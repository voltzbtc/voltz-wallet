import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { domainFor } from '../src/wallet/lnurlDomainPref'
import {
  connectSpark,
  disconnectSpark,
  sparkClaimLnAddressTransfer,
  sparkEnsureLnAddress,
  sparkRegisterLnAddress,
  sparkTakeLnAddress,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

// Every call that writes an address names the description. From 0.28 the SDK sends none without it,
// signed over an empty field, and the deployed gateway and LNURL server refuse that with 401, while
// the text a payer sees has to stay the one the SDK wrote by itself up to 0.27. The binding's mock
// refuses a call with no description, as the server does.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
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
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  domainFor: jest.fn(async () => undefined),
}))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<string, jest.Mock>
  }
).__sdkInstance

const MNEMONIC = `${'abandon '.repeat(11)}about`
const PUBKEY = '0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798'
const AUTHORIZATION = {
  username: 'moved',
  pubkey: PUBKEY,
  signature: '3044sig',
  domain: 'pay.a.com',
  timestamp: 1_700_000_000n,
}

const heldOn = (host: string, username = 'kept') => ({
  username,
  lightningAddress: `${username}@${host}`,
  lnurl: { url: `https://${host}/lnurlp`, bech32: 'lnurl1x' },
  description: '',
})

async function connectOn(domain: string | undefined): Promise<void> {
  await disconnectSpark()
  jest.mocked(domainFor).mockResolvedValue(domain)
  await connectSpark(MNEMONIC, 'primary')
}

const sent = (mock: jest.Mock) => (mock.mock.calls.at(-1)?.[0] as { description?: string }).description

beforeEach(async () => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUBKEY, balanceSats: 0n, tokenBalances: new Map() })
  sdk.getLightningAddress.mockResolvedValue(undefined)
  sdk.checkLightningAddressAvailable.mockResolvedValue(true)
  // No answer from the gateway, so a wallet that remembers nothing mints.
  global.fetch = jest.fn(async () => {
    throw new Error('offline')
  })
})

afterAll(async () => {
  await disconnectSpark()
})

// The build's domain, a wallet's own, and the SDK's default, which the app does not name.
describe.each([
  { label: 'the build domain', domain: 'usevoltz.app', host: 'usevoltz.app' },
  { label: 'a custom domain', domain: 'pay.a.com', host: 'pay.a.com' },
  { label: "the SDK's default", domain: undefined, host: 'breez.tips' },
])('on $label', ({ domain, host }) => {
  beforeEach(() => connectOn(domain))

  test('the customer\'s own register', async () => {
    await sparkRegisterLnAddress('alice')

    expect(sent(sdk.registerLightningAddress)).toBe(`Pay to alice@${host}`)
  })

  test('the take of a paid name', async () => {
    await sparkTakeLnAddress('alice')

    expect(sent(sdk.registerLightningAddress)).toBe(`Pay to alice@${host}`)
  })

  test('the claim of a transfer', async () => {
    await sparkClaimLnAddressTransfer(AUTHORIZATION as never)

    expect(sdk.claimLightningAddressTransfer).toHaveBeenCalledTimes(1)
    expect(sent(sdk.claimLightningAddressTransfer)).toBe(`Pay to moved@${host}`)
  })

  test('the name a generated register mints', async () => {
    await sparkEnsureLnAddress()

    const { username } = sdk.registerLightningAddress.mock.calls.at(-1)?.[0] as { username: string }
    expect(sent(sdk.registerLightningAddress)).toBe(`Pay to ${username}@${host}`)
  })
})

describe('an address left on another domain', () => {
  beforeEach(() => connectOn('pay.a.com'))

  test('the same name claimed on the domain in use names that domain', async () => {
    sdk.getLightningAddress.mockResolvedValue(heldOn('old.example'))

    await sparkEnsureLnAddress()

    expect(sdk.registerLightningAddress).toHaveBeenCalledWith({
      username: 'kept',
      description: 'Pay to kept@pay.a.com',
    })
  })

  test('the generated name after that claim is refused names it too', async () => {
    sdk.getLightningAddress.mockResolvedValue(heldOn('old.example'))
    sdk.checkLightningAddressAvailable.mockResolvedValueOnce(false)

    await sparkEnsureLnAddress()

    const { username } = sdk.registerLightningAddress.mock.calls.at(-1)?.[0] as { username: string }
    expect(username).not.toBe('kept')
    expect(sent(sdk.registerLightningAddress)).toBe(`Pay to ${username}@pay.a.com`)
  })
})

test('a description the caller chose goes as it is', async () => {
  await connectOn('pay.a.com')

  await sparkRegisterLnAddress('alice', 'Tips for alice')

  expect(sent(sdk.registerLightningAddress)).toBe('Tips for alice')
})
