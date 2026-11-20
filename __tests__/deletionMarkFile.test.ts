import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import { readDurable } from '../src/wallet/durableFile'
import {
  allDeletionMarks,
  answerDeletionMark,
  clearDeletionMark,
  clearImportCheck,
  deletionHolds,
  deletionMarkFor,
  deletionRefusal,
  findDeletionMark,
  importCheckDue,
  noteImportCheck,
  writeDeletionMark,
  type DeletionMark,
} from '../src/wallet/deletionMark'
import { ensureRegistered } from '../src/wallet/walletRegistry'

// The two files the deletion marks live in, and what a process killed at each step of a write leaves
// behind. The in-memory RNFS mock refuses a move onto a path that exists, as iOS does.

// Jest maps the spec to its in-memory double, which is never null.
const Durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>

const DOCS = RNFS.DocumentDirectoryPath
const MARKS = `${DOCS}/deletion.json`
const CHECKS = `${DOCS}/deletion-check.json`
const PA = `02${'a'.repeat(64)}`
const PB = `02${'b'.repeat(64)}`
const PC = `02${'c'.repeat(64)}`
const NOW = 1_800_000_000

const mark = (pubkey: string, state: DeletionMark['state'], askedAt = NOW): DeletionMark => ({ pubkey, state, askedAt })

const realWrite = RNFS.writeFile.bind(RNFS)

// The process dies while the file at `path` is being written: part of the text lands, the rest never.
function cutWhileWriting(match: (path: string) => boolean): void {
  jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, encoding?: string) => {
    if (match(path)) {
      await realWrite(path, text.slice(0, Math.floor(text.length / 2)), encoding)
      throw new Error('killed mid write')
    }
    return realWrite(path, text, encoding)
  })
}

async function raw(path: string): Promise<string | null> {
  return (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null
}

// The process dies once the copy is written, read back and synced, as the rename that puts it in place
// is sent.
function cutAtRename(): void {
  jest.spyOn(Durable, 'rename').mockRejectedValueOnce(new Error('killed before the rename'))
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
})

