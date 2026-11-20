import RNFS from 'react-native-fs'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId } from './walletRegistry'
import { isUnreadableFile, readDurable, removeDurable, serialQueue, setAside, writeDurable } from './durableFile'
import { isFinalAnswer, type FinalAnswer } from './lnRefusal'

// The lines of answers that gave a proof's slot up while no view could show them (releases in
// lnRefusal.ts), kept until a view takes one and shows it.
//
// The proof slot holds one record per kind, and the gateway's list of outstanding charges never
// names a released charge again, so a line kept on the proof would be lost when another charge holds
// the slot, and a line read from the proof can be shown by two views at once.
// Here each line lives on its own, as many per wallet as there are, and a view shows one only after
// taking it out in one turn of this file's queue, so exactly one view gets it.
//
// Only the reader that claimed a reference shows its line (claimLine). A take or a claim leaves the
// reference behind as shown, so the same answer heard later by another reader whose question was
// already out, the recovery sweep beside an open sheet above all, is neither kept nor said a second
// time: a note skips it and a claim answers `shown`.

export type LineKind = 'name' | 'tier'

export type ReleasedLine = {
  kind: LineKind
  reference: string
  answer: FinalAnswer
  /**
   * What the line names, as it was heard: the whole address for a name, the host for a year. Kept
   * rather than rebuilt when shown, since the session's domain may have moved since.
   */
  subject: string
}

const FILE = `${RNFS.DocumentDirectoryPath}/released-lines.json`

// Per wallet, a list in the order the lines were noted, with the references already shown. A wallet's
// list is kept as it was read, so an entry this build cannot read is written back untouched and never
// shown.
type Stored = Record<string, unknown[]>

type Shown = { reference: string; shown: true }

// Enough to cover the answers a reader still had out when a line was shown, which take seconds; the
// oldest go first.
const SHOWN_KEPT = 16

const isLists = (value: unknown): boolean =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every(list => Array.isArray(list))

function isLine(value: unknown): value is ReleasedLine {
  const line = value as ReleasedLine
  return (
    (line?.kind === 'name' || line?.kind === 'tier') &&
    typeof line.reference === 'string' &&
    line.reference !== '' &&
    isFinalAnswer(line.answer) &&
    typeof line.subject === 'string'
  )
}

function isShown(value: unknown): value is Shown {
  const entry = value as Shown
  return typeof entry?.reference === 'string' && entry.shown === true
}

// The list with `reference` recorded as shown, and only the newest SHOWN_KEPT of those kept.
function withShown(own: unknown[], reference: string): unknown[] {
  const next = own.filter(entry => !(isShown(entry) && entry.reference === reference))
  next.push({ reference, shown: true } satisfies Shown)
  const shown = next.filter(isShown)
  const dropped = new Set<unknown>(shown.slice(0, Math.max(0, shown.length - SHOWN_KEPT)))
  return next.filter(entry => !dropped.has(entry))
}

// Every read and write of the file runs whole in one turn of this queue, so a take and a note never
// interleave and two views never take the same line.
const serial = serialQueue()

// Each forget is numbered in queue order. A reader of the list reads, when its operation starts, the
// wallet it starts on and the number of forgets run by then (its scope), and every write that operation
// makes afterwards, a take, a note of the answer it heard, a claim's shown mark or a put-back, carries
// that scope and writes nothing for a wallet forgotten after it started (removed from the device or its
// data deleted at Voltz), since the forget exists so that an id taken again by the same words brings
// no line back. The comparison runs inside the write's own turn: a forget queued ahead of it has run
// and is counted, and one queued behind it drops what it wrote, so no order of the two leaves a line
// or a mark. A look at the registry before the write is queued would let a forget queued in between
// pass, and would miss a deletion, which keeps the wallet listed. A removal unlists before it forgets
// (wallet.ts, removeWallet), so a write after the unlisting meets the forget either way. The wallet is
// the scope's and never the one active at the write, so a switch while the operation is out keeps its
// lines on the wallet it started on. Kept in memory: a scope only outlives its operation within the
// process.
let forgets = 0
const forgottenAt = new Map<string, number>()

/** The wallet an operation on the list started on, and the forgets run when it started. */
export type LineScope = {
  /** Null when which wallet is active could not be read, which writes nothing. */
  readonly walletId: string | null
  readonly at: number
}

/**
 * The scope of an operation starting now on a wallet the caller already knows, read in the same
 * synchronous step that picks the wallet, as Home does for the sweep. Read any later, a forget that ran
 * between the pick and the read counts as one run before the operation started, and lets its writes in.
 */
export function scopeOn(walletId: string): LineScope {
  return { walletId, at: forgets }
}

/**
 * The scope of an operation starting now on the paying wallet, resolved as purchase.ts and
 * domainOnboard.ts resolve it, so a line is kept for the wallet whose proof it gave up. The forgets are
 * counted before the registry is read, so a forget that runs during the read keeps the operation's
 * writes out. Never rejects: a registry that cannot be read gives a scope that writes nothing.
 */
