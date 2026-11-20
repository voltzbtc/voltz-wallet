import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the still image QR reader: Vision on iOS, ML Kit on Android. The native side
// relays what it read, raw, and src/wallet/qrImage.ts is the one reader that decides what it means, so
// the rule about a photo with two codes sits where Jest reaches it.

export interface Spec extends TurboModule {
  // Every QR code in the image at this URI that holds text, in the order the platform reports them.
  // Rejects with the platform's own message when the image cannot be read or the reader is not ready.
  decode(uri: string): Promise<ReadonlyArray<string>>
}

// `get`, not `getEnforcing`, so a binary without the module reads as one with no reader instead of
// failing at import.
export default TurboModuleRegistry.get<Spec>('NativeVoltzQrImage')
