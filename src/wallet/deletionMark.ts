import RNFS from 'react-native-fs'
import { isUnreadableFile, readDurable, removeDurable, serialQueue, writeDurable } from './durableFile'
import { loadRegistry } from './walletRegistry'

/**
 * Which wallets on this device asked Voltz to delete their data, or gave their address up, and how
 * far that went. Kept in a module that imports nothing of the wallet but the registry, so the SDK
 * bridge, push and the purchase modules can all stop on it without an import cycle through deletion.ts.
 *
 * Written before a deletion request leaves the device, as `asked`, so an app killed mid request still
 * holds every automatic step (address, push, purchase) until a status read settles what the gateway
 * recorded. A mark is never written for a wallet that has not asked, and only `return`, a definitive
 * refusal or a status of `none` or `returned` takes one away.
 */
export type DeletionState =
  // The request was signed and is being sent, or was sent and no answer was read yet.
  | 'asked'
  // The gateway recorded the request (202, or a status read of `pending`).
  | 'pending'
  // The gateway said `done` and this device dropped its own copies of the wallet's records.
  | 'done'
  // The address was given up from the address screen. Nothing was asked of the gateway.
  | 'removed'

export type DeletionMark = {
  /** The wallet's identity key, which the gateway and the push registration are keyed by. */
  pubkey: string
  state: DeletionState
  /** Device clock, unix seconds, when the mark was written. */
  askedAt: number
  /** Gateway clock, unix seconds, when the request was recorded. */
  requestedAt?: number
  /** Gateway clock, unix seconds, by when the request ends. */
  deadline?: number
  /** Gateway clock, unix seconds, when the gateway finished. */
  doneAt?: number
  /** The domains this wallet owned when it asked, so the local cleanup can point the wallet back. */
  ownedHosts?: string[]
  /**
   * Device clock, unix seconds, when the address had been given up before this request. A request
   * the gateway never recorded puts the wallet back as removed rather than unheld, so asking for a
   * deletion that never arrived does not undo "remove address".
   */
  removedAt?: number
}

// --- files that survive a cut ----------------------------------------------------------------------

// Every file here is written and read through durableFile.ts. Each has a stand-in for when it cannot
// be read (the registry, or no entry), so a write replaces what could not be read ('replace') where
// a file with no other source would refuse.

// --- the marks -------------------------------------------------------------------------------------

const FILE = `${RNFS.DocumentDirectoryPath}/deletion.json`

// Stored beside the marks while a file that could not be read is rebuilt from status reads. No wallet
// id can take it (newWalletId and PRIMARY_ID in seed.ts).
const REPAIR_KEY = '~repair'

/**
 * The wallets on this device whose mark was lost with an unreadable file and is not read back yet, and
 * the keys a status read has since said hold nothing. Dropped once no wallet is left unread.
 */
type Repair = { unread: string[]; clear: string[] }

type Stored = { marks: Record<string, DeletionMark>; repair?: Repair }

const STATES: readonly DeletionState[] = ['asked', 'pending', 'done', 'removed']

