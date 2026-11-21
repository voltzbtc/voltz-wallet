import { secureBytes, toHex } from './secureRandom'

// The key a send goes out under, a random UUID v4 the SDK makes the payment's id. The SDK answers a key
// it already holds with that payment and sends nothing, so one key never stands for two requests: each
// prepared request gets its own, drawn here, and only a retry of that same request reuses it.
//
// Undefined when the platform has no getRandomValues, or when the draw fell back to Math.random, since
// a key from a weaker source could name a payment already made, and the send then goes without one, as
// before keys.
export function mintSendKey(): string | undefined {
  let bytes: Uint8Array
  try {
    bytes = secureBytes(16, 'a send key')
  } catch {
    return undefined
  }
  // Per RFC 9562, version 4 sits in the high nibble of byte 6 and the variant 10 in the top bits of byte 8.
  // eslint-disable-next-line no-bitwise
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  // eslint-disable-next-line no-bitwise
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = toHex(bytes)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
