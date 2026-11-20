import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { PermissionsAndroid, Platform } from 'react-native'
import RNFS from 'react-native-fs'
import {
  AuthorizationStatus,
  getMessaging,
  getToken,
  hasPermission,
  registerDeviceForRemoteMessages,
  requestPermission,
  setAutoInitEnabled,
} from '@react-native-firebase/messaging'
import type * as BridgeDouble from '../specs/__mocks__/NativeVoltzNotifications'
import App from '../App'

// The app as it boots on a fresh install: the notification listeners mount and the connected wallet
// runs the silent registration. firebase.json leaves Firebase Messaging off, so before notifications
// are allowed nothing here may switch it on, register with APNs or ask for a token. The cases that
// allowed them are the control: the same boot does reach those calls.

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigationContainerRef: () => ({
    isReady: () => false,
    navigate: jest.fn(),
    getCurrentRoute: () => undefined,
  }),
  NavigationContainer: () => null,
}))
jest.mock('../src/components/ReceivedOverlayHost', () => ({ ReceivedOverlayHost: () => null }))
jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  settleActiveWallet: jest.fn(async () => true),
}))
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app'),
}))
// A wallet is connected from the first render, which is when the silent registration runs.
jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  onSparkConnected: jest.fn((cb: () => void) => {
    cb()
    return () => undefined
  }),
  sparkGetIdentityPubkey: jest.fn(async () => '02'.padEnd(66, 'a')),
  sparkConnectedIdentity: jest.fn(async () => ({ walletId: 'primary', pubkey: '02'.padEnd(66, 'a') })),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
}))

// The iOS notification bridge and the iPhone state it stands for, reset by jest.setup.js.
const notifications: typeof BridgeDouble = jest.requireMock('../specs/NativeVoltzNotifications')
const bridge = notifications.default
const { device } = notifications

const REAL_OS = Platform.OS
const REAL_VERSION = Platform.Version

function setPlatform(os: string, version: number) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true })
}

let fetchMock: jest.Mock
let mounted: ReactTestRenderer.ReactTestRenderer | null = null

async function boot(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mounted = ReactTestRenderer.create(<App />)
  })
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

function expectFirebaseUntouched() {
  expect(setAutoInitEnabled).not.toHaveBeenCalled()
  expect(bridge.registerForRemoteNotifications).not.toHaveBeenCalled()
  expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
  expect(device.uikitRegistrations).toBe(0)
  expect(getToken).not.toHaveBeenCalled()
  expect(bridge.requestAuthorization).not.toHaveBeenCalled()
  expect(requestPermission).not.toHaveBeenCalled()
  expect(PermissionsAndroid.request).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
}

beforeEach(async () => {
  jest.clearAllMocks()
  const file = `${RNFS.DocumentDirectoryPath}/push-registration.json`
  if (await RNFS.exists(file)) {
    await RNFS.unlink(file)
  }
  ;(PermissionsAndroid.request as unknown as jest.Mock) = jest.fn(async () => 'granted')
  fetchMock = jest.fn(async () => ({ ok: true, status: 200 }))
  global.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
  Object.defineProperty(Platform, 'OS', { value: REAL_OS, configurable: true })
  Object.defineProperty(Platform, 'Version', { value: REAL_VERSION, configurable: true })
})

describe('iOS', () => {
  beforeEach(() => setPlatform('ios', 26))

  test.each([
    ['never answered', AuthorizationStatus.NOT_DETERMINED],
    ['refused', AuthorizationStatus.DENIED],
  ])('a boot whose notifications were %s leaves Firebase off', async (_name, status) => {
    jest.mocked(hasPermission).mockResolvedValue(status)

    await boot()

    // The listeners mounted and the silent path read the answer, so the boot did run.
    expect(getMessaging).toHaveBeenCalled()
    expect(hasPermission).toHaveBeenCalled()
    expectFirebaseUntouched()
  })

  test('the control: a boot whose notifications were allowed switches it on', async () => {
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

    await boot()

    expect(jest.mocked(setAutoInitEnabled).mock.calls).toEqual([[expect.anything(), true]])
    expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // UIKit's registered flag survives the relaunch and the APNs token does not, so the boot has to
  // register again for FIRMessaging to vend a token.
  test('a later boot whose notifications were allowed registers with APNs again', async () => {
    device.registered = true
    notifications.relaunch()
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

    await boot()

    expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('Android 13 and later', () => {
  beforeEach(() => setPlatform('android', 34))

  test('a boot before notifications are granted leaves Firebase off', async () => {
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)

    await boot()

    expect(getMessaging).toHaveBeenCalled()
    expect(hasPermission).toHaveBeenCalled()
    expectFirebaseUntouched()
  })

  test('the control: a boot once they are granted switches it on', async () => {
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

    await boot()

    expect(jest.mocked(setAutoInitEnabled).mock.calls).toEqual([[expect.anything(), true]])
    expect(bridge.registerForRemoteNotifications).not.toHaveBeenCalled()
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(getToken).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
