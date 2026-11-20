import { formatSats } from './amount'
import { BITCOIN_ASSET_ID, cutToTwoPlaces, isBelowCent } from './assets'
import { formatFiat, localizeAmount } from './fiat'
import { knownToken } from './tokens'
import type { HistoryConversionSide, HistoryConversionStatus, HistoryItem, PaymentMethod } from './payment'
import type { HistoryAssetFilter } from './spark'

// A zap (NIP-57) arrives as the signed kind-9734 event serialized as JSON, whose `content` holds
// the zapper's message. `senderComment` is the plain LUD-12 comment and can be present without a zap.
export function parseZap(
  nostrZapRequest?: string,
  senderComment?: string,
): { isZap: boolean; comment?: string } {
  const fallback = senderComment && senderComment.trim() !== '' ? senderComment : undefined
  if (nostrZapRequest == null) {
    return { isZap: false, comment: fallback }
  }
  let comment: string | undefined
  try {
    const event: unknown = JSON.parse(nostrZapRequest)
    if (
      event !== null &&
      typeof event === 'object' &&
      typeof (event as { content?: unknown }).content === 'string' &&
      (event as { content: string }).content.trim() !== ''
    ) {
      comment = (event as { content: string }).content
    }
  } catch {
    // The field's presence is the zap signal, so a malformed 9734 still counts as one.
  }
  return { isZap: true, comment: comment ?? fallback }
}

// Only http(s) reaches Linking.openURL, since these strings come from a user-typed address or a
// paid service.
export function httpUrl(value: string): string | null {
  return /^https?:\/\/\S+$/i.test(value) ? value : null
}

// The whole base is kept rather than the origin, so an explorer under a subpath still links right.
export function explorerTxUrl(
  method: PaymentMethod | undefined,
  txId: string | undefined,
  explorerBase: string | undefined,
): string | null {
  if (!txId || method !== 'bitcoin') {
    return null
  }
  const base = explorerBase?.trim().replace(/\/+$/, '')
  return base && httpUrl(base) ? `${base}/tx/${txId}` : null
}

export function assetHistoryFilter(assetId: string): HistoryAssetFilter {
  return assetId === BITCOIN_ASSET_ID ? 'bitcoin' : { tokenIdentifier: assetId }
}

// The query's filter only keeps other assets from taking up a page. This is what enforces it.
export function isAssetMovement(item: HistoryItem, assetId: string): boolean {
  return assetId === BITCOIN_ASSET_ID ? item.asset === null : item.asset?.assetId === assetId
}

export type HistoryGroupKind = 'today' | 'yesterday' | 'older'
export type HistoryGroup = { kind: HistoryGroupKind; ts: number; items: HistoryItem[] }

// A day header or one payment, so a virtualized list can render the grouped history without holding
// every row mounted. Keys come from the payment id, which stays unique even when a day repeats.
export type HistoryRow =
  | { kind: 'header'; key: string; group: HistoryGroup }
  | { kind: 'item'; key: string; item: HistoryItem; firstInGroup: boolean; lastInGroup: boolean }

export function flattenHistory(groups: HistoryGroup[]): HistoryRow[] {
  const rows: HistoryRow[] = []
  for (const group of groups) {
    rows.push({ kind: 'header', key: `h-${group.kind}-${group.ts}`, group })
    group.items.forEach((item, index) => {
      rows.push({
        kind: 'item',
        key: item.id,
        item,
        firstInGroup: index === 0,
        lastInGroup: index === group.items.length - 1,
      })
    })
  }
  return rows
}

