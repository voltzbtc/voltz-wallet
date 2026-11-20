import { SdkEvent_Tags, connect } from '@breeztech/breez-sdk-spark-react-native'
import {
  SYNC_WAIT_MS,
  connectSpark,
  disconnectSpark,
  onSparkSynced,
  sparkGetBalanceSat,
  sparkGetWalletInfo,
  sparkNoteResumed,
  sparkSyncWaitLeftMs,
  sparkSyncedBalanceSat,
} from '../src/wallet/spark'
import { onSparkResumed } from '../src/wallet/resumeNotice'

// The balance a payment is decided on, through the real spark.ts over a binding whose database answers
// the figure the last sync stored until the connection hears its own first sync. The domain purchase
// reads it before it pays, since its send does not refuse for too little balance.

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
  domainFor: jest.fn(async () => undefined),
}))

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

type Listener = { onEvent: (event: unknown) => Promise<void> }

// One instance per connect. `figure` is what its database answers, and sync() moves it to what the
// network says before the Synced event, the order the SDK keeps.
type Instance = {
  figure: number
  listener: Listener | null
  getInfo: jest.Mock
  addEventListener: jest.Mock
  disconnect: jest.Mock
  sync: (synced: number) => Promise<void>
}

function instance(stored: number): Instance {
  const sdk: Instance = {
    figure: stored,
    listener: null,
    getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: BigInt(sdk.figure), tokenBalances: new Map() })),
    addEventListener: jest.fn(async (listener: Listener) => {
      sdk.listener = listener
      return 'listener'
    }),
    disconnect: jest.fn(async () => undefined),
    async sync(synced: number) {
      sdk.figure = synced
      await sdk.listener?.onEvent({ tag: SdkEvent_Tags.Synced })
    },
  }
  return sdk
}

async function connectWith(stored: number, walletId = 'wallet-a'): Promise<Instance> {
  const sdk = instance(stored)
  jest.mocked(connect).mockImplementationOnce((async () => sdk) as never)
  await connectSpark(MNEMONIC, walletId)
  return sdk
}

