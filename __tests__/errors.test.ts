import { SdkError } from '@breeztech/breez-sdk-spark-react-native'
import {
  classifyWalletError,
  isDepositTooSmall,
  isExpiredInvoiceRefusal,
  isUsedInvoiceRefusal,
} from '../src/wallet/errors'

test('insufficient-funds errors map to insufficientFunds', () => {
  expect(classifyWalletError(new Error('PaymentError.InsufficientFunds: not enough funds'))).toBe(
    'insufficientFunds',
  )
  expect(classifyWalletError('Cannot pay: not enough funds')).toBe('insufficientFunds')
})

test('paying your own wallet maps to selfPayment', () => {
  expect(classifyWalletError(new Error('PaymentError.SelfTransferNotSupported'))).toBe('selfPayment')
  expect(classifyWalletError('Self transfer not supported')).toBe('selfPayment')
})

test('a lapsed cross-chain quote is not an expired invoice', () => {
  expect(classifyWalletError(new Error('Cross-chain quote has expired. Please re-prepare.'))).toBe('quoteExpired')
})

test('an expired invoice maps to expiredInvoice', () => {
  expect(classifyWalletError(new Error('invoice expired'))).toBe('expiredInvoice')
  expect(classifyWalletError('Invoice has expired')).toBe('expiredInvoice')
})

test('a payment timeout maps to timeout, but a network timeout stays offline', () => {
  expect(classifyWalletError(new Error('PaymentError.PaymentTimeout'))).toBe('timeout')
  expect(classifyWalletError('Payment timeout after 60s')).toBe('timeout')
  // A plain connectivity timeout is not a payment ceiling and stays offline.
  expect(classifyWalletError(new Error('network request timeout'))).toBe('offline')
})

test('malformed destinations map to invalidInput', () => {
  expect(classifyWalletError(new Error('invalid invoice'))).toBe('invalidInput')
  expect(classifyWalletError('failed to parse address')).toBe('invalidInput')
  expect(classifyWalletError('unsupported payment method')).toBe('invalidInput')
})

test('connectivity errors map to offline', () => {
  expect(classifyWalletError(new Error('network request timeout'))).toBe('offline')
  expect(classifyWalletError('connection refused')).toBe('offline')
})

test('anything unrecognized falls back to unknown', () => {
  expect(classifyWalletError(new Error('boom'))).toBe('unknown')
  expect(classifyWalletError(null)).toBe('unknown')
  expect(classifyWalletError(undefined)).toBe('unknown')
})

// The binding's cross-chain errors carry the reason in tag and inner; the message is only the class
// name. Shaped the way the generated wrapper builds them.
function sdkError(tag: string, inner: object): Error {
  return Object.assign(new Error(`SdkError.${tag}`), { tag, inner })
}

test('a cross-chain amount refusal says which side of the range it fell on', () => {
  const tooSmall = sdkError('CrossChainAmountOutOfRange', {
    reason: 'amount_too_small',
    tooSmall: true,
    boundAmount: 1200n,
    boundUsdCents: undefined,
  })
  const tooLarge = sdkError('CrossChainAmountOutOfRange', {
    reason: 'amount_exceeds_liquidity',
    tooSmall: false,
    boundAmount: undefined,
    boundUsdCents: 8_980_000n,
  })
  expect(classifyWalletError(tooSmall)).toBe('crossChainTooSmall')
  expect(classifyWalletError(tooLarge)).toBe('crossChainTooLarge')
})

test('a refused route tells a busy network from one that will not take the send', () => {
  const busy = sdkError('CrossChainRouteUnavailable', { reason: 'service_unavailable', temporary: true })
  const refused = sdkError('CrossChainRouteUnavailable', { reason: 'route_disabled', temporary: false })
  expect(classifyWalletError(busy)).toBe('routeBusy')
  expect(classifyWalletError(refused)).toBe('routeUnavailable')
})

// Built as UniffiError and a generated variant build it: the message is only the class name, so
// String(error) holds none of the SDK's words, and those ride frozen in inner[0]. Jest does not transform
// the uniffi package, so the construction is repeated here rather than imported.
class SdkSentence extends Error {
  readonly tag: string
  readonly inner: Readonly<[string]>
  constructor(tag: string, words: string) {
    super(`SdkError.${tag}`)
    this.tag = tag
    this.inner = Object.freeze([words] as [string])
  }
}

