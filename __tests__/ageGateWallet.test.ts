import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { addAndActivateWallet, addFirstWallet, isWalletAlreadyAdded } from '../src/wallet/wallet'
import { __resetAgeSignalForTests, isAgeRefusal } from '../src/wallet/ageSignal'
import { loadRegistry } from '../src/wallet/walletRegistry'

// The writer of every new wallet refuses one for a person the store's age signal says is under 18, and
// writes nothing first; a wallet already on the device is not new, and goes on.

jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(),
  connectSpark: jest.fn(),
  disconnectSpark: jest.fn(async () => undefined),
  disconnectSparkWhenIdle: jest.fn(async () => undefined),
  SparkReconnectBusy: class extends Error {},
}))

type AgeStore = typeof import('../specs/__mocks__/NativeVoltzAge').ageStore
const store: AgeStore = jest.requireMock('../specs/NativeVoltzAge').ageStore

const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const OTHER = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const SEED = 'com.voltz.wallet.seed'

const keychain = new Map<string, string>()
const seeds = (): string[] => [...keychain.keys()].filter(service => service.startsWith(SEED))

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __resetAgeSignalForTests()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockReset()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
})

describe.each([
  ['addFirstWallet', (words: string) => addFirstWallet(words, undefined, 'typed')],
  ['addAndActivateWallet', (words: string) => addAndActivateWallet(words, undefined, 'typed')],
])('%s', (_name, add) => {
  test('refuses a new wallet for a minor, and writes nothing', async () => {
    store.shares(13, 15)
    const refused = await add(WORDS).catch((err: unknown) => err)
    expect(isAgeRefusal(refused)).toBe(true)
    expect(seeds()).toEqual([])
    expect((await loadRegistry()).wallets).toEqual([])
  })

  test('adds a new wallet for an adult', async () => {
    store.shares(18, -1)
    await add(WORDS)
    expect(seeds()).toHaveLength(1)
  })

  test('adds a new wallet when the store marks nobody as regulated', async () => {
    store.regulated(false)
    await add(WORDS)
    expect(seeds()).toHaveLength(1)
    expect(store.calls.request).toBe(0)
  })

  test('adds a new wallet when the store fails to answer', async () => {
    store.regulated(true)
    store.requestFails('play-3')
    await add(WORDS)
    expect(seeds()).toHaveLength(1)
  })
})

// A wallet already on the device is never refused for age.
describe('a wallet already here', () => {
  test('the first run writing the same wallet again goes on for a minor', async () => {
    const id = await addFirstWallet(WORDS, undefined, 'typed')
    __resetAgeSignalForTests()
    store.shares(13, 15)
    expect(await addFirstWallet(WORDS, undefined, 'typed')).toBe(id)
  })

  test('adding words already here names that wallet for a minor, rather than refusing for age', async () => {
    const id = await addFirstWallet(WORDS, undefined, 'typed')
    __resetAgeSignalForTests()
    store.shares(13, 15)
    const err = await addAndActivateWallet(WORDS, undefined, 'typed').catch((e: unknown) => e)
    expect(isWalletAlreadyAdded(err)).toBe(true)
    expect((err as { walletId: string }).walletId).toBe(id)
  })

  test('a second, new wallet is still refused for a minor while the first stays', async () => {
    await addFirstWallet(WORDS, undefined, 'typed')
    __resetAgeSignalForTests()
    store.shares(13, 15)
    const refused = await addAndActivateWallet(OTHER, undefined, 'typed').catch((e: unknown) => e)
    expect(isAgeRefusal(refused)).toBe(true)
    expect(seeds()).toHaveLength(1)
    expect((await loadRegistry()).wallets).toHaveLength(1)
  })
})
