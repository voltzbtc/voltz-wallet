import { secureBytes, toHex } from '../src/wallet/secureRandom'

// The polyfill's weak branch still returns bytes, only sourced from Math.random.
const fillFromMathRandom = ((array: Uint8Array) => {
  for (let i = 0; i < array.length; i += 1) {
    array[i] = Math.floor(Math.random() * 256)
  }
  return array
}) as typeof globalThis.crypto.getRandomValues

afterEach(() => {
  jest.restoreAllMocks()
})

test('answers the bytes getRandomValues drew, as many as asked', () => {
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
    ;(array as Uint8Array).set([0xde, 0xad, 0xbe, 0xef])
    return array
  })
  const bytes = secureBytes(4)
  expect(bytes).toBeInstanceOf(Uint8Array)
  expect(toHex(bytes)).toBe('deadbeef')
})

test('refuses without getRandomValues, naming what was being drawn', () => {
  const crypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  try {
    expect(() => secureBytes(8, 'a send key')).toThrow(
      'refusing to draw a send key: crypto.getRandomValues is unavailable',
    )
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true })
  }
})

test('refuses bytes that touched Math.random, and puts Math.random back', () => {
  const realRandom = Math.random
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(fillFromMathRandom)
  expect(() => secureBytes(16, 'a webhook secret')).toThrow(
    'refusing to draw a webhook secret: the draw fell back to a non-crypto RNG',
  )
  expect(Math.random).toBe(realRandom)
})

test('puts Math.random back when the draw itself throws', () => {
  const realRandom = Math.random
  jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(() => {
    throw new Error('native module gone')
  })
  expect(() => secureBytes(4)).toThrow('native module gone')
  expect(Math.random).toBe(realRandom)
})

test('a healthy draw never calls Math.random', () => {
  const weak = jest.spyOn(Math, 'random')
  for (let i = 0; i < 50; i += 1) {
    secureBytes(32)
  }
  expect(weak).not.toHaveBeenCalled()
})
