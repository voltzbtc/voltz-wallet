import {
  connect,
  ConversionType_Tags,
  SparkAsset_Tags,
  CrossChainRouteFilter,
  Fee,
  MaxOnchainFee,
  MaxOnchainFee_Tags,
  MoonpayDelivery,
  MoonpayDelivery_Tags,
  OnchainConfirmationSpeed,
  ReceivePaymentMethod,
  PaymentRequest,
  PaymentType,
  BitcoinNetwork,
  SdkError,
  SendPaymentOptions,
  FeePolicy,
  SdkEvent_Tags,
  StableBalanceActiveLabel,
  StableBalanceConversionKind,
  WebhookEventType,
  type SdkEvent,
} from '@breeztech/breez-sdk-spark-react-native'
import { forgetLnAddress, lastLnAddress, rememberLnAddress } from '../src/wallet/lnAddressMemory'
import { clearDeletionMark } from '../src/wallet/deletionMark'
import RNFS from 'react-native-fs'
import { forgetPendingSends, readPendingSends } from '../src/wallet/pendingSends'
import * as exitHold from '../src/wallet/exitHold'
import { onSendSettled } from '../src/wallet/sendNotice'
import {
  connectSpark,
  connectActiveSpark,
  disconnectSpark,
  sparkConnectedWalletId,
  sparkGetTokenBalances,
  sparkGetWalletInfo,
  sparkGetLnAddress,
  sparkEnsureLnAddress,
  sparkCheckLnAddress,
  sparkRegisterLnAddress,
  sparkDeleteLnAddress,
  sparkReceive,
  sparkClassify,
  sparkInspectDestination,
  sparkPrepareSend,
  sparkDiscardSendQuote,
  sparkPrepareCrossChainSend,
  sparkConfirmSend,
  sparkGetStableBalance,
  sparkSetStableBalance,
  onStableBalanceChanged,
  sparkPrepareConvert,
  sparkPrepareConvertBySpend,
  sparkConfirmConvert,
  sparkConfirmConvertLeg,
  sparkConversionLimits,
  sparkListHistory,
  sparkListReceiveRoutes,
  sparkReceiveStable,
  sparkGetPayment,
  sparkGetFiatRates,
  sparkListFiatCurrencies,
  sparkBuyBitcoinUrl,
  receiveUpdateFromEvent,
  sparkParseLnurlPay,
  sparkPrepareLnurlPay,
  sparkConfirmLnurlPay,
  sparkConfirmSendHeld,
  sparkRetryHeldSend,
  sparkDropHeldSend,
  sparkSendTakesKey,
  KEY_READ_MS,
  sparkParseLnurlWithdraw,
  sparkConfirmLnurlWithdraw,
  sparkListUnclaimedDeposits,
  sparkClaimDeposit,
  sparkRefundAddress,
  sparkRefundDeposit,
  sparkRecommendedFees,
  sparkListContacts,
  sparkAddContact,
  sparkUpdateContact,
  sparkDeleteContact,
  sparkListWebhooks,
  sparkRegisterWebhook,
  sparkUnregisterWebhook,
  sparkWebhookSession,
  sparkConnectedIdentity,
  addressServesDomain,
  usernameOf,
  RECEIVE_CONVERSION_PENDING_MS,
  sparkNoteResumed,
  SEND_WAIT_MS,
  sendOutcomeFromEvent,
  sparkSubscribeToPayments,
  sparkSubscribeToReceives,
  sparkSyncState,
  sparkFollowSend,
  sparkSentRail,
  sparkAddEventListener,
} from '../src/wallet/spark'
import { ensureRegistered, getActiveWalletId } from '../src/wallet/walletRegistry'
import { loadPassphraseFor } from '../src/wallet/seed'
import { fingerprintFromMnemonic, fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { DEPIX, STABLE_BALANCE_LABEL, USDB } from '../src/wallet/tokens'
import { crossChainArrival } from '../src/wallet/history'
import { effectiveConvertCostPct, fromBaseUnits, SPARK_BTC } from '../src/wallet/sparkConvert'

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => undefined,
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(
    async () =>
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  ),
  // An undefined passphrase means the base wallet, which the connect tests below assume.
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
// Answers a wallet, not null. Null is a wallet that does not exist yet, and everything keyed by the
// active wallet is silently inert against it: the address memory stores nothing and reads nothing,
// so the guard it holds could not be seen failing.
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp-spark'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp-spark'),
}))

// __sdkInstance is a test-only export of the manual mock, absent from the real binding's type.
const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<
      | 'getInfo'
      | 'receivePayment'
      | 'parse'
      | 'prepareSendPayment'
      | 'getCrossChainRoutes'
      | 'sendPayment'
      | 'getUserSettings'
      | 'updateUserSettings'
      | 'listPayments'
      | 'getPayment'
      | 'listFiatRates'
      | 'listFiatCurrencies'
      | 'buyBitcoin'
      | 'fetchConversionLimits'
      | 'getLightningAddress'
      | 'checkLightningAddressAvailable'
      | 'registerLightningAddress'
      | 'deleteLightningAddress'
      | 'prepareLnurlPay'
      | 'lnurlPay'
      | 'lnurlWithdraw'
      | 'listUnclaimedDeposits'
      | 'claimDeposit'
      | 'refundDeposit'
      | 'recommendedFees'
      | 'listContacts'
      | 'addContact'
      | 'updateContact'
      | 'deleteContact'
      | 'listWebhooks'
      | 'registerWebhook'
      | 'unregisterWebhook'
      | 'addEventListener'
      | 'removeEventListener'
      | 'disconnect',
      jest.Mock
    >
  }
).__sdkInstance

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// The mock's variant constructors keep their fields, so reading them shows what the boundary passed.
const fieldsOf = (value: unknown): Record<string, unknown> =>
  (value as { fields: Record<string, unknown> }).fields

beforeEach(async () => {
  jest.clearAllMocks()
  // The address memory is a file, so it survives clearAllMocks and follows one case into the next.
  // A case about minting a first address must not inherit one remembered by the case before it.
  await forgetLnAddress('primary')
  // The same for the deletion mark: a case that gives the address up leaves the wallet held, and a
  // case after it about minting would find nothing minted.
  await clearDeletionMark('primary')
  // The record of pending sends is a file too, and a send one case left pending is not the next one's.
  await forgetPendingSends('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.receivePayment.mockResolvedValue({ paymentRequest: 'dest', fee: 0n })
  sdk.parse.mockResolvedValue({ tag: 'Bolt11Invoice' })
  sdk.prepareSendPayment.mockResolvedValue({
    paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 3n, sparkTransferFeeSats: 2n } },
    amount: 1000n,
  })
  sdk.sendPayment.mockResolvedValue({ payment: { status: 0 } })
  // The connection persists, so the first test connects and the rest reuse it.
  await connectSpark(MNEMONIC)
})

describe('sparkGetTokenBalances', () => {
  test('maps getInfo.tokenBalances into display rows (identifier, ticker, decimals, amount)', async () => {
    sdk.getInfo.mockResolvedValue({
      identityPubkey: '',
      balanceSats: 0n,
      tokenBalances: new Map([
        [
          'tkn1',
          {
            balance: 1_500_000n,
            tokenMetadata: {
              identifier: 'tkn1',
              issuerPublicKey: '',
              name: 'Spark USD',
              ticker: 'USDs',
              decimals: 6,
              maxSupply: 0n,
              isFreezable: false,
            },
          },
        ],
      ]),
    })

    const tokens = await sparkGetTokenBalances()

    expect(tokens).toEqual([
      { identifier: 'tkn1', ticker: 'USDs', name: 'Spark USD', decimals: 6, balanceBaseUnits: 1_500_000 },
    ])
  })

  test('is empty when the wallet holds no tokens', async () => {
    sdk.getInfo.mockResolvedValue({ identityPubkey: '', balanceSats: 0n, tokenBalances: new Map() })
    expect(await sparkGetTokenBalances()).toEqual([])
  })
})

describe('sparkGetWalletInfo', () => {
  test('reads BTC balance + held tokens from one getInfo call', async () => {
    sdk.getInfo.mockResolvedValue({
      identityPubkey: '',
      balanceSats: 4200n,
      tokenBalances: new Map([
        [
          'tkn1',
          {
            balance: 1_500_000n,
            tokenMetadata: {
              identifier: 'tkn1',
              issuerPublicKey: '',
              name: 'Spark USD',
              ticker: 'USDs',
              decimals: 6,
              maxSupply: 0n,
              isFreezable: false,
            },
          },
        ],
      ]),
    })

    const info = await sparkGetWalletInfo()

    expect(info.balanceSat).toBe(4200)
    expect(info.tokens).toEqual([
      { identifier: 'tkn1', ticker: 'USDs', name: 'Spark USD', decimals: 6, balanceBaseUnits: 1_500_000 },
    ])
  })
})

describe('sparkPrepareSend', () => {
  // Wallets show invoices as lightning: URIs, and the SDK's prepare refuses the scheme.
  test('hands the SDK an invoice without its lightning: scheme', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      amount: 100n,
      paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 0n } },
    })
    await sparkPrepareSend('lightning:lnbc1prefixed')

    const request = JSON.stringify(sdk.prepareSendPayment.mock.calls[0][0].paymentRequest)
    expect(request).toContain('lnbc1prefixed')
    expect(request).not.toContain('lightning:')
  })

  describe('spending everything', () => {
    test('asks for fees included and says what reaches the recipient', async () => {
      sdk.prepareSendPayment.mockResolvedValue({
        amount: 50_000n,
        paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 100n } },
      })
      const quote = await sparkPrepareSend('lnbc1', 50_000, undefined, true)

      expect(sdk.prepareSendPayment.mock.calls[0][0].feePolicy).toBe(FeePolicy.FeesIncluded)
      expect(quote).toMatchObject({ amount: 50_000, feesIncluded: true, receives: 49_900 })
    })

    test('asks for a dollar balance as a sale of the whole USDB, and answers in sats', async () => {
      sdk.prepareSendPayment.mockResolvedValue({
        paymentMethod: {
          tag: 'Bolt11Invoice',
          inner: { lightningFeeSats: 7n, sparkTransferFeeSats: undefined, invoiceDetails: {} },
        },
        amount: 12_307n,
        conversionEstimate: {
          options: {
            conversionType: {
              tag: ConversionType_Tags.ToBitcoin,
              inner: { fromTokenIdentifier: USDB.identifier },
            },
          },
          amountIn: 12_400_000n,
          amountOut: 12_307n,
          fee: 0n,
        },
      })

      const quote = await sparkPrepareSend('lnbc1amountless', 12_400_000, undefined, true, true)

      const asked = sdk.prepareSendPayment.mock.calls[0][0]
      expect(asked.amount).toBe(12_400_000n)
      expect(asked.tokenIdentifier).toBe(USDB.identifier)
      expect(asked.feePolicy).toBe(FeePolicy.FeesIncluded)
      expect(asked.conversionOptions.conversionType.inner.fromTokenIdentifier).toBe(USDB.identifier)
      // The figures that come back are sats, so nothing may read them as the token that went in.
      expect(quote.tokenIdentifier).toBeUndefined()
      expect(quote.amountBase).toBeUndefined()
      expect(quote.amount).toBe(12_307)
      expect(quote.receives).toBe(12_300)
      expect(quote.conversion?.amountIn).toBe(12_400_000)
    })

    test('leaves the conversion out of every other send', async () => {
      sdk.prepareSendPayment.mockResolvedValue({
        amount: 5000n,
        paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 1n } },
      })

      await sparkPrepareSend('lnbc1amountless', 5000, undefined, true)

      expect(sdk.prepareSendPayment.mock.calls[0][0].conversionOptions).toBeUndefined()
      expect(sdk.prepareSendPayment.mock.calls[0][0].tokenIdentifier).toBeUndefined()
    })

    test('a Spark send loses nothing to fees', async () => {
      sdk.prepareSendPayment.mockResolvedValue({
        amount: 50_000n,
        paymentMethod: { tag: 'SparkAddress', inner: { fee: 0n } },
      })
      expect(await sparkPrepareSend('sp1', 50_000, undefined, true)).toMatchObject({ receives: 50_000 })
    })

    test('on-chain leaves the figure to the speed', async () => {
      const speed = { l1BroadcastFeeSat: 1n, userFeeSat: 1n }
      sdk.prepareSendPayment.mockResolvedValue({
        amount: 50_000n,
        paymentMethod: {
          tag: 'BitcoinAddress',
          inner: { feeQuote: { speedFast: speed, speedMedium: speed, speedSlow: speed, isEstimate: false } },
        },
      })
      const quote = await sparkPrepareSend('bc1q', 50_000, undefined, true)
      expect(quote.feesIncluded).toBe(true)
      expect(quote.receives).toBeUndefined()
    })

    test('off by default, so a charge never takes its fee out of the invoice', async () => {
      sdk.prepareSendPayment.mockResolvedValue({
        amount: 50_000n,
        paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 100n } },
      })
      const quote = await sparkPrepareSend('lnbc1', 50_000)

      expect(sdk.prepareSendPayment.mock.calls[0][0].feePolicy).toBeUndefined()
      expect(quote.feesIncluded).toBeUndefined()
    })
  })

  test('surfaces the payee memo from the bolt11 invoiceDetails.description', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: {
        tag: 'Bolt11Invoice',
        inner: {
          lightningFeeSats: 3n,
          sparkTransferFeeSats: 2n,
          invoiceDetails: { description: 'Coffee at Satoshi Cafe' },
        },
      },
      amount: 1000n,
    })

    const quote = await sparkPrepareSend('lnbc1invoice')

    expect(quote.description).toBe('Coffee at Satoshi Cafe')
    expect(quote.fee).toBe(3)
  })

  test('a bare bitcoin address has no memo (no invoiceDetails)', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'BitcoinAddress', inner: { fee: 250n } },
      amount: 5000n,
    })

    const quote = await sparkPrepareSend('bc1qaddr', 5000)

    expect(quote.description).toBeUndefined()
    expect(quote.fee).toBe(250)
  })

  // 1.000000000000000001 of an 18-place token, which a double would hand on as 1.
  test('a typed token amount reaches the SDK exactly, past what a double holds', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: { fee: 0n, tokenIdentifier: 'btkn1eighteen' } },
      amount: 1_000_000_000_000_000_001n,
    })

    const quote = await sparkPrepareSend('sp1payee', 1_000_000_000_000_000_001n, 'btkn1eighteen')

    expect(sdk.prepareSendPayment.mock.calls[0][0].amount).toBe(1_000_000_000_000_000_001n)
    // The review draws this one, since `amount` went through a double.
    expect(quote.amountBase).toBe(1_000_000_000_000_000_001n)
  })

  // A token send is denominated in the token's base units end to end, fee included, never in sats.
  test('a token send forwards the token to the SDK and reports it on the quote', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: { fee: 1000n, tokenIdentifier: USDB.identifier } },
      amount: 10_000_000n,
    })

    const quote = await sparkPrepareSend('sp1payee', 10_000_000, USDB.identifier)

    expect(sdk.prepareSendPayment.mock.calls[0][0].tokenIdentifier).toBe(USDB.identifier)
    expect(sdk.prepareSendPayment.mock.calls[0][0].amount).toBe(10_000_000n)
    expect(quote.amount).toBe(10_000_000)
    expect(quote.fee).toBe(1000)
    expect(quote.tokenIdentifier).toBe(USDB.identifier)
  })

  test('a bitcoin send passes no token and reports none (the sats path is unchanged)', async () => {
    const quote = await sparkPrepareSend('lnbc1invoice', 1000)

    expect(sdk.prepareSendPayment.mock.calls[0][0].tokenIdentifier).toBeUndefined()
    expect(quote.tokenIdentifier).toBeUndefined()
    expect(quote.amountBase).toBeUndefined()
  })

  test('the token comes from the prepared method, so an invoice imposes its own asset', async () => {
    // A spark invoice bills in the token it chose, and the SDK rejects paying it in another one.
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkInvoice', inner: { fee: 0n, tokenIdentifier: 'btkn1invoiceToken' } },
      amount: 5_000_000n,
    })

    const quote = await sparkPrepareSend('spark1invoice')

    expect(quote.tokenIdentifier).toBe('btkn1invoiceToken')
  })
})

describe('lightning address (§11 fatia 9)', () => {
  test('sparkGetLnAddress returns null when none is registered', async () => {
    sdk.getLightningAddress.mockResolvedValue(undefined)
    expect(await sparkGetLnAddress()).toBeNull()
  })

  test('sparkGetLnAddress maps a registered address to username / user@domain / lnurl bech32', async () => {
    sdk.getLightningAddress.mockResolvedValue({
      username: 'alice',
      lightningAddress: 'alice@breez.tips',
      lnurl: { url: 'https://breez.tips/lnurlp', bech32: 'lnurl1abc' },
      description: 'Pay alice',
    })
    expect(await sparkGetLnAddress()).toEqual({
      username: 'alice',
      address: 'alice@breez.tips',
      lnurl: 'lnurl1abc',
    })
  })

  test('sparkCheckLnAddress asks the SDK whether the username is free', async () => {
    sdk.checkLightningAddressAvailable.mockResolvedValue(false)
    expect(await sparkCheckLnAddress('taken')).toBe(false)
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledWith({ username: 'taken' })
  })

  test('sparkRegisterLnAddress registers the username and maps the result', async () => {
    sdk.registerLightningAddress.mockResolvedValue({
      username: 'bob',
      lightningAddress: 'bob@breez.tips',
      lnurl: { url: 'https://breez.tips/lnurlp', bech32: 'lnurl1bob' },
      description: '',
    })
    const addr = await sparkRegisterLnAddress('bob')
    expect(addr).toEqual({ username: 'bob', address: 'bob@breez.tips', lnurl: 'lnurl1bob' })
    expect(sdk.registerLightningAddress).toHaveBeenCalledWith({
      username: 'bob',
      description: 'Pay to bob@breez.tips',
    })
  })

  test('a note that cannot be written does not fail the registration it is about', async () => {
    // The note about a registration is written after the name is taken, and a throw from it would
    // reach the screen as "could not create the address" while the address has already changed.
    // Being told something failed while it worked is worse than not recording it, since the record
    // only exists to avoid minting over a name that is already there.
    const fs = (require('react-native-fs') as { default: { writeFile: jest.Mock } }).default
    const write = jest.spyOn(fs, 'writeFile').mockRejectedValue(new Error('disk full'))
    sdk.registerLightningAddress.mockResolvedValue({
      username: 'shop',
      lightningAddress: 'shop@example.com',
      lnurl: { url: 'https://example.com/lnurlp', bech32: 'lnurl1l' },
      description: '',
    })

    await expect(sparkRegisterLnAddress('shop')).resolves.toMatchObject({
      address: 'shop@example.com',
    })

    write.mockRestore()
  })

  test('remembers the name the customer chose, not the one it replaced', async () => {
    // The path a customer takes to choose a name does not go through ensure, so the register call
    // itself updates the memory. Left holding the generated name, an empty read months later would
    // claim back a name they have already replaced.
    await rememberLnAddress('ambergecko19@example.com')
    sdk.registerLightningAddress.mockResolvedValue({
      username: 'carol',
      lightningAddress: 'carol@example.com',
      lnurl: { url: 'https://example.com/lnurlp', bech32: 'lnurl1m' },
      description: '',
    })

    await sparkRegisterLnAddress('carol')

    expect(await lastLnAddress()).toBe('carol@example.com')
  })

  test('forgets the name when the wallet gives its address up', async () => {
    // Otherwise the next screen open claims it back, undoing what the customer asked for.
    await rememberLnAddress('carol@example.com')
    sdk.deleteLightningAddress.mockResolvedValue(undefined)

    await sparkDeleteLnAddress()

    expect(await lastLnAddress()).toBeNull()
  })

  test('does not mint a new address over one the wallet already had', async () => {
    // A domain taken off the edge makes getLightningAddress answer nothing, and a wallet holds
    // exactly one address, so minting then releases the name the customer chose and there is no way
    // back. Opening the receive screen while the domain is frozen must not silently turn a chosen
    // name into a generated one like `ambergecko19`.
    await rememberLnAddress('carol@example.com')
    sdk.getLightningAddress.mockResolvedValue(undefined)
    sdk.checkLightningAddressAvailable.mockResolvedValue(false)

    expect(await sparkEnsureLnAddress()).toBeNull()

    // Null is the honest answer while it cannot be read. What must not happen is a registration.
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('claims the name back, not a new one, once the domain answers again', async () => {
    await rememberLnAddress('carol@example.com')
    sdk.getLightningAddress.mockResolvedValue(undefined)
    sdk.checkLightningAddressAvailable.mockResolvedValue(true)
    sdk.registerLightningAddress.mockResolvedValue({
      username: 'carol',
      lightningAddress: 'carol@example.com',
      lnurl: { url: 'https://example.com/lnurlp', bech32: 'lnurl1m' },
      description: '',
    })

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: 'carol@example.com' })
    expect(sdk.registerLightningAddress).toHaveBeenCalledWith({
      username: 'carol',
      description: 'Pay to carol@breez.tips',
    })
  })

  test('still mints for a wallet that never had one, which is what the loop is for', async () => {
    await forgetLnAddress('primary')
    sdk.getLightningAddress.mockResolvedValue(undefined)
    sdk.checkLightningAddressAvailable.mockResolvedValue(true)
    sdk.registerLightningAddress.mockResolvedValue({
      username: 'freshotter11',
      lightningAddress: 'freshotter11@usevoltz.app',
      lnurl: { url: 'https://usevoltz.app/lnurlp', bech32: 'lnurl1f' },
      description: '',
    })

    expect(await sparkEnsureLnAddress()).toMatchObject({ address: 'freshotter11@usevoltz.app' })
  })

  test('sparkEnsureLnAddress returns the existing address without registering a new one', async () => {
    sdk.getLightningAddress.mockResolvedValue({
      username: 'alice',
      lightningAddress: 'alice@breez.tips',
      lnurl: { url: 'https://breez.tips/lnurlp', bech32: 'lnurl1abc' },
      description: '',
    })
    const addr = await sparkEnsureLnAddress()
    expect(addr).toEqual({ username: 'alice', address: 'alice@breez.tips', lnurl: 'lnurl1abc' })
    expect(sdk.registerLightningAddress).not.toHaveBeenCalled()
  })

  test('sparkEnsureLnAddress registers a generic random username when none exists yet', async () => {
    // The SDK assigns no address on connect, so ensure claims a random valid LUD-16 username itself.
    sdk.getLightningAddress.mockResolvedValue(undefined)
    sdk.checkLightningAddressAvailable.mockResolvedValue(true)
    sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => ({
      username,
      lightningAddress: `${username}@breez.tips`,
      lnurl: { url: 'https://breez.tips/lnurlp', bech32: 'lnurl1gen' },
      description: '',
    }))
    const addr = await sparkEnsureLnAddress()
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    const username = sdk.registerLightningAddress.mock.calls[0][0].username
    expect(username).toMatch(/^[a-z]+\d{2}$/)
    expect(addr).toEqual({ username, address: `${username}@breez.tips`, lnurl: 'lnurl1gen' })
  })

  test('sparkEnsureLnAddress tries another username when the first is taken', async () => {
    sdk.getLightningAddress.mockResolvedValue(undefined)
    sdk.checkLightningAddressAvailable.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    sdk.registerLightningAddress.mockImplementation(async ({ username }: { username: string }) => ({
      username,
      lightningAddress: `${username}@breez.tips`,
      lnurl: { url: 'https://breez.tips/lnurlp', bech32: 'lnurl1gen' },
      description: '',
    }))
    const addr = await sparkEnsureLnAddress()
    expect(sdk.checkLightningAddressAvailable).toHaveBeenCalledTimes(2)
    expect(sdk.registerLightningAddress).toHaveBeenCalledTimes(1)
    expect(addr?.username).toMatch(/^[a-z]+\d{2}$/)
  })

  test('sparkDeleteLnAddress releases the registered address', async () => {
    await sparkDeleteLnAddress()
    expect(sdk.deleteLightningAddress).toHaveBeenCalled()
  })
})

// These pin what the boundary hands the SDK, not conversion semantics, which need a wallet holding tokens.
describe('sparkPrepareConvert', () => {
  test('BTC -> token: self-transfer, FromBitcoin, amount = desired token output (receive-driven)', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 1_000_000n,
      conversionEstimate: { amountIn: 210_000n, amountOut: 1_000_000n, fee: 500n },
    })

    const quote = await sparkPrepareConvert(undefined, 'usdt', 1_000_000)

    // The destination is the wallet's own Spark address, so the swapped funds stay in the wallet.
    expect(sdk.receivePayment).toHaveBeenCalled()
    const req = sdk.prepareSendPayment.mock.calls[0][0]
    expect(req.tokenIdentifier).toBe('usdt') // destination asset is the token
    expect(req.amount).toBe(1_000_000n)
    expect(req.conversionOptions.conversionType.tag).toBe('FromBitcoin')
    expect(quote).toMatchObject({ spentBaseUnits: 210_000, receivedBaseUnits: 1_000_000, feeBaseUnits: 500 })
  })

  test('a typed token output reaches the SDK exactly, past what a double holds', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 1_000_000_000_000_000_001n,
      conversionEstimate: { amountIn: 210_000n, amountOut: 1_000_000_000_000_000_001n, fee: 0n },
    })

    const quote = await sparkPrepareConvert(undefined, 'btkn1eighteen', 1_000_000_000_000_000_001n)

    expect(sdk.prepareSendPayment.mock.calls[0][0].amount).toBe(1_000_000_000_000_000_001n)
    // The screen draws these, since the Number figures went through a double.
    expect(quote).toMatchObject({ spentExact: 210_000n, receivedExact: 1_000_000_000_000_000_001n })
  })

  test('token -> BTC: ToBitcoin carries the source token, destination has no tokenIdentifier', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 50_000n,
      conversionEstimate: { amountIn: 250_000n, amountOut: 50_000n, fee: 200n },
    })

    const quote = await sparkPrepareConvert('usdt', undefined, 50_000)

    const req = sdk.prepareSendPayment.mock.calls[0][0]
    expect(req.tokenIdentifier).toBeUndefined()
    expect(req.amount).toBe(50_000n)
    expect(req.conversionOptions.conversionType.tag).toBe('ToBitcoin')
    expect(req.conversionOptions.conversionType.inner.fromTokenIdentifier).toBe('usdt')
    expect(quote).toMatchObject({ spentBaseUnits: 250_000, receivedBaseUnits: 50_000 })
  })

  test('confirm executes the prepared conversion through the handle', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 50_000n,
      conversionEstimate: { amountIn: 250_000n, amountOut: 50_000n, fee: 200n },
    })
    sdk.sendPayment.mockResolvedValue({ payment: { status: 0 } })
    const quote = await sparkPrepareConvert('usdt', undefined, 50_000)

    expect(await sparkConfirmConvert(quote.handle)).toBe('complete')
    expect(sdk.sendPayment).toHaveBeenCalled()
  })

  // A conversion to the wallet's own address returns once the converted side has landed, and its
  // amount is what arrived, which is what a second leg can spend.
  test('confirming a leg reports what arrived, not what was quoted', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 50_000n,
      conversionEstimate: { amountIn: 250_000n, amountOut: 50_000n, fee: 200n },
    })
    sdk.sendPayment.mockResolvedValue({ payment: { status: 0, amount: 50_320n } })
    const quote = await sparkPrepareConvert('usdt', undefined, 50_000)

    expect(await sparkConfirmConvertLeg(quote.handle)).toEqual({ status: 'complete', receivedBaseUnits: 50_320 })
  })
})

