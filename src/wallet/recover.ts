import RNFS from 'react-native-fs'
import { getBreezLnurlDomain, getDistribution } from '../config'
import { confirmName } from './namePurchase'
import {
  allPendingPurchaseReferences,
  clearGrantedPurchase,
  clearPendingPurchase,
  confirmDomain,
  loadPendingPurchase,
  recordPurchaseRefusal,
  releasePendingPurchase,
  savePendingPurchase,
} from './domainOnboard'
import {
  allPendingReferences,
  clearGranted,
  clearPending,
  loadPending,
  recordRefusal,
  releasePending,
  savePending,
} from './purchase'
import { ReceiveHeldByExit } from './errors'
import { forgetDomainAsk } from './domainTier'
import { spendable } from './nameCredit'
import {
  BOUGHT_BEFORE,
  holdsTheName,
  keptAnswer,
  PAID_AGAIN,
  paidRefusal,
  releases,
  type FinalAnswer,
  type PaidAnswer,
} from './lnRefusal'
import { claimLine, listLines, noteLine, putBack, type LineScope, type ReleasedLine } from './releasedLines'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId } from './walletRegistry'
import { SparkReconnectBusy, sparkRefreshTakenBackAddress, sparkTakeLnAddress } from './spark'
import { StoreError, openPurchases, storeAvailable, type StorePurchase } from './store'
import { storeBookEvidence, storeCredits, type StoreCredit } from './storePurchase'

// What this wallet paid for and never received, asked of the gateway instead of of this device.
//
// The device already keeps its own proof: purchase.ts writes it before the money moves and the
// address sheet resumes from it. That proof cannot survive the event this file exists for. A
// reinstall, a restore onto another handset, or a record already retired leaves a customer who paid
// with a device that knows nothing, and the service holds no send path of any kind (its treasury
// only mints invoices and learns when they settle), so there is no refund to fall back on. Granting what was paid for is the only recovery there is.

export type ChargeKind = 'name' | 'tier'

/** One row of the gateway's POST /api/charges/pending reply. */
export type PendingCharge = {
  reference: string
  kind: ChargeKind
  domain: string
  subject: string
  amountSats: number
}

export type RecoveryStatus =
  /** Paid, granted, and put on the wallet. Nothing is owed. */
  | 'ready'
  /** Paid, and the gateway has not seen the payment settle yet. Finishes on its own. */
  | 'settling'
  /** Paid and settled, and the gateway granted nothing. Only a person can move this. */
  | 'stuck'
  /** Paid and granted, and the name could not be put on the wallet. */
  | 'blocked'
  /**
   * Paid and granted, and left off the wallet on purpose: an address is already in use, or the session
   * moved to another wallet before the name could go on this one. The proof stays for the address
   * screen.
   */
  | 'waiting'
  /** A name bought through the store and not chosen yet. `subject` is the domain it is for. */
  | 'credit'
  /** Paid, never turned into anything, and the gateway says its sats were given back. */
  | 'repaid'
  /** Paid for a name the wallet already had, so it bought nothing. A person gives its sats back. */
  | 'paidAgain'
  /** The same, and the gateway says its sats were given back. */
  | 'paidAgainRepaid'
  /** A name or year the charge bought before, which the wallet no longer holds. Nothing is owed. */
  | 'boughtBefore'

export type Recovery = {
  status: RecoveryStatus
  kind: ChargeKind
  /** What the buyer would call it, the whole address or the hostname and never a reference. */
  subject: string
  /** Carried so support can find the payment without it being read out loud. */
  reference: string
  pubkey: string
}

export type RecoverDeps = {
  walletId: string
  // The scope of the wallet above (scopeOn), read in the same synchronous step that picked it, so a
  // removal or a deletion of that wallet while the caller awaits anything before the sweep keeps every
  // line, mark and claim of the sweep out (releasedLines.ts, LineScope).
  lines: LineScope
  pubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
  // Injected so tests do not wait out the retries of the credits read.
  sleep?: (ms: number) => Promise<void>
  // The card on screen, which a sweep that asks the gateway nothing keeps over any kept line it
  // outranks, so a line never takes the place of a card asking for a person until a sweep has news.
  showing?: Recovery | null
  // Whether a card put up now would be seen, the app in the foreground. A kept line is claimed only
  // then, since a card painted while the app is away is seen by nobody and dies with the process.
  onScreen?: () => boolean
}

