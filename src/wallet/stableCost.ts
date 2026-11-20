import { answerWithin } from './answerWithin'
import {
  sparkConversionLimits,
  sparkDiscardConvertQuote,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  sparkPrepareConvertBySpend,
} from './spark'
import { SPARK_BTC, effectiveConvertCostPct, tokenIdOf, type SparkConvertAsset } from './sparkConvert'
import { USDB } from './tokens'

// What the switch's confirmation can say about the conversion it asks for.
export type SwitchCost =
  // A percentage of the balance, estimated.
  | { kind: 'cost'; pct: number }
  // Nothing converts yet. The minimum is in base units of the side being spent, absent with no answer.
  | { kind: 'below'; minBase?: number }
  | { kind: 'unknown' }

const USDB_ASSET: SparkConvertAsset = { ...USDB, id: USDB.identifier }

// Asked of the pool on open, and the switch must never wait on it: leaving the mode cannot depend on a
// provider being up. Quoting can take up to 8 prepares, and this time is a choice, not a measure.
export const SWITCH_COST_WAIT_MS = 10_000

const UNKNOWN: SwitchCost = { kind: 'unknown' }

async function readCost(turningOn: boolean): Promise<SwitchCost> {
  const info = await sparkGetWalletInfo()
  // A figure the wallet has not confirmed would be a cost of the wrong amount.
  if (info.sync !== 'synced') {
    return UNKNOWN
  }
  const from = turningOn ? SPARK_BTC : USDB_ASSET
  const to = turningOn ? USDB_ASSET : SPARK_BTC
  const spend = turningOn
    ? info.balanceSat
    : info.tokens.find(token => token.identifier === USDB.identifier)?.balanceBaseUnits ?? 0
  const [limits, rates] = await Promise.all([
    sparkConversionLimits(tokenIdOf(from), tokenIdOf(to)).catch(() => null),
    sparkGetFiatRates(['USD']).catch(() => ({} as Record<string, number>)),
  ])
  const minBase = limits?.minFromBaseUnits
  if (spend <= 0 || (minBase !== undefined && spend < minBase)) {
    return { kind: 'below', minBase }
  }
  const usd = rates.USD
  if (usd === undefined || usd <= 0) {
    return UNKNOWN
  }
  const initialOut = turningOn ? (spend / 1e8) * usd * 10 ** USDB.decimals : 0
  const quote = await sparkPrepareConvertBySpend(tokenIdOf(from), tokenIdOf(to), spend, initialOut)
  // This only looks. Dropped as soon as it lands, which covers an answer no sheet still waits for.
  sparkDiscardConvertQuote(quote.handle)
  // The AMM's cost is in the price, so it comes from the two amounts at spot and never from the
  // quote's own fee field, which can read a hundred times too high (effectiveConvertCostPct). The
  // figure is what the pool gives, or the two directions of one sheet differ by the slippage allowed.
  const received = quote.expectedBaseUnits ?? quote.receivedBaseUnits
  const pct = effectiveConvertCostPct(from, to, quote.spentBaseUnits, received, rates)
  return pct === null ? UNKNOWN : { kind: 'cost', pct }
}

export async function estimateSwitchCost(turningOn: boolean): Promise<SwitchCost> {
  const read = readCost(turningOn).catch(() => UNKNOWN)
  return (await answerWithin(read, SWITCH_COST_WAIT_MS)) ?? UNKNOWN
}
