import * as Keychain from 'react-native-keychain'
import {
  getBiometryKind,
  isBiometricUnlockEnabled,
  enableBiometricUnlock,
  disableBiometricUnlock,
  unlockWithBiometrics,
  biometricOfferAfterUnlock,
  passesDeviceCheck,
} from '../src/wallet/biometrics'
import RNFS from 'react-native-fs'
import { Platform } from 'react-native'
import NativeBiometric from '../specs/NativeVoltzBiometric'

// The Android module, held in memory: an entry exists after an enroll the prompt allowed, and a
// reveal answers what the prompt allows.
jest.mock('../specs/NativeVoltzBiometric', () => ({
  __esModule: true,
  default: {
    enroll: jest.fn(),
    reveal: jest.fn(),
    isEnrolled: jest.fn(),
    remove: jest.fn(),
  },
}))

const SERVICE = 'com.voltz.wallet.biometric.currentSet'
const LEGACY = 'com.voltz.wallet.biometric'

beforeEach(() => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

describe('getBiometryKind', () => {
  it('face for iOS Face ID', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID as never)
    expect(await getBiometryKind()).toBe('face')
  })

  it('face for Android face auth', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE as never)
    expect(await getBiometryKind()).toBe('face')
  })

  it('fingerprint for iOS Touch ID', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.TOUCH_ID as never)
    expect(await getBiometryKind()).toBe('fingerprint')
  })

  it('fingerprint for Android fingerprint', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT as never)
    expect(await getBiometryKind()).toBe('fingerprint')
  })

  it('null when there is no biometric hardware/enrollment', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null as never)
    expect(await getBiometryKind()).toBeNull()
  })
})

describe('enableBiometricUnlock', () => {
  it('stores the PIN behind the biometrics enrolled now, which one enrolled later with the passcode does not open', async () => {
    await enableBiometricUnlock('123456')
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'pin',
      '123456',
      expect.objectContaining({
        service: SERVICE,
        accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      }),
    )
  })
})

describe('isBiometricUnlockEnabled', () => {
  it('reads existence without triggering a biometric prompt', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
    expect(await isBiometricUnlockEnabled()).toBe(true)
    // Reading the value through getGenericPassword is what pops the biometric prompt.
    expect(Keychain.getGenericPassword).not.toHaveBeenCalled()
  })

  it('false when the entry does not exist', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
    expect(await isBiometricUnlockEnabled()).toBe(false)
  })
})

describe('unlockWithBiometrics', () => {
  it('true when the released PIN matches the canonical one', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await unlockWithBiometrics('Unlock')).toBe(true)
  })

  it('false when the released PIN is stale (differs from the canonical one)', async () => {
    // Keying the mock off the service lets the biometric entry hold a stale PIN while the canonical
    // entry holds the current one.
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
      const service = (options as { service?: string } | undefined)?.service
      return { password: service === SERVICE ? '111111' : '999999' } as never
    })
    expect(await unlockWithBiometrics('Unlock')).toBe(false)
  })

  it('false when biometrics is cancelled (returns false)', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await unlockWithBiometrics('Unlock')).toBe(false)
  })

  it('false and does not throw when the OS rejects', async () => {
    jest.mocked(Keychain.getGenericPassword).mockRejectedValue(new Error('user canceled'))
    await expect(unlockWithBiometrics('Unlock')).resolves.toBe(false)
  })
})

describe('disableBiometricUnlock', () => {
  it('resets the biometric entry', async () => {
    await disableBiometricUnlock()
    expect(Keychain.resetGenericPassword).toHaveBeenCalled()
  })
})

describe('biometricOfferAfterUnlock', () => {
  beforeEach(() => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FINGERPRINT as never)
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
  })

  it('answers the kind once, then null on this device', async () => {
    expect(await biometricOfferAfterUnlock()).toBe('fingerprint')
    expect(await biometricOfferAfterUnlock()).toBeNull()
  })

  it('null while biometric unlock is on, without marking the offer', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
    expect(await biometricOfferAfterUnlock()).toBeNull()
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
    expect(await biometricOfferAfterUnlock()).toBe('fingerprint')
  })

  it('null without enrolled biometry, without marking the offer', async () => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null as never)
    expect(await biometricOfferAfterUnlock()).toBeNull()
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID as never)
    expect(await biometricOfferAfterUnlock()).toBe('face')
  })

  it('null when a read fails or the mark cannot be written', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockRejectedValueOnce(new Error('keystore'))
    expect(await biometricOfferAfterUnlock()).toBeNull()
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'))
    try {
      expect(await biometricOfferAfterUnlock()).toBeNull()
    } finally {
      write.mockRestore()
    }
    expect(await biometricOfferAfterUnlock()).toBe('fingerprint')
  })
})