// Byte-identical to the gateway's pending charges message, which it rebuilds to verify the
// signature. Written out here rather than assembled from parts, because a copy that agrees with any
// field order agrees with the wrong one too. It carries its own action word, because a signature
// made to list what a key is owed must not stand in for one that grants a domain or hands it over.
const VERSION = 'voltz-domain:v1'

export function pendingChargesMessage(pubkey: string, timestamp: number): string {
  return [VERSION, 'pending-charges', pubkey, String(timestamp)].join('\n')
}

function isCharge(value: unknown): value is PendingCharge {
  const row = value as PendingCharge
  return (
    typeof row?.reference === 'string' &&
    (row.kind === 'name' || row.kind === 'tier') &&
    typeof row.domain === 'string' &&
    row.domain !== '' &&
    typeof row.subject === 'string' &&
    row.subject !== '' &&
    typeof row.amountSats === 'number'
  )
}

/**
 * The rows this build could read, whether they were all of them, and the references the gateway says
 * can never receive money again: an invoice past its expiry that the treasury never saw paid.
 *
 * `expired` exists because a local record of a purchase the wallet never actually paid for has no
 * other way out. The gateway lists only charges where money arrived, so one where none did is
 * invisible to the sweep, and the record blocks every later purchase while the screen says the money
 * is on its way. A send that never went out can leave exactly such a record behind.
 *
 * Absent on a gateway older than the field, and absent is not empty: an older list says nothing
 * about what is dead, so nothing is dropped.
 */
export type PendingReply = { charges: PendingCharge[]; whole: boolean; expired: string[] }

// Throws on anything that is not a whole list, which includes the gateway's 503. That refusal is the
// load-bearing half of the contract: a treasury that cannot answer is an error and never an empty
// list, because the two are the same pixels to the app and opposite facts to the customer. Caught by
// the caller, which leaves the question open rather than recording that it was answered.
export async function fetchPendingCharges(deps: RecoverDeps, build: string): Promise<PendingReply> {
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(pendingChargesMessage(deps.pubkey, timestamp))
  // Addressed at the domain the build ships with, never at the wallet's own. The question is about
  // the key and names no host, and a customer's hostname can be off the edge, where a request
  // addressed there reaches nobody.
  const response = await (deps.request ?? fetch)(`https://${build}/api/charges/pending`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pubkey: deps.pubkey, signature, timestamp }),
  })
  if (!response.ok) {
    throw new Error(`status ${response.status}`)
  }
  const body = (await response.json()) as { charges?: unknown; expired?: unknown }
  if (!Array.isArray(body.charges)) {
    throw new Error('charges missing')
  }
  // Only strings cross, and a malformed list is read as no list rather than as nothing owed. The
  // cost of getting this wrong is dropping a record that stands for real money.
  const expired = Array.isArray(body.expired)
    ? body.expired.filter((ref): ref is string => typeof ref === 'string' && ref !== '')
    : []
  // A row this build cannot read is dropped rather than refusing the lot, and the shortfall is
  // reported so the ask is never recorded as answered. Refusing the lot buries every recoverable
  // charge beside the unreadable one, and since the gateway keeps returning it, that silence is
  // permanent: a wallet owed a paid name would never be told, which is the failure this file
  // exists to prevent. Dropping it cannot invent anything, because each survivor is still confirmed.
  const charges = body.charges.filter(isCharge)
  return { charges, whole: charges.length === body.charges.length, expired }
}

// Refusals the gateway names on a charge whose money it has already taken. Anything else, a dead
// network above all, is not a refusal at all and reads as still landing: a transport error dressed
// up as a lost payment sends somebody to support for something that finishes by itself.
const NEEDS_A_PERSON = new Set([
  'paid_but_not_granted',
  'reference does not belong to this purchase',
  PAID_AGAIN,
  BOUGHT_BEFORE,
])

// The card a final answer about a charge puts up. `kept` is the stuck card, where a person gives the
// sats back, and only the gateway's `repaid: true` for this charge says they came back.
const FINAL_STATUS: Record<FinalAnswer, RecoveryStatus> = {
  kept: 'stuck',
  repaid: 'repaid',
  paidAgain: 'paidAgain',
  paidAgainRepaid: 'paidAgainRepaid',
  boughtBefore: 'boughtBefore',
}

function statusOf(answer: PaidAnswer | undefined): RecoveryStatus {
  return answer === undefined || answer === 'coming' ? 'settling' : FINAL_STATUS[answer]
}

