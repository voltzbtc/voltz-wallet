import RNFS from 'react-native-fs'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import { isUnreadableFile, UnreadableFile } from '../src/wallet/durableFile'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import {
  allPendingReferences,
  clearPending,
  disownPending,
  forgetWalletPurchases,
  loadPending,
  payAndSettle,
  recordRefusal,
  savePending,
  type PendingPurchase,
} from '../src/wallet/purchase'
import { sparkConfirmSend, sparkPrepareSend } from '../src/wallet/spark'
import {
  allPendingPurchaseReferences,
  clearPendingPurchase,
  forgetWalletDomainPurchase,
  loadPendingPurchase,
  recordPurchaseRefusal,
  savePendingPurchase,
  type PendingPurchase as DomainProof,
} from '../src/wallet/domainOnboard'

// The proof of a payment in sats is the buyer's only pointer at money that already left. A proof
// file that cannot be read (cut mid write, or in a shape this build does not know) is never read as
// no proof, never written over and never removed. A torn copy with no file beside it is a first write
// that was cut, whose last finished state is no file, and reads as no proof.

jest.mock('../src/wallet/spark', () => ({
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 12821, fee: 0 })),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const active = jest.mocked(getActiveWalletId)
const DOCS = RNFS.DocumentDirectoryPath
const STORE = `${DOCS}/purchases.json`
const UNKEYED = `${DOCS}/purchase-name.json`
const UNKEYED_DOMAIN = `${DOCS}/purchase-domain.json`
const DOMAIN = `${DOCS}/domain-purchase.json`
const PATHS = [
  DOMAIN,
  `${DOMAIN}.tmp`,
  `${DOMAIN}.unreadable`,
  STORE,
  `${STORE}.tmp`,
  `${STORE}.unreadable`,
  UNKEYED,
  `${UNKEYED}.tmp`,
  UNKEYED_DOMAIN,
  `${UNKEYED_DOMAIN}.tmp`,
]

const realWrite = RNFS.writeFile.bind(RNFS)
const put = (path: string, text: string): Promise<void> => realWrite(path, text, 'utf8')

async function raw(path: string): Promise<string | null> {
  return (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null
}

async function disk(): Promise<Record<string, string | null>> {
  const entries = await Promise.all(PATHS.map(async path => [path, await raw(path)] as const))
  return Object.fromEntries(entries)
}

const proof = (reference: string, extra: Partial<PendingPurchase> = {}): PendingPurchase => ({
  kind: 'name',
  subject: 'bakery',
  reference,
  amountSats: 12821,
  ...extra,
})

// What a rejected call was rejected with, read so a case can say which failure it expects.
async function failure(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
    return 'resolved'
  } catch (err) {
    return isUnreadableFile(err) ? 'unreadable' : `failed: ${(err as Error)?.message}`
  }
}

// Jest maps the spec to its in-memory double, which is never null.
const Durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>

type Method = 'exists' | 'readFile' | 'writeFile' | 'unlink' | 'moveFile' | 'syncFile' | 'rename' | 'syncDirectory'
const FS_METHODS: Method[] = ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']
// The sync module's calls are steps of a write as well: the copy goes in place through its rename.
const SYNC_METHODS: Method[] = ['syncFile', 'rename', 'syncDirectory']

// Runs `hook` in front of every RNFS call and every call to the sync module; each call is one await of
// the code under test.
function trace(hook: (method: Method, args: unknown[], go: () => Promise<unknown>) => Promise<unknown>): void {
  const targets: [object, Method[]][] = [
    [RNFS, FS_METHODS],
    [Durable, SYNC_METHODS],
  ]
  for (const [target, methods] of targets) {
    for (const method of methods) {
      const host = target as Record<Method, (...args: unknown[]) => Promise<unknown>>
      const real = host[method].bind(target)
      jest.spyOn(host, method).mockImplementation(((...args: unknown[]) => hook(method, args, () => real(...args))) as never)
    }
  }
}

async function stepsOf(run: () => Promise<unknown>): Promise<number> {
  let calls = 0
  trace((_method, _args, go) => {
    calls += 1
    return go()
  })
  await run()
  jest.restoreAllMocks()
  return calls
}

