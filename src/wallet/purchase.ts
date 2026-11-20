import RNFS from 'react-native-fs'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId } from './walletRegistry'
import { sparkConfirmSend, sparkPrepareSend } from './spark'
import { SpendHeldByExit } from './errors'
import {
  isUnreadableFile,
  readDurable,
  removeDurable,
  serialQueue,
  UnreadableFile,
  writeDurable,
} from './durableFile'
import { releasedProof, type FinalAnswer } from './lnRefusal'

// Every paid feature shares these mechanics, which write the proof, pay, then confirm.
export type PurchaseKind = 'name' | 'domain'

const KINDS: readonly PurchaseKind[] = ['name', 'domain']

export type PendingPurchase = {
  kind: PurchaseKind
  /** What was bought, a username or a host. Only ever shown back to the buyer. */
  subject: string
  reference: string
  amountSats: number
  /**
   * Set on a record that stands for no payment by this wallet, meaning one written before the send
   * was dispatched or one the gateway has refused this wallet's key. It occupies the slot rather
   * than being deleted, so it also stops the unkeyed record below being offered here again.
   */
  unpaid?: boolean
  /**
   * Set while the last paid refusal the gateway gave for this reference was for good, which a
   * person sorts out. A screen with no fresh answer reads it, so a restart that cannot reach the
   * gateway still sends the buyer to that person rather than promising a name that never comes.
   * Absent on a record written before the field, which reads as never refused.
   */
  refusedForGood?: true
  /**
   * Which final answer the gateway last gave, beside `refusedForGood`, when it was one that names more
   * than a person giving the sats back: the sats given back, a payment that bought nothing because
   * the wallet already held the name, or a year the charge bought before. Absent reads as `kept`
   * (keptAnswer in lnRefusal.ts), as on a record written before the field.
   */
  finalAnswer?: Exclude<FinalAnswer, 'kept'>
  /**
   * Set by releasePending beside the answer it gave the slot up on, before the clear. A clear that never
   * lands leaves a record every reader answers as no proof (releasedProof), whatever that answer was,
   * a holder's paid-again answer included, which owes the sats back and so does not read as owing
   * nothing.
   */
  released?: true
}

// One record per wallet, then per kind, the shape settings.ts and lnurlDomainPref.ts already use for
// per-wallet state. Keyed by kind alone, every wallet's proof would share one slot on a device that
// holds several: one wallet would resume another's purchase, and paying on the second would write
// over the only record of the first. A refund is the stores' on their rails and the operator's on
// sats, within the purchase's first 14 days and only when the buyer asks (docs/store-bridge.md), so
// nothing here can count on one to cover a lost proof.
const FILE = `${RNFS.DocumentDirectoryPath}/purchases.json`

// A slot is kept as it was read, since another wallet's slot in a shape this build cannot read is
// still that wallet's and is written back untouched.
type Stored = Record<string, unknown>

// The older per-kind file, which may still hold a proof from before the store was keyed by wallet.
// Read and never written, apart from the mark a paid refusal leaves on it and its removal once its
// own purchase is finished.
function legacyFile(kind: PurchaseKind): string {
  return `${RNFS.DocumentDirectoryPath}/purchase-${kind}.json`
}

// The store and both older files share one queue, and every exported reader and writer runs its
// whole body in one turn of it. The recovery sweep files a proof into the same slot the address
// sheet pays from (recover.ts, hold), so a check and the write it allows must be one turn, or both
// pass the check and the second write buries the first reference. Reads wait too, since a read whose
// calls interleave with a write's can find the file already unlinked and then its copy already moved
// (durableFile.ts). Nothing inside a turn calls an exported function of this module.
const serial = serialQueue()

/**
 * Why a proof left the slot, which the writer that took it out knows. `granted` is the clear once the
 * charge was delivered, the name put on the wallet after its grant; `gone` is every other way out: an
 * answer that owes nothing or gave the sats back, a disowned record, a charge that expired, a send that
 * never left, or the wallet's data forgotten.
 */
export type GoneReason = 'granted' | 'gone'

/** Hears a reference whose proof readers no longer answer as owed, whoever gave it up, and why. */
type GoneListener = (kind: PurchaseKind, reference: string, reason: GoneReason) => void

const goneListeners = new Set<GoneListener>()

