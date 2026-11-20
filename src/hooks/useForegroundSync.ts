import { useEffect } from 'react'
import { AppState } from 'react-native'
import { sparkNoteResumed, sparkSyncWallet } from '../wallet/spark'

// The SDK polls on a timer, so anything that arrived while the app was away waits for the next tick,
// which is what makes an arrival look like it needs the app reopened. Returning to the foreground is
// when someone is looking, and the event listeners already in place fan the result out.
//
// Only a return from the background counts the balance as unsynced again; 'inactive' alone, as under
// the notification shade, leaves the app running. The flag is set by the 'background' sent on the way
// out. RCTAppState maps UIApplicationWillEnterForeground to 'background' as well, but it sends a state
// only when it differs from the last one sent, so on iOS nothing new arrives on the way back before
// 'active'. A flag, not the state just before 'active', says the app was away whatever comes between.
export function useForegroundSync(): void {
  useEffect(() => {
    let wasAway = false
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        wasAway = true
        return
      }
      if (state === 'active') {
        if (wasAway) {
          wasAway = false
          sparkNoteResumed()
        }
        // Rejects while no wallet is connected, and there is nothing to sync then.
        sparkSyncWallet().catch(() => undefined)
      }
    })
    return () => sub.remove()
  }, [])
}
