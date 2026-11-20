import i18n, { type FormatterModule } from 'i18next'
import { AppState } from 'react-native'
import { initReactI18next } from 'react-i18next'
import * as RNLocalize from 'react-native-localize'
import { setLocalCurrency, setNumberLanguage } from '../wallet/fiat'
import { holdMoneyPlaceholder } from './direction'
import { isRTL } from './languages'
import { installPluralRules } from './pluralRules'

import ptBR from './locales/pt-BR.json'
import ptPT from './locales/pt-PT.json'
import enUS from './locales/en-US.json'
import enGB from './locales/en-GB.json'
import es from './locales/es.json'
import esMX from './locales/es-MX.json'
import fr from './locales/fr.json'
import frCA from './locales/fr-CA.json'
import de from './locales/de.json'
import it from './locales/it.json'
import ru from './locales/ru.json'
import tr from './locales/tr.json'
import id from './locales/id.json'
import vi from './locales/vi.json'
import pl from './locales/pl.json'
import zh from './locales/zh.json'
import zhTW from './locales/zh-TW.json'
import hi from './locales/hi.json'
import ja from './locales/ja.json'
import ko from './locales/ko.json'
import th from './locales/th.json'
import ar from './locales/ar.json'
import ur from './locales/ur.json'
import he from './locales/he.json'

const resources = {
  'pt-BR': { translation: ptBR },
  'pt-PT': { translation: ptPT },
  'en-US': { translation: enUS },
  'en-GB': { translation: enGB },
  es: { translation: es },
  'es-MX': { translation: esMX },
  fr: { translation: fr },
  'fr-CA': { translation: frCA },
  de: { translation: de },
  it: { translation: it },
  ru: { translation: ru },
  tr: { translation: tr },
  id: { translation: id },
  vi: { translation: vi },
  pl: { translation: pl },
  zh: { translation: zh },
  'zh-TW': { translation: zhTW },
  hi: { translation: hi },
  ja: { translation: ja },
  ko: { translation: ko },
  th: { translation: th },
  ar: { translation: ar },
  ur: { translation: ur },
  he: { translation: he },
}

const best = RNLocalize.findBestLanguageTag(Object.keys(resources))

// Before init, since i18next picks a plural form through Intl.PluralRules and Hermes ships none.
installPluralRules()
// Registered before init, which emits the first change itself.
i18n.on('languageChanged', setNumberLanguage)
// From the same source as the default display currency. Read again whenever the app returns to the
// foreground, so a region changed in the system settings meanwhile reaches the next draw.
function readLocalCurrency(): void {
  setLocalCurrency(RNLocalize.getCurrencies())
}
readLocalCurrency()
AppState.addEventListener('change', state => {
  if (state === 'active') {
    readLocalCurrency()
  }
})
// Replaces i18next's own formatter, whose named formats no string uses. With alwaysFormat it sees
// every value as it is placed, by its placeholder's name, and in a right-to-left language holds the
// ones that carry money (holdMoneyPlaceholder in direction.ts).
const moneyHeld: FormatterModule = {
  type: 'formatter',
  init: () => undefined,
  add: () => undefined,
  addCached: () => undefined,
  format: (value, _format, lng, options) =>
    holdMoneyPlaceholder(value, options?.interpolationkey, lng !== undefined && isRTL(lng)) as string,
}

i18n.use(initReactI18next).use(moneyHeld).init({
  resources,
  // English both for a device no bundled locale matches and for a key a locale lacks, since it is
  // readable to more people.
  lng: best?.languageTag ?? 'en-US',
  fallbackLng: 'en-US',
  interpolation: { escapeValue: false, alwaysFormat: true },
})

export default i18n
