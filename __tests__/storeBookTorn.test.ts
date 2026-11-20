import RNFS from 'react-native-fs'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import {
  dropStoreWait,
  endNameChecks,
  forgetWalletOrders,
  keepNameCheck,
  nameChecks,
  storeBookEvidence,
  type NameCheck,
  type StoreContext,
} from '../src/wallet/storePurchase'

// The store book is not the source of a store payment, so one that cannot be read is read by the
// screens as empty, as a lost one is. It is never written over nor deleted: the first write sets it
// aside as store-orders.json.unreadable and starts a new book, and Support reads it as unread. A torn
// copy with no book beside it is a first write that was cut, whose last finished state is no book, and
// reads as none.

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'w_a',
  onSparkConnected: () => () => undefined,
}))

const BOOK = `${RNFS.DocumentDirectoryPath}/store-orders.json`
const PATHS = [BOOK, `${BOOK}.tmp`, `${BOOK}.unreadable`, `${BOOK}.tmp.unreadable`]
const TORN = '{"orders": {"ord-1": "w_a"}, "bought": {"ord'

const realWrite = RNFS.writeFile.bind(RNFS)
const put = (path: string, text: string): Promise<void> => realWrite(path, text, 'utf8')

async function raw(path: string): Promise<string | null> {
  return (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null
}

async function disk(): Promise<Record<string, string | null>> {
  return Object.fromEntries(await Promise.all(PATHS.map(async path => [path, await raw(path)] as const)))
}

const ctx: StoreContext = {
  walletId: () => 'w_a',
  wallets: async () => ['w_a'],
  gateway: async () => {
    throw new Error('no gateway in this suite')
  },
}

const CHECK: NameCheck = { domain: 'usevoltz.app', name: 'alice', after: 'register', attempt: ['c-1'] }
const EMPTY = { orders: {}, bought: {}, waits: {}, unknown: {}, about: {}, outcomes: {}, checks: {} }

// Jest maps the spec to its in-memory double, which is never null.
const Durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>

type Method = 'exists' | 'readFile' | 'writeFile' | 'unlink' | 'moveFile' | 'syncFile' | 'rename' | 'syncDirectory'
const FS_METHODS: Method[] = ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']
// The sync module's calls are steps of a write as well: the copy goes in place through its rename.
const SYNC_METHODS: Method[] = ['syncFile', 'rename', 'syncDirectory']

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

// The process dies at call number `k`, and nothing reaches the disk from there on. A write at `k` may
// land half its text first, as Android's truncate-then-write does.
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
})

describe.each<[string, string, string]>([
  ['a book cut mid write', BOOK, TORN],
  ['a book that is not a map', BOOK, '[1, 2]'],
])('%s', (_label, path, text) => {
  beforeEach(() => put(path, text))

  test('is set aside by the first change, which starts a book holding the change alone', async () => {
    await keepNameCheck(CHECK, ctx)
    expect(await raw(`${path}.unreadable`)).toBe(text)
    expect(await raw(`${BOOK}.tmp`)).toBeNull()
    expect(JSON.parse((await raw(BOOK))!)).toEqual({
      ...EMPTY,
      checks: { 'w_a usevoltz.app alice': { ...CHECK, wallet: 'w_a' } },
    })
    expect(await nameChecks('usevoltz.app', ctx)).toEqual([CHECK])
  })

  test('the deletion cleanup over it touches nothing', async () => {
    const before = await disk()
    await forgetWalletOrders('w_a')
    expect(await disk()).toEqual(before)
  })

  test('a change that changes nothing sets nothing aside', async () => {
    const before = await disk()
    await endNameChecks('usevoltz.app', ctx)
    expect(await disk()).toEqual(before)
  })

  test('the screens read it as an empty book, as before, and leave it where it is', async () => {
    const before = await disk()
    expect(await nameChecks('usevoltz.app', ctx)).toEqual([])
    expect(await disk()).toEqual(before)
  })

  test('Support reads it as unread, and the copy set aside keeps it unread after a change', async () => {
    expect(await storeBookEvidence()).toEqual({ references: [], unread: true })
    await dropStoreWait('ord-1')
    expect(await storeBookEvidence()).toEqual({ references: [], unread: true })
  })
})

