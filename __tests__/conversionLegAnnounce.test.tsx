import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { connect, PaymentType, SdkEvent_Tags } from '@breeztech/breez-sdk-spark-react-native'
import '../src/i18n'
import { ReceivedOverlayHost } from '../src/components/ReceivedOverlayHost'
import {
  CONVERSION_INFO_WAIT_MS,
  connectSpark,
  disconnectSpark,
  sparkSubscribeToReceives,
  type ReceiveUpdate,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { USDB } from '../src/wallet/tokens'

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))
jest.mock('../src/components/ReceivedOverlay', () => {
  const react = require('react')
  const rn = require('react-native')
  return {
    ReceivedOverlay: ({ amount }: { amount: { value: number; unit: string } }) =>
      react.createElement(rn.Text, null, `overlay ${amount.value} ${amount.unit}`),
  }
})

const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<'addEventListener' | 'removeEventListener' | 'getPayment' | 'listFiatRates', jest.Mock>
  }
).__sdkInstance

type Listener = { onEvent: (event: unknown) => Promise<void> }

const ID = 'c5a2e1f0-0000-7000-8000-000000000001'
const amm = (purpose: string) => ({
  tag: 'Amm',
  inner: { poolId: 'pool', conversionId: 'c1', status: 0, purpose: { tag: purpose } },
})
const bareSats = (inner: object = {}) => ({
  id: ID,
  paymentType: PaymentType.Receive,
  status: 0,
  amount: 31_473n,
  fees: 0n,
  timestamp: 1n,
  details: { tag: 'Spark', inner },
})
const bareToken = (inner: object = {}) => ({
  ...bareSats(),
  amount: 25_337_999n,
  details: { tag: 'Token', inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 }, ...inner } },
})
const succeeded = (payment: object) => ({ tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment } })

let listener: Listener

beforeEach(async () => {
  jest.clearAllMocks()
  jest.mocked(connect).mockResolvedValue(sdk as never)
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  sdk.addEventListener.mockImplementation(async (l: Listener) => {
    listener = l
    return 'listener_1'
  })
  sdk.getPayment.mockImplementation(async () => ({ payment: bareSats() }))
  await disconnectSpark().catch(() => undefined)
  await connectSpark('abandon abandon abandon')
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
})

async function subscribe(): Promise<{ updates: ReceiveUpdate[]; off: () => void }> {
  const updates: ReceiveUpdate[] = []
  const off = await sparkSubscribeToReceives(update => updates.push(update))
  return { updates, off }
}

describe('a bare receive that settled is read again before it is announced', () => {
  test.each([
    ['sats', bareSats()],
    ['token', bareToken()],
  ])('a bare %s receive says nothing during the wait', async (_, payment) => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(payment))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS - 1)
    expect(updates).toEqual([])
    expect(sdk.getPayment).not.toHaveBeenCalled()
  })

  test.each([
    ['SelfTransfer', 'SelfTransfer'],
    ['AutoConversion', 'AutoConversion'],
  ])('a leg that turns out a %s conversion announces nothing', async (_, purpose) => {
    sdk.getPayment.mockResolvedValue({ payment: bareSats({ conversionInfo: amm(purpose) }) })
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: ID })
    expect(updates).toEqual([])
  })

  test('a transfer that stays bare is announced once the wait ends', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toEqual([{ id: ID, stage: 'received', sat: 31_473, rail: 'spark' }])
  })

  test('a token that stays bare is announced in its own unit', async () => {
    sdk.getPayment.mockResolvedValue({ payment: bareToken() })
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareToken()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ stage: 'received', asset: { ticker: 'USDB', amount: '25.337999' } })
  })

  test('a read that fails still announces, since History holds the record', async () => {
    sdk.getPayment.mockRejectedValue(new Error('storage'))
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toEqual([{ id: ID, stage: 'received', sat: 31_473, rail: 'spark' }])
  })
})

