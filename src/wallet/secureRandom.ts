import 'react-native-get-random-values'

// The wallet code's one source of random bytes: seeds, the webhook secret, send keys, wallet ids,
// generated lightning names and passkey user names all draw here, so there is a single kind of
// randomness to audit.

// `n` bytes from the platform's CSPRNG, or a throw naming `what` was being drawn, never a fallback.
//
// A missing polyfill fails the availability check. A substituted getRandomValues that fills from
// Math.random still passes it, since the function exists, so the draw watches Math.random and
// rejects bytes that touched it. The draw is synchronous, so nothing else runs while Math.random is
// replaced, and it is put back whether the draw returns or throws.
export function secureBytes(n: number, what = 'random bytes'): Uint8Array {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error(`refusing to draw ${what}: crypto.getRandomValues is unavailable`)
  }
  const bytes = new Uint8Array(n)
  const realRandom = Math.random
  let weakSourceUsed = false
  Math.random = () => {
    weakSourceUsed = true
    return realRandom()
  }
  try {
    globalThis.crypto.getRandomValues(bytes)
  } finally {
    Math.random = realRandom
  }
  if (weakSourceUsed) {
    throw new Error(`refusing to draw ${what}: the draw fell back to a non-crypto RNG`)
  }
  return bytes
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}
