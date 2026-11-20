import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { reconnectIfDomainMoved } from '../src/wallet/deletion'
import { domainFor } from '../src/wallet/lnurlDomainPref'
import { type NameState } from '../src/wallet/nameState'
import {
  SparkReconnectBusy,
  connectSpark,
  disconnectSpark,
  sparkClaimDeposit,
  sparkConfirmConvertLeg,
  sparkConfirmLnurlPay,
  sparkConfirmLnurlWithdraw,
  sparkConfirmSend,
  sparkInspectDestination,
  sparkParseLnurlPay,
  sparkParseLnurlWithdraw,
  sparkPrepareConvert,
  sparkPrepareConvertBySpend,
  sparkPrepareCrossChainSend,
  sparkPrepareLnurlPay,
  sparkPrepareSend,
  sparkRefreshTakenBackAddress,
  sparkRefundDeposit,
  sparkSetStableBalance,
} from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'

// A reconnect nobody asked for, the refresh after a refund and the domain move after a deletion, never
// drops the instance a send or a prepare runs on: a send that already left would read as failed. It
// is skipped while one is in flight and done by the next call once none is.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
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
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  ...jest.requireActual('../src/wallet/lnurlDomainPref'),
  domainFor: jest.fn(async () => undefined),
}))

const HOST = 'usevoltz.app'
const PUB = `02${'b'.repeat(64)}`
const MNEMONIC = `${'abandon '.repeat(11)}about`

type Sdk = Record<
  | 'getInfo'
  | 'getLightningAddress'
  | 'signMessage'
  | 'disconnect'
  | 'prepareSendPayment'
  | 'sendPayment'
  | 'parse'
  | 'prepareLnurlPay'
  | 'lnurlPay'
  | 'lnurlWithdraw'
  | 'claimDeposit'
  | 'refundDeposit'
  | 'getCrossChainRoutes'
  | 'updateUserSettings'
  | 'receivePayment',
  jest.Mock
>
const sdk = (jest.requireMock('@breeztech/breez-sdk-spark-react-native') as { __sdkInstance: Sdk })
  .__sdkInstance
sdk.signMessage = jest.fn()

const info = (username: string) => ({
  username,
  lightningAddress: `${username}@${HOST}`,
  lnurl: { url: `https://${HOST}/lnurlp/${username}`, bech32: `lnurl1${username}` },
  description: '',
})

const takenBack = (name: string): NameState => ({
  host: HOST,
  name,
  live: null,
  takenBack: { closedBy: 'refund', closedAt: 1_800_000_000 },
  given: 'swiftotter42',
  givenHeldBy: 'you',
  askedHeldBy: 'you',
  serverNow: 1_800_000_000,
})

const fetchMock = jest.fn()
;(globalThis as { fetch: unknown }).fetch = fetchMock

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => {
    resolve = r
  })
  return { promise, resolve }
}

const until = async (reached: () => boolean) => {
  for (let i = 0; i < 50 && !reached(); i++) {
    await new Promise(resolve => setImmediate(resolve))
  }
  expect(reached()).toBe(true)
}

const reconnects = () => jest.mocked(connect).mock.calls.length

beforeEach(async () => {
  // A fresh session per case, so the domain one case connected on is not the next one's.
  await disconnectSpark()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(domainFor).mockResolvedValue(undefined)
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUB, balanceSats: 0n, tokenBalances: new Map() })
  sdk.signMessage.mockResolvedValue({ signature: '3044sig', pubkey: PUB })
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  await connectSpark(MNEMONIC)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// Each case holds one SDK call of a money path, and answers what releasing it settles.
type Held = { start: () => Promise<unknown>; release: () => void }

function holding(method: keyof Sdk, settled: unknown): () => Held {
  return () => {
    const gate = deferred<unknown>()
    sdk[method].mockImplementationOnce(() => gate.promise)
    return { start: () => Promise.resolve(), release: () => gate.resolve(settled) }
  }
}

