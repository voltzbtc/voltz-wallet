import {
  PREFER_SPARK_ROUTE,
  nothingArrives,
  payeeNote,
  routedQuote,
  sendReceives,
  sendTotal,
  takesSparkRoute,
} from '../src/wallet/sendAll'
import type { SparkSendQuote } from '../src/wallet/spark'

const tier = (totalSat: number) => ({ minerSat: 0, sparkSat: 0, totalSat })
const onchainFees = { fast: tier(300), medium: tier(200), slow: tier(100), estimate: false }

describe('sendTotal', () => {
  test('adds the fee to a plain send', () => {
    expect(sendTotal({ handle: 'h', amount: 1000, fee: 10 }, 'medium')).toBe(1010)
  })

  test('adds the speed chosen on-chain', () => {
    expect(sendTotal({ handle: 'h', amount: 1000, fee: undefined, onchainFees }, 'fast')).toBe(1300)
  })

  test('adds nothing with fees included', () => {
    const quote: SparkSendQuote = { handle: 'h', amount: 1000, fee: 10, feesIncluded: true, receives: 990 }
    expect(sendTotal(quote, 'medium')).toBe(1000)
    expect(sendTotal({ ...quote, fee: undefined, onchainFees }, 'fast')).toBe(1000)
  })
})

describe('sendReceives', () => {
  test('has nothing to say about a plain send', () => {
    expect(sendReceives({ handle: 'h', amount: 1000, fee: 10 }, 'medium')).toBeUndefined()
  })

  test('takes the figure the quote carries', () => {
    expect(sendReceives({ handle: 'h', amount: 1000, fee: 10, feesIncluded: true, receives: 980 }, 'fast')).toBe(980)
  })

  test('follows the speed on-chain', () => {
    const quote: SparkSendQuote = { handle: 'h', amount: 1000, fee: undefined, onchainFees, feesIncluded: true }
    expect(sendReceives(quote, 'fast')).toBe(700)
    expect(sendReceives(quote, 'slow')).toBe(900)
  })
})

// A vector the SDK's own tests parse (crates/spark/src/silent_payment.rs).
const SILENT_PAYMENT =
  'sp1qqgste7k9hx0qftg6qmwlkqtwuy6cycyavzmzj85c6qdfhjdpdjtdgqjuexzk6murw56suy3e0rd2cgqvycxttddwsvgxe2usfpxumr70xc9pkqwv'

describe('nothingArrives', () => {
  const P2WPKH = 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'
  const P2TR = 'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297'
  const net = (left: number): SparkSendQuote => ({
    handle: 'h',
    amount: left + (onchainFees?.medium.totalSat ?? 0),
    fee: undefined,
    onchainFees,
    feesIncluded: true,
  })

  test('a net at or under zero', () => {
    const quote: SparkSendQuote = { handle: 'h', amount: 200, fee: undefined, onchainFees, feesIncluded: true }
    expect(nothingArrives(quote, 'medium', P2WPKH)).toBe(true)
    expect(nothingArrives(quote, 'fast', P2WPKH)).toBe(true)
  })

  test.each([
    [P2WPKH, 293, true],
    [P2WPKH, 294, false],
    [P2TR, 329, true],
    [P2TR, 330, false],
    [SILENT_PAYMENT, 329, true],
    [SILENT_PAYMENT, 330, false],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 545, true],
    ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', 546, false],
  ])('at %s a net of %i is %s under the limit the SDK sends by', (address, left, under) => {
    expect(nothingArrives(net(left), 'medium', address)).toBe(under)
  })

  test('never a plain send', () => {
    expect(nothingArrives({ handle: 'h', amount: 0, fee: 0 }, 'medium', P2WPKH)).toBe(false)
  })

  test('a send with fees included off the chain holds to zero alone', () => {
    const lightning: SparkSendQuote = { handle: 'h', amount: 50, fee: 40, feesIncluded: true, receives: 10 }
    expect(nothingArrives(lightning, 'medium', 'lnbc1invoice')).toBe(false)
  })
})

describe('the Spark route', () => {
  const invoice: SparkSendQuote = { handle: 'h', amount: 1000, fee: 7, sparkRouteFeeSat: 0 }

  test('ships off, until a third party is seen paid over it', () => {
    expect(PREFER_SPARK_ROUTE).toBe(false)
  })

  test('is taken only when asked for and the invoice allows it', () => {
    expect(takesSparkRoute(invoice, true)).toBe(true)
    expect(takesSparkRoute(invoice, false)).toBe(false)
    expect(takesSparkRoute({ handle: 'h', amount: 1000, fee: 7 }, true)).toBe(false)
  })

  test('prices the quote on the route taken', () => {
    expect(routedQuote(invoice, true).fee).toBe(0)
    expect(sendTotal(routedQuote(invoice, true), 'medium')).toBe(1000)
  })

  test('leaves the Lightning quote alone otherwise', () => {
    expect(routedQuote(invoice, false)).toBe(invoice)
    const plain: SparkSendQuote = { handle: 'h', amount: 1000, fee: 7 }
    expect(routedQuote(plain, true)).toBe(plain)
  })

  test('says what arrives on that route with fees included', () => {
    const all: SparkSendQuote = { ...invoice, sparkRouteFeeSat: 3, feesIncluded: true, receives: 993 }
    expect(sendReceives(routedQuote(all, true), 'medium')).toBe(997)
    expect(sendTotal(routedQuote(all, true), 'medium')).toBe(1000)
  })
})

describe('payeeNote', () => {
  test('is the words of a message', () => {
    expect(payeeNote({ kind: 'message', text: 'Thanks!' })).toBe('Thanks!')
  })

  test('is the description of a link and never the link', () => {
    expect(payeeNote({ kind: 'url', url: 'https://x.example', description: 'Your receipt' })).toBe('Your receipt')
    expect(payeeNote({ kind: 'url', url: 'https://x.example', description: '' })).toBeFalsy()
  })

  test('is nothing without an action', () => {
    expect(payeeNote(undefined)).toBeUndefined()
  })
})