describe('sparkPrepareConvertBySpend', () => {
  // Linear AMM where each output unit costs `rate`, so the search must find the output that costs the spend.
  function armLinearAmm(rate = 0.21): void {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockImplementation(async (req: { amount: bigint }) => {
      const out = Number(req.amount)
      return {
        paymentMethod: { tag: 'Spark', inner: {} },
        amount: req.amount,
        conversionEstimate: { amountIn: BigInt(Math.round(out * rate)), amountOut: BigInt(out), fee: 0n },
      }
    })
  }

  test('honors the requested spend exactly, correcting a wrong initial estimate', async () => {
    armLinearAmm(0.21)
    // The 900_000 seed is a deliberately wrong output estimate for a 210_000 sat spend.
    const quote = await sparkPrepareConvertBySpend(undefined, 'usdt', 210_000, 900_000)
    expect(quote.spentBaseUnits).toBe(210_000)
    expect(quote.receivedBaseUnits).toBe(1_000_000)
  })

  test('never overspends: the chosen quote stays at or below the target', async () => {
    armLinearAmm(0.21)
    const quote = await sparkPrepareConvertBySpend(undefined, 'usdt', 100_000, 100_000)
    expect(quote.spentBaseUnits).toBeLessThanOrEqual(100_000)
  })

  test('does not overspend when the closest whole output overshoots the target (Flashnet stall)', async () => {
    // With each output unit costing 809 source base units, no integer output spends exactly 645_259.
    // The proportional step rounds the over-budget output back to itself and stalls, overspending.
    armLinearAmm(809)
    const quote = await sparkPrepareConvertBySpend(undefined, 'usdt', 645_259, 800)
    expect(quote.spentBaseUnits).toBeLessThanOrEqual(645_259)
    expect(quote.spentBaseUnits).toBe(644_773)
    expect(quote.receivedBaseUnits).toBe(797)
  })

  // Sats are whole, so an exact output could only reach the spend to within one sat of token. With the
  // token id and an amount in its base units the SDK quotes the sats for that exact input, the shape
  // Breez's own mainnet tests use, and converts exactly that input at confirm.
  test('a token spent into sats is quoted by its exact input, in one prepare', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 797n,
      conversionEstimate: { amountIn: 645_259n, amountOut: 797n, fee: 486n },
    })

    const quote = await sparkPrepareConvertBySpend('usdb', undefined, 645_259, 800)

    expect(sdk.prepareSendPayment).toHaveBeenCalledTimes(1)
    const req = sdk.prepareSendPayment.mock.calls[0][0]
    expect(req.paymentRequest.fields.input).toBe('sp1self')
    expect(req.amount).toBe(645_259n)
    expect(req.tokenIdentifier).toBe('usdb')
    expect(req.conversionOptions.conversionType.tag).toBe('ToBitcoin')
    expect(req.conversionOptions.conversionType.inner.fromTokenIdentifier).toBe('usdb')
    expect(quote).toMatchObject({ spentBaseUnits: 645_259, receivedBaseUnits: 797, feeBaseUnits: 486 })
  })

  test('a typed token spent into sats goes in exactly, past what a double holds', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 797n,
      conversionEstimate: { amountIn: 1_000_000_000_000_000_001n, amountOut: 797n, fee: 0n },
    })

    const exact = 1_000_000_000_000_000_001n
    const quote = await sparkPrepareConvertBySpend('btkn1eighteen', undefined, exact, 800)

    expect(sdk.prepareSendPayment.mock.calls[0][0].amount).toBe(1_000_000_000_000_000_001n)
    expect(quote).toMatchObject({ spentExact: 1_000_000_000_000_000_001n, receivedExact: 797n })
  })

  // 100 USDB at 100 000 USD a bitcoin, a pool that costs 0.4%, and the 1% this app allows: the SDK
  // answers its floor, 99 600 cut by 1%, as amountOut.
  test('a token spent into sats keeps what the pool gives apart from the floor the SDK signs', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 98_604n,
      conversionEstimate: { amountIn: 100_000_000n, amountOut: 98_604n, fee: 486n },
    })

    const quote = await sparkPrepareConvertBySpend(USDB.identifier, undefined, 100_000_000, 0)

    expect(sdk.prepareSendPayment.mock.calls[0][0].conversionOptions.maxSlippageBps).toBe(100)
    expect(quote).toMatchObject({ receivedBaseUnits: 98_604, expectedBaseUnits: 99_600 })
    const cost = effectiveConvertCostPct({ ...USDB, id: USDB.identifier }, SPARK_BTC, quote.spentBaseUnits, quote.expectedBaseUnits ?? 0, {
      USD: 100_000,
    })
    expect(cost).toBeCloseTo(0.4, 6)
  })

  test('an exact output has no floor to set apart, since its amountOut is the pool answer', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 1_000_000n,
      conversionEstimate: { amountIn: 210_000n, amountOut: 1_000_000n, fee: 500n },
    })

    expect((await sparkPrepareConvert(undefined, 'usdt', 1_000_000)).expectedBaseUnits).toBeUndefined()
  })

  test('an exact input quote confirms through its handle', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'SparkAddress', inner: {} },
      amount: 797n,
      conversionEstimate: { amountIn: 645_259n, amountOut: 797n, fee: 486n },
    })
    sdk.sendPayment.mockResolvedValue({ payment: { status: 0, amount: 799n } })
    const quote = await sparkPrepareConvertBySpend('usdb', undefined, 645_259, 800)

    expect(await sparkConfirmConvertLeg(quote.handle)).toEqual({ status: 'complete', receivedBaseUnits: 799 })
    expect(sdk.sendPayment.mock.calls[0][0].prepareResponse.conversionEstimate.amountIn).toBe(645_259n)
  })

  // Without an estimate the SDK is not converting, and a send of the token to the wallet's own
  // address is not what Convert asked for.
  test('an exact input prepare without an estimate is refused', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'sp1self', fee: 0n })
    sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { tag: 'SparkAddress', inner: {} }, amount: 645_259n })

    await expect(sparkPrepareConvertBySpend('usdb', undefined, 645_259, 800)).rejects.toThrow('conversion estimate missing')
  })

  test('drops the superseded prepared handles, keeping only the chosen one', async () => {
    armLinearAmm(0.21)
    const quote = await sparkPrepareConvertBySpend(undefined, 'usdt', 210_000, 500_000)
    sdk.sendPayment.mockResolvedValue({ payment: { status: 0 } })
    expect(await sparkConfirmConvert(quote.handle)).toBe('complete')
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })
})

describe('sparkConversionLimits', () => {
  test('maps fetchConversionLimits to the pair min from/to base units', async () => {
    sdk.fetchConversionLimits.mockResolvedValue({ minFromAmount: 1000n, minToAmount: 500n })
    expect(await sparkConversionLimits(undefined, 'usdt')).toEqual({
      minFromBaseUnits: 1000,
      minToBaseUnits: 500,
    })
  })

  test('leaves an undefined bound undefined', async () => {
    sdk.fetchConversionLimits.mockResolvedValue({ minFromAmount: undefined, minToAmount: undefined })
    expect(await sparkConversionLimits('usdt', undefined)).toEqual({
      minFromBaseUnits: undefined,
      minToBaseUnits: undefined,
    })
  })
})

describe('connectActiveSpark', () => {
  test('registers the active wallet so it shows in the wallet list (§11)', async () => {
    await connectActiveSpark()
    // Onboarding stores the seed without registering, so this is the only place the first wallet
    // enters the registry. Without it the list is empty and switching back to it is impossible.
    expect(ensureRegistered).toHaveBeenCalledWith('primary', 'fp-spark')
  })

  test('a refresh while already connected skips the re-register (fast path, no PBKDF2)', async () => {
    // Called on every focus and payment event, so it must not re-read the seed or re-run PBKDF2.
    await connectActiveSpark()
    jest.mocked(ensureRegistered).mockClear()
    await connectActiveSpark()
    expect(ensureRegistered).not.toHaveBeenCalled()
  })

  test('registers a passphrase wallet under its passphrase-derived id, not the bare mnemonic id', async () => {
    // The registered fingerprint has to come from mnemonic plus passphrase, else a wallet created
    // with one shows the passphrase-less base id in the list.
    jest.mocked(loadPassphraseFor).mockResolvedValue('hunter2')
    jest.mocked(fingerprintFromMnemonic).mockClear()
    jest.mocked(fingerprintFromMnemonicAsync).mockClear()
    await disconnectSpark() // clears connectedWalletId so the re-register path runs

    await connectActiveSpark()

    // Off the JS thread, since this runs on Home's focus right after the PIN.
    expect(fingerprintFromMnemonicAsync).toHaveBeenCalledWith(expect.any(String), 'hunter2')
    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
    jest.mocked(loadPassphraseFor).mockResolvedValue(undefined) // restore the default for later blocks
  })
})

// Read from a throwaway wallet id because the shared connection is already open by the time these run.
describe('connect config', () => {
  const configOfLastConnect = () => {
    const calls = jest.mocked(connect).mock.calls
    return calls[calls.length - 1][0].config
  }

  test('declares the USDB stable-balance token but leaves the feature switched off', async () => {
    await connectSpark(MNEMONIC, 'config-probe')

    const stable = configOfLastConnect().stableBalanceConfig
    // A label other than the one sparkSetStableBalance activates would register the token for nothing.
    expect(stable?.tokens).toEqual([
      { label: STABLE_BALANCE_LABEL, tokenIdentifier: USDB.identifier },
    ])
    // An active label at connect converts the wallet's sats into the token on first receive,
    // unasked.
    expect(stable?.defaultActiveLabel).toBeUndefined()
    // The SDK's 10 bps default rejects conversions on the thin USDB pool, breaking the auto-swap.
    expect(stable?.maxSlippageBps).toBe(100)

    await connectSpark(MNEMONIC, 'primary') // restore the shared state the rest of the file assumes
  })

  // The ceiling Breez recommends (guide/onchain_claims.html): the fastest recommended network fee rate
  // plus 1 sat/vbyte, plus 0.1% of the deposit. It differs from the SDK default, a 1 sat/vbyte rate,
  // and a flat figure would not follow the mempool.
  test('claims deposits under the fastest recommended fee plus 1 sat/vbyte and 0.1%', async () => {
    await connectSpark(MNEMONIC, 'config-probe')

    const ceiling = configOfLastConnect().maxDepositClaimFee
    expect(ceiling?.onchain).toBeInstanceOf(MaxOnchainFee.NetworkRecommended)
    expect(ceiling?.onchain.tag).toBe(MaxOnchainFee_Tags.NetworkRecommended)
    expect(ceiling?.onchain.inner).toEqual({ leewaySatPerVbyte: 1n })
    expect(ceiling?.proportionalPpm).toBe(1000)

    await connectSpark(MNEMONIC, 'primary')
  })

  test('opts into cross-chain sends and keeps the SDK slippage defaults', async () => {
    await connectSpark(MNEMONIC, 'config-probe')

    // Passing the struct at all is the opt-in, and unset fields keep the SDK's own defaults.
    expect(configOfLastConnect().crossChainConfig).toEqual({
      defaultSlippageBps: undefined,
      defaultTargetOverpayBps: undefined,
    })

    await connectSpark(MNEMONIC, 'primary')
  })
})

// The connection is cached by wallet id, not by the seed, so the plaintext mnemonic is not retained
// in module scope. Call counts are read as deltas so the assertions hold wherever this block runs.
describe('connection reuse', () => {
  test('reuses the open connection for the same wallet', async () => {
    const before = jest.mocked(connect).mock.calls.length
    await connectSpark(MNEMONIC, 'primary')
    expect(jest.mocked(connect).mock.calls.length).toBe(before)
  })

  test('tears the connection down and reconnects when the wallet changes', async () => {
    const before = jest.mocked(connect).mock.calls.length
    await connectSpark(MNEMONIC, 'second')
    // Only one engine runs at a time, so the old instance must be closed, not left running alongside.
    expect(sdk.disconnect).toHaveBeenCalled()
    expect(jest.mocked(connect).mock.calls.length).toBe(before + 1)
    await connectSpark(MNEMONIC, 'primary')
  })

  test('names the wallet it is connected as, and none once disconnected', async () => {
    await connectSpark(MNEMONIC, 'second')
    expect(sparkConnectedWalletId()).toBe('second')
    await disconnectSpark()
    expect(sparkConnectedWalletId()).toBeNull()
    await connectSpark(MNEMONIC, 'primary')
    expect(sparkConnectedWalletId()).toBe('primary')
  })
})

// New at 0.27.2. Each of these carries no payment, so a listener that reached for one would throw
// inside the binding's callback.
describe('an event with no payment', () => {
  const events: [string, SdkEvent][] = [
    [
      'StableBalanceConversionFailed',
      {
        tag: SdkEvent_Tags.StableBalanceConversionFailed,
        inner: { conversion: StableBalanceConversionKind.AutoConvert, error: 'pool refused', retryInSecs: 60n },
      } as unknown as SdkEvent,
    ],
    [
      'RecoverableFunds',
      { tag: SdkEvent_Tags.RecoverableFunds, inner: { recoverableFundsSats: 5_000n } } as unknown as SdkEvent,
    ],
  ]
  const lastListener = () =>
    sdk.addEventListener.mock.calls.at(-1)?.[0] as { onEvent: (event: SdkEvent) => Promise<void> }

  test.each(events)('%s moves no send and announces no receive', (_name, event) => {
    expect(sendOutcomeFromEvent(event, 'p1')).toBeNull()
    expect(receiveUpdateFromEvent(event)).toBeNull()
  })

  test.each(events)('%s is not a sync, and the Synced after it still is', async (_name, event) => {
    sdk.addEventListener.mockClear()
    await connectSpark(MNEMONIC, 'event-probe')
    const watcher = sdk.addEventListener.mock.calls[0][0] as { onEvent: (e: unknown) => Promise<void> }

    await expect(watcher.onEvent(event)).resolves.toBeUndefined()
    expect(sparkSyncState()).toBe('waiting')

    await watcher.onEvent({ tag: SdkEvent_Tags.Synced })
    expect(sparkSyncState()).toBe('synced')

    await connectSpark(MNEMONIC, 'primary')
  })

  test.each(events)('%s reaches both subscribers without a throw', async (_name, event) => {
    const onUpdate = jest.fn()
    const offReceives = await sparkSubscribeToReceives(onUpdate)
    await expect(lastListener().onEvent(event)).resolves.toBeUndefined()
    offReceives()
    expect(onUpdate).not.toHaveBeenCalled()

    const onChange = jest.fn()
    const offPayments = await sparkSubscribeToPayments(onChange)
    await expect(lastListener().onEvent(event)).resolves.toBeUndefined()
    offPayments()
    // Any event refreshes the screens on purpose, since a refresh costs a read and nothing else.
    expect(onChange).toHaveBeenCalledTimes(1)
  })

  // A listener's rejection reaches Rust as a panic in a library built to abort.
  test('a subscriber that throws, or an event that cannot be read, never rejects into the binding', async () => {
    const off = await sparkSubscribeToPayments(() => {
      throw new Error('screen gone')
    })
    await expect(lastListener().onEvent({ tag: SdkEvent_Tags.Synced } as SdkEvent)).resolves.toBeUndefined()
    off()

    const onUpdate = jest.fn()
    const offReceives = await sparkSubscribeToReceives(onUpdate)
    const unreadable = {
      tag: SdkEvent_Tags.PaymentSucceeded,
      get inner(): never {
        throw new Error('no payment')
      },
    } as unknown as SdkEvent
    await expect(lastListener().onEvent(unreadable)).resolves.toBeUndefined()
    offReceives()
    expect(onUpdate).not.toHaveBeenCalled()
  })

  // Whether a promise has settled once every queued microtask ran, without waiting on it.
  async function settledNow(promise: Promise<unknown>): Promise<boolean> {
    let settled = false
    promise.then(
      () => (settled = true),
      () => (settled = true),
    )
    for (let i = 0; i < 10; i++) {
      await Promise.resolve()
    }
    return settled
  }

  // SDK 0.28 awaits each listener in turn under its listener lock, so a subscriber's slow promise
  // awaited here would hold the next listener, the next event and the sync behind it.
  test('a subscriber whose promise never settles holds up neither its listener nor the next one', async () => {
    const stuck = jest.fn(() => new Promise<void>(() => undefined))
    const offStuck = await sparkAddEventListener(stuck)
    const first = lastListener()
    const after = jest.fn()
    const offAfter = await sparkAddEventListener(after)
    const second = lastListener()

    for (const event of [{ tag: SdkEvent_Tags.Synced }, { tag: SdkEvent_Tags.Synced }] as SdkEvent[]) {
      expect(await settledNow(first.onEvent(event))).toBe(true)
      expect(await settledNow(second.onEvent(event))).toBe(true)
    }
    expect(stuck).toHaveBeenCalledTimes(2)
    expect(after).toHaveBeenCalledTimes(2)
    offStuck()
    offAfter()
  })

  test('a subscriber that rejects or throws is caught and logged, never rejecting into the binding', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const offRejects = await sparkAddEventListener(() => Promise.reject(new Error('screen gone')))
      await expect(lastListener().onEvent({ tag: SdkEvent_Tags.Synced } as SdkEvent)).resolves.toBeUndefined()
      await settledNow(Promise.resolve())
      offRejects()
      expect(warn).toHaveBeenCalledWith('sdk listener failed: Error')

      warn.mockClear()
      const offThrows = await sparkAddEventListener(() => {
        throw new TypeError('view unmounted')
      })
      await expect(lastListener().onEvent({ tag: SdkEvent_Tags.Synced } as SdkEvent)).resolves.toBeUndefined()
      offThrows()
      expect(warn).toHaveBeenCalledWith('sdk listener failed: TypeError')
    } finally {
      warn.mockRestore()
    }
  })

  // A release build keeps its logs, and a subscriber's message can hold what the person typed or was
  // paid, so the log names the kind of failure and never repeats its words.
  test.each([
    ['an error with a code', Object.assign(new Error('paid 21000 sats to alice@usevoltz.app'), { code: 'E_GONE' }), 'Error E_GONE'],
    ['a binding error with a tag', Object.assign(new Error('alice@usevoltz.app'), { tag: 'InvalidInput' }), 'Error InvalidInput'],
    ['a thrown string', 'alice@usevoltz.app', 'string'],
    ['a thrown object with no name', { reason: 'alice@usevoltz.app' }, 'object'],
    [
      'a code that is really text, cut to 40 characters',
      Object.assign(new Error('x'), { code: 'E'.repeat(40) + ' alice@usevoltz.app' }),
      `Error ${'E'.repeat(40)}`,
    ],
  ])('a subscriber failure logs its kind and not its words: %s', async (_, failure, kind) => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      const offRejects = await sparkAddEventListener(() => Promise.reject(failure))
      await lastListener().onEvent({ tag: SdkEvent_Tags.Synced } as SdkEvent)
      await settledNow(Promise.resolve())
      offRejects()
      const offThrows = await sparkAddEventListener(() => {
        throw failure
      })
      await lastListener().onEvent({ tag: SdkEvent_Tags.Synced } as SdkEvent)
      offThrows()

      expect(warn.mock.calls).toEqual([[`sdk listener failed: ${kind}`], [`sdk listener failed: ${kind}`]])
      expect(JSON.stringify(warn.mock.calls)).not.toContain('alice')
    } finally {
      warn.mockRestore()
    }
  })
})

describe('receiveUpdateFromEvent', () => {
  test('a failed receive names its payment, so only that pill comes down', () => {
    const event = {
      tag: SdkEvent_Tags.PaymentFailed,
      inner: { payment: { id: 'p1', paymentType: PaymentType.Receive, amount: 2100n } },
    } as never
    expect(receiveUpdateFromEvent(event)).toEqual({ id: 'p1', stage: 'failed', sat: 2100 })
  })

  test('a failed send is no receive', () => {
    const event = {
      tag: SdkEvent_Tags.PaymentFailed,
      inner: { payment: { id: 'p1', paymentType: PaymentType.Send, amount: 2100n } },
    } as never
    expect(receiveUpdateFromEvent(event)).toBeNull()
  })

  const inbound = { paymentType: PaymentType.Receive, amount: 50000 }
  const outbound = { paymentType: PaymentType.Send, amount: 50000 }

  test('maps a settled inbound payment to "received"', () => {
    const event = { tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment: inbound } } as never
    expect(receiveUpdateFromEvent(event)).toEqual({ stage: 'received', sat: 50000 })
  })

  test('a settled inbound zap carries the zapper comment for the overlay', () => {
    const payment = {
      paymentType: PaymentType.Receive,
      amount: 50000,
      details: {
        tag: 'Lightning',
        inner: {
          destinationPubkey: '02x',
          lnurlReceiveMetadata: { nostrZapRequest: JSON.stringify({ kind: 9734, content: 'zap zap' }) },
        },
      },
    }
    const event = { tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment } } as never
    expect(receiveUpdateFromEvent(event)).toEqual({ stage: 'received', sat: 50000, rail: 'lightning', zap: { comment: 'zap zap' } })
  })

  // The provider's delivery ends on a Spark transfer, which is not how the money came.
  test('a receive brought from another chain names no rail', () => {
    const payment = {
      paymentType: PaymentType.Receive,
      amount: 25_337_999n,
      details: {
        tag: 'Token',
        inner: {
          metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 },
          conversionInfo: { tag: 'Orchestra', inner: { chain: 'base', asset: 'USDC', assetDecimals: 6 } },
        },
      },
    }
    for (const tag of [SdkEvent_Tags.PaymentPending, SdkEvent_Tags.PaymentSucceeded]) {
      const update = receiveUpdateFromEvent({ tag, inner: { payment } } as never)
      expect(update).toMatchObject({ asset: { ticker: 'USDB' } })
      expect(update).not.toHaveProperty('rail')
    }
  })

  // Without the asset the overlay announces 10 USDB as 10,000,000 sats.
  test('an inbound token payment carries its asset for the overlay', () => {
    const payment = {
      paymentType: PaymentType.Receive,
      amount: 10_000_000n,
      details: { tag: 'Token', inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 } } },
    }
    const event = { tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment } } as never
    expect(receiveUpdateFromEvent(event)).toMatchObject({ stage: 'received', asset: { ticker: 'USDB', amount: '10' } })
  })

  test('an incoming token payment carries its asset too', () => {
    const payment = {
      paymentType: PaymentType.Receive,
      amount: 10_000_000n,
      details: {
        tag: 'Token',
        inner: {
          metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 },
          invoiceDetails: { invoice: 'spark1invoice' },
        },
      },
    }
    const event = { tag: SdkEvent_Tags.PaymentPending, inner: { payment } } as never
    expect(receiveUpdateFromEvent(event)).toMatchObject({ stage: 'incoming', asset: { ticker: 'USDB', amount: '10' } })
  })

  // The overlay names the rail the record gives: the details' tag first, the method when details are
  // absent, and nothing when neither says.
  test.each([
    ['a Lightning receive', { details: { tag: 'Lightning', inner: {} } }, 'lightning'],
    ['an on-chain deposit', { details: { tag: 'Deposit', inner: {} } }, 'bitcoin'],
    ['a Spark transfer named only by its method', { method: 1 }, 'spark'],
    // With an invoice on it, since a bare transfer's pending event may be a conversion's delivery.
    [
      'a token transfer',
      {
        details: {
          tag: 'Token',
          inner: {
            metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 },
            invoiceDetails: { invoice: 'spark1invoice' },
          },
        },
      },
      'spark',
    ],
  ])('%s carries its rail, pending and settled', (_name, fields, rail) => {
    const payment = { paymentType: PaymentType.Receive, amount: 50000n, ...fields }
    expect(receiveUpdateFromEvent({ tag: SdkEvent_Tags.PaymentPending, inner: { payment } } as never)).toMatchObject({ rail })
    expect(receiveUpdateFromEvent({ tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment } } as never)).toMatchObject({ rail })
  })

  test('a record that names no rail carries none', () => {
    const payment = { paymentType: PaymentType.Receive, amount: 50000n, method: 5 }
    expect(receiveUpdateFromEvent({ tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment } } as never)).not.toHaveProperty('rail')
  })

  // It re-announces a payment already shown, now with where it came from, and must not show it twice.
  test('a metadata update of a received payment is not a second receive', () => {
    const event = { tag: SdkEvent_Tags.PaymentMetadataUpdated, inner: { payment: inbound } } as never
    expect(receiveUpdateFromEvent(event)).toBeNull()
  })

  test('maps a pending inbound payment to "incoming"', () => {
    const event = { tag: SdkEvent_Tags.PaymentPending, inner: { payment: inbound } } as never
    expect(receiveUpdateFromEvent(event)).toEqual({ stage: 'incoming', sat: 50000 })
  })

  describe('a conversion is not money arriving', () => {
    const sats = (inner: object) => ({
      paymentType: PaymentType.Receive,
      amount: 31_473n,
      details: { tag: 'Spark', inner },
    })
    const token = (inner: object) => ({
      paymentType: PaymentType.Receive,
      amount: 25_337_999n,
      details: { tag: 'Token', inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 }, ...inner } },
    })
    const amm = (status: number, purpose?: string) => ({
      tag: 'Amm',
      inner: { poolId: 'pool', conversionId: 'c1', status, purpose: purpose === undefined ? undefined : { tag: purpose } },
    })
    const event = (tag: SdkEvent_Tags, payment: object) => ({ tag, inner: { payment } }) as never

    // The pool's delivery reaches the wallet before the swap answers, so at this point it carries
    // no conversion info at all, and nothing later takes an announcement down.
    test.each([
      ['sats', sats({})],
      ['token', token({})],
    ])('a bare pending %s transfer, which may be the pool delivering, is not announced', (_, payment) => {
      expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentPending, payment))).toBeNull()
    })

    test.each(['SelfTransfer', 'AutoConversion', 'OngoingPayment'])('a leg of a %s conversion is never announced', purpose => {
      const leg = sats({ conversionInfo: amm(1, purpose) })
      expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentPending, leg))).toBeNull()
      expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentSucceeded, leg))).toBeNull()
    })

    test('a transfer that says what paid it is still announced', () => {
      const invoiced = sats({ invoiceDetails: { invoice: 'spark1invoice' } })
      const htlc = sats({ htlcDetails: { paymentHash: 'ab' } })
      const crossChain = token({ conversionInfo: { tag: 'Orchestra', inner: { chain: 'tron', asset: 'USDT' } } })
      for (const payment of [invoiced, htlc, crossChain]) {
        expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentPending, payment))).toMatchObject({ stage: 'incoming' })
      }
    })

    test('a pending Lightning receive is still announced', () => {
      const lightning = { ...sats({}), details: { tag: 'Lightning', inner: { destinationPubkey: '02x' } } }
      expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentPending, lightning))).toMatchObject({ stage: 'incoming' })
    })

    test('a settled bare transfer is money arriving', () => {
      expect(receiveUpdateFromEvent(event(SdkEvent_Tags.PaymentSucceeded, sats({})))).toMatchObject({ stage: 'received' })
    })
  })

  test('ignores outbound payments (a send is not a receive)', () => {
    const event = { tag: SdkEvent_Tags.PaymentSucceeded, inner: { payment: outbound } } as never
    expect(receiveUpdateFromEvent(event)).toBeNull()
  })

  test('ignores non-payment events (e.g. Synced)', () => {
    const event = { tag: SdkEvent_Tags.Synced, inner: {} } as never
    expect(receiveUpdateFromEvent(event)).toBeNull()
  })
})

