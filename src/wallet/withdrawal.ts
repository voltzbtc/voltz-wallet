import { ReceiveHeldByExit } from './errors'
import { storeRefundSheetAvailable } from './store'
import { post, sendSigned, storeCreditsMessage, SESSION_WAITS_MS, type Reply, type StoreGatewayDeps } from './storePurchase'

// A buyer's withdrawal from a name or a domain year in the 14 days after buying it, the app's half.
// The gateway lists every purchase of the wallet with whether it can be withdrawn now and how a
// withdrawal went, takes the signed request, and answers the time it got it, which is the receipt.
// Who gives the money back depends on the rail: Apple decides on its own refund sheet, Google Play
// refunds when the gateway asks, and on the sats rail Voltz pays the sats back to the wallet's Spark
// address. This module reads, signs and maps; the screens only show what it returns.

// Byte-identical to the statement the gateway rebuilds to verify the signature. The golden vectors in
// __tests__/withdrawal.test.ts were printed by the gateway's own builder of it.
export const WITHDRAW_VERSION = 'voltz-withdraw:v1'

export function withdrawMessage(
  pubkey: string,
  paymentRef: string,
  refundTo: string,
  consent: 0 | 1,
  timestamp: number,
): string {
  return [WITHDRAW_VERSION, pubkey, paymentRef, refundTo, String(consent), String(timestamp)].join('\n')
}

export type Channel = 'apple' | 'google' | 'sats'
export type WithdrawalState = 'requested' | 'refunded' | 'declined' | 'failed' | 'lapsed'
export type PurchaseKind = 'name' | 'tier'

export type PurchaseWithdrawal = { state: WithdrawalState; requestedAt: number; outcomeAt: number | null }

export type WalletPurchase = {
  paymentRef: string
  channel: Channel
  kind: PurchaseKind
  // The host the purchase was for, and the name or the customer's host as the order named it.
  domain: string
  subject: string
  // Unix seconds, the gateway's.
  purchasedAt: number
  withdrawableUntil: number
  // The withdraw route's own decision, so a row offered is a request the gateway would take now.
  withdrawable: boolean
  // Apple's transaction id, for its refund sheet; null on the other rails.
  transactionId: string | null
  // What a sats charge cost, the sats a withdrawal brings back. Null on the store rails, whose price
  // only the store knows, and whenever the list does not say it as a whole number of sats.
  amountSats: number | null
  withdrawal: PurchaseWithdrawal | null
}

// The forms the gateway accepts (PAYMENT_REF and SPARK_ADDRESS in its withdrawal.ts). A reference in
// any other form is not one this build could withdraw, and an address in any other form would be
// refused, so neither is sent.
const PAYMENT_REF = /^(apple:(Production|Sandbox):[0-9]{1,30}|google:[0-9a-f]{64}|[0-9a-f]{64})$/
export const SPARK_ADDRESS = /^spark1[02-9ac-hj-np-z]{20,300}$/
const TRANSACTION_ID = /^[0-9]{1,30}$/
const STATES: readonly WithdrawalState[] = ['requested', 'refunded', 'declined', 'failed', 'lapsed']

export function channelOf(paymentRef: string): Channel {
  return paymentRef.startsWith('apple:') ? 'apple' : paymentRef.startsWith('google:') ? 'google' : 'sats'
}

const isSeconds = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function withdrawalOf(value: unknown): PurchaseWithdrawal | null | undefined {
  if (value === null) {
    return null
  }
  const w = value as Record<string, unknown> | undefined
  if (
    typeof w !== 'object' ||
    !STATES.includes(w.state as WithdrawalState) ||
    !isSeconds(w.requestedAt) ||
    (w.outcomeAt !== null && !isSeconds(w.outcomeAt))
  ) {
    return undefined
  }
  return { state: w.state as WithdrawalState, requestedAt: w.requestedAt, outcomeAt: w.outcomeAt as number | null }
}

