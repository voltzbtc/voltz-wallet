import { readFileSync } from 'fs'
import { join } from 'path'
import { PermissionsAndroid, Platform } from 'react-native'
import * as Keychain from 'react-native-keychain'
import { Camera } from 'react-native-vision-camera'
import { launchCamera, launchImageLibrary } from 'react-native-image-picker'
import { enableBiometricUnlock, passesDeviceCheck, unlockWithBiometrics } from '../src/wallet/biometrics'
import { pickFullImage, pickWalletImage, takeWalletPhoto } from '../src/wallet/walletImage'
import { requestNotificationPermission } from '../src/wallet/pushToken'
import { buy } from '../src/wallet/store'
import { __setPasskeyLiveForTests, passkeyAttempt } from '../src/wallet/passkey'
import { RELOCK_AFTER_OWN_MS } from '../src/wallet/relock'

// Every prompt and picker the app starts runs inside the bracket the native side reads, so the pause
// Android makes under it is timed against the longer limit of src/wallet/relock.ts. Each
// native call here records the bracket's depth at the moment it runs.

jest.mock('react-native-image-picker', () => ({ launchImageLibrary: jest.fn(), launchCamera: jest.fn() }))
jest.mock('react-native-vision-camera', () => ({
  Camera: { getCameraPermissionStatus: jest.fn(), requestCameraPermission: jest.fn() },
}))

const device: { ownDepth: number } = jest.requireMock('../specs/NativeVoltzPrivacy').device
const storeDouble: { control: { scriptBuy: (script: () => unknown) => void } } =
  jest.requireMock('../specs/NativeVoltzStore')

// Answers like the native call it stands for, noting how deep the bracket was when it ran.
function seen<T>(answer: T): { depths: number[]; call: () => Promise<T> } {
  const depths: number[] = []
  return {
    depths,
    call: async () => {
      depths.push(device.ownDepth)
      return answer
    },
  }
}

const PHOTO = { assets: [{ uri: 'file:///cache/photo.jpg', width: 10, height: 10 }] }

beforeEach(() => {
  jest.clearAllMocks()
})

test('the biometric prompt that unlocks, the one that enables and the device check each run inside it', async () => {
  const read = seen({ username: 'pin', password: '123456' } as never)
  jest.mocked(Keychain.getGenericPassword).mockImplementation(read.call)
  await unlockWithBiometrics('Unlock')
  expect(read.depths[0]).toBe(1)

  const write = seen(false as never)
  jest.mocked(Keychain.setGenericPassword).mockImplementation(write.call)
  await enableBiometricUnlock('123456', { title: 'Use Face ID', cancel: 'Cancel' })
  expect(write.depths).toEqual([1])

  jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(true)
  const check = seen({ username: 'check', password: 'check' } as never)
  jest.mocked(Keychain.setGenericPassword).mockImplementation(check.call)
  jest.mocked(Keychain.getGenericPassword).mockImplementation(check.call)
  expect(await passesDeviceCheck({ title: 'Confirm', cancel: 'Cancel' })).toBe(true)
  expect(check.depths).toEqual([1, 1])
  expect(device.ownDepth).toBe(0)
})

test('a cancelled prompt closes the bracket', async () => {
  jest.mocked(Keychain.getGenericPassword).mockRejectedValue(new Error('cancelled'))
  expect(await unlockWithBiometrics('Unlock')).toBe(false)
  expect(device.ownDepth).toBe(0)
})

test('the photo pickers, the camera and its permission dialog each run inside it', async () => {
  const library = seen(PHOTO)
  jest.mocked(launchImageLibrary).mockImplementation(library.call as never)
  await pickWalletImage()
  await pickFullImage()
  expect(library.depths).toEqual([1, 1])

  jest.mocked(Camera.getCameraPermissionStatus).mockReturnValue('not-determined')
  const permission = seen('granted' as const)
  jest.mocked(Camera.requestCameraPermission).mockImplementation(permission.call)
  const camera = seen(PHOTO)
  jest.mocked(launchCamera).mockImplementation(camera.call as never)
  await takeWalletPhoto()
  expect(permission.depths).toEqual([1])
  expect(camera.depths).toEqual([1])
  expect(device.ownDepth).toBe(0)
})

test("Android's notification permission dialog runs inside it", async () => {
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })
  Object.defineProperty(Platform, 'Version', { value: 34, configurable: true })
  try {
    const dialog = seen('granted' as const)
    ;(PermissionsAndroid.request as unknown as jest.Mock) = jest.fn(dialog.call)
    expect(await requestNotificationPermission()).toBe(true)
    expect(dialog.depths).toEqual([1])
    expect(device.ownDepth).toBe(0)
  } finally {
    Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true })
  }
})

test("the store's purchase sheet runs inside it", async () => {
  const sheet = seen({ status: 'cancelled' })
  storeDouble.control.scriptBuy(sheet.call)
  await buy('name_year' as never, { reference: 'ref' })
  expect(sheet.depths).toEqual([1])
  expect(device.ownDepth).toBe(0)
})

test('the passkey sheet runs inside it, for the create and for the sign-in after it', async () => {
  const auth = (
    jest.requireMock('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider') as {
      __authenticator: typeof import('../__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider').__authenticator
    }
  ).__authenticator
  auth.reset()
  // Without PRF at create the SDK runs a second ceremony to derive, so both pass through the bridge.
  auth.prfAtCreate = false
  // Each ceremony waits on the gate while its sheet is up, which is where the depth is read.
  const depths: number[] = []
  auth.gate = {
    then: (resolve: (value: unknown) => void) => {
      depths.push(device.ownDepth)
      resolve(undefined)
    },
  } as Promise<unknown>
  __setPasskeyLiveForTests(true)
  try {
    await passkeyAttempt('register')()
  } finally {
    __setPasskeyLiveForTests(false)
    auth.reset()
  }
  expect(depths).toEqual([1, 1])
  expect(device.ownDepth).toBe(0)
})

// Android covers a return from such a trip natively, before the JS side decides, at the same figure the
// JS side locks at; a cover past the lock's limit would show the wallet for a frame first.
test("the native cover for a trip from the app's own activity starts where the lock does", () => {
  const kotlin = readFileSync(
    join(__dirname, '../android/app/src/main/java/app/usevoltz/privacy/PrivacyCover.kt'),
    'utf8',
  )
  const figure = /OWN_LOCK_AFTER_MS = ([\d_]+)L/.exec(kotlin)?.[1]
  expect(Number(figure?.replace(/_/g, ''))).toBe(RELOCK_AFTER_OWN_MS)
})

// A destroyed activity gets none of the callbacks an open bracket waits for (a picker's result, a
// prompt's answer), so its release closes every bracket still open; one left open would time every
// later trip against the longer limit and raise no cover on the way out.
test('a destroyed activity closes every bracket still open', () => {
  const kotlin = readFileSync(
    join(__dirname, '../android/app/src/main/java/app/usevoltz/privacy/PrivacyCover.kt'),
    'utf8',
  )
  const code = kotlin.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  const release = /fun release\(activity: Activity\) \{([\s\S]*?)\n {2}\}/.exec(code)?.[1]
  expect(release).toBeDefined()
  expect(release).toMatch(/synchronized\(stamp\) \{\s*ownDepth = 0\s*\}/)
})