// The process dies at call number `k`: from there on nothing reaches the disk, as after a kill. A
// write at `k` may land half its text first, as Android's truncate-then-write does. Every later call
// rejects too, so the call under test fails instead of carrying on over a disk it can no longer change.
function killAt(k: number, half: boolean): () => Method | null {
  let calls = 0
  let died: Method | null = null
  trace(async (method, args, go) => {
    const n = calls++
    if (n < k) {
      return go()
    }
    if (n === k) {
      died = method
      if (half && method === 'writeFile') {
        const [path, text] = args as [string, string]
        await realWrite(path, text.slice(0, Math.floor(text.length / 2)), 'utf8')
      }
    }
    throw new Error('killed')
  })
  return () => died
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
  jest.clearAllMocks()
  active.mockResolvedValue('w_a')
  jest.mocked(sparkPrepareSend).mockResolvedValue({ handle: 'h-1', amount: 12821, fee: 0 } as never)
  jest.mocked(sparkConfirmSend).mockResolvedValue('complete' as never)
})

const UNREADABLE_STORES: [string, () => Promise<void>][] = [
  ['a store cut mid write', () => put(STORE, '{"w_a": {"name": {"reference": "ref')],
  ['a store that is not a map', () => put(STORE, '[1, 2]')],
]

describe.each(UNREADABLE_STORES)('%s', (_label, tear) => {
  beforeEach(async () => {
    await tear()
    // An older record naming the reference every writer below is asked about, so a writer that read
    // the store as empty would have something to write.
    await put(UNKEYED, JSON.stringify(proof('ref-1')))
  })

  test('is never read as no proof', async () => {
    expect(await failure(() => loadPending('name'))).toBe('unreadable')
  })

  test('refuses a new proof and keeps every byte', async () => {
    const before = await disk()
    expect(await failure(() => savePending(proof('ref-2')))).toBe('unreadable')
    expect(await disk()).toEqual(before)
  })

  test('refuses to disown the older record and keeps every byte', async () => {
    const before = await disk()
    expect(await failure(() => disownPending('name', 'ref-1'))).toBe('unreadable')
    expect(await disk()).toEqual(before)
  })

  test.each<[string, () => Promise<unknown>]>([
    ['a clear naming the reference', () => clearPending('name', 'ref-1')],
    ['a clear naming another reference', () => clearPending('name', 'ref-2')],
    ['a paid refusal', () => recordRefusal('name', 'ref-1', true)],
    ['the deletion cleanup', () => forgetWalletPurchases('w_a')],
  ])('%s resolves and keeps every byte', async (_what, run) => {
    const before = await disk()
    expect(await failure(run)).toBe('resolved')
    expect(await disk()).toEqual(before)
  })

  test('sends nothing, and the store keeps its bytes', async () => {
    const before = await disk()
    const confirm = jest.fn(async () => true)
    expect(await failure(() => payAndSettle(proof('ref-2'), 'lnbc1', confirm))).toBe('unreadable')
    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(confirm).not.toHaveBeenCalled()
    expect(await disk()).toEqual(before)
  })
})

// Every write that can be the first is acted on only once it resolved, or records a charge the
// gateway lists again, so the cut write lost nothing and the store reads as none.
describe('a torn copy with no store, a first write that was cut', () => {
  const COPY = `${STORE}.tmp`
  beforeEach(() => put(COPY, '{"w_a": {"name": '))

  test('reads as no proof', async () => {
    expect(await loadPending('name')).toBeNull()
  })

  test('the next proof is written, the copy goes and nothing is set aside', async () => {
    expect(await savePending(proof('ref-2'))).toMatchObject({ reference: 'ref-2' })
    const after = await disk()
    expect([after[COPY], after[`${STORE}.unreadable`]]).toEqual([null, null])
    expect(JSON.parse(after[STORE]!)).toEqual({ w_a: { name: proof('ref-2') } })
  })

  test('a payment goes out over it and leaves its proof', async () => {
    const confirm = jest.fn(async () => false)
    expect(await payAndSettle(proof('ref-2'), 'lnbc1', confirm)).toEqual({ outcome: 'settling' })
    expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-2' })
    expect(await raw(COPY)).toBeNull()
  })

  test('Support reads nothing unread from it', async () => {
    expect(await allPendingReferences()).toEqual({ references: [], unread: false })
  })

  test('a clear writes no store, and takes the copy with it', async () => {
    await clearPending('name', 'ref-2')
    expect([await raw(STORE), await raw(COPY)]).toEqual([null, null])
  })
})

