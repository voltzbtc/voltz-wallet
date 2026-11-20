// Random interleavings of switches, focus loads, explicit connects, reconnects and disconnects, with
// native connects that answer, fail or never answer, disconnects the SDK is slow to answer, domain
// reads held back, a registry read that throws and the landing bound running out, all through the
// real spark.ts. The examples in connectTurn.test.ts pin the orders someone thought of; this walks
// the orders nobody listed.
//
// Checked after every step:
// - one seed never has two instances alive (an instance is alive until its connect fails or the SDK
//   has answered its disconnect);
// - the live connection is an instance of the wallet it names, never told to disconnect, with that
//   wallet's domain;
// - no instance that answered its connect is left running without being live;
// - the newest request, with no silent switch after it, settles on the wallet it asked for;
// and after the drain, that nothing is still pending and a last focus load lands.
//
// Each run draws from its own seed through a fixed PRNG, so a failure names the seed and the steps,
// and setting FIRST_SEED to that seed with RUNS = 1 replays it.

import type * as SparkModule from '../src/wallet/spark'
import type * as RegistryModule from '../src/wallet/walletRegistry'
import type * as DomainPrefModule from '../src/wallet/lnurlDomainPref'
import type * as BindingModule from '@breeztech/breez-sdk-spark-react-native'

jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'wallet-a'),
  ensureRegistered: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => MNEMONIC),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  domainFor: jest.fn(async (walletId: string) => `${walletId}.example`),
}))

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WALLETS = ['wallet-a', 'wallet-b', 'wallet-c']

// Sized to stay a unit test: 100 runs of 40 steps take about 6 s on a laptop, and under 20 s with
// every core busy. Dropping the wait for a cut instance's disconnect from spark.ts fails on the third
// seed, so this size still catches it.
const FIRST_SEED = 1000
const RUNS = 100
const STEPS = 40

type Instance = {
  idx: number
  wallet: string
  state: 'connecting' | 'resolved' | 'rejected'
  disconnectCalls: number
  disconnectDone: boolean
  resolve: () => void
  reject: () => void
  held: Array<() => void>
}
type Request = {
  id: number
  kind: 'active' | 'explicit' | 'disconnect'
  want: string | null
  regVer: number
  state: 'pending' | 'resolved' | 'rejected'
}

// A mulberry32 generator is small, fast and the same on every machine, since its arithmetic is bitwise.
/* eslint-disable no-bitwise */
function prng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/* eslint-enable no-bitwise */

