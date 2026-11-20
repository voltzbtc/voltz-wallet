import 'react-native-get-random-values'
import { Buffer } from 'buffer'
import * as bip39 from 'bip39'
import { sha256 } from '@noble/hashes/sha2.js'
import * as Keychain from 'react-native-keychain'

const SERVICE = 'com.voltz.wallet.seed'

export type MnemonicLength = 12 | 24

// Failing loudly keeps a missing react-native-get-random-values polyfill from becoming a weak seed.
function assertRngAvailable(): void {
  if (typeof globalThis.crypto?.getRandomValues !== 'function') {
    throw new Error('refusing to generate a seed: crypto.getRandomValues is unavailable')
  }
}

// react-native-get-random-values decodes the native base64 with no length check, so a truncated
// response leaves the tail at 0x00. A healthy draw ends in four zero bytes with probability 2^-32.
const ZERO_TAIL_LIMIT = 4

function drawEntropy(size: number): Buffer {
  const bytes = new Uint8Array(size)
  globalThis.crypto.getRandomValues(bytes)
  let zeroTail = 0
  while (zeroTail < bytes.length && bytes[bytes.length - 1 - zeroTail] === 0) {
    zeroTail += 1
  }
  if (zeroTail >= ZERO_TAIL_LIMIT) {
    throw new Error('refusing to generate a seed: entropy draw ended in a run of zero bytes')
  }
  return Buffer.from(bytes)
}

// A substituted getRandomValues that falls back to Math.random still passes assertRngAvailable,
// since the function exists, so generation watches Math.random and rejects a seed that touched it.
function generateWatchingSource(strength: 128 | 256): string {
  const realRandom = Math.random
  let weakSourceUsed = false
  Math.random = () => {
    weakSourceUsed = true
    return realRandom()
  }
  try {
    const mnemonic = bip39.generateMnemonic(strength, drawEntropy)
    if (weakSourceUsed) {
      throw new Error('refusing to generate a seed: entropy fell back to a non-crypto RNG')
    }
    return mnemonic
  } finally {
    Math.random = realRandom
  }
}

export function generateMnemonic(length: MnemonicLength = 12): string {
  assertRngAvailable()
  return generateWatchingSource(length === 24 ? 256 : 128)
}

// A fair d6 carries log2(6) ~= 2.585 bits, so 50 rolls clear the 128 bits of 12 words and 99 fall
// just short of 256. No test of the hashed output can replace the count, as one roll hashes uniform.
export const DICE_MIN_ROLLS: Record<MnemonicLength, number> = { 12: 50, 24: 100 }

export function diceRollsDistribution(rolls: string): number[] {
  const counts = [0, 0, 0, 0, 0, 0]
  for (const r of rolls) {
    const i = r.charCodeAt(0) - 49
    if (i >= 0 && i < 6) {
      counts[i] += 1
    }
  }
  return counts
}

// Catches skew the roll count masks, such as 114 twos out of 196, which clears the floor anyway.
export function diceRollsChiSquare(rolls: string): number {
  const n = rolls.length
  if (n === 0) {
    return 0
  }
  const expected = n / 6
  let chi2 = 0
  for (const c of diceRollsDistribution(rolls)) {
    const d = c - expected
    chi2 += (d * d) / expected
  }
  return chi2
}

// Critical value for df=5 at p~0.001, so honest rolls pass with room to spare.
export const DICE_MAX_CHI2 = 20.5

export function diceRollsUniform(rolls: string): boolean {
  return diceRollsChiSquare(rolls) <= DICE_MAX_CHI2
}

// Measures the SIZE of the entropy and not its quality, which the uniformity test covers.
export function diceRollsEntropyBits(rolls: string): number {
  const n = rolls.length
  if (n === 0) {
    return 0
  }
  let perRoll = 0
  for (const c of diceRollsDistribution(rolls)) {
    if (c > 0) {
      const p = c / n
      perRoll -= p * Math.log2(p)
    }
  }
  return n * perRoll
}

// Deliberately bypasses the CSPRNG, since dice exist to give auditable offline entropy.
// Entropy is SHA-256 of the ASCII roll string (Coldcard's method, as base-6 accumulation biases,
// see iancoleman/bip39#435). Never mix in the system RNG, and never log or persist the rolls.
export function mnemonicFromDiceRolls(rolls: string, length: MnemonicLength = 12): string {
  if (!/^[1-6]+$/.test(rolls)) {
    throw new Error('refusing dice seed: rolls must be digits 1-6 only, with no spaces or separators')
  }
  if (new Set(rolls).size === 1) {
    throw new Error('refusing dice seed: every roll is identical, enter your real dice rolls')
  }
  const min = DICE_MIN_ROLLS[length]
  if (rolls.length < min) {
    throw new Error(`refusing a weak seed: need at least ${min} rolls for ${length} words, got ${rolls.length}`)
  }
  // Blocks rather than warns, stricter than Krux, because a loaded die passes the count check.
  if (!diceRollsUniform(rolls)) {
    throw new Error('refusing a weak seed: rolls are too skewed to be a fair die, vary the results')
  }
  const digest = sha256(Buffer.from(rolls, 'ascii'))
  const entropy = Buffer.from(length === 24 ? digest : digest.slice(0, 16))
  return bip39.entropyToMnemonic(entropy)
}

