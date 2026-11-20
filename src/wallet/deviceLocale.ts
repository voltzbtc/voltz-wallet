import * as RNLocalize from 'react-native-localize'
import { pickDefaultFiat, type FiatCurrency } from './fiat'
import type { DateTimePrefs } from './history'

// A fresh install displays the device's own region currency, with the app
// language as the fallback. The language is detected separately (i18n/index.ts), so onboarding
// adapts both without asking. A stored menu choice always wins over this default.
export function resolveDefaultFiat(language: string): FiatCurrency {
  return pickDefaultFiat(RNLocalize.getCurrencies(), language)
}

// The OS's date/time display conventions, so history renders times the way the OS does: the full
// date format (order and separators) of the first preferred locale, plus the clock's 12h/24h
// setting. On Android that is the phone's language. On iOS a language saved in the app pins the
// preferred languages (i18n/bundleLanguage.ts), so both follow it, as they would for a language
// chosen for the app in the iPhone's Settings. The wall-clock value already follows the device time
// zone (Intl uses it by default). Falls back to en-US when the OS reports no locale.
export function deviceDateTimePrefs(): DateTimePrefs {
  return {
    locale: RNLocalize.getLocales()[0]?.languageTag ?? 'en-US',
    use24Hour: RNLocalize.uses24HourClock(),
  }
}