type Outcome = { state: 'pending' | 'resolved' | 'rejected'; value?: number | null }
function outcome(read: Promise<number | null>): Outcome {
  const seen: Outcome = { state: 'pending' }
  read.then(
    value => {
      seen.state = 'resolved'
      seen.value = value
    },
    () => {
      seen.state = 'rejected'
    },
  )
  return seen
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

beforeEach(async () => {
  await disconnectSpark()
  jest.clearAllMocks()
})

afterEach(() => {
  jest.useRealTimers()
})

describe('before the first sync', () => {
  test('a stored figure too high is never answered: the read waits and answers the synced one', async () => {
    const sdk = await connectWith(5_000)
    expect(await sparkGetBalanceSat()).toBe(5_000)

    const read = outcome(sparkSyncedBalanceSat())
    await flush()
    expect(read.state).toBe('pending')

    await sdk.sync(100)
    await flush()
    expect(read).toEqual({ state: 'resolved', value: 100 })
  })

  test('a stored figure too low is never answered either', async () => {
    const sdk = await connectWith(100)

    const read = outcome(sparkSyncedBalanceSat())
    await flush()
    expect(read.state).toBe('pending')

    await sdk.sync(5_000)
    await flush()
    expect(read).toEqual({ state: 'resolved', value: 5_000 })
  })

  test('once the wait runs out without a sync, it answers nothing rather than the stored figure', async () => {
    jest.useFakeTimers()
    await connectWith(5_000)

    const read = outcome(sparkSyncedBalanceSat())
    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
    expect(read.state).toBe('pending')
    await jest.advanceTimersByTimeAsync(1)
    expect(read).toEqual({ state: 'resolved', value: null })
  })

  test("a switch while it waits answers nothing, not the next wallet's figure nor the closed one's", async () => {
    const first = await connectWith(5_000, 'wallet-a')
    const read = outcome(sparkSyncedBalanceSat())
    await flush()

    const next = await connectWith(7_000, 'wallet-b')
    // The closed instance's sync arriving late still marks its own record.
    await first.sync(6_000)
    await next.sync(7_000)
    await flush()
    expect(read).toEqual({ state: 'resolved', value: null })
  })
})

test('after the first sync it answers at once, from the database', async () => {
  const sdk = await connectWith(5_000)
  await sdk.sync(300)
  expect(await sparkSyncedBalanceSat()).toBe(300)
})

describe('the sync notice', () => {
  test("a closed instance's first sync after a switch reaches no listener, the live one's does", async () => {
    const first = await connectWith(5_000, 'wallet-a')
    const next = await connectWith(7_000, 'wallet-b')
    const heard = jest.fn()
    const off = onSparkSynced(heard)

    await first.sync(6_000)
    await flush()
    expect(heard).not.toHaveBeenCalled()

    await next.sync(7_000)
    await flush()
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })
})

describe('a read that waits for the first sync', () => {
  // Every function a Set gained while the read ran, so a listener left behind shows up whichever
  // way the wait ended.
  function addedDuring(): { added: Array<[Set<unknown>, unknown]>; stop: () => void } {
    const added: Array<[Set<unknown>, unknown]> = []
    const real = Set.prototype.add
    const spy = jest.spyOn(Set.prototype, 'add').mockImplementation(function (this: Set<unknown>, value) {
      if (typeof value === 'function') {
        added.push([this, value])
      }
      return real.call(this, value)
    })
    return { added, stop: () => spy.mockRestore() }
  }

  test.each([
    ['the sync comes', false],
    ['the wait runs out', true],
  ])('leaves no listener behind once %s', async (_how, timesOut) => {
    if (timesOut) {
      jest.useFakeTimers()
    }
    const sdk = await connectWith(5_000)
    const watch = addedDuring()
    const read = outcome(sparkSyncedBalanceSat())
    await flush()
    watch.stop()
    expect(watch.added).toHaveLength(1)

    if (timesOut) {
      await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
    } else {
      await sdk.sync(100)
      await flush()
    }
    expect(read.state).toBe('resolved')
    for (const [set, value] of watch.added) {
      expect(set.has(value)).toBe(false)
    }
  })
})

// The same connection after the app was suspended: the database still answers what the last sync
// stored, which can predate the suspension, so nothing reads as synced until a Synced heard after the
// return.
describe('after a return from the background', () => {
  test('reads wait again, go stale past the wait, and are synced only after a Synced heard since', async () => {
    jest.useFakeTimers()
    const sdk = await connectWith(5_000)
    await sdk.sync(5_000)
    expect((await sparkGetWalletInfo()).sync).toBe('synced')

    sparkNoteResumed()
    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    expect(sparkSyncWaitLeftMs()).toBe(SYNC_WAIT_MS)
    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS - 1)
    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    await jest.advanceTimersByTimeAsync(1)
    expect((await sparkGetWalletInfo()).sync).toBe('stale')

    await sdk.sync(4_000)
    const info = await sparkGetWalletInfo()
    expect(info).toMatchObject({ sync: 'synced', balanceSat: 4_000 })
  })

  test('the balance a payment is decided on is nothing without a Synced since, and the new figure after one', async () => {
    jest.useFakeTimers()
    const sdk = await connectWith(5_000)
    await sdk.sync(5_000)
    sparkNoteResumed()

    const unsynced = outcome(sparkSyncedBalanceSat())
    await jest.advanceTimersByTimeAsync(SYNC_WAIT_MS)
    expect(unsynced).toEqual({ state: 'resolved', value: null })

    sparkNoteResumed()
    const read = outcome(sparkSyncedBalanceSat())
    await jest.advanceTimersByTimeAsync(1_000)
    expect(read.state).toBe('pending')
    await sdk.sync(1_200)
    await flush()
    expect(read).toEqual({ state: 'resolved', value: 1_200 })
  })

  test('the Synced after the return is announced like the first one, and only once', async () => {
    const sdk = await connectWith(5_000)
    await sdk.sync(5_000)
    const heard = jest.fn()
    const off = onSparkSynced(heard)
    sparkNoteResumed()
    await sdk.sync(5_100)
    await sdk.sync(5_200)
    expect(heard).toHaveBeenCalledTimes(1)
    off()
  })

  test("touches only the live connection, and a replaced one's Synced never marks it", async () => {
    const first = await connectWith(5_000, 'wallet-a')
    const next = await connectWith(7_000, 'wallet-b')
    await next.sync(7_000)
    sparkNoteResumed()
    await first.sync(6_000)
    expect((await sparkGetWalletInfo()).sync).toBe('waiting')
    await next.sync(7_000)
    expect((await sparkGetWalletInfo()).sync).toBe('synced')
  })

  test('with nothing connected, nothing is restarted and nobody is told', async () => {
    const heard = jest.fn()
    const off = onSparkResumed(heard)
    sparkNoteResumed()
    expect(heard).not.toHaveBeenCalled()
    expect(sparkSyncWaitLeftMs()).toBe(0)
    off()
  })
})
