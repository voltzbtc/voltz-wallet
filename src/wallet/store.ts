import { Platform } from 'react-native'
import NativeVoltzStore, {
  type NativeBuyResult,
  type NativePurchase,
  type NativeUpdate,
} from '../../specs/NativeVoltzStore'
import { asOwnActivity } from './relock'

// The one module that talks to the store bridge, as spark.ts is for the SDK. The native side relays
// the store raw; the stable error codes, the reference's form and which store callback answers a
// purchase in flight are decided here, where Jest and Stryker reach them.

export type ProductId =
  | 'name_long'
  | 'name_standard'
  | 'name_five'
  | 'name_four'
  | 'name_short'
  | 'domain_year'

export const PRODUCT_IDS: readonly ProductId[] = [
  'name_long',
  'name_standard',
  'name_five',
  'name_four',
  'name_short',
  'domain_year',
]

export function isProductId(value: unknown): value is ProductId {
  return PRODUCT_IDS.includes(value as ProductId)
}

export type Store = 'apple' | 'google'

export type StoreProduct = { id: ProductId; displayPrice: string }

export type StorePurchase = {
  store: Store
  productId: string
  state: 'purchased' | 'pending'
  purchasedAt: number
  // The order's reference as the store hands it back: appAccountToken on Apple, lowercased, and
  // obfuscatedProfileId on Google. Null when the purchase carries none.
  reference: string | null
  // What the gateway is asked about: the transactionId on Apple, the purchaseToken on Google.
  key: string
  verified: boolean
  revoked: boolean
}

export type StoreErrorCode =
  | 'cancelled'
  | 'alreadyOwned'
  | 'network'
  | 'storeUnavailable'
  | 'notAllowed'
  | 'declined'
  | 'notVerified'
  | 'unknown'

export type BuyResult =
  | { kind: 'purchased'; purchase: StorePurchase }
  | { kind: 'failed'; code: StoreErrorCode }
  // Ask to Buy and slow payments. Apple has no transaction until the purchase is approved.
  | { kind: 'pending'; purchase: StorePurchase | null }

// `noBilling` is set when the store says the device has no billing at all, as Play does on a device
// with no Google account, rather than that one call failed.
export class StoreError extends Error {
  constructor(
    readonly code: StoreErrorCode,
    message: string,
    readonly noBilling = false,
  ) {
    super(message)
  }
}

export function currentStore(): Store {
  return Platform.OS === 'ios' ? 'apple' : 'google'
}

export function storeAvailable(): boolean {
  return NativeVoltzStore != null
}

// Product.PurchaseResult, Product.PurchaseError and StoreKitError case names. Every other case,
// including the bridge's own refusals, is unknown.
const APPLE_CODES: Readonly<Record<string, StoreErrorCode>> = {
  userCancelled: 'cancelled',
  networkError: 'network',
  purchaseNotAllowed: 'notAllowed',
  productUnavailable: 'storeUnavailable',
  notAvailableInStorefront: 'storeUnavailable',
  systemError: 'storeUnavailable',
  unsupported: 'storeUnavailable',
}

// BillingResponseCode values, by their integer in decimal as the bridge relays them.
const GOOGLE_CODES: Readonly<Record<string, StoreErrorCode>> = {
  '1': 'cancelled', // USER_CANCELED
  '7': 'alreadyOwned', // ITEM_ALREADY_OWNED
  '12': 'network', // NETWORK_ERROR
  '2': 'network', // SERVICE_UNAVAILABLE
  '-1': 'network', // SERVICE_DISCONNECTED
  '3': 'storeUnavailable', // BILLING_UNAVAILABLE
  '4': 'storeUnavailable', // ITEM_UNAVAILABLE
  '-2': 'storeUnavailable', // FEATURE_NOT_SUPPORTED
  '6': 'storeUnavailable', // ERROR
}

// Play answers BILLING_UNAVAILABLE or FEATURE_NOT_SUPPORTED when the device has no billing. ERROR
// maps to the same stable code, but it is one call failing and says nothing about the device.
const GOOGLE_NO_BILLING: ReadonlySet<string> = new Set(['3', '-2'])

const GOOGLE_OK = '0'
// OnPurchasesUpdatedSubResponseCode.PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS.
const GOOGLE_DECLINED = '1'

export function storeErrorCode(
  store: Store,
  code: string | null | undefined,
  subCode: string | null = null,
  message: string | null = null,
): StoreErrorCode {
  const mapped =
    store === 'apple'
      ? APPLE_CODES[code ?? '']
      : subCode === GOOGLE_DECLINED
        ? 'declined'
        : GOOGLE_CODES[code ?? '']
  if (mapped) {
    return mapped
  }
  // The store's own words are the only trace of a code nothing here expected.
  console.warn(`store ${store} code ${code ?? 'none'} ${message ?? ''}`.trim())
  return 'unknown'
}