describe('what says who paid is announced at once', () => {
  test.each([
    ['an invoiced transfer', bareSats({ invoiceDetails: { invoice: 'spark1invoice' } })],
    ['an invoiced token', bareToken({ invoiceDetails: { invoice: 'spark1invoice' } })],
    ['an HTLC', bareSats({ htlcDetails: { paymentHash: 'ab' } })],
    ['a cross-chain receive', bareToken({ conversionInfo: { tag: 'Orchestra', inner: { chain: 'tron', asset: 'USDT' } } })],
    ['a Lightning receive', { ...bareSats(), details: { tag: 'Lightning', inner: { destinationPubkey: '02x' } } }],
    ['a deposit', { ...bareSats(), details: { tag: 'Deposit', inner: { txId: 'tx' } } }],
  ])('%s', async (_, payment) => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(payment))
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ stage: 'received' })
    expect(sdk.getPayment).not.toHaveBeenCalled()
  })
})

describe('one payment, one wallet', () => {
  test('repeated events of one payment announce it once and read it once', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toHaveLength(1)
    expect(sdk.getPayment).toHaveBeenCalledTimes(1)
  })

  test('two payments are two announcements', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await listener.onEvent(succeeded({ ...bareSats(), id: 'other', amount: 7n }))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toHaveLength(2)
  })

  test('a repeated Lightning event is not a second overlay', async () => {
    const lightning = { ...bareSats(), details: { tag: 'Lightning', inner: { destinationPubkey: '02x' } } }
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(lightning))
    await listener.onEvent(succeeded(lightning))
    expect(updates).toHaveLength(1)
  })

  test('the memory of what was announced keeps the latest payments', async () => {
    const lightning = (id: string) => ({
      ...bareSats(),
      id,
      details: { tag: 'Lightning', inner: { destinationPubkey: '02x' } },
    })
    const { updates } = await subscribe()
    for (let i = 0; i < 65; i++) {
      await listener.onEvent(succeeded(lightning(`p${i}`)))
    }
    await listener.onEvent(succeeded(lightning('p64')))
    expect(updates).toHaveLength(65)
  })

  test('a move of the active wallet during the wait announces nothing', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    jest.mocked(getActiveWalletId).mockResolvedValue('second')
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toEqual([])
  })

  test('a registry that cannot be read during the wait announces nothing', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    jest.mocked(getActiveWalletId).mockRejectedValue(new Error('read'))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(updates).toEqual([])
  })

  test('a disconnect during the wait announces nothing and reads nothing', async () => {
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await disconnectSpark()
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(sdk.getPayment).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })

  test('a reconnect that lands while the read is in flight announces nothing', async () => {
    let answer: (value: { payment: object }) => void = () => undefined
    sdk.getPayment.mockReturnValue(new Promise(resolve => (answer = resolve)))
    const { updates } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(sdk.getPayment).toHaveBeenCalledTimes(1)
    await disconnectSpark()
    await connectSpark('abandon abandon abandon')
    answer({ payment: bareSats() })
    await jest.advanceTimersByTimeAsync(0)
    expect(updates).toEqual([])
  })

  test('ending the subscription drops the wait', async () => {
    const { updates, off } = await subscribe()
    await listener.onEvent(succeeded(bareSats()))
    off()
    await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    expect(sdk.getPayment).not.toHaveBeenCalled()
    expect(updates).toEqual([])
  })
})

describe('on the screen, through the real boundary', () => {
  const overlay = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
    tree.root
      .findAllByType(Text)
      .map(text => [text.props.children].flat().join(''))
      .filter(text => text.startsWith('overlay'))

  async function mountHost(): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<ReceivedOverlayHost />)
      await jest.advanceTimersByTimeAsync(0)
    })
    return tree
  }

  const settle = (payment: object) =>
    ReactTestRenderer.act(async () => {
      await listener.onEvent(succeeded(payment))
      await jest.advanceTimersByTimeAsync(CONVERSION_INFO_WAIT_MS)
    })

  test('a conversion whose leg settles bare leaves no received overlay', async () => {
    sdk.getPayment.mockResolvedValue({ payment: bareSats({ conversionInfo: amm('SelfTransfer') }) })
    const tree = await mountHost()
    await settle(bareSats())
    expect(overlay(tree)).toEqual([])
  })

  test('a bare transfer from someone shows its overlay once the wait ends', async () => {
    const tree = await mountHost()
    await settle(bareSats())
    expect(overlay(tree)).toEqual(['overlay 31473 sats'])
  })
})
