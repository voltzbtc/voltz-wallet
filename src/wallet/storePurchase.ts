import { AppState } from 'react-native'
import RNFS from 'react-native-fs'
import { currentDeps, type PurchaseDeps } from './namePurchase'
import { onSparkConnected, sparkConnectedWalletId } from './spark'
import {
  buy,
  currentStore,
  finish,
  isProductId,
  onPurchaseUpdate,
  openPurchases,
  storeAvailable,
  StoreError,
  type ProductId,
  type Store,
  type StoreErrorCode,
  type StorePurchase,
} from './store'
import { loadRegistry } from './walletRegistry'
import { retryAtOf } from './lnRefusal'
import { minorBySignal } from './ageSignal'
import { deletionRefusal, noteGatewayDeleted } from './deletionMark'
import { asideExists, isUnreadableFile, readDurable, serialQueue, setAside, writeDurable } from './durableFile'

// Buying a name credit or a domain year through the App Store or Google Play. The gateway opens an
// order before the store does, and after the store answers it asks the store itself whether the
// purchase was paid, then delivers. This module is the app's half of that conversation.

// Byte-identical to the statements the gateway rebuilds to verify each route's signature, which are
// the specification; these are copies that follow it.
// One prefix per action, so a signature made to order never verifies as a confirmation.
export const STORE_ORDER_VERSION = 'voltz-store-order:v1'
export const STORE_CONFIRM_VERSION = 'voltz-store-confirm:v1'
export const STORE_CREDITS_VERSION = 'voltz-store-credits:v1'
export const STORE_SPEND_VERSION = 'voltz-store-spend:v1'

export type StoreKind = 'name' | 'tier'

// `domain` is the host the request goes to, `subject` the name or the customer's host as sent.
export function storeOrderMessage(
  domain: string,
  pubkey: string,
  store: Store,
  kind: StoreKind,
  subject: string,
  timestamp: number,
): string {
  return [STORE_ORDER_VERSION, 'order', domain, pubkey, store, kind, subject, String(timestamp)].join('\n')
}

// `purchase` is the Apple transactionId or the Google purchaseToken.
export function storeConfirmMessage(
  domain: string,
  pubkey: string,
  store: Store,
  reference: string,
  purchase: string,
  timestamp: number,
): string {
  return [STORE_CONFIRM_VERSION, 'confirm', domain, pubkey, store, reference, purchase, String(timestamp)].join('\n')
}

export function storeCreditsMessage(pubkey: string, timestamp: number): string {
  return [STORE_CREDITS_VERSION, 'credits', pubkey, String(timestamp)].join('\n')
}

// Signed just before a register that spends a credit, naming the name, so a register the app makes on
// its own never spends one. `domain` is the host the register goes to.
export function storeSpendMessage(domain: string, pubkey: string, username: string, timestamp: number): string {
  return [STORE_SPEND_VERSION, 'spend', domain, pubkey, username, String(timestamp)].join('\n')
}

export type StoreGatewayDeps = PurchaseDeps & {
  // Injected so tests do not wait out the retries.
  sleep?: (ms: number) => Promise<void>
}

// What came back, kept apart from what it means. A body that is not a JSON object is not the
// gateway's, since the edge in front of it answers its own 403 and 5xx pages in HTML.
export type Reply =
  | { kind: 'json'; status: number; body: Record<string, unknown> }
  | { kind: 'notJson'; status: number }
  | { kind: 'network' }

function endpoint(gatewayUrl: string, path: string): string {
  return `${gatewayUrl.replace(/\/+$/, '')}${path}`
}

export async function post(deps: StoreGatewayDeps, path: string, body: Record<string, unknown>): Promise<Reply> {
  let response: Response
  let text: string
  try {
    response = await (deps.request ?? fetch)(endpoint(deps.gatewayUrl, path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    text = await response.text()
  } catch {
    return { kind: 'network' }
  }
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      const answer = parsed as Record<string, unknown>
      // Every store route refuses a deleted wallet's key with 409 `deleted` (the order and the spend
      // today), which says this device may hold no mark for it yet; the status read that follows
      // writes one, and the local stop then refuses the next order before it is sent.
      if (response.status === 409 && answer.error === 'deleted') {
        noteGatewayDeleted({ pubkey: deps.pubkey })
      }
      return { kind: 'json', status: response.status, body: answer }
    }
  } catch {
    // Falls through to the reply that is not the gateway's.
  }
  return { kind: 'notJson', status: response.status }
}

function nowSecs(deps: StoreGatewayDeps): number {
  return Math.floor((deps.now ?? Date.now)() / 1000)
}

function errorOf(reply: Reply): string | null {
  return reply.kind === 'json' && typeof reply.body.error === 'string' ? reply.body.error : null
}

// The waits before each retry of a request the gateway could not serve this time (its own 503) or
// that never reached it. After the last one the purchase waits for the next open.
export const SESSION_WAITS_MS: readonly number[] = [2_000, 4_000, 8_000]

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

function retriable(reply: Reply): boolean {
  return reply.kind === 'network' || (reply.kind === 'json' && reply.status === 503)
}

// Sends a signed request, signed afresh on every try, retrying in this session what the gateway
// could not serve and a 401 once, since a clock that drifted past the signature window refuses a
// signature that a new timestamp makes good.
export async function sendSigned(
  deps: StoreGatewayDeps,
  path: string,
  build: (timestamp: number) => { message: string; body: Record<string, unknown> },
): Promise<Reply> {
  const sleep = deps.sleep ?? defaultSleep
  let waits = 0
  let renewed = false
  for (;;) {
    const timestamp = nowSecs(deps)
    const { message, body } = build(timestamp)
    let reply: Reply
    try {
      const signature = await deps.sign(message)
      reply = await post(deps, path, { ...body, pubkey: deps.pubkey, signature, timestamp })
    } catch {
      // A wallet that cannot sign right now has not reached the gateway.
      reply = { kind: 'network' }
    }
    if (retriable(reply) && waits < SESSION_WAITS_MS.length) {
      await sleep(SESSION_WAITS_MS[waits]!)
      waits += 1
      continue
    }
    if (reply.kind === 'json' && reply.status === 401 && !renewed) {
      renewed = true
      continue
    }
    return reply
  }
}

export type StoreOrder = {
  reference: string
  productId: ProductId
  // 'paid' when the store already said paid and nothing was delivered: the purchase is looked for
  // among the store's open ones instead of opening the store again.
  state: 'held' | 'paid'
  kind: StoreKind
  subject: string
  // What the store is handed, copied from the order and never computed here: appAccountToken on
  // Apple, obfuscatedProfileId and obfuscatedAccountId on Google.
  storeReference: string
  accountId: string | null
}