// A row this build cannot read in full is left out of the answer rather than guessed at: a row
// offered on a field read wrong would sign a request for the wrong purchase or rail.
export function readPurchase(row: unknown): WalletPurchase | null {
  const p = row as Record<string, unknown> | null
  if (typeof p !== 'object' || p === null) {
    return null
  }
  const withdrawal = withdrawalOf(p.withdrawal)
  if (
    typeof p.paymentRef !== 'string' ||
    !PAYMENT_REF.test(p.paymentRef) ||
    p.channel !== channelOf(p.paymentRef) ||
    (p.kind !== 'name' && p.kind !== 'tier') ||
    typeof p.domain !== 'string' ||
    p.domain === '' ||
    typeof p.subject !== 'string' ||
    p.subject === '' ||
    !isSeconds(p.purchasedAt) ||
    !isSeconds(p.withdrawableUntil) ||
    typeof p.withdrawable !== 'boolean' ||
    withdrawal === undefined
  ) {
    return null
  }
  const transactionId =
    p.channel === 'apple' && typeof p.transactionId === 'string' && TRANSACTION_ID.test(p.transactionId)
      ? p.transactionId
      : null
  // Apple's sheet needs the id, so an Apple row without it offers nothing a press could finish.
  if (p.channel === 'apple' && transactionId === null) {
    return null
  }
  const amountSats =
    p.channel === 'sats' && typeof p.amountSats === 'number' && Number.isSafeInteger(p.amountSats) && p.amountSats > 0
      ? p.amountSats
      : null
  return {
    paymentRef: p.paymentRef,
    channel: channelOf(p.paymentRef),
    kind: p.kind,
    domain: p.domain,
    subject: p.subject,
    purchasedAt: p.purchasedAt,
    withdrawableUntil: p.withdrawableUntil,
    withdrawable: p.withdrawable,
    transactionId,
    amountSats,
    withdrawal,
  }
}

// The wallet's purchases on both rails, from the same signed read as its credits. Null whenever the
// answer is not the gateway's list, an older gateway's included, so a failure never reads as having
// bought nothing. A display read, retried at once rather than after the session's waits, since the
// next focus reads it again and nothing should hold a screen's read for seconds.
export async function walletPurchases(deps: StoreGatewayDeps): Promise<WalletPurchase[] | null> {
  const reply = await sendSigned({ ...deps, sleep: deps.sleep ?? (() => Promise.resolve()) }, '/api/store/credits', timestamp => ({
    message: storeCreditsMessage(deps.pubkey, timestamp),
    body: {},
  }))
  if (reply.kind !== 'json' || reply.status !== 200 || !Array.isArray(reply.body.purchases)) {
    return null
  }
  return reply.body.purchases.map(readPurchase).filter((p): p is WalletPurchase => p !== null)
}

// What a screen offers for one purchase: the row while the gateway says it can be withdrawn, the
// state once a withdrawal exists, and nothing otherwise.
export function shownPurchases(purchases: WalletPurchase[], kind: PurchaseKind): WalletPurchase[] {
  return purchases.filter(p => p.kind === kind && (p.withdrawal !== null || p.withdrawable))
}

export type WithdrawReceipt = {
  paymentRef: string
  channel: Channel
  state: WithdrawalState
  // The gateway's clock: the time the request reached it, which is the receipt.
  requestedAt: number
  // When the withdrawal reached the state the answer carries; null while requested, and from a gateway
  // that does not say it.
  outcomeAt: number | null
  withdrawableUntil: number
  transactionId: string | null
}

export type WithdrawRefusal =
  | 'unknown_purchase'
  | 'not_withdrawable'
  | 'window_closed'
  | 'credit_reserved'
  | 'too_many_requests'
  | 'refused'