describe('Try again on a send in doubt (SND-02)', () => {
  const KEY = '0b9c4a4e-5f1d-4c3a-9e2b-7a6d5c4b3a21'
  const OTHER_KEY = '6f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0'
  const NO_ROWS = 'Underlying implementation error: Query returned no rows'
  const noRow = () => new SdkError.StorageError(NO_ROWS)
  const lnurlDetails = {
    callback: 'https://pay.example/cb',
    minSendable: 1_000n,
    maxSendable: 100_000_000n,
    metadataStr: '[]',
    commentAllowed: 0,
    domain: 'example.com',
    url: 'https://example.com/.well-known/lnurlp/alice',
    address: 'alice@example.com',
    allowsNostr: false,
  }

  // A keyed send whose confirm threw, as a dropped connection leaves it.
  async function threwInDoubt(): Promise<string> {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    sdk.sendPayment.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkConfirmSendHeld(quote.handle, KEY)).rejects.toThrow('transport error')
    return quote.handle
  }

  test('Try again sends the identical prepared request under the identical key, and prepares nothing', async () => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockRejectedValueOnce(noRow())
    const prepares = sdk.prepareSendPayment.mock.calls.length

    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ status: 'complete' })

    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: KEY })
    expect(sdk.sendPayment).toHaveBeenCalledTimes(2)
    const [first, again] = sdk.sendPayment.mock.calls.map(call => call[0])
    expect(again.prepareResponse).toBe(first.prepareResponse)
    expect(again.idempotencyKey).toBe(KEY)
    expect(first.idempotencyKey).toBe(KEY)
    expect(again.options).toBe(first.options)
    expect(sdk.prepareSendPayment.mock.calls.length).toBe(prepares)
  })

  test('an on-chain send goes again at the speed it first went at', async () => {
    sdk.prepareSendPayment.mockResolvedValueOnce({
      paymentMethod: {
        tag: 'BitcoinAddress',
        inner: {
          address: {},
          feeQuote: {
            speedFast: { l1BroadcastFeeSat: 1200n, userFeeSat: 930n },
            speedMedium: { l1BroadcastFeeSat: 780n, userFeeSat: 930n },
            speedSlow: { l1BroadcastFeeSat: 400n, userFeeSat: 930n },
            isEstimate: false,
          },
        },
      },
      amount: 5000n,
    })
    const quote = await sparkPrepareSend('bc1...', 5000)
    sdk.sendPayment.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkConfirmSendHeld(quote.handle, KEY, 'slow')).rejects.toThrow('transport error')
    sdk.getPayment.mockRejectedValueOnce(noRow())

    await sparkRetryHeldSend(quote.handle, KEY)

    const again = sdk.sendPayment.mock.calls[1][0]
    expect(fieldsOf(again.options)).toEqual({ confirmationSpeed: OnchainConfirmationSpeed.Slow })
    expect(again.idempotencyKey).toBe(KEY)
  })

  test.each([
    [0, 'complete'],
    [1, 'pending'],
    [2, 'failed'],
  ])('I2: a payment found under the key (status %s) answers %s and signs nothing', async (status, answer) => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockResolvedValueOnce({ payment: { id: KEY, status } })

    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ status: answer })

    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
    // The answer settles it, so nothing is held for a later press.
    await expect(sparkRetryHeldSend(handle, KEY)).rejects.toThrow('spark send not held')
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test('a read that fails for any other reason signs nothing and keeps the send held', async () => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockRejectedValueOnce(new SdkError.StorageError('database is locked'))

    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ read: 'unknown' })
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)

    sdk.getPayment.mockRejectedValueOnce(noRow())
    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ status: 'complete' })
    expect(sdk.sendPayment).toHaveBeenCalledTimes(2)
  })

  test('a read with no answer within KEY_READ_MS signs nothing, even when it answers later', async () => {
    const handle = await threwInDoubt()
    let late!: (value: unknown) => void
    sdk.getPayment.mockReturnValueOnce(new Promise(resolve => (late = resolve)))
    jest.useFakeTimers()
    try {
      const answer = sparkRetryHeldSend(handle, KEY)
      jest.advanceTimersByTime(KEY_READ_MS - 1)
      await Promise.resolve()
      jest.advanceTimersByTime(1)
      expect(await answer).toEqual({ read: 'unknown' })
    } finally {
      jest.useRealTimers()
    }
    late({ payment: { id: KEY, status: 0 } })
    await new Promise(resolve => setImmediate(resolve))
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test('a send dropped while its read is out is not signed when the read says none', async () => {
    const handle = await threwInDoubt()
    let answerRead!: (cause: unknown) => void
    sdk.getPayment.mockReturnValueOnce(new Promise((_, reject) => (answerRead = reject)))
    const answer = sparkRetryHeldSend(handle, KEY)
    sparkDropHeldSend(handle)
    answerRead(noRow())

    expect(await answer).toEqual({ read: 'unknown' })
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test('a send dropped while the exit-hold read is out is not signed when that read says none', async () => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockRejectedValueOnce(noRow())
    let answerHold!: (hold: 'none') => void
    const holdRead = jest
      .spyOn(exitHold, 'exitHoldOnSigner')
      .mockReturnValueOnce(new Promise(resolve => (answerHold = resolve)))
    try {
      const answer = sparkRetryHeldSend(handle, KEY)
      await new Promise(resolve => setImmediate(resolve))
      expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: KEY })
      expect(holdRead).toHaveBeenCalledTimes(1)
      sparkDropHeldSend(handle)
      answerHold('none')

      expect(await answer).toEqual({ read: 'unknown' })
      expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
    } finally {
      holdRead.mockRestore()
    }
  })

  test('a second Try again while one runs is refused', async () => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockReturnValueOnce(new Promise(() => undefined))
    sparkRetryHeldSend(handle, KEY).catch(() => undefined)

    await expect(sparkRetryHeldSend(handle, KEY)).rejects.toThrow('spark send not held')
  })

  // A keyed LNURL pay whose confirm threw, held the same way as a send.
  async function lnurlPayThrewInDoubt(): Promise<string> {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)
    sdk.lnurlPay.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkConfirmLnurlPay(quote.handle, KEY)).rejects.toThrow('transport error')
    return quote.handle
  }

  // Another wallet's storage holds no row under this key, so a read there would answer none and the
  // same invoice or address would go out again from that wallet.
  test.each([
    ['a send', threwInDoubt, () => sdk.sendPayment],
    ['an LNURL pay', lnurlPayThrewInDoubt, () => sdk.lnurlPay],
  ])('I2: %s held on one wallet is neither read nor signed while another is connected', async (_, hold, rail) => {
    const handle = await hold()
    sdk.getPayment.mockRejectedValueOnce(noRow())
    try {
      await connectSpark(MNEMONIC, 'second')
      expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ read: 'unknown' })
      expect(sdk.getPayment).not.toHaveBeenCalled()
      expect(rail()).toHaveBeenCalledTimes(1)
    } finally {
      await connectSpark(MNEMONIC, 'primary')
    }
    // Still held for the wallet that sent it, which reads and decides as usual once it is back.
    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ status: 'complete' })
    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: KEY })
    expect(rail()).toHaveBeenCalledTimes(2)
  })

  test('a wallet connected while the read is out is not signed from', async () => {
    const handle = await threwInDoubt()
    let answerRead!: (cause: unknown) => void
    sdk.getPayment.mockReturnValueOnce(new Promise((_, reject) => (answerRead = reject)))
    try {
      const answer = sparkRetryHeldSend(handle, KEY)
      await connectSpark(MNEMONIC, 'second')
      expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: KEY })
      answerRead(noRow())

      expect(await answer).toEqual({ read: 'unknown' })
      expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
    } finally {
      await connectSpark(MNEMONIC, 'primary')
    }
  })

  test('a retry that throws again stays held for the next press', async () => {
    const handle = await threwInDoubt()
    sdk.getPayment.mockRejectedValueOnce(noRow())
    sdk.sendPayment.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkRetryHeldSend(handle, KEY)).rejects.toThrow('transport error')

    sdk.getPayment.mockResolvedValueOnce({ payment: { id: KEY, status: 1 } })
    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({ status: 'pending' })
    expect(sdk.sendPayment).toHaveBeenCalledTimes(2)
  })

  test('a held send answers only to the key it went out under, and to no other handle', async () => {
    const handle = await threwInDoubt()
    await expect(sparkRetryHeldSend(handle, OTHER_KEY)).rejects.toThrow('spark send not held')
    const later = await sparkPrepareSend('lnbc1...', 1000)
    await expect(sparkRetryHeldSend(later.handle, KEY)).rejects.toThrow('spark send not held')
    expect(sdk.getPayment).not.toHaveBeenCalled()
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test('a held send never confirms again through a normal confirm', async () => {
    const handle = await threwInDoubt()
    await expect(sparkConfirmSend(handle)).rejects.toThrow('spark send not prepared')
    await expect(sparkConfirmSendHeld(handle, KEY)).rejects.toThrow('spark send not prepared')
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test('a send that answered is not held', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    sdk.sendPayment.mockResolvedValueOnce({ payment: { status: 1 } })
    expect(await sparkConfirmSendHeld(quote.handle, KEY)).toBe('pending')
    await expect(sparkRetryHeldSend(quote.handle, KEY)).rejects.toThrow('spark send not held')
  })

  test('a dropped send is gone', async () => {
    const handle = await threwInDoubt()
    sparkDropHeldSend(handle)
    await expect(sparkRetryHeldSend(handle, KEY)).rejects.toThrow('spark send not held')
  })

  test('a charge keeps its own key and a charge that throws is never held', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    sdk.sendPayment.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkConfirmSend(quote.handle, undefined, KEY)).rejects.toThrow('transport error')
    expect(sdk.sendPayment.mock.calls[0][0].idempotencyKey).toBe(KEY)
    await expect(sparkRetryHeldSend(quote.handle, KEY)).rejects.toThrow('spark send not held')
  })

  test.each([
    ['a token sent directly', { tokenIdentifier: 'btkn1usdb' }],
    ['a send funded by a conversion', { conversionEstimate: { options: { conversionType: { tag: 'FromBitcoin' } } } }],
    ['a cross-chain send', { paymentMethod: { tag: 'CrossChainAddress', inner: {} } }],
  ])('I3: %s takes no key, and a keyed confirm of it sends nothing', async (_, shape) => {
    sdk.prepareSendPayment.mockResolvedValueOnce({
      paymentMethod: { tag: 'SparkAddress', inner: { fee: 0n } },
      amount: 1000n,
      ...shape,
    })
    const quote = await sparkPrepareSend('spark1...', 1000)

    expect(sparkSendTakesKey(quote.handle)).toBe(false)
    await expect(sparkConfirmSendHeld(quote.handle, KEY)).rejects.toThrow('spark send takes no key')
    expect(sdk.sendPayment).not.toHaveBeenCalled()
    // Left prepared, so nothing about it changed.
    expect(await sparkConfirmSend(quote.handle)).toBe('complete')
    expect(sdk.sendPayment.mock.calls[0][0].idempotencyKey).toBeUndefined()
  })

  // The screen draws a v4 UUID in lower case; anything else goes without a key and so without a retry.
  test.each([
    ['not a UUID', 'not-a-uuid'],
    ['a UUID in upper case', KEY.toUpperCase()],
  ])('a keyed confirm under a key that is %s sends nothing and leaves the send prepared', async (_, bad) => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)

    await expect(sparkConfirmSendHeld(quote.handle, bad)).rejects.toThrow('spark send takes no key')
    expect(sdk.sendPayment).not.toHaveBeenCalled()
    expect(await sparkConfirmSend(quote.handle)).toBe('complete')
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })

  test.each([
    ['not a UUID', 'not-a-uuid'],
    ['a UUID in upper case', KEY.toUpperCase()],
  ])('a keyed LNURL pay under a key that is %s pays nothing and leaves the pay prepared', async (_, bad) => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)

    await expect(sparkConfirmLnurlPay(quote.handle, bad)).rejects.toThrow('lnurl-pay takes no key')
    expect(sdk.lnurlPay).not.toHaveBeenCalled()
    await sparkConfirmLnurlPay(quote.handle)
    expect(sdk.lnurlPay).toHaveBeenCalledTimes(1)
    expect(sdk.lnurlPay.mock.calls[0][0].idempotencyKey).toBeUndefined()
  })

  test('a sats send takes a key', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    expect(sparkSendTakesKey(quote.handle)).toBe(true)
  })

  test('an LNURL pay goes again with the invoice its prepare minted and the same key', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)
    expect(sparkSendTakesKey(quote.handle)).toBe(true)
    sdk.lnurlPay.mockRejectedValueOnce(new Error('transport error'))
    await expect(sparkConfirmLnurlPay(quote.handle, KEY)).rejects.toThrow('transport error')
    sdk.getPayment.mockRejectedValueOnce(noRow())
    sdk.lnurlPay.mockResolvedValueOnce({
      payment: { status: 0 },
      successAction: { tag: 'Message', inner: { data: { message: 'Thanks!' } } },
    })

    expect(await sparkRetryHeldSend(quote.handle, KEY)).toEqual({
      status: 'complete',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
    const [first, again] = sdk.lnurlPay.mock.calls.map(call => call[0])
    expect(again.prepareResponse).toBe(first.prepareResponse)
    expect(again.idempotencyKey).toBe(KEY)
    expect(sdk.prepareLnurlPay).toHaveBeenCalledTimes(1)
  })

  test('an LNURL pay found by its key answers the success action the payee left, and pays nothing', async () => {
    const handle = await lnurlPayThrewInDoubt()
    sdk.getPayment.mockResolvedValueOnce({
      payment: {
        id: KEY,
        status: 0,
        paymentType: PaymentType.Send,
        details: {
          tag: 'Lightning',
          inner: {
            invoice: 'lnbc1',
            destinationPubkey: '02',
            lnurlPayInfo: { processedSuccessAction: { tag: 'Message', inner: { data: { message: 'Thanks!' } } } },
          },
        },
      },
    })

    expect(await sparkRetryHeldSend(handle, KEY)).toEqual({
      status: 'complete',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
    expect(sdk.lnurlPay).toHaveBeenCalledTimes(1)
  })

  test('an LNURL pay funded by a conversion takes no key', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    sdk.prepareLnurlPay.mockResolvedValueOnce({
      amountSats: 5000n,
      feeSats: 1n,
      conversionEstimate: { options: { conversionType: { tag: 'FromBitcoin' } } },
    })
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)

    expect(sparkSendTakesKey(quote.handle)).toBe(false)
    await expect(sparkConfirmLnurlPay(quote.handle, KEY)).rejects.toThrow('lnurl-pay takes no key')
    expect(sdk.lnurlPay).not.toHaveBeenCalled()
  })
})

describe('lnurl-pay (paying a lightning address / LNURL)', () => {
  // LNURL-pay details as the SDK nests them, with amounts in millisats.
  const lnurlDetails = {
    callback: 'https://pay.example/cb',
    minSendable: 1_000_000n,
    maxSendable: 100_000_000n,
    metadataStr: '[]',
    commentAllowed: 120,
    domain: 'example.com',
    url: 'https://example.com/.well-known/lnurlp/alice',
    address: 'alice@example.com',
    allowsNostr: false,
  }

  test('spending everything takes what arrives from the invoice the payee was asked for', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 50_000n,
      feeSats: 100n,
      invoiceDetails: { amountMsat: 49_880_000n },
    })

    const quote = await sparkPrepareLnurlPay(ln.handle, 50_000, undefined, true)

    expect(sdk.prepareLnurlPay.mock.calls[0][0].feePolicy).toBe(FeePolicy.FeesIncluded)
    expect(quote).toMatchObject({ amount: 50_000, feesIncluded: true, receives: 49_880 })
  })

  test('a dollar balance goes to an LNURL pay as a sale of the whole USDB, in sats on the way back', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 12_307n,
      feeSats: 7n,
      invoiceDetails: { amountMsat: 12_300_000n },
    })

    const quote = await sparkPrepareLnurlPay(ln.handle, 12_400_000, undefined, true, true)

    const asked = sdk.prepareLnurlPay.mock.calls[0][0]
    expect(asked.amount).toBe(12_400_000n)
    expect(asked.tokenIdentifier).toBe(USDB.identifier)
    expect(asked.feePolicy).toBe(FeePolicy.FeesIncluded)
    expect(asked.conversionOptions.conversionType.inner.fromTokenIdentifier).toBe(USDB.identifier)
    expect(quote).toMatchObject({ amount: 12_307, feesIncluded: true, receives: 12_300 })
  })

  const sale = {
    amountIn: 12_400_000n,
    amountOut: 12_276n,
    fee: 30n,
    options: { conversionType: { tag: ConversionType_Tags.ToBitcoin, inner: { fromTokenIdentifier: USDB.identifier } } },
  }

  test('a dollar sale to an LNURL pay reads the pool, past the floor it signs', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 12_276n,
      feeSats: 7n,
      invoiceDetails: { amountMsat: 12_269_000n },
      conversionEstimate: sale,
    })

    const quote = await sparkPrepareLnurlPay(ln.handle, 12_400_000, undefined, true, true)

    expect(quote.conversion).toMatchObject({ amountOut: 12_276, expectedOut: 12_400 })
  })

  test('a dollar sale to an invoice reads the pool too', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 12_276n,
      conversionEstimate: sale,
    })

    const quote = await sparkPrepareSend('lnbc1x', 12_400_000, undefined, true, true)

    expect(quote.conversion).toMatchObject({ amountOut: 12_276, expectedOut: 12_400 })
  })

  test('a conversion the SDK adds to reach a sats amount answers the pool already', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Spark', inner: {} },
      amount: 12_300n,
      conversionEstimate: { ...sale, amountOut: 12_307n },
    })

    const quote = await sparkPrepareSend('lnbc1x', 12_300)

    expect(quote.conversion?.amountOut).toBe(12_307)
    expect(quote.conversion?.expectedOut).toBeUndefined()
  })

  test('sparkParseLnurlPay maps the sendable range (msat -> sat), comment policy and payee', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })

    const ln = await sparkParseLnurlPay('alice@example.com')

    expect(ln.minSat).toBe(1000)
    expect(ln.maxSat).toBe(100_000)
    expect(ln.commentAllowed).toBe(120)
    expect(ln.payee).toBe('alice@example.com')
  })

  test('sparkParseLnurlPay accepts a lightning address (tag LightningAddress), reading inner.payRequest', async () => {
    // A user@domain input parses as LightningAddress, so mocking LnurlPay here would hide that tag.
    sdk.parse.mockResolvedValue({
      tag: 'LightningAddress',
      inner: [{ address: 'alice@example.com', payRequest: lnurlDetails }],
    })

    const ln = await sparkParseLnurlPay('alice@example.com')

    expect(ln.minSat).toBe(1000)
    expect(ln.maxSat).toBe(100_000)
    expect(ln.commentAllowed).toBe(120)
    expect(ln.payee).toBe('alice@example.com')
  })

  test('sparkParseLnurlPay rejects a destination that is not an LNURL-pay endpoint', async () => {
    sdk.parse.mockResolvedValue({ tag: 'Bolt11Invoice' })
    await expect(sparkParseLnurlPay('lnbc1invoice')).rejects.toThrow()
  })

  test('sparkPrepareLnurlPay quotes the amount + comment and returns amountSat/feeSat/memo', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 5000n,
      feeSats: 12n,
      invoiceDetails: { description: 'Coffee' },
      successAction: undefined,
      conversionEstimate: undefined,
      feePolicy: undefined,
    })

    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000, 'thanks')

    const arg = sdk.prepareLnurlPay.mock.calls[0][0]
    expect(arg.amount).toBe(5000n)
    expect(arg.comment).toBe('thanks')
    expect(quote.amount).toBe(5000)
    expect(quote.fee).toBe(12)
    expect(quote.description).toBe('Coffee')
  })

  test('a lightning-address quote surfaces the conversion the SDK prepared', async () => {
    // A wallet holding only dollars pays by having the SDK sell the token first. Dropping that
    // estimate here makes the send screen compare the price against a sat balance of zero and
    // refuse a payment the SDK has already arranged, which is what the dollar wallet hits every
    // time.
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 1_000n,
      feeSats: 2n,
      invoiceDetails: { description: 'x' },
      successAction: undefined,
      feePolicy: undefined,
      conversionEstimate: {
        amountIn: 4_000n,
        amountOut: 1_002n,
        fee: 30n,
        options: {
          conversionType: {
            tag: ConversionType_Tags.ToBitcoin,
            inner: { fromTokenIdentifier: USDB.identifier },
          },
        },
      },
    })

    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 1_000)

    expect(quote.conversion).toEqual({
      tokenIdentifier: USDB.identifier,
      amountIn: 4_000,
      amountOut: 1_002,
      fee: 30,
    })
  })

  test('a lightning-address quote paid in sats carries no conversion', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    sdk.prepareLnurlPay.mockResolvedValue({
      amountSats: 1_000n,
      feeSats: 2n,
      invoiceDetails: { description: 'x' },
      successAction: undefined,
      conversionEstimate: undefined,
      feePolicy: undefined,
    })

    const ln = await sparkParseLnurlPay('alice@example.com')
    expect((await sparkPrepareLnurlPay(ln.handle, 1_000)).conversion).toBeUndefined()
  })

  test('an empty comment is sent as undefined (no comment field)', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    await sparkPrepareLnurlPay(ln.handle, 5000, '')
    expect(sdk.prepareLnurlPay.mock.calls[0][0].comment).toBeUndefined()
  })

  test('what the server says comes back with the status, read as the sheet reads it', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    sdk.lnurlPay.mockResolvedValue({
      payment: { status: 1 },
      successAction: { tag: 'Message', inner: { data: { message: 'Thanks!' } } },
    })
    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)

    expect(await sparkConfirmLnurlPay(quote.handle)).toEqual({
      status: 'pending',
      successAction: { kind: 'message', text: 'Thanks!' },
    })
  })

  test('sparkConfirmLnurlPay executes the prepared payment and maps the status', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [lnurlDetails] })
    sdk.lnurlPay.mockResolvedValue({ payment: { status: 0 }, successAction: undefined })

    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)

    expect(await sparkConfirmLnurlPay(quote.handle)).toEqual({ status: 'complete', successAction: undefined })
    // An LNURL pay has no options to hold a route, so it never takes the Spark one.
    expect(sdk.lnurlPay).toHaveBeenCalledWith({ prepareResponse: expect.anything(), idempotencyKey: undefined })
  })
})

describe('lnurl-withdraw (redeem a voucher: pull sats in)', () => {
  // Millisats not divisible by 1000, so ceil (min) and floor (max) are the only correct answers.
  const wd = {
    callback: 'https://f/cb',
    k1: 'deadbeef',
    defaultDescription: 'Voucher',
    minWithdrawable: 1_000_500n,
    maxWithdrawable: 100_000_500n,
  }

  test('sparkParseLnurlWithdraw maps the range millisats -> sats (ceil min, floor max) and the label', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlWithdraw', inner: [wd] })

    const w = await sparkParseLnurlWithdraw('lnurl1wd')

    expect(w.minSat).toBe(1001)
    expect(w.maxSat).toBe(100_000)
    expect(w.description).toBe('Voucher')
  })

  test('sparkParseLnurlWithdraw rejects a destination that is not a withdraw voucher', async () => {
    sdk.parse.mockResolvedValue({ tag: 'Bolt11Invoice' })
    await expect(sparkParseLnurlWithdraw('lnbc1invoice')).rejects.toThrow()
  })

  test('sparkConfirmLnurlWithdraw pulls amountSat as bigint and maps the status', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlWithdraw', inner: [wd] })
    sdk.lnurlWithdraw.mockResolvedValue({ paymentRequest: 'lnbc', payment: { status: 0 } })

    const w = await sparkParseLnurlWithdraw('lnurl1wd')
    expect(await sparkConfirmLnurlWithdraw(w.handle, 5000)).toBe('complete')

    const arg = sdk.lnurlWithdraw.mock.calls[0][0]
    expect(arg.amountSats).toBe(5000n)
    expect(arg.withdrawRequest).toBe(wd)
  })

  test('an undefined payment (timeout not reached) is a pending inbound, not a failure', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlWithdraw', inner: [wd] })
    sdk.lnurlWithdraw.mockResolvedValue({ paymentRequest: 'lnbc', payment: undefined })

    const w = await sparkParseLnurlWithdraw('lnurl1wd')
    expect(await sparkConfirmLnurlWithdraw(w.handle, 5000)).toBe('pending')
  })
})

