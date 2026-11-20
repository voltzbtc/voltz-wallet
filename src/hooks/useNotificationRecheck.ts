import { useEffect } from 'react'
import { AppState } from 'react-native'
import { sendDeviceForgets } from '../wallet/deviceForget'
import { recheckNotifications } from '../wallet/pushToken'

// The system settings are where notifications are turned off or on, and the app learns of it only by
// asking, so it asks on every return from the background as well as on every connect. A start and every
// such return also send the forgets an earlier run left owed, a wallet removed or erased with no network
// included.
//
// Only a return from the background counts, as in useForegroundSync: the settings are another app,
// and 'inactive' alone, as under the notification shade, leaves this one running.
export function useNotificationRecheck(): void {
  useEffect(() => {
    sendDeviceForgets().catch(() => undefined)
    let wasAway = false
    const sub = AppState.addEventListener('change', state => {
      if (state === 'background') {
        wasAway = true
        return
      }
      if (state === 'active' && wasAway) {
        wasAway = false
        recheckNotifications().catch(() => undefined)
        sendDeviceForgets().catch(() => undefined)
      }
    })
    return () => sub.remove()
  }, [])
}