function isMark(value: unknown): value is DeletionMark {
  const mark = value as DeletionMark
  return (
    typeof mark === 'object' &&
    mark !== null &&
    typeof mark.pubkey === 'string' &&
    STATES.includes(mark.state) &&
    typeof mark.askedAt === 'number'
  )
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isIdList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every(id => typeof id === 'string')

const isRepair = (value: unknown): value is Repair =>
  isRecord(value) && isIdList(value.unread) && isIdList(value.clear)

// Anything else at the top is no file of marks, and a repair record that cannot be read makes the whole
// file unreadable: dropping it would free the wallets it still holds.
const validMarks = (value: unknown): boolean =>
  isRecord(value) && (value[REPAIR_KEY] === undefined || isRepair(value[REPAIR_KEY]))

const keyOf = (pubkey: string | null | undefined): string => pubkey?.trim().toLowerCase() ?? ''

async function readAll(): Promise<Stored> {
  const raw = (await readDurable(FILE, validMarks)) as Record<string, unknown> | null
  if (raw === null) {
    return { marks: {} }
  }
  const marks = Object.fromEntries(
    Object.entries(raw).filter(([id, value]) => id !== REPAIR_KEY && isMark(value)),
  ) as Record<string, DeletionMark>
  const repair = raw[REPAIR_KEY]
  return isRepair(repair) ? { marks, repair } : { marks }
}

async function writeAll(stored: Stored): Promise<void> {
  const { marks, repair } = stored
  if (Object.keys(marks).length === 0 && !repair) {
    await removeDurable(FILE)
    return
  }
  const text = JSON.stringify(repair ? { ...marks, [REPAIR_KEY]: repair } : marks)
  await writeDurable(FILE, text, validMarks, 'replace')
}

// What a file that cannot be read becomes when something has to be written: no mark known, and every
// wallet in the registry unread, so each one stays held until a status read answers for it
// (deletion.ts, checkImportedDeletion). Writing the marks the file held would need them, and dropping
// the other wallets would free them. With no wallet listed nothing is written, and every wallet stays
// held as unknown.
async function rebuildFromRegistry(): Promise<Stored> {
  const unread = (await loadRegistry()).wallets.map(wallet => wallet.id)
  if (unread.length === 0) {
    throw new Error('deletion marks cannot be read, and no wallet is listed to read them back for')
  }
  return { marks: {}, repair: { unread, clear: [] } }
}

// Only a torn file is rebuilt. A read the platform refused leaves the file as it is, since a rebuild
// written over intact marks would drop a 'removed' the gateway knows nothing of.
async function readForWrite(): Promise<Stored> {
  try {
    return await readAll()
  } catch (err) {
    if (!isUnreadableFile(err)) {
      throw err
    }
    return rebuildFromRegistry()
  }
}

// Changes are applied one after another, since a status read on focus and a request on a press can
// both write, and each change reads the file before writing it. Reads wait in the same queue (see
// durableFile.ts), so none finds a file halfway through a write.
const serial = serialQueue()

// The only ways a lookup outside a change reads either file. A change reads them inside its own turn.
const readMarks = (): Promise<Stored> => serial(readAll)
const readDue = (): Promise<string[]> => serial(readChecks)

// Read when this device does not know a wallet's mark: a mark of unknown state rather than none.
// Answering "no mark" would let an automatic register recreate the address of a wallet that asked for
// it to be deleted, which is the one outcome this file exists to prevent; answering "marked" costs a
// missing address until a status read answers for the wallet.
const UNKNOWN: DeletionMark = { pubkey: '', state: 'asked', askedAt: 0 }

export type FoundMark = {
  walletId: string
  mark: DeletionMark
  /** The file could not be read, or this wallet's mark was lost with it and is not read back yet. */
  unknown?: true
}

const unknownAt = (walletId: string | null | undefined): FoundMark => ({
  walletId: walletId ?? '',
  mark: UNKNOWN,
  unknown: true,
})

/**
 * The one lookup of a mark, used by every reader: the wallet's own mark by its id, or else any mark
 * written for the same key. The key is what the gateway refuses, so a wallet whose seed is marked
 * under another id here is held and shown the same way, and every stop and every screen agrees.
 * `walletId` in the answer is where the mark is stored, which is where a change to it is written.
 *
 * While a file that could not be read is rebuilt, a wallet not read back yet holds as unknown, and
 * so does a key no status read has answered for, since a wallet still unread may hold the same seed.
 */
export async function findDeletionMark(by: { walletId?: string | null; pubkey?: string | null }): Promise<FoundMark | null> {
  let stored: Stored
  try {
    stored = await readMarks()
  } catch {
    return unknownAt(by.walletId)
  }
  return lookup(stored, by)
}

function lookup(stored: Stored, by: { walletId?: string | null; pubkey?: string | null }): FoundMark | null {
  if (by.walletId && stored.marks[by.walletId]) {
    return { walletId: by.walletId, mark: stored.marks[by.walletId] }
  }
  const key = keyOf(by.pubkey)
  if (key) {
    const entry = Object.entries(stored.marks).find(([, mark]) => keyOf(mark.pubkey) === key)
    if (entry) {
      return { walletId: entry[0], mark: entry[1] }
    }
  }
  const { repair } = stored
  if (!repair) {
    return null
  }
  if (by.walletId && repair.unread.includes(by.walletId)) {
    return unknownAt(by.walletId)
  }
  if (key && !repair.clear.includes(key) && repair.unread.length > 0) {
    return unknownAt(by.walletId)
  }
  return null
}

/** The mark for one wallet, or null, through the same lookup (findDeletionMark). */
export async function deletionMarkFor(walletId: string, pubkey?: string | null): Promise<DeletionMark | null> {
  return (await findDeletionMark({ walletId, pubkey }))?.mark ?? null
}

/** Every mark, keyed by wallet id. Empty when the file is missing or unreadable. */
export async function allDeletionMarks(): Promise<Record<string, DeletionMark>> {
  try {
    return (await readMarks()).marks
  } catch {
    return {}
  }
}

/**
 * Whether automatic work for this wallet or this key has to stop: creating an address, registering
 * push, opening a purchase. Any mark holds, `removed` included, since the address screen's "remove"
 * means the same "do not bring it back on your own".
 */
export async function deletionHolds(by: { walletId?: string | null; pubkey?: string | null }): Promise<boolean> {
  return (await findDeletionMark(by)) !== null
}

/**
 * The refusal an explicit purchase meets for this key: `address_removed` when the only reason is an
 * address given up on this device, which "Create the address again" lifts and the gateway knows
 * nothing about, `deleted` for any other mark, as the gateway refuses it, and null when nothing holds.
 */
export async function deletionRefusal(by: { walletId?: string | null; pubkey?: string | null }): Promise<'deleted' | 'address_removed' | null> {
  const found = await findDeletionMark(by)
  if (!found) {
    return null
  }
  return !found.unknown && found.mark.state === 'removed' ? 'address_removed' : 'deleted'
}

/**
 * Writes the mark for one wallet, replacing what was there. A file that could not be read is rebuilt
 * around it, the other wallets held until each is read back, never dropped. Throws when it cannot be
 * written.
 */
export function writeDeletionMark(walletId: string, mark: DeletionMark): Promise<void> {
  return serial(async () => {
    const stored = await readForWrite()
    stored.marks[walletId] = mark
    await writeAll(stored)
  })
}

/**
 * Drops the mark for one wallet, and the wallet from a rebuild still waiting on it, since the wallet
 * is being removed or came back. Throws when it cannot be written.
 */
export function clearDeletionMark(walletId: string): Promise<void> {
  return serial(async () => {
    // Never fails the clear: a time that stays behind only spares one daily read.
    await dropStatusReadAt(walletId).catch(() => undefined)
    const stored = await readForWrite()
    const unread = stored.repair?.unread.includes(walletId) === true
    if (!(walletId in stored.marks) && !unread) {
      return
    }
    delete stored.marks[walletId]
    settleRepair(stored, walletId, null, null)
    await writeAll(stored)
  })
}

/**
 * Records that the wallet gave its address up, looked up in the same turn as the write, so a mark
 * another writer put down after the caller's own read is never replaced. A wallet nothing holds gets
 * `removed`. An `asked` or `pending` mark keeps its state and gains `removedAt`, so a status of `none`
 * or `returned` later puts the wallet back as removed (deletion.ts, letGo) rather than letting it go
 * with no address. Any other mark already holds the wallet past a let-go, and nothing is written.
 * Answers whether it wrote. Throws when the file cannot be read or the wallet's state is not known,
 * since a `removed` over that state would end the read-back that settles it, so the caller writes this
 * before it forgets or gives up anything.
 */
export function markAddressRemoved(walletId: string, mark: DeletionMark): Promise<boolean> {
  return serial(async () => {
    const stored = await readAll()
    const found = lookup(stored, { walletId, pubkey: mark.pubkey })
    if (found?.unknown) {
      throw new Error('deletion state not known yet')
    }
    if (!found) {
      stored.marks[walletId] = mark
      await writeAll(stored)
      return true
    }
    const held = found.mark
    if ((held.state !== 'asked' && held.state !== 'pending') || typeof held.removedAt === 'number') {
      return false
    }
    stored.marks[found.walletId] = { ...held, removedAt: mark.askedAt }
    await writeAll(stored)
    return true
  })
}

/**
 * Takes back what markAddressRemoved wrote, only while it is still there: the `removed` mark while it
 * is still the wallet's mark, or the `removedAt` it gave a request's mark, so a mark written meanwhile
 * stays. Throws when it cannot be written.
 */
export function unmarkAddressRemoved(walletId: string, mark: DeletionMark): Promise<void> {
  return serial(async () => {
    const stored = await readAll()
    if (sameMark(stored.marks[walletId] ?? null, mark)) {
      delete stored.marks[walletId]
      await writeAll(stored)
      return
    }
    const found = lookup(stored, { walletId, pubkey: mark.pubkey })
    if (!found || found.unknown || found.mark.state === 'removed' || found.mark.removedAt !== mark.askedAt) {
      return
    }
    const back = { ...found.mark }
    delete back.removedAt
    stored.marks[found.walletId] = back
    await writeAll(stored)
  })
}

// `removedAt` counts: a status answer read from the mark before a removal noted it would otherwise
// write over it, and a `none` would let the wallet go with its address already given up.
const sameMark = (a: DeletionMark | null, b: DeletionMark | null): boolean =>
  a === null || b === null
    ? a === b
    : a.state === b.state && a.askedAt === b.askedAt && a.pubkey === b.pubkey && a.removedAt === b.removedAt

// One wallet answered for: out of the wallets a rebuild waits on, and its key read as clear when the
// answer left no mark. The record goes once no wallet is left unread.
function settleRepair(stored: Stored, walletId: string, pubkey: string | null, next: DeletionMark | null): void {
  if (!stored.repair) {
    return
  }
  const unread = stored.repair.unread.filter(id => id !== walletId)
  const key = keyOf(pubkey)
  const clear = !next && key && !stored.repair.clear.includes(key) ? [...stored.repair.clear, key] : stored.repair.clear
  if (unread.length > 0) {
    stored.repair = { unread, clear }
  } else {
    delete stored.repair
  }
}

/**
 * Writes what the gateway answered for one wallet's key: the mark the answer says, or none. Applied
 * only while the wallet's stored mark is still `expected`, the one the question was asked from (null
 * for no mark, which is also how an unknown one is stored), so an answer that lands after another
 * change never undoes it; false then, and nothing is written. `any` is for an answer newer than
 * anything a concurrent read could have written, a request the gateway just recorded. During a
 * rebuild the wallet counts as read, and a key the answer left unmarked as clear.
 */
export function answerDeletionMark(
  walletId: string,
  pubkey: string,
  next: DeletionMark | null,
  expected: DeletionMark | null | 'any',
): Promise<boolean> {
  return serial(async () => {
    const stored = await readForWrite()
    if (expected !== 'any' && !sameMark(stored.marks[walletId] ?? null, expected)) {
      return false
    }
    if (!stored.repair && next === null && !(walletId in stored.marks)) {
      return true
    }
    if (next) {
      stored.marks[walletId] = next
    } else {
      delete stored.marks[walletId]
    }
    settleRepair(stored, walletId, pubkey, next)
    await writeAll(stored)
    return true
  })
}

// --- the daily status read of a wallet on a domain of its own -------------------------------------

// When each wallet's deletion status was last answered by the daily read (deletion.ts,
// readDeletionOnFocus), in gateway unix seconds. Written as the marks are, and dropped with the
// wallet's mark.
const READ_FILE = `${RNFS.DocumentDirectoryPath}/deletion-read.json`

const isTimes = (value: unknown): value is Record<string, number> =>
  isRecord(value) && Object.values(value).every(at => typeof at === 'number' && Number.isFinite(at))

// A file that cannot be read answers no times, so every wallet is due once and the next answered read
// writes the file again; it never stops a read.
async function readTimes(): Promise<Record<string, number>> {
  try {
    return ((await readDurable(READ_FILE, isTimes)) as Record<string, number> | null) ?? {}
  } catch {
    return {}
  }
}

async function writeTimes(times: Record<string, number>): Promise<void> {
  if (Object.keys(times).length === 0) {
    await removeDurable(READ_FILE)
    return
  }
  await writeDurable(READ_FILE, JSON.stringify(times), isTimes, 'replace')
}

async function dropStatusReadAt(walletId: string): Promise<void> {
  const times = await readTimes()
  if (!(walletId in times)) {
    return
  }
  delete times[walletId]
  await writeTimes(times)
}

export async function lastStatusReadAt(walletId: string): Promise<number | null> {
  return (await serial(readTimes))[walletId] ?? null
}

export function noteStatusReadAt(walletId: string, at: number): Promise<void> {
  return serial(async () => {
    const times = await readTimes()
    times[walletId] = at
    await writeTimes(times)
  })
}

// --- the status read after an import ------------------------------------------------------------

// Wallets imported on this device whose deletion status has not been read yet. A seed deleted from
// another device holds no mark here, so its first open after the import asks the gateway once and
// writes the mark the answer says (deletion.ts, checkImportedDeletion). Dropped on the first answer
// and when the wallet is removed.
const CHECK_FILE = `${RNFS.DocumentDirectoryPath}/deletion-check.json`

// A list that cannot be read is read as every wallet in the registry due, so a cut write drops no
// wallet's read, and a wallet read for nothing costs one request.
async function readChecks(): Promise<string[]> {
  try {
    return ((await readDurable(CHECK_FILE, isIdList)) as string[] | null) ?? []
  } catch {
    return (await loadRegistry()).wallets.map(wallet => wallet.id)
  }
}

async function writeChecks(due: string[]): Promise<void> {
  if (due.length === 0) {
    await removeDurable(CHECK_FILE)
    return
  }
  await writeDurable(CHECK_FILE, JSON.stringify(due), isIdList, 'replace')
}

export function noteImportCheck(walletId: string): Promise<void> {
  return serial(async () => {
    const due = await readChecks()
    if (!due.includes(walletId)) {
      await writeChecks([...due, walletId])
    }
  })
}

export async function importCheckDue(walletId: string): Promise<boolean> {
  try {
    return (await readDue()).includes(walletId)
  } catch {
    return false
  }
}

// Tolerates a file it cannot read, which already answers as every listed wallet due: removing a
// wallet never fails on this list.
export function clearImportCheck(walletId: string): Promise<void> {
  return serial(async () => {
    const due = await readChecks().catch((): string[] => [])
    if (!due.includes(walletId)) {
      return
    }
    await writeChecks(due.filter(id => id !== walletId))
  })
}

/**
 * The error a stopped step throws, with the refusal code as the message: the gateway's own `deleted`,
 * or `address_removed` for an address given up on this device (deletionRefusal).
 */
export function deletedError<C extends 'deleted' | 'address_removed' = 'deleted'>(code?: C): Error & { code: C } {
  const value = (code ?? 'deleted') as C
  return Object.assign(new Error(value), { code: value })
}

// --- a gateway refusal of `deleted` ------------------------------------------------------------

type DeletedHearer = (pubkey: string) => void

const hearers = new Set<DeletedHearer>()
// Keys refused before anything listened, handed to the first listener. deletion.ts listens from its
// own module scope, and Metro's inline requires load it only when a screen first calls into it, after
// the boot's push registration and store sync may already have been refused.
const unheard = new Set<string>()

/**
 * The gateway answered a call signed by this key with 409 `deleted`: its data was deleted, possibly
 * from another device, and this device may hold no mark for it. Every module that reads that refusal
 * says so here, and deletion.ts reads the status once and writes the mark from the answer, so the
 * local stops hold the wallet before it is refused again. Returns at once and never throws, so the
 * refused call's own result is untouched. This module cannot import deletion.ts, which imports the
 * callers.
 */
export function noteGatewayDeleted(by: { pubkey: string | null | undefined }): void {
  const key = keyOf(by.pubkey)
  if (!key) {
    return
  }
  if (hearers.size === 0) {
    unheard.add(key)
    return
  }
  hearers.forEach(hear => hear(key))
}

export function onGatewayDeleted(hear: DeletedHearer): () => void {
  hearers.add(hear)
  const waiting = [...unheard]
  unheard.clear()
  waiting.forEach(key => hear(key))
  return () => {
    hearers.delete(hear)
  }
}