describe("a wallet's own slot that cannot be read", () => {
  const OTHER = proof('ref-b', { subject: 'otherbakery' })

  test.each<[string, unknown]>([
    ['a slot that is not a map', 'ref-a'],
    ['a record with no reference', { name: { subject: 'alice' } }],
    ['a record that is null', { name: null }],
  ])('%s is unreadable for that wallet and written over by nothing', async (_label, slot) => {
    await put(STORE, JSON.stringify({ w_a: slot, w_b: { name: OTHER } }))
    const before = await disk()
    expect(await failure(() => loadPending('name'))).toBe('unreadable')
    expect(await failure(() => savePending(proof('ref-2')))).toBe('unreadable')
    expect(await failure(() => disownPending('name', 'ref-1'))).toBe('unreadable')
    await clearPending('name', 'ref-b')
    await clearPending('name', 'ref-1')
    await recordRefusal('name', 'ref-1', true)
    expect(await disk()).toEqual(before)
  })

  test("another wallet's slot that cannot be read blocks nothing here and is written back as it was", async () => {
    await put(STORE, JSON.stringify({ w_b: 'ref-b', w_c: 7, w_d: null }))
    expect(await loadPending('name')).toBeNull()
    expect(await savePending(proof('ref-1'))).toMatchObject({ reference: 'ref-1' })
    expect(JSON.parse((await raw(STORE))!)).toEqual({ w_a: { name: proof('ref-1') }, w_b: 'ref-b', w_c: 7, w_d: null })
    await clearPending('name', 'ref-1')
    expect(JSON.parse((await raw(STORE))!)).toEqual({ w_b: 'ref-b', w_c: 7, w_d: null })
  })
})

describe('an older record that cannot be read', () => {
  beforeEach(async () => {
    await put(UNKEYED, '{"reference": "ref')
  })

  test('blocks a wallet with no record of its own, and keeps its bytes', async () => {
    const before = await disk()
    expect(await failure(() => loadPending('name'))).toBe('unreadable')
    expect(await failure(() => savePending(proof('ref-2')))).toBe('unreadable')
    await clearPending('name', 'ref-1')
    await recordRefusal('name', 'ref-1', true)
    expect(await disk()).toEqual(before)
  })

  test("says nothing over a wallet's own record, which answers for it", async () => {
    await put(STORE, JSON.stringify({ w_a: { name: proof('ref-a') } }))
    expect(await loadPending('name')).toMatchObject({ reference: 'ref-a' })
  })

  test('is never removed by the clear of its own reference', async () => {
    await put(UNKEYED, '[1')
    await clearPending('name', 'ref-1')
    expect(await raw(UNKEYED)).toBe('[1')
  })

  // Nothing in this build writes the older file first, so a torn copy beside none of it is not a
  // first write that was cut, and it is not read as no record.
  test('as a torn copy with no file still blocks a wallet with no record of its own', async () => {
    await RNFS.unlink(UNKEYED)
    await put(`${UNKEYED}.tmp`, '{"reference": "ref')
    const before = await disk()
    expect(await failure(() => loadPending('name'))).toBe('unreadable')
    expect(await failure(() => savePending(proof('ref-2')))).toBe('unreadable')
    expect(await allPendingReferences()).toEqual({ references: [], unread: true })
    expect(await disk()).toEqual(before)
  })
})

describe('a registry that cannot be read', () => {
  test('is never taken for the primary wallet: the read and the write reject, and nothing is written', async () => {
    active.mockRejectedValue(new UnreadableFile(`${DOCS}/wallets.json`))
    expect(await failure(() => loadPending('name'))).toBe('unreadable')
    expect(await failure(() => savePending(proof('ref-1')))).toBe('unreadable')
    expect(await failure(() => disownPending('name', 'ref-1'))).toBe('unreadable')
    expect(await disk()).toEqual(Object.fromEntries(PATHS.map(path => [path, null])))
  })
})

