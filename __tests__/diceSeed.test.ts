import {
  mnemonicFromDiceRolls,
  validateMnemonic,
  DICE_MIN_ROLLS,
  diceRollsChiSquare,
  diceRollsUniform,
  diceRollsDistribution,
} from '../src/wallet/seed'

// Both strings sit exactly at the roll floor, since 99 rolls reach only ~255.9 of the 256 bits
// the entropy gate requires.
const ROLLS_12 = '123456'.repeat(8) + '12'
const ROLLS_24 = '123456'.repeat(16) + '1234'

// The vectors were derived independently with @noble sha256 plus bip39.entropyToMnemonic, so they
// pin the recipe rather than agreeing with whatever the implementation happens to do.
const VECTOR_12 = 'unveil nice picture region tragic fault cream strike tourist control recipe tourist'
const VECTOR_24 =
  'tornado cactus wheel picture target finish home neither trend picture shoulder endless deputy glide open oxygen another ability forum swear side alcohol devote random'

describe('mnemonicFromDiceRolls', () => {
  test('known vector: 12 words (first 16 bytes of SHA-256 over the ASCII rolls)', () => {
    expect(mnemonicFromDiceRolls(ROLLS_12, 12)).toBe(VECTOR_12)
  })

  test('known vector: 24 words (full 32 bytes of SHA-256)', () => {
    expect(mnemonicFromDiceRolls(ROLLS_24, 24)).toBe(VECTOR_24)
  })

  test('produces a valid BIP39 mnemonic of the right length', () => {
    const m12 = mnemonicFromDiceRolls(ROLLS_12, 12)
    const m24 = mnemonicFromDiceRolls(ROLLS_24, 24)
    expect(validateMnemonic(m12)).toBe(true)
    expect(m12.split(' ')).toHaveLength(12)
    expect(validateMnemonic(m24)).toBe(true)
    expect(m24.split(' ')).toHaveLength(24)
  })

  test('is deterministic, so the same rolls give the same mnemonic', () => {
    expect(mnemonicFromDiceRolls(ROLLS_12)).toBe(mnemonicFromDiceRolls(ROLLS_12))
  })

  // Generation refuses below the floor rather than warning, because there is no RNG fallback here.
  test('hard-blocks below the roll floor (50 for 12 words, 100 for 24)', () => {
    expect(DICE_MIN_ROLLS).toEqual({ 12: 50, 24: 100 })
    expect(() => mnemonicFromDiceRolls('123456'.repeat(8) + '1', 12)).toThrow(/at least 50/)
    expect(() => mnemonicFromDiceRolls('123456'.repeat(16) + '123', 24)).toThrow(/at least 100/)
  })

  // A total-entropy metric would wave through a loaded die, so uniformity is what gates this.
  test('blocks a skewed distribution regardless of roll count (chi-square uniformity)', () => {
    const biased = '1'.repeat(46) + '2345'
    expect(biased.length).toBe(50)
    expect(new Set(biased).size).toBeGreaterThan(1)
    expect(() => mnemonicFromDiceRolls(biased, 12)).toThrow(/too skewed/)

    const heavy =
      '1'.repeat(27) + '2'.repeat(114) + '3'.repeat(4) + '4'.repeat(18) + '5'.repeat(17) + '6'.repeat(16)
    expect(heavy.length).toBe(196)
    expect(() => mnemonicFromDiceRolls(heavy, 12)).toThrow(/too skewed/)
  })

  test('rejects non-dice input (letters, spaces, separators, 0/7, empty)', () => {
    expect(() => mnemonicFromDiceRolls('12345x'.repeat(10), 12)).toThrow(/digits 1-6/)
    expect(() => mnemonicFromDiceRolls('1 2 3 4 5 6'.repeat(10), 12)).toThrow(/digits 1-6/)
    expect(() => mnemonicFromDiceRolls('1,2,3,4,5,6'.repeat(10), 12)).toThrow(/digits 1-6/)
    expect(() => mnemonicFromDiceRolls('7'.repeat(50), 12)).toThrow(/digits 1-6/)
    expect(() => mnemonicFromDiceRolls('', 12)).toThrow(/digits 1-6/)
  })

  test('rejects an all-identical roll string (fat-finger guard)', () => {
    expect(() => mnemonicFromDiceRolls('1'.repeat(60), 12)).toThrow(/every roll is identical/)
  })

  // The dice path exists for people who distrust the CSPRNG, so touching it at all defeats the
  // feature.
  test('never touches the system CSPRNG (getRandomValues / Math.random)', () => {
    const realRandom = Math.random
    const cryptoObj = globalThis.crypto
    const realGRV = cryptoObj?.getRandomValues
    const hasGRV = typeof realGRV === 'function'
    Math.random = () => {
      throw new Error('dice path must not call Math.random')
    }
    if (cryptoObj && hasGRV) {
      cryptoObj.getRandomValues = () => {
        throw new Error('dice path must not call getRandomValues')
      }
    }
    try {
      expect(validateMnemonic(mnemonicFromDiceRolls(ROLLS_12, 12))).toBe(true)
    } finally {
      Math.random = realRandom
      if (cryptoObj && hasGRV) {
        cryptoObj.getRandomValues = realGRV
      }
    }
  })
})

describe('dice distribution uniformity (chi-square, Krux-style stats)', () => {
  test('diceRollsDistribution counts each face 1..6', () => {
    expect(diceRollsDistribution('')).toEqual([0, 0, 0, 0, 0, 0])
    expect(diceRollsDistribution('123456')).toEqual([1, 1, 1, 1, 1, 1])
    expect(diceRollsDistribution('112233')).toEqual([2, 2, 2, 0, 0, 0])
    expect(diceRollsDistribution('6'.repeat(5))).toEqual([0, 0, 0, 0, 0, 5])
  })

  test('diceRollsChiSquare = 0 for a perfectly uniform set, 5N for all one face', () => {
    expect(diceRollsChiSquare('')).toBe(0)
    expect(diceRollsChiSquare('123456')).toBe(0)
    expect(diceRollsChiSquare('111111')).toBeCloseTo(30, 6) // (6-1)²/1 + 5·(0-1)²/1 = 30
  })

  test('diceRollsUniform accepts fair variance, rejects clear bias', () => {
    // Natural unevenness from a real die has to pass, or the gate rejects honest rolls.
    const fair = '1'.repeat(12) + '2'.repeat(8) + '3'.repeat(9) + '4'.repeat(7) + '5'.repeat(9) + '6'.repeat(5)
    expect(fair.length).toBe(50)
    expect(diceRollsUniform(fair)).toBe(true)
    // A dominant-face set is rejected.
    expect(diceRollsUniform('1'.repeat(46) + '2345')).toBe(false)
  })
})