export async function activeScope(): Promise<LineScope> {
  const at = forgets
  try {
    return { walletId: (await getActiveWalletId()) ?? PRIMARY_ID, at }
  } catch {
    return { walletId: null, at }
  }
}

/**
 * Runs a write an answer leads to on a proof's slot or record (a mark, a release, a clear), or the take
 * of a name it grants, for the wallet the question started on, never the one active when the answer
 * lands, so a switch while the question is out leaves the other wallet's slot and address as they were.
 * A scope that could not read its wallet writes nothing there either. Only the wallet is read, never the forgets, since a removal keeps the
 * wallet's proofs.
 */
export async function onAskedWallet(
  scope: LineScope | Promise<LineScope>,
  write: (walletId: string) => Promise<unknown>,
): Promise<void> {
  const { walletId } = await scope
  if (walletId !== null) {
    await write(walletId)
  }
}

// The wallet a write of this scope goes to, or null when it writes nothing. Read inside the write's
// own turn of the queue.
function liveWallet(scope: LineScope): string | null {
  const { walletId, at } = scope
  return walletId !== null && (forgottenAt.get(walletId) ?? 0) <= at ? walletId : null
}

// A cut first write reads as no file (durableFile.ts, FirstWriteCut). noteLine and claimLine are
// the writes that can come first; a take, a put-back and a forget write over the file a note, a
// take or a claim left, and a forget writes only for a wallet the file holds. A note comes before
// the slot is given up, so a cut one of the charge whose proof is in the slot leaves that proof,
// whose next confirmation hears the same answer; the sweep also notes charges whose proofs are not
// in the slot, and a cut note of one of those loses its line. A cut claim leaves the reference
// unrecorded and is followed by no paint, and the proof it was claimed for is given up only after
// the paint, so the next confirmation hears the same answer and claims it again.
const FIRST_WRITE_CUT = 'nothing'

async function readAll(): Promise<Stored> {
  return ((await readDurable(FILE, isLists, FIRST_WRITE_CUT)) ?? {}) as Stored
}

async function writeAll(stored: Stored): Promise<void> {
  const kept = Object.entries(stored).filter(([, list]) => list.length > 0)
  if (kept.length === 0) {
    await removeDurable(FILE)
    return
  }
  await writeDurable(FILE, JSON.stringify(Object.fromEntries(kept)), isLists, 'refuse', FIRST_WRITE_CUT)
}

/**
 * Keeps a line heard for the question `scope` started, for the first view that takes it, unless one of
 * that kind and reference is already kept or that reference was already shown, or the scope's wallet
 * was forgotten since. Never rejects: a line that could not be kept must not keep the proof's slot, so
 * the caller clears it either way. A file that cannot be read is set aside, never written over, and the
 * list starts again from this line. A read the platform refused says nothing about the file, which
 * stays as it is, and the line is not kept.
 */
export function noteLine(line: ReleasedLine, scope: LineScope): Promise<void> {
  return serial(async () => {
    try {
      const id = liveWallet(scope)
      if (id === null) {
        return
      }
      let all: Stored
      try {
        all = await readAll()
      } catch (err) {
        if (!isUnreadableFile(err)) {
          throw err
        }
        await setAside(FILE)
        all = {}
      }
      const own = all[id] ?? []
      const known = (kept: unknown): boolean =>
        (isLine(kept) && kept.kind === line.kind && kept.reference === line.reference) ||
        (isShown(kept) && kept.reference === line.reference)
      if (own.some(known)) {
        return
      }
      await writeAll({ ...all, [id]: [...own, line] })
    } catch {
      // Not kept, and the caller gives the slot up all the same.
    }
  })
}

/**
 * The oldest line of this kind kept for the scope's wallet, taken out of the list with its reference
 * recorded as shown, or null. A file that cannot be read, a write that did not land, or a wallet
 * forgotten since the scope started takes nothing and writes nothing, so a line is shown only once it
 * is gone from the file. A line taken that is not shown goes back under the same scope (putBack).
 */
export function takeLine(kind: LineKind, scope: LineScope): Promise<ReleasedLine | null> {
  return serial(async () => {
    try {
      const id = liveWallet(scope)
      if (id === null) {
        return null
      }
      const all = await readAll()
      const own = all[id] ?? []
      const at = own.findIndex(line => isLine(line) && line.kind === kind)
      if (at < 0) {
        return null
      }
      const taken = own[at] as ReleasedLine
      await writeAll({ ...all, [id]: withShown(own.filter((_, index) => index !== at), taken.reference) })
      return taken
    } catch {
      return null
    }
  })
}

/**
 * What a claim answers: `shown` when another reader already showed the reference's line, `claimed`
 * when this reader is the one to show it, with the line kept for it if one was, and `unknown` when the
 * list could not be read or written, or the claim's wallet was forgotten since its scope started.
 */
export type Claim = { outcome: 'shown' } | { outcome: 'claimed'; line: ReleasedLine | null } | { outcome: 'unknown' }

