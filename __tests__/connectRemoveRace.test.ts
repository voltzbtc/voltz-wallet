import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { connectActiveSpark } from '../src/wallet/spark'
import { removeActiveWallet } from '../src/wallet/wallet'
import { loadRegistry, type Registry } from '../src/wallet/walletRegistry'
import { hasSeedFor } from '../src/wallet/seed'
import { fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'

// The real wallet, registry, seed and spark modules over the in-memory fs and a Keychain that keeps
// what it is given. Only the SDK binding (its manual mock) and the post-connect derivation, which is
// held open on demand, stand in.
jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/fingerprint', () => {
  const actual = jest.requireActual('../src/wallet/fingerprint')
  return { ...actual, fingerprintFromMnemonicAsync: jest.fn(actual.fingerprintFromMnemonicAsync) }
})

const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`
const SEED = 'com.voltz.wallet.seed'
const seedService = (id: string): string => (id === 'primary' ? SEED : `${SEED}.${id}`)
const keychain = new Map<string, string>()

const WORDS_A =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const WORDS_B = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

const START: Registry = {
  wallets: [
    { id: 'primary', fingerprint: 'fpA' },
    { id: 'w_x', fingerprint: 'fpB' },
  ],
  active: 'w_x',
}

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
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
  keychain.set(seedService('primary'), WORDS_A)
  keychain.set(seedService('w_x'), WORDS_B)
  await RNFS.writeFile(REGISTRY, JSON.stringify(START), 'utf8')
})

afterEach(() => {
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async () => false)
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async () => false)
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async () => false)
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async () => true)
})

// Holds the derivation that registers the wallet open until released, and says when it has started.
// It is the only derivation a connect makes.
function holdRegisteringDerivation(): { started: Promise<void>; release: () => void } {
  const actual = jest.requireActual('../src/wallet/fingerprint') as typeof import('../src/wallet/fingerprint')
  let release!: () => void
  let started!: () => void
  const gate = new Promise<void>(resolve => (release = resolve))
  const began = new Promise<void>(resolve => (started = resolve))
  jest.mocked(fingerprintFromMnemonicAsync).mockImplementationOnce(async (mnemonic, passphrase) => {
    started()
    await gate
    return actual.fingerprintFromMnemonicAsync(mnemonic, passphrase)
  })
  return { started: began, release }
}

describe('a wallet removed while a connect derives its fingerprint', () => {
  it('is not listed again once the derivation resolves', async () => {
    const held = holdRegisteringDerivation()
    const connecting = connectActiveSpark()
    await held.started

    await removeActiveWallet()
    expect(await hasSeedFor('w_x')).toBe(false)
    expect((await loadRegistry()).wallets.map(w => w.id)).toEqual(['primary'])

    held.release()
    await connecting

    const reg = await loadRegistry()
    expect(reg.wallets.map(w => w.id)).toEqual(['primary'])
    expect(reg.active).toBe('primary')
  })

  // With no removal, the same connect lists the wallet it connected, under the derived id.
  it('still registers the connected wallet when nothing removes it', async () => {
    await RNFS.unlink(REGISTRY)
    await connectActiveSpark()
    const reg = await loadRegistry()
    expect(reg.wallets.map(w => w.id)).toEqual(['primary'])
    expect(reg.wallets[0].fingerprint).toMatch(/^[0-9a-f]{8}$/)
  })
})
