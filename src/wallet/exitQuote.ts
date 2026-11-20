import { answerWithin } from './answerWithin'
import { emergencyExitLive } from './emergencyExit'
import { isLivePlan, loadExitPlan, type ExitPlan } from './exitPlan'
import { sparkLeafIsCooperative, type SparkRecoverQuote, type SparkRecovery } from './spark'

// What a quote for an emergency exit says, kept apart from the screen so its rules are tested alone.

// Past this share of the value a quote still passes, with a warning. The doc gives no figure.
const THIN_SHARE = 0.2

// A quote older than this is taken again before anything is built on it.
export const QUOTE_LIFE_MS = 30 * 60_000

// The largest dust limit among the address types a destination can be (P2PKH). A smaller output is
// built and signed by the SDK, and no node relays it (recover_funds.md), so one constant serves every
// destination and the script need not be read.
export const LEAST_RELAYED_SAT = 546

export type QuoteVerdict = 'empty' | 'notWorth' | 'tooSmall' | 'thin' | 'fine'

type Totals = SparkRecoverQuote | SparkRecovery

const sumLeaves = (leaves: Totals['leaves']): number =>
  leaves.reduce((sum, leaf) => sum + Number(leaf.valueSats), 0)

// The two recoveries pay out apart, so each one with leaves has to clear the limit by itself. With more
// than one cooperative leaf this is only the total, and the outputs are read after the build.
function belowRelay(quote: Totals): boolean {
  const cooperative = quote.leaves.filter(sparkLeafIsCooperative)
  const unilateral = quote.leaves.filter(leaf => !sparkLeafIsCooperative(leaf))
  const left = (leaves: Totals['leaves'], fees: bigint[]): number =>
    sumLeaves(leaves) - fees.reduce((sum, fee) => sum + Number(fee), 0)
  return (
    (cooperative.length > 0 && left(cooperative, [quote.cooperativeFeeSats]) < LEAST_RELAYED_SAT) ||
    (unilateral.length > 0 && left(unilateral, [quote.refundFeeSats, quote.sweepFeeSats]) < LEAST_RELAYED_SAT)
  )
}

// recover_funds.md: "Before funding, require recoverable_value_sats to exceed total_fee_sats". The rule
// on each leaf leaves out the shared fan-out fee, so the totals of the quote are what decide.
export function quoteVerdict(quote: Totals): QuoteVerdict {
  if (quote.leaves.length === 0) {
    return 'empty'
  }
  const value = Number(quote.recoverableValueSats)
  const fee = Number(quote.totalFeeSats)
  if (!(value > fee)) {
    return 'notWorth'
  }
  if (belowRelay(quote)) {
    return 'tooSmall'
  }
  return fee > value * THIN_SHARE ? 'thin' : 'fine'
}

// The one reading of a verdict: whether money may be spent on what was judged.
export const mayGoOn = (verdict: QuoteVerdict): boolean => verdict === 'fine' || verdict === 'thin'

// What reaches the destination out of the value, or nothing for a quote whose fees take it all. CPFP
// and fan-out fees come from the funding, so taking the total fee off the value charges them twice.
export function arrivingSat(quote: Totals): number {
  const fromValue =
    Number(quote.cooperativeFeeSats) + Number(quote.refundFeeSats) + Number(quote.sweepFeeSats)
  return Math.max(0, Number(quote.recoverableValueSats) - fromValue)
}

export type Arriving = { sat: number; floor: boolean }

// What arrives at the destination, the one figure every screen states: the review and the question of
// a pass from a quote, the follow-up and the Home card from the live plan. The fees that come off the
// value are each kind's own, the cooperative fee for a cooperative leaf and the refund and sweep fees for
// a unilateral one. Funding the fees do not use comes back in the sweep on top (recover_funds.md: the
// sweep fee and a per-branch allowance "come back to you in the sweep"), so with funding the figure is
// a floor; neither a quote nor a plan knows that leftover, so it is never added.
export function exitArriving(of: SparkRecoverQuote | ExitPlan): Arriving {
  if ('recovery' in of) {
    return { sat: arrivingSat(of.recovery), floor: of.feeKey !== null || of.recovery.fundingInputs.length > 0 }
  }
  return { sat: arrivingSat(of), floor: of.funding !== undefined }
}

