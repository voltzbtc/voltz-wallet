import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the stores' age signal, whose one reader is src/wallet/ageSignal.ts: the Play Age
// Signals API on Android, Apple's Declared Age Range on iOS. California's Digital Age Assurance Act
// (Civ. Code 1798.500 et seq.) has every app ask for the signal when it is downloaded and launched. The
// native side relays what the store answers and decides nothing, and it logs and keeps nothing.

// What the store shared. `lower` and `upper` are the bounds of the age range in years, -1 for a bound
// the store left open or did not give.
//   shared                the store gave a range
//   notShared             the person declined, or the store shares nothing for them
//   verificationRequired  Play only: the person must confirm their age in the Play Store first
//   unspecified           any other status, read as nothing shared
export type AgeAnswer = {
  status: string
  lower: number
  upper: number
}

export interface Spec extends TurboModule {
  // Whether the store marks this person as one whose region's law has the app ask for the signal: Play's
  // MANDATORY_SHARING, or isEligibleForAgeFeatures on iOS 26.2 and later. Below iOS 26.2 it answers
  // false, since nothing there can be asked without a prompt the law does not require.
  regulated(): Promise<boolean>
  // Asks the store for the age range. Play may show its own sharing prompt over the app, which is why
  // the reader brackets this call as an activity of the app's own. iOS asks with one age gate, 18.
  request(): Promise<AgeAnswer>
}

// `get`, not `getEnforcing`: a binary built before the module, or a platform without it, answers no
// signal, which never stops the app.
export default TurboModuleRegistry.get<Spec>('NativeVoltzAge')
