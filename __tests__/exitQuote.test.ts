import {
  arrivingSat,
  exitArriving,
  childFits,
  fundingCoins,
  fundingNeededSat,
  LEAST_RELAYED_SAT,
  MAX_FUNDING_COINS,
  mayGoOn,
  paysAboveRelay,
  planArriving,
  QUOTE_LIFE_MS,
  quoteIsOld,
  quoteVerdict,
  txOutputsSat,
  txVbytes,
} from '../src/wallet/exitQuote'
import { cpfpChildHex, planOf, quoteOf, recoveryOf } from './support/exitFixtures'

const COOPERATIVE = 0
const UNILATERAL = 1
const leaf = (valueSats: bigint, method: number) => ({ leafId: `l${valueSats}`, valueSats, method })

// One input of 36 bytes with an empty script, in the wire format.
const LE = (value: bigint, bytes: number): string => {
  const hex = value.toString(16).padStart(bytes * 2, '0')
  return (hex.match(/../g) as string[]).reverse().join('')
}
const output = (value: number, scriptBytes = 22): string =>
  LE(BigInt(value), 8) + scriptBytes.toString(16).padStart(2, '0') + '00'.repeat(scriptBytes)
const INPUT = '11'.repeat(32) + '00000000' + '00' + 'ffffffff'
const WITNESS = '02' + '01aa' + '01bb'
const legacyTx = (...outputs: string[]): string =>
  '02000000' + '01' + INPUT + outputs.length.toString(16).padStart(2, '0') + outputs.join('') + '00000000'
const segwitTx = (...outputs: string[]): string =>
  '02000000' + '0001' + '01' + INPUT + outputs.length.toString(16).padStart(2, '0') + outputs.join('') + WITNESS + '00000000'

describe('reading the outputs of a transaction', () => {
  test.each([
    ['segwit', segwitTx(output(546), output(1_000_000))],
    ['legacy', legacyTx(output(546), output(1_000_000))],
  ])('%s gives each value', (_name, hex) => {
    expect(txOutputsSat(hex)).toEqual([546, 1_000_000])
  })

  test('a value past 32 bits comes back whole', () => {
    expect(txOutputsSat(segwitTx(output(2_100_000_000_000_000)))).toEqual([2_100_000_000_000_000])
  })

  test('a script longer than one byte of length is walked past', () => {
    const long = LE(5_000n, 8) + 'fd' + LE(300n, 2) + '00'.repeat(300)
    expect(txOutputsSat(segwitTx(long, output(700)))).toEqual([5_000, 700])
  })

  test.each([
    ['no hex at all', ''],
    ['a stub', 'aabb'],
    ['a transaction cut in the outputs', segwitTx(output(900)).slice(0, 110)],
  ])('%s is not a transaction', (_name, hex) => {
    expect(txOutputsSat(hex)).toBeNull()
  })

  test('the limit is on every output, and hex that cannot be read fails it', () => {
    expect(paysAboveRelay(segwitTx(output(LEAST_RELAYED_SAT)))).toBe(true)
    expect(paysAboveRelay(segwitTx(output(LEAST_RELAYED_SAT - 1)))).toBe(false)
    expect(paysAboveRelay(segwitTx(output(10_000), output(100)))).toBe(false)
    expect(paysAboveRelay('aabb')).toBe(false)
  })
})

describe('what nodes will relay', () => {
  test('the limit is the largest dust limit there is', () => {
    expect(LEAST_RELAYED_SAT).toBe(546)
  })

  test('a sweep that leaves exactly the limit passes, and one sat under does not', () => {
    const quote = (sweepFeeSats: bigint) =>
      quoteOf({
        leaves: [leaf(2_000n, UNILATERAL)],
        recoverableValueSats: 2_000n,
        totalFeeSats: 1_000n,
        refundFeeSats: 300n,
        sweepFeeSats,
      })
    expect(quoteVerdict(quote(1_154n))).toBe('thin')
    expect(quoteVerdict(quote(1_155n))).toBe('tooSmall')
  })

  test('a cooperative recovery under the limit is refused though its value beats its fee', () => {
    const quote = quoteOf({
      leaves: [leaf(800n, COOPERATIVE)],
      recoverableValueSats: 800n,
      totalFeeSats: 300n,
      cooperativeFeeSats: 300n,
      sweepFeeSats: 0n,
    })
    expect(quoteVerdict(quote)).toBe('tooSmall')
    expect(mayGoOn('tooSmall')).toBe(false)
  })

  test('a cooperative recovery at exactly the limit passes', () => {
    const quote = (valueSats: bigint) =>
      quoteOf({
        leaves: [leaf(valueSats, COOPERATIVE)],
        recoverableValueSats: valueSats,
        totalFeeSats: 300n,
        cooperativeFeeSats: 300n,
        sweepFeeSats: 0n,
      })
    expect(quoteVerdict(quote(846n))).toBe('thin')
    expect(quoteVerdict(quote(845n))).toBe('tooSmall')
  })

  test('each part with leaves stands alone, so a large sweep does not carry a small cooperative one', () => {
    const quote = quoteOf({
      leaves: [leaf(800n, COOPERATIVE), leaf(100_000n, UNILATERAL)],
      recoverableValueSats: 100_800n,
      totalFeeSats: 3_300n,
      cooperativeFeeSats: 300n,
      sweepFeeSats: 3_000n,
    })
    expect(quoteVerdict(quote)).toBe('tooSmall')
  })

  test('a part with no leaves asks nothing of its fees', () => {
    const quote = quoteOf({
      leaves: [leaf(100_000n, COOPERATIVE)],
      recoverableValueSats: 100_000n,
      totalFeeSats: 300n,
      cooperativeFeeSats: 300n,
      sweepFeeSats: 0n,
    })
    expect(quoteVerdict(quote)).toBe('fine')
  })
})

