import RNFS from 'react-native-fs'
import { getWalletIdentity, walletIdentityOf } from '../src/wallet/wallet'
import { carryWalletMeta, loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'

// The drawer, Edit wallet and the recovery phrase screen read a wallet's id right after the PIN. The
// synchronous derivation is wrapped so a call to it shows, and the async one runs as it does on device.
jest.mock('../src/wallet/fingerprint', () => {
  const actual = jest.requireActual('../src/wallet/fingerprint')
  return { ...actual, fingerprintFromMnemonic: jest.fn(actual.fingerprintFromMnemonic) }
})
const keychain: Record<string, string> = {}
jest.mock('../src/wallet/seed', () => ({
  PRIMARY_ID: 'primary',
  loadSeedFor: jest.fn(async (id: string) => keychain[`seed:${id}`] ?? null),
  loadPassphraseFor: jest.fn(async (id: string) => keychain[`pass:${id}`]),
  hasSeedFor: jest.fn(async (id: string) => `seed:${id}` in keychain),
}))
jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
  disconnectSpark: jest.fn(async () => undefined),
}))

const actual = jest.requireActual('../src/wallet/fingerprint') as typeof import('../src/wallet/fingerprint')
const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
const SECRET = 'correct horse'
const WORDS_ONLY = actual.fingerprintFromMnemonic(WORDS)
const WITH_SECRET = actual.fingerprintFromMnemonic(WORDS, SECRET)

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  for (const key of Object.keys(keychain)) {
    delete keychain[key]
  }
  jest.mocked(fingerprintFromMnemonic).mockClear()
})

test("a passphrase wallet's id and its carried name come from the async derivation only", async () => {
  keychain['seed:primary'] = WORDS
  keychain['pass:primary'] = SECRET
  await saveWalletMeta(WORDS_ONLY, { name: 'Savings' })
  expect(await getWalletIdentity()).toEqual({ fingerprint: WITH_SECRET })
  expect((await loadWalletMeta(WITH_SECRET)).name).toBe('Savings')
  expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
})

test('the recovery phrase read of a wallet without a passphrase never runs the synchronous derivation', async () => {
  expect(await walletIdentityOf(WORDS, undefined)).toEqual({ fingerprint: WORDS_ONLY })
  expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
})

test('a name saved while the legacy key is derived is kept, not written over by the carry', async () => {
  await saveWalletMeta(WORDS_ONLY, { name: 'Old' })
  let derive!: (key: string) => void
  const carried = carryWalletMeta(WITH_SECRET, () => new Promise<string>(resolve => (derive = resolve)))
  for (let i = 0; i < 5; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  await saveWalletMeta(WITH_SECRET, { name: 'New' })
  derive(WORDS_ONLY)
  await carried
  expect((await loadWalletMeta(WITH_SECRET)).name).toBe('New')
})