// When this wallet last asked, and whether the answer left anything owed.
//
// Almost every wallet is owed nothing and will be told exactly that forever, and this runs on the
// focus of the first screen of the app, so asking every time would be a request per screen open for
// every install. There is no local signal that picks out the wallet that needs this, because the local
// signal is the thing the reinstall destroyed, which is the same reason domainTier.ts cannot filter
// on a stored domain either.
const ASKED = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`

type Ask = { at: number; open: boolean }

// A day, matching the window domainTier.ts settled on for the same tension, and short enough to find
// a wallet restored onto a second handset that was told days ago that it was owed nothing.
const SETTLED_SECS = 86_400

// A question the last answer left open is asked again far sooner, because what holds it open is a
// payment in flight or a gateway that could not answer, and both change in minutes. It is a floor
// rather than a timer: the retry rides the next screen focus, so nothing polls and the confirm's
// shared per-address budget is not spent by an app sitting open.
const OPEN_SECS = 300

async function readAsked(): Promise<Record<string, Ask>> {
  try {
    if (!(await RNFS.exists(ASKED))) {
      return {}
    }
    const parsed: unknown = JSON.parse(await RNFS.readFile(ASKED, 'utf8'))
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, Ask>) : {}
  } catch {
    return {}
  }
}

async function rememberAsk(walletId: string, at: number, open: boolean): Promise<void> {
  const asked = await readAsked()
  await RNFS.writeFile(ASKED, JSON.stringify({ ...asked, [walletId]: { at, open } }), 'utf8')
}

// Drops when this wallet last asked, once the gateway said the wallet's data is gone.
export async function forgetPurchaseAsk(walletId: string): Promise<void> {
  const asked = await readAsked()
  if (!(walletId in asked)) {
    return
  }
  delete asked[walletId]
  await RNFS.writeFile(ASKED, JSON.stringify(asked), 'utf8')
}

function dueAgain(last: Ask | undefined, nowSecs: number): boolean {
  if (typeof last?.at !== 'number') {
    return true
  }
  // A device clock moved in either direction asks again rather than falling silent. An extra request
  // costs one round trip; a missing one costs somebody what they paid for.
  if (nowSecs < last.at) {
    return true
  }
  return nowSecs - last.at >= (last.open ? OPEN_SECS : SETTLED_SECS)
}

// The address on the charge, never the one the wallet is connected to. The gateway compares the
// charge's domain against the Host the confirmation arrived on, so a name bought on one domain and
// confirmed on another is refused as somebody else's purchase.
function nameDeps(deps: RecoverDeps, charge: PendingCharge) {
  return {
    gatewayUrl: `https://${charge.domain}`,
    domain: charge.domain,
    pubkey: deps.pubkey,
    sign: deps.sign,
    now: deps.now,
    request: deps.request,
  }
}

// A year on a domain is confirmed at the build's domain with the host in the body, because the
// gateway's tier confirmation reads the host from the payload and never from the Host header, and
// the customer's own hostname is exactly the one a freeze takes off the edge.
function tierDeps(deps: RecoverDeps, build: string) {
  return {
    gatewayUrl: `https://${build}`,
    ownerPubkey: deps.pubkey,
    sign: deps.sign,
    now: deps.now,
    request: deps.request,
  }
}

/** What the buyer would call the thing they bought. A reference is not it. */
function shownAs(charge: PendingCharge): string {
  return charge.kind === 'name' ? `${charge.subject}@${charge.domain}` : charge.subject
}

export type Take =
  /** The wallet already answers on this exact name, so the purchase finished and only its record was lost. */
  | 'held'
  /** Registered just now. */
  | 'taken'
  /** The wallet answers on some other address, which is the buyer's to change and not this sweep's. */
  | 'busy'
  /** The register was refused. */
  | 'failed'
  /** The session is on another wallet than the one that paid, so nothing was read or registered. */
  | 'elsewhere'