/**
 * Tells a view when a proof it may be waiting on leaves the slot. The slot is shared with the recovery
 * sweep (recover.ts), which can confirm, give up or clear a proof while a view says that payment is
 * coming, and a view left on screen would go on saying so. Called once the turn that changed the slot
 * is over, never inside it. Answers the unsubscribe.
 */
export function onPendingGone(listener: GoneListener): () => void {
  goneListeners.add(listener)
  return () => {
    goneListeners.delete(listener)
  }
}

// Runs `work` in one turn of the queue and, once that turn is over, tells the listeners of every
// reference `work` reported as no longer owed, with the reason the writer gives. A listener runs
// outside the turn, so one that reads the slot again waits behind nothing.
function serialTelling<T>(
  reason: GoneReason,
  work: (left: (kind: PurchaseKind, reference: string) => void) => Promise<T>,
): Promise<T> {
  const left: [PurchaseKind, string][] = []
  return serial(() => work((kind, reference) => left.push([kind, reference]))).finally(() => {
    for (const [kind, reference] of left) {
      for (const listener of [...goneListeners]) {
        listener(kind, reference, reason)
      }
    }
  })
}

// The reference this wallet's readers answer as owed for a kind, null for none, and undefined when
// that cannot be read, which tells nobody anything.
async function owedReference(all: Stored, id: string, kind: PurchaseKind): Promise<string | null | undefined> {
  try {
    return (await pendingFor(all, id, kind))?.reference ?? null
  } catch {
    return undefined
  }
}

// Reports the reference owed before a write that landed when it is no longer the one owed after it.
async function reportLeft(
  left: (kind: PurchaseKind, reference: string) => void,
  kind: PurchaseKind,
  before: string | null | undefined,
  after: Stored,
  id: string,
): Promise<void> {
  if (!before) {
    return
  }
  const now = await owedReference(after, id, kind)
  if (now !== undefined && now !== before) {
    left(kind, before)
  }
}

// The wallet that pays is the one spark.ts connects, which is the registry's active id. Resolved
// here for a view, so a screen cannot key a payment to a wallet other than the one the send went
// out from. The recovery sweep names the wallet it asked the gateway for (`walletId`), since it
// sends nothing and its answers are about that wallet's charges: resolved on each call, a switch
// while its questions are out would file, mark or clear the asked wallet's charge in the slot of
// the wallet switched to. A registry that cannot be read rejects, and is never taken for the
// primary wallet.
async function currentWallet(walletId?: string): Promise<string> {
  return walletId ?? (await getActiveWalletId()) ?? PRIMARY_ID
}

