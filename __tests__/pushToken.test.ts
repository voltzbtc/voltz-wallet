import { PermissionsAndroid, Platform } from 'react-native'
import RNFS from 'react-native-fs'
import {
  AuthorizationStatus,
  getAPNSToken,
  getToken,
  hasPermission,
  registerDeviceForRemoteMessages,
  requestPermission,
  setAutoInitEnabled,
} from '@react-native-firebase/messaging'
import type * as BridgeDouble from '../specs/__mocks__/NativeVoltzNotifications'
import { ensurePushRegistered, pushPromptDue, requestNotificationPermission } from '../src/wallet/pushToken'
import { loadRegistration, registerPushDevice } from '../src/wallet/push'
import { clearDeletionMark, writeDeletionMark } from '../src/wallet/deletionMark'
import { loadWebhookState } from '../src/wallet/webhookSecret'
import * as Keychain from 'react-native-keychain'

jest.mock('../src/config', () => ({
  getBreezLnurlDomain: jest.fn(() => 'lnurl.usevoltz.app'),
  getBreezSparkApiKey: jest.fn(() => 'key'),
  getBreezApiKey: jest.fn(() => 'key'),
}))

jest.mock('../src/wallet/spark', () => {
  const sparkGetIdentityPubkey = jest.fn(async () => '02'.padEnd(66, 'a'))
  return {
    sparkGetIdentityPubkey,
    sparkSignMessage: jest.fn(async () => 'deadbeef'),
    sparkConnectedIdentity: jest.fn(async () => ({ walletId: 'w1', pubkey: await sparkGetIdentityPubkey() })),
    // The provider's side of the payment webhook, which __tests__/paymentWebhook.test.ts drives.
    sparkWebhookSession: jest.fn(() => ({
      list: async () => [],
      register: async () => 'hook-1',
      unregister: async () => undefined,
    })),
  }
})

const DOMAIN = 'lnurl.usevoltz.app'
const PUB = '02'.padEnd(66, 'a')

const { getBreezLnurlDomain } = jest.requireMock('../src/config')
const { sparkSignMessage } = jest.requireMock('../src/wallet/spark')
// The iOS notification bridge and the iPhone state it stands for, reset by jest.setup.js.
const notifications: typeof BridgeDouble = jest.requireMock('../specs/NativeVoltzNotifications')
const bridge = notifications.default
const { device } = notifications

function setPlatform(os: string, version: number) {
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  Object.defineProperty(Platform, 'Version', { value: version, configurable: true })
}

let fetchMock: jest.Mock

beforeEach(async () => {
  jest.clearAllMocks()
  const file = `${RNFS.DocumentDirectoryPath}/push-registration.json`
  if (await RNFS.exists(file)) {
    await RNFS.unlink(file)
  }
  setPlatform('android', 34)
  getBreezLnurlDomain.mockReturnValue('lnurl.usevoltz.app')
  ;(PermissionsAndroid.request as unknown as jest.Mock) = jest.fn(async () => 'granted')
  // The mock's own default, never answered, so no test inherits another's answer.
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.NOT_DETERMINED)
  // A gateway that accepts v5, which answers the id the provider posts to.
  fetchMock = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => ({ registered: true, webhookId: 'AbCdEfGhIjKlMnOpQrStUv' }),
  }))
  global.fetch = fetchMock as unknown as typeof fetch
  // A Keychain that keeps what it is given, where the webhook secret lives.
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest
    .mocked(Keychain.getGenericPassword)
    .mockImplementation(async options =>
      keychain.has(options?.service ?? '')
        ? ({ username: 'webhook', password: keychain.get(options?.service ?? '')! } as never)
        : false,
    )
})

const keychain = new Map<string, string>()

test('a granted permission leads to a signed registration', async () => {
  expect(await ensurePushRegistered()).toBe(true)
  expect(getToken).toHaveBeenCalled()
  // The statement carries the wording this device wants on its lock screen, inside the signature, so
  // the app stays the only place the 24 translations live. v5 is what a build with every kind of
  // wording and a payment webhook secret sends, and the older versions stay reachable for a device
  // that cannot render all of it.
  expect(sparkSignMessage).toHaveBeenCalledWith(
    expect.stringContaining('voltz-push:v5\nregister-device\nlnurl.usevoltz.app'),
    PUB,
  )
  const signed = (sparkSignMessage as unknown as jest.Mock).mock.calls[0][0] as string
  expect(signed).toContain('Payment received')
  expect(signed).toContain('{amount}')
  expect(fetchMock.mock.calls[0][0]).toBe('https://lnurl.usevoltz.app/api/device')
  expect((await loadRegistration())?.token).toBe('fcm-token-from-device')
})