// What a plan says arrives, or null once its last check answered `redo`: the chain took another way
// than the plan's transactions, so their figures are of an exit that will not happen, and the next
// build, or the person's word on it, is what states one again.
export function planArriving(plan: ExitPlan): Arriving | null {
  return plan.verdict === 'redo' ? null : exitArriving(plan)
}

// What a live plan is moving, as what arrives, null when the plan states nothing (planArriving). Null
// with no live plan or the exit switched off, 'unread' when the plan cannot be read or does not answer
// in time. Nothing here is taken off the balance: once a branch's first step confirms and a sync runs
// the SDK's figure already leaves its leaves out, and the binding gives no status per leaf to tell
// which ones it still counts.
export type ExitOnItsWay = { arriving: Arriving | null }

// A local file read, so a wait this long is a platform that will not answer.
const PLAN_READ_WAIT_MS = 5_000

export async function exitOnItsWay(walletId: string | null): Promise<ExitOnItsWay | 'unread' | null> {
  if (!emergencyExitLive() || walletId === null) {
    return null
  }
  // Wrapped, since a plan that is absent answers null as a read that timed out does.
  const read = loadExitPlan(walletId).then(
    plan => ({ plan }),
    () => null,
  )
  const answer = await answerWithin(read, PLAN_READ_WAIT_MS)
  if (answer === null) {
    return 'unread'
  }
  const { plan } = answer
  if (!isLivePlan(plan)) {
    return null
  }
  return { arriving: planArriving(plan) }
}

// The output values of a raw transaction, or null for hex that does not parse as one.
export function txOutputsSat(hex: string): number[] | null {
  const byteAt = (index: number): number => parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  const littleEndian = (index: number, size: number): number => {
    let value = 0
    for (let at = size - 1; at >= 0; at -= 1) {
      value = value * 256 + byteAt(index + at)
    }
    return value
  }
  let at = 4
  const varInt = (): number => {
    const first = byteAt(at)
    at += 1
    if (first < 0xfd) {
      return first
    }
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    at += size
    return littleEndian(at - size, size)
  }
  // Segwit puts a zero where the input count would be, which no spendable transaction has.
  if (byteAt(at) === 0 && byteAt(at + 1) === 1) {
    at += 2
  }
  const inputs = varInt()
  for (let input = 0; input < inputs && at < hex.length / 2; input += 1) {
    at += 36
    const script = varInt()
    at += script + 4
  }
  const count = varInt()
  const outputs: number[] = []
  for (let output = 0; output < count && at < hex.length / 2; output += 1) {
    outputs.push(littleEndian(at, 8))
    at += 8
    const script = varInt()
    at += script
  }
  const whole = outputs.length === count && count > 0 && at <= hex.length / 2
  return whole && outputs.every(Number.isSafeInteger) ? outputs : null
}

// The same limit on what the SDK actually built, each output by itself. Hex that cannot be read proves
// nothing about what arrives, so it cannot pass.
export const paysAboveRelay = (txHex: string): boolean =>
  txOutputsSat(txHex)?.every(value => value >= LEAST_RELAYED_SAT) ?? false

// What the funding has to reach, or 0 for a quote with nothing to fund.
export const fundingNeededSat = (quote: SparkRecoverQuote): number =>
  quote.funding === undefined ? 0 : Number(quote.funding.singleUtxoSats)

export const quoteIsOld = (quotedAt: number, now: number, quotedRate: bigint, rate: bigint): boolean =>
  now - quotedAt > QUOTE_LIFE_MS || rate > quotedRate

// A TRUC transaction with an unconfirmed TRUC parent is at most 1,000 sigop-adjusted vbytes (BIP431,
// rule 5), and a CPFP child always has one, the transaction it pays for. Every host refuses a larger one,
// and the parent never confirms without it.
export const TRUC_CHILD_MAX_VBYTES = 1000

