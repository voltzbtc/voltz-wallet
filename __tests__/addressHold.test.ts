import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { writeDeletionMark } from '../src/wallet/deletionMark'
import { connectSpark, sparkClaimLnAddressTransfer, sparkEnsureLnAddress } from '../src/wallet/spark'
import { classifyWalletError } from '../src/wallet/errors'
import { lastLnAddress } from '../src/wallet/lnAddressMemory'

// The address stops of spark.ts that a deletion mark holds, against the real mark file over the
// in-memory fs, as deletion.test.ts drives the rest.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
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
const NOW = 1_800_000_000
const AUTHORIZATION = { username: 'moved', pubkey: '02aa', signature: 'sig', domain: 'usevoltz.app', timestamp: NOW } as never

const addressOf = (username: string) => ({
  username,
  lightningAddress: `${username}@usevoltz.app`,
  lnurl: { url: 'https://usevoltz.app/lnurlp', bech32: 'lnurl1x' },
  description: '',
})

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.getLightningAddress.mockResolvedValue(undefined)
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => addressOf(username))
  sdk.claimLightningAddressTransfer = jest.fn(async () => addressOf('moved'))
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
})

describe('a name moved from another wallet', () => {
  test('is claimed for a wallet with no mark', async () => {
    expect((await sparkClaimLnAddressTransfer(AUTHORIZATION)).address).toBe('moved@usevoltz.app')
    expect(sdk.claimLightningAddressTransfer).toHaveBeenCalledTimes(1)
  })

  test.each(['removed', 'asked', 'pending', 'done'] as const)('is refused as deleted while the mark is %s, and never claimed', async state => {
    await writeDeletionMark('primary', { pubkey: PUBKEY, state, askedAt: NOW })
    const refusal = await sparkClaimLnAddressTransfer(AUTHORIZATION).catch((e: unknown) => e)
    expect(classifyWalletError(refusal)).toBe('deleted')
    expect(sdk.claimLightningAddressTransfer).not.toHaveBeenCalled()
  })
})

describe('an address an automatic register made while a request was being asked', () => {
  test('is remembered for a wallet with no mark', async () => {
    const made = await sparkEnsureLnAddress()
    expect(made).not.toBeNull()
    expect(await lastLnAddress('primary')).toBe(made?.address)
  })

  test('is not remembered once the mark is written, so nothing claims it back later', async () => {
    // The mark lands while the register is on the wire: the ensure passed its own check before it.
    sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => {
      await writeDeletionMark('primary', { pubkey: PUBKEY, state: 'asked', askedAt: NOW })
      return addressOf(username)
    })
    await sparkEnsureLnAddress()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    expect(await lastLnAddress('primary')).toBeNull()
  })
})
