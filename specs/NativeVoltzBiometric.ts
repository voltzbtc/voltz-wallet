import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of biometric unlock on Android, whose one reader is src/wallet/biometrics.ts. iOS
// has no such module and keeps the PIN copy in the Keychain behind BiometryCurrentSet.
//
// react-native-keychain (10 and 11) makes every authenticated key time-bound: usable for five seconds
// after any strong biometric or device credential, the lock screen's unlock included, and it decrypts
// before it prompts. A person who knows the phone's passcode would then open the wallet without the
// app's PIN. This module's key opens for one operation at a time, and only for a strong biometric
// checked by the prompt that carries that operation (BiometricPrompt.CryptoObject); a change to the
// enrolled biometrics invalidates it. The pattern is the one Android's biometric guide gives for a
// key bound to the prompt, and the one Blockstream Green uses (AndroidKeystore.kt).
//
// Rejections carry a code: E_CANCELLED (the person closed the prompt), E_INVALIDATED (the enrolled
// biometrics changed, or the sealed bytes are not the key's, and the entry is already gone),
// E_UNAVAILABLE (no strong biometric enrolled, no screen lock, or no activity in front to show the
// prompt over) and E_FAILED (any other failure, which keeps the entry).
export interface Spec extends TurboModule {
  // Writes `secret` under a new key after a strong biometric on the prompt, replacing any entry.
  enroll(secret: string, title: string, cancel: string): Promise<void>
  // The secret after a strong biometric on the prompt, or null when there is no entry.
  reveal(title: string, cancel: string): Promise<string | null>
  // Whether an entry exists, without a prompt.
  isEnrolled(): Promise<boolean>
  // Deletes the entry and its key.
  remove(): Promise<void>
}

// `get`, not `getEnforcing`: iOS has no such module, and a binary without it offers no biometric unlock.
export default TurboModuleRegistry.get<Spec>('NativeVoltzBiometric')