function isOk(store: Store, code: string): boolean {
  return store === 'apple' ? code === 'OK' : code === GOOGLE_OK
}

// Apple writes a UUID in capitals and the gateway only accepts the lowercase form it issued.
function toPurchase(store: Store, raw: NativePurchase): StorePurchase {
  const reference = raw.reference ? (store === 'apple' ? raw.reference.toLowerCase() : raw.reference) : null
  // Purchase.PurchaseState.PURCHASED on Google. A pending or unspecified state is never paid.
  const paid = store === 'apple' ? raw.state === 'purchased' : raw.state === '1'
  return {
    store,
    productId: raw.productIds[0] ?? '',
    state: paid ? 'purchased' : 'pending',
    purchasedAt: raw.purchasedAt,
    reference,
    key: raw.key,
    verified: raw.verified,
    revoked: raw.revoked,
  }
}

function rejection(store: Store, err: unknown): StoreError {
  const raw = (err as { code?: unknown })?.code
  const code = typeof raw === 'string' ? raw : null
  const message = (err as Error)?.message ?? String(err)
  const noBilling = store === 'google' && code !== null && GOOGLE_NO_BILLING.has(code)
  return new StoreError(storeErrorCode(store, code, null, message), message, noBilling)
}

export async function loadProducts(ids: ProductId[]): Promise<StoreProduct[]> {
  const store = currentStore()
  if (!NativeVoltzStore) {
    throw new StoreError('storeUnavailable', 'the store bridge is not in this build')
  }
  let found
  try {
    found = await NativeVoltzStore.loadProducts(ids)
  } catch (err) {
    throw rejection(store, err)
  }
  // A product the store did not find is left out, so a screen never offers one it cannot sell.
  return found
    .filter(p => ids.includes(p.id as ProductId))
    .map(p => ({ id: p.id as ProductId, displayPrice: p.displayPrice }))
}

export async function openPurchases(): Promise<StorePurchase[]> {
  const store = currentStore()
  if (!NativeVoltzStore) {
    throw new StoreError('storeUnavailable', 'the store bridge is not in this build')
  }
  try {
    return (await NativeVoltzStore.openPurchases()).map(raw => toPurchase(store, raw))
  } catch (err) {
    throw rejection(store, err)
  }
}

// Only Apple finishes on the device. A Play purchase is consumed by the gateway after it delivers,
// and consuming or acknowledging here would race it and let the product be bought again undelivered.
export async function finish(purchase: StorePurchase): Promise<void> {
  if (purchase.store !== 'apple' || !NativeVoltzStore) {
    return
  }
  try {
    await NativeVoltzStore.finish(purchase.key)
  } catch (err) {
    throw rejection('apple', err)
  }
}

// What the store hands over outside a purchase in flight, kept for the next listener while none
// listens, with the same ceiling as the native queue. The store hands every one of them back on the
// next open, so the oldest is the one to lose.
const BACKLOG_LIMIT = 100

const listeners = new Set<(purchase: StorePurchase) => void>()
let backlog: StorePurchase[] = []
let listening = false
let drained: Promise<void> | null = null

// The Google purchase flow in flight. Its result arrives through the listener rather than as the
// answer to the launch, among whatever else the listener is handed.
type Tap = { productId: string; reference: string; resolve: (result: BuyResult) => void }
let tap: Tap | null = null
let buying = false

function deliver(purchase: StorePurchase): void {
  if (listeners.size === 0) {
    backlog.push(purchase)
    if (backlog.length > BACKLOG_LIMIT) {
      backlog.shift()
    }
    return
  }
  listeners.forEach(cb => cb(purchase))
}

function handleUpdate(update: NativeUpdate): void {
  const store = currentStore()
  let rest = update.purchases
  if (store === 'google' && tap) {
    const current = tap
    if (!isOk(store, update.code)) {
      // An error from the listener belongs to the flow in flight, the only one Google runs at a time.
      current.resolve({ kind: 'failed', code: storeErrorCode(store, update.code, update.subCode, update.message) })
    } else {
      // The purchase this tap made carries the product asked for and the order's reference. A purchase
      // of another product, or of this one with another order's reference, is another purchase of this
      // app, finished elsewhere.
      const ours = rest.filter(raw => raw.productIds.includes(current.productId))
      const hit = ours.find(raw => raw.reference === current.reference)
      if (hit) {
        rest = rest.filter(raw => raw !== hit)
        const purchase = toPurchase(store, hit)
        current.resolve(purchase.state === 'purchased' ? { kind: 'purchased', purchase } : { kind: 'pending', purchase })
      } else if (ours.some(raw => !raw.reference) || rest.length === 0) {
        // The flow's answer with no reference to read, or an OK with nothing in it, which ends the flow
        // all the same. The purchase goes on to the sync like any other, and the order waits in the
        // book. A call with only other purchases is not this flow's answer, so the tap stays open for
        // the next one, an error included.
        current.resolve({ kind: 'pending', purchase: null })
      }
    }
  }
  rest.forEach(raw => deliver(toPurchase(store, raw)))
}