describe('whether a quote may go on', () => {
  test('a quote with no leaves is empty, whatever its totals', () => {
    expect(quoteVerdict(quoteOf({ leaves: [] }))).toBe('empty')
  })

  test('fees above the value stop it', () => {
    expect(quoteVerdict(quoteOf({ recoverableValueSats: 1_000n, totalFeeSats: 1_001n }))).toBe('notWorth')
  })

  test('fees equal to the value stop it too, since the rule is more than, not as much as', () => {
    expect(quoteVerdict(quoteOf({ recoverableValueSats: 1_000n, totalFeeSats: 1_000n }))).toBe('notWorth')
  })

  test('one sat over the fee goes on, with the warning', () => {
    expect(quoteVerdict(quoteOf({ recoverableValueSats: 1_001n, totalFeeSats: 1_000n }))).toBe('thin')
  })

  test('the warning starts past a fifth of the value', () => {
    expect(quoteVerdict(quoteOf({ recoverableValueSats: 100_000n, totalFeeSats: 20_000n }))).toBe('fine')
    expect(quoteVerdict(quoteOf({ recoverableValueSats: 100_000n, totalFeeSats: 20_001n }))).toBe('thin')
  })
})

describe('what arrives', () => {
  // The doc's own terms: a funded exit with CPFP and fan-out paid from the funding.
  const quote = quoteOf({
    recoverableValueSats: 100_000n,
    totalFeeSats: 12_000n,
    cpfpFeeSats: 8_000n,
    fanoutFeeSats: 1_000n,
    sweepFeeSats: 3_000n,
  })

  test('is the value less the sweep, not less the total fee', () => {
    expect(arrivingSat(quote)).toBe(97_000)
    expect(arrivingSat(quote)).not.toBe(100_000 - 12_000)
  })

  test('takes off every fee that comes from the value, and only those', () => {
    const paidFromValue = quoteOf({
      recoverableValueSats: 100_000n,
      cooperativeFeeSats: 500n,
      refundFeeSats: 700n,
      sweepFeeSats: 3_000n,
    })
    expect(arrivingSat(paidFromValue)).toBe(95_800)
  })

  test('a quote whose fees take everything shows nothing arriving, never a negative figure', () => {
    const refused = quoteOf({ recoverableValueSats: 2_000n, cooperativeFeeSats: 1_000n, sweepFeeSats: 3_000n })
    expect(quoteVerdict(refused)).toBe('notWorth')
    expect(arrivingSat(refused)).toBe(0)
  })
})

test('the funding a quote needs is its single UTXO, or nothing without funding', () => {
  expect(fundingNeededSat(quoteOf())).toBe(15_000)
  expect(fundingNeededSat(quoteOf({ funding: undefined }))).toBe(0)
})

describe('an old quote', () => {
  test('holds up to 30 minutes at the same rate', () => {
    expect(quoteIsOld(0, QUOTE_LIFE_MS, 10n, 10n)).toBe(false)
    expect(quoteIsOld(0, QUOTE_LIFE_MS + 1, 10n, 10n)).toBe(true)
  })

  test('goes as soon as the rate rises, and a lower rate keeps it', () => {
    expect(quoteIsOld(0, 1, 10n, 11n)).toBe(true)
    expect(quoteIsOld(0, 1, 10n, 9n)).toBe(false)
  })
})