describe('an SDK error whose words ride in inner', () => {
  test('hides them from String(), which is what makes the shape matter', () => {
    const error = new SdkSentence('InvalidInput', 'Invoice has expired')
    expect(String(error)).toBe('Error: SdkError.InvalidInput')
    expect(error.message).toBe('SdkError.InvalidInput')
  })

  // cross_chain/boltz.rs:865 and orchestra.rs:2407, an InvalidInput in SDK 0.26.
  test('a lapsed cross-chain quote is told from a bad address', () => {
    const lapsed = new SdkSentence('InvalidInput', 'Cross-chain quote has expired. Please re-prepare.')
    expect(classifyWalletError(lapsed)).toBe('quoteExpired')
  })

  // A send to a Bitcoin address, which nothing here may replace as if it were a cross-chain quote.
  test('a lapsed coop exit fee quote is no cross-chain quote', () => {
    const words = 'Service error: service provider error: graphql error: The coop exit fee quote has expired, please request a new quote.'
    expect(classifyWalletError(new SdkSentence('SparkError', words))).toBe('unknown')
  })

  // sdk/payments/validation.rs:30.
  test('an expired invoice is told from a bad address', () => {
    expect(classifyWalletError(new SdkSentence('InvalidInput', 'Invoice has expired'))).toBe('expiredInvoice')
  })

  test('only the sentence itself is the refusal that clears a send of doubt', () => {
    expect(isExpiredInvoiceRefusal(new SdkSentence('InvalidInput', 'Invoice has expired'))).toBe(true)
    expect(isExpiredInvoiceRefusal(new SdkSentence('SparkError', 'quote has expired'))).toBe(false)
    expect(isExpiredInvoiceRefusal(new Error('invoice expired'))).toBe(false)
  })

  // utils/fees.rs:13 and sdk/lnurl/pay.rs:203.
  test.each(['Fee increased since prepare. Please retry.', 'Fee increased between queries. Please retry.'])(
    'a fee that rose reads as such: %s',
    words => {
      expect(classifyWalletError(new SdkSentence('Generic', words))).toBe('feeIncreased')
    },
  )

  // spark-wallet/src/error.rs:20, carried by the catch-all in From<SparkWalletError>.
  test('paying the wallet itself reads as such', () => {
    expect(classifyWalletError(new SdkSentence('SparkError', 'Self payment not allowed'))).toBe('selfPayment')
  })

  test('a variant with nothing the rules name stays as its name reads', () => {
    expect(classifyWalletError(new SdkSentence('InvalidInput', 'Amount must be positive'))).toBe('invalidInput')
    expect(classifyWalletError(new SdkSentence('Generic', 'Duplicate transfer'))).toBe('unknown')
  })

  // A body is a server's wording, and the variant already says what went wrong.
  test('a server body in a NetworkError never reads as a cause of its own', () => {
    const body = 'network request failed with status 403: {"error":"domain_expired"}'
    expect(classifyWalletError(new SdkSentence('NetworkError', body))).toBe('offline')
  })

  test('a keyword in an internal sentence names no cause', () => {
    expect(classifyWalletError(new SdkSentence('Generic', 'Invalid public key bytes'))).toBe('unknown')
    expect(classifyWalletError(new SdkSentence('Generic', 'Timeout while polling'))).toBe('unknown')
  })
})

// Every binding error carries a tag, so reading tags must not swallow the ones classified by text.
test('other tagged SDK errors still classify by their text', () => {
  expect(classifyWalletError(sdkError('NetworkError', {}))).toBe('offline')
  expect(classifyWalletError(sdkError('Generic', { reason: 'unavailable' }))).toBe('unknown')
})

test('a fee that rose between the two LNURL queries has its own code', () => {
  expect(classifyWalletError('Generic: Fee increased between queries. Please retry.')).toBe('feeIncreased')
})

// The handlers of buildonspark/spark on main at 467d389, as an old client meets them. The binding's
// message is only the class name, and the words ride in inner[0].
describe('the operators asking for a newer client', () => {
  const said = (tag: string, words: string): Error =>
    Object.assign(new Error(`SdkError.${tag}`), { tag, inner: [words] })

  test.each([
    ['transfer_handler.go', 'DirectRefundTxSigningJob is required. Please upgrade to the latest SDK version'],
    ['coop_exit_handler.go', 'connector tx required for cooperative exit validation. Please upgrade to the latest SDK version'],
    ['tree_creation_handler.go', 'field DirectNodeTxSigningJob is required. Please upgrade to the latest SDK version'],
  ])('%s maps to updateApp', (_file, words) => {
    expect(classifyWalletError(said('SparkError', words))).toBe('updateApp')
  })

  test('a sentence opening with "invalid" stays updateApp, since the rule for invalid comes later', () => {
    const words = 'invalid request: directNodeTxSigningJob is required. Please upgrade to the latest SDK version'
    expect(classifyWalletError(said('SparkError', words))).toBe('updateApp')
  })

  test('so does one inside a variant whose name says invalid', () => {
    const words = 'DirectFromCpfpRefundTxSigningJob is required. Please upgrade to the latest SDK version'
    expect(classifyWalletError(said('InvalidInput', words))).toBe('updateApp')
  })

  test('a plain string carrying the sentence maps too', () => {
    expect(classifyWalletError('Please upgrade to the latest SDK version')).toBe('updateApp')
  })

  test.each([
    'Please upgrade to the latest version',
    'upgrade your plan',
    'the latest SDK is required',
    'SDK upgrade in progress',
  ])('a near sentence is not it: %s', words => {
    expect(classifyWalletError(said('SparkError', words))).toBe('unknown')
  })

  test('an invalid input with no such sentence stays what it was', () => {
    expect(classifyWalletError(said('InvalidInput', 'bad address'))).toBe('invalidInput')
  })
})