export function validateMnemonic(mnemonic: string): boolean {
  return bip39.validateMnemonic(mnemonic)
}

export async function saveMnemonic(mnemonic: string): Promise<void> {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('invalid mnemonic')
  }
  await Keychain.setGenericPassword('seed', mnemonic, {
    service: SERVICE,
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

// The primary keeps the original single-entry Keychain key, so it needs no migration.
export const PRIMARY_ID = 'primary'

function serviceFor(id: string): string {
  return id === PRIMARY_ID ? SERVICE : `${SERVICE}.${id}`
}

export async function saveSeedFor(id: string, mnemonic: string): Promise<void> {
  if (!validateMnemonic(mnemonic)) {
    throw new Error('invalid mnemonic')
  }
  await Keychain.setGenericPassword('seed', mnemonic, {
    service: serviceFor(id),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function loadSeedFor(id: string): Promise<string | null> {
  const creds = await Keychain.getGenericPassword({ service: serviceFor(id) })
  return creds ? creds.password : null
}

// Avoids pulling the plaintext seed into the JS heap on every cold start.
export async function hasSeedFor(id: string): Promise<boolean> {
  return Keychain.hasGenericPassword({ service: serviceFor(id) })
}

export async function deleteSeedFor(id: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: serviceFor(id) })
}

// The wallet a Keychain service holds the entry of, or null for any other service. `base` is the
// primary's own service, which every other wallet's extends with its id.
function idOfService(service: string, base: string): string | null {
  if (service === base) {
    return PRIMARY_ID
  }
  const prefix = `${base}.`
  return service.startsWith(prefix) && service.length > prefix.length ? service.slice(prefix.length) : null
}

// The ids of the wallets whose seeds are on this device, for rebuilding a list of wallets that cannot
// be read. iOS lists every generic password service of the app, and Android every AndroidKeyStore
// alias of the ciphers in use, which can name a key whose entry is gone, so an id is kept only after
// its presence read answers present. skipUIAuth keeps the listing from raising an authentication
// prompt for an item behind biometry. A read that throws propagates.
export async function listSeedIds(): Promise<string[]> {
  const ids: string[] = []
  for (const service of await Keychain.getAllGenericPasswordServices({ skipUIAuth: true })) {
    const id = idOfService(service, SERVICE)
    if (id !== null && !ids.includes(id) && (await hasSeedFor(id))) {
      ids.push(id)
    }
  }
  return ids
}

// Optional BIP39 passphrase in its own Keychain entry. Storing it rather than prompting at each
// unlock keeps cold-start auto-connect working, at the cost of the local-extraction case.
const PASSPHRASE_SERVICE = 'com.voltz.wallet.passphrase'

function passphraseServiceFor(id: string): string {
  return id === PRIMARY_ID ? PASSPHRASE_SERVICE : `${PASSPHRASE_SERVICE}.${id}`
}

export async function savePassphraseFor(id: string, passphrase: string): Promise<void> {
  if (!passphrase) {
    // Empty means no passphrase, so a stale entry is cleared instead of opening another wallet.
    await deletePassphraseFor(id)
    return
  }
  await Keychain.setGenericPassword('passphrase', passphrase, {
    service: passphraseServiceFor(id),
    accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  })
}

export async function loadPassphraseFor(id: string): Promise<string | undefined> {
  const creds = await Keychain.getGenericPassword({ service: passphraseServiceFor(id) })
  return creds ? creds.password : undefined
}

export async function deletePassphraseFor(id: string): Promise<void> {
  await Keychain.resetGenericPassword({ service: passphraseServiceFor(id) })
}

// The ids a passphrase is stored under, seed or no seed: a kill between a wallet's two writes leaves a
// passphrase behind with no seed beside it, and no list of wallets names it.
export async function listPassphraseIds(): Promise<string[]> {
  const services = await Keychain.getAllGenericPasswordServices({ skipUIAuth: true })
  return services.flatMap(service => idOfService(service, PASSPHRASE_SERVICE) ?? [])
}