export type OrderResult =
  | { kind: 'order'; order: StoreOrder }
  // The gateway's own refusal, which the screen explains as it explains a sats quote's. `retryAt` is
  // the unix second a refusal that clears on its own clears.
  | { kind: 'refused'; status: number; code: string; retryAt?: number }
  // The gateway decided nothing, as with its own 503, a network failure or an answer not its own.
  | { kind: 'retry' }

const REFERENCE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function readOrder(store: Store, body: Record<string, unknown>): StoreOrder | null {
  const { reference, productId, state, kind, subject } = body
  if (
    typeof reference !== 'string' ||
    !REFERENCE.test(reference) ||
    !isProductId(productId) ||
    (state !== 'held' && state !== 'paid') ||
    (kind !== 'name' && kind !== 'tier') ||
    typeof subject !== 'string'
  ) {
    return null
  }
  const storeReference = store === 'apple' ? body.appAccountToken : body.obfuscatedProfileId
  // The reference handed to the store is the order's own, or the purchase could never be matched
  // back to the order.
  if (storeReference !== reference) {
    return null
  }
  if (store === 'apple') {
    return { reference, productId, state, kind, subject, storeReference, accountId: null }
  }
  const accountId = body.obfuscatedAccountId
  // Google blocks a purchase whose obfuscated identifiers exceed 64 characters.
  if (typeof accountId !== 'string' || accountId === '' || accountId.length > 64) {
    return null
  }
  return { reference, productId, state, kind, subject, storeReference, accountId }
}

// One attempt, with no wait, since a person is at the button and the screen offers to try again.
export async function openStoreOrder(
  deps: StoreGatewayDeps,
  store: Store,
  kind: StoreKind,
  subject: string,
): Promise<OrderResult> {
  // Refused here as the gateway refuses it: a wallet that asked for its data to be deleted opens no
  // order until it asks for its address back, so no store sheet takes money for a key the gateway
  // would never deliver to. An address given up here has its own code, whose words point at the way
  // back.
  const stop = await deletionRefusal({ pubkey: deps.pubkey })
  if (stop) {
    return { kind: 'refused', status: 409, code: stop }
  }
  let reply: Reply
  try {
    const timestamp = nowSecs(deps)
    const signature = await deps.sign(storeOrderMessage(deps.domain, deps.pubkey, store, kind, subject, timestamp))
    reply = await post(deps, '/api/store/order', {
      host: deps.domain,
      store,
      kind,
      subject,
      pubkey: deps.pubkey,
      signature,
      timestamp,
    })
  } catch {
    return { kind: 'retry' }
  }
  if (reply.kind !== 'json') {
    return { kind: 'retry' }
  }
  if (reply.status === 200) {
    const order = readOrder(store, reply.body)
    return order ? { kind: 'order', order } : { kind: 'retry' }
  }
  const code = errorOf(reply)
  if (code && reply.status >= 400 && reply.status < 500) {
    const retryAt = retryAtOf(reply.body)
    return { kind: 'refused', status: reply.status, code, ...(retryAt === undefined ? {} : { retryAt }) }
  }
  return { kind: 'retry' }
}

export type ConfirmVerdict =
  // Delivered, by the gateway's answer naming this purchase's reference.
  | { kind: 'delivered'; body: Record<string, unknown> }
  // Refused for good. Apple has no refund the developer can give, so Apple finishes these; Google
  // refunds an unconsumed purchase on the third day.
  | { kind: 'refused'; status: number; code: string }
  // A refusal only a defect in the app, the store's setup or the gateway produces. Left unfinished,
  // a fixed build delivers it through the recovery.
  | { kind: 'support'; code: string }
  // A reference the gateway never issued to this wallet.
  | { kind: 'unknownOrder' }
  // The store says the purchase is still pending.
  | { kind: 'pending' }
  // The store has not confirmed the purchase as paid.
  | { kind: 'notVerified'; code: string }
  // Every other answer, such as a 429, a second 401, a 400, a 404, any 5xx, a body that is not the
  // gateway's or a code this build does not know. Asked again on a later open, with a growing wait.
  | { kind: 'later'; status: number | null; code: string | null }
  // The gateway's 503 or a network failure that outlasted the retries of this session.
  | { kind: 'retry' }

// The gateway's final refusals, by status and code. A status alone never finishes a purchase: the
// edge answers 403 and 5xx of its own, and a code this list lacks may be a defect a later build fixes.
export const FINAL_REFUSALS: ReadonlySet<string> = new Set([
  '409 refunded',
  '409 order_already_delivered',
  '409 domain_held_by_another_wallet',
  '409 product_mismatch',
  '409 refused',
  '403 environment_not_allowed',
  '403 xcode_environment',
])

// Refusals that compare what the store holds with what the order sold. The app sends the
// purchase's own reference and the order's own product, so only a defect makes these.
export const DEFECT_REFUSALS: ReadonlySet<string> = new Set([
  'store_mismatch',
  'no_app_account_token',
  'wrong_app_account_token',
  'purchase_of_another_order',
  'wrong_bundle',
  'wrong_product',
  'not_consumable',
  'wrong_quantity',
  'no_profile_id',
  'wrong_profile_id',
  'no_account_id',
  'wrong_account_id',
])

function confirmVerdict(reply: Reply, reference: string): ConfirmVerdict {
  if (reply.kind === 'network') {
    return { kind: 'retry' }
  }
  if (reply.kind === 'notJson') {
    return { kind: 'later', status: reply.status, code: null }
  }
  const { status, body } = reply
  if (status === 200) {
    return body.state === 'delivered' && body.reference === reference
      ? { kind: 'delivered', body }
      : { kind: 'later', status, code: null }
  }
  if (status === 503) {
    return { kind: 'retry' }
  }
  const code = errorOf(reply)
  if (code === null) {
    return { kind: 'later', status, code: null }
  }
  if (FINAL_REFUSALS.has(`${status} ${code}`)) {
    return { kind: 'refused', status, code }
  }
  if (status === 409 && DEFECT_REFUSALS.has(code)) {
    return { kind: 'support', code }
  }
  if (status === 409 && code === 'unknown_order') {
    return { kind: 'unknownOrder' }
  }
  if (status === 402 && code === 'purchase_pending') {
    return { kind: 'pending' }
  }
  if (status === 402 && (code === 'purchase_not_found' || code === 'not_paid')) {
    return { kind: 'notVerified', code }
  }
  return { kind: 'later', status, code }
}

