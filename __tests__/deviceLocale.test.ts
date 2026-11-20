import { getCurrencies, uses24HourClock, getLocales } from 'react-native-localize'
import { resolveDefaultFiat, deviceDateTimePrefs } from '../src/wallet/deviceLocale'

jest.mock('react-native-localize', () => ({
  getCurrencies: jest.fn(() => []),
  uses24HourClock: jest.fn(() => true),
  getLocales: jest.fn(() => [{ languageTag: 'pt-BR' }]),
}))

beforeEach(() => {
  jest.clearAllMocks()
})

test('resolves the device region currency as the default', () => {
  jest.mocked(getCurrencies).mockReturnValue(['MXN', 'USD'])
  expect(resolveDefaultFiat('en-US')).toBe('MXN')
})

test('falls back to the app language when the device reports no currency', () => {
  jest.mocked(getCurrencies).mockReturnValue([])
  expect(resolveDefaultFiat('pt-BR')).toBe('BRL')
  expect(resolveDefaultFiat('en-US')).toBe('USD')
})

describe('deviceDateTimePrefs', () => {
  it('takes the device locale and its explicit 12h/24h choice', () => {
    jest.mocked(getLocales).mockReturnValue([{ languageTag: 'en-US' } as never])
    jest.mocked(uses24HourClock).mockReturnValue(false)
    expect(deviceDateTimePrefs()).toEqual({ locale: 'en-US', use24Hour: false })
  })

  it('falls back to en-US when the OS reports no locale', () => {
    jest.mocked(getLocales).mockReturnValue([])
    jest.mocked(uses24HourClock).mockReturnValue(true)
    expect(deviceDateTimePrefs()).toEqual({ locale: 'en-US', use24Hour: true })
  })
})
