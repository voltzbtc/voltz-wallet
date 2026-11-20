import * as Keychain from 'react-native-keychain'
import {
  generateMnemonic,
  validateMnemonic,
  saveMnemonic,
  hasSeedFor,
  PRIMARY_ID,
} from '../src/wallet/seed'
import { mnemonicToEntropy } from 'bip39'

const SERVICE = 'com.voltz.wallet.seed'

// Valid words in an order that fails the checksum, since a shuffle lands on a valid one ~1/16 of the time.
const INVALID_CHECKSUM =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon'

beforeEach(() => {
  jest.clearAllMocks()
})

describe('generateMnemonic', () => {
  it('generates a 12-word mnemonic by default', () => {
    expect(generateMnemonic().split(' ')).toHaveLength(12)
  })

  it('generates a 12-word mnemonic when explicitly requested', () => {
    expect(generateMnemonic(12).split(' ')).toHaveLength(12)
  })

  it('generates a 24-word mnemonic when requested', () => {
    expect(generateMnemonic(24).split(' ')).toHaveLength(24)
  })

  it('generates a 24-word mnemonic that passes BIP39 validation', () => {
    expect(validateMnemonic(generateMnemonic(24))).toBe(true)
  })

  it('generates a mnemonic that passes BIP39 validation', () => {
    expect(validateMnemonic(generateMnemonic())).toBe(true)
  })

  it('generates a different mnemonic on each call', () => {
    expect(generateMnemonic()).not.toBe(generateMnemonic())
  })

  it('refuses to generate when crypto.getRandomValues does not exist', () => {
    // getRandomValues lives on Crypto's prototype, so removing it needs the whole object swapped.
    const realCrypto = globalThis.crypto
    Object.defineProperty(globalThis, 'crypto', {
      value: {},
      configurable: true,
      writable: true,
    })
    try {
      expect(() => generateMnemonic()).toThrow(/crypto\.getRandomValues is unavailable/)
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
        writable: true,
      })
    }
  })
})

describe('validateMnemonic', () => {
  it('rejects a phrase that is not a mnemonic', () => {
    expect(validateMnemonic('invalid word whatever thing')).toBe(false)
  })

  it('rejects an empty string', () => {
    expect(validateMnemonic('')).toBe(false)
  })

  it('rejects a word outside the BIP39 wordlist', () => {
    const words = generateMnemonic().split(' ')
    words[0] = 'bananarama'
    expect(validateMnemonic(words.join(' '))).toBe(false)
  })

  it('rejects invalid checksum even when all words are in the wordlist', () => {
    expect(validateMnemonic(INVALID_CHECKSUM)).toBe(false)
  })

  it('rejects a mnemonic with an invalid word count', () => {
    const words = generateMnemonic().split(' ')
    expect(validateMnemonic(words.slice(0, 11).join(' '))).toBe(false)
  })
})

describe('saveMnemonic', () => {
  it('saves to the Keychain with the correct service and accessible', async () => {
    const mnemonic = generateMnemonic()
    await saveMnemonic(mnemonic)

    expect(Keychain.setGenericPassword).toHaveBeenCalledWith('seed', mnemonic, {
      service: SERVICE,
      accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
    })
  })

  it('refuses to save an invalid mnemonic', async () => {
    await expect(saveMnemonic('I am not a mnemonic')).rejects.toThrow('invalid mnemonic')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('refuses to save an empty string', async () => {
    await expect(saveMnemonic('')).rejects.toThrow('invalid mnemonic')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('refuses to save a mnemonic with invalid checksum', async () => {
    await expect(saveMnemonic(INVALID_CHECKSUM)).rejects.toThrow('invalid mnemonic')
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
  })

  it('does not leak the mnemonic in the error message', async () => {
    const secret = 'zebra zebra zebra zebra'
    await expect(saveMnemonic(secret)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining('zebra') }),
    )
  })

  it('propagates the Keychain error instead of masking it as success', async () => {
    jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(new Error('keychain down'))
    await expect(saveMnemonic(generateMnemonic())).rejects.toThrow('keychain down')
  })
})

// PRIMARY_ID maps to the original single-entry service, the same Keychain key the boot path reads.
describe('hasSeedFor', () => {
  it('returns true when a saved wallet exists', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true)
    await expect(hasSeedFor(PRIMARY_ID)).resolves.toBe(true)
  })

  it('returns false when no wallet exists', async () => {
    await expect(hasSeedFor(PRIMARY_ID)).resolves.toBe(false)
  })

  // This runs on every cold start, and decrypting would pull the plaintext seed into the JS heap.
  it('answers without decrypting the seed', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValueOnce(true)
    await hasSeedFor(PRIMARY_ID)
    expect(Keychain.hasGenericPassword).toHaveBeenCalledWith({ service: SERVICE })
    expect(Keychain.getGenericPassword).not.toHaveBeenCalled()
  })
})

// --- Entropy audit -------------------------------------------------------------
// A weak generator is invisible to output inspection: a source cut to 40 to 72 bits of effective
// entropy still produces output that looks healthy, so these verify which generator ran.

const SAMPLE = 5000

const CHI2_CUTOFF = 400

