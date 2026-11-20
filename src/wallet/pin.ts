import * as Keychain from 'react-native-keychain'

// App access PIN, a second barrier on top of device unlock, so an already-unlocked
// phone does not grant wallet access. Stored unhashed in the Keychain (already
// encrypted) under a dedicated service, since anyone able to read the Keychain would
// also hold the seed, which is the real fund protection.
const SERVICE = 'com.voltz.wallet.pin'
const PIN_LENGTH = 6

export function validatePinFormat(pin: string): boolean {
  return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin)
}

export async function savePin(pin: string): Promise<void> {
  if (!validatePinFormat(pin)) {
    throw new Error('invalid pin')
  }
  await Keychain.setGenericPassword('pin', pin, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function hasPin(): Promise<boolean> {
  return (await Keychain.getGenericPassword({ service: SERVICE })) !== false
}

// The only way to take the PIN away, and only after no seed is left: a seed with no PIN opens at the
// PIN step, which would hand the wallet to whoever holds the phone (`eraseAllWallets`).
export async function deletePin(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
}

export async function verifyPin(pin: string): Promise<boolean> {
  const stored = await Keychain.getGenericPassword({ service: SERVICE })
  return stored !== false && stored.password === pin
}