describe('on-chain deposits (claim / refund funds stuck at the deposit address)', () => {
  const dep = (
    txid: string,
    over: Partial<{
      isMature: boolean
      claimError: unknown
      instantClaimStatus: unknown
      refundTxId: string
      refundState: unknown
    }> = {},
  ) => ({
    txid,
    vout: 0,
    amountSats: 50000n,
    isMature: over.isMature ?? true,
    refundTx: undefined,
    refundTxId: over.refundTxId,
    refundState: over.refundState,
    claimError: 'claimError' in over ? over.claimError : undefined,
    instantClaimStatus: over.instantClaimStatus,
    maxClaimFee: undefined,
  })

  test('sparkListUnclaimedDeposits maps deposits; claimable only when mature and error-free', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [
        dep('a'),
        dep('b', { isMature: false }),
        dep('c', { claimError: { tag: 'Generic' } }),
        dep('d', {
          claimError: {
            tag: 'MaxDepositClaimFeeExceeded',
            inner: { requiredFeeSats: 1800n },
          },
        }),
      ],
    })

    const deposits = await sparkListUnclaimedDeposits()

    expect(deposits).toEqual([
      expect.objectContaining({ txid: 'a', vout: 0, amountSat: 50000, claimable: true, quotedFeeSat: undefined }),
      expect.objectContaining({ txid: 'b', vout: 0, amountSat: 50000, claimable: false, quotedFeeSat: undefined }),
      expect.objectContaining({ txid: 'c', vout: 0, amountSat: 50000, claimable: false, quotedFeeSat: undefined }),
      // Refused on price alone, so it is still claimable and the quoted fee rides along for approval.
      expect.objectContaining({ txid: 'd', vout: 0, amountSat: 50000, claimable: true, quotedFeeSat: 1800 }),
    ])
  })

  // A deposit credited early stays listed until the provider spends its output, and the operators'
  // feed later reports it mature with no error. Offered as claimable, the card would ask to claim
  // money that already arrived.
  test('a deposit already credited early is never offered for claiming', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [
        dep('claimed', { instantClaimStatus: { tag: 'Claimed' } }),
        dep('submitted', { instantClaimStatus: { tag: 'Submitted', inner: { claimId: 'c1' } } }),
        dep('declined', {
          instantClaimStatus: { tag: 'Declined', inner: { maxFeeSats: 1000n, confirmations: 1 } },
        }),
      ],
    })

    const claimable = (await sparkListUnclaimedDeposits()).map(d => [d.txid, d.claimable])

    // Declined early is still the ordinary mature claim, so it stays claimable. Claimed is out of the
    // list altogether, by the next test.
    expect(claimable).toEqual([
      ['submitted', false],
      ['declined', true],
    ])
  })

  // Claimed is already a payment, so a row would show the money twice. Submitted has no payment yet,
  // so leaving it out would show the money nowhere.
  test('an early claim that landed is out of the list, and one still submitted stays in', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [
        dep('claimed', { instantClaimStatus: { tag: 'Claimed' } }),
        dep('submitted', { instantClaimStatus: { tag: 'Submitted', inner: { claimId: 'c1' } } }),
      ],
    })

    expect(await sparkListUnclaimedDeposits()).toEqual([
      expect.objectContaining({ txid: 'submitted', stage: 'arriving', claimable: false }),
    ])
  })

  const tooSmall = { tag: 'DepositTooSmall', inner: { tx: 'small', vout: 0 } }

  test('a deposit stands at the stage its fields say', async () => {
    const priced = { tag: 'MaxDepositClaimFeeExceeded', inner: { requiredFeeSats: 1800n } }
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [
        dep('young', { isMature: false }),
        dep('mature'),
        dep('priced', { claimError: priced }),
        dep('broken', { claimError: { tag: 'Generic', inner: { message: 'no' } } }),
        dep('small', { claimError: tooSmall }),
        dep('back', { claimError: priced, refundTxId: 'r1' }),
      ],
    })

    expect((await sparkListUnclaimedDeposits()).map(d => [d.txid, d.stage])).toEqual([
      ['young', 'arriving'],
      ['mature', 'arriving'],
      ['priced', 'needsFee'],
      ['broken', 'stuck'],
      ['small', 'tooSmall'],
      ['back', 'returning'],
    ])
  })

  // No ceiling makes it claimable, so no fee is offered, and the SDK retries on every pass.
  test('a deposit too small to claim offers no claim and can still be sent back', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({ deposits: [dep('small', { claimError: tooSmall })] })

    expect(await sparkListUnclaimedDeposits()).toEqual([
      expect.objectContaining({ claimable: false, quotedFeeSat: undefined, refundable: true, stage: 'tooSmall' }),
    ])
  })

  // Too small to claim early says nothing about claiming at maturity, which costs less.
  test('a young deposit with the same refusal is still on its way', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [dep('young', { isMature: false, claimError: tooSmall })],
    })

    expect((await sparkListUnclaimedDeposits())[0].stage).toBe('arriving')
  })

  // claim_deposit does not refuse a deposit being refunded, so Receive would burn the fee racing it.
  test('a deposit being sent back is never offered for claiming', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({ deposits: [dep('back', { refundTxId: 'r1' })] })
    expect(await sparkListUnclaimedDeposits()).toEqual([
      expect.objectContaining({ claimable: false, refundable: false, refundTxId: 'r1', stage: 'returning' }),
    ])
  })

  test.each([
    ['mature with a price refusal', { claimError: { tag: 'MaxDepositClaimFeeExceeded', inner: { requiredFeeSats: 1n } } }, true],
    ['mature with another error', { claimError: { tag: 'Generic' } }, true],
    ['mature with no error, which is the automatic claim', {}, false],
    ['young', { isMature: false, claimError: { tag: 'Generic' } }, false],
    ['already being sent back', { claimError: { tag: 'Generic' }, refundTxId: 'r1' }, false],
    ['credited early', { claimError: { tag: 'Generic' }, instantClaimStatus: { tag: 'Submitted', inner: { claimId: 'c' } } }, false],
  ])('refundable: %s', async (_name, over, refundable) => {
    sdk.listUnclaimedDeposits.mockResolvedValue({ deposits: [dep('x', over)] })
    expect((await sparkListUnclaimedDeposits())[0].refundable).toBe(refundable)
  })

  test('a refund\'s state reads as pending, refused or accepted', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({
      deposits: [
        dep('a', { refundTxId: 'r', refundState: { tag: 'BroadcastPending', inner: { lastError: undefined } } }),
        dep('b', { refundTxId: 'r', refundState: { tag: 'BroadcastPending', inner: { lastError: 'min relay' } } }),
        dep('c', { refundTxId: 'r', refundState: { tag: 'Broadcast' } }),
      ],
    })
    expect((await sparkListUnclaimedDeposits()).map(d => [d.refundState, d.refundError])).toEqual([
      ['pending', undefined],
      ['pending', 'min relay'],
      ['broadcast', undefined],
    ])
  })

  describe('sparkRefundAddress', () => {
    const address = (a: string) => ({ tag: 'BitcoinAddress', inner: [{ address: a }] })
    const bip21 = (uri: string, methods: unknown[]) => ({
      tag: 'Bip21',
      inner: [{ uri, amountSat: undefined, paymentMethods: methods }],
    })

    test('a Bitcoin address passes, trimmed', async () => {
      sdk.parse.mockResolvedValue(address('bc1qok'))
      expect(await sparkRefundAddress('  bc1qok\n')).toBe('bc1qok')
    })

    test('a BIP21 hands over its address', async () => {
      sdk.parse.mockResolvedValue(bip21('bitcoin:bc1qok', [address('bc1qok')]))
      expect(await sparkRefundAddress('bitcoin:bc1qok')).toBe('bc1qok')
    })

    test('a BIP21 with a Spark leg is refused', async () => {
      sdk.parse.mockResolvedValue(bip21('bitcoin:bc1qok?spark=sp1x', [address('bc1qok')]))
      expect(await sparkRefundAddress('bitcoin:bc1qok?spark=sp1x')).toBeNull()
    })

    test.each(['SparkAddress', 'SparkInvoice', 'Bolt11Invoice', 'LightningAddress'])('%s is refused', async tag => {
      sdk.parse.mockResolvedValue({ tag, inner: [{}] })
      expect(await sparkRefundAddress('x')).toBeNull()
    })

    test('loose text is refused', async () => {
      sdk.parse.mockRejectedValue(new Error('invalid input'))
      expect(await sparkRefundAddress('hello')).toBeNull()
    })
  })

  test('is empty when there are no unclaimed deposits', async () => {
    sdk.listUnclaimedDeposits.mockResolvedValue({ deposits: [] })
    expect(await sparkListUnclaimedDeposits()).toEqual([])
  })

  test('sparkClaimDeposit claims a specific deposit and maps the status', async () => {
    sdk.claimDeposit.mockResolvedValue({ outcome: { tag: 'Settled', inner: { payment: { status: 0 } } } })
    expect(await sparkClaimDeposit('a', 0)).toBe('complete')
    expect(sdk.claimDeposit).toHaveBeenCalledWith({ txid: 'a', vout: 0, maxFee: undefined })
  })

  // An early claim is accepted before it settles, and a deferred one claimed nothing. Neither may
  // read as done, and a deferred one is not in flight either.
  test('sparkClaimDeposit tells an accepted early claim from a deferred one', async () => {
    sdk.claimDeposit.mockResolvedValueOnce({ outcome: { tag: 'Submitted' } })
    expect(await sparkClaimDeposit('a', 0)).toBe('pending')

    sdk.claimDeposit.mockResolvedValueOnce({
      outcome: { tag: 'Deferred', inner: { reason: { tag: 'NoEarlyClaimAvailable' } } },
    })
    expect(await sparkClaimDeposit('a', 0)).toBe('deferred')
  })

  // Left to the config ceiling, a manual claim could never clear what the automatic pass refused.
  test('sparkClaimDeposit carries an explicit ceiling when one is given', async () => {
    sdk.claimDeposit.mockResolvedValue({ outcome: { tag: 'Settled', inner: { payment: { status: 0 } } } })

    await sparkClaimDeposit('a', 0, 1800)

    const req = sdk.claimDeposit.mock.calls.at(-1)?.[0] as {
      maxFee: { onchain: { tag: string; inner: { amount: bigint } }; proportionalPpm: unknown }
    }
    expect(req.maxFee.onchain).toBeInstanceOf(MaxOnchainFee.Fixed)
    expect(req.maxFee.onchain.inner).toEqual({ amount: 1800n })
    // The figure the person approved is the whole ceiling, with no share of the amount on top.
    expect(req.maxFee.proportionalPpm).toBeUndefined()
  })

  test('sparkRefundDeposit refunds to an address at the fixed fee and returns the txid', async () => {
    sdk.refundDeposit.mockResolvedValue({ txId: 'refundtx', txHex: '00' })

    const txid = await sparkRefundDeposit('c', 0, 'bc1qrefund', 8)

    expect(txid).toBe('refundtx')
    const arg = sdk.refundDeposit.mock.calls[0][0]
    expect(arg.destinationAddress).toBe('bc1qrefund')
    expect(arg.fee).toBeInstanceOf(Fee.Fixed)
    expect(fieldsOf(arg.fee).amount).toBe(8n)
  })

  test('sparkRecommendedFees maps the mempool tiers to fast/medium/slow', async () => {
    sdk.recommendedFees.mockResolvedValue({
      fastestFee: 20n,
      halfHourFee: 10n,
      hourFee: 5n,
      economyFee: 2n,
      minimumFee: 1n,
    })
    expect(await sparkRecommendedFees()).toEqual({ fast: 20, medium: 10, slow: 2 })
  })
})

describe('contacts (address book)', () => {
  test('sparkListContacts maps SDK contacts to {id, name, address}', async () => {
    sdk.listContacts.mockResolvedValue([
      { id: 'c1', name: 'Alice', paymentIdentifier: 'alice@breez.tips', createdAt: 0n, updatedAt: 0n },
    ])
    expect(await sparkListContacts()).toEqual([{ id: 'c1', name: 'Alice', address: 'alice@breez.tips' }])
  })

  test('sparkAddContact saves the name + lightning address and returns the new contact', async () => {
    sdk.addContact.mockResolvedValue({
      id: 'c2',
      name: 'Bob',
      paymentIdentifier: 'bob@x.com',
      createdAt: 0n,
      updatedAt: 0n,
    })

    const c = await sparkAddContact('Bob', 'bob@x.com')

    expect(sdk.addContact).toHaveBeenCalledWith({ name: 'Bob', paymentIdentifier: 'bob@x.com' })
    expect(c).toEqual({ id: 'c2', name: 'Bob', address: 'bob@x.com' })
  })

  test('sparkUpdateContact updates the name + address by id', async () => {
    await sparkUpdateContact('c1', 'Alicia', 'alicia@breez.tips')
    expect(sdk.updateContact).toHaveBeenCalledWith({
      id: 'c1',
      name: 'Alicia',
      paymentIdentifier: 'alicia@breez.tips',
    })
  })

  test('sparkDeleteContact removes a contact by id', async () => {
    await sparkDeleteContact('c1')
    expect(sdk.deleteContact).toHaveBeenCalledWith('c1')
  })
})

describe('webhooks (payment notices)', () => {
  test('sparkRegisterWebhook subscribes to all four payment events and answers the provider id', async () => {
    sdk.registerWebhook.mockResolvedValue({ webhookId: 'h1' })
    expect(await sparkRegisterWebhook('https://gw/api/push/spark/abc', 'shhh')).toBe('h1')

    const req = sdk.registerWebhook.mock.calls[0][0]
    expect(req.url).toBe('https://gw/api/push/spark/abc')
    expect(req.secret).toBe('shhh')
    expect(req.eventTypes.map((e: { tag: string }) => e.tag)).toEqual([
      'LightningReceiveFinished',
      'LightningSendFinished',
      'CoopExitFinished',
      'StaticDepositFinished',
    ])
    expect(req.eventTypes[1]).toBeInstanceOf(WebhookEventType.LightningSendFinished)
  })

  test('sparkListWebhooks reads each webhook with its event tags, an unknown one by name', async () => {
    sdk.listWebhooks.mockResolvedValue([
      {
        id: 'w1',
        url: 'https://gw/notify',
        eventTypes: [new WebhookEventType.CoopExitFinished(), new WebhookEventType.Unknown('SparkNew')],
      },
    ])
    expect(await sparkListWebhooks()).toEqual([
      { id: 'w1', url: 'https://gw/notify', events: ['CoopExitFinished', 'Unknown:SparkNew'] },
    ])
  })

  test('sparkUnregisterWebhook removes a webhook by id', async () => {
    await sparkUnregisterWebhook('w1')
    expect(sdk.unregisterWebhook).toHaveBeenCalledWith({ webhookId: 'w1' })
  })

  test('a session is refused on another wallet, so a pass never touches the wallet switched to', async () => {
    const { pubkey } = await sparkConnectedIdentity()
    expect(() => sparkWebhookSession('second', pubkey)).toThrow('another wallet')
    const session = sparkWebhookSession('primary', pubkey)
    sdk.listWebhooks.mockResolvedValue([])
    await expect(session.list()).resolves.toEqual([])
    await connectSpark(MNEMONIC, 'second')
    try {
      // The calls of a session started on the wallet before the switch refuse, rather than land on
      // the connection now live.
      sdk.listWebhooks.mockClear()
      await expect(session.list()).rejects.toThrow('spark not connected')
      await expect(session.register('https://gw/x', 's')).rejects.toThrow('spark not connected')
      await expect(session.unregister('h1')).rejects.toThrow('spark not connected')
      expect(sdk.listWebhooks).not.toHaveBeenCalled()
      expect(sdk.registerWebhook).not.toHaveBeenCalled()
      expect(sdk.unregisterWebhook).not.toHaveBeenCalled()
    } finally {
      await connectSpark(MNEMONIC, 'primary')
    }
  })

  test('a session is refused on the same wallet opened with other words, so a pass never settles one key against another', async () => {
    sdk.getInfo.mockResolvedValue({ identityPubkey: '03cd', balanceSats: 0n, tokenBalances: new Map() })
    await connectSpark(MNEMONIC, 'second')
    try {
      sdk.listWebhooks.mockClear()
      sdk.registerWebhook.mockClear()
      sdk.unregisterWebhook.mockClear()
      const other = sparkWebhookSession('second', '02ab')
      await expect(other.list()).rejects.toThrow('another identity')
      await expect(other.register('https://gw/x', 's')).rejects.toThrow('another identity')
      await expect(other.unregister('h1')).rejects.toThrow('another identity')
      expect(sdk.listWebhooks).not.toHaveBeenCalled()
      expect(sdk.registerWebhook).not.toHaveBeenCalled()
      expect(sdk.unregisterWebhook).not.toHaveBeenCalled()
      sdk.listWebhooks.mockResolvedValue([])
      await expect(sparkWebhookSession('second', '03cd').list()).resolves.toEqual([])
    } finally {
      await connectSpark(MNEMONIC, 'primary')
    }
  })

  test('sparkConnectedIdentity reads the wallet id and its key from one connection', async () => {
    sdk.getInfo.mockResolvedValue({ identityPubkey: '02ab', balanceSats: 0n, tokenBalances: new Map() })
    await connectSpark(MNEMONIC, 'second')
    try {
      expect(await sparkConnectedIdentity()).toEqual({ walletId: 'second', pubkey: '02ab' })
    } finally {
      await connectSpark(MNEMONIC, 'primary')
    }
  })
})

describe('sparkReceive', () => {
  test('lightning builds a bolt11 invoice for the amount (sats -> bigint)', async () => {
    const quote = await sparkReceive('lightning', 1000, 'coffee')

    const arg = sdk.receivePayment.mock.calls[0][0]
    expect(arg.paymentMethod).toBeInstanceOf(ReceivePaymentMethod.Bolt11Invoice)
    // Named and unset, so the SDK makes the preimage and keeps the settlement it always had.
    expect(Object.keys(fieldsOf(arg.paymentMethod))).toContain('preimage')
    expect(fieldsOf(arg.paymentMethod).preimage).toBeUndefined()
    expect(fieldsOf(arg.paymentMethod).amountSats).toBe(1000n)
    expect(fieldsOf(arg.paymentMethod).description).toBe('coffee')
    expect(quote.destination).toBe('dest')
  })

  test('onchain asks for a bitcoin deposit address', async () => {
    await sparkReceive('onchain')
    expect(sdk.receivePayment.mock.calls[0][0].paymentMethod).toBeInstanceOf(
      ReceivePaymentMethod.BitcoinAddress,
    )
  })

  test('spark returns the static spark address', async () => {
    await sparkReceive('spark')
    expect(sdk.receivePayment.mock.calls[0][0].paymentMethod).toBeInstanceOf(
      ReceivePaymentMethod.SparkAddress,
    )
  })

  test('spark with an amount + token bills a Spark invoice in that token base units', async () => {
    await sparkReceive('spark', 1_500_000, 'coffee', USDB.identifier)

    const method = sdk.receivePayment.mock.calls[0][0].paymentMethod
    expect(method).toBeInstanceOf(ReceivePaymentMethod.SparkInvoice)
    expect(fieldsOf(method).amount).toBe(1_500_000n)
    expect(fieldsOf(method).tokenIdentifier).toBe(USDB.identifier)
    expect(fieldsOf(method).description).toBe('coffee')
  })

  test('a typed token amount is billed exactly, past what a double holds', async () => {
    await sparkReceive('spark', 1_000_000_000_000_000_001n, undefined, 'btkn1eighteen')

    const method = sdk.receivePayment.mock.calls[0][0].paymentMethod
    expect(method).toBeInstanceOf(ReceivePaymentMethod.SparkInvoice)
    expect(fieldsOf(method).amount).toBe(1_000_000_000_000_000_001n)
  })

  test('spark with an amount and no token bills the invoice in sats', async () => {
    await sparkReceive('spark', 2000)

    const method = sdk.receivePayment.mock.calls[0][0].paymentMethod
    expect(method).toBeInstanceOf(ReceivePaymentMethod.SparkInvoice)
    expect(fieldsOf(method).amount).toBe(2000n)
    expect(fieldsOf(method).tokenIdentifier).toBeUndefined() // absent = Bitcoin
  })

  test('an empty description on a spark invoice is sent as undefined, not as ""', async () => {
    await sparkReceive('spark', 2000, '')
    expect(fieldsOf(sdk.receivePayment.mock.calls[0][0].paymentMethod).description).toBeUndefined()
  })

  test('a zero amount stays on the static address (there is nothing to bill)', async () => {
    // One static address receives BTC and every token, so an amountless token receive specializes nothing.
    await sparkReceive('spark', 0, undefined, USDB.identifier)
    expect(sdk.receivePayment.mock.calls[0][0].paymentMethod).toBeInstanceOf(
      ReceivePaymentMethod.SparkAddress,
    )
  })

  test('receive fee is converted from the binding bigint', async () => {
    sdk.receivePayment.mockResolvedValue({ paymentRequest: 'dest', fee: 7n })
    expect((await sparkReceive('lightning', 1000)).feeSat).toBe(7)
  })
})

// What the binding throws for a failed parse: the message is only the class name, and the SDK's
// sentence rides in inner.
describe('a parse that fails', () => {
  const invalidInput = (words: string): Error =>
    Object.assign(new Error('SdkError.InvalidInput'), { tag: 'InvalidInput', inner: [words] })
  const SILENT = [
    'Lnurl error: error calling lnurl endpoint: Request error: error sending request for url (https://x.io/l)',
    'Lnurl error: error calling lnurl endpoint: Timeout error: operation timed out',
    'Lnurl error: error calling lnurl endpoint: Connect error: tcp connect error',
    'Lnurl error: error calling lnurl endpoint: Body error: connection closed before message completed',
    'Lnurl error: error calling lnurl endpoint: Other error: unexpected',
  ]
  const SPOKEN = [
    'invalid input',
    'Lnurl error: endpoint error: no such link',
    'Lnurl error: error calling lnurl endpoint: Json error: expected value at line 1',
    'Lnurl error: error calling lnurl endpoint: Status error: 404 - not found',
  ]

  test.each(SILENT)('of a server that stayed silent is unread: %s', async words => {
    sdk.parse.mockRejectedValue(invalidInput(words))

    expect(await sparkClassify('lnurl1x')).toBe('unread')
    expect(await sparkInspectDestination('lnurl1x')).toEqual({ kind: 'unread' })
  })

  test.each(SPOKEN)('with an answer in it says so: %s', async words => {
    sdk.parse.mockRejectedValue(invalidInput(words))

    expect(await sparkClassify('lnurl1x')).toBe('other')
    expect(await sparkInspectDestination('lnurl1x')).toEqual({ kind: 'other' })
  })

  test('with its words only in the message is not read as an answer of the network', async () => {
    sdk.parse.mockRejectedValue(new Error('error calling lnurl endpoint: Request error'))

    expect(await sparkClassify('lnurl1x')).toBe('other')
  })
})

describe('sparkClassify', () => {
  test('maps the spark-recognized destinations', async () => {
    sdk.parse.mockResolvedValue({ tag: 'BitcoinAddress' })
    expect(await sparkClassify('bc1...')).toBe('bitcoinAddress')
    sdk.parse.mockResolvedValue({ tag: 'SparkAddress' })
    expect(await sparkClassify('sp1...')).toBe('sparkAddress')
    sdk.parse.mockResolvedValue({ tag: 'Bolt11Invoice' })
    expect(await sparkClassify('lnbc...')).toBe('bolt11')
    sdk.parse.mockResolvedValue({ tag: 'LnurlWithdraw' })
    expect(await sparkClassify('lnurl1wd')).toBe('lnurlWithdraw')
  })

  test('returns other when the spark parser rejects the input (routes to Liquid)', async () => {
    sdk.parse.mockRejectedValue(new Error('unrecognized'))
    expect(await sparkClassify('lq1...')).toBe('other')
  })
})

// The SDK answers Bip21 for any text with the bitcoin: prefix, an address alone included
// (common/src/input/parser/mod.rs, parse_core and parse_bip_21), with each leg a parsed InputType.
describe('sparkClassify of a bitcoin: URI', () => {
  const TSP1 =
    'tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh'
  const address = { tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr', network: BitcoinNetwork.Bitcoin }] }
  const spark = { tag: 'SparkAddress', inner: [{ address: 'spark1x' }] }
  const bolt11 = (expiry: bigint) => ({
    tag: 'Bolt11Invoice',
    inner: [{ invoice: { bolt11: 'lnbc1inv' }, timestamp: 0n, expiry }],
  })
  const foreignSilent = { tag: 'SilentPaymentAddress', inner: [{ address: TSP1, network: BitcoinNetwork.Testnet3 }] }
  const bip21 = (uri: string, ...paymentMethods: unknown[]) => ({
    tag: 'Bip21',
    inner: [{ amountSat: undefined, uri, paymentMethods, extras: [] }],
  })

  test.each([
    ['an address alone', bip21('bitcoin:bc1qaddr', address), 'bitcoinAddress'],
    ['an address and a Spark address', bip21('bitcoin:bc1qaddr?spark=spark1x', address, spark), 'sparkAddress'],
    ['an address and a live invoice', bip21('bitcoin:bc1qaddr?lightning=lnbc1inv', address, bolt11(99_999_999_999n)), 'bolt11'],
    ['an expired invoice and an address', bip21('bitcoin:bc1qaddr?lightning=lnbc1inv', bolt11(3600n), address), 'bitcoinAddress'],
    ['a silent payment address of another network alone', bip21(`bitcoin:?sp=${TSP1}`, foreignSilent), 'wrongNetwork'],
    ['an expired invoice alone', bip21('bitcoin:?lightning=lnbc1inv', bolt11(3600n)), 'other'],
  ])('with %s is the leg Send pays', async (_name, parsed, kind) => {
    sdk.parse.mockResolvedValue(parsed)
    const uri = (parsed.inner[0] as { uri: string }).uri

    expect(await sparkClassify(uri)).toBe(kind)
    expect((await sparkInspectDestination(uri)).kind).toBe(kind)
  })
})

// Vectors the real parser reads: the one in crates/spark/src/silent_payment.rs, the same keys encoded
// for testnet, and the first with its last character changed. The script that made them checked the
// checksum of each, and the third fails it.
describe('a silent payment address', () => {
  const SP1 =
    'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv'
  const TSP1 =
    'tsp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc3wk4yh'
  const BAD_CHECKSUM =
    'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwq'
  const silent = (address: string, network: BitcoinNetwork) => ({
    tag: 'SilentPaymentAddress',
    inner: [{ address, network, source: {} }],
  })
  const bip21 = (uri: string, ...paymentMethods: unknown[]) => ({
    tag: 'Bip21',
    inner: [{ amountSat: 5000n, uri, paymentMethods, extras: [] }],
  })
  const fallback = { tag: 'BitcoinAddress', inner: [{ address: 'bc1qfallback', network: BitcoinNetwork.Bitcoin }] }

  test('classifies as its own kind, which neither a refund nor an exit takes', async () => {
    sdk.parse.mockResolvedValue(silent(SP1, BitcoinNetwork.Bitcoin))

    expect(await sparkClassify(SP1)).toBe('silentPaymentAddress')
    expect(await sparkRefundAddress(SP1)).toBeNull()
  })

  test('resolves to the form the SDK gives, since a QR code carries it in capitals', async () => {
    sdk.parse.mockResolvedValue(silent(SP1, BitcoinNetwork.Bitcoin))

    expect(await sparkInspectDestination(SP1.toUpperCase())).toEqual({
      kind: 'silentPaymentAddress',
      resolved: SP1,
    })
  })

  test.each([
    ['testnet', BitcoinNetwork.Testnet3],
    ['signet', BitcoinNetwork.Signet],
    ['regtest', BitcoinNetwork.Regtest],
  ])('a %s address is refused on mainnet, read whole rather than unread', async (_name, network) => {
    sdk.parse.mockResolvedValue(silent(TSP1, network))

    expect(await sparkClassify(TSP1)).toBe('wrongNetwork')
    expect(await sparkInspectDestination(TSP1)).toEqual({ kind: 'wrongNetwork' })
  })

  test('a bad checksum is what any text the SDK cannot read is', async () => {
    sdk.parse.mockRejectedValue(
      Object.assign(new Error('SdkError.InvalidInput'), { tag: 'InvalidInput', inner: ['Invalid input'] }),
    )

    expect(await sparkClassify(BAD_CHECKSUM)).toBe('other')
    expect(await sparkInspectDestination(BAD_CHECKSUM)).toEqual({ kind: 'other' })
  })

  test('a URI that names one pays it, with its amount, ahead of the fallback address', async () => {
    sdk.parse.mockResolvedValue(bip21(`bitcoin:bc1qfallback?sp=${SP1}`, fallback, silent(SP1, BitcoinNetwork.Bitcoin)))

    expect(await sparkInspectDestination(`bitcoin:bc1qfallback?sp=${SP1}`)).toEqual({
      kind: 'silentPaymentAddress',
      resolved: SP1,
      requestedAmount: 5000,
    })
  })

  test('a URI whose invoice ran out pays it as the on-chain leg it is, saying the invoice expired', async () => {
    const expired = { tag: 'Bolt11Invoice', inner: [{ invoice: { bolt11: 'lnbc1old' }, timestamp: 1000n, expiry: 3600n }] }
    const uri = `bitcoin:?sp=${SP1}&lightning=lnbc1old`
    sdk.parse.mockResolvedValue(bip21(uri, silent(SP1, BitcoinNetwork.Bitcoin), expired))

    expect(await sparkInspectDestination(uri)).toEqual({
      kind: 'silentPaymentAddress',
      resolved: SP1,
      requestedAmount: 5000,
      expiredInvoice: true,
    })
  })

  // The refund pays the fallback only by ignoring the leg the URI asks for first, so it is refused.
  test('a URI that names one is no refund address, even with a fallback beside it', async () => {
    sdk.parse.mockResolvedValue(bip21(`bitcoin:bc1qfallback?sp=${SP1}`, fallback, silent(SP1, BitcoinNetwork.Bitcoin)))

    expect(await sparkRefundAddress(`bitcoin:bc1qfallback?sp=${SP1}`)).toBeNull()
  })

  test('a URI with one for another network takes its fallback, or is refused with none', async () => {
    const foreign = silent(TSP1, BitcoinNetwork.Testnet3)
    sdk.parse.mockResolvedValueOnce(bip21('bitcoin:bc1qfallback', fallback, foreign))
    expect(await sparkInspectDestination('bitcoin:bc1qfallback')).toMatchObject({
      kind: 'bitcoinAddress',
      resolved: 'bc1qfallback',
    })

    sdk.parse.mockResolvedValueOnce(bip21(`bitcoin:?sp=${TSP1}`, foreign))
    expect(await sparkInspectDestination(`bitcoin:?sp=${TSP1}`)).toEqual({ kind: 'wrongNetwork' })
  })

  // The SDK answers a BitcoinAddress method for it (sdk/payments/prepare/mod.rs), so the quote and the
  // send read as they do for any on-chain address.
  test('prepares and confirms as a withdrawal at the chosen speed', async () => {
    const tier = (speed: number) => ({ userFeeSat: 750n + BigInt(speed), l1BroadcastFeeSat: 200n })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: {
        tag: 'BitcoinAddress',
        inner: {
          address: { address: SP1, network: BitcoinNetwork.Bitcoin },
          feeQuote: { speedFast: tier(2), speedMedium: tier(1), speedSlow: tier(0), isEstimate: false },
        },
      },
      amount: 20_000n,
    })

    const quote = await sparkPrepareSend(SP1, 20_000)

    expect(sdk.prepareSendPayment.mock.calls[0][0].paymentRequest).toBeInstanceOf(PaymentRequest.Input)
    expect(quote.amount).toBe(20_000)
    expect(quote.onchainFees?.medium).toEqual({ minerSat: 200, sparkSat: 751, totalSat: 951 })

    await sparkConfirmSend(quote.handle, 'fast')

    const { options } = sdk.sendPayment.mock.calls[0][0]
    expect(options).toBeInstanceOf(SendPaymentOptions.BitcoinAddress)
  })
})