// Puts the paid name on the wallet, and refuses to do it over an address already in use. The address
// sheet takes a holder's paid-again answer by this same rule.
//
// The LNURL server keys registrations on (domain, pubkey), so a wallet restored from its seed comes
// back answering on whatever address it held, and an older paid charge that was never confirmed is
// exactly what this file goes looking for. Registering then would swap the address the customer is
// currently reachable at, unattended and with no tap, for a name they bought before it. It also
// spends one of the address changes the gateway allows per rate limit window. Which address a
// wallet answers on is the buyer's call, so the entitlement is granted, the proof is kept, and the
// name waits on the address screen for free.
//
// The sweep names the wallet it asked about (`walletId`). A switch while its questions are out moves
// the session to another wallet, whose key would register the name: a name the gateway gives that
// wallet for free would land on it, and the clear after it would drop the paying wallet's proof. The
// take then registers nothing (spark.ts, sparkTakeLnAddress), and the proof stays.
export async function takeName(username: string, walletId?: string): Promise<Take> {
  let took
  try {
    took = await sparkTakeLnAddress(username, walletId)
  } catch (err) {
    // A wallet whose exit holds its receives registers no name until the exit ends, and the proof
    // waits for that as it waits for an address that could not be read.
    if (err instanceof ReceiveHeldByExit) {
      return 'busy'
    }
    // Deliberately not read against the server's wording, which is no contract. A name somebody else
    // registered in the meantime and a register that failed for any other reason both leave the same
    // fact in front of the buyer, and the proof below stays on disk either way so the address screen
    // keeps retrying without anybody being charged again.
    return 'failed'
  }
  if ('elsewhere' in took) {
    return 'elsewhere'
  }
  if ('unread' in took) {
    // An address that could not be read is not an address that is absent, and registering on that
    // guess is the swap this refuses to make.
    return 'busy'
  }
  if ('held' in took) {
    return took.held.username.toLowerCase() === username.toLowerCase() ? 'held' : 'busy'
  }
  return 'taken'
}

// Turns one paid charge into the thing that was bought. `take` is false for every name after the
// first: confirming is what puts the money beyond risk and costs the buyer nothing, while registering
// changes the address the wallet answers on, and doing that twice in one open would leave the second
// name showing and the first looking lost. The one not taken is reported as waiting rather than
// ready, since it is an entitlement the buyer picks up from the address screen for free and calling
// it ready would name an address the wallet does not answer on.
async function finish(
  deps: RecoverDeps,
  build: string,
  charge: PendingCharge,
  take: boolean,
): Promise<Recovery> {
  const base = { kind: charge.kind, subject: shownAs(charge), reference: charge.reference, pubkey: deps.pubkey }
  // Written before the gateway is asked, so an app killed mid-confirmation still leaves the address
  // sheet and the domain screen a proof to resume from. It refuses to displace a different reference
  // already in the slot, and `ours` is how that refusal is read: a slot this charge never held must
  // never be cleared on its behalf.
  const ours = await hold(charge, deps.walletId)
  if (charge.kind === 'tier') {
    const granted = await confirmDomain(tierDeps(deps, build), charge.subject, charge.reference)
    if (!granted) {
      return { ...base, status: 'settling' }
    }
    if (ours) {
      // Named for the same reason the name path names it, since the slot is shared, and a clear
      // that drops whatever is there rather than what this charge put there discards proof of a
      // payment that actually left. Cleared as delivered, with the year granted, so a domain screen
      // waiting on it shows that year rather than a fresh price.
      await clearGrantedPurchase(charge.reference, granted, deps.walletId)
    }
    // The adoption itself belongs to domainTier.ts, which already refuses to point a wallet at a
    // frozen host. Dropping the throttle makes the next read do it instead of duplicating that
    // judgement here, where getting it wrong leaves a wallet with no address at all.
    await forgetDomainAsk(deps.walletId)
    return { ...base, status: 'ready' }
  }
  const entitled = await confirmName(nameDeps(deps, charge), charge.subject, charge.reference)
  if (!entitled) {
    return { ...base, status: 'settling' }
  }
  // The grant takes back a refusal for good the proof kept, since the name may yet wait on the
  // address screen, where that refusal would send the buyer to a person for a name that is theirs.
  await recordRefusal('name', charge.reference, false, undefined, deps.walletId)
  if (!take) {
    return { ...base, status: 'waiting' }
  }
  const took = await takeName(charge.subject, deps.walletId)
  if (took === 'busy' || took === 'elsewhere') {
    return { ...base, status: 'waiting' }
  }
  if (took === 'failed') {
    return { ...base, status: 'blocked' }
  }
  if (ours) {
    // Cleared only once the name exists. Until then the record is the only way back to a payment
    // that was made. Cleared as delivered, so an address sheet waiting on it shows the address.
    await clearGranted('name', charge.reference, deps.walletId)
  }
  return { ...base, status: 'ready' }
}

