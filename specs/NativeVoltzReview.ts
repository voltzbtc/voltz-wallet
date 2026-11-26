import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the stores' review prompt, whose one reader is src/wallet/storeReview.ts: the
// Play In-App Review API on Android, StoreKit's review request on iOS. The native side asks and decides
// nothing, and it logs and keeps nothing. Neither store says whether a card showed or a review was left,
// and each store caps how often its card shows, so a resolve means only that the request was handed over.

export interface Spec extends TurboModule {
  // Android requests a ReviewInfo and launches the flow over the current activity, resolving when the
  // flow ends. iOS hands the request to the foreground scene and resolves at once.
  request(): Promise<void>
}

// `get`, not `getEnforcing`: a binary built before the module, or a platform without it, asks nothing.
export default TurboModuleRegistry.get<Spec>('NativeVoltzReview')