/**
 * Claims a reference for the reader about to show its line, whole in one turn of the queue, so of the
 * readers claiming one reference exactly one is answered `claimed`. A reference already recorded as
 * shown answers `shown` and writes nothing. Otherwise the line kept for it, if any, is taken out, the
 * reference is recorded as shown, and the claim answers `claimed` once that write landed. A file that
 * cannot be read, or a write that did not land, answers `unknown` and writes nothing, and so does a
 * claim whose wallet was forgotten since its scope started, since its mark would outlive the forget.
 */
export function claimLine(reference: string, scope: LineScope): Promise<Claim> {
  return serial(async (): Promise<Claim> => {
    try {
      const id = liveWallet(scope)
      if (id === null) {
        return { outcome: 'unknown' }
      }
      const all = await readAll()
      const own = all[id] ?? []
      if (own.some(entry => isShown(entry) && entry.reference === reference)) {
        return { outcome: 'shown' }
      }
      const at = own.findIndex(entry => isLine(entry) && entry.reference === reference)
      const line = at < 0 ? null : (own[at] as ReleasedLine)
      await writeAll({ ...all, [id]: withShown(own.filter((_, index) => index !== at), reference) })
      return { outcome: 'claimed', line }
    } catch {
      return { outcome: 'unknown' }
    }
  })
}

/** A view that heard a released answer itself, as sayOnce reads it once the claim is answered. */
export type HearingView = {
  /** Whether the view is still on screen. */
  onScreen: () => boolean
  /** Puts the answer's line on screen. */
  show: () => void
  /** The line was said elsewhere, so the view goes on as a released slot, which offers a fresh quote. */
  passOver: () => void
}

/**
 * The answer a view heard itself, said by that view only once it claimed the reference. Whether the
 * view is on screen is read when the claim is answered, and the line is put on screen with no await
 * between, so a view closed meanwhile never paints it. On screen, a claim or a list that could not be
 * read shows the line, and one shown elsewhere passes over it. Closed, the line goes back to the list
 * for the next view when it was claimed, is noted when the list could not be read, and is left alone
 * when it was shown elsewhere. A view already closed when the answer lands notes it instead. Every
 * write goes under the scope the view's question started on, so a switch meanwhile keeps the line on
 * the wallet asked about and a forget meanwhile keeps it out.
 */
export async function sayOnce(line: ReleasedLine, scope: LineScope, view: HearingView): Promise<void> {
  const claim = await claimLine(line.reference, scope)
  if (view.onScreen()) {
    if (claim.outcome === 'shown') {
      view.passOver()
    } else {
      view.show()
    }
    return
  }
  if (claim.outcome === 'claimed') {
    await putBack(line, scope)
  } else if (claim.outcome === 'unknown') {
    await noteLine(line, scope)
  }
}

/**
 * Puts back a line a view took or claimed and could not show, the view having closed meanwhile, as the
 * oldest of the list, and forgets that its reference was shown. Takes the scope the take or the claim
 * ran under, so a line handed out before its wallet's lines were forgotten stays out. Never rejects; a
 * file that cannot be read keeps it out.
 */
export function putBack(line: ReleasedLine, scope: LineScope): Promise<void> {
  return serial(async () => {
    try {
      const id = liveWallet(scope)
      if (id === null) {
        return
      }
      const all = await readAll()
      const own = (all[id] ?? []).filter(entry => !(isShown(entry) && entry.reference === line.reference))
      if (own.some(kept => isLine(kept) && kept.kind === line.kind && kept.reference === line.reference)) {
        return
      }
      await writeAll({ ...all, [id]: [line, ...own] })
    } catch {
      // Not put back, and the file is left as it is.
    }
  })
}

/**
 * Drops every line and shown reference kept for one wallet, once its data at Voltz is gone or the wallet
 * is removed from the device: each line names an address or a host, and an id taken again by the same
 * words would otherwise bring them back. No operation that started before the forget writes for that
 * wallet afterwards (its scope). A file that cannot be read is left as it is, and so is every other
 * wallet's list. Rejects only when a read the platform refused or a write says so.
 */
export function forgetWalletLines(walletId: string): Promise<void> {
  return serial(async () => {
    // Counted before the file is read, so a forget that fails still keeps out every write of an
    // operation that started before it.
    forgets += 1
    forgottenAt.set(walletId, forgets)
    let all: Stored
    try {
      all = await readAll()
    } catch (err) {
      if (isUnreadableFile(err)) {
        return
      }
      throw err
    }
    if (!(walletId in all)) {
      return
    }
    delete all[walletId]
    await writeAll(all)
  })
}

/**
 * This wallet's lines in the order they were noted, read without taking any. Empty when the file
 * cannot be read. A line read here is shown only once a claim hands it back (claimLine).
 */
export function listLines(walletId?: string): Promise<ReleasedLine[]> {
  return serial(async () => {
    try {
      const own = (await readAll())[walletId ?? (await getActiveWalletId()) ?? PRIMARY_ID] ?? []
      return own.filter(isLine)
    } catch {
      return []
    }
  })
}
