import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the stores' review prompt, whose one reader is src/wallet/storeReview.ts: the
// Play In-App Review API on Android, StoreKit's review request on iOS. The native side asks and decides
// nothing, and it logs and keeps nothing beyond Play's ReviewInfo between the two calls. Neither store
// says whether a card showed or a review was left, and each store caps how often its card shows, so a
// resolve means only that the request was handed over.
//
// Two calls, so the caller can look at the screen again between the store's round trip and the card:
// Play answers requestReviewFlow asynchronously, and a card launched from that answer would land over
// whatever the person opened meanwhile.

export interface Spec extends TurboModule {
  // Android requests a ReviewInfo and keeps it, replacing any older one, and resolves true once it is
  // ready; it shows nothing. iOS has nothing to prepare and resolves true at once.
  prepare(): Promise<boolean>
  // Android launches the flow with the kept ReviewInfo over the current activity, drops it, and
  // resolves when the flow ends; it rejects when nothing was prepared. iOS hands the request to the
  // foreground scene and resolves at once.
  launch(): Promise<void>
}

// `get`, not `getEnforcing`: a binary built before the module, or a platform without it, asks nothing.
export default TurboModuleRegistry.get<Spec>('NativeVoltzReview')