test('a refused permission registers nothing', async () => {
  ;(PermissionsAndroid.request as unknown as jest.Mock).mockResolvedValue('denied')
  expect(await ensurePushRegistered()).toBe(false)
  expect(getToken).not.toHaveBeenCalled()
  expect(fetchMock).not.toHaveBeenCalled()
})

test('the token is never fetched before the user has agreed', async () => {
  // Asking Firebase for a token first would create the device registration on Google's side even
  // if the person then refuses, which is exactly the tracking a wallet should not do.
  ;(PermissionsAndroid.request as unknown as jest.Mock).mockResolvedValue('never_ask_again')
  await ensurePushRegistered()
  expect(getToken).not.toHaveBeenCalled()
})

test('Android below 13 does not prompt, since install already granted it', async () => {
  setPlatform('android', 32)
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  expect(await requestNotificationPermission()).toBe(true)
  expect(PermissionsAndroid.request).not.toHaveBeenCalled()
})

// Below 13 there is no POST_NOTIFICATIONS to check, and the system settings switch is the only way
// off. RNFB's hasPermission reads areNotificationsEnabled on Android, which sees it on every level.
describe('notifications turned off in the system settings count as off on every Android', () => {
  test.each([24, 29, 32, 34])('Android SDK %i, prompt or not, reads the settings switch', async version => {
    setPlatform('android', version)
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)

    expect(await requestNotificationPermission(false)).toBe(false)
    if (version < 33) {
      expect(await requestNotificationPermission(true)).toBe(false)
    }
    expect(await ensurePushRegistered(false)).toBe(false)
    expect(PermissionsAndroid.request).not.toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/device'))).toHaveLength(0)
  })

  test('the control: the same read on Android 12 with the switch on registers', async () => {
    setPlatform('android', 32)
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

    expect(await ensurePushRegistered(false)).toBe(true)
    expect(hasPermission).toHaveBeenCalled()
  })
})

test('without a custom domain nothing is registered', async () => {
  // On the SDK default domain the payment never reaches the gateway, so a registration would point
  // at a service that will never hear about it.
  getBreezLnurlDomain.mockReturnValue(undefined)
  expect(await ensurePushRegistered()).toBe(false)
  expect(fetchMock).not.toHaveBeenCalled()
})

test('a second call after a successful one sends nothing', async () => {
  expect(await ensurePushRegistered()).toBe(true)
  expect(await ensurePushRegistered()).toBe(false)
  expect(fetchMock).toHaveBeenCalledTimes(1)
})

test('a wallet switch re-points the device without raising a dialog', async () => {
  // The gateway holds one wallet per device token, so a switch has to re-register. Prompting there
  // would put a permission dialog in front of someone who only changed wallets.
  await registerPushDevice({
    gatewayUrl: 'https://lnurl.usevoltz.app',
    domain: DOMAIN,
    platform: 'android',
    token: 'fcm-token-from-device',
    identity: async () => PUB,
    sign: async () => 'sig',
    request: (async () => ({ ok: true, status: 200 }) as Response) as unknown as typeof fetch,
  })
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
  const { sparkGetIdentityPubkey } = jest.requireMock('../src/wallet/spark')
  sparkGetIdentityPubkey.mockResolvedValue('03'.padEnd(66, 'c'))

  expect(await ensurePushRegistered(false)).toBe(true)
  expect(PermissionsAndroid.request).not.toHaveBeenCalled()
  expect(hasPermission).toHaveBeenCalled()
  expect((await loadRegistration())?.pubkey).toBe('03'.padEnd(66, 'c'))
})

test('silent mode registers nothing when the user never granted notifications', async () => {
  jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)
  expect(await ensurePushRegistered(false)).toBe(false)
  expect(PermissionsAndroid.request).not.toHaveBeenCalled()
})