// Asks the gateway to deliver a purchase. The reference sent is the one the store handed back inside
// the purchase, never one remembered by the app, and the Apple JWS never travels: the gateway asks
// the App Store for the transaction by its id.
export async function confirmStorePurchase(
  deps: StoreGatewayDeps,
  purchase: StorePurchase & { reference: string },
): Promise<ConfirmVerdict> {
  const { store, reference, key } = purchase
  const reply = await sendSigned(deps, '/api/store/confirm', timestamp => ({
    message: storeConfirmMessage(deps.domain, deps.pubkey, store, reference, key, timestamp),
    body:
      store === 'apple'
        ? { host: deps.domain, store, reference, transactionId: key }
        : { host: deps.domain, store, reference, purchaseToken: key },
  }))
  return confirmVerdict(reply, reference)
}

export type StoreCredit = {
  // The gateway's name for the credit, the SHA-256 of its payment reference, which stays the same on
  // every read and through every state.
  id: string
  domain: string
  tier: string
  // available, reserved, spent or annulled as the gateway writes them.
  state: string
  name: string | null
  grantedAt: number
  // Set while a withdrawal of the credit's purchase is open ('withdrawal'), when the gateway spends
  // the credit on nothing. Absent otherwise and from a gateway that does not send it.
  held?: string
}

// A row without its id is one this build cannot follow, since telling a register that landed from an
// earlier spend on the same name rests on it.
function readCredit(row: unknown): StoreCredit | null {
  const c = row as Record<string, unknown> | null
  if (
    typeof c?.id !== 'string' ||
    c.id === '' ||
    typeof c.domain !== 'string' ||
    typeof c.tier !== 'string' ||
    typeof c.state !== 'string' ||
    (c.name !== null && typeof c.name !== 'string') ||
    typeof c.grantedAt !== 'number'
  ) {
    return null
  }
  const read: StoreCredit = { id: c.id, domain: c.domain, tier: c.tier, state: c.state, name: c.name, grantedAt: c.grantedAt }
  return typeof c.held === 'string' && c.held !== '' ? { ...read, held: c.held } : read
}

// The wallet's credits on every domain, which no store shows a reinstalled app. Null whenever the
// answer is not the gateway's list, so a failure never reads as owning nothing.
export async function storeCredits(deps: StoreGatewayDeps): Promise<StoreCredit[] | null> {
  const reply = await sendSigned(deps, '/api/store/credits', timestamp => ({
    message: storeCreditsMessage(deps.pubkey, timestamp),
    body: {},
  }))
  if (reply.kind !== 'json' || reply.status !== 200 || !Array.isArray(reply.body.credits)) {
    return null
  }
  const credits = reply.body.credits.map(readCredit)
  return credits.every((c): c is StoreCredit => c !== null) ? credits : null
}

export type SpendResult =
  // Recorded for this name, good until `expiresAt` in Unix seconds, for the register that follows.
  | { kind: 'recorded'; expiresAt: number }
  | { kind: 'refused'; status: number; code: string }
  // The gateway decided nothing, as with its own 503, a network failure, an answer not its own or a
  // refusal this build does not know.
  | { kind: 'retry' }

// The spend route's own refusals and the edge limit in front of every route. A code outside this list
// is no refusal this build can explain, so it is a retry and never shown. A deleted wallet's key is
// refused for good, as the order route refuses it, and post() has already noted the deletion.
const SPEND_REFUSALS: ReadonlySet<string> = new Set([
  '409 deleted',
  '400 missing_fields',
  '400 invalid_pubkey',
  '400 malformed username',
  '401 invalid_signature',
  '429 too many requests',
])

// Records the wallet's intent to spend a credit on `username` at deps.domain, which the register guard
// requires before it reserves one. One attempt with no wait, since a person is at the button and the
// screen offers to try again.
export async function recordSpendIntent(deps: StoreGatewayDeps, username: string): Promise<SpendResult> {
  const stop = await deletionRefusal({ pubkey: deps.pubkey })
  if (stop) {
    return { kind: 'refused', status: 409, code: stop }
  }
  let reply: Reply
  try {
    const timestamp = nowSecs(deps)
    const signature = await deps.sign(storeSpendMessage(deps.domain, deps.pubkey, username, timestamp))
    reply = await post(deps, '/api/store/spend', { host: deps.domain, username, pubkey: deps.pubkey, signature, timestamp })
  } catch {
    return { kind: 'retry' }
  }
  if (reply.kind !== 'json') {
    return { kind: 'retry' }
  }
  const { status, body } = reply
  // Only an answer about this exact name is the intent the register will look for.
  if (status === 200) {
    return body.recorded === true && body.username === username && typeof body.expiresAt === 'number'
      ? { kind: 'recorded', expiresAt: body.expiresAt }
      : { kind: 'retry' }
  }
  const code = errorOf(reply)
  return code !== null && SPEND_REFUSALS.has(`${status} ${code}`) ? { kind: 'refused', status, code } : { kind: 'retry' }
}

// No route delivers a purchase from the store's own notice yet, so delivery depends on an app
// sending the confirmation. A purchase the gateway does not know for this wallet may be another
// device's, the one that holds the wallet it was bought for, and finishing it here would drop the
// copy the store hands that device. While this is false an unknown order is never finished.
export const STORE_NOTICE_DELIVERY = false

// An unknown order is finished only once delivery no longer needs the app, the order was opened on
// this device, and every wallet here has heard the gateway does not know it.
export function unknownOrderFinishes(
  noticeDelivery: boolean,
  openedHere: boolean,
  refusedBy: readonly string[],
  wallets: readonly string[],
): boolean {
  return noticeDelivery && openedHere && wallets.length > 0 && wallets.every(id => refusedBy.includes(id))
}

// The wait before asking again after an answer that decided nothing, doubling from a minute to six
// hours, so a purchase the gateway cannot place does not spend its rate window on every open.
export const LATER_FIRST_MS = 60_000
export const LATER_CEILING_MS = 6 * 60 * 60_000

export function laterWait(attempts: number): number {
  return Math.min(LATER_FIRST_MS * 2 ** Math.max(0, attempts - 1), LATER_CEILING_MS)
}