describe('passesDeviceCheck', () => {
  const prompt = { title: 'Confirm', cancel: 'Cancel' }

  beforeEach(() => {
    jest.mocked(Keychain.setGenericPassword).mockReset()
    jest.mocked(Keychain.getGenericPassword).mockReset()
    jest.mocked(Keychain.resetGenericPassword).mockReset()
    jest.mocked(Keychain.resetGenericPassword).mockResolvedValue(true)
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockReset()
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(true)
  })

  it('passes with no prompt on a device with no lock', async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockResolvedValue(false)
    expect(await passesDeviceCheck(prompt)).toBe(true)
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
    expect(Keychain.getGenericPassword).not.toHaveBeenCalled()
  })

  it('fails with no prompt when the read of the lock fails, which says nothing about the lock', async () => {
    jest.mocked(Keychain.isPasscodeAuthAvailable).mockRejectedValue(new Error('keychain unavailable'))
    expect(await passesDeviceCheck(prompt)).toBe(false)
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('passes when the entry behind the device lock reads back, and leaves no entry', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ username: 'check', password: 'check' } as never)
    expect(await passesDeviceCheck(prompt)).toBe(true)
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'check',
      'check',
      expect.objectContaining({ accessControl: 'DevicePasscode', authenticationPrompt: prompt }),
    )
    expect(Keychain.getGenericPassword).toHaveBeenCalledWith(
      expect.objectContaining({ accessControl: 'DevicePasscode', authenticationPrompt: prompt }),
    )
    expect(Keychain.resetGenericPassword).toHaveBeenCalledTimes(1)
  })

  it('fails when the prompt on the write is cancelled, as on Android', async () => {
    jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('cancelled'))
    expect(await passesDeviceCheck(prompt)).toBe(false)
    expect(Keychain.getGenericPassword).not.toHaveBeenCalled()
  })

  it('fails when the prompt on the read is cancelled, as on iOS, and leaves no entry', async () => {
    jest.mocked(Keychain.getGenericPassword).mockRejectedValue(new Error('cancelled'))
    expect(await passesDeviceCheck(prompt)).toBe(false)
    expect(Keychain.resetGenericPassword).toHaveBeenCalledTimes(1)
  })

  it('fails when the read answers nothing', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await passesDeviceCheck(prompt)).toBe(false)
  })
})

describe('on Android', () => {
  const native = jest.mocked(NativeBiometric!)
  const prompt = { title: 'Confirm your fingerprint', cancel: 'Cancel' }
  const original = Platform.OS

  beforeEach(() => {
    Platform.OS = 'android'
    native.enroll.mockResolvedValue(undefined)
    native.remove.mockResolvedValue(undefined)
    native.isEnrolled.mockResolvedValue(true)
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
    jest.mocked(Keychain.getGenericPassword).mockImplementation(async options =>
      (options as { service?: string } | undefined)?.service === 'com.voltz.wallet.pin'
        ? ({ password: '123456' } as never)
        : (false as never),
    )
  })

  afterEach(() => {
    Platform.OS = original
  })

  // react-native-keychain writes every authenticated entry under a key that opens for five seconds
  // after any unlock of the phone, the passcode included, and decrypts before it prompts.
  it('keeps the PIN with the app module and never in the Keychain', async () => {
    await enableBiometricUnlock('123456', prompt)
    expect(native.enroll).toHaveBeenCalledWith('123456', prompt.title, prompt.cancel)
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('unlocks with the PIN the prompt released, checked against the canonical one', async () => {
    native.reveal.mockResolvedValue('123456')
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(true)
    expect(native.reveal).toHaveBeenCalledWith('Unlock', 'Cancel')
    native.reveal.mockResolvedValue('111111')
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
    // No Keychain read stands in for the prompt.
    expect(Keychain.getGenericPassword).not.toHaveBeenCalledWith(expect.objectContaining({ service: LEGACY }))
  })

  it('does not unlock when the enrolled biometrics changed, nor when the prompt is cancelled', async () => {
    native.reveal.mockRejectedValueOnce(Object.assign(new Error('invalidated'), { code: 'E_INVALIDATED' }))
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
    native.reveal.mockRejectedValueOnce(Object.assign(new Error('cancelled'), { code: 'E_CANCELLED' }))
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
    native.reveal.mockResolvedValueOnce(null)
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
  })

  it('reads whether it is on from the module, without a prompt', async () => {
    expect(await isBiometricUnlockEnabled()).toBe(true)
    native.isEnrolled.mockResolvedValue(false)
    expect(await isBiometricUnlockEnabled()).toBe(false)
    expect(native.reveal).not.toHaveBeenCalled()
  })

  it('turning it off removes the module entry and any entry an earlier version wrote', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
    await disableBiometricUnlock()
    expect(native.remove).toHaveBeenCalled()
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: LEGACY })
  })
})

