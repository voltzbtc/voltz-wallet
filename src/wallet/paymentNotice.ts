// What an in-app notice says about one payment: the rail it went over, the asset, and the amount in
// that asset's own unit. Every fact is the SDK's payment record's (spark.ts reads it), never what was
// asked for, since an invoice can be paid over Spark and a pending payment can still fail.
//
// The direction leads and the rail follows it ("Received over Lightning"), the way the closed-app
// push words the same events (push.ts), and the amount stays the figure. A pending payment has words
// of its own and never borrows the settled ones.
import type { HistoryAsset, PaymentMethod } from './payment'
import { knownToken } from './tokens'
import { formatSats } from './amount'
import { localizeAmount } from './fiat'

export type NoticeRail = PaymentMethod

// `sat` is the record's raw amount, which for a token is its base units; `asset` then carries the
// same amount already in the token's unit, by the decimals the record gave. `tokenUnread` is a token
// payment whose record gave no metadata, so it has no unit to state.
export type PaymentFacts = {
  rail?: NoticeRail
  sat: number
  asset?: Pick<HistoryAsset, 'assetId' | 'amount'>
  tokenUnread?: true
  // A send past Spark, whose record ends with its Spark transfer while the provider still delivers it.
  crossChain?: true
}

type Translate = (key: string, options?: Record<string, unknown>) => string

export type NoticeKind = 'incoming' | 'received' | 'sent' | 'onTheWay'

// A record with no method and no details names no rail, and the notice then says what it said
// before rails were named.
const RAILLESS: Record<NoticeKind, string> = {
  incoming: 'receive.incoming',
  received: 'receive.gotIt',
  sent: 'send.sent',
  onTheWay: 'send.onTheWay',
}

export function noticeTitle(kind: NoticeKind, rail: NoticeRail | undefined, t: Translate): string {
  return t(rail ? `notice.${kind}.${rail}` : RAILLESS[kind])
}

// The ticker of a token the app knows by its identifier. Any other token is named by nothing it says
// about itself, since its issuer can call it USDB, or sats.
export function tokenUnit(assetId: string): string | null {
  return knownToken(assetId)?.ticker ?? null
}

// The amount as one piece of text: sats, a known token's figure and ticker, an unknown token's figure in
// a phrase that says the app does not know it, or a phrase alone for a token the record left unnamed.
export function amountText(facts: PaymentFacts, t: Translate): string {
  if (facts.tokenUnread) {
    return t('notice.tokenAmountUnread')
  }
  if (facts.asset) {
    const figure = localizeAmount(facts.asset.amount)
    const ticker = tokenUnit(facts.asset.assetId)
    return ticker ? `${figure} ${ticker}` : t('notice.unknownTokenAmount', { amount: figure })
  }
  return `${formatSats(facts.sat)} ${t('common.sats')}`
}

export type SettledOutcome = 'complete' | 'failed'

// The card for a send the confirm screen left on the way, once the SDK gave its last word. `fiat` is a
// bitcoin amount's value in the display currency, already formatted, and only when a rate answered; a
// token's amount is its own value and takes none. A failed send's card points at History and never
// says where the money is, since the SDK's word does not either.
export function settledSendNotice(
  outcome: SettledOutcome,
  facts: PaymentFacts,
  t: Translate,
  fiat?: string,
): { title: string; body: string; destination: null } {
  const { rail } = facts
  const amount = amountText(facts, t)
  const figure =
    fiat !== undefined && !facts.asset && !facts.tokenUnread ? t('notice.withFiat', { amount, fiat }) : amount
  // A send past Spark is complete when its Spark transfer is, and is still being delivered on the other
  // chain, so its card says it is on the way, as the confirm screen did.
  if (outcome === 'complete' && facts.crossChain) {
    return { title: noticeTitle('onTheWay', undefined, t), body: figure, destination: null }
  }
  return outcome === 'complete'
    ? { title: t(rail ? `notice.settled.${rail}` : 'send.lateCompleteTitle'), body: figure, destination: null }
    : {
        title: t(rail ? `notice.failed.${rail}` : 'send.lateFailedTitle'),
        body: t('notice.failedBody', { amount: figure }),
        destination: null,
      }
}
