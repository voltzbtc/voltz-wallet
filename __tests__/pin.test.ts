import * as Keychain from 'react-native-keychain'
import { validatePinFormat, savePin, verifyPin, hasPin } from '../src/wallet/pin'

describe('validatePinFormat', () => {
  it('accepts 6 digits', () => {
    expect(validatePinFormat('123456')).toBe(true)
  })

  it('rejects fewer than 6 digits', () => {
    expect(validatePinFormat('12345')).toBe(false)
  })

  it('rejects more than 6 digits', () => {
    expect(validatePinFormat('1234567')).toBe(false)
  })

  it('rejects letters', () => {
    expect(validatePinFormat('12345a')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(validatePinFormat('')).toBe(false)
  })

  it('rejects space in the middle', () => {
    expect(validatePinFormat('12 456')).toBe(false)
  })
})

describe('savePin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('refuses invalid format without saving', async () => {
    await expect(savePin('12ab')).rejects.toThrow('invalid pin')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('saves a valid PIN', async () => {
    await savePin('123456')
    expect(Keychain.setGenericPassword).toHaveBeenCalled()
  })
})

describe('verifyPin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('accepts the correct PIN', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await verifyPin('123456')).toBe(true)
  })

  it('rejects the wrong PIN', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await verifyPin('000000')).toBe(false)
  })

  it('rejects when there is no PIN stored', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await verifyPin('123456')).toBe(false)
  })
})

describe('hasPin', () => {
  beforeEach(() => jest.clearAllMocks())

  it('true when there is a PIN stored', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue({ password: '123456' } as never)
    expect(await hasPin()).toBe(true)
  })

  it('false when there is none', async () => {
    jest.mocked(Keychain.getGenericPassword).mockResolvedValue(false as never)
    expect(await hasPin()).toBe(false)
  })
})