test('a claim refused as too small is told by its tag, and nothing else is', () => {
  expect(isDepositTooSmall(new SdkError.DepositTooSmall({ tx: 'a', vout: 0, docsUrl: 'https://doc' }))).toBe(true)
  expect(isDepositTooSmall({ tag: 'Generic', inner: ['DepositTooSmall'] })).toBe(false)
  expect(isDepositTooSmall(new Error('DepositTooSmall'))).toBe(false)
  expect(isDepositTooSmall('DepositTooSmall')).toBe(false)
  expect(isDepositTooSmall(undefined)).toBe(false)
})

// The SDK's display of each, built the way the binding carries it: the class name in the message and
// the sentence in inner[0].
describe('refusals the SDK gives no variant of its own', () => {
  // tonic 0.12 renders a gRPC status as "status: <Code>, message: ...", which the wallet's wrappers
  // prefix with their own names before SdkError::SparkError takes the whole display.
  const alreadyExists =
    'Service error: service connection error: Connection error: status: AlreadyExists, message: "preimage request already exists", details: [], metadata: MetadataMap { headers: {} }'

  test('an invoice the operators already hold a payment for is told by the status in its words', () => {
    expect(isUsedInvoiceRefusal(new SdkSentence('SparkError', alreadyExists))).toBe(true)
  })

  test.each([
    ['another variant', new SdkSentence('Generic', alreadyExists)],
    ['another status', new SdkSentence('SparkError', alreadyExists.replace('AlreadyExists', 'NotFound'))],
    ['the words outside inner', new Error(`SdkError.SparkError: ${alreadyExists}`)],
    ['a longer status name', new SdkSentence('SparkError', 'status: AlreadyExistsElsewhere, message: ""')],
  ])('%s is no such refusal', (_, cause) => {
    expect(isUsedInvoiceRefusal(cause)).toBe(false)
  })

  // An already used invoice is no code of its own, since AlreadyExists also answers operations that
  // are not an invoice; only Send, which knows the destination, names it.
  test('classifying it keeps the unknown code', () => {
    expect(classifyWalletError(new SdkSentence('SparkError', alreadyExists))).toBe('unknown')
  })

  // common/src/lnurl/error.rs, EndpointError, as the server's LUD-06 reason follows the prefix.
  test('a refusal from an LNURL server is its own code', () => {
    expect(classifyWalletError(new SdkSentence('LnurlError', 'endpoint error: Amount too small'))).toBe(
      'lnurlRefused',
    )
  })

  test.each([
    'endpoint error: Fee increased since prepare',
    'endpoint error: Invoice has expired',
    'endpoint error: Please upgrade to the latest SDK version',
    'endpoint error: self payment',
  ])('the server\'s words never pick another reason: %s', words => {
    expect(classifyWalletError(new SdkSentence('LnurlError', words))).toBe('lnurlRefused')
  })

  test('an LNURL server out of reach is no refusal', () => {
    const silent = new SdkSentence('LnurlError', 'error calling lnurl endpoint: Timeout error: request timed out')
    expect(classifyWalletError(silent)).not.toBe('lnurlRefused')
    expect(classifyWalletError(new SdkSentence('Generic', 'endpoint error: no'))).not.toBe('lnurlRefused')
  })

  // spark-wallet wallet.rs, select_leaves_with_retry, through the tree service's Generic.
  test('leaves that could not be reserved are a balance still updating', () => {
    const words = 'Tree service error: generic error: Failed to select leaves after all retries'
    expect(classifyWalletError(new SdkSentence('SparkError', words))).toBe('balanceSettling')
    expect(classifyWalletError(new SdkSentence('Generic', words))).toBe('unknown')
  })
})
