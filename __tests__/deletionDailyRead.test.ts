import RNFS from 'react-native-fs'
import { PENDING_FOCUS_FLOOR_SECS, readDeletionOnFocus, type SettleDeps } from '../src/wallet/deletion'
import {
  clearDeletionMark,
  findDeletionMark,
  lastStatusReadAt,
  noteImportCheck,
  writeDeletionMark,
} from '../src/wallet/deletionMark'
import { setDomainFor } from '../src/wallet/lnurlDomainPref'

// Home's focus read for a wallet with no mark on a domain of its own: once a day at most, since a
// deletion asked from another device can take that domain down and leave this device no refusal to
// learn it from. Real deletion.ts and deletionMark.ts over the in-memory fs, with the gateway as a
// fetch double and the clock injected.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const NOW = 1_800_000_000
// The rule itself, written out rather than read from the module, so a change to it turns this red.
const DAY = 24 * 60 * 60
const DOCS = RNFS.DocumentDirectoryPath

type Answer = Record<string, unknown> | 'none'
let answer: Answer = { status: 'none' }
const request = jest.fn(async (_url: string, _init?: { body?: string }) => {
  if (answer === 'none') {
    throw new Error('network down')
  }
  const body = answer
  return { ok: true, status: 200, json: async () => body }
})
const statusReads = () =>
  request.mock.calls.filter(([url, init]) => url.endsWith('/api/wallet/delete') && JSON.parse(init?.body ?? '{}').action === 'status').length

let clock = NOW
const cleanup = jest.fn(async () => undefined)
const deps = (over: Partial<SettleDeps> = {}): SettleDeps => ({
  walletId: 'primary',
  pubkey: PUBKEY,
  sign: async () => 'sig',
  now: () => clock * 1000,
  request: request as unknown as typeof fetch,
  cleanup,
  ...over,
})
const focus = () => readDeletionOnFocus(deps())

async function ownerCache(walletId: string): Promise<void> {
  const entry = { host: 'shop.example', readAt: NOW, state: { role: 'owner' } }
  await RNFS.writeFile(`${DOCS}/domain-tier.json`, JSON.stringify({ [walletId]: entry }), 'utf8')
}

const settle = async () => {
  for (let i = 0; i < 40; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  // Past every floor the module keeps in memory from earlier cases.
  clock += DAY * 10
  answer = { status: 'none' }
})

describe('a wallet with no mark on a domain of its own', () => {
  test('reads on focus once, not again within a day, and again after it', async () => {
    await setDomainFor('primary', 'shop.example')
    await focus()
    expect(statusReads()).toBe(1)
    expect(await lastStatusReadAt('primary')).toBe(clock)

    clock += DAY - 1
    await focus()
    expect(statusReads()).toBe(1)

    clock += 1
    await focus()
    expect(statusReads()).toBe(2)
  })

  test('an owner whose stored domain was lost is read for through the cached role', async () => {
    await ownerCache('primary')
    await focus()
    expect(statusReads()).toBe(1)
  })

  test('a pending answer writes the mark, and the next focus reads it as a pending request', async () => {
    await setDomainFor('primary', 'shop.example')
    answer = { status: 'pending', requestedAt: NOW, finishBy: NOW + 86_400 }
    await focus()
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('pending')
  })

  test('a done answer runs the cleanup before the wallet is held as deleted', async () => {
    await setDomainFor('primary', 'shop.example')
    answer = { status: 'done', requestedAt: NOW, doneAt: NOW + 60 }
    await focus()
    expect(cleanup).toHaveBeenCalledWith('primary', PUBKEY, undefined)
    expect((await findDeletionMark({ walletId: 'primary' }))?.mark.state).toBe('done')
  })

  test('no answer reads again after the floor, not before, and writes no time', async () => {
    await setDomainFor('primary', 'shop.example')
    answer = 'none'
    await focus()
    expect(statusReads()).toBe(1)
    expect(await lastStatusReadAt('primary')).toBeNull()

    clock += PENDING_FOCUS_FLOOR_SECS - 1
    await focus()
    expect(statusReads()).toBe(1)

    clock += 1
    answer = { status: 'none' }
    await focus()
    expect(statusReads()).toBe(2)
    expect(await lastStatusReadAt('primary')).toBe(clock)
  })

  test('a time file that cannot be read makes the wallet due once and never stops the read', async () => {
    await setDomainFor('primary', 'shop.example')
    await RNFS.writeFile(`${DOCS}/deletion-read.json`, '{"primary": 17', 'utf8')
    await focus()
    expect(statusReads()).toBe(1)
    expect(await lastStatusReadAt('primary')).toBe(clock)
    await focus()
    expect(statusReads()).toBe(1)
  })

  test('the stored time goes with the mark, so a removed wallet imported again is read at once', async () => {
    await setDomainFor('primary', 'shop.example')
    await focus()
    expect(await lastStatusReadAt('primary')).toBe(clock)
    await clearDeletionMark('primary')
    expect(await lastStatusReadAt('primary')).toBeNull()
    await focus()
    expect(statusReads()).toBe(2)
  })
})