describe('sparkInspectDestination', () => {
  test('a plain destination carries no token, amount or routes (and is trimmed)', async () => {
    sdk.parse.mockResolvedValue({ tag: 'Bolt11Invoice' })

    expect(await sparkInspectDestination('  lnbc1invoice  ')).toEqual({ kind: 'bolt11' })
    expect(sdk.parse).toHaveBeenCalledWith('lnbc1invoice')
  })

  // Expiry far in the future so the validity check never flakes against wall-clock time.
  const liveBolt11 = (bolt11: string) => ({
    tag: 'Bolt11Invoice',
    inner: [{ invoice: { bolt11 }, timestamp: 0n, expiry: 99_999_999_999n }],
  })

  test('a unified BIP21 prefers the Spark leg (free, instant) over Lightning and on-chain', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri: 'bitcoin:bc1qaddr?amount=0.00005&lightning=lnbc1inv&spark=sp1x',
          amountSat: 5_000n,
          // The SDK leaves extras empty for unknown params, so the spark= param has to be read from uri.
          extras: [],
          paymentMethods: [
            { tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr' }] },
            liveBolt11('lnbc1inv'),
          ],
        },
      ],
    })

    // A bare Spark address embeds no amount, so the BIP21 amount rides along.
    expect(
      await sparkInspectDestination('bitcoin:bc1qaddr?amount=0.00005&lightning=lnbc1inv&spark=sp1x'),
    ).toEqual({ kind: 'sparkAddress', resolved: 'sp1x', requestedAmount: 5_000 })
  })

  test('an all-caps unified QR still takes its Spark leg, in lower case', async () => {
    const uri = 'BITCOIN:BC1QADDR?AMOUNT=0.00005&LIGHTNING=LNBC1INV&SPARK=SPARK1ABC'
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri,
          amountSat: 5_000n,
          extras: [],
          paymentMethods: [{ tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr' }] }, liveBolt11('lnbc1inv')],
        },
      ],
    })

    expect(await sparkInspectDestination(uri)).toEqual({
      kind: 'sparkAddress',
      resolved: 'spark1abc',
      requestedAmount: 5_000,
    })
  })

  test('a unified BIP21 without a Spark leg resolves to its Lightning invoice', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri: 'bitcoin:bc1qaddr?lightning=lnbc1inv',
          amountSat: undefined,
          extras: [],
          paymentMethods: [{ tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr' }] }, liveBolt11('lnbc1inv')],
        },
      ],
    })

    expect(await sparkInspectDestination('bitcoin:bc1qaddr?lightning=lnbc1inv')).toEqual({
      kind: 'bolt11',
      resolved: 'lnbc1inv',
    })
  })

  test('an EXPIRED bolt11 in a unified BIP21 gives way to the on-chain leg, which says so', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri: 'bitcoin:bc1qaddr?amount=0.001&lightning=lnbcexpired',
          amountSat: 100_000n,
          extras: [],
          paymentMethods: [
            { tag: 'Bolt11Invoice', inner: [{ invoice: { bolt11: 'lnbcexpired' }, timestamp: 1000n, expiry: 3600n }] },
            { tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr' }] },
          ],
        },
      ],
    })

    expect(
      await sparkInspectDestination('bitcoin:bc1qaddr?amount=0.001&lightning=lnbcexpired'),
    ).toEqual({ kind: 'bitcoinAddress', resolved: 'bc1qaddr', requestedAmount: 100_000, expiredInvoice: true })
  })

  test('a BIP21 with no Lightning leg falls back to on-chain AND carries the requested amount', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri: 'bitcoin:bc1qaddr?amount=0.001',
          amountSat: 100_000n,
          extras: [],
          paymentMethods: [{ tag: 'BitcoinAddress', inner: [{ address: 'bc1qaddr' }] }],
        },
      ],
    })

    // The amount lives only at Bip21Details.amountSat, since a bare address embeds none.
    expect(await sparkInspectDestination('bitcoin:bc1qaddr?amount=0.001')).toEqual({
      kind: 'bitcoinAddress',
      resolved: 'bc1qaddr',
      requestedAmount: 100_000,
    })
  })

  test('a BIP21 with neither a payable leg nor a Spark param is "other"', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [{ uri: 'bitcoin:?label=x', amountSat: undefined, extras: [], paymentMethods: [] }],
    })
    await expect(sparkInspectDestination('bitcoin:?label=x')).resolves.toEqual({ kind: 'other' })
  })

  test('a BIP353 name (₿user@domain) reaches parse with the ₿ intact and resolves via its BIP21', async () => {
    // Stripping the ₿ turns a BIP353 DNS lookup into a bare LNURL address, a different resolution.
    sdk.parse.mockResolvedValue({
      tag: 'Bip21',
      inner: [
        {
          uri: 'bitcoin:bc1qaddr?lightning=lnbc1inv',
          amountSat: undefined,
          extras: [],
          paymentMethods: [liveBolt11('lnbc1inv')],
        },
      ],
    })

    expect(await sparkInspectDestination('  ₿alice@voltz.app  ')).toEqual({
      kind: 'bolt11',
      resolved: 'lnbc1inv',
    })
    expect(sdk.parse).toHaveBeenCalledWith('₿alice@voltz.app')
  })

  // At 0.26.0 the SDK resolves a BIP353 name itself (the DNS TXT record at
  // <user>.user._bitcoin-payment.<domain>) and answers the record's BIP21, each payment method carrying
  // the name it came from in `source.bip353Address` (PaymentRequestSource). Whatever the record holds is
  // read as any BIP21 is.
  describe('a BIP353 record', () => {
    const fromName = (uri: string, paymentMethods: unknown[]) => ({
      tag: 'Bip21',
      inner: [{ uri, amountSat: undefined, assetId: undefined, extras: [], label: undefined, message: undefined, paymentMethods }],
    })
    const source = (bip21Uri: string) => ({ bip21Uri, bip353Address: 'alice@voltz.app' })

    test('carrying a Spark address resolves to it', async () => {
      const uri = 'bitcoin:?spark=spark1alice'
      sdk.parse.mockResolvedValue(fromName(uri, []))

      expect(await sparkInspectDestination('₿alice@voltz.app')).toEqual({
        kind: 'sparkAddress',
        resolved: 'spark1alice',
        requestedAmount: undefined,
      })
    })

    test('carrying only an on-chain address resolves to it', async () => {
      const uri = 'bitcoin:bc1qalice'
      sdk.parse.mockResolvedValue(
        fromName(uri, [{ tag: 'BitcoinAddress', inner: [{ address: 'bc1qalice', source: source(uri) }] }]),
      )

      expect(await sparkInspectDestination('₿alice@voltz.app')).toEqual({
        kind: 'bitcoinAddress',
        resolved: 'bc1qalice',
        requestedAmount: undefined,
      })
    })

    // SendPaymentMethod has no BOLT12 variant at 0.26.0, so an offer is not payable and nothing on
    // screen may offer to pay it.
    test('carrying only a BOLT12 offer is not payable', async () => {
      const uri = 'bitcoin:?lno=lno1alice'
      sdk.parse.mockResolvedValue(
        fromName(uri, [{ tag: 'Bolt12Offer', inner: [{ offer: { offer: 'lno1alice', source: source(uri) } }] }]),
      )

      expect(await sparkInspectDestination('₿alice@voltz.app')).toEqual({ kind: 'other' })
    })
  })

  test('a ₿name that resolves to a lightning address takes the LNURL-pay kind', async () => {
    // A ₿name can surface as a LUD-16 address, which is payable too, so it must not collapse to "other".
    sdk.parse.mockResolvedValue({ tag: 'LightningAddress' })

    expect(await sparkInspectDestination('₿bob@voltz.app')).toEqual({ kind: 'lightningAddress' })
    expect(sdk.parse).toHaveBeenCalledWith('₿bob@voltz.app')
  })

  test('an input the parser rejects is "other", never a thrown error', async () => {
    // The send screen calls this on every keystroke and scan, where a throw surfaces as a crash.
    sdk.parse.mockRejectedValue(new Error('unrecognized'))
    await expect(sparkInspectDestination('lq1notspark')).resolves.toEqual({ kind: 'other' })
  })

  test('a spark invoice reports the token it bills in and the amount it embeds', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'SparkInvoice',
      inner: [
        { invoice: 'spark1inv', tokenIdentifier: USDB.identifier, amount: 10_000_000n, description: 'x' },
      ],
    })

    const info = await sparkInspectDestination('spark1inv')

    expect(info.kind).toBe('sparkAddress')
    expect(info.tokenIdentifier).toBe(USDB.identifier)
    expect(info.amount).toBe(10_000_000) // base units of the token, not sats
  })

  test('an amountless BTC spark invoice reports neither token nor amount', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'SparkInvoice',
      inner: [{ invoice: 'spark1inv', tokenIdentifier: undefined, amount: undefined }],
    })

    const info = await sparkInspectDestination('spark1inv')

    expect(info.kind).toBe('sparkAddress')
    expect(info.tokenIdentifier).toBeUndefined()
    expect(info.amount).toBeUndefined()
  })

  test('an embedded amount of zero stays 0 (it is an amount, not "absent")', async () => {
    sdk.parse.mockResolvedValue({
      tag: 'SparkInvoice',
      inner: [{ invoice: 'spark1inv', tokenIdentifier: undefined, amount: 0n }],
    })
    expect((await sparkInspectDestination('spark1inv')).amount).toBe(0)
  })

  // A live pair lists the Spark assets it accepts, each with its own bounds: a sats floor when funded
  // with BTC, none when funded with USDB. Boltz publishes no bounds at all.
  const btcLimits = { minAmount: 1200n, maxAmount: undefined, minUsdCents: 80n, maxUsdCents: 8_980_000n }
  const orchestraPair = {
    provider: 0,
    chain: 'tron',
    asset: 'USDT',
    decimals: 6,
    chainId: undefined,
    acceptedAssets: [
      { asset: { tag: 'Token', inner: { tokenIdentifier: 'btkn1usdb' } }, limits: { minAmount: 5n } },
      { asset: { tag: 'Bitcoin' }, limits: btcLimits },
    ],
  }
  const boltzPair = {
    provider: 1,
    chain: 'arbitrum',
    asset: 'USDT',
    decimals: 6,
    chainId: '42161',
    acceptedAssets: [{ asset: { tag: 'Bitcoin' }, limits: undefined }],
  }

  // The app funds a cross-chain send with sats, so only the Bitcoin entry's bounds apply.
  test('a route carries the bounds of the Bitcoin entry, and none when it publishes none', async () => {
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: 'TAddr' }] })
    sdk.getCrossChainRoutes.mockResolvedValue([
      orchestraPair,
      boltzPair,
      { ...boltzPair, chain: 'bsc', acceptedAssets: [orchestraPair.acceptedAssets[0]] },
    ])

    const [tron, arbitrum, tokenOnly] = (await sparkInspectDestination('TAddr')).routes ?? []

    expect(tron).toMatchObject({ minSat: 1200, maxSat: undefined, minUsdCents: 80, maxUsdCents: 8_980_000 })
    for (const route of [arbitrum, tokenOnly]) {
      expect(route).toMatchObject({ minSat: undefined, maxSat: undefined, minUsdCents: undefined })
    }
  })

  test('a cross-chain address returns the routes, provider enum decoded', async () => {
    const details = { address: '0xdeadbeef', addressFamily: 0 }
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [details] })
    sdk.getCrossChainRoutes.mockResolvedValue([
      { ...orchestraPair, chain: 'base', asset: 'USDC', chainId: '8453' },
      { ...boltzPair, chain: 'solana', asset: 'USDT' },
    ])

    const info = await sparkInspectDestination('0xdeadbeef')

    expect(info.kind).toBe('crossChainAddress')
    // CrossChainProvider is a numeric enum (Orchestra = 0, Boltz = 1) and the screen shows a name.
    expect(info.routes).toMatchObject([
      { id: expect.any(String), chain: 'base', asset: 'USDC', decimals: 6, provider: 'orchestra' },
      { id: expect.any(String), chain: 'solana', asset: 'USDT', decimals: 6, provider: 'boltz' },
    ])
    expect(info.routes).toHaveLength(2)
    const routes = info.routes ?? []
    expect(routes[0].id).not.toBe(routes[1].id)
    const filter = sdk.getCrossChainRoutes.mock.calls[0][0]
    expect(filter).toBeInstanceOf(CrossChainRouteFilter.Send)
    // Strict, so a delivery method set to anything stops listing the routes the Spark balance pays.
    expect(fieldsOf(filter)).toStrictEqual({ addressDetails: details, deliveryMethod: undefined })
  })

  test('an address whose routes cannot be fetched is still cross-chain, with none', async () => {
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: '0xdeadbeef' }] })
    sdk.getCrossChainRoutes.mockRejectedValue(new Error('provider unreachable'))

    const info = await sparkInspectDestination('0xdeadbeef')

    expect(info.kind).toBe('crossChainAddress')
    expect(info.routes).toEqual([])
  })
})

describe('sparkPrepareCrossChainSend', () => {
  const pair = {
    provider: 1,
    chain: 'solana',
    asset: 'USDC',
    decimals: 6,
    chainId: undefined,
    acceptedAssets: [{ asset: { tag: 'Bitcoin' }, limits: undefined }],
  }

  // Routes only exist after the address was inspected, which is what registers them for prepare.
  const inspectRoute = async () => {
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: 'SoLaNaAddr' }] })
    sdk.getCrossChainRoutes.mockResolvedValue([pair])
    const info = await sparkInspectDestination('SoLaNaAddr')
    return (info.routes ?? [])[0]
  }

  test('rejects a route id that was never resolved', async () => {
    await expect(sparkPrepareCrossChainSend('solana|USDC|nope', 50_000, 'sats')).rejects.toThrow(
      'cross-chain route not found',
    )
  })

  test('quotes over the inspected address + route and keeps the two units apart', async () => {
    const route = await inspectRoute()
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: {
        tag: 'CrossChainAddress',
        inner: {
          amountIn: 50_000n,
          sourceTransferFeeSats: 120n,
          estimatedOut: 24_800_000n,
          feeAmount: 200_000n,
          expiresAt: '2026-08-05T12:00:00Z',
        },
      },
      amount: 50_000n,
    })

    const quote = await sparkPrepareCrossChainSend(route.id, 50_000, 'sats')

    const req = sdk.prepareSendPayment.mock.calls[0][0]
    expect(req.paymentRequest).toBeInstanceOf(PaymentRequest.CrossChain)
    expect(fieldsOf(req.paymentRequest).address).toBe('SoLaNaAddr')
    expect(fieldsOf(req.paymentRequest).route).toBe(pair) // the SDK's own pair, not the mapped copy
    expect(req.amount).toBe(50_000n)
    expect(req.tokenIdentifier).toBeUndefined() // the wallet pays sats, the token is on the far side
    // 50_000 and 120 are sats leaving, 24_800_000 and 200_000 are USDC base units arriving.
    expect(quote).toMatchObject({
      amountIn: 50_000,
      source: 'sats',
      feeSat: 120,
      estimatedOut: 24_800_000,
      feeAmount: 200_000,
      chain: 'solana',
      asset: 'USDC',
      decimals: 6,
      expiresAt: '2026-08-05T12:00:00Z',
    })
  })

  test('the route and the quote carry the provider and the contract, and an empty contract is none', async () => {
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: 'TAddr' }] })
    sdk.getCrossChainRoutes.mockResolvedValue([
      { ...pair, provider: 0, chain: 'tron', asset: 'USDT', contractAddress: 'TContract' },
      { ...pair, provider: 0, chain: 'solana', contractAddress: '' },
    ])
    const [tron, native] = (await sparkInspectDestination('TAddr')).routes ?? []
    sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { tag: 'CrossChainAddress', inner: {} }, amount: 1n })

    expect(tron.contractAddress).toBe('TContract')
    expect(native.contractAddress).toBeUndefined()
    await expect(sparkPrepareCrossChainSend(tron.id, 1, 'sats')).resolves.toMatchObject({
      provider: 'orchestra',
      contractAddress: 'TContract',
    })
    await expect(sparkPrepareCrossChainSend(native.id, 1, 'sats')).resolves.toMatchObject({ contractAddress: undefined })
  })

  test('two contracts of one asset on one chain are two routes, each paying its own', async () => {
    sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: '0xPayee' }] })
    const first = { ...pair, provider: 0, chain: 'base', asset: 'USDC', contractAddress: '0xAAA' }
    const second = { ...first, contractAddress: '0xBBB' }
    sdk.getCrossChainRoutes.mockResolvedValue([first, second])
    const [a, b] = (await sparkInspectDestination('0xPayee')).routes ?? []
    sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { tag: 'CrossChainAddress', inner: {} }, amount: 1n })

    expect(a.id).not.toBe(b.id)
    await expect(sparkPrepareCrossChainSend(a.id, 1, 'sats')).resolves.toMatchObject({ contractAddress: '0xAAA' })
    await expect(sparkPrepareCrossChainSend(b.id, 1, 'sats')).resolves.toMatchObject({ contractAddress: '0xBBB' })
    expect(fieldsOf(sdk.prepareSendPayment.mock.calls[1][0].paymentRequest).route).toBe(second)
  })

  test('a discarded quote can no longer be sent', async () => {
    const route = await inspectRoute()
    sdk.prepareSendPayment.mockResolvedValue({ paymentMethod: { tag: 'CrossChainAddress', inner: {} }, amount: 1n })
    const { handle } = await sparkPrepareCrossChainSend(route.id, 1, 'sats')

    sparkDiscardSendQuote(handle)

    await expect(sparkConfirmSend(handle)).rejects.toThrow('spark send not prepared')
    expect(sdk.sendPayment).not.toHaveBeenCalled()
  })

  describe('a USDB source', () => {
    const USDB_ASSET = { asset: { tag: SparkAsset_Tags.Token, inner: { tokenIdentifier: USDB.identifier } }, limits: undefined }
    const LOOKALIKE = { asset: { tag: SparkAsset_Tags.Token, inner: { tokenIdentifier: 'btkn1fake', ticker: 'USDB' } }, limits: undefined }
    const quoted = (over: object = {}) => ({
      paymentMethod: {
        tag: 'CrossChainAddress',
        inner: {
          amountIn: 10_020_000n,
          sourceTransferFeeSats: 0n,
          estimatedOut: 10_000_000_000_000_000_000n,
          feeAmount: 20_000_000_000_000_000n,
          expiresAt: '2026-11-05T12:00:00Z',
          ...over,
        },
      },
      amount: 10_000_000n,
    })
    const routeFor = async (route: object) => {
      sdk.parse.mockResolvedValue({ tag: 'CrossChainAddress', inner: [{ address: '0xabc' }] })
      sdk.getCrossChainRoutes.mockResolvedValue([{ ...pair, decimals: 18, chain: 'bsc', ...route }])
      return ((await sparkInspectDestination('0xabc')).routes ?? [])[0]
    }

    test('goes in as USDB on a route that lists it, and comes back in USDB', async () => {
      const route = await routeFor({ acceptedAssets: [...pair.acceptedAssets, USDB_ASSET] })
      sdk.prepareSendPayment.mockResolvedValue(quoted())

      const quote = await sparkPrepareCrossChainSend(route.id, 10_000_000, 'usdb')

      const req = sdk.prepareSendPayment.mock.calls[0][0]
      expect(req.amount).toBe(10_000_000n)
      expect(req.tokenIdentifier).toBe(USDB.identifier)
      expect(quote).toMatchObject({ source: 'usdb', amountIn: 10_020_000, routeId: route.id })
    })

    // In that path the SDK takes `amount` in the route's 18 decimals, 12 orders of magnitude off.
    test('never reaches the SDK on a route that takes only sats', async () => {
      const route = await routeFor({})

      await expect(sparkPrepareCrossChainSend(route.id, 10_000_000, 'usdb')).rejects.toThrow('does not take USDB')

      expect(route.accepts).toEqual({ btc: true, usdb: false })
      expect(sdk.prepareSendPayment).not.toHaveBeenCalled()
    })

    test('a sats source on an 18-decimal route carries sats and no token', async () => {
      const route = await routeFor({ acceptedAssets: [...pair.acceptedAssets, USDB_ASSET] })
      sdk.prepareSendPayment.mockResolvedValue(quoted({ amountIn: 40_000n }))

      const quote = await sparkPrepareCrossChainSend(route.id, 40_000, 'sats')

      const req = sdk.prepareSendPayment.mock.calls[0][0]
      expect(req.amount).toBe(40_000n)
      expect(req.tokenIdentifier).toBeUndefined()
      expect(quote).toMatchObject({ source: 'sats', amountIn: 40_000 })
    })

    test('a token called USDB is not USDB', async () => {
      const route = await routeFor({ acceptedAssets: [...pair.acceptedAssets, LOOKALIKE] })

      expect(route.accepts.usdb).toBe(false)
      await expect(sparkPrepareCrossChainSend(route.id, 10_000_000, 'usdb')).rejects.toThrow('does not take USDB')
    })

    test('the conversion the SDK adds on its own reaches the quote, with amountIn in sats', async () => {
      const route = await routeFor({})
      sdk.prepareSendPayment.mockResolvedValue({
        ...quoted({ amountIn: 12_000n }),
        conversionEstimate: {
          options: {
            conversionType: {
              tag: ConversionType_Tags.ToBitcoin,
              inner: { fromTokenIdentifier: USDB.identifier },
            },
          },
          amountIn: 12_400_000n,
          amountOut: 12_100n,
          fee: 9_000n,
        },
      })

      const quote = await sparkPrepareCrossChainSend(route.id, 12_000, 'sats')

      expect(quote).toMatchObject({
        source: 'sats',
        amountIn: 12_000,
        conversion: { tokenIdentifier: USDB.identifier, amountIn: 12_400_000, amountOut: 12_100 },
      })
    })

    test('the route carries the bounds of USDB, apart from the ones of sats', async () => {
      const route = await routeFor({
        acceptedAssets: [
          { asset: { tag: SparkAsset_Tags.Bitcoin }, limits: { minAmount: 1_200n, maxAmount: 900_000n } },
          {
            ...USDB_ASSET,
            limits: { minAmount: 1_000_000n, maxAmount: 5_000_000_000n, minUsdCents: 200n, maxUsdCents: 300_000n },
          },
        ],
      })

      expect(route).toMatchObject({ minSat: 1_200, maxSat: 900_000, usdbMin: 2, usdbMax: 3_000 })
    })

    // A double holds about 15 digits, so an 18-decimal figure is off past the sixth place shown.
    test('ten dollars on 18 decimals reads ten at the six places shown', async () => {
      const route = await routeFor({ acceptedAssets: [...pair.acceptedAssets, USDB_ASSET] })
      sdk.prepareSendPayment.mockResolvedValue(quoted({ estimatedOut: 10_000_000_000_000_000_123n }))

      const { estimatedOut } = await sparkPrepareCrossChainSend(route.id, 10_000_000, 'usdb')

      expect(estimatedOut).toBeGreaterThan(Number.MAX_SAFE_INTEGER)
      expect(fromBaseUnits(estimatedOut, 18, 6)).toBe('10')
    })
  })

  test('the handle confirms through the same send path as any other send', async () => {
    const route = await inspectRoute()
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: {
        tag: 'CrossChainAddress',
        inner: {
          amountIn: 50_000n,
          sourceTransferFeeSats: 120n,
          estimatedOut: 24_800_000n,
          feeAmount: 200_000n,
          expiresAt: '2026-08-05T12:00:00Z',
        },
      },
      amount: 50_000n,
    })
    sdk.sendPayment.mockResolvedValue({ payment: { status: 0 } })

    const quote = await sparkPrepareCrossChainSend(route.id, 50_000, 'sats')

    expect(await sparkConfirmSend(quote.handle)).toBe('complete')
    expect(sdk.sendPayment).toHaveBeenCalledTimes(1)
  })
})

describe('stable balance switch', () => {
  test('is off while the SDK reports no active label', async () => {
    sdk.getUserSettings.mockResolvedValue({
      sparkPrivateModeEnabled: false,
      stableBalanceActiveLabel: undefined,
    })
    expect(await sparkGetStableBalance()).toBe(false)
  })

  test('is on once a label is active', async () => {
    sdk.getUserSettings.mockResolvedValue({
      sparkPrivateModeEnabled: false,
      stableBalanceActiveLabel: new StableBalanceActiveLabel.Set({ label: STABLE_BALANCE_LABEL }),
    })
    expect(await sparkGetStableBalance()).toBe(true)
  })

  test('turning it on activates the label declared at connect', async () => {
    await sparkSetStableBalance(true)

    const req = sdk.updateUserSettings.mock.calls[0][0]
    expect(req.stableBalanceActiveLabel).toBeInstanceOf(StableBalanceActiveLabel.Set)
    // Must be the same label buildConfig registered the token under, or nothing gets activated.
    expect(req.stableBalanceActiveLabel.inner.label).toBe(STABLE_BALANCE_LABEL)
    // The unrelated setting rides along in the same call and must stay untouched.
    expect(req.sparkPrivateModeEnabled).toBeUndefined()
  })

  test('the switch announces itself, since nothing else reports this change', async () => {
    // The accent, the wordmark and the tab bar follow the mode. Without this they stay on the old
    // one until a payment or a reconnect happens to come along.
    const seen: boolean[] = []
    const off = onStableBalanceChanged(on => seen.push(on))

    await sparkSetStableBalance(true)
    await sparkSetStableBalance(false)

    expect(seen).toEqual([true, false])
    off()
  })

  test('a removed listener stops hearing the switch', async () => {
    const seen: boolean[] = []
    onStableBalanceChanged(on => seen.push(on))()

    await sparkSetStableBalance(true)

    expect(seen).toEqual([])
  })

  test('turning it off unsets the label (converting the token balance back to BTC)', async () => {
    await sparkSetStableBalance(false)

    const req = sdk.updateUserSettings.mock.calls[0][0]
    expect(req.stableBalanceActiveLabel).toBeInstanceOf(StableBalanceActiveLabel.Unset)
    expect(req.stableBalanceActiveLabel).not.toBeInstanceOf(StableBalanceActiveLabel.Set)
  })
})

