import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import * as sdk from '@breeztech/breez-sdk-spark-react-native'
import {
  SparkConnectSuperseded,
  connectActiveSpark,
  disconnectSpark,
  sparkConnectedWalletId,
} from '../src/wallet/spark'
import { addFirstWallet, eraseAllWallets } from '../src/wallet/wallet'
import { loadRegistry } from '../src/wallet/walletRegistry'

// Forgot PIN erases every wallet from the lock drawn over a running wallet, where Home's live reads
// call connectActiveSpark on a timer, on a return and on SDK events. The next first wallet takes the
// erased primary id, and connectActiveSpark keeps a connection already on that id, so a connect that
// lands on the erased seed while the erase runs would hand out the erased wallet's addresses. The real
// wallet and spark modules run here over the SDK mock, an in-memory fs and a Keychain that keeps what
// it is given.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
  getDistribution: () => 'store',
}))

const REGISTRY = `${RNFS.DocumentDirectoryPath}/wallets.json`
const SEED = 'com.voltz.wallet.seed'
const PASSPHRASE = 'com.voltz.wallet.passphrase'
const ERASED = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const NEXT = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const keychain = new Map<string, string>()
const sdkInstance = (sdk as unknown as { __sdkInstance: { disconnect: jest.Mock } }).__sdkInstance

function connects(): number {
  return jest.mocked(sdk.connect).mock.calls.length
}

function lastSeed(): unknown {
  return (jest.mocked(sdk.connect).mock.calls.at(-1)?.[0] as { seed: unknown }).seed
}

beforeEach(async () => {
  // Each test starts with nothing connected, as the app does at the lock after a boot.
  await disconnectSpark()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_u, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementation(async () => [...keychain.keys()])
  keychain.set(SEED, ERASED)
  keychain.set('com.voltz.wallet.pin', '123456')
  await RNFS.writeFile(
    REGISTRY,
    JSON.stringify({ wallets: [{ id: 'primary', fingerprint: 'fp' }], active: 'primary' }),
    'utf8',
  )
})

// What the next first wallet does once the erase is over: it takes the primary id and connects its own
// words, which a connection left on the erased seed would stop.
async function nextWalletConnectsItsOwnWords(): Promise<void> {
  expect(sparkConnectedWalletId()).toBeNull()
  expect(keychain.has(SEED)).toBe(false)
  await addFirstWallet(NEXT, undefined, 'drawn')
  const before = connects()
  await connectActiveSpark()
  expect(connects() - before).toBe(1)
  expect(lastSeed()).toEqual(expect.objectContaining({ mnemonic: NEXT }))
}

test('a connect asked after the erase dropped the connection and before the seed went is refused', async () => {
  await connectActiveSpark()
  expect(sparkConnectedWalletId()).toBe('primary')
  const before = connects()

  let asked: Promise<void> | null = null
  const list = jest.mocked(Keychain.getAllGenericPasswordServices).getMockImplementation()!
  jest.mocked(Keychain.getAllGenericPasswordServices).mockImplementationOnce(async () => {
    // The erase's first Keychain listing, past its disconnect, with the primary seed still stored.
    asked = connectActiveSpark()
    asked.catch(() => undefined)
    return list()
  })
  await eraseAllWallets()

  expect(asked).not.toBeNull()
  await expect(asked).rejects.toBeInstanceOf(SparkConnectSuperseded)
  expect(connects()).toBe(before)
  await nextWalletConnectsItsOwnWords()
})

test('a connect asked while the SDK is still closing the erased wallet is refused', async () => {
  await connectActiveSpark()
  const before = connects()
  let asked: Promise<void> | null = null
  sdkInstance.disconnect.mockImplementationOnce(async () => {
    asked = connectActiveSpark()
    asked.catch(() => undefined)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  await eraseAllWallets()

  await expect(asked).rejects.toBeInstanceOf(SparkConnectSuperseded)
  expect(connects()).toBe(before)
  await nextWalletConnectsItsOwnWords()
})

test('a connect already registering its wallet is waited for, so the erase leaves no wallet listed', async () => {
  await RNFS.unlink(REGISTRY)
  // The second passphrase read is the one after the connection landed, before the registry write.
  let reads = 0
  let release!: () => void
  const held = new Promise<void>(resolve => (release = resolve))
  const read = jest.mocked(Keychain.getGenericPassword).getMockImplementation()!
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    if (options?.service === PASSPHRASE && ++reads === 2) {
      await held
    }
    return read(options)
  })
  const connecting = connectActiveSpark()
  for (let i = 0; i < 20 && reads < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 0))
  }
  expect(reads).toBe(2)

  let erased = false
  const erasing = eraseAllWallets().then(() => {
    erased = true
  })
  await new Promise(resolve => setTimeout(resolve, 0))
  expect(erased).toBe(false)
  // The erase has not begun, and nothing was disconnected, while the connect it waits for holds its last step.
  expect(sdkInstance.disconnect).not.toHaveBeenCalled()
  release()
  await connecting
  await erasing

  expect((await loadRegistry()).wallets).toEqual([])
  await nextWalletConnectsItsOwnWords()
})

test('a connect after the erase ended is not refused', async () => {
  await eraseAllWallets()
  await addFirstWallet(NEXT, undefined, 'drawn')
  await expect(connectActiveSpark()).resolves.toBeUndefined()
  expect(sparkConnectedWalletId()).toBe('primary')
})
