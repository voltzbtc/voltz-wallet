import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the iOS notification bridge. Asking for notifications and registering with
// APNs are two calls here, where React Native Firebase's requestPermission makes them one: it
// registers with APNs after any answer, a refusal included, and on a fresh install the APNs token
// alone makes FIRMessaging fetch an installation id and an FCM token. src/wallet/pushToken.ts is the
// one reader, and only on iOS; Android has no implementation.

export interface Spec extends TurboModule {
  // Shows the system dialog for alerts and sounds when it is still to come, then answers the
  // authorization status: 'notDetermined', 'denied', 'authorized', 'provisional' or 'ephemeral'.
  // Never registers with APNs, whatever the answer.
  requestAuthorization(): Promise<string>
  // UIApplication registerForRemoteNotifications on the main thread, on every call. The device token
  // reaches FIRMessaging through RNFB's app delegate proxy, which holds it in memory only, so every
  // process that wants an FCM token registers again, already registered or not.
  registerForRemoteNotifications(): Promise<void>
}

// `get`, not `getEnforcing`, so a binary without the module reads as one that cannot ask instead of
// failing at import, and Android, which never implements it, reads null.
export default TurboModuleRegistry.get<Spec>('NativeVoltzNotifications')
