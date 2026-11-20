import { Platform } from 'react-native'
import * as Keychain from 'react-native-keychain'
import RNFS from 'react-native-fs'
import NativeBiometric from '../../specs/NativeVoltzBiometric'
import { verifyPin } from './pin'
import { asOwnActivity } from './relock'

// Biometric unlock stores a copy of the app PIN that only a biometric releases; on success the
// released PIN is verified against the canonical one. The PIN is gated rather than the seed because
// the SDK reads the seed on every balance refresh, which would pop biometrics each time. The PIN
// keypad remains as the fallback.
//
// The PIN exists so that a phone that is unlocked, or whose passcode someone knows, does not open the
// wallet, so nothing that the device's own passcode can do may release the copy:
// - iOS keeps it in the Keychain behind BiometryCurrentSet, which a face or finger enrolled after it
//   (and enrolling needs only the passcode) does not open.
// - Android keeps it under a key of the app's own module (specs/NativeVoltzBiometric.ts) that opens
//   for one operation at a time after a strong biometric on the prompt, never in a window after the
//   lock screen's unlock, and that a new enrollment invalidates. react-native-keychain cannot make such
//   a key.
const SERVICE = 'com.voltz.wallet.biometric.currentSet'

// The entry every version before this wrote: BiometryAny on iOS, and on Android a key that opened for
// five seconds after any unlock of the phone. It is never read again, only removed, and a wallet that
// had it is offered biometric unlock again after its next keypad unlock.
const LEGACY_SERVICE = 'com.voltz.wallet.biometric'

const android = (): boolean => Platform.OS === 'android'

export type BiometryKind = 'face' | 'fingerprint' | null

// Collapses the platform biometry enum into what the UI needs for icon and label. Face auth
// maps to 'face', everything else (Touch ID, fingerprint, iris) to 'fingerprint'. null
// means no biometric hardware or enrollment, and on Android no module to keep the entry.
export async function getBiometryKind(): Promise<BiometryKind> {
  if (android() && !NativeBiometric) {
    return null
  }
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
  if (android()) {
    return NativeBiometric ? NativeBiometric.isEnrolled() : false
  }
  return Keychain.hasGenericPassword({ service: SERVICE })
}

// On Android the write itself raises the system prompt, since the entry's key works only for an
// operation a strong biometric authorized, so a cancelled prompt rejects and nothing is stored. The
// prompt's wording comes from the caller, which Android needs. iOS stores without asking.
export async function enableBiometricUnlock(
  pin: string,
  prompt?: { title: string; cancel: string },
): Promise<void> {
  await retireLegacyEntry()
  if (android()) {
    if (!NativeBiometric || !prompt) {
      throw new Error('biometric unlock unavailable')
    }
    const native = NativeBiometric
    // The prompt is the app's own, so a trip that begins under it on Android raises no cover and is
    // timed against ten minutes instead of two.
    await asOwnActivity(() => native.enroll(pin, prompt.title, prompt.cancel))
    return
  }
  await asOwnActivity(() =>
    Keychain.setGenericPassword('pin', pin, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      // CURRENT_SET, so a face or finger enrolled later with the passcode does not release the PIN.
      // Such an enrollment leaves the entry unreadable, which unlockWithBiometrics clears.
      accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_CURRENT_SET,
      ...(prompt && { authenticationPrompt: prompt }),
    }),
  )
}

export async function disableBiometricUnlock(): Promise<void> {
  await retireLegacyEntry()
  if (android()) {
    await NativeBiometric?.remove()
    return
  }
  await Keychain.resetGenericPassword({ service: SERVICE })
}

// Whether an entry from an earlier version was there, which this removes.
async function retireLegacyEntry(): Promise<boolean> {
  if (!(await Keychain.hasGenericPassword({ service: LEGACY_SERVICE }))) {
    return false
  }
  await Keychain.resetGenericPassword({ service: LEGACY_SERVICE })
  return true
}

// Re-verifying the released PIN guards against a stale copy left by a PIN change.
// Cancel or failure resolves to false rather than throwing.
export async function unlockWithBiometrics(prompt: string, cancel?: string): Promise<boolean> {
  try {
    // The prompt over the lock is the app's own, so a pause under it is timed against ten minutes
    // instead of two, and one answered within that does not lock again under the unlock it is
    // completing.
    const pin = await asOwnActivity(() => releasePin(prompt, cancel))
    return pin !== null && (await verifyPin(pin))
  } catch {
    return false
  }
}

async function releasePin(prompt: string, cancel?: string): Promise<string | null> {
  if (android()) {
    // An entry whose key a new enrollment invalidated rejects, and the module has removed it.
    return NativeBiometric && cancel ? NativeBiometric.reveal(prompt, cancel) : null
  }
  const creds = await Keychain.getGenericPassword({
    service: SERVICE,
    authenticationPrompt: cancel ? { title: prompt, cancel } : { title: prompt },
  })
  if (creds === false) {
    // An entry that is gone, or that a change to the enrolled biometrics made unreadable. Removing it
    // turns the switch off rather than leave a prompt that can never answer.
    await Keychain.resetGenericPassword({ service: SERVICE })
    return null
  }
  return creds.password
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
// it, and how one whose entry an earlier version wrote gets it back: null once offered on this
// device, while biometric unlock is on, or without enrolled biometry. The offer is marked as made
// before it is returned, and any failure answers null, so the unlock never waits on more than these
// reads.
export async function biometricOfferAfterUnlock(): Promise<NonNullable<BiometryKind> | null> {
  try {
    // A wallet that had the earlier entry chose biometric unlock already, so it is asked again.
    const retired = await retireLegacyEntry()
    if ((!retired && (await RNFS.exists(OFFERED))) || (await isBiometricUnlockEnabled())) {
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