describe('sparkPrepareSend / sparkConfirmSend', () => {
  test('wraps the raw destination and reports the amount, and the two routes apart', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)

    const arg = sdk.prepareSendPayment.mock.calls[0][0]
    expect(arg.paymentRequest).toBeInstanceOf(PaymentRequest.Input)
    expect(fieldsOf(arg.paymentRequest).input).toBe('lnbc1...')
    expect(arg.amount).toBe(1000n)
    expect(quote.amount).toBe(1000)
    // One route runs, so the fees are alternatives and never add up.
    expect(quote.fee).toBe(3)
    expect(quote.sparkRouteFeeSat).toBe(2)
  })

  test('an invoice with no Spark route leaves the field out', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 3n, sparkTransferFeeSats: undefined } },
      amount: 1000n,
    })
    expect((await sparkPrepareSend('lnbc1...')).sparkRouteFeeSat).toBeUndefined()
  })

  test('a free Spark route is still a route', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'Bolt11Invoice', inner: { lightningFeeSats: 3n, sparkTransferFeeSats: 0n } },
      amount: 1000n,
    })
    expect((await sparkPrepareSend('lnbc1...')).sparkRouteFeeSat).toBe(0)
  })

  test('asks for the Spark route only when told to', async () => {
    const quiet = await sparkPrepareSend('lnbc1...')
    await sparkConfirmSend(quiet.handle)
    expect(sdk.sendPayment.mock.calls[0][0].options).toBeUndefined()

    const routed = await sparkPrepareSend('lnbc1...')
    await sparkConfirmSend(routed.handle, undefined, undefined, true)
    const { options } = sdk.sendPayment.mock.calls[1][0]
        expect(fieldsOf(options)).toEqual({ preferSpark: true, completionTimeoutSecs: undefined })
  })

  test('onchain send: no flat fee, but the tiered breakdown (miner + Spark) per speed', async () => {
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: {
        tag: 'BitcoinAddress',
        inner: {
          address: {},
          feeQuote: {
            speedFast: { l1BroadcastFeeSat: 1200n, userFeeSat: 930n },
            speedMedium: { l1BroadcastFeeSat: 780n, userFeeSat: 930n },
            speedSlow: { l1BroadcastFeeSat: 400n, userFeeSat: 930n },
            isEstimate: false,
          },
        },
      },
      amount: 5000n,
    })
    const quote = await sparkPrepareSend('bc1...', 5000)
    expect(quote.amount).toBe(5000)
    // There is no flat fee, only a per-speed split of the miner leg and the Spark operator leg.
    expect(quote.fee).toBeUndefined()
    expect(quote.onchainFees?.medium).toEqual({ minerSat: 780, sparkSat: 930, totalSat: 1710 })
    expect(quote.onchainFees?.fast).toEqual({ minerSat: 1200, sparkSat: 930, totalSat: 2130 })
    expect(quote.onchainFees?.estimate).toBe(false)
  })

  test('onchain send: a fee the SDK only estimated is marked, a quoted one is not', async () => {
    // Since 0.25 the quote carries isEstimate, set when the wallet holds no bitcoin and a token
    // conversion will fund the send: the provider will not quote a withdrawal with no leaves, so the
    // SDK estimates locally. The real send never pays more than the estimate for the chosen speed.
    const feeQuote = (isEstimate: boolean) => ({
      speedFast: { l1BroadcastFeeSat: 1200n, userFeeSat: 930n },
      speedMedium: { l1BroadcastFeeSat: 780n, userFeeSat: 930n },
      speedSlow: { l1BroadcastFeeSat: 400n, userFeeSat: 930n },
      isEstimate,
    })
    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'BitcoinAddress', inner: { address: {}, feeQuote: feeQuote(true) } },
      amount: 5000n,
    })
    expect((await sparkPrepareSend('bc1...', 5000)).onchainFees?.estimate).toBe(true)

    sdk.prepareSendPayment.mockResolvedValue({
      paymentMethod: { tag: 'BitcoinAddress', inner: { address: {}, feeQuote: feeQuote(false) } },
      amount: 5000n,
    })
    expect((await sparkPrepareSend('bc1...', 5000)).onchainFees?.estimate).toBe(false)
  })

  test('confirm executes the prepared send and maps the payment status', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    expect(await sparkConfirmSend(quote.handle)).toBe('complete')
    expect(sdk.sendPayment.mock.calls[0][0].prepareResponse).toBeDefined()

    sdk.sendPayment.mockResolvedValue({ payment: { status: 1 } })
    const pending = await sparkPrepareSend('lnbc1...', 1000)
    expect(await sparkConfirmSend(pending.handle)).toBe('pending')

    sdk.sendPayment.mockResolvedValue({ payment: { status: 2 } })
    const failed = await sparkPrepareSend('lnbc1...', 1000)
    expect(await sparkConfirmSend(failed.handle)).toBe('failed')
  })

  test('confirm rejects an unknown handle (prepare must precede confirm)', async () => {
    await expect(sparkConfirmSend('nope')).rejects.toThrow('spark send not prepared')
  })

  test('a confirmed handle cannot be replayed', async () => {
    const quote = await sparkPrepareSend('lnbc1...', 1000)
    await sparkConfirmSend(quote.handle)
    await expect(sparkConfirmSend(quote.handle)).rejects.toThrow('spark send not prepared')
  })
})

describe('sparkListHistory', () => {
  test('maps spark payments to the shared history model (direction/status/bigint -> number)', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        // PaymentType.Receive = 1, PaymentStatus.Completed = 0
        { id: 'p1', paymentType: 1, status: 0, amount: 5000n, fees: 3n, timestamp: 1_700_000_000n },
        // PaymentType.Send = 0, PaymentStatus.Pending = 1
        { id: 'p2', paymentType: 0, status: 1, amount: 2000n, fees: 1n, timestamp: 1_700_000_100n },
      ],
    })

    const items = await sparkListHistory()

    expect(items).toEqual([
      {
        id: 'p1',
        direction: 'received',
        status: 'complete',
        amountSat: 5000,
        feesSat: 3,
        timestamp: 1_700_000_000,
        asset: null,
      },
      {
        id: 'p2',
        direction: 'sent',
        status: 'pending',
        amountSat: 2000,
        feesSat: 1,
        timestamp: 1_700_000_100,
        asset: null,
      },
    ])
  })

  // Conversion sides as the SDK reports them, with `identifier` undefined for sats.
  const BTC_SIDE = { chain: 0, asset: { ticker: 'BTC', identifier: undefined, decimals: 0 }, amount: 60_557n, fee: 0n }
  const USDB_SIDE = {
    chain: 0,
    asset: { ticker: 'USDB', identifier: USDB.identifier, decimals: 6 },
    amount: 47_493_695n,
    fee: 0n,
  }
  const tokenPayment = (over: object) => ({
    details: {
      tag: 'Token',
      inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 } },
    },
    ...over,
  })

  test('turning the dollar wallet on reads as converted, not received', async () => {
    // Reading this as a receive would announce money arriving for what is only a mode change.
    sdk.listPayments.mockResolvedValue({
      payments: [
        tokenPayment({
          id: 'c1',
          paymentType: 1,
          status: 0,
          amount: 47_493_695n,
          fees: 0n,
          timestamp: 1_700_000_200n,
          conversionDetails: { status: 0, conversions: [{ provider: 0, from: BTC_SIDE, to: USDB_SIDE, status: 0 }] },
        }),
      ],
    })

    const items = await sparkListHistory()

    expect(items[0].direction).toBe('converted')
  })

  test('turning it off (token back to sats) reads as converted too', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 'c2',
          paymentType: 1,
          status: 0,
          amount: 60_557n,
          fees: 0n,
          timestamp: 1_700_000_250n,
          conversionDetails: { status: 0, conversions: [{ provider: 0, from: USDB_SIDE, to: BTC_SIDE, status: 0 }] },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0].direction).toBe('converted')
  })

  test('a real receive that the stable balance then converted is still a receive', async () => {
    // The sats are the conversion's source, not its destination, so calling it a conversion would
    // hide a receive.
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 'r1',
          paymentType: 1,
          status: 0,
          amount: 1000n,
          fees: 0n,
          timestamp: 1_700_000_280n,
          conversionDetails: { status: 0, conversions: [{ provider: 0, from: BTC_SIDE, to: USDB_SIDE, status: 0 }] },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0].direction).toBe('received')
  })

  test('a send funded by a conversion is still a send: value did leave the wallet', async () => {
    // Paying a bitcoin invoice out of the USDB balance carries conversionDetails too.
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 's1',
          paymentType: 0,
          status: 0,
          amount: 1000n,
          fees: 0n,
          timestamp: 1_700_000_300n,
          conversionDetails: { status: 0, conversions: [{ provider: 0, from: USDB_SIDE, to: BTC_SIDE, status: 0 }] },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0].direction).toBe('sent')
  })

  // The leg the AMM pays back on a conversion to the wallet's own address, in the shape the SDK
  // reports it: AMM info with its purpose on the details, and no conversionDetails at all.
  const ammInfo = (purpose?: string) => ({
    tag: 'Amm',
    inner: {
      poolId: '030000000000000000000000000000000000000000000000000000000000000001',
      conversionId: '01a00000-0000-7000-8000-000000000001',
      status: 1,
      purpose: purpose === undefined ? undefined : { tag: purpose },
    },
  })

  test('a conversion made on the Convert screen reads as converted, not received', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 'x1',
          paymentType: 1,
          status: 0,
          method: 1,
          amount: 899n,
          fees: 0n,
          timestamp: 1_700_000_400n,
          details: { tag: 'Spark', inner: { conversionInfo: ammInfo('SelfTransfer') } },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0]).toMatchObject({ direction: 'converted', amountSat: 899, asset: null })
  })

  test('the token leg of a conversion on the Convert screen reads as converted too', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 'x2',
          paymentType: 1,
          status: 0,
          method: 2,
          amount: 791_091_799n,
          fees: 0n,
          timestamp: 1_700_000_450n,
          details: {
            tag: 'Token',
            inner: {
              metadata: { identifier: DEPIX.identifier, ticker: 'DePix', decimals: 8 },
              conversionInfo: ammInfo('SelfTransfer'),
            },
          },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0]).toMatchObject({ direction: 'converted', asset: { assetId: DEPIX.identifier } })
  })

  // A refund carries AMM info with no purpose, and it is the wallet's own value coming back from a
  // conversion that did not happen.
  test('a refund from the pool is a receive, not a conversion', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 'x3',
          paymentType: 1,
          status: 0,
          method: 1,
          amount: 899n,
          fees: 0n,
          timestamp: 1_700_000_500n,
          details: { tag: 'Spark', inner: { conversionInfo: ammInfo() } },
        },
      ],
    })

    const items = await sparkListHistory()

    expect(items[0].direction).toBe('received')
  })

  // Each shape below is what the SDK writes at crates/breez-sdk/core/src, tag 0.26.0, and the path that
  // writes it is named on the test. Status numbers are ConversionStatus: 0 Pending, 1 Completed,
  // 2 Failed, 3 RefundNeeded, 4 Refunded.
  describe('what a conversion says', () => {
    const DEPIX_SIDE = (amount: bigint, fee: bigint) => ({
      chain: 0,
      asset: { ticker: 'DePix', identifier: DEPIX.identifier, decimals: 8 },
      amount,
      fee,
    })
    const satsSide = (amount: bigint, fee = 0n) => ({ ...BTC_SIDE, amount, fee })
    const usdbSide = (amount: bigint, fee = 0n) => ({ ...USDB_SIDE, amount, fee })
    const amm = (status: number, purpose?: string, fee?: bigint) => ({
      tag: 'Amm',
      inner: {
        poolId: '030000000000000000000000000000000000000000000000000000000000000001',
        conversionId: '01a00000-0000-7000-8000-000000000001',
        status,
        fee,
        purpose: purpose === undefined ? undefined : { tag: purpose },
        amountAdjustment: undefined,
        degradation: undefined,
      },
    })
    const usdbDetails = (conversionInfo?: object) => ({
      tag: 'Token',
      inner: {
        metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 },
        txHash: 'hash',
        txType: 0,
        invoiceDetails: undefined,
        conversionInfo,
      },
    })
    const satsDetails = (conversionInfo?: object) => ({
      tag: 'Spark',
      inner: { invoiceDetails: undefined, htlcDetails: undefined, conversionInfo },
    })
    const base = { id: 'c', paymentType: 1, status: 0, method: 1, fees: 0n, timestamp: 1_700_000_000n }
    const one = async (payment: object) => {
      sdk.listPayments.mockResolvedValue({ payments: [{ ...base, ...payment }] })
      return (await sparkListHistory())[0]
    }

    // The dollar wallet turning on: auto_convert links the sent leg under the received one and marks
    // the received one Completed, so the SDK rebuilds the whole step (stable_balance/conversions.rs).
    test('a dollar wallet conversion names both sides, each in its own unit, and the fee', async () => {
      const item = await one({
        amount: 25_337_999n,
        details: usdbDetails(amm(1, 'AutoConversion', 50_956n)),
        conversionDetails: {
          status: 1,
          conversions: [
            { provider: 0, status: 1, from: satsSide(31_191n), to: usdbSide(25_337_999n, 50_956n), amountAdjustment: undefined },
          ],
        },
      })

      expect(item.direction).toBe('converted')
      expect(item.status).toBe('complete')
      expect(item.conversion).toEqual({
        status: 'complete',
        automatic: true,
        from: { ticker: null, amount: '31191', fee: undefined },
        to: { ticker: 'USDB', assetId: USDB.identifier, amount: '25.337999', fee: '0.050956' },
      })
    })

    // The dollar wallet turning off: the fee is on the token side, which is the side that left.
    test('token to sats keeps the fee on the token side, in the token', async () => {
      const item = await one({
        amount: 31_473n,
        details: satsDetails(amm(1, 'AutoConversion')),
        conversionDetails: {
          status: 1,
          conversions: [
            { provider: 0, status: 1, from: usdbSide(25_388_955n, 50_000n), to: satsSide(31_473n), amountAdjustment: undefined },
          ],
        },
      })

      expect(item.conversion?.from).toEqual({ ticker: 'USDB', assetId: USDB.identifier, amount: '25.388955', fee: '0.05' })
      expect(item.conversion?.to).toEqual({ ticker: null, amount: '31473', fee: undefined })
    })

    test('each side scales by its own decimals, not by the first one it finds', async () => {
      const item = await one({
        amount: 791_091_799n,
        details: {
          tag: 'Token',
          inner: { metadata: { identifier: DEPIX.identifier, ticker: 'DePix', decimals: 8 }, conversionInfo: amm(1, 'AutoConversion') },
        },
        conversionDetails: {
          status: 1,
          conversions: [{ provider: 0, status: 1, from: satsSide(60_557n, 12n), to: DEPIX_SIDE(791_091_799n, 1_500_000n) }],
        },
      })

      expect(item.conversion?.from).toMatchObject({ amount: '60557', fee: '12' })
      expect(item.conversion?.to).toMatchObject({ amount: '7.91091799', fee: '0.015' })
    })

    // A self-transfer, which is how Convert runs, links the sent leg away and writes no
    // conversion_status, so the SDK builds no step, and the leg that arrived is all a list or a get can read
    // (sdk/payments/conversion.rs, pre_link_conversion_children, complete_conversion_and_send).
    test('a Convert into a token knows it left sats, without saying how many', async () => {
      const item = await one({ amount: 25_337_999n, details: usdbDetails(amm(1, 'SelfTransfer', 50_956n)) })

      expect(item.direction).toBe('converted')
      expect(item.conversion).toEqual({
        status: 'complete',
        automatic: false,
        from: { ticker: null },
        to: { ticker: 'USDB', assetId: USDB.identifier, amount: '25.337999', fee: '0.050956' },
      })
    })

    test('a Convert into sats does not guess which token left, nor any fee', async () => {
      const item = await one({ amount: 31_473n, details: satsDetails(amm(1, 'SelfTransfer')) })

      expect(item.conversion).toEqual({
        status: 'complete',
        automatic: false,
        to: { ticker: null, amount: '31473', fee: undefined },
      })
      expect(item.conversion?.from).toBeUndefined()
    })

    test('an AMM fee on a sats leg is not read, since its unit would be unknown', async () => {
      const item = await one({ amount: 31_473n, details: satsDetails(amm(1, 'SelfTransfer', 999n)) })

      expect(item.conversion?.to?.fee).toBeUndefined()
    })

    test('a side the SDK reports with fee 0 has no fee, rather than a zero that may be unknown', async () => {
      const item = await one({
        amount: 25_337_999n,
        details: usdbDetails(amm(1, 'AutoConversion')),
        conversionDetails: { status: 1, conversions: [{ provider: 0, status: 1, from: satsSide(31_191n), to: usdbSide(25_337_999n) }] },
      })

      expect(item.conversion?.from?.fee).toBeUndefined()
      expect(item.conversion?.to?.fee).toBeUndefined()
    })

    // A convert-then-send whose send never landed, or any conversion before the SDK links it: the
    // purpose is on the legs, both are listed, and neither is money from anyone.
    test.each(['AutoConversion', 'OngoingPayment'])('the arriving leg of a %s conversion is a conversion', async purpose => {
      const item = await one({ amount: 31_473n, details: satsDetails(amm(1, purpose)) })

      expect(item.direction).toBe('converted')
    })

    test('the leg that left, while it is listed, is a conversion and says only its own side', async () => {
      const item = await one({ paymentType: 0, amount: 31_191n, details: satsDetails(amm(1, 'AutoConversion')) })

      expect(item.direction).toBe('converted')
      expect(item.conversion).toEqual({
        status: 'complete',
        automatic: true,
        from: { ticker: null, amount: '31191', fee: undefined },
      })
    })

    // A conversion that did not land leaves only its sent leg, marked by update_payment_conversion_info,
    // and that transfer did settle, into the pool (token_conversion/flashnet.rs).
    test.each([
      [3, 'refundPending'],
      [4, 'refunded'],
      [2, 'failed'],
    ])('a sent leg at conversion status %s reads as not delivered', async (status, expected) => {
      const item = await one({ paymentType: 0, amount: 25_388_955n, details: usdbDetails(amm(status, 'SelfTransfer', 50_000n)) })

      expect(item.direction).toBe('converted')
      expect(item.status).toBe('failed')
      expect(item.conversion).toEqual({
        status: expected,
        automatic: false,
        from: { ticker: 'USDB', assetId: USDB.identifier, amount: '25.388955', fee: '0.05' },
      })
    })

    test('the refund that follows stays a receive and says it was a refund', async () => {
      const item = await one({ amount: 31_473n, details: satsDetails(amm(4)) })

      expect(item.direction).toBe('received')
      expect(item.status).toBe('complete')
      expect(item.conversion).toEqual({ status: 'refunded', automatic: false })
      expect(item.poolRefund).toBe(true)
    })

    test('a leg with its own conversion info is a refund only once the info says Refunded', async () => {
      const item = await one({ amount: 31_473n, details: satsDetails(amm(1)) })

      expect(item.poolRefund).toBeUndefined()
    })

    // The conversion stable balance ran on it failed, and the status reaches the parent through the step
    // that build_conversions makes of its child legs (stable_balance/conversions.rs links them).
    test.each([
      [4, 'refunded'],
      [3, 'refundPending'],
      [2, 'failed'],
    ])('a real receive whose auto conversion ended at %s stays a receive', async (status, expected) => {
      const item = await one({
        amount: 5000n,
        details: satsDetails(),
        conversionDetails: {
          status,
          conversions: [{ provider: 0, status, from: satsSide(5000n), to: usdbSide(4_900_000n) }],
        },
      })

      expect(item.direction).toBe('received')
      expect(item.status).toBe('complete')
      expect(item.poolRefund).toBeUndefined()
      expect(item.conversion?.status).toBe(expected)
    })

    // should_trigger_per_receive marks the real receive Pending with no steps yet, and the two legs
    // are then its children (stable_balance/mod.rs, conversions.rs).
    test('a real receive queued for dollar mode stays a receive, with the conversion pending', async () => {
      const item = await one({
        amount: 1000n,
        details: satsDetails(),
        conversionDetails: { status: 0, conversions: [] },
      })

      expect(item.direction).toBe('received')
      expect(item.status).toBe('complete')
      expect(item.conversion).toEqual({ status: 'pending', automatic: false })
    })

    test('a real receive whose conversion timed out stays a receive that says so', async () => {
      const item = await one({
        amount: 1000n,
        details: satsDetails(),
        conversionDetails: { status: 2, conversions: [] },
      })

      expect(item.direction).toBe('received')
      expect(item.status).toBe('complete')
      expect(item.conversion).toEqual({ status: 'failed', automatic: false })
    })

    test('a real receive that dollar mode converted names both sides and stays a receive', async () => {
      const item = await one({
        amount: 1000n,
        details: satsDetails(),
        conversionDetails: {
          status: 1,
          conversions: [{ provider: 0, status: 1, from: satsSide(1000n), to: usdbSide(800_000n, 1_600n) }],
        },
      })

      expect(item.direction).toBe('received')
      expect(item.conversion).toMatchObject({
        status: 'complete',
        from: { ticker: null, amount: '1000' },
        to: { ticker: 'USDB', assetId: USDB.identifier, amount: '0.8', fee: '0.0016' },
      })
    })

    test('a send funded by a conversion stays a send and carries the conversion', async () => {
      const item = await one({
        paymentType: 0,
        amount: 1000n,
        details: satsDetails(),
        conversionDetails: {
          status: 1,
          conversions: [{ provider: 0, status: 1, from: usdbSide(810_000n, 1_600n), to: satsSide(1000n) }],
        },
      })

      expect(item.direction).toBe('sent')
      expect(item.conversion?.from).toMatchObject({ ticker: 'USDB', amount: '0.81', fee: '0.0016' })
    })

    test('a cross-chain step is not a conversion of the wallet\'s own balance', async () => {
      const item = await one({
        amount: 49_990_000n,
        details: usdbDetails({ tag: 'Orchestra', inner: { chain: 'tron', asset: 'USDT', assetDecimals: 6 } }),
        conversionDetails: {
          status: 1,
          conversions: [{ provider: 1, status: 1, from: usdbSide(50_210_000n), to: usdbSide(49_990_000n) }],
        },
      })

      expect(item.direction).toBe('received')
      expect(item.conversion).toBeUndefined()
    })

    test('a payment with no conversion carries none', async () => {
      const item = await one({ amount: 1000n, details: satsDetails() })

      expect(item.conversion).toBeUndefined()
    })
  })

  test('asks for everything by default: no asset filter', async () => {
    sdk.listPayments.mockResolvedValue({ payments: [] })
    await sparkListHistory()

    expect(sdk.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ assetFilter: undefined, limit: 50 }),
    )
  })

  test('narrows to bitcoin through the SDK union, not a string', async () => {
    // The binding takes AssetFilter variants, so a bare 'bitcoin' string is rejected at the FFI boundary.
    sdk.listPayments.mockResolvedValue({ payments: [] })
    await sparkListHistory(10, 'bitcoin')

    const request = sdk.listPayments.mock.calls[sdk.listPayments.mock.calls.length - 1][0]
    expect(request.limit).toBe(10)
    expect(request.assetFilter.tag).toBe('Bitcoin')
  })

  test('narrows to one token, carrying its identifier', async () => {
    sdk.listPayments.mockResolvedValue({ payments: [] })
    await sparkListHistory(10, { tokenIdentifier: 'btkn1usdb' })

    const request = sdk.listPayments.mock.calls[sdk.listPayments.mock.calls.length - 1][0]
    expect(request.assetFilter.tag).toBe('Token')
    expect(request.assetFilter.inner).toEqual({ tokenIdentifier: 'btkn1usdb' })
  })
})

describe('who ran a conversion', () => {
  const amm = { tag: 'Amm', inner: { poolId: 'p', conversionId: 'c', status: 1 } }
  const provider = async (payment: object) => {
    sdk.listPayments.mockResolvedValue({
      payments: [{ id: 'p', paymentType: 0, status: 0, amount: 1n, fees: 0n, timestamp: 1n, ...payment }],
    })
    return (await sparkListHistory())[0].provider
  }

  test('the pool is Flashnet, from the info alone', async () => {
    expect(await provider({ details: { tag: 'Spark', inner: { conversionInfo: amm } } })).toBe('Flashnet')
  })

  test('the step speaks when the details say nothing', async () => {
    const side = { asset: { ticker: 'BTC', identifier: undefined, decimals: 0 }, amount: 1n, fee: 0n }
    const conversions = [{ provider: 0, status: 1, from: side, to: side }]
    expect(await provider({ details: { tag: 'Spark', inner: {} }, conversionDetails: { status: 1, conversions } })).toBe(
      'Flashnet',
    )
  })

  test('a plain payment has none', async () => {
    expect(await provider({ details: { tag: 'Spark', inner: {} } })).toBeUndefined()
  })
})