describe('the size of a CPFP child', () => {
  // 331 weight units besides the coins and 272 for each, from the SDK's own weight functions.
  test.each([
    [1, 151],
    [13, 967],
    [14, 1_035],
  ])('with %i coins it is %i vbytes', (coins, vbytes) => {
    expect(txVbytes(cpfpChildHex(coins))).toBe(vbytes)
  })

  test('a transaction without witness weighs its bytes, and a witness counts a quarter', () => {
    expect(txVbytes(legacyTx(output(546)))).toBe(82)
    expect(txVbytes(segwitTx(output(546)))).toBe(84)
  })

  test('13 coins is the most the 1,000 vbyte limit of a TRUC child takes', () => {
    expect(MAX_FUNDING_COINS).toBe(13)
    expect(childFits(cpfpChildHex(MAX_FUNDING_COINS))).toBe(true)
    expect(childFits(cpfpChildHex(MAX_FUNDING_COINS + 1))).toBe(false)
  })

  test('hex that does not parse has no size, and fails no child on that alone', () => {
    expect(txVbytes(cpfpChildHex(14).slice(0, -10))).toBeNull()
    expect(txVbytes('beef')).toBeNull()
    expect(txVbytes('xyz')).toBeNull()
    expect(childFits('beef')).toBe(true)
  })
})

describe('the coins a build is handed', () => {
  const coin = (valueSat: number, vout = 0) => ({ txid: 'cd'.repeat(32), vout, valueSat })

  test('are the largest first', () => {
    expect(fundingCoins([coin(1_000, 0), coin(5_000, 1), coin(3_000, 2)], 10n)).toEqual([
      coin(5_000, 1),
      coin(3_000, 2),
      coin(1_000, 0),
    ])
  })

  test('are never more than one child takes, and the largest of them', () => {
    const many = Array.from({ length: 20 }, (_, vout) => coin((vout + 1) * 1_000, vout))
    expect(fundingCoins(many, 10n).map(each => each.valueSat)).toEqual(
      Array.from({ length: 13 }, (_, index) => (20 - index) * 1_000),
    )
  })

  test('under the cap keep every coin, as a build was handed before the cap', () => {
    expect(fundingCoins([coin(5_000, 0), coin(100, 1)], 10n)).toHaveLength(2)
  })

  // At 10 sat/vB a coin's own 68 vbytes cost 680 sats.
  test('past the cap leave out a coin worth no more than its own weight', () => {
    const many = [
      ...Array.from({ length: 11 }, (_, vout) => coin(5_000, vout)),
      coin(681, 11),
      coin(680, 12),
      coin(100, 13),
    ]
    expect(fundingCoins(many, 10n).map(each => each.valueSat)).toEqual([...Array(11).fill(5_000), 681])
  })
})

// The one figure of what arrives, read by the review, the question of a pass, the follow-up and Home.
describe('exitArriving', () => {
  test('a quote with funding states a floor, never above the value less the fees that come off it', () => {
    const quote = quoteOf({ cooperativeFeeSats: 500n, refundFeeSats: 700n, sweepFeeSats: 3_000n })
    expect(exitArriving(quote)).toEqual({ sat: 100_000 - 500 - 700 - 3_000, floor: true })
  })

  test('a quote with no funding states what arrives plainly', () => {
    expect(exitArriving(quoteOf({ funding: undefined })).floor).toBe(false)
  })

  test('a live plan with a fee key states a floor from its recovery, never its value before fees', () => {
    const plan = planOf({ recovery: recoveryOf({ recoverableValueSats: 16_384n, sweepFeeSats: 3_000n }) })
    expect(exitArriving(plan)).toEqual({ sat: 13_384, floor: true })
  })

  test('a plan with nothing to fund states it plainly', () => {
    const plan = planOf({ feeKey: null, recovery: recoveryOf({ fundingInputs: [] }) })
    expect(exitArriving(plan).floor).toBe(false)
  })

  test('fees past the value arrive as nothing', () => {
    expect(exitArriving(quoteOf({ recoverableValueSats: 1_000n, sweepFeeSats: 3_000n })).sat).toBe(0)
  })
})

describe('planArriving', () => {
  const recovery = recoveryOf({ recoverableValueSats: 16_384n, sweepFeeSats: 3_000n })

  test('a plan the check found valid states its floor', () => {
    expect(planArriving(planOf({ recovery }))).toEqual({ sat: 13_384, floor: true })
  })

  // The operators' own version of a step landed, so the plan's transactions will not confirm.
  test('a plan whose last check answered redo states nothing', () => {
    expect(planArriving(planOf({ recovery, verdict: 'redo' }))).toBeNull()
  })
})