export type WithdrawResult =
  | { kind: 'received'; receipt: WithdrawReceipt }
  | { kind: 'refused'; code: WithdrawRefusal }
  // Signed by nobody, sent nowhere: the live connection is another wallet's.
  | { kind: 'otherWallet' }
  // The address the sats would go back to could not be read as this wallet's mainnet address.
  | { kind: 'noRefundAddress' }
  // The wallet's emergency exit is alive, or its plan unread, and receiving into it waits.
  | { kind: 'receiveHeld'; hold: 'exit' | 'unread' }
  // An Apple purchase where Apple's sheet cannot open, which would reach the gateway and never Apple.
  | { kind: 'appleElsewhere' }
  // No answer that says what became of the request. A repeat answers the first receipt, so asking
  // again is safe, and nothing here says the request was or was not recorded.
  | { kind: 'unknown'; network: boolean }

// The refusals a person can act on keep their own line; the rest are this build sending something
// the gateway could not take, which no line can explain better than that the request was not taken.
const REFUSALS: ReadonlyMap<string, WithdrawRefusal> = new Map([
  ['unknown_purchase', 'unknown_purchase'],
  ['not_withdrawable', 'not_withdrawable'],
  ['window_closed', 'window_closed'],
  ['credit_reserved', 'credit_reserved'],
])

function receiptOf(body: Record<string, unknown>, paymentRef: string): WithdrawReceipt | null {
  if (
    body.paymentRef !== paymentRef ||
    body.channel !== channelOf(paymentRef) ||
    !STATES.includes(body.state as WithdrawalState) ||
    !isSeconds(body.requestedAt) ||
    !isSeconds(body.withdrawableUntil)
  ) {
    return null
  }
  const transactionId =
    body.channel === 'apple' && typeof body.transactionId === 'string' && TRANSACTION_ID.test(body.transactionId)
      ? body.transactionId
      : null
  const state = body.state as WithdrawalState
  return {
    paymentRef,
    channel: channelOf(paymentRef),
    state,
    requestedAt: body.requestedAt,
    outcomeAt: state !== 'requested' && isSeconds(body.outcomeAt) ? body.outcomeAt : null,
    withdrawableUntil: body.withdrawableUntil,
    transactionId,
  }
}

export type WithdrawDeps = StoreGatewayDeps & {
  // The wallet whose key read the list, which is the wallet that paid for every purchase on it.
  walletId: string
  // The wallet the live connection signs for right now, read again right before the request.
  connectedWalletId: () => string | null
  // The wallet's own Spark address on the connection whose identity is `pubkey`, refused otherwise.
  refundAddress: (pubkey: string) => Promise<string>
}

// No holder name. The gateway still takes an optional one, but the app asks for no name anywhere, as
// its privacy policy and the store privacy labels say, and the signed key already says whose purchase
// it is.
export type WithdrawRequest = { purchase: WalletPurchase; consent: boolean }

function isOtherIdentity(err: unknown): boolean {
  return (err as Error | null)?.message === 'spark connected as another identity'
}