// Each change starts from an empty book then, and what one adds to it is acted on only once the write
// resolved or is kept by the store or the gateway, so the cut write lost nothing.
describe('a torn copy with no book, a first write that was cut', () => {
  const COPY = `${BOOK}.tmp`
  beforeEach(() => put(COPY, TORN))

  test('reads as an empty book, and Support reads nothing unread from it', async () => {
    expect(await nameChecks('usevoltz.app', ctx)).toEqual([])
    expect(await storeBookEvidence()).toEqual({ references: [], unread: false })
  })

  test('the next change starts a book holding it alone, takes the copy and sets nothing aside', async () => {
    await keepNameCheck(CHECK, ctx)
    expect(await disk()).toEqual({
      [BOOK]: JSON.stringify({ ...EMPTY, checks: { 'w_a usevoltz.app alice': { ...CHECK, wallet: 'w_a' } } }),
      [COPY]: null,
      [`${BOOK}.unreadable`]: null,
      [`${BOOK}.tmp.unreadable`]: null,
    })
    expect(await storeBookEvidence()).toEqual({ references: [], unread: false })
  })

  test('the deletion cleanup over it touches nothing', async () => {
    const before = await disk()
    await forgetWalletOrders('w_a')
    expect(await disk()).toEqual(before)
  })
})

// The one other way to leave a torn copy with no book is a set aside cut between its two moves, which
// has already moved the torn book: Support still reads that as unread, and the next change writes.
test('a set aside cut between its moves reads as an empty book, still unread for Support', async () => {
  await put(BOOK, TORN)
  await put(`${BOOK}.tmp`, '{"orders": {"ord')
  let moves = 0
  const realMove = RNFS.moveFile.bind(RNFS)
  jest.spyOn(RNFS, 'moveFile').mockImplementation(async (from: string, to: string) => {
    moves += 1
    if (moves === 2) {
      throw new Error('killed')
    }
    return realMove(from, to)
  })
  await expect(keepNameCheck(CHECK, ctx)).rejects.toThrow('killed')
  jest.restoreAllMocks()
  expect([await raw(BOOK), await raw(`${BOOK}.tmp`), await raw(`${BOOK}.unreadable`)]).toEqual([
    null,
    '{"orders": {"ord',
    TORN,
  ])
  expect(await nameChecks('usevoltz.app', ctx)).toEqual([])
  expect(await storeBookEvidence()).toEqual({ references: [], unread: true })
  await keepNameCheck(CHECK, ctx)
  expect(await nameChecks('usevoltz.app', ctx)).toEqual([CHECK])
  expect(await raw(`${BOOK}.unreadable`)).toBe(TORN)
  expect(await storeBookEvidence()).toEqual({ references: [], unread: true })
})

test('a book set aside before is never written over by a second one', async () => {
  await put(BOOK, TORN)
  await keepNameCheck(CHECK, ctx)
  await put(BOOK, '[9')
  jest.spyOn(Date, 'now').mockReturnValue(1_234)
  await keepNameCheck({ ...CHECK, name: 'bob' }, ctx)
  expect(await raw(`${BOOK}.unreadable`)).toBe(TORN)
  expect(await raw(`${BOOK}.unreadable-1234`)).toBe('[9')
  expect(JSON.parse((await raw(BOOK))!).checks).toEqual({ 'w_a usevoltz.app bob': { ...CHECK, name: 'bob', wallet: 'w_a' } })
})