// The gateway's paid answer about a charge is kept with its proof, where the address sheet, the
// domain screen and the next sweep read it when they cannot reach the gateway themselves. An answer
// that releases the slot goes through `release` instead. Every read and write of a slot here names
// the wallet the sweep asked for, never the one active when it lands, so a switch while the
// questions are out leaves the wallet switched to as it was.
async function keepRefusal(charge: PendingCharge, answer: PaidAnswer, walletId: string): Promise<void> {
  const forGood = answer !== 'coming'
  const named = forGood ? answer : undefined
  if (charge.kind === 'tier') {
    await recordPurchaseRefusal(charge.reference, forGood, named, walletId)
  } else {
    await recordRefusal('name', charge.reference, forGood, named, walletId)
  }
}

// The final answer the proof of this charge keeps from an earlier answer, or undefined. A proof that
// could not be read answers `kept`: nothing verified says the charge is landing or that its sats came
// back, so a person sorts it out rather than the card promising either.
async function answeredBefore(charge: PendingCharge, walletId: string): Promise<FinalAnswer | undefined> {
  const read = charge.kind === 'tier' ? loadPendingPurchase(walletId) : loadPending('name', walletId)
  const proof = await read.catch(() => 'unread' as const)
  if (proof === 'unread') {
    return 'kept'
  }
  return proof?.reference === charge.reference ? keptAnswer(proof) : undefined
}

// Answers whether this charge holds the device's proof slot for its kind.
async function hold(charge: PendingCharge, walletId: string): Promise<boolean> {
  try {
    if (charge.kind === 'tier') {
      const held = await savePendingPurchase(
        { host: charge.subject, reference: charge.reference, amountSats: charge.amountSats },
        walletId,
      )
      return held.reference === charge.reference
    }
    const held = await savePending(
      {
        kind: 'name',
        subject: charge.subject,
        reference: charge.reference,
        amountSats: charge.amountSats,
      },
      walletId,
    )
    return held.reference === charge.reference
  } catch {
    // The proof is a backstop, not the recovery. The confirmation below is what grants the purchase,
    // and it needs only the reference the gateway just handed back.
    return false
  }
}

// Gives the slot up for an answer that releases it, once its line is kept or shown. Only a slot
// holding this reference changes. The gateway's list of outstanding charges never names such a charge
// again, settled or given back, so no later sweep files it back or asks about it.
function release(kind: ChargeKind, reference: string, answer: FinalAnswer, walletId: string): Promise<void> {
  return kind === 'tier'
    ? releasePendingPurchase(reference, answer, walletId)
    : releasePending('name', reference, answer, walletId)
}

// A kept line as the card that says it.
function lineCard(line: ReleasedLine, pubkey: string): Recovery {
  return { status: FINAL_STATUS[line.answer], kind: line.kind, subject: line.subject, reference: line.reference, pubkey }
}

// The line behind each card showCard handed out of the list, with the scope of the sweep that claimed
// it. Keyed by the card object, so the card itself stays the plain Recovery every screen reads.
const claimedCards = new WeakMap<Recovery, { line: ReleasedLine; scope: LineScope }>()

/**
 * Puts the line behind a card back in the list of the wallet the sweep asked about, when the home
 * screen drops the card before painting it: a switch, a newer card, a dismiss or the screen going.
 * The line left the list when it was claimed, so a card never painted would otherwise be said by
 * nobody. Anything else is left alone, and so is a card already put back, and so is a line whose wallet
 * was forgotten since the sweep started. Never rejects.
 */
export function putBackCard(card: Recovery | null): Promise<void> {
  const claimed = card === null ? undefined : claimedCards.get(card)
  if (card === null || claimed === undefined) {
    return Promise.resolve()
  }
  claimedCards.delete(card)
  return putBack(claimed.line, claimed.scope)
}

// Which one the buyer is shown when a wallet is owed more than one thing, which is rare enough that
// the ordering matters more for being defensible than for being common. Everything a person has to
// act on outranks everything that finished or finishes itself.
const URGENCY: Record<RecoveryStatus, number> = {
  stuck: 0,
  blocked: 1,
  paidAgain: 2,
  waiting: 3,
  credit: 4,
  settling: 5,
  ready: 6,
  repaid: 7,
  paidAgainRepaid: 7,
  boughtBefore: 8,
}

