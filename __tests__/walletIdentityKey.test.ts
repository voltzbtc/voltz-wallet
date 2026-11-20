import RNFS from 'react-native-fs'
import { addAndActivateWallet, getWalletIdentity } from '../src/wallet/wallet'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'

// The drawer, Edit wallet and the recovery phrase screen read a wallet's id here, and the wallets
// list, the picker and the domain screen read the registry. The registry, the meta store and the
// fingerprint are the real modules over the in-memory fs, so a name saved under one key and looked up
// under another shows up as the default it would show on screen.
const keychain: Record<string, string> = {}
jest.mock('../src/wallet/seed', () => ({
  PRIMARY_ID: 'primary',
  saveSeedFor: jest.fn(async (id: string, words: string) => {
    keychain[`seed:${id}`] = words
  }),
  loadSeedFor: jest.fn(async (id: string) => keychain[`seed:${id}`] ?? null),
  savePassphraseFor: jest.fn(async (id: string, secret: string) => {
    keychain[`pass:${id}`] = secret
  }),
  loadPassphraseFor: jest.fn(async (id: string) => keychain[`pass:${id}`]),
  hasSeedFor: jest.fn(async (id: string) => `seed:${id}` in keychain),
  deleteSeedFor: jest.fn(),
  deletePassphraseFor: jest.fn(),
}))
jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
  disconnectSpark: jest.fn(async () => undefined),
}))

const WORDS = 'abandon ability able about above absent absorb abstract absurd abuse access accident'
const SECRET = 'correct horse'
const WORDS_ONLY = fingerprintFromMnemonic(WORDS)
const WITH_SECRET = fingerprintFromMnemonic(WORDS, SECRET)
const META_FILE = `${RNFS.DocumentDirectoryPath}/wallet-meta.json`

async function metaFile(): Promise<string | null> {
  return (await RNFS.exists(META_FILE)) ? RNFS.readFile(META_FILE, 'utf8') : null
}

async function listKey(): Promise<string> {
  const reg = await loadRegistry()
  return reg.wallets.find(w => w.id === reg.active)!.fingerprint
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  for (const key of Object.keys(keychain)) {
    delete keychain[key]
  }
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  jest.mocked(console.warn).mockRestore()
})

it("gives a passphrase wallet the wallets list's id, so a name set in Edit shows in the list", async () => {
  expect(WITH_SECRET).not.toBe(WORDS_ONLY)
  await addAndActivateWallet(WORDS, SECRET)

  const { fingerprint } = await getWalletIdentity()
  expect(fingerprint).toBe(WITH_SECRET)
  expect(fingerprint).toBe(await listKey())

  await saveWalletMeta(fingerprint, { name: 'Savings', color: '#3e63dd' })
  expect(await loadWalletMeta(await listKey())).toEqual({ name: 'Savings', color: '#3e63dd' })
})

it('carries a name, colour and image saved under the words-only key over to the registry key', async () => {
  const saved = { name: 'Savings', color: '#e5484d', imagePath: `/mock/Documents/wallet-avatars/${WORDS_ONLY}-1.jpg` }
  await saveWalletMeta(WORDS_ONLY, saved)
  await addAndActivateWallet(WORDS, SECRET)

  await getWalletIdentity()

  expect(await loadWalletMeta(await listKey())).toEqual(saved)
  // The words without the passphrase are another wallet, and the entry stays its own.
  expect(await loadWalletMeta(WORDS_ONLY)).toEqual(saved)
})

it('carries over once, and never over a name the wallet has since been given', async () => {
  await saveWalletMeta(WORDS_ONLY, { name: 'Savings' })
  await addAndActivateWallet(WORDS, SECRET)
  await getWalletIdentity()

  await saveWalletMeta(WORDS_ONLY, { name: 'Decoy' })
  await getWalletIdentity()
  expect((await loadWalletMeta(WITH_SECRET)).name).toBe('Savings')

  await saveWalletMeta(WITH_SECRET, { name: 'Vault' })
  await getWalletIdentity()
  expect((await loadWalletMeta(WITH_SECRET)).name).toBe('Vault')
})

it('carries nothing over for a passphrase wallet the old key never named', async () => {
  await addAndActivateWallet(WORDS, SECRET)
  await getWalletIdentity()

  await saveWalletMeta(WORDS_ONLY, { name: 'Decoy' })
  await getWalletIdentity()
  expect(await loadWalletMeta(WITH_SECRET)).toEqual({})
})

it('keeps the one key of a wallet without a passphrase, and writes nothing to read it', async () => {
  await addAndActivateWallet(WORDS)

  const { fingerprint } = await getWalletIdentity()
  expect(fingerprint).toBe(WORDS_ONLY)
  expect(fingerprint).toBe(await listKey())
  expect(await metaFile()).toBeNull()

  await saveWalletMeta(WORDS_ONLY, { name: 'Daily', color: '#30a46c' })
  const before = await metaFile()
  await getWalletIdentity()
  expect(await loadWalletMeta(await listKey())).toEqual({ name: 'Daily', color: '#30a46c' })
  expect(await metaFile()).toBe(before)
})

it('leaves an unreadable meta file as it is and still names the wallet by its registry id', async () => {
  // A carry built on a store that failed to parse would replace every wallet's entry with one.
  await addAndActivateWallet(WORDS, SECRET)
  await RNFS.writeFile(META_FILE, '{"broken', 'utf8')

  const { fingerprint } = await getWalletIdentity()

  expect(fingerprint).toBe(WITH_SECRET)
  expect(await metaFile()).toBe('{"broken')
  expect(console.warn).toHaveBeenCalled()
})

it('names no wallet when the active one has no words', async () => {
  expect(await getWalletIdentity()).toEqual({ fingerprint: '' })
  expect(await metaFile()).toBeNull()
})