describe('a write cut at any step', () => {
  // A wallet's own record written before the send, and another wallet's proof, which no step of this
  // wallet's write may cost.
  const start = async (): Promise<void> => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await put(STORE, JSON.stringify({ w_a: { name: proof('ref-1', { unpaid: true }) }, w_b: { name: proof('ref-b') } }))
  }

  test('leaves the record from before or after it, and the other wallet its proof', async () => {
    await start()
    const steps = await stepsOf(() => savePending(proof('ref-1')))
    expect(steps).toBeGreaterThan(6)
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        await start()
        const died = killAt(k, half)
        expect(await failure(() => savePending(proof('ref-1')))).toBe('failed: killed')
        jest.restoreAllMocks()
        expect({ half, k, died: died() !== null }).toEqual({ half, k, died: true })
        const answer = await loadPending('name').then(
          found => found?.reference ?? null,
          (err: unknown) => (isUnreadableFile(err) ? 'unreadable' : 'failed'),
        )
        // Null is the record from before, which stands for no payment.
        expect({ half, k, answer: [null, 'ref-1'].includes(answer) }).toEqual({ half, k, answer: true })
        active.mockResolvedValueOnce('w_b')
        expect({ half, k, other: (await loadPending('name'))?.reference }).toEqual({ half, k, other: 'ref-b' })
      }
    }
  })

  // With no proof on the device there is nothing to lose. A first write torn mid write leaves only a
  // torn copy, which reads as unreadable rather than as none, since nothing says no file was meant to
  // be there (durableFile.ts).
  // A first write cut mid copy leaves the copy torn with no store, whose last finished state is none,
  // and the next proof is written over it.
  test('from no store at all, leaves none or the new record, and the next proof is written', async () => {
    const steps = await stepsOf(() => savePending(proof('ref-1')))
    let tornCopies = 0
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        ;(RNFS as unknown as { __reset: () => void }).__reset()
        const died = killAt(k, half)
        await failure(() => savePending(proof('ref-1')))
        jest.restoreAllMocks()
        if (half && died() === 'writeFile' && (await raw(`${STORE}.tmp`)) !== null) {
          tornCopies += 1
        }
        const answer = await loadPending('name').then(
          found => found?.reference ?? null,
          (err: unknown) => (isUnreadableFile(err) ? 'unreadable' : 'failed'),
        )
        expect({ half, k, answer: [null, 'ref-1'].includes(answer) }).toEqual({ half, k, answer: true })
        expect({ half, k, next: await failure(() => savePending(proof('ref-1'))) }).toEqual({ half, k, next: 'resolved' })
        expect({ half, k, aside: await raw(`${STORE}.unreadable`), copy: await raw(`${STORE}.tmp`) }).toEqual({
          half,
          k,
          aside: null,
          copy: null,
        })
      }
    }
    // The torn copy with no store is among the states this walks through.
    expect(tornCopies).toBeGreaterThan(0)
  })
})

