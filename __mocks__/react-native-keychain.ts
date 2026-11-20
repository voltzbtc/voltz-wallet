export const setGenericPassword = jest.fn(async () => false as const)
export const getGenericPassword = jest.fn(async () => false as const)
export const hasGenericPassword = jest.fn(async () => false)
export const resetGenericPassword = jest.fn(async () => true)
export const getAllGenericPasswordServices = jest.fn(async (): Promise<string[]> => [])
export const getSupportedBiometryType = jest.fn(async (): Promise<string | null> => null)
export const isPasscodeAuthAvailable = jest.fn(async () => false)

export const ACCESSIBLE = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'AccessibleWhenUnlockedThisDeviceOnly',
} as const

export const ACCESS_CONTROL = {
  BIOMETRY_ANY: 'BiometryAny',
  BIOMETRY_CURRENT_SET: 'BiometryCurrentSet',
  DEVICE_PASSCODE: 'DevicePasscode',
} as const

export const BIOMETRY_TYPE = {
  TOUCH_ID: 'TouchID',
  FACE_ID: 'FaceID',
  FINGERPRINT: 'Fingerprint',
  FACE: 'Face',
  IRIS: 'Iris',
} as const