describe('two focuses whose daily reads overlap', () => {
  // Holds the next existence check of one file until the test lets it through, so the order in which
  // the two focuses reach the file queue is the test's own.
  const realExists = RNFS.exists.bind(RNFS)
  const gates = new Map<string, Promise<void>>()
  function gate(path: string): () => void {
    let open!: () => void
    gates.set(path, new Promise<void>(resolve => (open = resolve)))
    return () => open()
  }

  beforeEach(() => {
    gates.clear()
    jest.spyOn(RNFS, 'exists').mockImplementation(async (at: string) => {
      const held = gates.get(at)
      if (held) {
        gates.delete(at)
        await held
      }
      return realExists(at)
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('send one read when the second reads the time before the first notes it', async () => {
    await setDomainFor('primary', 'shop.example')
    let release!: () => void
    request.mockImplementationOnce(
      () =>
        new Promise(resolve => {
          release = () => resolve({ ok: true, status: 200, json: async () => ({ status: 'none' }) })
        }),
    )
    const first = focus()
    await settle()
    expect(statusReads()).toBe(1)

    const domainRead = gate(`${DOCS}/lnurl-domain.json`)
    const second = focus()
    await settle()

    // The first read's answer reaches the mark file and waits there.
    const markRead = gate(`${DOCS}/deletion.json`)
    release()
    await settle()

    // The second focus asks for the time behind it.
    domainRead()
    await settle()
    const timeRead = gate(`${DOCS}/deletion-read.json`)
    markRead()
    await settle()
    timeRead()
    await Promise.all([first, second])
    await settle()

    expect(statusReads()).toBe(1)
    expect(await lastStatusReadAt('primary')).toBe(clock)
  })

  test('a time that cannot be written fails the focus that read, and the next focus reads again', async () => {
    await setDomainFor('primary', 'shop.example')
    const realWrite = RNFS.writeFile.bind(RNFS)
    const write = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, ...rest: unknown[]) => {
      if (path.startsWith(`${DOCS}/deletion-read.json`)) {
        throw new Error('disk full')
      }
      return (realWrite as (...args: unknown[]) => Promise<void>)(path, ...rest)
    })
    await expect(focus()).rejects.toThrow('disk full')
    write.mockRestore()
    await focus()
    expect(statusReads()).toBe(2)
    expect(await lastStatusReadAt('primary')).toBe(clock)
  })
})

describe('reads this branch never makes', () => {
  test('for a wallet on the shared domain', async () => {
    await focus()
    await setDomainFor('primary', 'usevoltz.app')
    await focus()
    expect(statusReads()).toBe(0)
  })

  test("for a member of someone else's domain known only from the cache", async () => {
    await RNFS.writeFile(
      `${DOCS}/domain-tier.json`,
      JSON.stringify({ primary: { host: 'shop.example', readAt: NOW, state: { role: 'member' } } }),
      'utf8',
    )
    await focus()
    expect(statusReads()).toBe(0)
  })

  test('for a wallet that holds a mark, which its own reads cover', async () => {
    await setDomainFor('primary', 'shop.example')
    await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'removed', askedAt: NOW })
    await focus()
    expect(statusReads()).toBe(0)
  })

  test('a second time on a focus whose import read already asked', async () => {
    await setDomainFor('primary', 'shop.example')
    await noteImportCheck('primary')
    await focus()
    expect(statusReads()).toBe(1)
  })
})
