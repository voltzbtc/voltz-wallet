import type { CodegenTypes, TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the iOS capture bridge. iOS cannot block a screenshot or a recording, it can only
// say that one happened, so the native side relays UIKit's two signals and src/wallet/screenCapture.ts
// is the one reader. Android has no implementation: FLAG_SECURE in MainActivity blocks both.

export interface Spec extends TurboModule {
  // UIScreen isCaptured, read on the main thread: true while the screen is recorded, mirrored or sent
  // over AirPlay.
  isCaptured(): Promise<boolean>
  // UIScreen capturedDidChangeNotification, with the value after the change.
  readonly onCapturedChange: CodegenTypes.EventEmitter<boolean>
  // UIApplication userDidTakeScreenshotNotification, which arrives after the shot was taken.
  readonly onScreenshot: CodegenTypes.EventEmitter<void>
}

// `get`, not `getEnforcing`, so a binary without the module reads as one with nothing to watch instead
// of failing at import, and Android, which never implements it, reads null.
export default TurboModuleRegistry.get<Spec>('NativeVoltzCapture')
