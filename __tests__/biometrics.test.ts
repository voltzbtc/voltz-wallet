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
  it('stores the PIN gated by biometrics', async () => {
    await enableBiometricUnlock('123456')
    expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
      'pin',
      '123456',
      expect.objectContaining({ accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY }),
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
      return { password: service === 'com.voltz.wallet.biometric' ? '111111' : '999999' } as never
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