describe('payment detail enrichment (mapper walks the details union)', () => {
  // Base payment fields, Receive and Completed, with each test supplying its own `details`.
  const base = { id: 'px', paymentType: 1, status: 0, amount: 5000n, fees: 3n, timestamp: 1_700_000_000n }
  const only = async (details: unknown, method?: number, paymentType: number = base.paymentType) => {
    sdk.listPayments.mockResolvedValue({ payments: [{ ...base, paymentType, method, details }] })
    return (await sparkListHistory())[0]
  }
  const sent = (details: unknown) => only(details, undefined, PaymentType.Send)

  test('Lightning send: method lightning + memo + counterparty (lnAddress over pubkey), no txId', async () => {
    const item = await sent({
      tag: 'Lightning',
      inner: {
        description: 'Invoice memo',
        invoice: 'lnbc1',
        destinationPubkey: '02deadbeef',
        lnurlPayInfo: { lnAddress: 'alice@site.com' },
      },
    })
    expect(item.method).toBe('lightning')
    expect(item.description).toBe('Invoice memo')
    expect(item.destination).toBe('alice@site.com')
    expect(item.lnAddress).toBe('alice@site.com')
    expect(item.invoice).toBe('lnbc1')
    expect(item.txId).toBeUndefined() // LN has no on-chain tx
  })

  test('Lightning send without lnurlPayInfo falls back to the node pubkey, which is no address', async () => {
    const item = await sent({
      tag: 'Lightning',
      inner: { description: undefined, invoice: 'lnbc1', destinationPubkey: '02deadbeef', lnurlPayInfo: undefined },
    })
    expect(item.destination).toBe('02deadbeef')
    expect(item.lnAddress).toBeUndefined()
  })

  // destinationPubkey on a receive is the wallet's own side, which no one reads as a counterparty.
  test('a Lightning receive names no destination and keeps its invoice', async () => {
    const item = await only({
      tag: 'Lightning',
      inner: { invoice: 'lnbc1', destinationPubkey: '02deadbeef', lnurlPayInfo: undefined },
    })
    expect(item.destination).toBeUndefined()
    expect(item.invoice).toBe('lnbc1')
  })

  test('a Lightning send keeps the comment it went out with, and a blank one is none', async () => {
    const lnurl = (comment: string | undefined) => ({
      tag: 'Lightning',
      inner: { invoice: 'lnbc1', destinationPubkey: '02deadbeef', lnurlPayInfo: { comment } },
    })
    expect((await sent(lnurl('for the coffee'))).comment).toBe('for the coffee')
    expect((await sent(lnurl('  '))).comment).toBeUndefined()
  })

  describe('the success action a paid service left (LUD-09)', () => {
    const action = async (processedSuccessAction: unknown) =>
      (
        await sent({
          tag: 'Lightning',
          inner: { invoice: 'lnbc1', destinationPubkey: '02', lnurlPayInfo: { processedSuccessAction } },
        })
      ).successAction

    test('a message is its text', async () => {
      expect(await action({ tag: 'Message', inner: { data: { message: 'Thanks!' } } })).toEqual({
        kind: 'message',
        text: 'Thanks!',
      })
    })

    test('a url on another host than the callback says so', async () => {
      const inner = { data: { url: 'https://else.example/r', description: 'Receipt', matchesCallbackDomain: false } }
      expect(await action({ tag: 'Url', inner })).toEqual({
        kind: 'url',
        url: 'https://else.example/r',
        description: 'Receipt',
        foreignHost: true,
      })
    })

    test('a url keeps the address and its description', async () => {
      const inner = { data: { url: 'https://shop.example/r', description: 'Receipt', matchesCallbackDomain: true } }
      expect(await action({ tag: 'Url', inner })).toEqual({
        kind: 'url',
        url: 'https://shop.example/r',
        description: 'Receipt',
      })
    })

    test('a decrypted one is a message under its description', async () => {
      const result = { tag: 'Decrypted', inner: { data: { description: 'Your code', plaintext: '1234' } } }
      expect(await action({ tag: 'Aes', inner: { result } })).toEqual({
        kind: 'message',
        text: '1234',
        description: 'Your code',
      })
    })

    test('one the SDK could not open shows nothing', async () => {
      const result = { tag: 'ErrorStatus', inner: { reason: 'bad key' } }
      expect(await action({ tag: 'Aes', inner: { result } })).toBeUndefined()
    })

    test('none is none', async () => {
      expect(await action(undefined)).toBeUndefined()
    })
  })

  test('Lightning zap: item.zap carries the zapper comment from the 9734', async () => {
    const item = await only({
      tag: 'Lightning',
      inner: {
        destinationPubkey: '02deadbeef',
        lnurlPayInfo: undefined,
        lnurlReceiveMetadata: {
          nostrZapRequest: JSON.stringify({ kind: 9734, content: 'gm ☕' }),
          senderComment: undefined,
        },
      },
    })
    expect(item.zap).toEqual({ comment: 'gm ☕' })
  })

  test('Lightning non-zap LUD-12 comment does NOT set item.zap (zap-only policy)', async () => {
    const item = await only({
      tag: 'Lightning',
      inner: {
        destinationPubkey: '02deadbeef',
        lnurlPayInfo: undefined,
        lnurlReceiveMetadata: { nostrZapRequest: undefined, senderComment: 'thanks!' },
      },
    })
    expect(item.zap).toBeUndefined()
  })

  // A send to a silent payment address lands as any withdrawal, and the SDK keeps no address on it, so
  // the row names the rail and the transaction and claims no destination.
  test('a send to a silent payment address reads as an on-chain send, in sats, with its fee', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          ...base,
          paymentType: PaymentType.Send,
          status: 1,
          amount: 20_000n,
          fees: 1_710n,
          details: { tag: 'Withdraw', inner: { txId: 'sptx' } },
        },
      ],
    })
    const [item] = await sparkListHistory()
    expect(item).toMatchObject({
      direction: 'sent',
      status: 'pending',
      amountSat: 20_000,
      feesSat: 1_710,
      method: 'bitcoin',
      txId: 'sptx',
    })
    expect(item.asset ?? undefined).toBeUndefined()
    expect(item.destination).toBeUndefined()
  })

  test('Withdraw: method bitcoin + on-chain txId', async () => {
    const item = await only({ tag: 'Withdraw', inner: { txId: 'wtx123' } })
    expect(item.method).toBe('bitcoin')
    expect(item.txId).toBe('wtx123')
    expect(item.description).toBeUndefined()
  })

  test('Deposit: method bitcoin + on-chain txId', async () => {
    const item = await only({ tag: 'Deposit', inner: { txId: 'dtx456', vout: 0 } })
    expect(item.method).toBe('bitcoin')
    expect(item.txId).toBe('dtx456')
  })

  test('Spark send: method spark + description/destination from the spark invoice, no txId', async () => {
    const item = await sent({
      tag: 'Spark',
      inner: { invoiceDetails: { description: 'Spark memo', invoice: 'spark1invoice' } },
    })
    expect(item.method).toBe('spark')
    expect(item.description).toBe('Spark memo')
    expect(item.destination).toBe('spark1invoice')
    expect(item.txId).toBeUndefined()
  })

  test('a Spark receive keeps the invoice it answered as an invoice, not as a destination', async () => {
    const item = await only({ tag: 'Spark', inner: { invoiceDetails: { invoice: 'spark1invoice' } } })
    expect(item.destination).toBeUndefined()
    expect(item.invoice).toBe('spark1invoice')
  })

  test('a Spark payment is verifiable by its transfer id, which is not a txId', async () => {
    const item = await only({ tag: 'Spark', inner: { invoiceDetails: undefined } })
    expect(item.transferRef).toBe('px')
    expect(item.txId).toBeUndefined()
  })

  test('Token: method spark and txHash is NOT surfaced as a txId (not a bitcoin txid)', async () => {
    const item = await only({
      tag: 'Token',
      inner: { metadata: {}, txHash: 'sparkhash', invoiceDetails: { description: 'Token memo', invoice: 'tok1' } },
    })
    expect(item.method).toBe('spark')
    expect(item.description).toBe('Token memo')
    expect(item.txId).toBeUndefined() // an explorer link on a spark hash would 404
    expect(item.transferRef).toBe('sparkhash')
  })

  // The SDK writes 0 on every token payment without working a fee out (utils/token.rs:207).
  test('a token fee is in the token, and a 0 from the SDK is no fee at all', async () => {
    const token = (fees: bigint) =>
      sdk.listPayments.mockResolvedValue({
        payments: [
          {
            ...base,
            fees,
            details: {
              tag: 'Token',
              inner: { metadata: { identifier: 'btkn1usdb', ticker: 'USDB', decimals: 6 }, txHash: 'h' },
            },
          },
        ],
      })
    token(50_000n)
    expect((await sparkListHistory())[0].asset?.fee).toBe('0.05')
    token(0n)
    expect((await sparkListHistory())[0].asset?.fee).toBeUndefined()
  })

  test('fallback: when details is empty, the rail comes from the p.method enum', async () => {
    // PaymentMethod enum values, Deposit=3 -> bitcoin, Spark=1 -> spark, Unknown=5 -> undefined.
    expect((await only(undefined, 3)).method).toBe('bitcoin')
    expect((await only(undefined, 1)).method).toBe('spark')
    expect((await only(undefined, 5)).method).toBeUndefined()
  })
})

describe('sparkGetPayment', () => {
  test('fetches one payment by id and returns it through the same enriched mapper', async () => {
    sdk.getPayment.mockResolvedValue({
      payment: {
        id: 'p9',
        paymentType: 0,
        status: 0,
        amount: 8000n,
        fees: 2n,
        timestamp: 1_700_000_500n,
        details: { tag: 'Withdraw', inner: { txId: 'chainTx' } },
      },
    })

    const item = await sparkGetPayment('p9')

    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: 'p9' })
    expect(item.id).toBe('p9')
    expect(item.method).toBe('bitcoin')
    expect(item.txId).toBe('chainTx')
  })
})

describe('sparkGetFiatRates', () => {
  test('maps the SDK rates to a coin -> value map, only for the requested coins', async () => {
    sdk.listFiatRates.mockResolvedValue({
      rates: [
        { coin: 'USD', value: 100_000 },
        { coin: 'BRL', value: 550_000 },
        { coin: 'EUR', value: 90_000 },
      ],
    })
    expect(await sparkGetFiatRates(['BRL', 'USD'])).toEqual({ BRL: 550_000, USD: 100_000 })
  })

  test('omits a coin the SDK does not return', async () => {
    sdk.listFiatRates.mockResolvedValue({ rates: [{ coin: 'USD', value: 100_000 }] })
    expect(await sparkGetFiatRates(['BRL', 'USD'])).toEqual({ USD: 100_000 })
  })
})

describe('sparkListFiatCurrencies', () => {
  test('flattens the SDK currencies to {id,name,symbol,fractionSize} and leaves the feed placement behind', async () => {
    sdk.listFiatCurrencies.mockResolvedValue({
      currencies: [
        // The feed's placement (position or template) is its home country's habit, so none of it reaches
        // the option: toEqual below fails on any key beyond these four.
        { id: 'EUR', info: { name: 'Euro', fractionSize: 2, symbol: { grapheme: '€', position: 1 } } },
        // A shared glyph, so uniqSymbol disambiguates and must win over the bare symbol.
        {
          id: 'AUD',
          info: {
            name: 'Australian Dollar',
            fractionSize: 2,
            symbol: { grapheme: '$', template: '$1' },
            uniqSymbol: { grapheme: 'A$', template: '$1' },
          },
        },
        { id: 'SEK', info: { name: 'Swedish Krona', fractionSize: 2, symbol: { grapheme: 'kr', template: '1 $', position: 1 } } },
        // No grapheme in either symbol falls back to the code.
        { id: 'XAF', info: { name: 'CFA Franc', fractionSize: 0, symbol: undefined, uniqSymbol: undefined } },
      ],
    })

    expect(await sparkListFiatCurrencies()).toEqual([
      { id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 },
      { id: 'AUD', name: 'Australian Dollar', symbol: 'A$', fractionSize: 2 },
      { id: 'SEK', name: 'Swedish Krona', symbol: 'kr', fractionSize: 2 },
      { id: 'XAF', name: 'CFA Franc', symbol: 'XAF', fractionSize: 0 },
    ])
  })
})

describe('sparkBuyBitcoinUrl', () => {
  test('returns the Moonpay hosted URL and buys bitcoin for the amount, as a bigint', async () => {
    sdk.buyBitcoin.mockResolvedValue({ url: 'https://buy.moonpay/xyz' })

    const url = await sparkBuyBitcoinUrl(50_000)

    const { delivery } = fieldsOf(sdk.buyBitcoin.mock.calls[0][0]) as { delivery: MoonpayDelivery }
    expect(delivery).toBeInstanceOf(MoonpayDelivery.Bitcoin)
    expect(delivery.tag).toBe(MoonpayDelivery_Tags.Bitcoin)
    expect(delivery.inner).toEqual({ amountSat: 50_000n })
    expect(url).toBe('https://buy.moonpay/xyz')
  })

  // The SDK reads an unset delivery as bitcoin to the wallet's own address, with no amount prefilled.
  test('no amount leaves the delivery unset', async () => {
    await sparkBuyBitcoinUrl()
    expect(fieldsOf(sdk.buyBitcoin.mock.calls[0][0]).delivery).toBeUndefined()
  })
})

describe('address left on a domain the wallet no longer serves', () => {
  test('an address on the configured domain is kept', () => {
    expect(addressServesDomain('alice@usevoltz.app', 'usevoltz.app')).toBe(true)
    // Case is not significant in a domain, and the SDK echoes back whatever was registered.
    expect(addressServesDomain('alice@UseVoltz.app', 'usevoltz.app')).toBe(true)
  })

  test('an address on another domain is not', () => {
    // An app configured for the apex must not keep showing an address on the subdomain, which
    // resolves against a host that has no record of the name.
    expect(addressServesDomain('alice@lnurl.usevoltz.app', 'usevoltz.app')).toBe(false)
    expect(addressServesDomain('alice@breez.tips', 'usevoltz.app')).toBe(false)
  })

  test('a suffix that is not a domain boundary does not count as a match', () => {
    expect(addressServesDomain('alice@notusevoltz.app', 'usevoltz.app')).toBe(false)
  })

  test('with no configured domain the SDK default is trusted', () => {
    expect(addressServesDomain('alice@breez.tips', undefined)).toBe(true)
  })

  test('the username is what precedes the @, so the name survives the move', () => {
    expect(usernameOf('alice@lnurl.usevoltz.app')).toBe('alice')
    expect(usernameOf('')).toBe('')
  })
})

// --- Receiving USDT/USDC from another chain ---
describe('cross-chain receive', () => {
  const btcAccepted = { asset: { tag: 'Bitcoin' }, limits: { minAmount: 500_000n, maxAmount: undefined, minUsdCents: 100n, maxUsdCents: 1_000_000n } }
  const usdbAccepted = { asset: { tag: 'Token', inner: { tokenIdentifier: USDB.identifier } }, limits: undefined }
  const pair = (over: object) => ({
    provider: 0,
    chain: 'tron',
    chainId: undefined,
    asset: 'USDT',
    contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    decimals: 6,
    exactOutEligible: false,
    acceptedAssets: [btcAccepted, usdbAccepted],
    deliveryMethods: [],
    ...over,
  })

  test('lists the receive routes, sorted, each with where it lands and its bounds', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([
      pair({ chain: 'base', asset: 'USDC', contractAddress: '0xbase', decimals: 6 }),
      pair({}),
      pair({ chain: 'arc', asset: 'USDC', contractAddress: '0xarc', acceptedAssets: [usdbAccepted] }),
      pair({ chain: 'nowhere', acceptedAssets: [{ asset: { tag: 'Token', inner: { tokenIdentifier: 'btkn1other' } }, limits: undefined }] }),
    ])

    const routes = await sparkListReceiveRoutes(false)

    const filter = sdk.getCrossChainRoutes.mock.calls[0][0]
    expect(filter).toBeInstanceOf(CrossChainRouteFilter.Receive)
    // Strict, so a delivery method set to anything stops listing the routes that land on Spark.
    expect(fieldsOf(filter)).toStrictEqual({ contractAddress: undefined, deliveryMethod: undefined })
    // A route that can deliver neither bitcoin nor USDB is left out, and the common ones lead.
    expect(routes.map(r => [r.chain, r.asset, r.landing])).toEqual([
      ['tron', 'USDT', 'btc'],
      ['base', 'USDC', 'btc'],
      ['arc', 'USDC', 'usdb'],
    ])
    // Bounds come from the asset that lands, in base units: bitcoin has a 1 USD floor, USDB none.
    expect(routes[0]).toMatchObject({ min: 1_000_000n, max: 10_000_000_000n })
    expect(routes[2]).toMatchObject({ min: undefined, max: undefined })
  })

  test('the dollar wallet lands the same route as USDB, with that asset bounds', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([pair({})])
    const [tron] = await sparkListReceiveRoutes(true)
    expect(tron).toMatchObject({ landing: 'usdb', min: undefined })
  })

  // USDC on BSC has 18 places, past a double, and a floor a base unit past five dollars must reach
  // the keypad as itself, or five dollars reads as enough and the provider refuses it.
  test('an 18-place route keeps its bounds to the last base unit', async () => {
    const min = 5_000_000_000_000_000_001n
    const max = 9_999_999_999_999_999_999n
    const limits = { minAmount: min, maxAmount: max, minUsdCents: 500n, maxUsdCents: 1_000_000n }
    const accepted = [{ asset: { tag: 'Bitcoin' }, limits }]
    sdk.getCrossChainRoutes.mockResolvedValue([
      pair({ chain: 'bsc', asset: 'USDC', decimals: 18, acceptedAssets: accepted }),
    ])
    const [bsc] = await sparkListReceiveRoutes(false)
    expect(bsc).toMatchObject({ decimals: 18, min, max })
  })

  // The same chain can list one asset under two contracts, and one id for both would quote the wrong one.
  test('a repeated asset on one chain keeps apart by contract', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([pair({}), pair({ contractAddress: 'Tother' })])
    const [a, b] = await sparkListReceiveRoutes(false)
    expect(a.id).not.toBe(b.id)
  })

  const receiveInfo = {
    depositAddress: 'TDepositAddr111',
    depositAmount: 50_210_000n,
    expectedReceivedAmount: 49_990_000n,
    destinationAsset: 'USDB',
    tokenIdentifier: USDB.identifier,
    serviceFeeAmount: 0n,
    serviceFeeAsset: undefined,
    serviceFeeAssetDecimals: undefined,
    expiresAt: 1_790_000_120n,
  }

  test('quotes an exact amount and lands it where the route says', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([pair({ chain: 'bsc', asset: 'USDC', decimals: 18 })])
    const [bsc] = await sparkListReceiveRoutes(true)
    sdk.receivePayment.mockResolvedValue({
      paymentRequest: 'ethereum:0xusdc@56/transfer?address=0xdep&uint256=50210000000000000000',
      fee: 0n,
      crossChainInfo: { ...receiveInfo, depositAddress: '0xdep', depositAmount: 50_210_000_000_000_000_000n },
    })

    // 1.1 is one of the short amounts a double gets wrong at 18 places (by 128 base units); 50.12 is not.
    const quote = await sparkReceiveStable(bsc.id, '1.1')

    const method = sdk.receivePayment.mock.calls[0][0].paymentMethod
    expect(method).toBeInstanceOf(ReceivePaymentMethod.CrossChain)
    expect(fieldsOf(method).amount).toBe(1_100_000_000_000_000_000n)
    expect(fieldsOf(method).destination).toMatchObject({ tag: 'Token', inner: { tokenIdentifier: USDB.identifier } })
    expect(fieldsOf(method).route).toMatchObject({ chain: 'bsc', contractAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t' })
    // The QR carries the wallet URI, the copy carries the bare address an exchange accepts.
    expect(quote).toMatchObject({
      qr: 'ethereum:0xusdc@56/transfer?address=0xdep&uint256=50210000000000000000',
      address: '0xdep',
      sendAmount: '50.21',
      landing: 'usdb',
      // 49_990_000 base units of a 6-decimal USDB.
      receiveAmount: 49.99,
      expiresAtMs: 1_790_000_120_000,
    })
  })

  test('a bitcoin landing is asked for as bitcoin and reads in sats', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([pair({})])
    const [tron] = await sparkListReceiveRoutes(false)
    sdk.receivePayment.mockResolvedValue({
      paymentRequest: 'TDepositAddr111',
      fee: 0n,
      crossChainInfo: { ...receiveInfo, expectedReceivedAmount: 52_000n, destinationAsset: 'BTC', tokenIdentifier: undefined },
    })

    const quote = await sparkReceiveStable(tron.id, '50')

    expect(fieldsOf(sdk.receivePayment.mock.calls[0][0].paymentMethod).destination).toMatchObject({ tag: 'Bitcoin' })
    expect(fieldsOf(sdk.receivePayment.mock.calls[0][0].paymentMethod).amount).toBe(50_000_000n)
    expect(quote).toMatchObject({ landing: 'btc', receiveAmount: 52_000 })
  })

  test('refuses an amount the asset cannot represent before asking the provider', async () => {
    sdk.getCrossChainRoutes.mockResolvedValue([pair({})])
    const [tron] = await sparkListReceiveRoutes(false)
    await expect(sparkReceiveStable(tron.id, '0.0000001')).rejects.toThrow()
    expect(sdk.receivePayment).not.toHaveBeenCalled()
  })

  // The arrival is a plain transfer that the SDK later annotates with where it came from.
  test('history names where a cross-chain receive came from', async () => {
    const orchestra = {
      tag: 'Orchestra',
      inner: {
        orderId: 'o1', quoteId: 'q1', readToken: undefined, chain: 'tron', chainId: undefined, asset: 'USDT',
        recipientAddress: 'spark1me', assetAmountIn: 50_210_000n, estimatedOut: 49_990_000n,
        deliveredAmount: 49_990_000n, externalTxHash: 'tronhash123', status: 0, feeAmount: undefined,
        serviceFeeAmount: undefined, serviceFeeAsset: undefined, serviceFeeAssetDecimals: undefined,
        assetDecimals: 6, assetContract: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
      },
    }
    const received = (conversionInfo: unknown) => ({
      id: 'r1',
      paymentType: PaymentType.Receive,
      status: 0,
      amount: 49_990_000n,
      fees: 0n,
      timestamp: 1_700_000_300n,
      details: {
        tag: 'Token',
        inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 }, conversionInfo },
      },
    })
    // The SDK rebuilds conversionDetails from the Orchestra info: the paid asset on the external chain
    // in, the Spark asset out. That step is money arriving, not the wallet converting its own balance.
    const orchestraStep = (to: object) => ({
      provider: 1,
      status: 0,
      from: {
        chain: { tag: 'External', inner: { name: 'tron', chainId: undefined } },
        asset: { ticker: 'USDT', identifier: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
        amount: 50_210_000n,
        fee: 0n,
      },
      to,
      amountAdjustment: undefined,
    })
    const usdbSide = { chain: { tag: 'Spark' }, asset: { ticker: 'USDB', identifier: USDB.identifier, decimals: 6 }, amount: 49_990_000n, fee: 0n }
    const btcSide = { chain: { tag: 'Spark' }, asset: { ticker: 'BTC', identifier: undefined, decimals: 0 }, amount: 52_000n, fee: 0n }
    const btcReceived = {
      id: 'r2',
      paymentType: PaymentType.Receive,
      status: 0,
      amount: 52_000n,
      fees: 0n,
      timestamp: 1_700_000_400n,
      details: { tag: 'Spark', inner: { conversionInfo: orchestra } },
      conversionDetails: { status: 0, conversions: [orchestraStep(btcSide)] },
    }
    sdk.listPayments.mockResolvedValue({
      payments: [
        { ...received(orchestra), conversionDetails: { status: 0, conversions: [orchestraStep(usdbSide)] } },
        btcReceived,
        received({ tag: 'Amm', inner: {} }),
      ],
    })

    const [crossChain, btcLanding, amm] = await sparkListHistory()

    expect(crossChain.direction).toBe('received')
    expect(btcLanding.direction).toBe('received')
    expect(crossChain.crossChain).toEqual({ chain: 'tron', asset: 'USDT', amountIn: '50.21', txHash: 'tronhash123' })
    expect(amm.crossChain).toBeUndefined()
  })

  // On a send the Orchestra info names the destination, which a "From" row would present as the source.
  test('a cross-chain send carries no source', async () => {
    sdk.listPayments.mockResolvedValue({
      payments: [
        {
          id: 's1',
          paymentType: PaymentType.Send,
          status: 0,
          amount: 5_200n,
          fees: 0n,
          timestamp: 1_700_000_500n,
          details: {
            tag: 'Spark',
            inner: {
              conversionInfo: {
                tag: 'Orchestra',
                inner: {
                  chain: 'base',
                  asset: 'USDC',
                  recipientAddress: '0xrecipient',
                  assetAmountIn: undefined,
                  estimatedOut: 5_000_000n,
                  assetDecimals: 6,
                  externalTxHash: '0xdelivery',
                },
              },
            },
          },
        },
      ],
    })

    const [sent] = await sparkListHistory()

    expect(sent.crossChain).toBeUndefined()
  })
})

// The Spark transfer and the provider's leg are separate fields (guide/cross_chain.html). Shaped after
// the binding: an Orchestra or Boltz info on the details, and the step the SDK rebuilds from it.
describe('a send past Spark reads as where the delivery stands', () => {
  const COMPLETED = 0
  const TRANSFER_PENDING = 1
  const TRANSFER_FAILED = 2
  const STATUS = { Pending: 0, Completed: 1, Failed: 2, RefundNeeded: 3, Refunded: 4 }
  const sparkSide = { chain: { tag: 'Spark' }, asset: { ticker: 'BTC', identifier: undefined, decimals: 0 }, amount: 50_000n, fee: 0n }
  const externalSide = {
    chain: { tag: 'External', inner: { name: 'tron', chainId: undefined } },
    asset: { ticker: 'USDT', identifier: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 },
    amount: 49_000_000n,
    fee: 0n,
  }
  const orchestraInfo = (status: number) => ({
    tag: 'Orchestra',
    inner: { chain: 'tron', asset: 'USDT', assetDecimals: 6, status, estimatedOut: 49_000_000n, externalTxHash: undefined },
  })
  const orchestraStep = (status: number) => ({ provider: 1, status, from: sparkSide, to: externalSide, amountAdjustment: undefined })
  const send = (payment: object) => ({
    id: 's',
    paymentType: PaymentType.Send,
    status: COMPLETED,
    method: 1,
    amount: 50_000n,
    fees: 0n,
    timestamp: 1_700_000_000n,
    ...payment,
  })
  const crossChainSend = (status: number) =>
    send({
      details: { tag: 'Spark', inner: { conversionInfo: orchestraInfo(status) } },
      conversionDetails: { status, conversions: [orchestraStep(status)] },
    })
  const read = async (payment: object) => {
    sdk.listPayments.mockResolvedValue({ payments: [payment] })
    return (await sparkListHistory())[0]
  }

  test.each([
    ['Pending', 'pending', 'pending'],
    ['Completed', 'complete', 'complete'],
    ['Failed', 'failed', 'failed'],
    ['RefundNeeded', 'failed', 'refundPending'],
    ['Refunded', 'failed', 'refunded'],
  ] as const)('a delivery %s over a settled transfer reads %s', async (name, status, delivery) => {
    const item = await read(crossChainSend(STATUS[name]))

    expect(item.direction).toBe('sent')
    expect(item.status).toBe(status)
    expect(item.delivery).toBe(delivery)
  })

  // An event's payment and a row the SDK could not build a step for carry the info alone.
  test('the info alone is enough, with no conversionDetails built', async () => {
    const item = await read(send({ details: { tag: 'Spark', inner: { conversionInfo: orchestraInfo(STATUS.Pending) } } }))

    expect(item.status).toBe('pending')
    expect(item.delivery).toBe('pending')
  })

  test('the step alone is enough, with no info on the details', async () => {
    const item = await read(
      send({
        details: { tag: 'Spark', inner: {} },
        conversionDetails: { status: STATUS.RefundNeeded, conversions: [orchestraStep(STATUS.RefundNeeded)] },
      }),
    )

    expect(item.status).toBe('failed')
    expect(item.delivery).toBe('refundPending')
  })

  // Shaped after the binding's Token variant: a USDB source settles as a token payment, not as sats.
  test('a send paid from USDB reads in USDB, with the delivery tracked', async () => {
    const item = await read(
      send({
        amount: 10_020_000n,
        details: {
          tag: 'Token',
          inner: {
            metadata: { identifier: USDB.identifier, ticker: 'USDB', name: 'Bitcoin USD', decimals: 6, isFreezable: false },
            txHash: 'tx',
            txType: 0,
            conversionInfo: orchestraInfo(STATUS.Pending),
          },
        },
      }),
    )

    expect(item.asset).toMatchObject({ ticker: 'USDB', amount: '10.02' })
    expect(item.status).toBe('pending')
    expect(item.delivery).toBe('pending')
  })

  test('a Boltz delivery on a Lightning send reads the same', async () => {
    const item = await read(
      send({
        details: {
          tag: 'Lightning',
          inner: {
            htlcDetails: { paymentHash: 'h', status: 0, expiryTime: 0n },
            conversionInfo: {
              tag: 'Boltz',
              inner: {
                status: STATUS.Pending,
                asset: 'USDT',
                chain: 'arbitrum',
                recipientAddress: '0xrecipient',
                estimatedOut: 49_000_000n,
                assetDecimals: 6,
              },
            },
          },
        },
      }),
    )

    expect(item.status).toBe('pending')
    expect(item.delivery).toBe('pending')
  })

  // Shaped after the binding: Orchestra names a transaction on the chain and Boltz has only a bridge
  // handle, which is no transaction.
  describe.each([
    [
      'Orchestra',
      { tag: 'Spark', inner: 'Spark' },
      { externalTxHash: '0xdelivery', orderId: 'o1' },
      '0xdelivery',
    ],
    ['Boltz', { tag: 'Lightning', inner: 'Lightning' }, { bridgeRef: 'guid-1', swapId: 'b1' }, undefined],
  ])('what a %s send says past Spark', (tag, shape, own, txHash) => {
    const payment = (status: number, fields: object = {}) =>
      send({
        details: {
          tag: shape.tag,
          inner: {
            ...(shape.inner === 'Lightning'
              ? { invoice: 'lnbchold', destinationPubkey: '02boltz', htlcDetails: { paymentHash: 'h' } }
              : {}),
            conversionInfo: {
              tag,
              inner: {
                chain: 'tron',
                asset: 'USDT',
                assetDecimals: 6,
                recipientAddress: 'TRrecipient',
                status,
                estimatedOut: 49_000_000n,
                deliveredAmount: undefined,
                feeAmount: 1_250_000n,
                ...own,
                ...fields,
              },
            },
          },
        },
      })

    test('the address and the figures in the destination asset, with the node key out of the way', async () => {
      const item = await read(payment(STATUS.Pending))

      expect(item.destination).toBe('TRrecipient')
      expect(item.crossChainSend).toEqual({
        chain: 'tron',
        asset: 'USDT',
        estimatedOut: '49',
        feeAmount: '1.25',
        txHash,
      })
      expect(item.provider).toBe(tag)
    })

    test.each([
      ['Pending', undefined, { amount: '49', estimated: true }],
      ['Completed', 48_750_000n, { amount: '48.75', estimated: false }],
      // Terminal success with the figure missing has nothing that can be called delivered.
      ['Completed', undefined, null],
      ['Failed', undefined, null],
      ['RefundNeeded', undefined, null],
      ['Refunded', undefined, null],
    ] as const)('at %s with delivered %s the arrival is %j', async (name, deliveredAmount, arrival) => {
      expect(crossChainArrival(await read(payment(STATUS[name], { deliveredAmount })))).toEqual(arrival)
    })

    test('a transfer that failed under a delivery still marked pending has no arrival', async () => {
      const item = await read({ ...payment(STATUS.Pending), status: TRANSFER_FAILED })

      expect(item.status).toBe('failed')
      expect(crossChainArrival(item)).toBeNull()
    })

    test.each([undefined, 0n])('with %s from the provider there is no fee', async feeAmount => {
      const item = await read(payment(STATUS.Pending, { feeAmount }))

      expect(item.crossChainSend?.feeAmount).toBeUndefined()
    })
  })

  test('a receive carries no crossChainSend, and keeps its crossChain', async () => {
    const item = await read({
      ...send({ details: { tag: 'Spark', inner: { conversionInfo: orchestraInfo(STATUS.Completed) } } }),
      paymentType: PaymentType.Receive,
    })

    expect(item.crossChainSend).toBeUndefined()
    expect(item.crossChain?.chain).toBe('tron')
  })

  // The persisted conversionDetails.status of a dollar-funded send is the funding conversion's, and
  // says Completed while the delivery is still on its way.
  test('the funding conversion finishing does not answer for the delivery', async () => {
    const amm = { provider: 0, status: STATUS.Completed, from: externalSide, to: sparkSide, amountAdjustment: undefined }
    const item = await read(
      send({
        details: { tag: 'Spark', inner: { conversionInfo: orchestraInfo(STATUS.Pending) } },
        conversionDetails: { status: STATUS.Completed, conversions: [amm, orchestraStep(STATUS.Pending)] },
      }),
    )

    expect(item.status).toBe('pending')
    expect(item.delivery).toBe('pending')
  })

  test('a delivery that finished never lifts a transfer the SDK has not settled', async () => {
    const pending = await read({ ...crossChainSend(STATUS.Completed), status: TRANSFER_PENDING })
    const failed = await read({ ...crossChainSend(STATUS.Completed), status: TRANSFER_FAILED })

    expect(pending.status).toBe('pending')
    expect(failed.status).toBe('failed')
  })

  test('a transfer still pending over a refused delivery reads as refused', async () => {
    const item = await read({ ...crossChainSend(STATUS.RefundNeeded), status: TRANSFER_PENDING })

    expect(item.status).toBe('failed')
  })

  test('a send with no cross-chain leg has no delivery', async () => {
    const amm = { provider: 0, status: STATUS.Pending, from: externalSide, to: sparkSide, amountAdjustment: undefined }
    const item = await read(
      send({ details: { tag: 'Spark', inner: {} }, conversionDetails: { status: STATUS.Pending, conversions: [amm] } }),
    )

    expect(item.delivery).toBeUndefined()
    expect(item.status).toBe('complete')
  })

  test('a cross-chain arrival has no delivery: the info names where it came from', async () => {
    const item = await read({
      ...send({ details: { tag: 'Spark', inner: { conversionInfo: orchestraInfo(STATUS.Pending) } } }),
      paymentType: PaymentType.Receive,
    })

    expect(item.delivery).toBeUndefined()
    expect(item.status).toBe('complete')
  })
})

