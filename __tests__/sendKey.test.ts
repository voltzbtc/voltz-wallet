import { mintSendKey } from '../src/wallet/sendKey'

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('draws a lowercase UUID v4, the shape spark.ts lets through to the SDK', () => {
  expect(mintSendKey()).toMatch(UUID_V4)
})

test('each draw is a key of its own', () => {
  const keys = new Set(Array.from({ length: 64 }, () => mintSendKey()))
  expect(keys.size).toBe(64)
})

test('the bytes come from getRandomValues, with the version and variant bits set over them', () => {
  const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
    ;(array as Uint8Array).fill(0xff)
    return array
  })
  try {
    expect(mintSendKey()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff')
  } finally {
    spy.mockRestore()
  }
})

test('no getRandomValues, no key, so the send goes without one', () => {
  const crypto = globalThis.crypto
  Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true })
  try {
    expect(mintSendKey()).toBeUndefined()
  } finally {
    Object.defineProperty(globalThis, 'crypto', { value: crypto, configurable: true })
  }
})

test('a draw that fell back to Math.random gives no key, as no getRandomValues does', () => {
  const spy = jest.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(array => {
    const view = array as Uint8Array
    for (let i = 0; i < view.length; i += 1) {
      view[i] = Math.floor(Math.random() * 256)
    }
    return array
  })
  try {
    expect(mintSendKey()).toBeUndefined()
  } finally {
    spy.mockRestore()
  }
})