// iOS asks through the app's notification bridge, which shows the system dialog. Only an answer that
// delivers notifications leads to a token, and the platform the gateway is told is the one that is
// running.
describe('iOS', () => {
  beforeEach(() => {
    setPlatform('ios', 26)
    // The wallet switch case above leaves another identity behind.
    jest.requireMock('../src/wallet/spark').sparkGetIdentityPubkey.mockResolvedValue(PUB)
  })

  function signedLines(): string[] {
    return ((sparkSignMessage as unknown as jest.Mock).mock.calls[0][0] as string).split('\n')
  }

  function sentBody(): Record<string, unknown> {
    return JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body)
  }

  test('an allowed prompt registers the device as ios, signed and sent', async () => {
    device.answer = 'authorized'

    expect(await ensurePushRegistered()).toBe(true)

    expect(bridge.requestAuthorization).toHaveBeenCalledTimes(1)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(hasPermission).not.toHaveBeenCalled()
    expect(PermissionsAndroid.request).not.toHaveBeenCalled()
    expect(signedLines().slice(0, 6)).toEqual([
      'voltz-push:v5',
      'register-device',
      DOMAIN,
      PUB,
      'ios',
      'fcm-token-from-device',
    ])
    expect(fetchMock.mock.calls[0][0]).toBe('https://lnurl.usevoltz.app/api/device')
    expect(sentBody().platform).toBe('ios')
    expect((await loadRegistration())?.platform).toBe('ios')
  })

  test('a provisional grant registers too, since those notifications are delivered', async () => {
    device.answer = 'provisional'

    expect(await ensurePushRegistered()).toBe(true)
    expect(sentBody().platform).toBe('ios')
  })

  test.each([
    ['refused', 'denied'],
    ['undecided', 'notDetermined'],
    ['ephemeral', 'ephemeral'],
  ] as const)('a %s answer never fetches a token', async (_name, status) => {
    device.answer = status

    expect(await ensurePushRegistered()).toBe(false)
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('silent mode reads the answer already given and never shows the dialog', async () => {
    jest.mocked(hasPermission).mockResolvedValueOnce(AuthorizationStatus.AUTHORIZED)

    expect(await ensurePushRegistered(false)).toBe(true)
    expect(hasPermission).toHaveBeenCalledTimes(1)
    expect(bridge.requestAuthorization).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(sentBody().platform).toBe('ios')
  })

  test('silent mode before any answer registers nothing and asks nothing', async () => {
    jest.mocked(hasPermission).mockResolvedValueOnce(AuthorizationStatus.NOT_DETERMINED)

    expect(await ensurePushRegistered(false)).toBe(false)
    expect(bridge.requestAuthorization).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

test('a platform without push asks nothing and sends nothing', async () => {
  setPlatform('web', 0)

  expect(await ensurePushRegistered()).toBe(false)
  expect(bridge.requestAuthorization).not.toHaveBeenCalled()
  expect(requestPermission).not.toHaveBeenCalled()
  expect(PermissionsAndroid.request).not.toHaveBeenCalled()
  expect(getToken).not.toHaveBeenCalled()
})

test.each(['removed', 'asked', 'pending', 'done'] as const)(
  'a key whose deletion mark is %s registers nothing and is asked no permission',
  async state => {
    await writeDeletionMark('primary', { pubkey: PUB, state, askedAt: 1_800_000_000 })
    try {
      expect(await ensurePushRegistered()).toBe(false)
      expect(PermissionsAndroid.request).not.toHaveBeenCalled()
      expect(bridge.requestAuthorization).not.toHaveBeenCalled()
      expect(requestPermission).not.toHaveBeenCalled()
      expect(getToken).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      await clearDeletionMark('primary')
    }
  },
)

// Whether the system dialog is still to come, which is when Receive explains it before a tap asks.
describe('pushPromptDue', () => {
  const ASKED = `${RNFS.DocumentDirectoryPath}/notification-asked.json`

  beforeEach(async () => {
    if (await RNFS.exists(ASKED)) {
      await RNFS.unlink(ASKED)
    }
    jest.requireMock('../src/wallet/spark').sparkGetIdentityPubkey.mockResolvedValue(PUB)
    ;(PermissionsAndroid.check as unknown as jest.Mock) = jest.fn(async () => false)
  })

  test('Android 13 and later, never asked and not granted, is due', async () => {
    setPlatform('android', 33)
    expect(await pushPromptDue()).toBe(true)
    // Reading whether it is due asks nothing.
    expect(PermissionsAndroid.request).not.toHaveBeenCalled()
  })

  test('Android once the system was asked is not due, whatever the answer was', async () => {
    setPlatform('android', 34)
    // A refused dialog still writes the mark, and the permission stays off.
    ;(PermissionsAndroid.request as unknown as jest.Mock).mockResolvedValue('denied')
    expect(await ensurePushRegistered(true)).toBe(false)
    expect(await RNFS.exists(ASKED)).toBe(true)
    expect(await pushPromptDue()).toBe(false)
  })

  test('an iOS build without the bridge offers no card, since it cannot show the dialog', async () => {
    setPlatform('ios', 26)
    // The code reads the module's default export at each call, so taking it away here stands for a
    // build whose binary lacks the bridge.
    const bridgeModule = notifications as unknown as { default: unknown }
    const saved = bridgeModule.default
    bridgeModule.default = null
    try {
      expect(await pushPromptDue()).toBe(false)
      expect(await requestNotificationPermission(true)).toBe(false)
      expect(await RNFS.exists(ASKED)).toBe(false)
    } finally {
      bridgeModule.default = saved
    }
  })

  test('Android below 13 is never due, since install granted it', async () => {
    setPlatform('android', 32)
    expect(await pushPromptDue()).toBe(false)
  })

  test('a granted permission is not due', async () => {
    setPlatform('android', 34)
    ;(PermissionsAndroid.check as unknown as jest.Mock) = jest.fn(async () => true)
    expect(await pushPromptDue()).toBe(false)
  })

  test('without a custom domain it is not due, since nothing would be registered', async () => {
    setPlatform('android', 34)
    getBreezLnurlDomain.mockReturnValue(undefined)
    expect(await pushPromptDue()).toBe(false)
  })

  test('a wallet held by a deletion is not due, and its permission is not even read', async () => {
    setPlatform('ios', 26)
    await writeDeletionMark('primary', { pubkey: PUB, state: 'asked', askedAt: 1_800_000_000 })
    try {
      expect(await pushPromptDue()).toBe(false)
      expect(hasPermission).not.toHaveBeenCalled()
      expect(PermissionsAndroid.check).not.toHaveBeenCalled()
    } finally {
      await clearDeletionMark('primary')
    }
  })

  test('iOS before any answer is due', async () => {
    setPlatform('ios', 26)
    jest.mocked(hasPermission).mockResolvedValueOnce(AuthorizationStatus.NOT_DETERMINED)
    expect(await pushPromptDue()).toBe(true)
    expect(bridge.requestAuthorization).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
  })

  test.each([
    ['refused', AuthorizationStatus.DENIED],
    ['allowed', AuthorizationStatus.AUTHORIZED],
    ['provisional', AuthorizationStatus.PROVISIONAL],
  ])('iOS after a %s answer is not due', async (_name, status) => {
    setPlatform('ios', 26)
    jest.mocked(hasPermission).mockResolvedValueOnce(status)
    expect(await pushPromptDue()).toBe(false)
  })

  test('a platform without push is never due', async () => {
    setPlatform('web', 0)
    expect(await pushPromptDue()).toBe(false)
  })

  // The mark is what the dialog leaves behind, so only a call that may show it writes one.
  test('only a call that may show the dialog writes the mark', async () => {
    setPlatform('android', 34)
    await ensurePushRegistered(false)
    expect(await RNFS.exists(ASKED)).toBe(false)
    setPlatform('ios', 26)
    device.answer = 'denied'
    await ensurePushRegistered(true)
    expect(await RNFS.exists(ASKED)).toBe(true)
  })
})

// firebase.json starts Firebase Messaging switched off, so a fresh install is unknown to Firebase
// until notifications are allowed. These hold where it is switched on, and that nothing before an
// allowed answer switches it on, registers with APNs or asks for a token.
describe('Firebase starts only after notifications are allowed', () => {
  const PUB_KEY = '02'.padEnd(66, 'a')

  beforeEach(() => {
    jest.requireMock('../src/wallet/spark').sparkGetIdentityPubkey.mockResolvedValue(PUB_KEY)
  })

  function expectFirebaseUntouched() {
    expect(setAutoInitEnabled).not.toHaveBeenCalled()
    expect(bridge.registerForRemoteNotifications).not.toHaveBeenCalled()
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(device.uikitRegistrations).toBe(0)
    expect(getAPNSToken).not.toHaveBeenCalled()
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  }

  function order(fn: unknown): number {
    return (fn as jest.Mock).mock.invocationCallOrder[0]
  }

  test.each([
    ['allowed', 'authorized'],
    ['provisional', 'provisional'],
  ] as const)('iOS %s: switched on, registered with APNs, then the token, then the gateway', async (_name, status) => {
    setPlatform('ios', 26)
    device.answer = status

    expect(await ensurePushRegistered()).toBe(true)

    expect(setAutoInitEnabled).toHaveBeenCalledTimes(1)
    expect(jest.mocked(setAutoInitEnabled).mock.calls[0][1]).toBe(true)
    expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
    expect(requestPermission).not.toHaveBeenCalled()
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(order(bridge.requestAuthorization)).toBeLessThan(order(setAutoInitEnabled))
    expect(order(setAutoInitEnabled)).toBeLessThan(order(bridge.registerForRemoteNotifications))
    expect(order(bridge.registerForRemoteNotifications)).toBeLessThan(order(getAPNSToken))
    expect(order(getAPNSToken)).toBeLessThan(order(getToken))
    expect(order(getToken)).toBeLessThan(order(fetchMock))
  })

  test('iOS silent mode for an owner who already allowed switches it on the same way', async () => {
    setPlatform('ios', 26)
    jest.mocked(hasPermission).mockResolvedValueOnce(AuthorizationStatus.AUTHORIZED)

    expect(await ensurePushRegistered(false)).toBe(true)

    expect(bridge.requestAuthorization).not.toHaveBeenCalled()
    expect(requestPermission).not.toHaveBeenCalled()
    expect(jest.mocked(setAutoInitEnabled).mock.calls).toEqual([[expect.anything(), true]])
    expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
    expect(order(bridge.registerForRemoteNotifications)).toBeLessThan(order(getToken))
  })

  // RNFB's requestPermission registers with APNs after any answer, which is what makes a refusal
  // reach Firebase on an iPhone; the bridge asks without registering.
  test.each([
    ['refused', 'denied'],
    ['undecided', 'notDetermined'],
    ['ephemeral', 'ephemeral'],
  ] as const)('iOS %s at the prompt leaves Firebase untouched and never registers with APNs', async (_name, status) => {
    setPlatform('ios', 26)
    device.answer = status

    expect(await ensurePushRegistered()).toBe(false)
    expect(bridge.requestAuthorization).toHaveBeenCalledTimes(1)
    expectFirebaseUntouched()
  })

  test.each([
    ['refused', AuthorizationStatus.DENIED],
    ['undecided', AuthorizationStatus.NOT_DETERMINED],
  ])('iOS %s in silent mode leaves Firebase untouched', async (_name, status) => {
    setPlatform('ios', 26)
    jest.mocked(hasPermission).mockResolvedValueOnce(status)

    expect(await ensurePushRegistered(false)).toBe(false)
    expectFirebaseUntouched()
  })

  test('Android 13 and later, allowed: switched on, then the token, with no APNs call', async () => {
    setPlatform('android', 34)

    expect(await ensurePushRegistered()).toBe(true)

    expect(jest.mocked(setAutoInitEnabled).mock.calls).toEqual([[expect.anything(), true]])
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(order(PermissionsAndroid.request)).toBeLessThan(order(setAutoInitEnabled))
    expect(order(setAutoInitEnabled)).toBeLessThan(order(getToken))
    expect(order(getToken)).toBeLessThan(order(fetchMock))
  })

  test.each(['denied', 'never_ask_again'])(
    'Android 13 and later, %s at the prompt, leaves Firebase untouched',
    async answer => {
      setPlatform('android', 34)
      ;(PermissionsAndroid.request as unknown as jest.Mock).mockResolvedValue(answer)

      expect(await ensurePushRegistered()).toBe(false)
      expectFirebaseUntouched()
    },
  )

  test('Android 13 and later, silent mode before any grant, leaves Firebase untouched', async () => {
    setPlatform('android', 34)
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.DENIED)

    expect(await ensurePushRegistered(false)).toBe(false)
    expectFirebaseUntouched()
  })

  // Install grants notifications below Android 13, so the registration still follows the first
  // connection without a dialog; the switch is the one call added in front of the token.
  test.each([true, false])('Android 12 and earlier (prompt %s): switched on with no dialog', async prompt => {
    setPlatform('android', 32)
    jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

    expect(await ensurePushRegistered(prompt)).toBe(true)

    expect(PermissionsAndroid.request).not.toHaveBeenCalled()
    expect(hasPermission).toHaveBeenCalled()
    expect(jest.mocked(setAutoInitEnabled).mock.calls).toEqual([[expect.anything(), true]])
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(order(setAutoInitEnabled)).toBeLessThan(order(getToken))
    expect(order(getToken)).toBeLessThan(order(fetchMock))
  })

  // Android has no implementation of the bridge, and its token needs no APNs.
  test.each([[34, true], [34, false], [32, true]] as const)(
    'Android %i (prompt %s) never reaches the iOS bridge or the APNs token',
    async (version, prompt) => {
      setPlatform('android', version)
      jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

      expect(await ensurePushRegistered(prompt)).toBe(true)
      expect(bridge.requestAuthorization).not.toHaveBeenCalled()
      expect(bridge.registerForRemoteNotifications).not.toHaveBeenCalled()
      expect(getAPNSToken).not.toHaveBeenCalled()
    },
  )

  test('reading whether the prompt is due never touches Firebase', async () => {
    for (const [os, version] of [['ios', 26], ['android', 34], ['android', 32]] as const) {
      setPlatform(os, version)
      await pushPromptDue()
    }
    expect(bridge.requestAuthorization).not.toHaveBeenCalled()
    expect(setAutoInitEnabled).not.toHaveBeenCalled()
    expect(bridge.registerForRemoteNotifications).not.toHaveBeenCalled()
    expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
    expect(device.uikitRegistrations).toBe(0)
    expect(getToken).not.toHaveBeenCalled()
  })

  test('a failed switch sends nothing to the gateway', async () => {
    setPlatform('android', 34)
    jest.mocked(setAutoInitEnabled).mockRejectedValueOnce(new Error('no play services'))

    await expect(ensurePushRegistered()).rejects.toThrow('no play services')
    expect(getToken).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  describe('iOS, waiting for the APNs token', () => {
    beforeEach(() => {
      setPlatform('ios', 26)
      jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    async function settled<T>(work: Promise<T>): Promise<T> {
      await jest.advanceTimersByTimeAsync(15_000)
      return work
    }

    // The last registration sent. A forget the same run queued for a secret it retired can follow it.
    function sentBody(): Record<string, unknown> {
      const calls = fetchMock.mock.calls.filter(call => !String(call[0]).endsWith('/api/device/forget'))
      const call = calls[calls.length - 1]
      return JSON.parse((call[1] as { body: string }).body)
    }

    function unregistered(): Error {
      return Object.assign(new Error('[messaging/unregistered] not yet'), { code: 'messaging/unregistered' })
    }

    // On a later launch UIKit still says registered and FIRMessaging has no APNs token. RNFB's own
    // registration returns early there, so a start that relied on it would find no token.
    test('a silent start in a later process registers with APNs again and gets the token', async () => {
      device.registered = true
      notifications.relaunch()
      jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)

      expect(await settled(ensurePushRegistered(false))).toBe(true)

      expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
      expect(registerDeviceForRemoteMessages).not.toHaveBeenCalled()
      expect(order(bridge.registerForRemoteNotifications)).toBeLessThan(order(getToken))
      expect(sentBody().token).toBe('fcm-token-from-device')
    })

    test('a wallet switch in a later process points the gateway at the new wallet', async () => {
      jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
      expect(await settled(ensurePushRegistered(false))).toBe(true)
      expect(sentBody().pubkey).toBe(PUB_KEY)

      notifications.relaunch()
      jest.clearAllMocks()
      const other = '03'.padEnd(66, 'c')
      jest.requireMock('../src/wallet/spark').sparkGetIdentityPubkey.mockResolvedValue(other)

      expect(await settled(ensurePushRegistered(false))).toBe(true)
      expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
      expect(order(bridge.registerForRemoteNotifications)).toBeLessThan(order(getToken))
      expect(sentBody().pubkey).toBe(other)
      expect((await loadRegistration())?.pubkey).toBe(other)
    })

    // On a fresh install the read is refused until the first registration completes, then answers
    // null until the token arrives. getToken asked before that is declined by FIRMessaging.
    test('getToken waits until the APNs token has arrived', async () => {
      device.answer = 'authorized'
      device.delivers = null
      jest
        .mocked(getAPNSToken)
        .mockRejectedValueOnce(unregistered())
        .mockImplementationOnce(async () => {
          device.registered = true
          return null
        })
        .mockImplementationOnce(async () => {
          device.apnsToken = notifications.APNS_TOKEN
          return device.apnsToken
        })

      expect(await settled(ensurePushRegistered())).toBe(true)

      expect(getAPNSToken).toHaveBeenCalledTimes(3)
      expect(order(getToken)).toBeGreaterThan(jest.mocked(getAPNSToken).mock.invocationCallOrder[2])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('an APNs token that never arrives sends nothing, and the next start tries again', async () => {
      device.answer = 'authorized'
      device.delivers = null

      expect(await settled(ensurePushRegistered())).toBe(false)
      expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(1)
      expect(getAPNSToken).toHaveBeenCalledTimes(40)
      expect(getToken).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()

      device.delivers = notifications.APNS_TOKEN
      jest.mocked(hasPermission).mockResolvedValue(AuthorizationStatus.AUTHORIZED)
      expect(await settled(ensurePushRegistered(false))).toBe(true)
      expect(bridge.registerForRemoteNotifications).toHaveBeenCalledTimes(2)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    test('a read of the APNs token that fails otherwise stops the start and sends nothing', async () => {
      device.answer = 'authorized'
      jest.mocked(getAPNSToken).mockRejectedValueOnce(new Error('bridge gone'))

      await expect(ensurePushRegistered()).rejects.toThrow('bridge gone')
      expect(getToken).not.toHaveBeenCalled()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})

// The gateway marks every secret a forget named and refuses a registration with it, 410 `forgotten`,
// whichever of the two reached it first. The app raises nothing, retires the secret if it still holds
// it, and the next connect registers a fresh one.
describe('a registration refused as forgotten', () => {
  const STATE = 'com.voltz.wallet.pushwebhook.w1'

  beforeEach(() => {
    jest.requireMock('../src/wallet/spark').sparkGetIdentityPubkey.mockResolvedValue(PUB)
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  })

  // Every secret a registration carried, in the order sent.
  function secretsSent(): string[] {
    return fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/api/device'))
      .map(call => JSON.parse((call[1] as { body: string }).body).webhookSecret as string)
  }

  // A gateway whose next registration is refused as forgotten, after `meanwhile` ran, and that
  // accepts every request after it.
  function refuseNextRegistration(meanwhile: () => void = () => undefined) {
    let refused = false
    fetchMock.mockImplementation(async (url: string) => {
      if (!refused && url.endsWith('/api/device')) {
        refused = true
        meanwhile()
        return { ok: false, status: 410, json: async () => ({ error: 'forgotten' }) }
      }
      return { ok: true, status: 200, json: async () => ({ registered: true, webhookId: 'AbCdEfGhIjKlMnOpQrStUv' }) }
    })
  }

  test('raises nothing, retires the secret, and the next connect registers a fresh one', async () => {
    refuseNextRegistration()

    await expect(ensurePushRegistered()).resolves.toBe(false)
    const [forgotten] = secretsSent()
    expect(forgotten).toMatch(/^[0-9a-f]{64}$/)
    expect(await loadWebhookState('w1')).toBeNull()
    expect(await loadRegistration()).toBeNull()

    await expect(ensurePushRegistered()).resolves.toBe(true)
    const sent = secretsSent()
    expect(sent).toHaveLength(2)
    expect(sent[1]).not.toBe(forgotten)
    expect(await loadWebhookState('w1')).toEqual({
      secret: sent[1],
      webhookId: 'AbCdEfGhIjKlMnOpQrStUv',
      pubkey: PUB,
    })
  })

  test('leaves a secret drawn after the one refused, which is another registration', async () => {
    const drawn = 'e'.repeat(64)
    refuseNextRegistration(() => keychain.set(STATE, JSON.stringify({ secret: drawn, pubkey: PUB })))

    await expect(ensurePushRegistered()).resolves.toBe(false)

    expect(secretsSent()[0]).not.toBe(drawn)
    expect(await loadWebhookState('w1')).toEqual({ secret: drawn, pubkey: PUB })
  })
})
