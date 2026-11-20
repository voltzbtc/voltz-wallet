// Bringing a domain the customer already owns onto the service. The gateway rebuilds the signed
// statement to verify it, so the two must stay byte-identical or every request is rejected.
import RNFS from 'react-native-fs'
import { PRIMARY_ID } from './seed'
import { getActiveWalletId } from './walletRegistry'
import { finalOf, releasedProof, repaidOf, type FinalAnswer } from './lnRefusal'
import { deletedError, deletionRefusal, noteGatewayDeleted } from './deletionMark'
import {
  isUnreadableFile,
  readDurable,
  removeDurable,
  serialQueue,
  UnreadableFile,
  writeDurable,
} from './durableFile'

const VERSION = 'voltz-onboard:v1'

export function onboardMessage(host: string, ownerPubkey: string, timestamp: number): string {
  // The host is inside the signature, so a signature made for one domain cannot claim another.
  return [VERSION, 'claim', host, ownerPubkey, String(timestamp)].join('\n')
}

// Settling a charge is signed too. The charge already holds the buyer's key, so an unsigned confirm
// cannot move a domain, but that rests on a couple of lines of gateway SQL staying as they are, and
// a payment hash is no secret: every routing node on the path sees it.
//
// A different action word from the claim, and the reference inside, so a signature made to price a
// domain cannot settle a charge on it and a signature made for one charge cannot settle another.
export function confirmMessage(
  host: string,
  ownerPubkey: string,
  reference: string,
  timestamp: number,
): string {
  return [VERSION, 'confirm', host, ownerPubkey, reference, String(timestamp)].join('\n')
}

export type ProviderId =
  | 'cloudflare'
  | 'route53'
  | 'namecheap'
  | 'hostinger'
  | 'registrobr'
  | 'godaddy'
  | 'locaweb'
  | 'hostgator'
  | 'wix'
  | 'generic'

// Where the customer stands. `awaiting_dns` and `wrong_target` are kept apart because they need
// opposite advice: one is "keep waiting", the other is "this will never work, fix it".
export type OnboardState =
  | 'awaiting_dns'
  | 'wrong_target'
  | 'awaiting_certificate'
  | 'active'
  | 'root_unsupported'

export type OnboardStatus = {
  host: string
  provider: ProviderId
  supportsRoot: boolean
  isRoot: boolean
  target: string
  state: OnboardState
  // The name already answers with an address, so the record being asked for is a replacement rather
  // than an addition. Optional because a gateway older than the field simply omits it, and absent
  // has to mean "not known to be occupied" rather than a warning nobody can act on.
  occupied?: boolean
}

/**
 * What the gateway currently charges, in US cents, keyed as its price table keys them. A key with no
 * row there is absent here rather than defaulted, so "nobody chose this price" never renders as a
 * number somebody could act on.
 *
 * Read from the gateway rather than carried as a constant, because the gateway prices from a table:
 * a constant here is a second source of truth, and any change there would leave the screen
 * advertising the old number until a build shipped.
 */
export type PriceBook = Partial<Record<string, number>>

// Held for the length of a screen's visit rather than the process, since the price moves by an
// insert and a stale book would disagree with the quote.
const PRICE_TTL_MS = 60_000
let priceCache: { at: number; book: PriceBook } | null = null

export async function fetchPrices(
  gatewayUrl: string,
  request: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<PriceBook> {
  if (priceCache && now() - priceCache.at < PRICE_TTL_MS) {
    return priceCache.book
  }
  const response = await request(endpoint(gatewayUrl, '/api/prices'))
  if (!response.ok) {
    await refuse(response)
  }
  const body = (await response.json()) as { prices?: unknown }
  const raw = typeof body.prices === 'object' && body.prices !== null ? body.prices : {}
  // Only numbers cross. A key answered as a string or null is the gateway saying it has no price,
  // and carrying that through as something falsy would print as a free tier.
  const book: PriceBook = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      book[key] = value
    }
  }
  priceCache = { at: now(), book }
  return book
}