// Subscribes before draining, so what lands between the two waits in the native queue and comes out
// with the drain, and nothing is handed over twice. A drain that fails leaves the native side
// queueing, so the next caller drains again.
function ensureSubscribed(): Promise<void> {
  const native = NativeVoltzStore
  if (!native) {
    return Promise.resolve()
  }
  if (!listening) {
    native.onUpdate(handleUpdate)
    listening = true
  }
  if (!drained) {
    drained = native
      .takeQueued()
      .then(updates => updates.forEach(handleUpdate))
      .catch(err => {
        drained = null
        console.warn(`store queue unreadable: ${(err as Error)?.message ?? String(err)}`)
      })
  }
  return drained
}

// Hands every purchase the store reports outside a purchase in flight to `cb`, those that arrived
// before anybody listened included.
export function onPurchaseUpdate(cb: (purchase: StorePurchase) => void): () => void {
  listeners.add(cb)
  const held = backlog
  backlog = []
  held.forEach(purchase => cb(purchase))
  ensureSubscribed()
  return () => {
    listeners.delete(cb)
  }
}

function fromApple(result: NativeBuyResult): BuyResult {
  switch (result.status) {
    case 'purchased':
      return result.purchase
        ? { kind: 'purchased', purchase: toPurchase('apple', result.purchase) }
        : { kind: 'failed', code: 'unknown' }
    case 'pending':
      return { kind: 'pending', purchase: null }
    case 'cancelled':
      return { kind: 'failed', code: 'cancelled' }
    default:
      return { kind: 'failed', code: storeErrorCode('apple', result.code, result.subCode, result.message) }
  }
}

// One purchase in flight at a time, on both stores, so a store callback is never matched against
// the wrong tap. The store's sheet is the app's own activity, which Google Play shows by pausing the
// app, so a trip that begins in it raises no cover and is timed against ten minutes instead of two.
export function buy(id: ProductId, ids: { reference: string; accountId?: string }): Promise<BuyResult> {
  return asOwnActivity(() => buyInStore(id, ids))
}

async function buyInStore(id: ProductId, ids: { reference: string; accountId?: string }): Promise<BuyResult> {
  const native = NativeVoltzStore
  if (!native) {
    return { kind: 'failed', code: 'storeUnavailable' }
  }
  if (buying) {
    return { kind: 'failed', code: 'unknown' }
  }
  buying = true
  const store = currentStore()
  try {
    if (store === 'apple') {
      return fromApple(await native.buy(id, ids.reference, null))
    }
    await ensureSubscribed()
    const outcome = new Promise<BuyResult>(resolve => {
      tap = { productId: id, reference: ids.reference, resolve }
    })
    const launched = await native.buy(id, ids.reference, ids.accountId ?? null)
    if (launched.status !== 'launched') {
      // The sheet never opened, so no listener call will follow.
      return { kind: 'failed', code: storeErrorCode(store, launched.code, launched.subCode, launched.message) }
    }
    return await outcome
  } catch (err) {
    return { kind: 'failed', code: rejection(store, err).code }
  } finally {
    tap = null
    buying = false
  }
}

// What became of Apple's refund sheet. Sent says only that Apple has the request, which Apple decides
// with no deadline it publishes (its page gives 24 to 48 hours for an update); closed is the sheet
// dismissed before sending; duplicate is a request Apple already has for this transaction.
export type RefundSheetResult = 'sent' | 'closed' | 'duplicate' | 'failed'

// Whether Apple's refund sheet can open here: on an iPhone with the store bridge, never on Android
// or in a build without the bridge.
export function storeRefundSheetAvailable(): boolean {
  return currentStore() === 'apple' && NativeVoltzStore != null
}

// Opens Apple's refund sheet for one transaction. Only Apple has one; on Google, and in a build
// without the bridge, nothing opens and the answer is failed.
export async function requestStoreRefund(transactionId: string): Promise<RefundSheetResult> {
  const native = NativeVoltzStore
  if (!storeRefundSheetAvailable() || !native) {
    return 'failed'
  }
  try {
    const result = await native.beginRefundRequest(transactionId)
    if (result.status === 'success') {
      return 'sent'
    }
    if (result.status === 'userCancelled') {
      return 'closed'
    }
    if (result.code !== 'failed' && result.code !== 'duplicateRequest') {
      // The store's own words are the only trace of an answer nothing here expected.
      console.warn(`store apple refund ${result.status} ${result.code ?? 'none'} ${result.message ?? ''}`.trim())
    }
    return result.code === 'duplicateRequest' ? 'duplicate' : 'failed'
  } catch (err) {
    console.warn(`store apple refund rejected ${(err as Error)?.message ?? String(err)}`)
    return 'failed'
  }
}
