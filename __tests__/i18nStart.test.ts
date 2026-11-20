import { findBestLanguageTag, getCurrencies } from 'react-native-localize'
import type { AppStateStatus } from 'react-native'

jest.mock('react-native-localize', () => ({
  findBestLanguageTag: jest.fn(),
  getCurrencies: jest.fn(() => []),
}))

// src/i18n picks the language once, when the module loads, so each case loads a fresh copy of it
// (and of i18next) against the device the mock describes.
function startLanguage(): string {
  let language = ''
  jest.isolateModules(() => {
    const i18n = require('../src/i18n').default as typeof import('../src/i18n').default
    language = i18n.language
  })
  return language
}

describe('start language', () => {
  beforeEach(() => {
    jest.mocked(findBestLanguageTag).mockReset()
  })

  it('is en-US when no bundled locale matches the device', () => {
    jest.mocked(findBestLanguageTag).mockReturnValue(undefined)
    expect(startLanguage()).toBe('en-US')
    expect(findBestLanguageTag).toHaveBeenCalledTimes(1)
  })

  it('is the matched locale when the device has one', () => {
    jest.mocked(findBestLanguageTag).mockReturnValue({ languageTag: 'es', isRTL: false })
    expect(startLanguage()).toBe('es')
  })
})

// The device's own currency is read at load too, and decides which currency may be written
// with a bare $. The fresh copy of fiat is the one the fresh i18n configured.
describe('start currency', () => {
  function startUsd(deviceCurrencies: string[]): string {
    jest.mocked(findBestLanguageTag).mockReturnValue({ languageTag: 'en-US', isRTL: false })
    jest.mocked(getCurrencies).mockReturnValue(deviceCurrencies)
    let shown = ''
    jest.isolateModules(() => {
      require('../src/i18n')
      const fiat = require('../src/wallet/fiat') as typeof import('../src/wallet/fiat')
      shown = fiat.formatFiat(3.15, 'USD')
    })
    return shown
  }

  it('writes a bare $ on a device whose own currency is the dollar', () => {
    expect(startUsd(['USD', 'EUR'])).toBe('$3.15')
  })

  it('writes US$ on an Australian device, whose $ is its own dollar', () => {
    expect(startUsd(['AUD'])).toBe('US$3.15')
  })

  it('writes US$ when the device names no currency', () => {
    expect(startUsd([])).toBe('US$3.15')
  })
})

// A region changed in the system settings while the app sat in the background is seen the next time
// it comes forward, so the read at load is repeated then. The control in each case is the figure
// before the return, which must still be the old one: the device answers differently by then, and
// only a read tells.
describe('currency on return to the foreground', () => {
  function boot(deviceCurrencies: string[]): {
    usd: () => string
    change: (state: AppStateStatus) => void
  } {
    jest.mocked(findBestLanguageTag).mockReturnValue({ languageTag: 'en-US', isRTL: false })
    jest.mocked(getCurrencies).mockReturnValue(deviceCurrencies)
    let usd = () => ''
    let change: (state: AppStateStatus) => void = () => undefined
    jest.isolateModules(() => {
      const { AppState } = require('react-native') as typeof import('react-native')
      jest.mocked(AppState.addEventListener).mockClear()
      require('../src/i18n')
      const fiat = require('../src/wallet/fiat') as typeof import('../src/wallet/fiat')
      usd = () => fiat.formatFiat(3.15, 'USD')
      const registered = jest.mocked(AppState.addEventListener).mock.calls.find(([type]) => type === 'change')
      if (registered) {
        change = registered[1] as (state: AppStateStatus) => void
      }
    })
    return { usd, change }
  }

  it('writes US$ once an Australian region has replaced a US one while away', () => {
    const app = boot(['USD', 'EUR'])
    expect(app.usd()).toBe('$3.15')

    jest.mocked(getCurrencies).mockReturnValue(['AUD'])
    expect(app.usd()).toBe('$3.15')

    app.change('active')
    expect(app.usd()).toBe('US$3.15')
  })

  it('writes the bare $ again once a US region has replaced an Australian one', () => {
    const app = boot(['AUD'])
    expect(app.usd()).toBe('US$3.15')

    jest.mocked(getCurrencies).mockReturnValue(['USD', 'EUR'])
    app.change('active')
    expect(app.usd()).toBe('$3.15')
  })

  it('reads nothing when the app goes to the background or is only inactive', () => {
    const app = boot(['USD', 'EUR'])
    jest.mocked(getCurrencies).mockReturnValue(['AUD'])

    app.change('background')
    app.change('inactive')
    expect(app.usd()).toBe('$3.15')
  })

  it('writes no bare $ once the device names no currency any more', () => {
    const app = boot(['USD', 'EUR'])
    jest.mocked(getCurrencies).mockReturnValue([])
    app.change('active')
    expect(app.usd()).toBe('US$3.15')
  })
})
