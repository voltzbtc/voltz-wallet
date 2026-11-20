import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the cover over the app while it is away, and of the clock that times the trip.
// src/wallet/relock.ts is the one reader.
//
// The native side stamps the leave and raises the cover inside the platform's own callback
// (applicationDidEnterBackground on iOS, Activity.onPause before super on Android), because a stamp
// taken in the JS 'background' handler arrives only on the return when iOS suspends the process first,
// and a cover drawn from JS is drawn after the snapshot and after the first frame back. The clock counts
// sleep and nothing can set it: SystemClock.elapsedRealtime on Android, CLOCK_MONOTONIC_RAW on iOS.
// Neither JS clock fits: Date.now() is the wall clock, which Settings can set back, and performance.now()
// is the C++ steady clock, which stops while the device sleeps.

// What takeAway answers for each kind of leave: the milliseconds since the first one, or a negative
// code. -1: no such leave. -2: its clock read zero, or ran backwards by the return.
export type Trips = {
  // Leaves from the app's own screens.
  left: number
  // Leaves while an activity the app started itself was open (Android only; iOS answers -1). Such a
  // trip has a longer limit, so a long pick does not lock, while Home pressed inside a picker and a
  // return hours later does.
  own: number
}

export interface Spec extends TurboModule {
  // What the native side recorded since the previous call, which it then forgets.
  takeAway(): Trips
  // Lowers the cover once the app is in front, and no sooner than a quarter of a second after it went
  // up. A hide that finds the app away again, or that was queued before a later leave, does nothing.
  hideCover(): void
  // The same, once every Modal window the cover went up over has closed and left the screen; the lock
  // calls it after closing them. Android plays a Dialog's exit animation after the app lets go of the
  // window, with the theme fixed when the Dialog was made, so the native side waits for each such
  // window to go and for its exit to end, and lifts anyway after a short wait for one that stays. iOS
  // lowers at once: a Modal there reads its animationType from the update that hides it, so the lock's
  // are dismissed unanimated under the cover.
  hideCoverAfterModals(): void
  // Resolves true once the app is in front and a prompt may be shown (Android: after onPostResume),
  // false when it leaves again first.
  whenInFront(): Promise<boolean>
  // Bracket an activity the app starts itself (a picker, the biometric or passkey prompt, the store
  // sheet). A trip that begins while one is open raises no cover and is timed against ten minutes
  // instead of two (RELOCK_AFTER_OWN_MS). Android only; iOS shows these inside the app.
  beginOwnActivity(): void
  endOwnActivity(): void
  // Dismisses whatever UIKit presented that is not a React Native Modal (the share sheet,
  // ActionSheetIOS, the photo picker), and resolves once it is gone. Android has none and resolves at
  // once.
  dismissPresented(): Promise<void>
}

// `get`, not `getEnforcing`, so a binary without the module reads as a clock that cannot be read,
// which the lock treats as time enough to lock, instead of failing at import.
export default TurboModuleRegistry.get<Spec>('NativeVoltzPrivacy')
