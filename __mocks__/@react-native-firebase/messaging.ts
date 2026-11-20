// Native module, absent in Jest. It stays minimal because what is worth asserting is which calls
// happen and with what, not the SDK's own behaviour.
import { Platform } from 'react-native'

// The iPhone's side (UIKit's registration and the APNs token FIRMessaging holds) is kept by the
// notification bridge's double, which stands for UIKit, so both doubles read one device.
type Device = typeof import('../../specs/__mocks__/NativeVoltzNotifications')
function iphone(): Device {
  return jest.requireMock('../../specs/NativeVoltzNotifications')
}

function nativeError(code: string, message: string): Error {
  return Object.assign(new Error(`[messaging/${code}] ${message}`), { code: `messaging/${code}` })
}

export const getMessaging = jest.fn(() => ({}))
// On iOS, as RNFB and FIRMessaging answer: refused while UIKit has never registered, and declined
// with MissingDeviceToken while this process has no APNs token.
export const getToken = jest.fn(async () => {
  if (Platform.OS === 'ios') {
    const { device } = iphone()
    if (!device.registered) {
      throw nativeError('unregistered', 'You must be registered for remote messages before calling getToken')
    }
    if (!device.apnsToken) {
      throw nativeError('unknown', 'No APNS token specified before fetching FCM Token')
    }
  }
  return 'fcm-token-from-device'
})
// The switch firebase.json leaves off. It resolves, as on a device that was granted notifications.
export const setAutoInitEnabled = jest.fn(async () => undefined)
// RNFB's registration, which returns early when UIKit already says registered
// (RNFBMessagingModule.mm registerForRemoteNotifications), so a later launch gets no APNs token from it.
export const registerDeviceForRemoteMessages = jest.fn(async () => {
  const { device, uikitRegister } = iphone()
  if (!device.registered) {
    uikitRegister()
  }
})
// FIRMessaging.APNSToken as RNFB reads it: refused while UIKit has never registered, then null until
// this process's token arrives.
export const getAPNSToken = jest.fn(async (): Promise<string | null> => {
  const { device } = iphone()
  if (device.apnsToken) {
    return device.apnsToken
  }
  if (!device.registered) {
    throw nativeError('unregistered', 'You must be registered for remote messages before calling getAPNSToken')
  }
  return null
})
export const onTokenRefresh = jest.fn(() => () => undefined)
// A tapped notification, cold start and warm. Nothing arrives by default, which is the ordinary
// launch: the app was opened from its icon.
export const getInitialNotification = jest.fn(async () => null)
export const onNotificationOpenedApp = jest.fn(() => () => undefined)
export const onMessage = jest.fn(() => () => undefined)
// The deprecated permission pair. The app reads hasPermission only, and asks through the notification
// bridge. Jest runs as iOS, so nothing is granted by default, as on a fresh install that has not
// answered or a prompt answered with a refusal. A screen test then never registers with the gateway
// by accident, and a test that wants a grant says so. requestPermission registers with UIKit after any
// answer, as RNFB does (RNFBMessagingModule.mm requestPermission).
export const AuthorizationStatus = {
  NOT_DETERMINED: -1,
  DENIED: 0,
  AUTHORIZED: 1,
  PROVISIONAL: 2,
  EPHEMERAL: 3,
} as const
export const requestPermission = jest.fn(async () => {
  iphone().uikitRegister()
  return AuthorizationStatus.DENIED as number
})
export const hasPermission = jest.fn(async () => AuthorizationStatus.NOT_DETERMINED as number)