async function flush(): Promise<void> {
  for (let i = 0; i < 25; i++) {
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}

// Paths the walk has to reach, or a green run proves nothing about them.
type Reached = {
  superseded: number
  busy: number
  failed: number
  heldAnswered: number
  registryThrew: number
}

async function walk(seed: number, reached: Reached): Promise<string | null> {
  const rand = prng(seed)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
  let spark!: typeof SparkModule
  let binding!: typeof BindingModule
  let registryModule!: typeof RegistryModule
  let domainPref!: typeof DomainPrefModule
  jest.isolateModules(() => {
    binding = require('@breeztech/breez-sdk-spark-react-native')
    registryModule = require('../src/wallet/walletRegistry')
    domainPref = require('../src/wallet/lnurlDomainPref')
    spark = require('../src/wallet/spark')
  })
  const holdDisconnects = rand() < 0.5
  const holdReads = rand() < 0.5
  let autoAnswer = false
  let registry = 'wallet-a'
  let regVer = 0
  let throwNext = false
  const made: Instance[] = []
  const heldReads: Array<() => void> = []
  const requests: Request[] = []
  const steps: string[] = []
  let violation: string | null = null
  const fail = (what: string) => {
    violation ??= `seed ${seed}, ${what}\nsteps:\n${steps.join('\n')}`
  }

  jest.mocked(registryModule.getActiveWalletId).mockImplementation(async () => {
    if (throwNext) {
      throwNext = false
      reached.registryThrew += 1
      throw new Error('registry unreadable')
    }
    return registry
  })
  jest.mocked(domainPref.domainFor).mockImplementation(
    (walletId: string) =>
      new Promise(resolve => {
        if (holdReads && !autoAnswer) {
          heldReads.push(() => resolve(`${walletId}.example`))
        } else {
          resolve(`${walletId}.example`)
        }
      }),
  )
  jest.mocked(binding.connect).mockImplementation(((req: { config: { lnurlDomain?: string } }) =>
    new Promise((resolve, reject) => {
      const inst: Instance = {
        idx: made.length,
        wallet: (req.config.lnurlDomain ?? '').replace('.example', ''),
        state: 'connecting',
        disconnectCalls: 0,
        disconnectDone: false,
        resolve: () => undefined,
        reject: () => undefined,
        held: [],
      }
      const sdk = {
        // The balance names the instance, so the check can tell which one is live.
        getInfo: jest.fn(async () => ({
          identityPubkey: '02aa',
          balanceSats: BigInt(inst.idx + 1000),
          tokenBalances: new Map(),
        })),
        addEventListener: jest.fn(async () => 'listener'),
        disconnect: jest.fn(() => {
          inst.disconnectCalls += 1
          if (holdDisconnects && !autoAnswer) {
            return new Promise<void>(answer => {
              inst.held.push(() => {
                inst.disconnectDone = true
                answer()
              })
            })
          }
          inst.disconnectDone = true
          return Promise.resolve()
        }),
      }
      inst.resolve = () => {
        inst.state = 'resolved'
        resolve(sdk as never)
      }
      inst.reject = () => {
        inst.state = 'rejected'
        reject(new Error('native connect failed'))
      }
      made.push(inst)
      if (autoAnswer) {
        inst.resolve()
      }
    })) as never)

  const request = (kind: Request['kind'], want: string | null, settled: Promise<unknown>) => {
    const r: Request = { id: requests.length, kind, want, regVer, state: 'pending' }
    requests.push(r)
    settled.then(
      () => {
        r.state = 'resolved'
        if (r.id === requests.length - 1 && r.regVer === regVer) {
          const expected = kind === 'disconnect' ? null : kind === 'active' ? registry : want
          const got = spark.sparkConnectedWalletId()
          if (got !== expected) {
            fail(`the newest ${kind}(${want}) resolved with ${got} connected, expected ${expected}`)
          }
        }
      },
      (error: unknown) => {
        r.state = 'rejected'
        if (error instanceof spark.SparkConnectSuperseded) {
          reached.superseded += 1
        } else if (error instanceof spark.SparkConnectBusy) {
          reached.busy += 1
        } else {
          reached.failed += 1
        }
      },
    )
  }

  const alive = (i: Instance) => i.state !== 'rejected' && !i.disconnectDone
  const check = async (where: string) => {
    for (const w of WALLETS) {
      const n = made.filter(i => i.wallet === w && alive(i)).length
      if (n > 1) {
        fail(`${where}: ${n} alive instances of ${w}`)
      }
    }
    const connected = spark.sparkConnectedWalletId()
    let liveIdx: number | null = null
    if (connected !== null) {
      const balance = await spark.sparkGetBalanceSat().catch(() => null)
      liveIdx = balance === null ? null : balance - 1000
      const inst = liveIdx === null ? undefined : made[liveIdx]
      if (!inst || inst.wallet !== connected || inst.disconnectCalls > 0 || inst.state !== 'resolved') {
        const seen = inst && { wallet: inst.wallet, disconnects: inst.disconnectCalls, state: inst.state }
        fail(`${where}: live names ${connected} but instance ${liveIdx} is ${JSON.stringify(seen)}`)
      }
      if (spark.connectedLnurlDomain() !== `${connected}.example`) {
        fail(`${where}: domain ${spark.connectedLnurlDomain()} for ${connected}`)
      }
    }
    for (const i of made) {
      if (i.state === 'resolved' && i.idx !== liveIdx && i.disconnectCalls === 0) {
        fail(`${where}: instance ${i.idx} of ${i.wallet} answered, is not live and was never disconnected`)
      }
    }
  }

  for (let step = 0; step < STEPS && violation === null; step++) {
    const x = rand()
    const connecting = made.filter(i => i.state === 'connecting')
    const holding = made.filter(i => i.held.length > 0)
    if (x < 0.2) {
      registry = pick(WALLETS)
      regVer += 1
      steps.push(`switch ${registry}`)
      request('active', registry, spark.connectActiveSpark())
    } else if (x < 0.33) {
      steps.push('focus')
      request('active', registry, spark.connectActiveSpark())
    } else if (x < 0.37) {
      registry = pick(WALLETS)
      regVer += 1
      steps.push(`silent ${registry}`)
    } else if (x < 0.44) {
      registry = pick(WALLETS)
      regVer += 1
      steps.push(`explicit ${registry}`)
      request('explicit', registry, spark.connectSpark(MNEMONIC, registry))
    } else if (x < 0.5) {
      // What reconnectActiveWallet does.
      steps.push(`reconnect ${registry}`)
      request('disconnect', null, spark.disconnectSpark())
      request('explicit', registry, spark.connectSpark(MNEMONIC, registry))
    } else if (x < 0.56) {
      steps.push('disconnect')
      request('disconnect', null, spark.disconnectSpark())
    } else if (x < 0.75) {
      if (connecting.length) {
        const i = pick(connecting)
        steps.push(`land #${i.idx} ${i.wallet}`)
        i.resolve()
      }
    } else if (x < 0.79) {
      if (connecting.length) {
        const i = pick(connecting)
        steps.push(`fail #${i.idx} ${i.wallet}`)
        i.reject()
      }
    } else if (x < 0.88) {
      if (holding.length) {
        const i = pick(holding)
        steps.push(`disconnect answers #${i.idx}`)
        reached.heldAnswered += 1
        i.held.splice(0).forEach(answer => answer())
      }
    } else if (x < 0.9) {
      if (heldReads.length) {
        steps.push('a domain read answers')
        heldReads.splice(Math.floor(rand() * heldReads.length), 1)[0]()
      }
    } else if (x < 0.93) {
      steps.push('bound runs out')
      jest.advanceTimersByTime(spark.LANDING_WAIT_MS)
    } else {
      steps.push('registry read throws once')
      throwNext = true
    }
    await flush()
    await check(`after step ${step} (${steps[steps.length - 1]})`)
  }
  if (violation !== null) {
    return violation
  }

  // Every native call answers, the bound runs out, and nothing stays pending.
  steps.push('drain')
  throwNext = false
  autoAnswer = true
  for (let k = 0; k < 10; k++) {
    made.filter(i => i.state === 'connecting').forEach(i => i.resolve())
    made.forEach(i => i.held.splice(0).forEach(answer => answer()))
    heldReads.splice(0).forEach(answer => answer())
    jest.advanceTimersByTime(spark.LANDING_WAIT_MS)
    await flush()
  }
  await check('after the drain')
  const stuck = requests.filter(r => r.state === 'pending')
  if (stuck.length) {
    const names = stuck.map(r => `${r.kind}(${r.want})`).join(', ')
    fail(`${stuck.length} requests still pending after the drain: ${names}`)
  }

  // One more focus load lands on the registry's wallet.
  regVer += 1
  let last = 'pending'
  spark.connectActiveSpark().then(
    () => (last = 'resolved'),
    (error: Error) => (last = `rejected ${error?.name}`),
  )
  for (let k = 0; k < 5; k++) {
    jest.advanceTimersByTime(spark.LANDING_WAIT_MS)
    await flush()
  }
  if (last !== 'resolved' || spark.sparkConnectedWalletId() !== registry) {
    fail(`the last focus load is ${last} with ${spark.sparkConnectedWalletId()} connected, registry ${registry}`)
  }
  await check('after the last focus load')
  return violation
}

test('no order of requests and answers runs one seed twice or publishes a connection nobody wants', async () => {
  jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
  const reached: Reached = { superseded: 0, busy: 0, failed: 0, heldAnswered: 0, registryThrew: 0 }
  const violations: string[] = []
  try {
    for (let seed = FIRST_SEED; seed < FIRST_SEED + RUNS && violations.length === 0; seed++) {
      const violation = await walk(seed, reached)
      if (violation !== null) {
        violations.push(violation)
      }
    }
  } finally {
    jest.useRealTimers()
  }
  expect(violations).toEqual([])
  expect(reached.superseded).toBeGreaterThan(0)
  expect(reached.busy).toBeGreaterThan(0)
  expect(reached.failed).toBeGreaterThan(0)
  expect(reached.heldAnswered).toBeGreaterThan(0)
  expect(reached.registryThrew).toBeGreaterThan(0)
}, 120_000)
