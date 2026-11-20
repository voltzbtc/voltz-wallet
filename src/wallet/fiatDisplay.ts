import { sparkListFiatCurrencies, type FiatCurrencyOption } from './spark'
import { configureFiatFormats, type FiatCurrency } from './fiat'
import { loadDisplayCurrency } from './settings'
import { resolveDefaultFiat } from './deviceLocale'

// The display currency with its formatter already configured. Both steps travel together because a
// currency beyond BRL/USD renders with its bare code until the SDK's symbol and decimals are loaded.
// Every screen that draws a fiat amount reads the currency here, so their answers cannot drift.
export async function resolveDisplayCurrency(language: string): Promise<FiatCurrency> {
  const currency = (await loadDisplayCurrency()) ?? resolveDefaultFiat(language)
  // BRL and USD have their own entrenched formatters; every other code needs the SDK's metadata.
  if (currency !== 'BRL' && currency !== 'USD') {
    const list = await sparkListFiatCurrencies().catch(() => [] as FiatCurrencyOption[])
    if (list.length > 0) {
      configureFiatFormats(list, language)
    }
  }
  return currency
}