// Signs and sends one withdrawal as the wallet that read the list, and never an Apple one where
// Apple's sheet cannot open, whatever a screen offered. The live connection is checked
// before each signature, and the identity signer and sparkOwnSparkAddress refuse another identity
// themselves, so a switch while the confirmation is open sends nothing. Signed afresh on every try, and retried in this session
// when the gateway could not be reached or could not serve, and once after a 401, since a clock that
// drifted past the window refuses a signature a new timestamp makes good.
export async function requestWithdrawal(deps: WithdrawDeps, request: WithdrawRequest): Promise<WithdrawResult> {
  const { purchase } = request
  if (needsAppleSheet(purchase, storeRefundSheetAvailable())) {
    return { kind: 'appleElsewhere' }
  }
  let refundTo = ''
  if (purchase.channel === 'sats') {
    try {
      refundTo = await deps.refundAddress(deps.pubkey)
    } catch (err) {
      if (err instanceof ReceiveHeldByExit) {
        return { kind: 'receiveHeld', hold: err.hold }
      }
      return isOtherIdentity(err) ? { kind: 'otherWallet' } : { kind: 'noRefundAddress' }
    }
    if (!SPARK_ADDRESS.test(refundTo)) {
      return { kind: 'noRefundAddress' }
    }
  }
  // Apple alone reads it; every rail signs it, and only the box ticked makes it 1.
  const consent: 0 | 1 = purchase.channel === 'apple' && request.consent ? 1 : 0
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  let waits = 0
  let renewed = false
  for (;;) {
    if (deps.connectedWalletId() !== deps.walletId) {
      return { kind: 'otherWallet' }
    }
    const timestamp = Math.floor((deps.now ?? Date.now)() / 1000)
    let reply: Reply
    try {
      const signature = await deps.sign(withdrawMessage(deps.pubkey, purchase.paymentRef, refundTo, consent, timestamp))
      reply = await post(deps, '/api/purchase/withdraw', {
        pubkey: deps.pubkey,
        paymentRef: purchase.paymentRef,
        refundTo,
        consent,
        signature,
        timestamp,
      })
    } catch (err) {
      if (isOtherIdentity(err)) {
        return { kind: 'otherWallet' }
      }
      reply = { kind: 'network' }
    }
    const retriable = reply.kind === 'network' || (reply.kind === 'json' && reply.status === 503)
    if (retriable && waits < SESSION_WAITS_MS.length) {
      await sleep(SESSION_WAITS_MS[waits]!)
      waits += 1
      continue
    }
    if (reply.kind === 'json' && reply.status === 401 && !renewed) {
      renewed = true
      continue
    }
    return withdrawResultOf(reply, purchase.paymentRef)
  }
}

export function withdrawResultOf(reply: Reply, paymentRef: string): WithdrawResult {
  if (reply.kind === 'network') {
    return { kind: 'unknown', network: true }
  }
  if (reply.kind !== 'json') {
    return { kind: 'unknown', network: false }
  }
  if (reply.status === 200) {
    const receipt = receiptOf(reply.body, paymentRef)
    return receipt ? { kind: 'received', receipt } : { kind: 'unknown', network: false }
  }
  if (reply.status === 429) {
    return { kind: 'refused', code: 'too_many_requests' }
  }
  // A 5xx says nothing about whether the request was written.
  if (reply.status >= 500) {
    return { kind: 'unknown', network: false }
  }
  const error = typeof reply.body.error === 'string' ? reply.body.error : ''
  return { kind: 'refused', code: REFUSALS.get(error) ?? 'refused' }
}

export type Line = { key: string; params?: Record<string, string> }

export type LineFormat = { date: (seconds: number) => string; time: (seconds: number) => string; item: string }

// The state a withdrawal reached, as the gateway's list says it. Refunded is said only from the list's
// own state, three business days only on the sats rail, where Voltz is the one paying, and a decline by
// Apple says only that Apple did not approve it.
export function stateLine(withdrawal: PurchaseWithdrawal, channel: Channel, format: LineFormat): Line {
  switch (withdrawal.state) {
    case 'refunded':
      return withdrawal.outcomeAt === null
        ? { key: 'withdrawal.refundedUndated', params: { item: format.item } }
        : { key: 'withdrawal.refunded', params: { item: format.item, date: format.date(withdrawal.outcomeAt) } }
    case 'declined':
      if (channel === 'apple') {
        return { key: 'withdrawal.declinedApple', params: { item: format.item } }
      }
      break
    case 'failed':
      if (channel === 'google') {
        return { key: 'withdrawal.failedGoogle' }
      }
      break
    case 'lapsed':
      if (channel === 'apple') {
        return { key: 'withdrawal.lapsedApple' }
      }
      break
    case 'requested':
      return {
        key: channel === 'apple' ? 'withdrawal.waitingApple' : channel === 'google' ? 'withdrawal.waitingGoogle' : 'withdrawal.waitingSats',
        params: { date: format.date(withdrawal.requestedAt) },
      }
  }
  // A state the contract does not pair with this rail claims nothing beyond the request itself.
  return { key: 'withdrawal.requestedOn', params: { date: format.date(withdrawal.requestedAt) } }
}