describe('a write that is cut never costs the last finished one', () => {
  test('neither file is ever written in place, only its temporary copy', async () => {
    const written: string[] = []
    jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, encoding?: string) => {
      written.push(path)
      return realWrite(path, text, encoding)
    })
    await writeDeletionMark('a', mark(PA, 'asked'))
    await writeDeletionMark('b', mark(PB, 'removed'))
    await clearDeletionMark('a')
    await answerDeletionMark('b', PB, mark(PB, 'pending'), mark(PB, 'removed'))
    await noteImportCheck('a')
    await noteImportCheck('b')
    await clearImportCheck('a')
    expect(written.length).toBeGreaterThanOrEqual(6)
    expect(written.filter(path => path === MARKS || path === CHECKS)).toEqual([])
    expect(new Set(written)).toEqual(new Set([`${MARKS}.tmp`, `${CHECKS}.tmp`]))
  })

  test('a cut while the temporary copy is written leaves the marks as the last write left them', async () => {
    await writeDeletionMark('a', mark(PA, 'pending'))
    cutWhileWriting(path => path.endsWith('.tmp'))
    await expect(writeDeletionMark('b', mark(PB, 'asked'))).rejects.toThrow('killed')
    jest.restoreAllMocks()
    expect((await deletionMarkFor('a'))?.state).toBe('pending')
    expect(await findDeletionMark({ walletId: 'b', pubkey: PB })).toBeNull()
    // The next write goes through, and the torn copy never reaches the file.
    await writeDeletionMark('b', mark(PB, 'asked'))
    expect(JSON.parse((await raw(MARKS)) ?? 'null')).toEqual({ a: mark(PA, 'pending'), b: mark(PB, 'asked') })
  })

  test('a cut before the rename leaves the marks as the last write left them, and the next write drops its copy', async () => {
    await writeDeletionMark('a', mark(PA, 'pending'))
    const before = await raw(MARKS)
    cutAtRename()
    await expect(writeDeletionMark('b', mark(PB, 'asked'))).rejects.toThrow('killed')
    jest.restoreAllMocks()
    // The copy was finished, and the file it was to replace still holds the last finished write.
    expect(JSON.parse((await raw(`${MARKS}.tmp`)) ?? 'null')).toEqual({ a: mark(PA, 'pending'), b: mark(PB, 'asked') })
    expect(await raw(MARKS)).toBe(before)
    expect((await deletionMarkFor('a'))?.state).toBe('pending')
    expect(await deletionMarkFor('b')).toBeNull()
    await writeDeletionMark('c', mark(PC, 'removed'))
    expect(Object.keys(JSON.parse((await raw(MARKS)) ?? '{}')).sort()).toEqual(['a', 'c'])
    expect(await RNFS.exists(`${MARKS}.tmp`)).toBe(false)
  })

  test('a first write cut at its rename is read from its copy, and a second cut right after never costs it', async () => {
    cutAtRename()
    await expect(writeDeletionMark('a', mark(PA, 'pending'))).rejects.toThrow('killed')
    jest.restoreAllMocks()
    // No file was there before, so only the finished copy holds a.
    expect(await RNFS.exists(MARKS)).toBe(false)
    expect((await deletionMarkFor('a'))?.state).toBe('pending')
    // The next write moves that copy in before it writes its own, and is cut while it writes its own.
    cutWhileWriting(path => path.endsWith('.tmp'))
    await expect(writeDeletionMark('b', mark(PB, 'asked'))).rejects.toThrow('killed')
    jest.restoreAllMocks()
    expect((await deletionMarkFor('a'))?.state).toBe('pending')
    expect(await deletionMarkFor('b')).toBeNull()
  })

  test('a temporary copy that does not read back as written never replaces the file', async () => {
    await writeDeletionMark('a', mark(PA, 'done'))
    // A write the platform reports as done that left a short file, as a write over an existing file
    // that does not truncate leaves one too.
    jest.spyOn(RNFS, 'writeFile').mockImplementation(async (path: string, text: string, encoding?: string) =>
      realWrite(path, path.endsWith('.tmp') ? text.slice(0, -3) : text, encoding),
    )
    await expect(writeDeletionMark('b', mark(PB, 'asked'))).rejects.toThrow('did not read back')
    jest.restoreAllMocks()
    expect(JSON.parse((await raw(MARKS)) ?? 'null')).toEqual({ a: mark(PA, 'done') })
  })

  test('the import list survives a cut the same way', async () => {
    await noteImportCheck('a')
    cutWhileWriting(path => path === `${CHECKS}.tmp`)
    await expect(noteImportCheck('b')).rejects.toThrow('killed')
    jest.restoreAllMocks()
    expect(await importCheckDue('a')).toBe(true)
    expect(await importCheckDue('b')).toBe(false)
    cutAtRename()
    await expect(noteImportCheck('b')).rejects.toThrow('killed')
    jest.restoreAllMocks()
    expect(await raw(CHECKS)).toBe('["a"]')
    expect(await importCheckDue('a')).toBe(true)
    expect(await importCheckDue('b')).toBe(false)
    await noteImportCheck('b')
    expect(await importCheckDue('b')).toBe(true)
  })

  test('a clear cut halfway never brings back an older copy', async () => {
    await writeDeletionMark('a', mark(PA, 'asked'))
    await realWrite(`${MARKS}.tmp`, JSON.stringify({ a: mark(PA, 'asked'), z: mark(PC, 'done') }), 'utf8')
    const realUnlink = RNFS.unlink.bind(RNFS)
    let unlinks = 0
    jest.spyOn(RNFS, 'unlink').mockImplementation(async (path: string) => {
      unlinks += 1
      if (unlinks === 2) {
        throw new Error('killed mid clear')
      }
      return realUnlink(path)
    })
    await expect(clearDeletionMark('a')).rejects.toThrow('killed')
    jest.restoreAllMocks()
    // The clear did not finish, so a may still hold; the stale copy's z never does.
    expect(await deletionHolds({ pubkey: PC })).toBe(false)
  })

  test('clearing the last mark leaves no copy behind that could bring it back', async () => {
    await writeDeletionMark('a', mark(PA, 'asked'))
    // A finished copy left by a write cut before its swap, beside the file it lost to.
    await realWrite(`${MARKS}.tmp`, JSON.stringify({ a: mark(PA, 'asked'), z: mark(PC, 'done') }), 'utf8')
    await clearDeletionMark('a')
    expect(await RNFS.exists(MARKS)).toBe(false)
    expect(await RNFS.exists(`${MARKS}.tmp`)).toBe(false)
    expect(await deletionHolds({ pubkey: PC })).toBe(false)
  })
})