// A name bought through the store and never chosen is the buyer's for ever, and neither store shows
// a reinstalled app a consumable it already finished, so the gateway's list is the only way back to
// it. Asked at the build's domain, since the list names no host. The credit is undefined when the list
// could not be read, which keeps the question open, as does a refresh after a refund still owed.
async function unspentCredit(
  deps: RecoverDeps,
  build: string,
): Promise<{ credit: Recovery | null | undefined; refreshOwed: boolean }> {
  const list = await storeCredits({
    gatewayUrl: `https://${build}`,
    domain: build,
    pubkey: deps.pubkey,
    sign: deps.sign,
    now: deps.now,
    request: deps.request,
    sleep: deps.sleep,
  }).catch(() => null)
  if (list === null) {
    return { credit: undefined, refreshOwed: false }
  }
  const refreshOwed = await refreshAfterRefund(deps, list)
  const spare = list.find(spendable)
  // A credit carries no reference of its own; the key that bought it is what support looks up.
  const credit: Recovery | null = spare
    ? { status: 'credit', kind: 'name', subject: spare.domain, reference: '', pubkey: deps.pubkey }
    : null
  return { credit, refreshOwed }
}

// A refund annuls the credit, and the name it bought is frozen, while the SDK's cache can keep showing
// that name until the next connect. The list names no name for an annulled credit, so only its id and
// domain are passed on, and spark.ts asks the gateway about the name the wallet shows there before it
// reconnects. Never fails the sweep.
//
// Answers whether the refresh is still owed. One skipped for a send or an address change in flight
// left the dead name live, and neither a focus, which keeps a live connection, nor a sweep a day away
// would retry it soon, so the sweep keeps its question open until the refresh runs.
async function refreshAfterRefund(deps: RecoverDeps, list: StoreCredit[]): Promise<boolean> {
  const annulled = list.filter(credit => credit.state === 'annulled').map(({ id, domain }) => ({ id, domain }))
  if (annulled.length === 0) {
    return false
  }
  try {
    await sparkRefreshTakenBackAddress(deps.walletId, annulled)
  } catch (err) {
    if (err instanceof SparkReconnectBusy) {
      return true
    }
    console.warn(`address not refreshed after a refund: ${(err as Error)?.message ?? String(err)}`)
  }
  return false
}

// What this wallet paid for and never received, granted where it can be and named where it cannot.
//
// Never rejects, and answers null far more often than not. Nothing recovered draws nothing at all:
// no toast, no empty state, no "all clear". A wallet that was owed nothing and a wallet whose
// gateway could not be reached both see the same screen they always saw, and the difference between
// them is not in the pixels but in whether the question was recorded as answered.
//
// One sweep runs at a time, and a call while one is out answers null, which the home screen reads as
// nothing new. Two at once would each confirm the same charges and each take a name.
let sweeping = false

export async function recoverPurchases(deps: RecoverDeps): Promise<Recovery | null> {
  if (sweeping) {
    return null
  }
  sweeping = true
  try {
    return await sweep(deps)
  } finally {
    sweeping = false
  }
}

