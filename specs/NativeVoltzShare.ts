import type { TurboModule } from 'react-native'
import { TurboModuleRegistry } from 'react-native'

// The codegen spec of the image share on Android, whose one reader is src/wallet/addressCard.ts. React
// Native's Share sends text alone on Android, while on iOS it takes a file URL, so iOS has no such
// module.
//
// Rejects with E_FAILED when the file is outside the provider's root (the cache's share folder), when
// no activity is in front to show the chooser over, or when the chooser cannot start. It resolves once
// the chooser is started, before any app has read the file.
export interface Spec extends TurboModule {
  // Opens the system chooser on an ACTION_SEND of the PNG at `path` with `text` beside it.
  shareImage(path: string, text: string, title: string): Promise<void>
}

// `get`, not `getEnforcing`: iOS has no such module, and a binary without it shares the text alone.
export default TurboModuleRegistry.get<Spec>('NativeVoltzShare')
