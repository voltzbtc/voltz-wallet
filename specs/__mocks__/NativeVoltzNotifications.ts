import type { Spec } from '../NativeVoltzNotifications'

// The notification bridge under Jest, wired by jest.setup.js, with the slice of the iPhone it acts on.
// `device` stands for UIKit and for the APNs token RNFB hands FIRMessaging, and the Firebase double
// (__mocks__/@react-native-firebase/messaging.ts) reads the same state: UIKit's registered flag
// survives a relaunch, while the APNs token exists only after a registration in the current process,
// as FIRMessaging keeps it in memory. jest.setup.js puts it back to a fresh install before each test.
// Tests reach it through jest.requireMock, since importing this file directly yields a second
// instance that the code under test never sees.

export type Status = 'notDetermined' | 'denied' | 'authorized' | 'provisional' | 'ephemeral'

export const APNS_TOKEN = 'apns-token-from-device'

export const device = {
  // The answer the system dialog gets. A refusal unless a test says otherwise, as in the Firebase
  // double, so a screen test never registers by accident.
  answer: 'denied' as Status,
  // UIApplication.isRegisteredForRemoteNotifications.
  registered: false,
  // FIRMessaging.APNSToken.
  apnsToken: null as string | null,
  // What APNs hands over at a registration; null for an APNs that never answers.
  delivers: APNS_TOKEN as string | null,
  // Every call that reached UIKit's registerForRemoteNotifications, whichever module made it.
  uikitRegistrations: 0,
}

export function resetDevice(): void {
  device.answer = 'denied'
  device.registered = false
  device.apnsToken = null
  device.delivers = APNS_TOKEN
  device.uikitRegistrations = 0
}

// A later launch of an app that registered before: UIKit still says registered, and FIRMessaging
// starts with no APNs token.
export function relaunch(): void {
  device.apnsToken = null
}

// UIKit's registerForRemoteNotifications, with APNs answering at once through the app delegate.
export function uikitRegister(): void {
  device.uikitRegistrations += 1
  if (device.delivers !== null) {
    device.registered = true
    device.apnsToken = device.delivers
  }
}

const bridge: Spec = {
  requestAuthorization: jest.fn(async (): Promise<string> => device.answer),
  registerForRemoteNotifications: jest.fn(async () => uikitRegister()),
}

export default bridge