function toBytes(hex: string): number[] {
  const out: number[] = []
  for (let i = 0; i < hex.length; i += 2) {
    out.push(parseInt(hex.slice(i, i + 2), 16))
  }
  return out
}

// Pearson chi-square over the 256 byte values. A healthy CSPRNG scores ~= df (255) with sd ~= 22.6,
// so the 400 cutoff sits ~6 sigma above that mean and far below any degenerate source.
function chiSquare(bytes: number[]): number {
  const counts = Array.from({ length: 256 }, () => 0)
  for (const b of bytes) {
    counts[b] += 1
  }
  const expected = bytes.length / 256
  let chi = 0
  for (const c of counts) {
    const diff = c - expected
    chi += (diff * diff) / expected
  }
  return chi
}

describe('entropy source', () => {
  // The polyfill has an insecure Math.random path the availability guard cannot catch.
  it('never falls back to Math.random while generating seeds', () => {
    const spy = jest.spyOn(Math, 'random')
    try {
      for (let i = 0; i < 100; i += 1) {
        generateMnemonic()
      }
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('refuses the seed when the crypto source secretly draws from Math.random', () => {
    // The polyfill's weak branch still returns bytes, only sourced from Math.random.
    const fillFromMathRandom = (array: Uint8Array) => {
      for (let i = 0; i < array.length; i += 1) {
        array[i] = Math.floor(Math.random() * 256)
      }
      return array
    }
    const spy = jest
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(fillFromMathRandom as typeof globalThis.crypto.getRandomValues)
    try {
      expect(() => generateMnemonic()).toThrow(/non-crypto RNG/)
    } finally {
      spy.mockRestore()
    }
  })

  // Fills every byte but the last `zeroTail` without touching Math.random, or the route guard fires first.
  function fillTruncated(zeroTail: number) {
    return (array: Uint8Array) => {
      for (let i = 0; i < array.length - zeroTail; i += 1) {
        array[i] = (i % 255) + 1
      }
      return array
    }
  }

  function withEntropy(fill: (array: Uint8Array) => Uint8Array, assert: () => void) {
    const spy = jest
      .spyOn(globalThis.crypto, 'getRandomValues')
      .mockImplementation(fill as typeof globalThis.crypto.getRandomValues)
    try {
      assert()
    } finally {
      spy.mockRestore()
    }
  }

  it('derives the mnemonic from the bytes actually drawn', () => {
    // The draw crosses a Buffer boundary, where a mangled conversion still yields a valid mnemonic.
    const drawn = Uint8Array.from({ length: 16 }, (_, i) => i * 7 + 1)
    withEntropy(
      array => {
        array.set(drawn)
        return array
      },
      () => {
        expect(mnemonicToEntropy(generateMnemonic())).toBe(Buffer.from(drawn).toString('hex'))
      },
    )
  })

  it('refuses the seed when the entropy draw is truncated', () => {
    // The polyfill decodes the native base64 into the caller's buffer with no length check, so a
    // short response leaves the tail at 0x00 and returns normally, invisible to the guard above.
    withEntropy(fillTruncated(8), () => {
      expect(() => generateMnemonic()).toThrow(/run of zero bytes/)
    })
  })

  it('accepts a 3-byte zero tail -- the 4-byte threshold is deliberate', () => {
    // An honest CSPRNG ends on a zero byte once every 256 draws, so a tighter limit would refuse real
    // wallets. Four zero bytes is 2^-32, and three lost bytes still leave >= 104 of the 128 bits.
    withEntropy(fillTruncated(3), () => {
      expect(() => generateMnemonic()).not.toThrow()
    })
  })
})

describe('entropy distribution', () => {
  // Smoke check for gross degeneration (stuck, biased or range-limited output). It does not audit
  // entropy level, so a uniform-looking but low-entropy source passes here untouched.
  const mnemonics: string[] = []
  const bytes: number[] = []

  beforeAll(() => {
    for (let i = 0; i < SAMPLE; i += 1) {
      const mnemonic = generateMnemonic()
      mnemonics.push(mnemonic)
      bytes.push(...toBytes(mnemonicToEntropy(mnemonic)))
    }
  })

  it('generates no duplicate mnemonics across the sample', () => {
    expect(new Set(mnemonics).size).toBe(SAMPLE)
  })

  it('spreads entropy bytes ~uniformly (chi-square below cutoff)', () => {
    expect(chiSquare(bytes)).toBeLessThan(CHI2_CUTOFF)
  })

  // A detector that only ever sees good randomness cannot be trusted to flag bad randomness.
  it('the duplicate check flags a small-output source', () => {
    const pool = Array.from({ length: 50 }, (_, i) => `s${i}`)
    const drawn = Array.from({ length: SAMPLE }, (_, i) => pool[i % pool.length])
    expect(new Set(drawn).size).toBeLessThan(SAMPLE)
  })

  it('the chi-square check flags a biased source', () => {
    // Top two bits stuck at 0 -> values 0..63 only, the shape of a low-entropy source.
    const biased = Array.from({ length: SAMPLE * 16 }, (_, i) => i % 64)
    expect(chiSquare(biased)).toBeGreaterThan(CHI2_CUTOFF)
  })
})