// A CPFP child spends the coins it is handed and the parent's P2A anchor into one P2WPKH change
// (build_cpfp_child in spark/src/services/unilateral_exit.rs). Besides the coins it weighs 331 units: 42
// of version, counts, locktime and segwit marker, 165 of the anchor and 124 of the change. Each coin
// weighs 272 at the 72 byte signature the SDK sizes fees on, so 13 coins make 967 vbytes and 14 make 1,035.
const CHILD_BASE_WEIGHT = 331
const COIN_WEIGHT = 272
export const MAX_FUNDING_COINS = Math.floor((TRUC_CHILD_MAX_VBYTES * 4 - CHILD_BASE_WEIGHT) / COIN_WEIGHT)

type Coin = { txid: string; vout: number; valueSat: number }

// The coins a build is handed, largest first. With one branch the SDK puts all of them in the first child,
// and with several each child gets some of them or one output of a fan-out, so a cap on the whole keeps
// every child under the limit. Past the cap a coin worth no more than its own weight at the rate is left
// out, since it adds more fee than value, and what remains is the set that fits and pays the most.
export function fundingCoins<T extends Coin>(coins: T[], feeRateSatPerVbyte: bigint): T[] {
  const largestFirst = [...coins].sort(
    (a, b) => b.valueSat - a.valueSat || a.txid.localeCompare(b.txid) || a.vout - b.vout,
  )
  if (largestFirst.length <= MAX_FUNDING_COINS) {
    return largestFirst
  }
  const coinFeeSat = (COIN_WEIGHT / 4) * Number(feeRateSatPerVbyte)
  return largestFirst.filter(coin => coin.valueSat > coinFeeSat).slice(0, MAX_FUNDING_COINS)
}

// The virtual size of a raw transaction, or null for hex that does not parse as one. Sigops are left
// out: a P2WPKH or P2A input costs at most one, far below what its weight already counts.
export function txVbytes(hex: string): number | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) {
    return null
  }
  const size = hex.length / 2
  const byteAt = (index: number): number => parseInt(hex.slice(index * 2, index * 2 + 2), 16)
  let at = 4
  const varInt = (): number => {
    const first = byteAt(at)
    at += 1
    if (first < 0xfd) {
      return first
    }
    const width = first === 0xfd ? 2 : first === 0xfe ? 4 : 8
    let value = 0
    for (let index = width - 1; index >= 0; index -= 1) {
      value = value * 256 + byteAt(at + index)
    }
    at += width
    return value
  }
  const segwit = byteAt(at) === 0 && byteAt(at + 1) === 1
  if (segwit) {
    at += 2
  }
  const inputs = varInt()
  // Each length is read before `at` moves past it, since `at += varInt()` would add to the old `at`.
  const skipSized = (): void => {
    const length = varInt()
    at += length
  }
  for (let input = 0; input < inputs && at < size; input += 1) {
    at += 36
    skipSized()
    at += 4
  }
  const outputs = varInt()
  for (let output = 0; output < outputs && at < size; output += 1) {
    at += 8
    skipSized()
  }
  const witnessStart = at
  for (let input = 0; segwit && input < inputs && at < size; input += 1) {
    const items = varInt()
    for (let item = 0; item < items && at < size; item += 1) {
      skipSized()
    }
  }
  if (at + 4 !== size) {
    return null
  }
  // The marker and flag count as witness, at a quarter of the weight of the rest.
  const witnessBytes = segwit ? at - witnessStart + 2 : 0
  return Math.ceil(((size - witnessBytes) * 4 + witnessBytes) / 4)
}

// Whether a child the SDK built is one the network takes. Hex that does not parse says nothing of its
// size, and a parser's limit is no reason to stop an exit, so only a size measured over the limit fails.
export const childFits = (hex: string): boolean => (txVbytes(hex) ?? 0) <= TRUC_CHILD_MAX_VBYTES