describe('an entry an earlier version wrote', () => {
  beforeEach(() => {
    jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(Keychain.BIOMETRY_TYPE.FACE_ID as never)
  })

  it('is never read: it does not count as on, and the unlock reads only the current entry', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => options?.service === LEGACY)
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await isBiometricUnlockEnabled()).toBe(false)
    await unlockWithBiometrics('Unlock', 'Cancel')
    for (const [options] of jest.mocked(Keychain.getGenericPassword).mock.calls) {
      expect((options as { service?: string } | undefined)?.service).not.toBe(LEGACY)
    }
  })

  it('is removed at the next keypad unlock, which offers biometric unlock again though it was offered', async () => {
    await RNFS.writeFile(`${RNFS.DocumentDirectoryPath}/biometric-offer.json`, '{"offered":true}', 'utf8')
    let legacy = true
    jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => options?.service === LEGACY && legacy)
    jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => {
      if (options?.service === LEGACY) {
        legacy = false
      }
      return true
    })
    expect(await biometricOfferAfterUnlock()).toBe('face')
    expect(legacy).toBe(false)
    expect(await biometricOfferAfterUnlock()).toBeNull()
  })
})

describe('an iOS entry that cannot be read', () => {
  it('is removed, so the switch shows off rather than prompting for nothing', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
    expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: SERVICE })
  })

  it('is kept when the face or finger did not match, which rejects', async () => {
    jest.mocked(Keychain.getGenericPassword).mockRejectedValue(new Error('code: -25293'))
    expect(await unlockWithBiometrics('Unlock', 'Cancel')).toBe(false)
    expect(Keychain.resetGenericPassword).not.toHaveBeenCalledWith({ service: SERVICE })
  })
})

describe('the Android module', () => {
  const { readFileSync, readdirSync, statSync } = require('fs')
  const { join, relative } = require('path')
  const ROOT = join(__dirname, '..')
  const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
  const sources = (dir: string): string[] =>
    readdirSync(join(ROOT, dir)).flatMap((name: string) => {
      const path = join(dir, name)
      return statSync(join(ROOT, path)).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
    })

  // A library's `implementation` stays off the app's compile classpath, so the app names the artifact
  // to compile against. It must be the one react-native-keychain ships, and it must not ship twice.
  it('compiles against the androidx.biometric react-native-keychain ships, at its version', () => {
    const shipped = /implementation '(androidx\.biometric:biometric:[^@']+)/.exec(
      read('node_modules/react-native-keychain/android/build.gradle'),
    )?.[1]
    expect(shipped).toBeDefined()
    const gradle = read('android/app/build.gradle').replace(/\/\/.*$/gm, '')
    expect(gradle).toContain(`compileOnly("${shipped}")`)
    expect(gradle.match(/androidx\.biometric/g)).toHaveLength(1)
  })

  it('is registered, and its key opens once per strong biometric and dies with a new enrollment', () => {
    expect(read('android/app/src/main/java/app/usevoltz/MainApplication.kt')).toContain(
      'add(NativeVoltzBiometricPackage())',
    )
    const module = read('android/app/src/main/java/app/usevoltz/biometric/NativeVoltzBiometricModule.kt')
    expect(module).toContain('setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)')
    expect(module).toContain('setUserAuthenticationValidityDurationSeconds(-1)')
    expect(module).toContain('setInvalidatedByBiometricEnrollment(true)')
    expect(module).toContain('BiometricPrompt.CryptoObject(cipher)')
    expect(module).toContain('.setAllowedAuthenticators(BIOMETRIC_STRONG)')
    expect(module).not.toMatch(/DEVICE_CREDENTIAL/)
  })

  it('has one reader', () => {
    expect(
      sources('src').filter(path => read(path).includes('specs/NativeVoltzBiometric')).map((p: string) => relative('.', p)),
    ).toEqual(['src/wallet/biometrics.ts'])
  })
})
