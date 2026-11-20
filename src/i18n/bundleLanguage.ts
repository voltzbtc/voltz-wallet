import { Platform, Settings } from 'react-native'
import { bundleLocalization } from './languages'

// iOS picks the bundle's localization from the app's own AppleLanguages once per process, at launch,
// and UIKit gives the views it owns the direction of that localization: the native stack header, its
// back swipe, alerts. Left to the phone, an iPhone in Arabic lays out the header of an app in English
// right to left, since react-native-screens never forces its default LTR direction. Kept equal to the
// app's language, UIKit follows the app from the next cold start; a switch made in place keeps the
// localization the process launched with until then. The permission prompts are drawn by the system
// in the phone's language and do not follow this.
//
// Only a language saved in the app is pinned, at boot and on every pick in the picker. With none
// saved the key is left alone: the language detected from the phone keeps following the phone, since
// detection reads the same preferred languages the key overrides, and a language chosen for the app
// in the iPhone's Settings, which writes the key, still applies. iOS builds the current locale from
// the key as well, so date and clock defaults follow it (src/wallet/deviceLocale.ts).
export function pinBundleLanguage(language: string): void {
  if (Platform.OS !== 'ios') {
    return
  }
  try {
    Settings.set({ AppleLanguages: [bundleLocalization(language)] })
  } catch (e) {
    // A failed write leaves the key as it was, which costs only the native header's direction; the
    // language change goes on.
    console.warn('could not pin the bundle language', e)
  }
}
