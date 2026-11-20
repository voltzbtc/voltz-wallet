import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { connectSpark, sparkRegisterLnAddress, sparkTakeLnAddress } from '../src/wallet/spark'
import { lastLnAddress } from '../src/wallet/lnAddressMemory'

// The take of a paid name (recover.ts, takeName): the address read and the register in one turn of
// the address queue, so two takers of one name register it once and a register that lands meanwhile is
// never replaced.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<string, jest.Mock>
  }
).__sdkInstance

const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'

const addressOf = (username: string) => ({
  username,
  lightningAddress: `${username}@usevoltz.app`,
  lnurl: { url: 'https://usevoltz.app/lnurlp', bech32: 'lnurl1x' },
  description: '',
})

// The server's one address for this wallet, which a register replaces.
let onServer: ReturnType<typeof addressOf> | undefined

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  onServer = undefined
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.getLightningAddress.mockImplementation(async () => onServer)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
    onServer = addressOf(username)
    return onServer
  })
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark('abandon '.repeat(11) + 'about')
})

test('two takes of one name at once register it once, and the second finds it held', async () => {
  const [first, second] = await Promise.all([sparkTakeLnAddress('alice'), sparkTakeLnAddress('alice')])
  expect(first).toMatchObject({ registered: { username: 'alice' } })
  expect(second).toMatchObject({ held: { username: 'alice' } })
  expect(sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)).toEqual(['alice'])
  expect(await lastLnAddress('primary')).toBe('alice@usevoltz.app')
})

test('a register queued ahead of a take is never replaced by it', async () => {
  let answer!: () => void
  sdk.registerLightningAddress.mockImplementationOnce(async ({ username }: { username: string }) => {
    await new Promise<void>(resolve => (answer = resolve))
    onServer = addressOf(username)
    return onServer
  })
  const chosen = sparkRegisterLnAddress('bob')
  const take = sparkTakeLnAddress('alice')
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  answer()
  await chosen
  expect(await take).toMatchObject({ held: { username: 'bob' } })
  expect(sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)).toEqual(['bob'])
})

// A register asked for while the take is out waits for the whole take, so the name chosen is the one
// left on the wallet, never replaced by a take that read the address before it landed.
test('a register asked for while a take is out lands after it and stays', async () => {
  const take = sparkTakeLnAddress('alice')
  const chosen = sparkRegisterLnAddress('bob')
  expect(await take).toMatchObject({ registered: { username: 'alice' } })
  await chosen
  expect(sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)).toEqual(['alice', 'bob'])
  expect(onServer?.username).toBe('bob')
})

test('an address that cannot be read registers nothing', async () => {
  sdk.getLightningAddress.mockRejectedValueOnce(new Error('SdkError.NetworkError'))
  expect(await sparkTakeLnAddress('alice')).toEqual({ unread: true })
  expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
})

test('a register the server refuses rejects and remembers nothing', async () => {
  sdk.registerLightningAddress.mockRejectedValueOnce(new Error('name is reserved'))
  await expect(sparkTakeLnAddress('alice')).rejects.toThrow('name is reserved')
  expect(await lastLnAddress('primary')).toBeNull()
})

// A take for the wallet that paid goes on only that wallet's connection. After a switch the live
// connection is another wallet's, and its key would register the name, so nothing is read or
// registered and the take answers `elsewhere`.
describe('a take for the wallet that paid', () => {
  const MNEMONIC = 'abandon '.repeat(11) + 'about'

  test('reads and registers nothing while the session is on another wallet', async () => {
    expect(await sparkTakeLnAddress('alice', 'w_a')).toEqual({ elsewhere: true })
    expect(sdk.getLightningAddress).not.toHaveBeenCalled()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('registers nothing when the session reconnects to another wallet while the address is read', async () => {
    sdk.getLightningAddress.mockImplementationOnce(async () => {
      await connectSpark(MNEMONIC, 'w_b')
      return undefined
    })
    expect(await sparkTakeLnAddress('alice', 'primary')).toEqual({ elsewhere: true })
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('w_b')).toBeNull()
  })

  test('control: registers on the connection of the wallet that paid, and remembers it there', async () => {
    expect(await sparkTakeLnAddress('alice', 'primary')).toMatchObject({ registered: { username: 'alice' } })
    expect(sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)).toEqual(['alice'])
    expect(await lastLnAddress('primary')).toBe('alice@usevoltz.app')
  })
})

// The customer's register of a name paid for as one wallet goes only on that wallet's connection, by
// the take's rule. Read right before the register, a live connection that is another wallet's, or that a
// reconnect replaced while the register waited for its turn, registers nothing and answers null.
describe('a register for the wallet that paid', () => {
  const MNEMONIC = 'abandon '.repeat(11) + 'about'

  test('registers nothing while the session is on another wallet', async () => {
    expect(await sparkRegisterLnAddress('alice', undefined, 'w_a')).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('registers nothing when the session reconnects to another wallet while it waits for its turn', async () => {
    sdk.getLightningAddress.mockImplementationOnce(async () => {
      await connectSpark(MNEMONIC, 'w_b')
      return addressOf('bob')
    })
    const take = sparkTakeLnAddress('bob')
    const chosen = sparkRegisterLnAddress('alice', undefined, 'primary')
    expect(await take).toMatchObject({ held: { username: 'bob' } })
    expect(await chosen).toBeNull()
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
    expect(await lastLnAddress('w_b')).toBeNull()
    expect(await lastLnAddress('primary')).toBeNull()
  })

  test('control: registers on the connection of the wallet that paid, and remembers it there', async () => {
    expect(await sparkRegisterLnAddress('alice', undefined, 'primary')).toMatchObject({ username: 'alice' })
    expect(sdk.registerLightningAddress.mock.calls.map(([req]) => req.username)).toEqual(['alice'])
    expect(await lastLnAddress('primary')).toBe('alice@usevoltz.app')
  })
})