describe('one queue for the check and the write', () => {
  // The recovery sweep's hold and the address sheet both write this slot. Both passing the check
  // before either writes would leave the second reference over the first, with the first caller told
  // its own was kept.
  test('two proofs in flight leave one on disk, and the other caller is handed it', async () => {
    const [swept, paying] = await Promise.all([savePending(proof('ref-sweep')), savePending(proof('ref-sheet'))])
    const onDisk = (await loadPending('name'))?.reference
    expect(onDisk).toBe('ref-sweep')
    expect([swept.reference, paying.reference]).toEqual([onDisk, onDisk])
  })

  // From a finished copy and no store the write moves the copy in first, the one point a read outside
  // the queue can find neither. The other wallet's proof, which no step changes, is what such a read
  // would lose, since this wallet's record from before reads as none.
  test.each([
    ['a store', STORE],
    ['a finished copy and no store', `${STORE}.tmp`],
  ])('a read sent at any step of a write, from %s, answers the record from before or after it', async (_label, at) => {
    const prepare = async (): Promise<void> => {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await put(at, JSON.stringify({ w_a: { name: proof('ref-1', { unpaid: true }) }, w_b: { name: proof('ref-b') } }))
    }
    await prepare()
    const steps = await stepsOf(() => savePending(proof('ref-1')))
    expect(steps).toBeGreaterThan(6)
    for (let k = 0; k < steps; k += 1) {
      await prepare()
      const reads: Promise<(string | null)[]>[] = []
      let calls = 0
      const referenceOf = (walletId: string): Promise<string | null> =>
        loadPending('name', walletId).then(found => found?.reference ?? null, () => 'failed')
      trace((_method, _args, go) => {
        if (calls++ === k) {
          reads.push(Promise.all([referenceOf('w_a'), referenceOf('w_b')]))
        }
        return go()
      })
      await savePending(proof('ref-1'))
      jest.restoreAllMocks()
      const [[own, other]] = await Promise.all(reads)
      expect({ k, own: [null, 'ref-1'].includes(own), other }).toEqual({ k, own: true, other: 'ref-b' })
    }
  })
})

describe('every reference on the device', () => {
  test('carries every wallet and every kind, leaving out records that stand for no payment', async () => {
    await put(
      STORE,
      JSON.stringify({
        w_a: { name: proof('ref-a'), domain: proof('ref-a-domain', { kind: 'domain' }) },
        w_b: { name: proof('ref-b') },
        w_c: { name: proof('ref-c', { unpaid: true }) },
      }),
    )
    await put(UNKEYED, JSON.stringify(proof('ref-old')))
    await put(UNKEYED_DOMAIN, JSON.stringify(proof('ref-old-domain', { kind: 'domain' })))
    expect(await allPendingReferences()).toEqual({
      references: ['ref-a', 'ref-a-domain', 'ref-b', 'ref-old', 'ref-old-domain'],
      unread: false,
    })
  })

  test('answers none, and nothing unread, with no proof file', async () => {
    expect(await allPendingReferences()).toEqual({ references: [], unread: false })
  })

  test.each<[string, string, string]>([
    ['a torn store', STORE, '{"w_a": {"name": {"reference": "ref'],
    ['a torn older name record', UNKEYED, '{"reference'],
    ['a torn older domain record', UNKEYED_DOMAIN, '{"reference'],
  ])('%s is unread, and the good proofs beside it are still carried', async (_label, path, text) => {
    await put(STORE, JSON.stringify({ w_b: { name: proof('ref-b') } }))
    await put(UNKEYED, JSON.stringify(proof('ref-old')))
    await put(path, text)
    const { references, unread } = await allPendingReferences()
    expect(unread).toBe(true)
    expect(references.length).toBeGreaterThan(0)
    expect(references.every(r => ['ref-b', 'ref-old'].includes(r))).toBe(true)
  })

  test.each<[string, unknown]>([
    ['a slot that is not a map', 'ref-x'],
    ['a record with no reference', { name: { subject: 'alice' } }],
  ])('%s of any wallet is unread, beside the proofs that read', async (_label, slot) => {
    await put(STORE, JSON.stringify({ w_b: { name: proof('ref-b') }, w_x: slot }))
    expect(await allPendingReferences()).toEqual({ references: ['ref-b'], unread: true })
  })
})