// RNFS answers its calls in the order they arrive on one native queue (RNFSManager.m methodQueue), and
// the syncs and the rename on another (specs/NativeVoltzDurable.ts); a caller sends its next call only
// once the last one answered. Emulated over the in-memory mocks, with a turn of the event loop before
// each call so every answer lands before the next runs. `during` hears each call's number as the call
// is queued, before it runs.
function nativeQueues(during: (call: number) => void): void {
  let calls = 0
  const queues: [object, string[]][] = [
    [RNFS, ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']],
    [Durable, ['syncFile', 'rename', 'syncDirectory']],
  ]
  for (const [host, methods] of queues) {
    let tail: Promise<unknown> = Promise.resolve()
    for (const method of methods) {
      const target = host as Record<string, (...args: unknown[]) => Promise<unknown>>
      const real = target[method].bind(host)
      jest.spyOn(target, method).mockImplementation(((...args: unknown[]) => {
        const call = tail.then(() => new Promise(resolve => setImmediate(resolve))).then(() => real(...args))
        tail = call.catch(() => undefined)
        during(calls++)
        return call
      }) as never)
    }
  }
}

// The rename replaces a file in one step, so a write over a file leaves no point where it is gone. A
// write that starts from a finished copy and no file, a first write cut at its rename, moves that copy
// in before its own, and a read beside that move can find no file and then no copy.
describe('a read that lands during a write never reads the file as empty', () => {
  const markFirst = () => writeDeletionMark('a', mark(PA, 'removed'))
  const markOther = () => writeDeletionMark('b', mark(PB, 'asked'))

  // Leaves the first wallet's write as a finished copy with no file beside it.
  async function startFrom(first: () => Promise<void>): Promise<void> {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    cutAtRename()
    await expect(first()).rejects.toThrow('killed')
    jest.restoreAllMocks()
  }

  // Sends `read` as call number `k` of the write is queued, and answers what it read.
  async function readAtStep<T>(k: number, other: () => Promise<void>, read: () => Promise<T>): Promise<T> {
    let during: Promise<T> | undefined
    nativeQueues(n => {
      if (n === k) {
        during = read()
      }
    })
    await other()
    jest.restoreAllMocks()
    if (during === undefined) {
      throw new Error(`no call number ${k}`)
    }
    return during
  }

  async function stepsOf(other: () => Promise<void>): Promise<number> {
    let steps = 0
    nativeQueues(() => {
      steps += 1
    })
    await other()
    jest.restoreAllMocks()
    return steps
  }

  test.each([
    ['a mark, looked up', MARKS, markFirst, markOther, () => deletionHolds({ walletId: 'a' })],
    ['a mark, listed', MARKS, markFirst, markOther, async () => 'a' in (await allDeletionMarks())],
    ['an import check', CHECKS, () => noteImportCheck('a'), () => noteImportCheck('b'), () => importCheckDue('a')],
  ])('%s: another wallet being written still leaves the first one held at every step', async (_, path, first, other, holds) => {
    await startFrom(first)
    expect([await RNFS.exists(path), await RNFS.exists(`${path}.tmp`)]).toEqual([false, true])
    // Outside any write the first wallet holds, from its copy alone, which is what each read has to keep.
    expect(await holds()).toBe(true)
    const steps = await stepsOf(other)
    expect(steps).toBeGreaterThan(4)
    for (let k = 0; k < steps; k += 1) {
      await startFrom(first)
      expect({ k, held: await readAtStep(k, other, holds) }).toEqual({ k, held: true })
    }
    expect(await holds()).toBe(true)
  })

  // The emulation has to be able to show the gap: the same read of the marks, sent outside their queue.
  test('control: a read of the marks outside their queue finds no marks at some step', async () => {
    await startFrom(markFirst)
    const steps = await stepsOf(markOther)
    const answers: unknown[] = []
    for (let k = 0; k < steps; k += 1) {
      await startFrom(markFirst)
      answers.push(await readAtStep(k, markOther, () => readDurable(MARKS, () => true).catch(() => 'failed')))
    }
    // Null is the file found missing, then its copy found missing once the rename moved it.
    expect(answers).toContain(null)
  })
})

describe('a file that cannot be read holds every wallet until each is read back', () => {
  beforeEach(async () => {
    // The registry lists a wallet only when its seed is on the device.
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    await ensureRegistered('a', 'fpa')
    await ensureRegistered('b', 'fpb')
  })

  test.each([
    ['a torn file', async () => realWrite(MARKS, '{"a":{"pubkey":"02', 'utf8')],
    ['a torn temporary copy with no file', async () => realWrite(`${MARKS}.tmp`, '{"a":{"pub', 'utf8')],
    ['a file of another shape', async () => realWrite(MARKS, 'null', 'utf8')],
    ['a list where the marks belong', async () => realWrite(MARKS, '[]', 'utf8')],
    ['a repair record that cannot be read', async () => realWrite(MARKS, '{"~repair":{"unread":"a"}}', 'utf8')],
  ])('%s holds every wallet and every key', async (_, plant) => {
    await plant()
    for (const by of [{ walletId: 'a' }, { walletId: 'b', pubkey: PB }, { pubkey: PC }]) {
      expect((await findDeletionMark(by))?.unknown).toBe(true)
      expect(await deletionHolds(by)).toBe(true)
    }
    // An explicit purchase meets the gateway's own code, never the removed address's.
    expect(await deletionRefusal({ pubkey: PA })).toBe('deleted')
  })

  test("a write over a torn file keeps every other wallet held, never dropped", async () => {
    await realWrite(MARKS, '{"a":{"pubkey":"02', 'utf8')
    await writeDeletionMark('a', mark(PA, 'removed'))
    expect(await findDeletionMark({ walletId: 'a', pubkey: PA })).toEqual({ walletId: 'a', mark: mark(PA, 'removed') })
    expect((await findDeletionMark({ walletId: 'b', pubkey: PB }))?.unknown).toBe(true)
    expect(await deletionHolds({ pubkey: PB })).toBe(true)
  })

  test('each wallet is let go only by its own answer, and the record goes with the last one', async () => {
    await realWrite(MARKS, '{"a":{"pubkey":"02', 'utf8')
    // No answer for anyone yet: still held.
    expect(await deletionHolds({ walletId: 'a', pubkey: PA })).toBe(true)
    expect(await answerDeletionMark('a', PA, null, null)).toBe(true)
    // a is read as holding nothing, by its id and by its key.
    expect(await findDeletionMark({ walletId: 'a', pubkey: PA })).toBeNull()
    expect(await deletionHolds({ pubkey: PA })).toBe(false)
    // b is not read yet, and neither is a key nobody answered for.
    expect((await findDeletionMark({ walletId: 'b' }))?.unknown).toBe(true)
    expect(await deletionHolds({ pubkey: PB })).toBe(true)
    expect(await deletionHolds({ walletId: 'a', pubkey: PC })).toBe(true)
    expect(JSON.parse((await raw(MARKS)) ?? '{}')['~repair']).toEqual({ unread: ['b'], clear: [PA] })

    expect(await answerDeletionMark('b', PB, mark(PB, 'pending'), null)).toBe(true)
    expect((await deletionMarkFor('b', PB))?.state).toBe('pending')
    expect(await deletionHolds({ pubkey: PC })).toBe(false)
    expect(JSON.parse((await raw(MARKS)) ?? '{}')).toEqual({ b: mark(PB, 'pending') })
  })

  test('a wallet removed meanwhile is no longer waited on', async () => {
    await realWrite(MARKS, '{"a":{"pubkey":"02', 'utf8')
    await clearDeletionMark('a')
    expect(await deletionHolds({ walletId: 'a' })).toBe(false)
    expect((await findDeletionMark({ walletId: 'b' }))?.unknown).toBe(true)
    await answerDeletionMark('b', PB, null, null)
    expect(await raw(MARKS)).toBeNull()
  })

  test('with no wallet listed, nothing is written and every wallet stays held', async () => {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await realWrite(MARKS, '{"a":{"pubkey":"02', 'utf8')
    await expect(writeDeletionMark('a', mark(PA, 'removed'))).rejects.toThrow('no wallet is listed')
    await expect(answerDeletionMark('a', PA, null, null)).rejects.toThrow('no wallet is listed')
    expect(await deletionHolds({ walletId: 'a', pubkey: PA })).toBe(true)
  })

  test('an import list that cannot be read makes every listed wallet due, and a note keeps the others', async () => {
    await realWrite(CHECKS, '["a",', 'utf8')
    expect(await importCheckDue('a')).toBe(true)
    expect(await importCheckDue('b')).toBe(true)
    await noteImportCheck('c')
    expect(JSON.parse((await raw(CHECKS)) ?? '[]')).toEqual(['a', 'b', 'c'])
    await clearImportCheck('a')
    expect(JSON.parse((await raw(CHECKS)) ?? '[]')).toEqual(['b', 'c'])
  })
})

// A read the platform refuses says nothing about the bytes, so it is never taken for a torn file: the
// rebuild that a torn file gets would be written over intact marks and lose a 'removed' the gateway
// knows nothing of.
describe('a read the platform refuses on intact marks', () => {
  beforeEach(async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true).mockResolvedValueOnce(true)
    await ensureRegistered('a', 'fpa')
    await ensureRegistered('b', 'fpb')
  })

  // The next text read of the marks rejects as an I/O error would, and so does the bytes read after it.
  function refuseNextRead(): void {
    const real = RNFS.readFile.bind(RNFS)
    let left = 1
    let bytes = false
    jest.spyOn(RNFS, 'readFile').mockImplementation(((path: string, encoding?: string) => {
      if (path === MARKS && ((encoding === 'utf8' && left > 0) || (encoding === 'base64' && bytes))) {
        bytes = encoding === 'utf8'
        left -= encoding === 'utf8' ? 1 : 0
        return Promise.reject(new Error('EIO: i/o error'))
      }
      return (real as (...a: unknown[]) => Promise<string>)(path, encoding)
    }) as never)
  }

  test.each([
    ['writing a mark', () => writeDeletionMark('b', mark(PB, 'asked'))],
    ['clearing a mark', () => clearDeletionMark('b')],
    ['answering a mark', () => answerDeletionMark('b', PB, mark(PB, 'pending'), mark(PB, 'removed'))],
  ])('%s rejects and leaves the marks as they were', async (_, write) => {
    await writeDeletionMark('a', mark(PA, 'removed'))
    await writeDeletionMark('b', mark(PB, 'pending'))
    const before = await raw(MARKS)
    refuseNextRead()
    await expect(write()).rejects.toThrow('EIO')
    jest.mocked(RNFS.readFile).mockRestore()
    expect(await raw(MARKS)).toBe(before)
    expect(await deletionMarkFor('a', PA)).toEqual(mark(PA, 'removed'))
  })
})