function isPurchase(value: unknown): value is PendingPurchase {
  return typeof (value as PendingPurchase)?.reference === 'string'
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// A cut first write of the store reads as no store (durableFile.ts, FirstWriteCut). Each write that
// can be the first is acted on only once it resolved, or records a fact the gateway keeps and answers
// again: payAndSettle prepares and sends only after savePending answered, the sweep's hold records a
// charge the gateway lists (recover.ts, hold), and disownPending the gateway's refusal of this
// wallet's key on the older record, which the next open asks for again. recordRefusal writes only over
// a record it read, and a clear of an empty store writes nothing. The older files are never first
// written by this build, so a torn copy beside one is no cut first write and stays unreadable.
const FIRST_WRITE_CUT = 'nothing'

// Throws UnreadableFile when the file, or a finished write's copy beside it, cannot be read.
async function readAll(): Promise<Stored> {
  return ((await readDurable(FILE, isMap, FIRST_WRITE_CUT)) ?? {}) as Stored
}

async function readLegacy(kind: PurchaseKind): Promise<PendingPurchase | null> {
  return (await readDurable(legacyFile(kind), isPurchase)) as PendingPurchase | null
}

// This wallet's record of a kind as it stands, a record standing for no payment included. A slot or
// a record this build cannot read throws: what it holds is not known, so it is neither offered nor
// written over.
function ownRecord(all: Stored, id: string, kind: PurchaseKind): PendingPurchase | undefined {
  const slot = all[id]
  if (slot === undefined) {
    return undefined
  }
  if (!isMap(slot)) {
    throw new UnreadableFile(FILE)
  }
  const own = slot[kind]
  if (own === undefined) {
    return undefined
  }
  if (!isPurchase(own)) {
    throw new UnreadableFile(FILE)
  }
  return own
}

function ownSlot(all: Stored, id: string): Record<string, unknown> {
  const slot = all[id]
  return isMap(slot) ? { ...slot } : {}
}

async function pendingFor(all: Stored, id: string, kind: PurchaseKind): Promise<PendingPurchase | null> {
  const own = ownRecord(all, id, kind)
  if (own !== undefined) {
    // A record of this wallet's own answers for it either way, including when it stands for no
    // payment. Falling through to the unkeyed one then would hand back the very record this wallet
    // has already been told is not its own. A record whose last answer owes nothing stands for no
    // payment owed either, so it holds nothing back and the next purchase writes over it.
    return own.unpaid || releasedProof(own) ? null : own
  }
  // A wallet holding no proof of its own is offered the unkeyed one, which no longer says whose it
  // is. Confirming needs the paying wallet's key, so the wrong wallet is answered with a mismatch
  // and the record survives on disk for the right one; attributing it to a wallet instead would bury
  // a real payment under one that can never finish it, and ignoring it would strand the payment.
  const unkeyed = await readLegacy(kind)
  return unkeyed !== null && releasedProof(unkeyed) ? null : unkeyed
}

// A store with nothing left in it is removed, so "no proof" and "no file" stay the same statement.
// Only a slot that is an empty map holds nothing; any other slot is written back as it was read.
async function writeAll(stored: Stored): Promise<void> {
  const kept = Object.entries(stored).filter(([, slot]) => !isMap(slot) || Object.keys(slot).length > 0)
  if (kept.length === 0) {
    await removeDurable(FILE)
    return
  }
  await writeDurable(FILE, JSON.stringify(Object.fromEntries(kept)), isMap, 'refuse', FIRST_WRITE_CUT)
}

// Drops every proof kept for one wallet, once the gateway said the wallet's data is gone and no
// confirmation for it can succeed. The older per-kind files are left, since nothing in them says
// whose they are. A store that cannot be read is left as it is, for support, and the wallet's records
// stay inside it.
export function forgetWalletPurchases(walletId: string): Promise<void> {
  return serialTelling('gone', async left => {
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
    const before: (string | null | undefined)[] = []
    for (const kind of KINDS) {
      before.push(await owedReference(all, walletId, kind))
    }
    const next = { ...all }
    delete next[walletId]
    await writeAll(next)
    for (const [index, kind] of KINDS.entries()) {
      await reportLeft(left, kind, before[index], next, walletId)
    }
  })
}

/**
 * The payment this wallet has on record for a kind, or null when it has none. Throws
 * `UnreadableFile` when the store, this wallet's slot or record in it, or, for a wallet with no
 * record of its own, the older file cannot be read: whether a payment is owed is then not known, and
 * answering none would put a price beside it.
 */
export function loadPending(kind: PurchaseKind, walletId?: string): Promise<PendingPurchase | null> {
  return serial(async () => pendingFor(await readAll(), await currentWallet(walletId), kind))
}

/**
 * Every reference a proof on this device holds, of any wallet and any kind, leaving out records that
 * stand for no payment, and whether any of the three files, a slot or a record could not be read.
 * What did read is carried either way, so a torn file never hides a good proof beside it.
 */
export function allPendingReferences(): Promise<{ references: string[]; unread: boolean }> {
  return serial(async () => {
    const references: string[] = []
    let unread = false
    const carry = (record: unknown): void => {
      if (!isPurchase(record)) {
        unread = true
      } else if (!record.unpaid) {
        references.push(record.reference)
      }
    }
    try {
      for (const slot of Object.values(await readAll())) {
        if (isMap(slot)) {
          Object.values(slot).forEach(carry)
        } else {
          unread = true
        }
      }
    } catch {
      unread = true
    }
    for (const kind of KINDS) {
      try {
        const older = await readLegacy(kind)
        if (older !== null) {
          carry(older)
        }
      } catch {
        unread = true
      }
    }
    return { references, unread }
  })
}

// Answers with the proof that ends up on disk, which is not always the one passed in. The record
// holds the buyer's only reference, so writing a second payment over a first that is still owed
// leaves money nobody can point at from then on. The caller is handed the purchase that won so it can
// finish that one instead of paying again. The same reference is written through, since retrying one
// invoice is not a second payment.
//
// A refusal for good kept on that record stays through the write, with the final answer it names,
// since writing the reference again says nothing about the payment and only the gateway's answer
// takes the refusal back.
//
// Throws, writing nothing, when what is on record cannot be read, so no payment is sent against it.
export function savePending(purchase: PendingPurchase, walletId?: string): Promise<PendingPurchase> {
  return serial(async () => {
    const id = await currentWallet(walletId)
    const all = await readAll()
    const held = await pendingFor(all, id, purchase.kind)
    if (held && held.reference !== purchase.reference) {
      return held
    }
    const written: PendingPurchase = held?.refusedForGood
      ? withRefusal(purchase, true, held.finalAnswer)
      : purchase
    await writeAll({ ...all, [id]: { ...ownSlot(all, id), [purchase.kind]: written } })
    return written
  })
}

function withRefusal(proof: PendingPurchase, forGood: boolean, answer?: FinalAnswer, released = false): PendingPurchase {
  const marked = { ...proof }
  delete marked.finalAnswer
  // A slot given up stays given up, whatever is marked on its record after.
  if (released) {
    marked.released = true
  }
  if (forGood) {
    marked.refusedForGood = true
    if (answer !== undefined && answer !== 'kept') {
      marked.finalAnswer = answer
    }
  } else {
    delete marked.refusedForGood
  }
  return marked
}

// Keeps the gateway's word on a paid charge with the proof it is about. `forGood` is a final answer,
// a refusal with `final: true` or no `final` and every answer `answer` names, and false is
// `final: false` or a grant, so the latest answer is what a screen reads after a restart. `answer`
// names a final answer other than a person giving the sats back. Only the record this wallet reads
// under that reference is marked, and nothing else on it changes, since it is the buyer's only
// pointer at money that already left.
export function recordRefusal(
  kind: PurchaseKind,
  reference: string,
  forGood: boolean,
  answer?: FinalAnswer,
  walletId?: string,
): Promise<void> {
  return markAnswer(kind, reference, forGood, answer, false, walletId)
}

function markAnswer(
  kind: PurchaseKind,
  reference: string,
  forGood: boolean,
  answer: FinalAnswer | undefined,
  released: boolean,
  walletId: string | undefined,
): Promise<void> {
  // A mark never delivers anything: one that leaves no proof owed names an answer that owes nothing or
  // gave the slot up.
  return serialTelling('gone', async left => {
    try {
      const id = await currentWallet(walletId)
      const all = await readAll()
      const before = await owedReference(all, id, kind)
      const own = ownRecord(all, id, kind)
      if (own !== undefined) {
        if (own.reference === reference) {
          const next = { ...all, [id]: { ...ownSlot(all, id), [kind]: withRefusal(own, forGood, answer, released) } }
          await writeAll(next)
          // A mark that gives the slot up, or names an answer that owes nothing, leaves no proof owed.
          await reportLeft(left, kind, before, next, id)
        }
        return
      }
      // The unkeyed record is what loadPending offers a wallet with none of its own, so the mark goes
      // where that read finds it.
      const unkeyed = await readLegacy(kind)
      if (unkeyed?.reference === reference) {
        await writeDurable(legacyFile(kind), JSON.stringify(withRefusal(unkeyed, forGood, answer, released)), isPurchase)
        await reportLeft(left, kind, before, all, id)
      }
    } catch {
      // A mark that could not be written, or a record that could not be read, leaves the screen on
      // what it already shows and the file as it was, and the next answer writes it again.
    }
  })
}

// Gives the slot up on an answer that releases it (releases in lnRefusal.ts), so no reader asks the
// gateway about that charge again and the next opening offers a fresh quote. The caller has already
// shown the answer's line or kept it in releasedLines.ts, since nothing here keeps it. The mark goes
// first, naming the record released: a clear that fails after it leaves a record every reader answers
// as no proof (releasedProof), a holder's paid-again answer as much as one that owes nothing, and both
// name the reference, so a slot another purchase took meanwhile stays.
export async function releasePending(
  kind: PurchaseKind,
  reference: string,
  answer: FinalAnswer,
  walletId?: string,
): Promise<void> {
  await markAnswer(kind, reference, true, answer, true, walletId)
  await clearPending(kind, reference, walletId)
}

/**
 * The idempotency key for a send that pays a charge, derived from the charge's own reference.
 *
 * The SDK requires a valid UUID ("If an idempotency key is re-used, the same payment will be
 * returned", breez_sdk_spark.d.ts), and a charge reference is a payment hash: 64 hex characters,
 * not a UUID. So the hash is reshaped rather than invented, which keeps the property that matters,
 * that one charge always produces one key, on this device and on any other.
 *
 * Version and variant nibbles are stamped so the result is a well formed v4. Anything that is not a
 * long enough hex string yields undefined, which sends without a key, so the worst case here is a
 * send with no idempotency rather than one the SDK refuses.
 */
export function idempotencyKeyFor(reference: string): string | undefined {
  const hex = reference.trim().toLowerCase()
  if (!/^[0-9a-f]{32,}$/.test(hex)) {
    return undefined
  }
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-')
}

// The reference names what is being given up, on both records, and is required: a clear of whatever
// the slot holds would drop a proof that is not this flow's own, since the recovery sweep files one
// into it for any charge the gateway says this wallet is owed (recover.ts, hold), and a purchase that
// never dispatched would delete the only thing on the device pointing at money that already left.
// The unkeyed record stays for the same reason, being the only proof of a payment whose wallet cannot
// be told from disk. A name taken for free names no charge and goes through clearUnpaid.
//
// The slot is read as it stands rather than through loadPending, since a record standing for no
// payment is still this purchase's own to drop and the reader answers null for it.
export function clearPending(kind: PurchaseKind, reference: string, walletId?: string): Promise<void> {
  return clearSlot(kind, reference, 'gone', walletId)
}

// The clear once the charge was delivered, the name put on the wallet after its grant. A view waiting
// on that reference hears it as delivered rather than given up, so it shows what was bought and never
// offers a price for it again. Named by its reference, since a clear of whatever the slot holds says
// nothing about which charge was delivered.
export function clearGranted(kind: PurchaseKind, reference: string, walletId?: string): Promise<void> {
  return clearSlot(kind, reference, 'granted', walletId)
}

function clearSlot(kind: PurchaseKind, reference: string, reason: GoneReason, walletId: string | undefined): Promise<void> {
  return serialTelling(reason, async left => {
    try {
      const id = await currentWallet(walletId)
      const all = await readAll()
      const held = ownRecord(all, id, kind)
      if (held !== undefined && held.reference !== reference) {
        return
      }
      const before = await owedReference(all, id, kind)
      const mine = ownSlot(all, id)
      delete mine[kind]
      const next = { ...all, [id]: mine }
      await writeAll(next)
      if (reference && (await readLegacy(kind))?.reference === reference) {
        await removeDurable(legacyFile(kind))
      }
      await reportLeft(left, kind, before, next, id)
    } catch {
      // A stale file costs one extra confirmation, which is idempotent. A file that cannot be read is
      // left as it is, since it may be the only proof of a payment.
    }
  })
}

// The clear of a name taken for free, which names no charge. The slot is shared with the recovery
// sweep, which files a paid proof there whenever the gateway lists a charge (recover.ts, hold), so
// only a record of this wallet's own standing for no payment goes, a send that never left. A paid
// proof stays, released or not, for the reader that names its reference, and so does the mark that
// disowns the unkeyed record, which would otherwise be offered to this wallet again. The wallet is the
// one the name went on, named by the caller, never the one active when the clear runs.
export function clearUnpaid(kind: PurchaseKind, walletId: string): Promise<void> {
  return serial(async () => {
    try {
      const id = walletId
      const all = await readAll()
      const own = ownRecord(all, id, kind)
      if (own?.unpaid !== true || (await readLegacy(kind))?.reference === own.reference) {
        return
      }
      const mine = ownSlot(all, id)
      delete mine[kind]
      await writeAll({ ...all, [id]: mine })
    } catch {
      // A file that cannot be read is left as it is, since it may be the only proof of a payment.
    }
  })
}

// Records that this wallet is not the buyer of the unkeyed purchase it was offered, answering
// whether it was released. The unkeyed record is shown to every wallet because nothing on disk says
// whose it is, so a wallet the gateway refuses would be handed it again on every open, unable to buy
// a name of its own and unable to give back a payment it never made.
//
// A wallet's own record is never disowned. The same refusal comes back for a reference whose domain
// has moved on since it was paid, and there it says nothing about who paid; that record is the only
// proof of that wallet's own payment.
//
// The wallet is the one whose key the gateway refused, named by the caller whose question it answers;
// unnamed, the active one.
export function disownPending(kind: PurchaseKind, reference: string, walletId?: string): Promise<boolean> {
  return serialTelling('gone', async left => {
    const id = await currentWallet(walletId)
    const all = await readAll()
    if (ownRecord(all, id, kind) !== undefined) {
      return false
    }
    const unkeyed = await readLegacy(kind)
    if (unkeyed?.reference !== reference) {
      return false
    }
    const before = await owedReference(all, id, kind)
    // The record itself is left where it is, since the wallet that paid still has to find it.
    const next = { ...all, [id]: { ...ownSlot(all, id), [kind]: { ...unkeyed, unpaid: true } } }
    await writeAll(next)
    await reportLeft(left, kind, before, next, id)
    return true
  })
}

export type PayOutcome =
  /** Paid and granted. */
  | 'done'
  /** Paid, but the gateway has not seen it yet. Retryable without paying again. */
  | 'settling'
  /** The send did not go through. Nothing was charged. */
  | 'failed'

// `owed` means nothing was sent, because a payment already made on this wallet is still unfinished.
// It carries that purchase, since the caller has to put the buyer back on it rather than on a price.
// A union rather than an optional field, so the refusal cannot be read without reading what is owed.
export type PayResult = { outcome: PayOutcome } | { outcome: 'owed'; owed: PendingPurchase }

// Pays an invoice and turns it into the thing that was bought. The order is the contract: the proof
// is written before the money moves, the send's own status decides whether anything was charged, and
// a confirmation answering false means still settling, never nothing.
//
// Returns a result rather than a bare outcome so a refusal cannot be read as a failure to send. A
// caller that ignores the refusal pays for a second name while the first is still owed.
//
// The caller names the wallet its press started on (`walletId`), and every write here goes to that
// wallet's slot, so a switch while the send is out never promotes the proof in another wallet's slot
// or leaves this one's behind after a send that failed.
export async function payAndSettle(
  purchase: PendingPurchase,
  invoice: string,
  confirm: () => Promise<boolean>,
  walletId?: string,
): Promise<PayResult> {
  // Written in two steps because the record has to survive a crash during the send and must not
  // survive one before it. A send that never left, for want of balance or because the app was killed
  // while the invoice was being prepared, would otherwise leave a proof of a payment that did not
  // happen: kept, it answers every later purchase with a refusal and a wait that never ends, while
  // telling the buyer their money is on its way.
  const held = await savePending({ ...purchase, unpaid: true }, walletId)
  if (held.reference !== purchase.reference) {
    return { outcome: 'owed', owed: held }
  }
  let prepared
  try {
    prepared = await sparkPrepareSend(invoice)
  } catch (err) {
    await clearPending(purchase.kind, purchase.reference, walletId)
    throw err
  }
  // Preparing moves nothing, so everything up to here is knowably unpaid. From the dispatch on it is
  // not, and the record counts: a throw then says nothing about whether the money went.
  //
  // The refusal is read here as well as above, because this is still before the send. A write that
  // lost the slot to another purchase in the meantime means somebody's payment is owed, and sending
  // anyway takes a second amount against a record that is no longer this one's.
  const promoted = await savePending(purchase, walletId)
  if (promoted.reference !== purchase.reference) {
    return { outcome: 'owed', owed: promoted }
  }
  let sent
  try {
    sent = await sparkConfirmSend(prepared.handle, undefined, idempotencyKeyFor(purchase.reference))
  } catch (err) {
    // An exit's hold refuses before the SDK is called, so this one throw is knowably unpaid.
    if (err instanceof SpendHeldByExit) {
      await clearPending(purchase.kind, purchase.reference, walletId)
    }
    throw err
  }
  if (sent === 'failed') {
    await clearPending(purchase.kind, purchase.reference, walletId)
    return { outcome: 'failed' }
  }
  return { outcome: await settlePending(purchase.kind, confirm) }
}

// Asks the gateway to turn a settled payment into the purchase. Separate from paying so a payment
// already made can be retried on its own, which is what a crash between the two leaves behind.
//
// It does not clear the proof. Buying and receiving are two steps, and the caller still has to take
// what it bought; dropping the record in between leaves an entitlement that is paid for and that
// nothing in the app can reach afterwards, with the only way forward offering to charge again. The
// caller clears it once the thing exists.
export async function settlePending(
  kind: PurchaseKind,
  confirm: () => Promise<boolean>,
): Promise<PayOutcome> {
  return (await confirm()) ? 'done' : 'settling'
}