const sends: [string, () => Promise<Held>][] = [
  [
    'a send being confirmed',
    async () => {
      const quote = await sparkPrepareSend('lnbc1')
      const held = holding('sendPayment', { payment: { status: 0 } })()
      return { start: () => sparkConfirmSend(quote.handle), release: held.release }
    },
  ],
  [
    'a send being prepared',
    async () => {
      const held = holding('prepareSendPayment', {
        amount: 1000n,
        paymentMethod: { tag: 'Bolt11Invoice', inner: {} },
      })()
      return { start: () => sparkPrepareSend('lnbc1'), release: held.release }
    },
  ],
  [
    'a lightning address pay being confirmed',
    async () => {
      sdk.parse.mockResolvedValueOnce({
        tag: 'LightningAddress',
        inner: [{ payRequest: { minSendable: 1000n, maxSendable: 1_000_000n, commentAllowed: 0, domain: HOST } }],
      })
      const pay = await sparkParseLnurlPay(`someone@${HOST}`)
      const quote = await sparkPrepareLnurlPay(pay.handle, 10)
      const held = holding('lnurlPay', { payment: { status: 0 } })()
      return { start: () => sparkConfirmLnurlPay(quote.handle), release: held.release }
    },
  ],
  [
    'a conversion being prepared',
    async () => {
      const held = holding('prepareSendPayment', { amount: 1000n, paymentMethod: { tag: 'SparkAddress', inner: {} } })()
      return { start: () => sparkPrepareConvert('btkn1usdb', undefined, 1000), release: held.release }
    },
  ],
  [
    'a cross-chain send being prepared',
    async () => {
      sdk.parse.mockResolvedValueOnce({ tag: 'CrossChainAddress', inner: [{ address: 'SoLaNaAddr' }] })
      sdk.getCrossChainRoutes.mockResolvedValueOnce([
        {
          provider: 1,
          chain: 'solana',
          asset: 'USDC',
          decimals: 6,
          chainId: undefined,
          acceptedAssets: [{ asset: { tag: 'Bitcoin' }, limits: undefined }],
        },
      ])
      const route = ((await sparkInspectDestination('SoLaNaAddr')).routes ?? [])[0]
      const held = holding('prepareSendPayment', {
        amount: 50_000n,
        paymentMethod: { tag: 'CrossChainAddress', inner: {} },
      })()
      return { start: () => sparkPrepareCrossChainSend(route.id, 50_000, 'sats'), release: held.release }
    },
  ],
  [
    'a lightning address pay being prepared',
    async () => {
      sdk.parse.mockResolvedValueOnce({
        tag: 'LightningAddress',
        inner: [{ payRequest: { minSendable: 1000n, maxSendable: 1_000_000n, commentAllowed: 0, domain: HOST } }],
      })
      const pay = await sparkParseLnurlPay(`someone@${HOST}`)
      const held = holding('prepareLnurlPay', { amountSats: 10n, feeSats: 0n, invoiceDetails: {} })()
      return { start: () => sparkPrepareLnurlPay(pay.handle, 10), release: held.release }
    },
  ],
  [
    'a voucher being withdrawn',
    async () => {
      sdk.parse.mockResolvedValueOnce({
        tag: 'LnurlWithdraw',
        inner: [{ minWithdrawable: 1000n, maxWithdrawable: 1_000_000n, defaultDescription: '' }],
      })
      const voucher = await sparkParseLnurlWithdraw('lnurl1voucher')
      const held = holding('lnurlWithdraw', { paymentRequest: 'lnbc0', payment: { status: 0 } })()
      return { start: () => sparkConfirmLnurlWithdraw(voucher.handle, 10), release: held.release }
    },
  ],
  [
    'a deposit being claimed',
    async () => {
      const held = holding('claimDeposit', { outcome: { tag: 'Settled', inner: { payment: { status: 0 } } } })()
      return { start: () => sparkClaimDeposit('deposittx', 0, 500), release: held.release }
    },
  ],
  [
    'a deposit being refunded',
    async () => {
      const held = holding('refundDeposit', { txId: 'refundtx', txHex: '00' })()
      return { start: () => sparkRefundDeposit('deposittx', 0, 'bc1qrefund', 2), release: held.release }
    },
  ],
  [
    'a conversion being prepared by what it spends',
    async () => {
      const held = holding('prepareSendPayment', {
        amount: 1000n,
        paymentMethod: { tag: 'SparkAddress', inner: {} },
        conversionEstimate: { amountIn: 1000n, amountOut: 1000n, fee: 0n },
      })()
      return { start: () => sparkPrepareConvertBySpend(undefined, 'btkn1usdb', 1000, 1000), release: held.release }
    },
  ],
  [
    'a conversion leg being confirmed',
    async () => {
      const quote = await sparkPrepareConvert('btkn1usdb', undefined, 1000)
      const held = holding('sendPayment', { payment: { status: 0, amount: 1000n } })()
      return { start: () => sparkConfirmConvertLeg(quote.handle), release: held.release }
    },
  ],
  [
    'the stable balance being switched',
    async () => {
      const held = holding('updateUserSettings', undefined)()
      return { start: () => sparkSetStableBalance(true), release: held.release }
    },
  ],
]

describe('the refresh after a refund', () => {
  let n = 0

  test.each(sends)('drops nothing under %s and says so, and the next sweep reconnects', async (_what, setUp) => {
    const name = `refunded${++n}`
    sdk.getLightningAddress.mockResolvedValue(info(name))
    fetchMock.mockImplementation(async () => ({ status: 200, json: async () => takenBack(name) }))
    const held = await setUp()
    const before = reconnects()
    const running = held.start()

    await expect(sparkRefreshTakenBackAddress('primary', [{ id: 'a1'.repeat(32), domain: HOST }])).rejects.toBeInstanceOf(SparkReconnectBusy)
    expect(sdk.disconnect).not.toHaveBeenCalled()
    expect(reconnects()).toBe(before)

    held.release()
    await running
    expect(await sparkRefreshTakenBackAddress('primary', [{ id: 'a1'.repeat(32), domain: HOST }])).toBe(true)
    expect(sdk.disconnect).toHaveBeenCalledTimes(1)
    expect(reconnects()).toBe(before + 1)
  })
})

describe('the domain move after a deletion', () => {
  test.each(sends)('drops nothing under %s and says so, and the next call reconnects', async (_what, setUp) => {
    jest.mocked(domainFor).mockResolvedValue('moved.app')
    const held = await setUp()
    const before = reconnects()
    const running = held.start()

    await expect(reconnectIfDomainMoved('primary')).rejects.toBeInstanceOf(SparkReconnectBusy)
    expect(sdk.disconnect).not.toHaveBeenCalled()
    expect(reconnects()).toBe(before)

    held.release()
    await running
    await reconnectIfDomainMoved('primary')
    expect(sdk.disconnect).toHaveBeenCalledTimes(1)
    expect(reconnects()).toBe(before + 1)
  })

  test('with nothing in flight reconnects at once', async () => {
    jest.mocked(domainFor).mockResolvedValue('moved.app')
    const before = reconnects()
    await reconnectIfDomainMoved('primary')
    await until(() => reconnects() === before + 1)
    expect(sdk.disconnect).toHaveBeenCalledTimes(1)
  })
})