// Which wallet opened each order, what the store last answered a purchase for it, when a purchase
// may be asked about again, and which wallets the gateway told it does not know an order. Nothing in
// it is secret and none of it is the source of truth, which is the gateway's: a lost file only costs
// trying the connected wallet.
//
// So a book that cannot be read is read by the screens as empty, as a lost one is, and is never
// refused: settleOnce writes it on every confirmation and the deletion cleanup forgets rows in it,
// and a refusal would stop both for good. It is set aside on the first write instead
// (store-orders.json.unreadable), never written over nor deleted, so what it held stays on the device
// for support, and Support reads it as unread while it is there (storeBookEvidence). The one payment
// fact only the book holds, an Ask to Buy still pending on Apple, goes with it, and the store's sheet
// can open again for that order (docs/store-bridge.md).
const BOOK = `${RNFS.DocumentDirectoryPath}/store-orders.json`

type Wait = { attempts: number; nextAt: number }
// What an order sells, so a screen opened again finds it. `place` is the domain a name is bought on,
// or the host a year is bought for, and `renewal` marks a year bought from the renewal.
type About = { kind: StoreKind; place: string; subject: string; renewal?: boolean }

// A year as the gateway's delivery names it.
export type DeliveredYear = { host: string; expiresAt: number | null; frozen: boolean }

export function deliveredYearOf(boughtFor: string, body: Record<string, unknown>): DeliveredYear {
  return {
    host: typeof body.host === 'string' ? body.host : boughtFor,
    expiresAt: typeof body.expiresAt === 'number' ? body.expiresAt : null,
    frozen: body.frozen === true,
  }
}

// What a screen showed when an order's answer arrived, kept beside the order so the screen shows it
// again after a close or a restart. A name's delivery is a credit, which the gateway's own list keeps,
// so only a year's is written here.
export type StoreOutcome =
  // `key` is the store's id of a purchase that came back without the order's reference.
  | { kind: 'support'; code: string; key?: string }
  // `refusal` is the gateway's status and code.
  | { kind: 'refused'; refusal: string }
  | ({ kind: 'delivered' } & DeliveredYear)

// A name whose fate a failed read of the credits left open, which its sheet shows as the check until
// a read of the list answers (docs/store-bridge.md). `register` is a register whose answer was lost,
// `pending` a name the gateway called pending, `delivered` a credit the gateway delivered for it, and
// `settled` a purchase the store let go of while the sheet waited on it.
export type NameCheck = {
  domain: string
  name: string
  after: 'register' | 'pending' | 'delivered' | 'settled'
  // The credits the register could spend, read before it was sent.
  attempt: string[]
}

type Book = {
  orders: Record<string, string>
  // Only the answers after which the store holds or may still take money for the order.
  bought: Record<string, 'pending' | 'purchased'>
  waits: Record<string, Wait>
  unknown: Record<string, string[]>
  about: Record<string, About>
  outcomes: Record<string, StoreOutcome>
  // Keyed by wallet, domain and name, so a reopened sheet finds what it was checking.
  checks: Record<string, NameCheck & { wallet: string }>
}

const emptyBook = (): Book => ({ orders: {}, bought: {}, waits: {}, unknown: {}, about: {}, outcomes: {}, checks: {} })