// Calendar day in LOCAL time, so "today"/"yesterday" follow the wall clock, not UTC.
function dayStamp(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`
}

const DAY_MS = 86_400_000

// Assumes the SDK's newest-first order, grouping only consecutive same-day items.
export function groupHistory(items: HistoryItem[], nowMs: number): HistoryGroup[] {
  const today = dayStamp(nowMs)
  const yesterday = dayStamp(nowMs - DAY_MS)
  const groups: HistoryGroup[] = []
  for (const item of items) {
    const stamp = dayStamp(item.timestamp * 1000)
    const last = groups[groups.length - 1]
    if (last && dayStamp(last.ts * 1000) === stamp) {
      last.items.push(item)
    } else {
      const kind: HistoryGroupKind = stamp === today ? 'today' : stamp === yesterday ? 'yesterday' : 'older'
      groups.push({ kind, ts: item.timestamp, items: [item] })
    }
  }
  return groups
}

// The device's explicit 12h/24h setting overrides the locale's own default clock.
export type DateTimePrefs = { locale: string; use24Hour: boolean }

// Some ICU builds put a narrow or no-break space before AM/PM, varying by device and by build.
function normalizeSpaces(s: string): string {
  return s.replace(/[\u202f\u00a0]/g, ' ')
}

export function formatTime(timestampSeconds: number, prefs: DateTimePrefs): string {
  return normalizeSpaces(
    new Intl.DateTimeFormat(prefs.locale, {
      hour: prefs.use24Hour ? '2-digit' : 'numeric',
      minute: '2-digit',
      hour12: !prefs.use24Hour,
    }).format(new Date(timestampSeconds * 1000)),
  )
}

export function formatDate(timestampSeconds: number, prefs: DateTimePrefs): string {
  return normalizeSpaces(
    new Intl.DateTimeFormat(prefs.locale, {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(timestampSeconds * 1000)),
  )
}

// A moment as it reads on a line, with the date when that is not today, so an old one never passes
// for one from this morning.
export function clearsAt(timestampSeconds: number, prefs: DateTimePrefs): string {
  const time = formatTime(timestampSeconds, prefs)
  return new Date(timestampSeconds * 1000).toDateString() === new Date().toDateString()
    ? time
    : `${formatDate(timestampSeconds, prefs)} ${time}`
}

type Translate = (key: string, opts?: Record<string, unknown>) => string

// A conversion's figures are in the side's own unit, which is sats when the side has no token.
export function conversionFigure(side: HistoryConversionSide, value: string, t: Translate): string {
  return side.ticker === null
    ? t('home.sats', { amount: formatSats(Number(value)) })
    : `${localizeAmount(value)} ${side.ticker}`
}

function cutTokenFigure(value: string, ticker: string): string {
  return `${localizeAmount(cutToTwoPlaces(value))} ${ticker}`
}

// What left, as the caption of a row that draws what arrived. Nothing when nobody said how much left,
// and a figure that is only the quote reads as approximate.
export function conversionLeft(item: HistoryItem, t: Translate): string | null {
  const { from, to } = item.conversion ?? {}
  if (item.direction !== 'converted' || from?.amount === undefined || to?.amount === undefined) {
    return null
  }
  const figure = from.ticker === null ? conversionFigure(from, from.amount, t) : cutTokenFigure(from.amount, from.ticker)
  return t('history.rowFrom', { amount: from.quoted ? `≈ ${figure}` : figure })
}

// What a cross-chain send delivered, or is estimated to. `deliveredAmount` is only final with the
// delivery complete, a pending delivery has only the estimate from when it was prepared, and a
// delivery that did not happen has no figure at all, however much was estimated.
export function crossChainArrival(item: HistoryItem): { amount: string; estimated: boolean } | null {
  const send = item.crossChainSend
  if (!send || item.status === 'failed') {
    return null
  }
  if (item.delivery === 'complete') {
    return send.deliveredAmount === undefined ? null : { amount: send.deliveredAmount, estimated: false }
  }
  return item.delivery === 'pending' ? { amount: send.estimatedOut, estimated: true } : null
}

// The payment's fee in the unit it was charged in, or null when there is none to state. A failed
// payment charged nothing. A conversion's own costs are drawn apart, since its leg's fee is not what
// it cost. A cross-chain send's fee is the provider's, and without one nothing says it was free.
export function feeText(item: HistoryItem, t: Translate): string | null {
  if (item.status === 'failed' || item.direction === 'converted') {
    return null
  }
  const send = item.crossChainSend
  if (send) {
    if (send.feeAmount === undefined) {
      return null
    }
    return `${item.delivery === 'pending' ? '≈ ' : ''}${localizeAmount(send.feeAmount)} ${send.asset}`
  }
  if (item.asset) {
    return item.asset.fee === undefined ? null : `${localizeAmount(item.asset.fee)} ${item.asset.ticker}`
  }
  return t('home.sats', { amount: formatSats(item.feesSat) })
}

// The payment's figure to the last digit in its own unit, which is what the detail states.
export function exactAmountText(item: HistoryItem, t: Translate): string {
  return item.asset
    ? `${localizeAmount(item.asset.amount)} ${item.asset.ticker}`
    : t('home.sats', { amount: formatSats(item.amountSat) })
}

// The token amount a list row can state as money, by identifier and never by ticker, since anyone can
// issue a token called USDB. A send or a receive that converted is that token only once the
// conversion finished, and only by a figure the SDK reports. A conversion keeps its own units, which
// its title and its caption are read against.
function peggedFigure(item: HistoryItem): { assetId: string; amount: string } | null {
  const { direction, conversion, asset } = item
  if (direction === 'converted' || (conversion && conversion.status !== 'complete')) {
    return null
  }
  if (asset) {
    return asset
  }
  const side = direction === 'received' ? conversion?.to : conversion?.from
  return side?.assetId !== undefined && side.amount !== undefined && !side.quoted
    ? { assetId: side.assetId, amount: side.amount }
    : null
}

// A list row's figure. A pegged token reads as the money it tracks, except under a cent, which
// formatFiat would draw as zero.
export function rowAmountText(item: HistoryItem, t: Translate): string {
  if (item.direction === 'converted' && item.asset) {
    return cutTokenFigure(item.asset.amount, item.asset.ticker)
  }
  const figure = peggedFigure(item)
  const token = figure && knownToken(figure.assetId)
  if (!figure || token?.fiatId === undefined) {
    return exactAmountText(item, t)
  }
  const value = Number(figure.amount)
  return isBelowCent(Math.round(value * 10 ** token.decimals), token.decimals)
    ? `${localizeAmount(figure.amount)} ${token.ticker}`
    : formatFiat(value, token.fiatId)
}

// Contact names by address, resolved when a line is drawn so that renaming a contact renames its whole
// history. Addresses compare trimmed and in lowercase on both sides, since the SDK keeps a contact's
// as it was typed.
export type ContactNames = ReadonlyMap<string, string>

export function contactKey(address: string): string {
  return address.trim().toLowerCase()
}

// The most a list under a field shows before it pushes the rest of the screen away.
const MAX_CONTACT_MATCHES = 5

// A name is typed however the keyboard is set, without the capital or the accent it was saved with.
function foldedText(text: string): string {
  return text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
}

export function matchContacts<C extends { name: string; address: string }>(
  contacts: readonly C[],
  typed: string,
): C[] {
  const wanted = foldedText(typed.trim())
  if (wanted.length === 0) {
    return []
  }
  return contacts
    .filter(
      contact => foldedText(contact.name).includes(wanted) || foldedText(contact.address).includes(wanted),
    )
    .slice(0, MAX_CONTACT_MATCHES)
}

function sentTitle(item: HistoryItem, t: Translate, names: ContactNames | undefined): string {
  if (!item.lnAddress) {
    return t('history.sent')
  }
  return t('history.sentTo', { name: names?.get(contactKey(item.lnAddress)) ?? item.lnAddress })
}

// Shared by the rows and the detail. A conversion is named by the side it landed on, and the asset
// that side holds is bitcoin, whatever unit its figure is in. Without that side it is only a
// conversion: it may have failed, so "Converted" could say something false.
// A refund from the pool is value coming back, not a payment from anyone, however the SDK files it. A
// conversion that a real receive started and the pool refunded leaves that receive a receive.
export function directionLabel(item: HistoryItem, t: Translate, names?: ContactNames): string {
  if (item.direction === 'sent') {
    return sentTitle(item, t, names)
  }
  if (item.direction === 'received') {
    return t(item.poolRefund ? 'history.returned' : 'history.received')
  }
  const to = item.conversion?.to
  if (!to) {
    return t('history.detail.conversion')
  }
  return to.ticker === null ? t('history.convertedToBitcoin') : t('history.convertedTo', { to: to.ticker })
}

// The sides of a conversion the detail states. What did not finish never arrived, and a receive it did
// not finish for stayed as it came in, so nothing left either. A conversion that funded a send made
// what the send then spent, so on a send it reads as arrived only once the send itself is through, and
// a cross-chain send has a far side of its own, and a figure of what left that counts all of it.
export function conversionSides(item: HistoryItem): { left?: HistoryConversionSide; arrived?: HistoryConversionSide } {
  const { conversion, crossChainSend, direction, status } = item
  const finished = conversion?.status === 'complete'
  if (!conversion || crossChainSend || (direction === 'received' && !finished)) {
    return {}
  }
  const through = direction !== 'sent' || status === 'complete'
  return { left: conversion.from, arrived: finished && through ? conversion.to : undefined }
}

// A conversion that did not deliver says where the value stands, since "failed" alone reads as lost.
export function conversionStatusText(status: HistoryConversionStatus, t: Translate): string {
  switch (status) {
    case 'pending':
      return t('history.pending')
    case 'failed':
      return t('history.failedStatus')
    case 'refundPending':
      return t('history.conversionRefundPending')
    case 'refunded':
      return t('history.conversionRefunded')
    default:
      return t('history.completed')
  }
}

// Shared by the History list, the asset screen and the detail, which must not name the same state
// differently.
export function historyStatusText(item: HistoryItem, t: Translate): string {
  const undelivered = item.direction === 'converted' ? item.conversion?.status : item.delivery
  const refund = undelivered === 'refundPending' || undelivered === 'refunded'
  return conversionStatusText(refund ? undelivered : item.status, t)
}