describe('a change cut at any step', () => {
  const START = JSON.stringify({ ...EMPTY, bought: { 'ord-1': 'purchased', 'ord-2': 'pending' } })

  test('leaves the book from before or after it, never one that cannot be read', async () => {
    await put(BOOK, START)
    const steps = await stepsOf(() => dropStoreWait('ord-1'))
    expect(steps).toBeGreaterThan(6)
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        ;(RNFS as unknown as { __reset: () => void }).__reset()
        await put(BOOK, START)
        const died = killAt(k, half)
        await expect(dropStoreWait('ord-1')).rejects.toThrow('killed')
        jest.restoreAllMocks()
        expect({ half, k, died: died() !== null }).toEqual({ half, k, died: true })
        const { references, unread } = await storeBookEvidence()
        const answer = JSON.stringify({ references, unread })
        const allowed = [
          JSON.stringify({ references: ['ord-1', 'ord-2'], unread: false }),
          JSON.stringify({ references: ['ord-2'], unread: false }),
        ]
        expect({ half, k, answer: allowed.includes(answer) }).toEqual({ half, k, answer: true })
      }
    }
  })

  // A write over a book leaves no step where it is gone, since the rename replaces it in one step; one
  // that starts from a finished copy and no book moves the copy in first, and a read beside that move
  // finds neither unless it waits in the book's queue.
  test.each([
    ['a book', BOOK],
    ['a finished copy and no book', `${BOOK}.tmp`],
  ])('a read sent at any step, from %s, answers the book from before or after it', async (_label, at) => {
    const prepare = async (): Promise<void> => {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await put(at, START)
    }
    await prepare()
    const steps = await stepsOf(() => dropStoreWait('ord-1'))
    expect(steps).toBeGreaterThan(6)
    for (let k = 0; k < steps; k += 1) {
      await prepare()
      const reads: Promise<string[]>[] = []
      let calls = 0
      trace((_method, _args, go) => {
        if (calls++ === k) {
          reads.push(storeBookEvidence().then(found => found.references))
        }
        return go()
      })
      await dropStoreWait('ord-1')
      jest.restoreAllMocks()
      const [answer] = await Promise.all(reads)
      expect({ k, answer: [['ord-1', 'ord-2'], ['ord-2']].some(v => JSON.stringify(v) === JSON.stringify(answer)) }).toEqual({
        k,
        answer: true,
      })
    }
  })
})

// The screens' read is the one that answers an empty book for a file it cannot read, so a read that
// slipped between a write's look for the book and its look for the copy, as the copy moves in, would
// show no check at all.
test.each([
  ['a book', BOOK],
  ['a finished copy and no book', `${BOOK}.tmp`],
])("a screen's read sent at any step of a change, from %s, answers the checks from before or after it", async (_label, at) => {
  const start = JSON.stringify({ ...EMPTY, checks: { 'w_a usevoltz.app alice': { ...CHECK, wallet: 'w_a' } } })
  const BOB = { ...CHECK, name: 'bob' }
  const prepare = async (): Promise<void> => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await put(at, start)
  }
  await prepare()
  const steps = await stepsOf(() => keepNameCheck(BOB, ctx))
  expect(steps).toBeGreaterThan(6)
  for (let k = 0; k < steps; k += 1) {
    await prepare()
    const reads: Promise<string[]>[] = []
    let calls = 0
    trace((_method, _args, go) => {
      if (calls++ === k) {
        reads.push(nameChecks('usevoltz.app', ctx).then(found => found.map(c => c.name)))
      }
      return go()
    })
    await keepNameCheck(BOB, ctx)
    jest.restoreAllMocks()
    const [answer] = await Promise.all(reads)
    expect({ k, answer: [['alice'], ['alice', 'bob']].some(v => JSON.stringify(v) === JSON.stringify(answer)) }).toEqual({
      k,
      answer: true,
    })
  }
})

test('Support reads what the book keeps for money the store may hold', async () => {
  await put(
    BOOK,
    JSON.stringify({
      ...EMPTY,
      orders: { 'ord-open': 'w_a' },
      bought: { 'ord-paid': 'purchased', 'ord-asked': 'pending' },
      outcomes: {
        'ord-support': { kind: 'support', code: 'no_reference', key: 'txn-9' },
        'ord-refused': { kind: 'refused', refusal: '409 refunded' },
        'ord-done': { kind: 'delivered', host: 'bakery.com.br', expiresAt: 1, frozen: false },
      },
    }),
  )
  expect(await storeBookEvidence()).toEqual({
    references: ['ord-paid', 'ord-asked', 'ord-support', 'txn-9', 'ord-refused'],
    unread: false,
  })
})