// What the receipt says next while the withdrawal is requested, per rail. Apple decides on its own
// sheet, Google Play was already asked, and only on the sats rail does Voltz promise a time, since
// only there does Voltz pay.
export function receiptNextKey(channel: Channel): string {
  return channel === 'apple' ? 'withdrawal.receiptApple' : channel === 'google' ? 'withdrawal.receiptGoogle' : 'withdrawal.receiptSats'
}

// What the receipt says next, by the state the answer carries, which can already be past requested:
// Google's refund is asked for before the answer, and a repeat answers the state the withdrawal is
// in now. Refunded is said only when the answer says it, a Google refund that failed promises no time,
// and an end the rail never reaches claims only the request.
export function receiptNextLine(receipt: WithdrawReceipt, format: LineFormat): Line {
  if (receipt.state === 'requested') {
    return { key: receiptNextKey(receipt.channel) }
  }
  // Past requested, the receipt says what the list will say, in the same words.
  return stateLine({ state: receipt.state, requestedAt: receipt.requestedAt, outcomeAt: receipt.outcomeAt }, receipt.channel, format)
}

// An Apple purchase reaches Apple only through Apple's own refund sheet, which opens only on an iPhone
// with the store bridge. Anywhere else a request would be recorded and never reach Apple, holding the
// credit until it lapses, so such a purchase is never sent from there and its screens point to an
// iPhone with this wallet or to Apple's refund page instead.
export function needsAppleSheet(purchase: Pick<WalletPurchase, 'channel'>, appleSheet: boolean): boolean {
  return purchase.channel === 'apple' && !appleSheet
}

// The confirmation's sentence about the purchase: with the amount where the list carries one, which
// only a sats charge does.
export function purchaseLine(purchase: WalletPurchase, format: LineFormat & { sats: (amount: number) => string }): Line {
  const params = { item: format.item, date: format.date(purchase.purchasedAt) }
  return purchase.amountSats === null
    ? { key: 'withdrawal.purchase', params }
    : { key: 'withdrawal.purchaseAmount', params: { ...params, amount: format.sats(purchase.amountSats) } }
}

// The line above Pay, per rail.
export function payLineKey(channel: Channel): string {
  return channel === 'apple' ? 'withdrawal.payLineApple' : channel === 'google' ? 'withdrawal.payLineGoogle' : 'withdrawal.payLineSats'
}

export function refusalKey(result: Exclude<WithdrawResult, { kind: 'received' }>): string {
  switch (result.kind) {
    case 'otherWallet':
      return 'withdrawal.otherWallet'
    case 'noRefundAddress':
      return 'withdrawal.noRefundAddress'
    case 'receiveHeld':
      return result.hold === 'exit' ? 'emergencyExit.receiveHeld' : 'emergencyExit.receiveHeldUnread'
    case 'appleElsewhere':
      return 'withdrawal.appleElsewhere'
    case 'unknown':
      return result.network ? 'withdrawal.unknownNetwork' : 'withdrawal.unknown'
    case 'refused':
      switch (result.code) {
        case 'unknown_purchase':
          return 'withdrawal.unknownPurchase'
        case 'not_withdrawable':
          return 'withdrawal.notWithdrawable'
        case 'window_closed':
          return 'withdrawal.windowClosed'
        case 'credit_reserved':
          return 'withdrawal.creditReserved'
        case 'too_many_requests':
          return 'withdrawal.tooMany'
        case 'refused':
          return 'withdrawal.refused'
      }
  }
}