function isMap(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record<T>(value: unknown): Record<string, T> {
  return isMap(value) ? (value as Record<string, T>) : {}
}

// Each field read as a map whatever it holds, so a book a later build wrote with a field of another
// shape still reads.
function bookOf(value: unknown): Book {
  const raw = record<unknown>(value)
  return {
    orders: record(raw.orders),
    bought: record(raw.bought),
    waits: record(raw.waits),
    unknown: record(raw.unknown),
    about: record(raw.about),
    outcomes: record(raw.outcomes),
    checks: record(raw.checks),
  }
}

// Every read and every change of the book runs in one turn of this queue. Purchases are settled
// concurrently and each change reads the book before writing it, and a read whose calls interleave
// with a write's can find the book already unlinked and then its copy already moved, and answer an
// empty book (durableFile.ts). Nothing inside a turn calls a queued reader of this module.
const serial = serialQueue()

// A cut first write of the book reads as no book (durableFile.ts, FirstWriteCut). Each change starts
// from an empty book then, and what a change adds to one is acted on only once the write resolved (the
// opener note buyInStore writes before the store's sheet opens), or is a fact the store or the gateway
// keeps and answers again: a purchase the store lists until the gateway delivers, an answer of the
// gateway that the next confirmation asks for again, a name check the credits list settles. The one
// fact only the book holds, an Ask to Buy still pending on Apple, is noted after the opener note, so
// its write is the first only when that note failed to write; the screens read an unreadable book as
// empty too, so they treat the lost note the same either way (docs/store-bridge.md).
const FIRST_WRITE_CUT = 'nothing'

// Throws UnreadableFile when the book, or a finished write's copy beside it, cannot be read.
async function readBookStrict(): Promise<Book> {
  const raw = await readDurable(BOOK, isMap, FIRST_WRITE_CUT)
  return raw === null ? emptyBook() : bookOf(raw)
}

// The screens' read: a book that cannot be read is an empty one, as a lost one is.
function readBook(): Promise<Book> {
  return serial(() => readBookStrict().catch(() => emptyBook()))
}

// A change that answers false changed nothing, and the file is left as it is. Over a book that cannot
// be read the change is applied to an empty book, and the book is set aside before that is written.
function updateBook(change: (book: Book) => void | false): Promise<void> {
  return serial(async () => {
    let book: Book
    let unreadable = false
    try {
      book = await readBookStrict()
    } catch (err) {
      if (!isUnreadableFile(err)) {
        throw err
      }
      book = emptyBook()
      unreadable = true
    }
    if (change(book) === false) {
      return
    }
    if (unreadable) {
      await setAside(BOOK)
    }
    await writeDurable(BOOK, JSON.stringify(book), isMap, 'refuse', FIRST_WRITE_CUT)
  })
}

function forget(book: Book, reference: string): void {
  delete book.orders[reference]
  delete book.bought[reference]
  delete book.unknown[reference]
  delete book.about[reference]
  delete book.outcomes[reference]
  for (const key of Object.keys(book.waits)) {
    if (key.endsWith(`:${reference}`)) {
      delete book.waits[key]
    }
  }
}

// Keeps an outcome for an order a screen can still show, one opened here and not yet closed by the
// person, so a later answer about an order no screen shows is not written back.
function remember(book: Book, reference: string, outcome: StoreOutcome): void {
  if (book.about[reference]) {
    book.outcomes[reference] = outcome
  }
}

// Settles an order for good. Nothing is asked about it again, and what its screen showed is kept
// until that screen's own rule ends it; without such an outcome the order is forgotten.
function conclude(book: Book, reference: string, outcome: StoreOutcome | null): void {
  if (!outcome || !book.about[reference]) {
    forget(book, reference)
    return
  }
  const opener = book.orders[reference]
  const sells = book.about[reference]
  forget(book, reference)
  if (opener !== undefined) {
    book.orders[reference] = opener
  }
  book.about[reference] = sells
  book.outcomes[reference] = outcome
}

// A support case kept for an order whose purchase the store no longer lists stops standing once the
// store holds a purchase for that order again, which is the wait a screen shows from then on.
function dropSupport(book: Book, reference: string): void {
  if (book.outcomes[reference]?.kind === 'support') {
    delete book.outcomes[reference]
  }
}

/**
 * The references the book keeps for money the store may hold, for Support: an order the store was
 * paid for or asked to charge, an order whose answer needs a person or was a refusal, and the store
 * key of a purchase that came back with no reference. `unread` when the book cannot be read or one was
 * set aside, since what it held is then not known.
 */
export function storeBookEvidence(): Promise<{ references: string[]; unread: boolean }> {
  return serial(async () => {
    const unread = await asideExists(BOOK)
    const book = await readBookStrict().catch(() => null)
    if (book === null) {
      return { references: [], unread: true }
    }
    const references = Object.keys(book.bought)
    for (const [reference, outcome] of Object.entries(book.outcomes)) {
      if (outcome?.kind === 'support' || outcome?.kind === 'refused') {
        references.push(reference)
        if (outcome.kind === 'support' && typeof outcome.key === 'string') {
          references.push(outcome.key)
        }
      }
    }
    return { references: [...new Set(references)], unread }
  })
}

function postpone(book: Book, key: string, now: number): void {
  const attempts = (book.waits[key]?.attempts ?? 0) + 1
  book.waits[key] = { attempts, nextAt: now + laterWait(attempts) }
}

// Drops what the book keeps about this wallet once the gateway said its data is gone: the orders it
// opened, its name checks and its place in the lists of wallets an order was unknown to. Whatever
// another wallet opened or checks is written back as it was.
//
// The opener of an order goes with no tombstone left. That is safe because a deletion never reaches
// an order the gateway still counts as open: its store_order_open blocker refuses the request until
// the order is paid, recorded or past its window.
export function forgetWalletOrders(walletId: string): Promise<void> {
  return updateBook(book => {
    let changed = false
    for (const [reference, opener] of Object.entries(book.orders)) {
      if (opener === walletId) {
        forget(book, reference)
        changed = true
      }
    }
    for (const [reference, wallets] of Object.entries(book.unknown)) {
      if (Array.isArray(wallets) && wallets.includes(walletId)) {
        const left = wallets.filter(wallet => wallet !== walletId)
        if (left.length > 0) {
          book.unknown[reference] = left
        } else {
          delete book.unknown[reference]
        }
        changed = true
      }
    }
    for (const [key, check] of Object.entries(book.checks)) {
      if (check?.wallet === walletId) {
        delete book.checks[key]
        changed = true
      }
    }
    return changed ? undefined : false
  })
}

export type SettleResult =
  | ConfirmVerdict
  // A purchase that names no order, made outside the app or through a promotion. Nothing tells the
  // gateway whose it is, so it is never confirmed and stays unfinished for support to place.
  | { kind: 'noReference' }
  | { kind: 'waiting'; why: 'inFlight' | 'otherWallet' | 'noWallet' | 'backoff' }

export type StoreContext = {
  // The wallet the SDK is connected as, which is the one that can sign; null when none is.
  walletId(): string | null
  gateway(): Promise<StoreGatewayDeps>
  // Every wallet on this device.
  wallets(): Promise<string[]>
  now?: () => number
}

export function liveStoreContext(): StoreContext {
  return {
    walletId: sparkConnectedWalletId,
    gateway: currentDeps,
    wallets: async () => (await loadRegistry()).wallets.map(w => w.id),
  }
}

// Verdicts that decided nothing final and are asked about again after a wait. A Play purchase
// refused for good stays on the store's list until Google refunds it, so it waits too.
const POSTPONED: ReadonlySet<SettleResult['kind']> = new Set(['later', 'notVerified', 'support', 'unknownOrder', 'refused'])

async function finishQuietly(purchase: StorePurchase): Promise<void> {
  try {
    await finish(purchase)
  } catch (err) {
    // Left unfinished, the transaction comes back on the next open and the gateway answers the same.
    console.warn(`store finish failed: ${(err as Error)?.message ?? String(err)}`)
  }
}

// The same purchase reaches the app up to three times (the purchase itself, the store's update
// stream and its list of open purchases), and only the first of them in flight is confirmed.
const inFlight = new Set<string>()

// The orders the gateway answered delivered or refused for good, each with its place in the order of
// those answers, so a purchase in progress can tell an order settled while it was out.
const concluded = new Map<string, number>()
let conclusions = 0

// The latest settle of each order, by reference, kept for the session as `concluded` is. Each ends once
// the book holds its answer and the screens heard it.
const settling = new Map<string, Promise<SettleResult>>()

// A purchase approved by Ask to Buy, or paid slowly, is settled by the root's sync while a screen
// waits on it, so the screen hears the answer here rather than asking the store again.
const settledListeners = new Set<(reference: string, result: SettleResult) => void>()

export function onStoreSettled(cb: (reference: string, result: SettleResult) => void): () => void {
  settledListeners.add(cb)
  return () => {
    settledListeners.delete(cb)
  }
}

export async function settleStorePurchase(purchase: StorePurchase, ctx: StoreContext): Promise<SettleResult> {
  const { reference } = purchase
  if (!reference) {
    return { kind: 'noReference' }
  }
  if (purchase.state === 'pending') {
    return { kind: 'pending' }
  }
  const key = `${purchase.store}:${purchase.key}`
  if (inFlight.has(key)) {
    return { kind: 'waiting', why: 'inFlight' }
  }
  inFlight.add(key)
  const run = settleAndTell({ ...purchase, reference }, ctx, key)
  settling.set(reference, run)
  return run
}

async function settleAndTell(purchase: StorePurchase & { reference: string }, ctx: StoreContext, key: string): Promise<SettleResult> {
  let result: SettleResult
  try {
    result = await settleOnce(purchase, ctx)
  } catch (err) {
    console.warn(`store purchase left for the next open: ${(err as Error)?.message ?? String(err)}`)
    result = { kind: 'retry' }
  } finally {
    inFlight.delete(key)
  }
  settledListeners.forEach(cb => cb(purchase.reference, result))
  return result
}

// What settleOnce writes once the gateway answered. The answer is the gateway's, and Apple's purchase
// may already be finished on it, so a book that cannot be written loses only its note of the answer,
// which the screens read as a lost book, and the answer still reaches them rather than a retry.
async function noteVerdict(change: (book: Book) => void | false): Promise<void> {
  await updateBook(change).catch((err: unknown) => {
    console.warn(`store book note lost: ${(err as Error)?.message ?? String(err)}`)
  })
}

async function settleOnce(purchase: StorePurchase & { reference: string }, ctx: StoreContext): Promise<SettleResult> {
  const wallet = ctx.walletId()
  if (!wallet) {
    return { kind: 'waiting', why: 'noWallet' }
  }
  const { reference } = purchase
  const book = await readBook()
  const wallets = await ctx.wallets()
  const opener = book.orders[reference]
  // A removed wallet never connects again, and adding its words back gives it a new id, so a note
  // naming a wallet no longer on this device says nothing about who can sign.
  const owner = opener !== undefined && wallets.includes(opener) ? opener : undefined
  const refusedBy = book.unknown[reference] ?? []
  // Only the wallet that opened the order signs for it, and switching wallets does not reconnect the
  // SDK, so another wallet's purchase waits until that wallet connects. Once the gateway told that
  // wallet it does not know the order, the note no longer says whose it is, and any wallet may ask.
  if (owner !== undefined && owner !== wallet && !refusedBy.includes(owner)) {
    return { kind: 'waiting', why: 'otherWallet' }
  }
  const now = (ctx.now ?? Date.now)()
  const waitKey = `${wallet}:${reference}`
  if ((book.waits[waitKey]?.nextAt ?? 0) > now) {
    return { kind: 'waiting', why: 'backoff' }
  }
  const deps = await ctx.gateway()
  // The identity is read after the owner check, and a reconnect in between makes it another wallet's.
  if (ctx.walletId() !== wallet) {
    return { kind: 'retry' }
  }
  const verdict = await confirmStorePurchase(deps, purchase)
  if (verdict.kind === 'unknownOrder') {
    const refused = refusedBy.includes(wallet) ? refusedBy : [...refusedBy, wallet]
    if (unknownOrderFinishes(STORE_NOTICE_DELIVERY, opener !== undefined, refused, wallets)) {
      await finishQuietly(purchase)
      await noteVerdict(b => forget(b, reference))
      return verdict
    }
    await noteVerdict(b => {
      b.unknown[reference] = refused
      postpone(b, waitKey, now)
      remember(b, reference, { kind: 'support', code: 'unknown_order' })
    })
    return verdict
  }
  // Only a delivery or a refusal the gateway gives as final finishes, and finish reaches only Apple.
  if (verdict.kind === 'delivered' || verdict.kind === 'refused') {
    concluded.set(reference, ++conclusions)
    await finishQuietly(purchase)
  }
  if (verdict.kind === 'delivered') {
    await noteVerdict(b => conclude(b, reference, yearOutcome(b.about[reference], verdict.body)))
  } else if (verdict.kind === 'refused' && purchase.store === 'apple') {
    await noteVerdict(b => conclude(b, reference, { kind: 'refused', refusal: `${verdict.status} ${verdict.code}` }))
  } else if (POSTPONED.has(verdict.kind)) {
    await noteVerdict(b => {
      postpone(b, waitKey, now)
      if (verdict.kind === 'refused') {
        // A final refusal on Google waits for Google's own refund, and no screen waits on it.
        delete b.bought[reference]
        remember(b, reference, { kind: 'refused', refusal: `${verdict.status} ${verdict.code}` })
      } else if (verdict.kind === 'support') {
        remember(b, reference, { kind: 'support', code: verdict.code })
      }
    })
  }
  return verdict
}

// A delivered year with the end date the gateway always sends, which is what its screen states again.
function yearOutcome(about: About | undefined, body: Record<string, unknown>): StoreOutcome | null {
  if (about?.kind !== 'tier') {
    return null
  }
  const year = deliveredYearOf(about.subject, body)
  return year.expiresAt === null ? null : { kind: 'delivered', ...year }
}

// Every purchase the store still holds open, confirmed one at a time, since each confirmation spends
// the gateway's rate window. Runs when the app opens, returns to the foreground and connects a
// wallet, which together recover what a killed app or a lost answer left behind.
export async function syncStorePurchases(ctx: StoreContext): Promise<SettleResult[]> {
  if (!storeAvailable()) {
    return []
  }
  let open: StorePurchase[]
  try {
    open = await openPurchases()
  } catch {
    return []
  }
  const results: SettleResult[] = []
  for (const purchase of open) {
    results.push(await settleStorePurchase(purchase, ctx))
  }
  return results
}

// Listens for the store's updates and recovers open purchases from the moment the app is up. Apple
// hands an unfinished transaction to Transaction.updates once, so the listener belongs at the root.
export function startStoreSync(ctx: StoreContext = liveStoreContext()): () => void {
  if (!storeAvailable()) {
    return () => undefined
  }
  const offUpdates = onPurchaseUpdate(purchase => {
    settleStorePurchase(purchase, ctx).catch(() => undefined)
  })
  // Runs at once when a wallet is already connected, and whenever one connects, which is when a
  // purchase another wallet opened can be signed for.
  const offConnected = onSparkConnected(() => {
    syncStorePurchases(ctx).catch(() => undefined)
  })
  const foreground = AppState.addEventListener('change', state => {
    if (state === 'active') {
      syncStorePurchases(ctx).catch(() => undefined)
    }
  })
  return () => {
    offUpdates()
    offConnected()
    foreground.remove()
  }
}

// Every outcome after the order opened names its reference, which support needs to find the purchase.
export type StoreBuyOutcome =
  | { kind: 'unavailable' }
  // The store's age signal says the person is under 18 (ageSignal.ts). No order opened.
  | { kind: 'adultsOnly' }
  | { kind: 'orderRefused'; status: number; code: string; retryAt?: number }
  | { kind: 'orderRetry' }
  // The store's own outcome, cancelled included. A cancelled order lapses on its own.
  | { kind: 'failed'; code: StoreErrorCode }
  | { kind: 'pending'; reference: string }
  // The store was already paid for this order and no purchase open here carries it.
  | { kind: 'paidElsewhere'; reference: string }
  // The root's sync settled the order after the gateway handed it out, so the store never opened. It is
  // answered once that settle wrote the book, and the screen shows what the sync settled, as the book
  // keeps it.
  | { kind: 'settledMeanwhile'; reference: string }
  | { kind: 'settled'; reference: string; result: SettleResult }

// `renewal` marks a year bought from the renewal, whose delivered year the first-year form leaves to
// the renewal. `wanted` is asked before each step that leaves the device, the order, the store's list,
// the confirmation of a purchase it lists and the store's sheet, so a screen closed behind its press
// goes no further and ends as a cancel, whose order's hold lapses on its own. What follows the store's
// sheet runs whatever `wanted` says, since the money already left.
export async function buyInStore(
  kind: StoreKind,
  subject: string,
  ctx: StoreContext = liveStoreContext(),
  renewal = false,
  wanted: () => boolean = () => true,
): Promise<StoreBuyOutcome> {
  const wallet = ctx.walletId()
  if (!storeAvailable() || !wallet) {
    return { kind: 'unavailable' }
  }
  if (await minorBySignal()) {
    return { kind: 'adultsOnly' }
  }
  const since = conclusions
  let deps: StoreGatewayDeps
  try {
    deps = await ctx.gateway()
  } catch {
    return { kind: 'orderRetry' }
  }
  // The book notes the order under `wallet`, so the identity that opens it has to be that wallet's.
  if (ctx.walletId() !== wallet) {
    return { kind: 'orderRetry' }
  }
  if (!wanted()) {
    return { kind: 'failed', code: 'cancelled' }
  }
  const opened = await openStoreOrder(deps, currentStore(), kind, subject)
  if (opened.kind === 'refused') {
    const { status, code, retryAt } = opened
    return { kind: 'orderRefused', status, code, ...(retryAt === undefined ? {} : { retryAt }) }
  }
  if (opened.kind === 'retry') {
    return { kind: 'orderRetry' }
  }
  const { order } = opened
  // Written before the store opens, so a purchase that comes back after a wallet switch or a restart
  // is confirmed by the wallet that opened it. A note that fails to write only costs trying the
  // connected wallet. An order handed back keeps what the book already holds for it, since the gateway
  // keys a year by its host alone and the renewal and the first-year form reach the same order, whose
  // delivered year the screen that opened it still places.
  await updateBook(b => {
    b.orders[order.reference] = wallet
    if (!b.about[order.reference]) {
      b.about[order.reference] = {
        kind,
        place: kind === 'name' ? deps.domain : order.subject,
        subject: order.subject,
        ...(kind === 'tier' ? { renewal } : {}),
      }
    }
  }).catch(() => undefined)
  // An order handed back may already have a purchase in the store, paid, pending or never confirmed,
  // and opening the store again for the same reference would charge twice. A list that cannot be
  // read is not an empty one.
  if (!wanted()) {
    return { kind: 'failed', code: 'cancelled' }
  }
  let open: StorePurchase[]
  try {
    open = await openPurchases()
  } catch (err) {
    return { kind: 'failed', code: err instanceof StoreError ? err.code : 'unknown' }
  }
  const existing = open.find(p => p.reference === order.reference)
  if (existing) {
    // The store holds the purchase, so the order waits on it as on one this tap made, and a reopen
    // shows that wait again. A settle that ends the order clears the note with the rest.
    await updateBook(b => {
      b.bought[order.reference] = existing.state
      dropSupport(b, order.reference)
    }).catch(() => undefined)
    // The note above keeps the order's wait for the next open, and the root's sync confirms the
    // purchase in place of this press.
    if (!wanted()) {
      return { kind: 'failed', code: 'cancelled' }
    }
    return { kind: 'settled', reference: order.reference, result: await settleStorePurchase(existing, ctx) }
  }
  // The store already took the money for this order, or was asked to and may still take it. An Ask to
  // Buy still waiting on Apple is in no list but the book's, so a book that cannot be read answers a
  // retry rather than read as one without the note.
  let last: Book['bought'][string] | undefined
  try {
    last = (await serial(readBookStrict)).bought[order.reference]
  } catch {
    return { kind: 'orderRetry' }
  }
  if (order.state === 'paid' || last === 'purchased') {
    return { kind: 'paidElsewhere', reference: order.reference }
  }
  if (last === 'pending') {
    return { kind: 'pending', reference: order.reference }
  }
  // Settled by the root's sync while this purchase was out, after which the store no longer lists its
  // purchase, and opening the store would take a second payment for it. The answer waits for that
  // settle to write the book and tell the screens, so the press that reads the book next finds the
  // order settled, and the screen never gives its purchase press back in between.
  if ((concluded.get(order.reference) ?? 0) > since) {
    await settling.get(order.reference)?.catch(() => undefined)
    return { kind: 'settledMeanwhile', reference: order.reference }
  }
  if (!wanted()) {
    return { kind: 'failed', code: 'cancelled' }
  }
  const result = await buy(order.productId, { reference: order.storeReference, accountId: order.accountId ?? undefined })
  if (result.kind === 'pending' || result.kind === 'purchased') {
    // A note that fails to write leaves the store free to open again for this order.
    await updateBook(b => {
      b.bought[order.reference] = result.kind
      dropSupport(b, order.reference)
    }).catch(() => undefined)
  }
  if (result.kind === 'pending') {
    return { kind: 'pending', reference: order.reference }
  }
  if (result.kind === 'failed') {
    // Google refuses a product still owned, which is an earlier purchase nobody confirmed yet.
    if (result.code === 'alreadyOwned') {
      await syncStorePurchases(ctx)
    }
    return { kind: 'failed', code: result.code }
  }
  const settled = await settleStorePurchase(result.purchase, ctx)
  // A purchase that came back without the order's reference is never confirmed, so it is kept under
  // the order by the store's own id, for the screen to show while support places it.
  if (settled.kind === 'noReference') {
    const key = result.purchase.key
    await updateBook(b => remember(b, order.reference, { kind: 'support', code: 'no_reference', key })).catch(
      () => undefined,
    )
  }
  return { kind: 'settled', reference: order.reference, result: settled }
}

const samePlace = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// An order this wallet opened here and what its screen shows for it, which is the outcome the book
// kept, or the wait while the store still holds the purchase or may still take money for it.
export type StoreOrderView = {
  reference: string
  subject: string
  renewal: boolean
  outcome: StoreOutcome | { kind: 'waiting' }
}

// A purchase that needs a person comes first and one still out with the store second, ahead of a
// refusal and a delivered year, which are only told.
const RANK: Record<StoreOrderView['outcome']['kind'], number> = { support: 0, waiting: 1, refused: 2, delivered: 3 }

// What a screen opened again shows for the orders of `kind` on `place`, the domain of a name or the
// host of a year, or on any when it is null, in that order. A wait is a purchase among the store's open
// ones under the order's reference, or an Ask to Buy on Apple, which has no transaction until it is
// approved, so a screen that finds one never opens the store for a second charge. A purchase that
// needs support stays while the store still lists it, which it stops doing once the purchase is
// delivered from another device or refunded.
export function storeOrderViews(
  kind: StoreKind,
  place: string | null,
  ctx: StoreContext = liveStoreContext(),
): Promise<StoreOrderView[]> {
  return orderViews(kind, place, ctx, true)
}

// The same views from the book alone, which is on the device and answers before the store's list
// does. Every purchase the list would decide reads as still held, so what the book keeps shows at
// once and the list only takes away what the store let go (docs/store-bridge.md, I1).
export function keptOrderViews(
  kind: StoreKind,
  place: string | null,
  ctx: StoreContext = liveStoreContext(),
): Promise<StoreOrderView[]> {
  return orderViews(kind, place, ctx, false)
}

async function orderViews(kind: StoreKind, place: string | null, ctx: StoreContext, listing: boolean): Promise<StoreOrderView[]> {
  const wallet = ctx.walletId()
  if (!storeAvailable() || !wallet) {
    return []
  }
  const book = await readBook()
  const mine = Object.keys(book.about).filter(reference => {
    const about = book.about[reference]!
    return (
      book.orders[reference] === wallet &&
      about.kind === kind &&
      (place === null || samePlace(about.place, place)) &&
      (reference in book.bought || reference in book.outcomes)
    )
  })
  const needed = mine.some(r => book.outcomes[r] === undefined || book.outcomes[r]!.kind === 'support')
  // A list that cannot be read, or is not read, is not an empty one, so every purchase on it is still
  // held.
  const open = !listing ? null : needed ? await openPurchases().catch(() => null) : []
  const listed = (reference: string, key?: string): boolean =>
    open === null || open.some(p => p.reference === reference || (key !== undefined && p.key === key))
  // A paid purchase the store no longer lists was let go, as it is once the gateway finished it or the
  // store refunded it, so the note that it was paid stops standing and the next press asks the store
  // again rather than showing a wait nothing holds.
  const gone = mine.filter(r => open !== null && book.outcomes[r] === undefined && book.bought[r] === 'purchased' && !listed(r))
  // A support case ends once the store stops listing its purchase, delivered from another device or
  // refunded, so the case and the note of the purchase leave the book rather than staying there
  // unseen. What the order sells stays, as for any order left, so an order handed back keeps it.
  const ended = mine.filter(r => book.outcomes[r]?.kind === 'support' && !listed(r, book.outcomes[r]!.key))
  if (gone.length > 0 || ended.length > 0) {
    await updateBook(b => {
      gone.forEach(r => {
        if (b.bought[r] === 'purchased') {
          delete b.bought[r]
        }
      })
      ended.forEach(r => {
        if (b.outcomes[r]?.kind === 'support') {
          delete b.outcomes[r]
          delete b.bought[r]
        }
      })
    }).catch(() => undefined)
  }
  const views: StoreOrderView[] = []
  for (const reference of mine) {
    const about = book.about[reference]!
    const shown = { reference, subject: about.subject, renewal: about.renewal === true }
    const outcome = book.outcomes[reference]
    if (outcome === undefined) {
      if (listed(reference) || (book.bought[reference] === 'pending' && currentStore() === 'apple')) {
        views.push({ ...shown, outcome: { kind: 'waiting' } })
      }
    } else if (outcome.kind !== 'support' || listed(reference, outcome.key)) {
      views.push({ ...shown, outcome })
    }
  }
  return views.sort((a, b) => RANK[a.outcome.kind] - RANK[b.outcome.kind])
}

// Leaves the wait for a purchase still out with the store, whatever it last answered. Apple never
// reports a parent declining or letting an Ask to Buy lapse, and a paid purchase the gateway has not
// confirmed is still confirmed by the sync. The next Buy opens the store, and a request approved
// later is a second purchase, which the person chose.
export async function dropStoreWait(reference: string): Promise<void> {
  await updateBook(b => {
    delete b.bought[reference]
  })
}

const CHECKS: ReadonlySet<string> = new Set(['register', 'pending', 'delivered', 'settled'])

function checkKey(wallet: string, domain: string, name: string): string {
  return `${wallet} ${domain.toLowerCase()} ${name.toLowerCase()}`
}

// Keeps a name the connected wallet's sheet shows as the check, which replaces an earlier one for the
// same name.
export async function keepNameCheck(check: NameCheck, ctx: StoreContext = liveStoreContext()): Promise<void> {
  const wallet = ctx.walletId()
  if (!wallet) {
    return
  }
  await updateBook(b => {
    b.checks[checkKey(wallet, check.domain, check.name)] = { ...check, wallet }
  })
}

// The checks the connected wallet's sheet on `domain` keeps. A record this build cannot read is left
// out rather than shown wrong.
export async function nameChecks(domain: string, ctx: StoreContext = liveStoreContext()): Promise<NameCheck[]> {
  const wallet = ctx.walletId()
  if (!wallet) {
    return []
  }
  return Object.values((await readBook()).checks).flatMap(c =>
    c?.wallet === wallet &&
    typeof c.domain === 'string' &&
    samePlace(c.domain, domain) &&
    typeof c.name === 'string' &&
    CHECKS.has(c.after) &&
    Array.isArray(c.attempt) &&
    c.attempt.every(id => typeof id === 'string')
      ? [{ domain: c.domain, name: c.name, after: c.after, attempt: c.attempt }]
      : [],
  )
}

// Ends every check of the connected wallet on `domain`, which a list of the credits that answers
// settles, since the screen reads what became of each name from it.
export async function endNameChecks(domain: string, ctx: StoreContext = liveStoreContext()): Promise<void> {
  const wallet = ctx.walletId()
  if (!wallet) {
    return
  }
  await updateBook(b => {
    const ended = Object.keys(b.checks).filter(key => {
      const c = b.checks[key]
      return c?.wallet === wallet && typeof c.domain === 'string' && samePlace(c.domain, domain)
    })
    if (ended.length === 0) {
      return false
    }
    ended.forEach(key => delete b.checks[key])
  })
}

// Ends a refusal or a delivered year the person has read. The wallet that opened the order is kept,
// since a Play purchase refused for good is still asked about until Google refunds it, and with what
// the order sells gone that answer is not written back.
export async function dismissStoreOutcome(reference: string): Promise<void> {
  await updateBook(b => {
    delete b.outcomes[reference]
    delete b.about[reference]
    delete b.bought[reference]
  })
}