async function sweep(deps: RecoverDeps): Promise<Recovery | null> {
  // Every line this sweep notes, claims or puts back goes under the scope its caller read as it picked
  // the wallet, and none once that wallet is removed or its data deleted after the pick.
  const { lines } = deps
  const build = getBreezLnurlDomain()
  if (!build) {
    return null
  }
  const nowSecs = Math.floor((deps.now ?? Date.now)() / 1000)
  if (!dueAgain((await readAsked())[deps.walletId], nowSecs)) {
    return showCard([], deps, lines, deps.showing)
  }
  let reply: PendingReply
  try {
    reply = await fetchPendingCharges(deps, build)
  } catch {
    // Recorded as asked and still open, so the next screen focus retries in minutes rather than
    // tomorrow, and a gateway that is down does not take one request per focus while it is.
    await rememberAsk(deps.walletId, nowSecs, true).catch(() => undefined)
    return showCard([], deps, lines, deps.showing)
  }
  // Dropped before anything else. A record naming a charge that can never receive money stands for a
  // purchase that never happened, and while it sits there the wallet cannot buy anything and is told
  // its money is on its way. Only references the gateway named are dropped, never ones inferred from
  // silence: an empty list means nothing is known to be dead, not that nothing is.
  for (const dead of reply.expired) {
    await clearPendingPurchase(dead, deps.walletId).catch(() => undefined)
    await clearPending('name', dead, deps.walletId).catch(() => undefined)
  }

  const found: Recovery[] = []
  let taken = false
  // Whether a confirmation went unanswered, which leaves the question open whatever the card says.
  let unanswered = false
  for (const charge of reply.charges) {
    try {
      const result = await finish(deps, build, charge, charge.kind === 'name' && !taken)
      if (charge.kind === 'name' && result.status !== 'settling') {
        taken = true
      }
      found.push(result)
    } catch (err) {
      const message = (err as Error)?.message ?? ''
      // A refusal the gateway names is money it has taken and not turned into anything, which only a
      // person can move, unless it says the sats came back or the charge bought its year before. The
      // exception is `final: false`, another wallet's reservation in the way, which a later
      // confirmation may still get past, so it reads as landing and keeps the question open.
      const paidLine = paidRefusal(err)
      // A holder's answer to a payment that bought nothing: the wallet holds the name, so it goes on
      // the wallet only while the wallet answers on no address at all (takeName), and it spends this
      // sweep's one register as a grant would. The slot is given up below, so no later reader asks
      // about this charge again or registers on its answer.
      if (charge.kind === 'name' && holdsTheName(err)) {
        if (!taken) {
          await takeName(charge.subject, deps.walletId)
        }
        taken = true
      }
      // An answer that releases the slot is kept as a line first and the slot given up after, whether
      // or not this charge held it, since nothing else is left to say it: the gateway never lists the
      // charge again, and the slot may hold another charge's proof. The card shows it only once it is
      // taken back out (showCard). A crash between the two leaves the proof, which the next reader
      // confirms again, hears the same answer about and finds the line already kept.
      if (paidLine !== undefined && releases(paidLine, err)) {
        await noteLine(
          { kind: charge.kind, reference: charge.reference, answer: paidLine, subject: shownAs(charge) },
          lines,
        )
        await release(charge.kind, charge.reference, paidLine, deps.walletId)
        continue
      }
      // Everything else is the network, which says nothing new about the payment. The last paid
      // refusal on the proof stands, so one for good still asks for a person and any other reads as
      // landing.
      const named = NEEDS_A_PERSON.has(message)
      if (!named) {
        unanswered = true
      }
      found.push({
        kind: charge.kind,
        subject: shownAs(charge),
        reference: charge.reference,
        pubkey: deps.pubkey,
        // A named refusal that is no paid answer, a disowned reference, is stuck as before.
        status: named
          ? paidLine === undefined
            ? 'stuck'
            : statusOf(paidLine)
          : statusOf(await answeredBefore(charge, deps.walletId)),
      })
      if (paidLine !== undefined) {
        await keepRefusal(charge, paidLine, deps.walletId)
      }
    }
  }
  // A payment still in flight keeps the question open, and so does a reply this build could not read
  // in full: a list short of a row reads as a wallet owed less than it is, and that reading must
  // never be the one that gets recorded as the answer. A blocked charge was settled by its grant,
  // so the gateway will not list it again. A stuck one stays unsettled, and the gateway lists it for
  // its thirty day recovery window, so the next ask a day later shows the card again; asking sooner
  // buys nothing, and what carries both forward is the proof left on disk and the mail to support.
  // One that reads as stuck from the proof because its confirmation went unanswered was settled by
  // nothing, and keeps the question open too, as does an address refresh after a refund still owed.
  // Only a build that sells through the store can spend a credit, so only one asks for them.
  const { credit, refreshOwed } =
    getDistribution() === 'store' ? await unspentCredit(deps, build) : { credit: null, refreshOwed: false }
  if (credit) {
    found.push(credit)
  }
  const open =
    !reply.whole ||
    unanswered ||
    found.some(r => r.status === 'settling') ||
    credit === undefined ||
    refreshOwed
  await rememberAsk(deps.walletId, nowSecs, open).catch(() => undefined)
  return showCard(found, deps, lines)
}

