import type { HistorySuccessAction } from './payment'
import type { OnchainSpeed, SparkDestinationInfo, SparkDestinationKind, SparkSendQuote } from './spark'

// Whether a send pays an invoice over Spark when the invoice allows it. Off while it is unknown that a
// third party's invoice paid this way shows as paid to whoever charged. Only Send reads this: a
// charge of ours has to settle as its invoice, so it never takes the route.
export const PREFER_SPARK_ROUTE = false

export function takesSparkRoute(quote: SparkSendQuote, prefer: boolean): boolean {
  return prefer && quote.sparkRouteFeeSat !== undefined
}

// The quote priced on the route the send will take, so the fee, the total and what arrives all read
// the same rail.
export function routedQuote(quote: SparkSendQuote, prefer: boolean): SparkSendQuote {
  const fee = quote.sparkRouteFeeSat
  if (!takesSparkRoute(quote, prefer) || fee === undefined) {
    return quote
  }
  return { ...quote, fee, ...(quote.feesIncluded ? { receives: quote.amount - fee } : {}) }
}

// What a send takes from the wallet at this speed. With fees included `amount` already holds them.
export function sendTotal(quote: SparkSendQuote, speed: OnchainSpeed): number {
  if (quote.feesIncluded) {
    return quote.amount
  }
  return quote.amount + (quote.onchainFees?.[speed]?.totalSat ?? quote.fee ?? 0)
}

// What reaches the recipient of a send with fees included, or undefined on any other send, where it is
// `amount` and needs no line of its own. On-chain the fee follows the speed, so the figure does too.
export function sendReceives(quote: SparkSendQuote, speed: OnchainSpeed): number | undefined {
  if (!quote.feesIncluded) {
    return undefined
  }
  const tier = quote.onchainFees?.[speed]
  return tier ? quote.amount - tier.totalSat : quote.receives
}

// The SDK prepares a silent payment address as a BitcoinAddress method, with the same fee quotes and
// speeds, so the two are one rail on Send (sdk/payments/prepare/mod.rs).
export const isOnchainKind = (kind: SparkDestinationKind | null): boolean =>
  kind === 'bitcoinAddress' || kind === 'silentPaymentAddress'

// The least an on-chain output can be at each address type, which the SDK checks only as it sends
// (`get_dust_limit_sats`), past a review that would have said what arrives.
export function dustLimitSat(address: string): number {
  const lower = address.toLowerCase()
  if (lower.startsWith('bc1q')) {
    return lower.length === 42 ? 294 : 330
  }
  // A silent payment pays a taproot output (utils/bitcoin_dust.rs).
  if (lower.startsWith('bc1p') || lower.startsWith('sp1')) {
    return 330
  }
  return address.startsWith('3') ? 540 : 546
}

// Whether a destination can be paid in this token. Only a Spark address carries a token, and a Spark
// invoice or a unified code that names a figure without a token names sats.
export function carriesToken(
  info: Pick<SparkDestinationInfo, 'kind' | 'tokenIdentifier' | 'amount' | 'requestedAmount'>,
  tokenId: string,
): boolean {
  if (info.kind !== 'sparkAddress') {
    return false
  }
  return info.tokenIdentifier !== undefined
    ? info.tokenIdentifier === tokenId
    : info.amount === undefined && info.requestedAmount === undefined
}

export function nothingArrives(quote: SparkSendQuote, speed: OnchainSpeed, address: string): boolean {
  const receives = sendReceives(quote, speed)
  return receives !== undefined && receives < (quote.onchainFees ? dustLimitSat(address) : 1)
}

// What the recipient's server said on a finished LNURL pay, as words only. Its link waits in the
// transaction's sheet, since opening or even drawing it here would hand a press on a success screen
// to whatever the server wrote.
export function payeeNote(action: HistorySuccessAction | undefined): string | undefined {
  return action?.kind === 'message' ? action.text : action?.description
}
