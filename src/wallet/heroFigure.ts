import { walletFiatTotal, type FiatCurrency } from './fiat'

// The units the big balance can draw.
export type HeroUnit = 'fiat' | 'sats' | 'btc'

export function isHeroUnit(value: unknown): value is HeroUnit {
  return value === 'fiat' || value === 'sats' || value === 'btc'
}

const SATS_PER_BTC = 100_000_000

type Holdings = {
  balanceSat: number
  tokenFiat: { amount: number; pegFiat?: string }[]
  currency: FiatCurrency
  rates: Record<string, number>
}

// What the wallet's figures can state right now.
export type HeroRead = {
  // Whether the figure is the whole wallet. Otherwise it is the bitcoin balance, under its own label,
  // and the tokens are left to the asset list.
  whole: boolean
  // The units that can be stated, in tap order, never empty. The first leads until the person chooses:
  // bitcoin alone is counted in sats, and a wallet with tokens by what it adds up to.
  units: HeroUnit[]
  // The total in the display currency, null when it is not among the units.
  fiat: number | null
  // The figure for the sats and BTC units.
  sats: number
  // Whether `sats` is a value at the rate rather than sats the wallet holds. Tokens have a value in
  // bitcoin and are not bitcoin, so such a figure always carries the approximate mark.
  approx: boolean
}

export function heroRead({ balanceSat, tokenFiat, currency, rates }: Holdings): HeroRead {
  const rate = rates[currency]
  const hasRate = rate > 0
  const total = walletFiatTotal(balanceSat, tokenFiat, currency, rates)
  const holdsTokens = tokenFiat.some(token => token.amount > 0)

  if (!holdsTokens) {
    return {
      whole: total !== null,
      units: hasRate ? ['sats', 'btc', 'fiat'] : ['sats', 'btc'],
      fiat: hasRate ? total : null,
      sats: balanceSat,
      approx: false,
    }
  }
  if (total === null) {
    return { whole: false, units: ['sats', 'btc'], fiat: null, sats: balanceSat, approx: false }
  }
  // A wallet of pegged tokens can have a total in a currency with no bitcoin rate to read it by.
  return hasRate
    ? {
        whole: true,
        units: ['fiat', 'sats', 'btc'],
        fiat: total,
        sats: Math.round((total / rate) * SATS_PER_BTC),
        approx: true,
      }
    : { whole: true, units: ['fiat'], fiat: total, sats: balanceSat, approx: false }
}

// The unit to draw for the one chosen, null when the person has chosen none. One that cannot be stated
// now gives way to the wallet's lead and stays chosen, so the figure goes back to it when the rates do.
export function drawnUnit(units: HeroUnit[], chosen: HeroUnit | null): HeroUnit {
  return chosen !== null && units.includes(chosen) ? chosen : units[0]
}

export function nextUnit(units: HeroUnit[], drawn: HeroUnit): HeroUnit {
  return units[(units.indexOf(drawn) + 1) % units.length]
}