// The card is the most urgent of what this sweep found and the lines kept for this wallet, read here,
// after every question of the sweep has been answered, so a line a view took meanwhile is not among
// them. A line is the card only once a claim hands it back out of the list, which one reader alone
// manages; one a view took or claimed first is passed over for the next. Read on the device alone, so a sweep the throttle holds
// back, or one whose list could not be fetched, still shows them. The home screen puts the card up as
// soon as it is answered, so the slot of a line taken here is given up as shown.
//
// A sweep that asked nothing finds nothing, and the card on screen is still the latest word, so it
// stands among the candidates, ahead of a line as urgent as it. When it comes first nothing is
// claimed and the answer is null, which Home reads as keeping it, and the lines wait in the list. A
// line is claimed only while a card would be seen, and one claimed as the app left goes back. The
// card is the sweep's own wallet's, so a sweep the session switched away from meanwhile, or one
// that cannot read which wallet is active, answers none and claims no line, since Home would put it
// up over another wallet; the lines stay listed for this wallet's next reader. A switch can still land
// after the last look, while the slot is given up or before Home paints, and Home then hands the card
// back (putBackCard), which returns its line to this wallet's list.
async function showCard(
  found: Recovery[],
  deps: RecoverDeps,
  lines: LineScope,
  showing?: Recovery | null,
): Promise<Recovery | null> {
  const { pubkey, walletId } = deps
  const ours = (): Promise<boolean> =>
    getActiveWalletId().then(
      active => (active ?? PRIMARY_ID) === walletId,
      () => false,
    )
  const seen = async (): Promise<boolean> => (deps.onScreen?.() ?? true) && (await ours())
  const candidates: { result: Recovery; line?: ReleasedLine; onScreen?: true }[] = [
    ...(showing ? [{ result: showing, onScreen: true as const }] : []),
    ...found.map(result => ({ result })),
    ...(await listLines(walletId)).map(line => ({ result: lineCard(line, pubkey), line })),
  ].sort((a, b) => URGENCY[a.result.status] - URGENCY[b.result.status])
  for (const { result, line, onScreen } of candidates) {
    if (onScreen) {
      return null
    }
    if (line === undefined) {
      return (await ours()) ? result : null
    }
    if (!(await seen())) {
      continue
    }
    const claim = await claimLine(line.reference, lines)
    if (claim.outcome === 'claimed' && claim.line !== null) {
      const taken = claim.line
      if (!(await seen())) {
        await putBack(taken, lines)
        continue
      }
      await release(taken.kind, taken.reference, taken.answer, walletId)
      const card = lineCard(taken, pubkey)
      claimedCards.set(card, { line: taken, scope: lines })
      return card
    }
  }
  return null
}

// Where a customer who paid, and whose lookup comes back empty, goes instead of a dead end. The gateway keeps a
// charge for a limited window and the treasury keeps its own record, so a lookup by support needs
// the key the payment was made from, which is a primary key at both services. Read from the device
// and never from the network, because the case this exists for is the one where the network already
// answered nothing.
export type PaymentEvidence = { pubkey: string; references: string[]; unread: boolean }

type Evidence = { references: string[]; unread: boolean }

// What the store itself still holds open, which on a reinstall is the only trace of a store purchase
// the gateway never delivered. A purchase that carries no order reference is named by its store key.
async function storeListEvidence(): Promise<Evidence> {
  if (!storeAvailable()) {
    return { references: [], unread: false }
  }
  let open: StorePurchase[]
  try {
    open = await openPurchases()
  } catch (err) {
    // A device the store says has no billing, as Play says with no Google account, holds no store
    // purchase it can see, so its list is read and empty. Any other refusal leaves the list unread.
    if (err instanceof StoreError && err.noBilling) {
      return { references: [], unread: false }
    }
    throw err
  }
  return { references: open.map(purchase => purchase.reference ?? purchase.key), unread: false }
}

// Every place on the device that can hold a payment: the sats proofs of every wallet and kind, the
// older per-kind files, the domain year records, the store book and a copy of it set aside, and the
// store's list of open purchases.
const SOURCES: readonly (() => Promise<Evidence>)[] = [
  allPendingReferences,
  allPendingPurchaseReferences,
  storeBookEvidence,
  storeListEvidence,
]

// `unread` is true when any of those sources, or any record inside one, could not be read: "no payment
// on this device" is then not known. Every reference that did read is carried, from any wallet, since
// a torn file beside a good proof must not hide the good one, and the references find the payment
// without the key. The key is the active wallet's; one that cannot be read is left empty, since an
// empty line claims nothing about money.
export async function paymentEvidence(pubkey: () => Promise<string>): Promise<PaymentEvidence> {
  const key = await pubkey().catch(() => '')
  const references: string[] = []
  let unread = false
  for (const source of SOURCES) {
    const read = await source().catch((): Evidence => ({ references: [], unread: true }))
    references.push(...read.references)
    unread = unread || read.unread
  }
  return { pubkey: key, references: [...new Set(references)], unread }
}

// The one address the support page names, its contact row and the mail below alike. A form would
// need a backend on a product built without one, and a mail leaves the customer their own copy in
// their sent folder.
export const SUPPORT_EMAIL = 'support@usevoltz.app'

export function helpMailUrl(subject: string, body: string): string {
  return `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`
}
