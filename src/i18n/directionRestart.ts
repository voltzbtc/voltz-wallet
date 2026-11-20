import { I18nManager, NativeModules, Platform } from 'react-native'
import RNRestart from 'react-native-restart'
import { isRTL } from './languages'
import {
  clearDirectionRestart,
  loadDirectionRestart,
  saveDirectionRestart,
  type LayoutDirection,
} from '../wallet/settings'
import { disconnectSpark } from '../wallet/spark'

export type DirectionOutcome = 'settled' | 'restarting'

// I18nManager.isRTL is a constant handed to the JS runtime when it starts, and forceRTL only writes
// the preference the next runtime reads. A language whose direction disagrees with the running one
// therefore needs a restart that starts a new runtime.
//
// The marker names the direction a restart was started for. A boot that still disagrees and finds
// it renders as it is rather than restarting again, so a restart that does not take costs a wrong
// layout until the next cold start, never a loop. The boot and the language picker both come here,
// and nothing else writes the native direction flags.
export async function settleDirection(language: string): Promise<DirectionOutcome> {
  const rtl = isRTL(language)
  const target: LayoutDirection = rtl ? 'rtl' : 'ltr'
  const marker = await readMarker()
  if (I18nManager.isRTL === rtl) {
    if (marker) {
      await clearDirectionRestart().catch(() => undefined)
    }
    return 'settled'
  }
  if (marker === target) {
    await clearDirectionRestart().catch(() => undefined)
    console.warn(`layout direction is still not ${target} after a restart, rendering as it is`)
    return 'settled'
  }
  try {
    await saveDirectionRestart(target)
  } catch {
    // Without the marker the next boot could not tell this restart from a first one.
    return 'settled'
  }
  // allowRTL follows the target as well. Left true, the native check also honours the device and the
  // app bundle language, so an app in English on an Arabic phone would come back RTL and disagree.
  I18nManager.allowRTL(rtl)
  I18nManager.forceRTL(rtl)
  await disconnectBeforeRestart()
  restartRuntime()
  return 'restarting'
}

// How long a restart waits for the SDK to let go before it goes ahead anyway.
export const DISCONNECT_BOUND_MS = 2000

// A restart keeps the process, and an SDK instance left connected by the old runtime would go on
// syncing next to the one the new runtime connects, on the same seed and storage directory. It is
// closed first, and only once a restart is certain, since a path that settles keeps using it. A
// disconnect that fails or never answers does not hold the restart back past the bound.
//
// Only the live instance is waited for. A native connect still under way is cut loose and not
// awaited; inside one runtime such an instance disconnects itself when it lands (the connect rules in
// spark.ts). Whether the reload leaves the old runtime there to do it is a device check, not
// something this code can see.
async function disconnectBeforeRestart(): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>(resolve => {
    timer = setTimeout(resolve, DISCONNECT_BOUND_MS)
  })
  try {
    const closed = Promise.resolve()
      .then(() => disconnectSpark())
      .catch(() => undefined)
    await Promise.race([closed, bound])
  } finally {
    clearTimeout(timer)
  }
}

// An unreadable marker counts as none, whether the read rejects or throws before it starts: at most
// one restart more, since a restart needs a marker that was written.
async function readMarker(): Promise<LayoutDirection | null> {
  try {
    return await loadDirectionRestart()
  } catch {
    return null
  }
}

// react-native-restart reaches for getReactNativeHost, which the New Architecture does not provide
// on Android, and falls back to recreating the activity inside the same runtime, where isRTL keeps
// its old value. The app's own module reloads the ReactHost instead, which starts a new runtime.
// iOS reloads the runtime through react-native-restart already.
function restartRuntime(): void {
  const host = Platform.OS === 'android' ? NativeModules.VoltzRestart : undefined
  if (host) {
    host.reload('direction')
    return
  }
  RNRestart.restart()
}