describe('a receive with a conversion behind it', () => {
  const NOW = 1_800_000_000_000
  const receive = (conversionStatus: number, ageMs: number) => ({
    id: 'r',
    paymentType: PaymentType.Receive,
    status: 0,
    method: 1,
    amount: 1000n,
    fees: 0n,
    timestamp: BigInt(Math.floor((NOW - ageMs) / 1000)),
    details: { tag: 'Spark', inner: {} },
    conversionDetails: { status: conversionStatus, conversions: [] },
  })
  const read = async (payment: object) => {
    sdk.listPayments.mockResolvedValue({ payments: [payment] })
    return (await sparkListHistory())[0]
  }

  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(NOW)
  })
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('reads pending while the conversion is in flight', async () => {
    const item = await read(receive(0, 60_000))

    expect(item.status).toBe('pending')
    expect(item.direction).toBe('received')
  })

  test('reads pending right up to the limit', async () => {
    expect((await read(receive(0, RECEIVE_CONVERSION_PENDING_MS - 1000))).status).toBe('pending')
  })

  test('falls back to its own status at the limit, and the detail keeps the conversion pending', async () => {
    const item = await read(receive(0, RECEIVE_CONVERSION_PENDING_MS))

    expect(item.status).toBe('complete')
    expect(item.conversion?.status).toBe('pending')
  })

  test('a conversion that failed leaves a completed receive, since the sats arrived', async () => {
    const item = await read(receive(2, 60_000))

    expect(item.status).toBe('complete')
    expect(item.conversion?.status).toBe('failed')
  })

  test('a receive with no conversion is not held back', async () => {
    const item = await read({ ...receive(0, 60_000), conversionDetails: undefined })

    expect(item.status).toBe('complete')
  })

  test('a transfer the SDK has not settled stays pending at any age', async () => {
    expect((await read({ ...receive(0, RECEIVE_CONVERSION_PENDING_MS * 2), status: 1 })).status).toBe('pending')
  })
})

// A confirmed send answers pending at once on Lightning (bolt11.rs passes no completion timeout, and
// LNURL has none), and the SDK's poll reports the end of it only as an event (lightning_sender.rs).
describe('following a send to the SDK\'s last word', () => {
  type Listener = { onEvent: (event: unknown) => Promise<void> }
  const COMPLETED = 0
  const PENDING = 1
  const FAILED = 2
  const ID = 'pay-1'
  const row = (status: number, id = ID) => ({
    id,
    paymentType: PaymentType.Send,
    status,
    amount: 1000n,
    fees: 0n,
    timestamp: 1n,
    method: 1,
  })
  const word = (tag: string, status: number, id = ID) => ({ tag, inner: { payment: row(status, id) } })
  const succeeded = (id?: string) => word(SdkEvent_Tags.PaymentSucceeded, COMPLETED, id)
  const failed = (id?: string) => word(SdkEvent_Tags.PaymentFailed, FAILED, id)

  let listener: Listener | null

  // Connected before the clock stops, since the connect itself needs real time.
  beforeEach(() => {
    listener = null
    sdk.addEventListener.mockImplementation(async (l: Listener) => {
      listener = l
      return 'send_listener'
    })
    sdk.getPayment.mockResolvedValue({ payment: row(PENDING) })
    sdk.sendPayment.mockResolvedValue({ payment: row(PENDING) })
    sdk.lnurlPay.mockResolvedValue({ payment: row(PENDING), successAction: undefined })
    jest.mocked(getActiveWalletId).mockResolvedValue('primary')
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
    sdk.addEventListener.mockReset()
    sdk.getPayment.mockReset()
  })

  async function confirmed(): Promise<string> {
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('pending')
    return quote.handle
  }

  async function follow(): Promise<{ answer: () => string | null }> {
    const handle = await confirmed()
    let answered: string | null = null
    sparkFollowSend(handle).then(status => {
      answered = status
    })
    await jest.advanceTimersByTimeAsync(0)
    return { answer: () => answered }
  }

  test('the event for this payment is the only word that counts', () => {
    expect(sendOutcomeFromEvent(succeeded() as never, ID)).toBe('complete')
    expect(sendOutcomeFromEvent(failed() as never, ID)).toBe('failed')
    expect(sendOutcomeFromEvent(succeeded('other') as never, ID)).toBeNull()
    expect(sendOutcomeFromEvent(failed('other') as never, ID)).toBeNull()
    expect(sendOutcomeFromEvent(word(SdkEvent_Tags.PaymentPending, PENDING) as never, ID)).toBeNull()
    expect(sendOutcomeFromEvent({ tag: SdkEvent_Tags.Synced } as never, ID)).toBeNull()
  })

  test('with no word in the wait it stays pending, not a moment before the wait ends', async () => {
    const { answer } = await follow()

    await jest.advanceTimersByTimeAsync(SEND_WAIT_MS - 1)
    expect(answer()).toBeNull()
    await jest.advanceTimersByTimeAsync(1)
    expect(answer()).toBe('pending')
  })

  test.each([
    ['succeeded', succeeded, 'complete'],
    ['failed', failed, 'failed'],
  ])('a payment that %s in the wait answers at once and stops listening', async (_, event, expected) => {
    const { answer } = await follow()

    await listener?.onEvent(event())
    await jest.advanceTimersByTimeAsync(0)

    expect(answer()).toBe(expected)
    expect(sdk.removeEventListener).toHaveBeenCalledWith('send_listener')
  })

  test('another payment finishing says nothing about this one', async () => {
    const { answer } = await follow()

    await listener?.onEvent(succeeded('other'))
    await listener?.onEvent(failed('other'))
    await jest.advanceTimersByTimeAsync(0)

    expect(answer()).toBeNull()
  })

  // The word came between the send's return and the subscription, so no event will carry it.
  test.each([
    ['settled', COMPLETED, 'complete'],
    ['failed', FAILED, 'failed'],
  ])('a payment that already %s before the listener is read back', async (_, status, expected) => {
    sdk.getPayment.mockResolvedValue({ payment: row(status) })

    const { answer } = await follow()

    expect(answer()).toBe(expected)
    expect(sdk.getPayment).toHaveBeenCalledTimes(1)
    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: ID })
  })

  test('the read comes after the subscription, or the gap between them stays open', async () => {
    await follow()

    expect(sdk.addEventListener.mock.invocationCallOrder[0]).toBeLessThan(
      sdk.getPayment.mock.invocationCallOrder[0],
    )
  })

  test('a read that fails offline stays pending and keeps listening', async () => {
    sdk.getPayment.mockRejectedValue(new Error('offline'))

    const { answer } = await follow()
    await jest.advanceTimersByTimeAsync(SEND_WAIT_MS)
    expect(answer()).toBe('pending')
  })

  test('a word that lands while the subscription is still being made is not lost', async () => {
    let subscribed: (id: string) => void = () => undefined
    sdk.addEventListener.mockImplementation((l: Listener) => {
      listener = l
      return new Promise(resolve => {
        subscribed = resolve
      })
    })

    const { answer } = await follow()
    await listener?.onEvent(failed())
    await jest.advanceTimersByTimeAsync(0)
    expect(answer()).toBe('failed')

    subscribed('send_listener')
    await jest.advanceTimersByTimeAsync(0)
    expect(sdk.removeEventListener).toHaveBeenCalledWith('send_listener')
  })

  test('the wait ends with the screen\'s own listener removed, since the record follows from there', async () => {
    const { answer } = await follow()
    await jest.advanceTimersByTimeAsync(SEND_WAIT_MS)

    expect(answer()).toBe('pending')
    expect(sdk.removeEventListener).toHaveBeenCalledWith('send_listener')
  })

  test('a handle the last confirm did not leave pending has nothing to follow', async () => {
    await confirmed()

    expect(await sparkFollowSend('some-other-handle')).toBe('pending')
    expect(sdk.addEventListener).not.toHaveBeenCalled()
  })

  test('an LNURL pay is followed the same way', async () => {
    sdk.parse.mockResolvedValue({ tag: 'LnurlPay', inner: [{ minSendable: 1000n, maxSendable: 1_000_000n, commentAllowed: 0, domain: 'x' }] })
    const ln = await sparkParseLnurlPay('alice@example.com')
    const quote = await sparkPrepareLnurlPay(ln.handle, 5000)
    expect((await sparkConfirmLnurlPay(quote.handle)).status).toBe('pending')

    const answer = sparkFollowSend(quote.handle)
    await jest.advanceTimersByTimeAsync(0)
    await listener?.onEvent(succeeded())

    expect(await answer).toBe('complete')
  })

  test('a confirm that came back settled leaves nothing to follow', async () => {
    sdk.sendPayment.mockResolvedValue({ payment: row(COMPLETED) })
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('complete')

    expect(await sparkFollowSend(quote.handle)).toBe('pending')
    expect(sdk.addEventListener).not.toHaveBeenCalled()
  })
})

// A send the screen left on the way is followed by the wallet's record to its end, however late, and
// its end is told once, on the wallet that sent it, only as the SDK reported it.
describe('a send left pending, followed to its end however late', () => {
  type Listener = { onEvent: (event: unknown) => Promise<void> }
  const COMPLETED = 0
  const PENDING = 1
  const FAILED = 2
  const ID = 'pay-held'
  const RECORD = '/mock/Documents/pending-sends-primary.json'
  const row = (status: number, id = ID, paymentType = PaymentType.Send) => ({
    id,
    paymentType,
    status,
    amount: 1000n,
    fees: 0n,
    timestamp: 1n,
    method: 1,
  })
  // What the record above says: 1000 sats over Spark (method 1, no details).
  const FACTS = { sat: 1000, rail: 'spark' }
  const word = (tag: string, status: number, id = ID, paymentType = PaymentType.Send) => ({
    tag,
    inner: { payment: row(status, id, paymentType) },
  })
  const succeeded = (id?: string) => word(SdkEvent_Tags.PaymentSucceeded, COMPLETED, id)
  const failed = (id?: string) => word(SdkEvent_Tags.PaymentFailed, FAILED, id)

  let listeners: Listener[] = []
  const told = jest.fn()
  let stopHearing: () => void = () => undefined

  const flush = async () => {
    for (let i = 0; i < 20; i++) {
      await new Promise(resolve => setImmediate(resolve))
    }
  }
  // The connection's own listener, the first one a connect registers.
  const connectionHears = async (event: unknown) => {
    await listeners[0].onEvent(event)
    await flush()
  }
  const everyoneHears = async (event: unknown) => {
    for (const l of [...listeners]) {
      await l.onEvent(event)
    }
    await flush()
  }
  const resumed = async () => {
    sparkNoteResumed()
    await flush()
  }

  async function reconnect(): Promise<void> {
    await disconnectSpark()
    listeners = []
    await connectSpark(MNEMONIC)
    await flush()
  }

  beforeEach(async () => {
    sdk.addEventListener.mockImplementation(async (l: Listener) => {
      listeners.push(l)
      return `listener_${listeners.length}`
    })
    sdk.getPayment.mockResolvedValue({ payment: row(PENDING) })
    sdk.sendPayment.mockResolvedValue({ payment: row(PENDING) })
    sdk.getInfo.mockResolvedValue({ identityPubkey: '', balanceSats: 0n, tokenBalances: new Map() })
    jest.mocked(getActiveWalletId).mockResolvedValue('primary')
    await reconnect()
    told.mockClear()
    stopHearing = onSendSettled(told)
  })
  afterEach(() => {
    stopHearing()
    jest.useRealTimers()
    jest.restoreAllMocks()
    sdk.addEventListener.mockReset()
    sdk.getPayment.mockReset()
  })

  async function leftPending(): Promise<string> {
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('pending')
    await flush()
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [ID] })
    return quote.handle
  }

  test('an end is told complete only when the SDK reports that payment Completed', async () => {
    await leftPending()

    await connectionHears(succeeded('another-send'))
    await connectionHears(word(SdkEvent_Tags.PaymentPending, PENDING))
    expect(told).not.toHaveBeenCalled()

    await connectionHears(succeeded())
    expect(told.mock.calls).toEqual([['complete', FACTS]])
  })

  test('a failure is told failed, never complete', async () => {
    await leftPending()

    await connectionHears(failed())

    expect(told.mock.calls).toEqual([['failed', FACTS]])
  })

  test('a read on return from the background tells what the SDK stored', async () => {
    await leftPending()
    sdk.getPayment.mockResolvedValue({ payment: row(FAILED) })

    await resumed()

    expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: ID })
    expect(told.mock.calls).toEqual([['failed', FACTS]])
  })

  // The card names what the record says: the rail, sats, or a token in its own unit, and a token the
  // record left without metadata is never passed off as sats.
  test.each([
    ['a Lightning send', { method: 0, details: { tag: 'Lightning', inner: {} } }, { sat: 1000, rail: 'lightning' }],
    ['an on-chain send', { method: 4, details: undefined }, { sat: 1000, rail: 'bitcoin' }],
    [
      'a USDB send',
      {
        amount: 10_000_000n,
        details: { tag: 'Token', inner: { metadata: { identifier: USDB.identifier, ticker: 'USDB', decimals: 6 } } },
      },
      { sat: 10_000_000, rail: 'spark', asset: { assetId: USDB.identifier, amount: '10' } },
    ],
    ['a token send with no metadata', { method: 2, details: undefined }, { sat: 1000, rail: 'spark', tokenUnread: true }],
    // The Spark transfer only carries a send past Spark to its provider, so its rail is not the send's.
    ...['Orchestra', 'Boltz'].map(provider => [
      `a send past Spark through ${provider}`,
      {
        details: {
          tag: 'Spark',
          inner: {
            conversionInfo: {
              tag: provider,
              inner: { chain: 'base', asset: 'USDC', recipientAddress: '0xr', estimatedOut: 5_000_000n, assetDecimals: 6 },
            },
          },
        },
      },
      { sat: 1000, crossChain: true },
    ]),
  ] as [string, object, object][])('N1: %s is told with the record\'s own facts', async (_name, fields, facts) => {
    await leftPending()

    await connectionHears({
      tag: SdkEvent_Tags.PaymentSucceeded,
      inner: { payment: { ...row(COMPLETED), ...fields } },
    })

    expect(told.mock.calls).toEqual([['complete', facts]])
  })

  // An invoice can be paid over Spark, so the screen reads the rail from the record by its handle.
  test('the rail a confirm\'s record names is kept by its handle for the screen', async () => {
    sdk.sendPayment.mockResolvedValue({ payment: { ...row(COMPLETED), method: 0, details: { tag: 'Spark', inner: {} } } })
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('complete')

    expect(sparkSentRail(quote.handle)).toBe('spark')
    expect(sparkSentRail('some-other-handle')).toBeUndefined()
  })

  test('a payment of the same id that is no send tells nothing', async () => {
    await leftPending()

    await connectionHears(word(SdkEvent_Tags.PaymentSucceeded, COMPLETED, ID, PaymentType.Receive))

    expect(told).not.toHaveBeenCalled()
  })

  test('nothing is told while the SDK holds the send pending, across a return and a restart', async () => {
    await leftPending()

    await resumed()
    await reconnect()
    expect(told).not.toHaveBeenCalled()
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [ID] })

    // The first sync of a connect stores an end without an event, so the read at its Synced tells it.
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })
    await connectionHears({ tag: SdkEvent_Tags.Synced })
    expect(told.mock.calls).toEqual([['complete', FACTS]])
  })

  test('one end is told once, through two events, a read and a reconnect', async () => {
    await leftPending()
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })

    await connectionHears(succeeded())
    await connectionHears(succeeded())
    await resumed()
    await reconnect()
    await connectionHears(succeeded())

    expect(told).toHaveBeenCalledTimes(1)
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [] })
  })

  test('an end the screen showed in its wait is not told again', async () => {
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('pending')
    const answer = sparkFollowSend(quote.handle)
    await flush()

    await everyoneHears(succeeded())
    expect(await answer).toBe('complete')
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })
    await resumed()
    await reconnect()

    expect(told).not.toHaveBeenCalled()
  })

  test('past the screen\'s wait the record tells the end, once', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate'] })
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('pending')
    const answer = sparkFollowSend(quote.handle)
    await flush()
    await jest.advanceTimersByTimeAsync(SEND_WAIT_MS)
    expect(await answer).toBe('pending')

    await everyoneHears(failed())
    await everyoneHears(failed())

    expect(told.mock.calls).toEqual([['failed', FACTS]])
  })

  test('with another wallet active nothing is told, and the send waits for its own wallet', async () => {
    await leftPending()
    jest.mocked(getActiveWalletId).mockResolvedValue('another')

    await connectionHears(succeeded())
    expect(told).not.toHaveBeenCalled()

    jest.mocked(getActiveWalletId).mockResolvedValue('primary')
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })
    await resumed()
    expect(told.mock.calls).toEqual([['complete', FACTS]])
  })

  test('a registry that cannot say who is active tells nothing and keeps the send', async () => {
    await leftPending()
    jest.mocked(getActiveWalletId).mockRejectedValue(new Error('unreadable'))

    await connectionHears(succeeded())

    expect(told).not.toHaveBeenCalled()
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [ID] })
  })

  test('a connection that was replaced tells nothing', async () => {
    await leftPending()
    const replaced = listeners[0]
    await reconnect()

    await replaced.onEvent(succeeded())
    await flush()

    expect(told).not.toHaveBeenCalled()
  })

  test('a torn record tells nothing, keeps its bytes and is rebuilt from the SDK\'s pending sends', async () => {
    const torn = '{"version":1,"walletId":"primary","sends":["pay-'
    await RNFS.writeFile(RECORD, torn, 'utf8')
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })
    sdk.listPayments.mockResolvedValueOnce({ payments: [row(PENDING, 'still-out')] })

    await resumed()
    await connectionHears(succeeded())

    expect(told).not.toHaveBeenCalled()
    expect(await RNFS.readFile(`${RECORD}.unreadable`, 'utf8')).toBe(torn)
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: ['still-out'] })
    expect(sdk.listPayments).toHaveBeenCalledWith(
      expect.objectContaining({ typeFilter: [PaymentType.Send], statusFilter: [PENDING] }),
    )
  })

  // A listener's rejection reaches Rust as a panic in a library built to abort.
  const unreadable = {
    tag: SdkEvent_Tags.PaymentSucceeded,
    get inner(): never {
      throw new Error('no payment')
    },
  }

  test('an event whose payment cannot be read resolves, tells nothing and keeps the send', async () => {
    await leftPending()

    await expect(listeners[0].onEvent(unreadable)).resolves.toBeUndefined()
    await flush()
    expect(told).not.toHaveBeenCalled()
    expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [ID] })

    await connectionHears(succeeded())
    expect(told.mock.calls).toEqual([['complete', FACTS]])
  })

  test('the screen\'s own listener resolves on an unreadable event and still hears the end', async () => {
    const quote = await sparkPrepareSend('lnbc1invoice')
    expect(await sparkConfirmSend(quote.handle)).toBe('pending')
    const answer = sparkFollowSend(quote.handle)
    await flush()
    const screens = listeners.at(-1)!
    expect(screens).not.toBe(listeners[0])

    await expect(screens.onEvent(unreadable)).resolves.toBeUndefined()
    await everyoneHears(succeeded())

    expect(await answer).toBe('complete')
  })

  test('a read the platform refuses tells nothing, touches nothing, and loses nothing', async () => {
    await leftPending()
    const before = await RNFS.readFile(RECORD, 'utf8')
    const read = RNFS.readFile
    jest
      .spyOn(RNFS, 'readFile')
      .mockImplementation((path: string, encoding?: string) =>
        path === RECORD ? Promise.reject(new Error('EACCES')) : read(path, encoding),
      )
    sdk.getPayment.mockResolvedValue({ payment: row(COMPLETED) })

    await resumed()
    await connectionHears(succeeded())
    expect(told).not.toHaveBeenCalled()

    jest.restoreAllMocks()
    expect(await RNFS.readFile(RECORD, 'utf8')).toBe(before)
    await resumed()
    expect(told.mock.calls).toEqual([['complete', FACTS]])
  })

  // A recorded send the SDK's storage holds no row for would be read on every sweep for good. The
  // SDK drops a failed write of a payment, so the missing row is proof only once a sync with no
  // reported failure was heard, before the read and still after it, and only for a send noted by an
  // earlier process, since a send noted by this one can postdate every sync it heard.
  describe('a send the SDK holds no row for', () => {
    const EARLIER = 'pay-earlier'
    const OTHER = 'pay-other'
    const NO_ROWS = 'Underlying implementation error: Query returned no rows'
    const unknown = () => new SdkError.StorageError(NO_ROWS)
    const recorded = (ids: string[]) =>
      RNFS.writeFile(RECORD, JSON.stringify({ version: 1, walletId: 'primary', sends: ids }))
    const synced = () => connectionHears({ tag: SdkEvent_Tags.Synced })
    const failedSync = () => {
      sdk.getInfo.mockResolvedValueOnce({
        identityPubkey: '',
        balanceSats: 0n,
        tokenBalances: new Map(),
        lastSyncError: { message: 'unreachable' },
      })
      return synced()
    }

    test('leaves the record once a sync with no failure was heard, and tells nothing', async () => {
      await recorded([EARLIER, OTHER])
      sdk.getPayment.mockImplementation(async ({ paymentId }: { paymentId: string }) => {
        if (paymentId === EARLIER) {
          throw unknown()
        }
        return { payment: row(PENDING, paymentId) }
      })

      await synced()

      expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: EARLIER })
      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [OTHER] })
      expect(told).not.toHaveBeenCalled()
    })

    test('is kept at connect, after a sync that reported a failure, and on a return', async () => {
      await recorded([EARLIER])
      sdk.getPayment.mockRejectedValue(unknown())

      await reconnect()
      await failedSync()
      await resumed()

      expect(sdk.getPayment).toHaveBeenCalledTimes(2)
      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [EARLIER] })
      expect(told).not.toHaveBeenCalled()
    })

    test.each([
      ['the same text under another tag', () => new SdkError.Generic(NO_ROWS)],
      ['another storage error', () => new SdkError.StorageError('Connection error: locked')],
      ['the same text in a plain error', () => new Error(NO_ROWS)],
      ['a storage tag on no SdkError', () => ({ tag: 'StorageError', inner: [NO_ROWS] })],
      ['a failure offline', () => new Error('offline')],
    ])('%s keeps the send after a good sync', async (_, failure) => {
      await recorded([EARLIER])
      sdk.getPayment.mockRejectedValue(failure())

      await synced()

      expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: EARLIER })
      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [EARLIER] })
    })

    test('a send this process noted is kept, even after a good sync', async () => {
      await leftPending()
      sdk.getPayment.mockRejectedValue(unknown())

      await synced()

      expect(sdk.getPayment).toHaveBeenCalledWith({ paymentId: ID })
      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [ID] })
      expect(told).not.toHaveBeenCalled()
    })

    // The sync may store the send after the storage answered, as the read after it shows.
    test('a read begun before the sync is no proof, though the sync lands meanwhile', async () => {
      await recorded([EARLIER])
      let answer!: (cause: unknown) => void
      sdk.getPayment
        .mockReturnValueOnce(new Promise((_, reject) => (answer = reject)))
        .mockResolvedValue({ payment: row(PENDING, EARLIER) })

      await resumed()
      await synced()
      expect(sdk.getPayment).toHaveBeenCalledTimes(2)
      answer(unknown())
      await flush()

      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [EARLIER] })
    })

    test('a failure reported while the read runs is no proof', async () => {
      await recorded([EARLIER])
      let answer!: (cause: unknown) => void
      sdk.getPayment.mockReturnValueOnce(new Promise((_, reject) => (answer = reject)))

      await synced()
      expect(sdk.getPayment).toHaveBeenCalledTimes(1)
      await failedSync()
      answer(unknown())
      await flush()

      expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [EARLIER] })
    })
  })
})