// The same rules for the record of a domain year paid in sats, which holds one slot per wallet or,
// from an older app, one unkeyed record as the whole file.
describe('domain-purchase.json', () => {
  const year = (reference: string, extra: Partial<DomainProof> = {}): DomainProof => ({
    host: 'pay.bakery.com.br',
    reference,
    amountSats: 99000,
    ...extra,
  })

  describe.each<[string, () => Promise<void>]>([
    ['a record cut mid write', () => put(DOMAIN, '{"w_a": {"reference')],
    ['a record that is not a map', () => put(DOMAIN, '17')],
    ['a record that is a list', () => put(DOMAIN, '[{"reference": "ref-1"}]')],
    ["this wallet's record with no reference", () => put(DOMAIN, '{"w_a": {"host": "bakery.com.br"}, "w_b": {"reference": "ref-b", "host": "b.com", "amountSats": 1}}')],
  ])('%s', (_label, tear) => {
    beforeEach(tear)

    test('is never read as no record, and refuses a new one keeping every byte', async () => {
      const before = await disk()
      expect(await failure(() => loadPendingPurchase())).toBe('unreadable')
      expect(await failure(() => savePendingPurchase(year('ref-2')))).toBe('unreadable')
      expect(await disk()).toEqual(before)
    })

    test.each<[string, () => Promise<unknown>]>([
      ['a clear naming the reference', () => clearPendingPurchase('ref-1')],
      ['a clear naming another reference', () => clearPendingPurchase('ref-2')],
      ['a paid refusal', () => recordPurchaseRefusal('ref-1', true)],
    ])('%s resolves and keeps every byte', async (_what, run) => {
      const before = await disk()
      expect(await failure(run)).toBe('resolved')
      expect(await disk()).toEqual(before)
    })
  })

  test.each<[string, () => Promise<void>]>([
    ['a record cut mid write', () => put(DOMAIN, '{"w_a": {"reference')],
    ['a torn copy with no record', () => put(`${DOMAIN}.tmp`, '{"w_a": ')],
  ])('the deletion cleanup over %s resolves and keeps every byte', async (_label, tear) => {
    await tear()
    const before = await disk()
    expect(await failure(() => forgetWalletDomainPurchase('w_a'))).toBe('resolved')
    expect(await disk()).toEqual(before)
  })

  // The one write that can be the first is acted on only once it resolved, or records a charge the
  // gateway lists again, so the cut write lost nothing and the record reads as none.
  describe('a torn copy with no record, a first write that was cut', () => {
    const COPY = `${DOMAIN}.tmp`
    beforeEach(() => put(COPY, '{"w_a": '))

    test('reads as no record, and the next one is written with nothing set aside', async () => {
      expect(await loadPendingPurchase()).toBeNull()
      expect(await savePendingPurchase(year('ref-2'))).toMatchObject({ reference: 'ref-2' })
      const after = await disk()
      expect([after[COPY], after[`${DOMAIN}.unreadable`]]).toEqual([null, null])
      expect(JSON.parse(after[DOMAIN]!)).toEqual({ w_a: year('ref-2') })
    })

    test('Support reads nothing unread from it', async () => {
      expect(await allPendingPurchaseReferences()).toEqual({ references: [], unread: false })
    })

    test('a clear writes no record, and takes the copy with it', async () => {
      await clearPendingPurchase('ref-2')
      expect([await raw(DOMAIN), await raw(COPY)]).toEqual([null, null])
    })
  })

  test('a first write cut at any step leaves none or the new record, and the next one is written', async () => {
    const steps = await stepsOf(() => savePendingPurchase(year('ref-1')))
    let tornCopies = 0
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        ;(RNFS as unknown as { __reset: () => void }).__reset()
        const died = killAt(k, half)
        await failure(() => savePendingPurchase(year('ref-1')))
        jest.restoreAllMocks()
        if (half && died() === 'writeFile' && (await raw(`${DOMAIN}.tmp`)) !== null) {
          tornCopies += 1
        }
        const answer = await loadPendingPurchase().then(
          found => found?.reference ?? null,
          (err: unknown) => (isUnreadableFile(err) ? 'unreadable' : 'failed'),
        )
        expect({ half, k, answer: [null, 'ref-1'].includes(answer) }).toEqual({ half, k, answer: true })
        expect({ half, k, next: await failure(() => savePendingPurchase(year('ref-1'))) }).toEqual({
          half,
          k,
          next: 'resolved',
        })
        expect({ half, k, aside: await raw(`${DOMAIN}.unreadable`), copy: await raw(`${DOMAIN}.tmp`) }).toEqual({
          half,
          k,
          aside: null,
          copy: null,
        })
      }
    }
    expect(tornCopies).toBeGreaterThan(0)
  })

  test("another wallet's record that cannot be read blocks nothing here and is written back as it was", async () => {
    await put(DOMAIN, JSON.stringify({ w_b: { host: 'b.com' }, w_c: 'x' }))
    expect(await loadPendingPurchase()).toBeNull()
    await savePendingPurchase(year('ref-1'))
    expect(JSON.parse((await raw(DOMAIN))!)).toEqual({ w_a: year('ref-1'), w_b: { host: 'b.com' }, w_c: 'x' })
    await clearPendingPurchase('ref-1')
    expect(JSON.parse((await raw(DOMAIN))!)).toEqual({ w_b: { host: 'b.com' }, w_c: 'x' })
  })

  test('the unkeyed record of an older app is still offered to every wallet', async () => {
    await put(DOMAIN, JSON.stringify(year('ref-old')))
    expect(await loadPendingPurchase()).toMatchObject({ reference: 'ref-old' })
    active.mockResolvedValueOnce('w_b')
    expect(await loadPendingPurchase()).toMatchObject({ reference: 'ref-old' })
    expect(await savePendingPurchase(year('ref-2'))).toMatchObject({ reference: 'ref-old' })
  })

  test('a registry that cannot be read is never taken for the primary wallet', async () => {
    active.mockRejectedValue(new UnreadableFile(`${DOCS}/wallets.json`))
    expect(await failure(() => loadPendingPurchase())).toBe('unreadable')
    expect(await failure(() => savePendingPurchase(year('ref-1')))).toBe('unreadable')
    expect(await raw(DOMAIN)).toBeNull()
  })

  test('a write cut at any step leaves the record from before or after it, and the other wallet its own', async () => {
    const start = async (): Promise<void> => {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await put(DOMAIN, JSON.stringify({ w_a: year('ref-1', { unpaid: true }), w_b: year('ref-b') }))
    }
    await start()
    const steps = await stepsOf(() => savePendingPurchase(year('ref-1')))
    expect(steps).toBeGreaterThan(6)
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        await start()
        const died = killAt(k, half)
        expect(await failure(() => savePendingPurchase(year('ref-1')))).toBe('failed: killed')
        jest.restoreAllMocks()
        expect({ half, k, died: died() !== null }).toEqual({ half, k, died: true })
        const answer = await loadPendingPurchase().then(
          found => found?.reference ?? null,
          (err: unknown) => (isUnreadableFile(err) ? 'unreadable' : 'failed'),
        )
        expect({ half, k, answer: [null, 'ref-1'].includes(answer) }).toEqual({ half, k, answer: true })
        active.mockResolvedValueOnce('w_b')
        expect({ half, k, other: (await loadPendingPurchase())?.reference }).toEqual({ half, k, other: 'ref-b' })
      }
    }
  })

  test('two saves in flight keep one, and the other caller is handed it', async () => {
    const [swept, paying] = await Promise.all([savePendingPurchase(year('ref-sweep')), savePendingPurchase(year('ref-screen'))])
    const onDisk = (await loadPendingPurchase())?.reference
    expect(onDisk).toBe('ref-sweep')
    expect([swept.reference, paying.reference]).toEqual([onDisk, onDisk])
  })

  test('carries every reference of every wallet, or the unkeyed one, and says what did not read', async () => {
    expect(await allPendingPurchaseReferences()).toEqual({ references: [], unread: false })
    await put(DOMAIN, JSON.stringify({ w_a: year('ref-a'), w_b: year('ref-b'), w_c: year('ref-c', { unpaid: true }) }))
    expect(await allPendingPurchaseReferences()).toEqual({ references: ['ref-a', 'ref-b'], unread: false })
    await put(DOMAIN, JSON.stringify({ w_a: year('ref-a'), w_x: { host: 'x.com' } }))
    expect(await allPendingPurchaseReferences()).toEqual({ references: ['ref-a'], unread: true })
    await put(DOMAIN, JSON.stringify(year('ref-old')))
    expect(await allPendingPurchaseReferences()).toEqual({ references: ['ref-old'], unread: false })
    await put(DOMAIN, '{"w_a": {"ref')
    expect(await allPendingPurchaseReferences()).toEqual({ references: [], unread: true })
  })
})
