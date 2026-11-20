import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import { BitcoinNetwork, connect } from '@breeztech/breez-sdk-spark-react-native'
import i18n from '../src/i18n'
import { ScanScreen } from '../src/screens/ScanScreen'
import { connectSpark } from '../src/wallet/spark'
import { buildBip21 } from '../src/wallet/bip21'

// The real spark.ts classifies against the mocked binding, so what the scanner sends on is what the
// SDK's answer for a bitcoin: URI makes of it, not a kind the test picked.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => null),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp-spark'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp-spark'),
}))

const mockReplace = jest.fn()
const mockNavigate = jest.fn()
const mockPopTo = jest.fn()
jest.mock('@react-navigation/native', () => ({
  useRoute: () => ({ params: undefined }),
  useNavigation: () => ({ replace: mockReplace, navigate: mockNavigate, popTo: mockPopTo }),
  useFocusEffect: () => {},
  useIsFocused: () => true,
}))

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as { __sdkInstance: { parse: jest.Mock } }
).__sdkInstance

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const ADDRESS = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'
const SPARK = 'spark1pgss9qf5m8zrcx2h4uxsfjc3vjkzwm9q6rsc0m3j9qkp8dhu0y5jl9xy2w8r'

// The legs in the shape the SDK hands them, one parsed InputType each (parse_bip_21).
function answerAsTheSdk(uri: string, ...paymentMethods: unknown[]) {
  sdk.parse.mockImplementation(async (input: string) => {
    if (input !== uri) {
      throw new Error('invalid input')
    }
    return { tag: 'Bip21', inner: [{ amountSat: 5_000n, uri, paymentMethods, extras: [] }] }
  })
}
const onchainLeg = { tag: 'BitcoinAddress', inner: [{ address: ADDRESS, network: BitcoinNetwork.Bitcoin }] }
const sparkLeg = { tag: 'SparkAddress', inner: [{ address: SPARK }] }
const expiredInvoice = {
  tag: 'Bolt11Invoice',
  inner: [{ invoice: { bolt11: 'lnbc1expired' }, timestamp: 1_000n, expiry: 3_600n }],
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => [node.props.children].flat())
    .filter((child): child is string => typeof child === 'string')
    .join(' ')
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const found = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!found) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    found.props.onPress()
  })
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

async function typeIntoScan(code: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ScanScreen />)
  })
  await press(tree, 'Type')
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(code)
  })
  await press(tree, 'Continue')
  return tree
}

beforeEach(async () => {
  jest.clearAllMocks()
  // The connection persists across cases, so the instance it holds is the one each case drives.
  jest.mocked(connect).mockResolvedValue(sdk as never)
  await connectSpark(MNEMONIC)
})

test("Voltz's own receive code, with a Spark leg, goes on to Send whole", async () => {
  const uri = buildBip21({ address: ADDRESS, amountSat: 5_000, spark: SPARK })
  answerAsTheSdk(uri, onchainLeg, sparkLeg)

  const tree = await typeIntoScan(uri)

  expect(sdk.parse).toHaveBeenCalledWith(uri)
  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: uri, picked: expect.any(Number) })
  expect(texts(tree)).not.toContain(i18n.t('errors.invalidInput'))
})

test('a bitcoin: URI with an address alone goes on to Send', async () => {
  const uri = buildBip21({ address: ADDRESS })
  answerAsTheSdk(uri, onchainLeg)

  await typeIntoScan(uri)

  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: uri, picked: expect.any(Number) })
})

test('a unified code whose invoice expired still goes on to Send, which says so before paying', async () => {
  const uri = buildBip21({ address: ADDRESS, lightning: 'lnbc1expired' })
  answerAsTheSdk(uri, onchainLeg, expiredInvoice)

  await typeIntoScan(uri)

  expect(mockPopTo).toHaveBeenCalledWith('Send', { destination: uri, picked: expect.any(Number) })
})

test('a code with no leg this wallet pays is still not recognised', async () => {
  const uri = 'bitcoin:?lightning=lnbc1expired'
  answerAsTheSdk(uri, expiredInvoice)

  const tree = await typeIntoScan(uri)

  expect(mockPopTo).not.toHaveBeenCalled()
  expect(mockReplace).not.toHaveBeenCalled()
  expect(texts(tree)).toContain(i18n.t('errors.invalidInput'))
})
