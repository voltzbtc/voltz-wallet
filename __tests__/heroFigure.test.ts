import { drawnUnit, heroRead, isHeroUnit, nextUnit } from '../src/wallet/heroFigure'
import { loadHeroUnit, saveHeroUnit } from '../src/wallet/settings'

const usdb = { amount: 10, pegFiat: 'USD' }
const rates = { BRL: 600_000, USD: 100_000 }

describe('heroRead', () => {
  it('states a bitcoin wallet exactly in every unit, sats first', () => {
    expect(heroRead({ balanceSat: 5_000, tokenFiat: [], currency: 'BRL', rates })).toEqual({
      whole: true,
      units: ['sats', 'btc', 'fiat'],
      fiat: 30,
      sats: 5_000,
      approx: false,
    })
  })

  it('values the whole wallet at the rate when it holds tokens, the total first, and marks it', () => {
    expect(heroRead({ balanceSat: 5_000, tokenFiat: [usdb], currency: 'BRL', rates })).toEqual({
      whole: true,
      units: ['fiat', 'sats', 'btc'],
      fiat: 90,
      sats: 15_000,
      approx: true,
    })
  })

  it('treats a token at zero as no token', () => {
    const read = heroRead({ balanceSat: 5_000, tokenFiat: [{ amount: 0 }], currency: 'BRL', rates })
    expect(read.approx).toBe(false)
    expect(read.units).toEqual(['sats', 'btc', 'fiat'])
  })

  it('states the bitcoin alone when a holding has no value', () => {
    expect(heroRead({ balanceSat: 5_000, tokenFiat: [{ amount: 7 }], currency: 'BRL', rates })).toEqual({
      whole: false,
      units: ['sats', 'btc'],
      fiat: null,
      sats: 5_000,
      approx: false,
    })
  })

  it('has no total to state without the rates', () => {
    const read = heroRead({ balanceSat: 5_000, tokenFiat: [], currency: 'BRL', rates: {} })
    expect(read.whole).toBe(false)
    expect(read.units).toEqual(['sats', 'btc'])
  })

  it('a pegged wallet in the peg currency has a total and nothing to read it into bitcoin by', () => {
    const read = heroRead({ balanceSat: 0, tokenFiat: [usdb], currency: 'USD', rates: {} })
    expect(read.units).toEqual(['fiat'])
    expect(read.fiat).toBe(10)
  })

  it('an empty wallet with no rate is whole, and draws no money figure', () => {
    const read = heroRead({ balanceSat: 0, tokenFiat: [], currency: 'BRL', rates: {} })
    expect(read.whole).toBe(true)
    expect(read.units).toEqual(['sats', 'btc'])
  })
})

describe('drawnUnit', () => {
  it('draws the choice when it can be stated', () => {
    expect(drawnUnit(['fiat', 'sats', 'btc'], 'btc')).toBe('btc')
  })

  it('gives way to the lead of the wallet', () => {
    expect(drawnUnit(['sats', 'btc'], 'fiat')).toBe('sats')
    expect(drawnUnit(['fiat'], 'sats')).toBe('fiat')
    expect(drawnUnit(['fiat'], 'btc')).toBe('fiat')
  })

  it('with no choice made, draws the lead of the wallet', () => {
    expect(drawnUnit(['sats', 'btc', 'fiat'], null)).toBe('sats')
    expect(drawnUnit(['fiat', 'sats', 'btc'], null)).toBe('fiat')
  })

  it('a choice made on one wallet holds on another', () => {
    expect(drawnUnit(['sats', 'btc', 'fiat'], 'fiat')).toBe('fiat')
    expect(drawnUnit(['fiat', 'sats', 'btc'], 'sats')).toBe('sats')
  })
})

describe('nextUnit', () => {
  it('walks the units and comes back', () => {
    const units = ['sats', 'btc', 'fiat'] as const
    expect(nextUnit([...units], 'sats')).toBe('btc')
    expect(nextUnit([...units], 'btc')).toBe('fiat')
    expect(nextUnit([...units], 'fiat')).toBe('sats')
  })

  it('stays on the one unit there is', () => {
    expect(nextUnit(['fiat'], 'fiat')).toBe('fiat')
  })
})

describe('the choice on disk', () => {
  it('starts with none and keeps what was saved', async () => {
    expect(await loadHeroUnit()).toBeNull()
    await saveHeroUnit('btc')
    expect(await loadHeroUnit()).toBe('btc')
  })

  it('takes nothing that is not a unit', () => {
    expect(isHeroUnit('sats')).toBe(true)
    expect(isHeroUnit('bitcoin')).toBe(false)
    expect(isHeroUnit(undefined)).toBe(false)
  })
})