describe('an answer is written only over the mark it was asked from', () => {
  test('a mark that changed meanwhile is kept, and the answer is not written', async () => {
    await writeDeletionMark('a', mark(PA, 'asked', NOW + 5))
    expect(await answerDeletionMark('a', PA, null, mark(PA, 'asked', NOW))).toBe(false)
    expect(await deletionMarkFor('a')).toEqual(mark(PA, 'asked', NOW + 5))
    expect(await answerDeletionMark('a', PA, mark(PA, 'pending', NOW + 5), mark(PA, 'asked', NOW + 5))).toBe(true)
    expect((await deletionMarkFor('a'))?.state).toBe('pending')
  })

  test('a mark written over no mark is kept from an answer for no mark', async () => {
    await writeDeletionMark('a', mark(PA, 'removed'))
    expect(await answerDeletionMark('a', PA, mark(PA, 'pending'), null)).toBe(false)
    expect((await deletionMarkFor('a'))?.state).toBe('removed')
  })
})

describe('the refusal an explicit purchase meets', () => {
  test.each([
    ['removed', 'address_removed'],
    ['asked', 'deleted'],
    ['pending', 'deleted'],
    ['done', 'deleted'],
  ] as const)('%s refuses with %s', async (state, code) => {
    await writeDeletionMark('a', mark(PA, state))
    expect(await deletionRefusal({ pubkey: PA })).toBe(code)
  })

  test('nothing refuses a key with no mark', async () => {
    await writeDeletionMark('a', mark(PA, 'removed'))
    expect(await deletionRefusal({ pubkey: PB })).toBeNull()
  })
})
