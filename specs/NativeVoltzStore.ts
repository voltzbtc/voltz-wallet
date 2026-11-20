import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the store bridge (StoreKit 2 on iOS, Play Billing on Android). The native side
// only relays what the store says, raw, and src/wallet/store.ts is the one reader that turns it into
// the app's types and stable error codes, where Jest and Stryker reach the rules.

// One purchase as the store reports it.
export type NativePurchase = {
  // Apple has one product per transaction; a Play purchase lists every product it bought.
  productIds: ReadonlyArray<string>
  // The transaction id on Apple, the purchase token on Google: what the gateway is asked about.
  key: string
  // appAccountToken on Apple, obfuscatedProfileId on Google; null when the purchase carries none.
  reference: string | null
  // Always 'purchased' on Apple, since a pending purchase there has no transaction yet. On Google the
  // Purchase.PurchaseState integer in decimal.
  state: string
  // Milliseconds since the epoch.
  purchasedAt: number
  // Apple's VerificationResult; always true on Google, which signs nothing the app checks.
  verified: boolean
  // Whether Apple set a revocationDate; always false on Google.
  revoked: boolean
}

export type NativeProduct = {
  id: string
  // Formatted by the store in the buyer's currency.
  displayPrice: string
}

// One store callback, whole. On Google that is one call of the PurchasesUpdatedListener, whose
// result code belongs to the purchase flow in flight and whose purchases may be any of the app's;
// on Apple it is one element of Transaction.updates, with code 'OK'.
export type NativeUpdate = {
  // The store's own code: the case name on Apple, the BillingResponseCode integer in decimal on Google.
  code: string
  // The OnPurchasesUpdatedSubResponseCode integer in decimal on Google, null otherwise.
  subCode: string | null
  // The store's debug message, for the log only.
  message: string | null
  purchases: ReadonlyArray<NativePurchase>
}

export type NativeBuyResult = {
  // 'purchased', 'pending', 'cancelled' or 'failed' on Apple. On Google 'launched', when the
  // purchase sheet opened and the outcome arrives through onUpdate, or 'failed'.
  status: string
  code: string | null
  subCode: string | null
  message: string | null
  purchase: NativePurchase | null
}

// Apple's answer to its refund sheet, raw. Google has no such sheet and answers 'failed'.
export type NativeRefundResult = {
  // 'success' or 'userCancelled', as Transaction.RefundRequestStatus names them, or 'failed'.
  status: string
  // On 'failed', the case name of Transaction.RefundRequestError or of a StoreKitError, or the
  // bridge's own: 'invalidTransaction', 'noScene', 'unsupported'.
  code: string | null
  message: string | null
}

export interface Spec extends TurboModule {
  loadProducts(ids: ReadonlyArray<string>): Promise<ReadonlyArray<NativeProduct>>
  // `accountId` is Google's obfuscatedAccountId; Apple ignores it.
  buy(productId: string, reference: string, accountId: string | null): Promise<NativeBuyResult>
  // Transaction.unfinished on Apple, queryPurchasesAsync for one-time products on Google.
  openPurchases(): Promise<ReadonlyArray<NativePurchase>>
  // Finishes the unfinished Apple transaction with this id, answering false when none has it. Google
  // never finishes on the device, since the gateway consumes after delivering.
  finish(transactionId: string): Promise<boolean>
  // Hands back and empties what arrived before anyone listened, and switches the native side to
  // emitting directly.
  takeQueued(): Promise<ReadonlyArray<NativeUpdate>>
  // Transaction.beginRefundRequest(for:in:) on the current window scene for the transaction with this
  // id. Apple decides on the refund afterwards; the answer only says what became of the sheet.
  beginRefundRequest(transactionId: string): Promise<NativeRefundResult>
  readonly onUpdate: CodegenTypes.EventEmitter<NativeUpdate>
}

// `get`, not `getEnforcing`, so a binary without the module reads as a store that is unavailable
// instead of failing at import.
export default TurboModuleRegistry.get<Spec>('NativeVoltzStore')
