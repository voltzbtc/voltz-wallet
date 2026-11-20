import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import { verifyPin } from './pin'
import { asOwnActivity } from './relock'

// Biometric unlock stores a copy of the app PIN behind a biometric-gated Keychain
// entry; on success the released PIN is verified against the canonical one. The PIN is
// gated rather than the seed because the SDK reads the seed on every balance refresh,
// which would pop biometrics each time. The PIN keypad remains as the fallback.
const SERVICE = 'com.voltz.wallet.biometric'

export type BiometryKind = 'face' | 'fingerprint' | null

// Collapses the platform biometry enum into what the UI needs for icon and label. Face auth
// maps to 'face', everything else (Touch ID, fingerprint, iris) to 'fingerprint'. null
// means no biometric hardware or enrollment.
export async function getBiometryKind(): Promise<BiometryKind> {
  const type = await Keychain.getSupportedBiometryType()
  if (type === null) {
    return null
  }
  if (type === Keychain.BIOMETRY_TYPE.FACE_ID || type === Keychain.BIOMETRY_TYPE.FACE) {
    return 'face'
  }
  return 'fingerprint'
}

// Existence check only; does not trigger a biometric prompt.
export async function isBiometricUnlockEnabled(): Promise<boolean> {
  return Keychain.hasGenericPassword({ service: SERVICE })
}

// On Android the write itself raises the system prompt, since the entry's key opens only within five
// seconds of a strong biometric or the device's own lock, so a cancelled prompt rejects and nothing
// is stored. The prompt's wording comes from the caller; without one the library shows its own
// English default. iOS stores without asking.
export async function enableBiometricUnlock(
  pin: string,
  prompt?: { title: string; cancel: string },
): Promise<void> {
  // The prompt is the app's own, so a trip that begins under it on Android raises no cover and is
  // timed against ten minutes instead of two.
  await asOwnActivity(() =>
    Keychain.setGenericPassword('pin', pin, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      // BIOMETRY_ANY (not CURRENT_SET) so it survives enrolling a new face/finger.
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY,
      ...(prompt && { authenticationPrompt: prompt }),
    }),
  )
}

export async function disableBiometricUnlock(): Promise<void> {
  await Keychain.resetGenericPassword({ service: SERVICE })
}

// Re-verifying the released PIN guards against a stale copy left by a PIN change.
// Cancel or failure resolves to false rather than throwing.
export async function unlockWithBiometrics(prompt: string, cancel?: string): Promise<boolean> {
  try {
    // The prompt over the lock is the app's own, so a pause under it is timed against ten minutes
    // instead of two, and one answered within that does not lock again under the unlock it is
    // completing.
    const creds = await asOwnActivity(() =>
      Keychain.getGenericPassword({
        service: SERVICE,
        authenticationPrompt: cancel ? { title: prompt, cancel } : { title: prompt },
      }),
    )
    return creds !== false && (await verifyPin(creds.password))
  } catch {
    return false
  }
}

// A throwaway entry behind the device's own lock, written and read to raise the system's check.
const OWNER_CHECK = 'com.voltz.wallet.ownerCheck'

// Whether the person holding the phone passes the device's own lock, for an action the app's PIN cannot
// guard because the PIN is what was forgotten. The prompt is the system's. A cancel and a failure both
// answer false, and nothing retries by itself. A device with no lock answers true, as there is nothing
// to ask, while a read of that which fails says nothing about the lock, so it answers false. Android
// below 11 reports no lock whatever is set (DeviceAvailability.isDevicePasscodeAvailable in
// react-native-keychain), so it takes the first path.
export async function passesDeviceCheck(prompt: { title: string; cancel: string }): Promise<boolean> {
  const lockSet = await Keychain.isPasscodeAuthAvailable().catch(() => null)
  if (lockSet !== true) {
    return lockSet === false
  }
  try {
    // The device's own lock screen is the app's prompt here, which Android shows as an activity.
    const read = await asOwnActivity(async () => {
      await Keychain.setGenericPassword('check', 'check', {
        service: OWNER_CHECK,
        accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
        accessControl: Keychain.ACCESS_CONTROL.DEVICE_PASSCODE,
        authenticationPrompt: prompt,
      })
      return Keychain.getGenericPassword({
        service: OWNER_CHECK,
        accessControl: Keychain.ACCESS_CONTROL.DEVICE_PASSCODE,
        authenticationPrompt: prompt,
      })
    })
    return read !== false
  } catch {
    return false
  } finally {
    await Keychain.resetGenericPassword({ service: OWNER_CHECK }).catch(() => undefined)
  }
}

// Whether this device was offered biometric unlock. A plain file, since it is no secret, written as
// the offer shows rather than when it is answered, so closing the app on the offer still counts as
// the one time.
const OFFERED = `${RNFS.DocumentDirectoryPath}/biometric-offer.json`

export async function markBiometricOffered(): Promise<void> {
  await RNFS.writeFile(OFFERED, JSON.stringify({ offered: true }), 'utf8')
}

// What to offer after a keypad unlock, which is how an install whose PIN came before the offer meets
// it: null once offered on this device, while biometric unlock is on, or without enrolled biometry.
// The offer is marked as made before it is returned, and any failure answers null, so the unlock
// never waits on more than these reads.
export async function biometricOfferAfterUnlock(): Promise<NonNullable<BiometryKind> | null> {
  try {
    if ((await RNFS.exists(OFFERED)) || (await isBiometricUnlockEnabled())) {
      return null
    }
    const kind = await getBiometryKind()
    if (!kind) {
      return null
    }
    await markBiometricOffered()
    return kind
  } catch {
    return null
  }
}