/** Only for tests, which must not inherit a book cached by the case before them. */
export function forgetPrices(): void {
  priceCache = null
}

export type DomainQuote = {
  host: string
  priceUsdCents: number
  days: number
  amountSats: number
  invoice: string
  reference: string
  /** Unix seconds after which the hold lapses and the invoice stops being payable. */
  expiresAt: number
}

// A payment that settled but was never confirmed. Written before the money moves, so an app that is
// killed between paying and confirming can pick the purchase back up instead of paying twice: the
// reference is the only proof the buyer holds.
//
// One record per wallet, the shape lnurlDomainPref.ts and purchase.ts already use for per wallet
// state. A single slot is wrong here because the gateway only confirms a charge for the key that
// paid it: a single slot hands a device's second wallet the first one's reference, which the
// gateway answers with 409 forever, leaving that wallet unable to buy any domain while the proof it
// holds hostage belongs to somebody else.
const PENDING = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`

export type PendingPurchase = {
  host: string
  reference: string
  amountSats: number
  /**
   * Set on a record that stands for no payment, meaning one written before the send was
   * dispatched. It occupies the slot rather than being absent, so a purchase abandoned before the
   * money moved leaves nothing that reads as owed.
   */
  unpaid?: boolean
  /**
   * Which of the two the buyer chose. Recorded rather than worked out again on the next mount,
   * because the host alone cannot answer it: `shop.com.br` and `pay.shop.com` both carry three
   * labels, and only a list of every public suffix in the world separates them. Counting labels
   * calls the first one a subdomain `shop` sitting on `com.br`, which is not a domain anybody owns.
   *
   * Optional for a record written before this field existed. Those last only as long as a payment
   * takes to settle, so the old guess is kept for them rather than given a migration.
   */
  isRoot?: boolean
  /**
   * Set while the last paid refusal the gateway gave for this reference was for good, which a
   * person sorts out. A screen with no fresh answer reads it, so a restart that cannot reach the
   * gateway still sends the buyer to that person rather than promising a year that never comes.
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
}

// A slot is kept as it was read, since another wallet's slot in a shape this build cannot read is
// still that wallet's and is written back untouched.
type Stored = Record<string, unknown>

function isPurchase(value: unknown): value is PendingPurchase {
  return typeof (value as PendingPurchase)?.reference === 'string'
}

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Every reader and writer of the record runs its whole body in one turn of this queue. The recovery
// sweep files a proof into the same slot the domain screen pays from (recover.ts, hold), so a check
// and the write it allows must be one turn, or both pass the check and the second write buries the
// first reference. Reads wait too, since a read whose calls interleave with a write's can find the
// file already unlinked and then its copy already moved (durableFile.ts). Nothing inside a turn calls
// an exported function of this module.
const serial = serialQueue()

/**
 * How a year's proof left the record, which the writer that took it out knows. `granted` is the clear
 * once the year was delivered, carrying what its grant answered, so a view shows the year bought from
 * that answer and asks nothing again; `gone` is every other way out: an answer that owes nothing or
 * gave the sats back, a charge that expired, a send that never left, or the wallet's data forgotten.
 */
export type PurchaseLeft = { reason: 'granted'; year: DomainConfirmation } | { reason: 'gone' }

type PurchaseGoneListener = (reference: string, left: PurchaseLeft) => void

const goneListeners = new Set<PurchaseGoneListener>()

/**
 * Tells a view when a proof it may be waiting on leaves the record, and how. The record is shared with
 * the recovery sweep (recover.ts), which can confirm, give up or clear a proof while the domain screen
 * says that year is coming, and a screen left open would go on saying so. Called once the turn that
 * changed the record is over, never inside it. Answers the unsubscribe.
 */
export function onPendingPurchaseGone(listener: PurchaseGoneListener): () => void {
  goneListeners.add(listener)
  return () => {
    goneListeners.delete(listener)
  }
}

// Runs `work` in one turn of the queue and, once that turn is over, tells the listeners of every
// reference `work` reported as no longer owed, with how the writer says it left, so a listener never
// runs inside the turn.
function serialTelling<T>(how: PurchaseLeft, work: (left: (reference: string) => void) => Promise<T>): Promise<T> {
  const left: string[] = []
  return serial(() => work(reference => left.push(reference))).finally(() => {
    for (const reference of left) {
      for (const listener of [...goneListeners]) {
        listener(reference, how)
      }
    }
  })
}

const GONE: PurchaseLeft = { reason: 'gone' }

// The reference this wallet's readers answer as owed, null for none, and undefined when that cannot
// be read, which tells nobody anything.
function owedReference(parsed: unknown, id: string): string | null | undefined {
  try {
    return owedIn(recordFor(parsed, id))?.reference ?? null
  } catch {
    return undefined
  }
}

// Reports the reference owed before a write that landed when it is no longer the one owed after it.
function reportLeft(left: (reference: string) => void, before: string | null | undefined, after: unknown, id: string): void {
  const now = owedReference(after, id)
  if (before && now !== undefined && now !== before) {
    left(before)
  }
}

// The wallet that pays is the one spark.ts has connected, which is the registry's active id. Read
// here for a view, so a screen cannot file a payment under a wallet other than the one the send
// went out from. The recovery sweep names the wallet it asked the gateway for (`walletId`), as it
// does for the name slot (purchase.ts, currentWallet), so a switch while its questions are out
// never files, marks or clears the asked wallet's year in the record of the wallet switched to. A
// registry that cannot be read rejects, and is never taken for the primary wallet.
async function payingWallet(walletId?: string): Promise<string> {
  return walletId ?? (await getActiveWalletId()) ?? PRIMARY_ID
}

// A cut first write of the record reads as no record (durableFile.ts, FirstWriteCut). The only write
// that can be the first is savePendingPurchase's: the domain screen prepares and sends only after it
// answered, and the recovery sweep's hold records a charge the gateway lists and lists again.
const FIRST_WRITE_CUT = 'nothing'

// The file as it stands: null when there is none, the unkeyed record of an older app, or the store
// keyed by wallet. Throws UnreadableFile when the file, or a finished write's copy beside it, cannot
// be read.
function read(): Promise<unknown> {
  return readDurable(PENDING, isMap, FIRST_WRITE_CUT)
}

function write(stored: unknown): Promise<void> {
  return writeDurable(PENDING, JSON.stringify(stored), isMap, 'refuse', FIRST_WRITE_CUT)
}

// A record written before the store was keyed no longer says whose payment it is, so it is offered
// to whoever asks. Filing it under one wallet would bury a real payment under a key that may not be
// able to finish it, and the confirmation refuses the wrong wallet anyway. Read here and never
// written, apart from the mark a paid refusal leaves on it.
//
// Answers this wallet's record as it stands, a record standing for no payment included, and throws
// when the record there cannot be read.
function recordFor(parsed: unknown, id: string): PendingPurchase | undefined {
  if (parsed === null) {
    return undefined
  }
  const held = isPurchase(parsed) ? parsed : (parsed as Stored)[id]
  if (held === undefined) {
    return undefined
  }
  if (!isPurchase(held)) {
    throw new UnreadableFile(PENDING)
  }
  return held
}

// A record that stands for no payment answers as no record at all: it holds no price back and the
// next purchase writes straight over it. Answering with it instead would put a wallet that never
// paid on a wait for a charge the gateway refuses forever, with no price left anywhere to press. A
// record whose last answer owes nothing stands for no payment owed, and answers the same way.
function owedIn(held: PendingPurchase | undefined): PendingPurchase | null {
  return held && held.unpaid !== true && !releasedProof(held) ? held : null
}

/**
 * The payment this wallet has on record, or null when it has none. Throws `UnreadableFile` when the
 * file or this wallet's record in it cannot be read: whether a payment is owed is then not known, and
 * answering none would put a price beside it.
 */
export function loadPendingPurchase(walletId?: string): Promise<PendingPurchase | null> {
  return serial(async () => owedIn(recordFor(await read(), await payingWallet(walletId))))
}

/**
 * Every reference the record holds, of any wallet, leaving out records that stand for no payment,
 * and whether the file or any record in it could not be read. What did read is carried either way.
 */
export function allPendingPurchaseReferences(): Promise<{ references: string[]; unread: boolean }> {
  return serial(async () => {
    let parsed: unknown
    try {
      parsed = await read()
    } catch {
      return { references: [], unread: true }
    }
    const records = parsed === null ? [] : isPurchase(parsed) ? [parsed] : Object.values(parsed as Stored)
    const references: string[] = []
    let unread = false
    for (const record of records) {
      if (!isPurchase(record)) {
        unread = true
      } else if (record.unpaid !== true) {
        references.push(record.reference)
      }
    }
    return { references, unread }
  })
}

// The store keyed by wallet that a write starts from. The unkeyed record is not carried into it: a
// save reaches it only for its own reference or over a record standing for no payment, and a clear
// only when it names that record's reference.
function keyedOf(parsed: unknown): Stored {
  return parsed !== null && !isPurchase(parsed) ? { ...(parsed as Stored) } : {}
}

// Answers with the proof that ends up on disk, which is not always the one passed in. One slot holds
// this wallet's only reference, so writing a second payment over a first that is still owed leaves
// money nobody can point at from then on. The caller is handed the purchase that won so it can finish
// that one instead of paying again. The same reference is written through, since retrying one invoice
// is not a second payment.
//
// A refusal for good kept on that record stays through the write, with the final answer it names,
// since writing the reference again says nothing about the payment and only the gateway's answer
// takes the refusal back.
//
// Throws, writing nothing, when what is on record cannot be read, so no payment is sent against it.
export function savePendingPurchase(purchase: PendingPurchase, walletId?: string): Promise<PendingPurchase> {
  return serial(async () => {
    const parsed = await read()
    const id = await payingWallet(walletId)
    const held = owedIn(recordFor(parsed, id))
    if (held && held.reference !== purchase.reference) {
      return held
    }
    const written: PendingPurchase = held?.refusedForGood
      ? marked(purchase, true, held.finalAnswer)
      : purchase
    await write({ ...keyedOf(parsed), [id]: written })
    return written
  })
}

function marked(proof: PendingPurchase, forGood: boolean, answer?: FinalAnswer): PendingPurchase {
  const next = { ...proof }
  delete next.finalAnswer
  if (forGood) {
    next.refusedForGood = true
    if (answer !== undefined && answer !== 'kept') {
      next.finalAnswer = answer
    }
  } else {
    delete next.refusedForGood
  }
  return next
}

// Keeps the gateway's word on a paid charge with the proof it is about. `forGood` is a final answer,
// a refusal with `final: true` or no `final` and every answer `answer` names, and false is
// `final: false` or a grant, so the latest answer is what a screen reads after a restart. `answer`
// names a final answer other than a person giving the sats back. Only the record this wallet reads
// under that reference is marked, and nothing else on it changes, since it is the buyer's only
// pointer at money that already left.
export function recordPurchaseRefusal(
  reference: string,
  forGood: boolean,
  answer?: FinalAnswer,
  walletId?: string,
): Promise<void> {
  // A mark never delivers anything: one that leaves no proof owed names an answer that owes nothing.
  return serialTelling(GONE, async left => {
    try {
      const parsed = await read()
      const id = await payingWallet(walletId)
      const held = recordFor(parsed, id)
      if (held === undefined || held.reference !== reference) {
        return
      }
      const mark = marked(held, forGood, answer)
      // The unkeyed record is the whole file and the one loadPendingPurchase offers, so the mark goes
      // where that read finds it.
      const next = isPurchase(parsed) ? mark : { ...(parsed as Stored), [id]: mark }
      await write(next)
      // A mark naming an answer that owes nothing leaves no proof owed.
      reportLeft(left, owedReference(parsed, id), next, id)
    } catch {
      // A mark that could not be written, or a record that could not be read, leaves the screen on
      // what it already shows and the file as it was, and the next answer writes it again.
    }
  })
}

// Gives the slot up on an answer that releases it (releases in lnRefusal.ts), so no reader asks the
// gateway about that charge again and the next opening offers a fresh quote. The caller has already
// shown the answer's line or kept it in releasedLines.ts, since nothing here keeps it. The mark goes
// first: a clear that fails after an answer that owes nothing leaves a record every reader answers as
// no proof (releasedProof), and both name the reference, so a slot another purchase took meanwhile
// stays.
export async function releasePendingPurchase(reference: string, answer: FinalAnswer, walletId?: string): Promise<void> {
  await recordPurchaseRefusal(reference, true, answer, walletId)
  await clearPendingPurchase(reference, walletId)
}

// The reference names what is being given up, and is required: a clear of whatever the slot holds
// would drop a proof the recovery sweep filed into that same slot for any charge the gateway says this
// wallet is owed (recover.ts, hold), and a purchase that never dispatched would delete the only thing
// on the device pointing at money that already left. Read raw rather than through the reader above,
// since a record standing for no payment is still this purchase's to drop.
export function clearPendingPurchase(reference: string, walletId?: string): Promise<void> {
  return clearRecord(reference, GONE, walletId)
}

// The clear once the year was delivered, carrying what its grant answered. A view waiting on that
// reference hears it as delivered rather than given up, so it shows the year bought and never offers a
// price for it again. Named by its reference, since a clear of whatever the record holds says nothing
// about which charge was delivered.
export function clearGrantedPurchase(reference: string, year: DomainConfirmation, walletId?: string): Promise<void> {
  return clearRecord(reference, { reason: 'granted', year }, walletId)
}

function clearRecord(reference: string, how: PurchaseLeft, walletId: string | undefined): Promise<void> {
  return serialTelling(how, async left => {
    try {
      const parsed = await read()
      const id = await payingWallet(walletId)
      const held = recordFor(parsed, id)
      if (held && held.reference !== reference) {
        return
      }
      const before = owedReference(parsed, id)
      // An unkeyed record only ever reaches here through the wallet that just confirmed it, since the
      // gateway refuses any other. A store with nothing left in it is removed, so "no proof" and "no
      // file" stay the same statement.
      const stored = keyedOf(parsed)
      delete stored[id]
      if (Object.keys(stored).length === 0) {
        await removeDurable(PENDING)
        reportLeft(left, before, null, id)
        return
      }
      await write(stored)
      reportLeft(left, before, stored, id)
    } catch {
      // A stale file only costs one extra confirmation attempt, which is idempotent. A file that
      // cannot be read is left as it is, since it may be the only proof of a payment.
    }
  })
}

// Drops this wallet's slot, whatever it holds, once the gateway said the wallet's data is gone and no
// confirmation for it can succeed. The unkeyed record of an older app is left, since nothing in it
// says whose it is, and every other wallet's slot is written back as it was. A file that cannot be
// read is left as it is, for support, and the wallet's record stays inside it.
export function forgetWalletDomainPurchase(walletId: string): Promise<void> {
  return serialTelling(GONE, async left => {
    let parsed: unknown
    try {
      parsed = await read()
    } catch (err) {
      if (isUnreadableFile(err)) {
        return
      }
      throw err
    }
    if (parsed === null || isPurchase(parsed)) {
      return
    }
    const stored = keyedOf(parsed)
    if (!(walletId in stored)) {
      return
    }
    const before = owedReference(parsed, walletId)
    delete stored[walletId]
    if (Object.keys(stored).length === 0) {
      await removeDurable(PENDING)
      reportLeft(left, before, null, walletId)
      return
    }
    await write(stored)
    reportLeft(left, before, stored, walletId)
  })
}

export type OnboardDeps = {
  gatewayUrl: string
  ownerPubkey: string
  sign: (message: string) => Promise<string>
  now?: () => number
  request?: typeof fetch
}

// Proper nouns, shown as the provider writes them. They are neither translated nor a menu path,
// because panels are renamed often enough that naming one ages worse than naming none.
const PROVIDER_NAMES: Record<ProviderId, string> = {
  cloudflare: 'Cloudflare',
  route53: 'Amazon Route 53',
  namecheap: 'Namecheap',
  hostinger: 'Hostinger',
  registrobr: 'Registro.br',
  godaddy: 'GoDaddy',
  locaweb: 'Locaweb',
  hostgator: 'HostGator',
  wix: 'Wix',
  generic: '',
}

export function providerName(id: ProviderId): string {
  return PROVIDER_NAMES[id] ?? ''
}

// The name the customer types into the record. A subdomain takes only its own label, since the
// panel appends the rest; the root takes the marker every provider uses for it.
export function recordName(host: string, isRoot: boolean): string {
  return isRoot ? '@' : host.split('.')[0]!
}

// A domain typed by hand, or pasted with a scheme and a path. It is shaped here rather than judged,
// and the gateway decides, since only it can convert `bakery.рф` to the punycode form DNS and
// certificates use, and it answers `not_a_domain` for the rest. Checking here only keeps the
// customer from waiting on a request for something that is plainly not a domain.
//
// So the labels are read by what they cannot hold rather than by an allowed alphabet: any letter of
// any script is a domain somewhere, and an ASCII-only rule turns away the customers this is for.
const FORBIDDEN = /[\s/\\@:?#[\]]/

export function normaliseDomain(input: string): string | null {
  const domain = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '')
  if (domain.length < 1 || domain.length > 253 || FORBIDDEN.test(domain)) {
    return null
  }
  const labels = domain.split('.')
  // A single label is a machine name, never a domain that can be bought or pointed anywhere.
  if (labels.length < 2) {
    return null
  }
  const wellFormed = labels.every(
    label =>
      label.length >= 1 && label.length <= 63 && !label.startsWith('-') && !label.endsWith('-'),
  )
  // The last label is what makes it a domain rather than an address: no top-level domain is one
  // character or all digits, and `1.2.3.4` would otherwise be sent on to a DNS step.
  const last = labels[labels.length - 1]!
  return wellFormed && last.length >= 2 && !/^\d+$/.test(last) ? domain : null
}

function endpoint(gatewayUrl: string, path: string): string {
  // /api is the prefix the edge routes to the gateway; a path at the root answers from the LNURL
  // server instead, which accepts the request and does nothing with it.
  return `${gatewayUrl.replace(/\/+$/, '')}${path}`
}

async function signedPost(
  deps: OnboardDeps,
  path: string,
  host: string,
  extra: Record<string, unknown> = {},
): Promise<Response> {
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(onboardMessage(host, deps.ownerPubkey, timestamp))
  return (deps.request ?? fetch)(endpoint(deps.gatewayUrl, path), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, ownerPubkey: deps.ownerPubkey, signature, timestamp, ...extra }),
  })
}

// What the gateway knows about a domain and says while refusing to serve it. Every field is optional
// and absent means unmeasured, never false: a root reported free because nobody could check it is how
// somebody buys a year on a domain that already carries their site.
export type DomainFacts = {
  provider?: string
  supportsRoot?: boolean
  isRoot?: boolean
  // About the name that was asked for.
  occupied?: boolean
  // About the customer's root, whichever name was asked for, because the choice between root and
  // subdomain is made before either has been asked about.
  rootOccupied?: boolean
}

// Read back off a rejected promise. The refusal keeps its message as the bare error code, because
// three call sites compare that string and one maps it to a sentence, and it carries the facts
// alongside rather than instead.
export function factsOf(err: unknown): DomainFacts {
  const carried = (err as { facts?: unknown })?.facts
  return carried && typeof carried === 'object' ? (carried as DomainFacts) : {}
}

function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

// `pubkey` is the key the call was signed with, against which a 409 `deleted` is noted for the status
// read (deletionMark.ts); the price list is signed by nobody.
async function refuse(response: Response, pubkey?: string): Promise<never> {
  let reason = `status ${response.status}`
  let facts: DomainFacts = {}
  let final: boolean | undefined
  let repaid: boolean | undefined
  try {
    const body = (await response.json()) as Record<string, unknown>
    if (typeof body.error === 'string') {
      reason = body.error
    }
    final = finalOf(body)
    repaid = repaidOf(body)
    // Copied field by field rather than spread, so a gateway that grows a field does not smuggle it
    // into a type that claims to know what it holds.
    facts = {
      provider: typeof body.provider === 'string' ? body.provider : undefined,
      supportsRoot: bool(body.supportsRoot),
      isRoot: bool(body.isRoot),
      occupied: bool(body.occupied),
      rootOccupied: bool(body.rootOccupied),
    }
  } catch {
    // Left as the status.
  }
  if (pubkey && response.status === 409 && reason === 'deleted') {
    noteGatewayDeleted({ pubkey })
  }
  // `final` and `repaid` travel as they do on a name's refusal, for paidRefusal in lnRefusal.ts to read.
  const error = new Error(reason) as Error & { facts: DomainFacts; final?: boolean; repaid?: boolean }
  error.facts = facts
  error.final = final
  error.repaid = repaid
  throw error
}

// Where the customer stands right now. Called on a timer by the screen, which is why there is no
// "I have finished" button: pressing one before DNS has spread is where a non-technical customer
// sees an error and decides they did it wrong.
export async function claimDomain(deps: OnboardDeps, host: string): Promise<OnboardStatus> {
  // A wallet that asked for its data to be deleted claims no domain until it asks for its address
  // back, which the gateway enforces as well.
  const stop = await deletionRefusal({ pubkey: deps.ownerPubkey })
  if (stop) {
    throw deletedError(stop)
  }
  const response = await signedPost(deps, '/api/domain/claim', host)
  if (!response.ok) {
    await refuse(response, deps.ownerPubkey)
  }
  return (await response.json()) as OnboardStatus
}

export async function quoteDomain(deps: OnboardDeps, host: string): Promise<DomainQuote> {
  const stop = await deletionRefusal({ pubkey: deps.ownerPubkey })
  if (stop) {
    throw deletedError(stop)
  }
  // The quote signs the same statement as the claim, so the wallet that pays is the wallet that
  // will own the domain.
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(onboardMessage(host, deps.ownerPubkey, timestamp))
  const response = await (deps.request ?? fetch)(endpoint(deps.gatewayUrl, '/api/domain/quote'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ host, pubkey: deps.ownerPubkey, signature, timestamp }),
  })
  if (!response.ok) {
    await refuse(response, deps.ownerPubkey)
  }
  return (await response.json()) as DomainQuote
}

// What the gateway granted. The gateway reads `frozen` before it puts the hostname back, so it
// means the domain was off the edge when the payment landed, which is the difference between
// saying an address works and saying it is coming back.
export type DomainConfirmation = {
  /** Unix seconds the paid year now ends. Null when the reply carried no date. */
  expiresAt: number | null
  frozen: boolean
}

export async function confirmDomain(
  deps: OnboardDeps,
  host: string,
  reference: string,
): Promise<DomainConfirmation | null> {
  // The gateway verifies the signature against the host in the payload before it normalises it, so
  // the host signed here has to be the same string that goes on the wire.
  const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
  const signature = await deps.sign(confirmMessage(host, deps.ownerPubkey, reference, timestamp))
  const response = await (deps.request ?? fetch)(
    endpoint(deps.gatewayUrl, '/api/domain/quote/confirm'),
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host, pubkey: deps.ownerPubkey, reference, signature, timestamp }),
    },
  )
  if (response.status === 402) {
    // Not an error. The payment simply has not landed yet, and the screen keeps waiting.
    return null
  }
  if (!response.ok) {
    await refuse(response, deps.ownerPubkey)
  }
  // The year is already granted by the time this reply exists, so a body that fails to parse must
  // never read as a purchase that did not happen. Both fields only choose which words are shown.
  const body = (await response.json().catch(() => ({}))) as {
    expiresAt?: unknown
    frozen?: unknown
  }
  return {
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
    frozen: body.frozen === true,
  }
}
