import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, Linking, ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { chainDisplayName } from '../wallet/crossChain'
import Clipboard from '@react-native-clipboard/clipboard'
import type {
  HistoryConversion,
  HistoryConversionStatus,
  HistoryConversionSide,
  HistoryItem,
  HistorySuccessAction,
} from '../wallet/payment'
import {
  conversionFigure,
  conversionSides,
  conversionStatusText,
  crossChainArrival,
  directionLabel,
  exactAmountText,
  explorerTxUrl,
  feeText,
  formatDate,
  formatTime,
  historyStatusText,
  httpUrl,
  type ContactNames,
  type DateTimePrefs,
} from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { loadTxExplorers, resolveTxExplorerUrl, TX_EXPLORER_PRESETS } from '../wallet/settings'
import { formatSats } from '../wallet/amount'
import type { SparkDeposit } from '../wallet/spark'
import { depositStatusKey } from './PendingDepositRows'
import { refundNeedsHigherFee } from '../wallet/refund'
import { localizeAmount } from '../wallet/fiat'
import { GradientButton } from './GradientButton'
import { TabIcon } from './TabIcon'
import { colors, dividerBottom, radius, space, stroke } from '../theme'
import { Sheet } from './Sheet'
import { joinLabels } from '../i18n/join'
import { Row } from './Row'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { Figure } from './Amount'
import { DetailsFold } from './DetailsFold'
import { FigureRow } from './FigureRow'
import { useSideBySide } from '../hooks/useSideBySide'

type Props = { item: HistoryItem | null; onClose: () => void; names?: ContactNames }

// The separator is an ellipsis, never an em-dash, which is banned in user-facing text.
function truncateMiddle(value: string, head = 12, tail = 8): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`
}

// The copy and the explorer both detail sheets offer. The chosen explorer is read each time the
// sheet opens rather than when its screen mounts, so a screen that never opens one, such as Home,
// never reads the settings for it.
function useDetailActions(t: (key: string) => string, open: boolean) {
  const [copied, setCopied] = useState<string | null>(null)
  // Null until the stored preference answers, and the link uses the default preset meanwhile.
  const [explorerBase, setExplorerBase] = useState<string | null>(null)
  // The read this opening started, null when it failed. A press waits for it, so one made before it
  // answers still opens the explorer the person chose rather than the one drawn meanwhile.
  const explorerRead = useRef<Promise<string | null>>(Promise.resolve(null))
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    if (!open) {
      return
    }
    let alive = true
    const read = loadTxExplorers()
      .then(resolveTxExplorerUrl)
      .catch(() => null)
    explorerRead.current = read
    read.then(base => {
      if (alive && base !== null) {
        setExplorerBase(base)
      }
    })
    return () => {
      alive = false
    }
  }, [open])

  // A read that failed leaves the base the link was drawn with.
  async function explore(urlFor: (base: string) => string | null) {
    const base = (await explorerRead.current) ?? explorerBase ?? TX_EXPLORER_PRESETS[0].url
    const url = urlFor(base)
    if (url) {
      await Linking.openURL(url)
    }
  }

  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    [],
  )

  function copy(field: string, value: string) {
    Clipboard.setString(value)
    setCopied(field)
    // The Copied line replaces the value only on screen, and a screen reader hears nothing of it.
    AccessibilityInfo.announceForAccessibility(t('history.detail.copied'))
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(null), 2000)
  }

  function reset() {
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    setCopied(null)
  }

  return { copied, copy, reset, explorerBase, explore }
}

export function TransactionDetailSheet({ item, onClose, names }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const { copied, copy, reset, explorerBase, explore } = useDetailActions(t, item != null)

  function close() {
    reset()
    onClose()
  }

  return (
    <Sheet visible={item != null} onClose={close} closeLabel={t('history.detail.close')}>
        {item && (
          <Detail
            // A new payment starts with its technical details closed.
            key={item.id}
            item={item}
            names={names}
            copied={copied}
            onCopy={copy}
            t={t}
            prefs={prefs}
            explorerBase={explorerBase}
            onExplore={explore}
          />
        )}
    </Sheet>
  )
}

function Detail({
  item,
  names,
  copied,
  onCopy,
  t,
  prefs,
  explorerBase,
  onExplore,
}: {
  item: HistoryItem
  names: ContactNames | undefined
  copied: string | null
  onCopy: (field: string, value: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  prefs: DateTimePrefs
  explorerBase: string | null
  onExplore: (urlFor: (base: string) => string | null) => void
}): React.JSX.Element {
  const received = item.direction === 'received'
  const left = exactAmountText(item, t)
  const amountColor =
    item.status === 'failed'
      ? colors.danger
      : item.status === 'pending'
        ? colors.textSecondary
        : received
          ? colors.success
          : colors.text
  const converted = item.direction === 'converted'

  // A USDC or USDT send opens on what reached the other side, and what left stays a line under it.
  const send = item.crossChainSend
  const arrival = crossChainArrival(item)
  const arrived = send && arrival ? `${localizeAmount(arrival.amount)} ${send.asset}` : null
  const fee = feeText(item, t)
  const txUrl = explorerTxUrl(item.method, item.txId, explorerBase ?? TX_EXPLORER_PRESETS[0].url)
  const comment = item.zap?.comment ?? item.comment

  const copyRow = (field: string, label: string, value: string) => (
    <CopyRow
      label={label}
      value={truncateMiddle(value)}
      copied={copied === field}
      onPress={() => onCopy(field, value)}
      copiedLabel={t('history.detail.copied')}
    />
  )

  // A scroll, because a Lightning receive with a zap comment and an open details fold runs past the
  // sheet's cap on a small screen or at a large text size, and only a scroll keeps every row in reach.
  return (
    <ScrollView contentContainerStyle={styles.body}>
      <Txt role="section" tone="muted">
        {directionLabel(item, t, names)}
      </Txt>
      <Figure role="title" tabular style={{ color: amountColor }}>
        {/* A conversion stays within the wallet, so it carries no sign, as in the list. */}
        {approxIf(arrival?.estimated, `${converted ? '' : received ? '+' : '\u2212'}${arrived ?? left}`, t)}
      </Figure>
      <View style={styles.statusPill}>
        <Txt role="labelStrong" tone="inherit" style={{ color: amountColor }}>
          {historyStatusText(item, t)}
        </Txt>
      </View>
      {item.zap ? (
        <View style={styles.zapBadge}>
          <TabIcon name="bolt" color={colors.textSecondary} size={14} />
          <Txt role="labelStrong" tone="muted">
            {t('history.zap')}
          </Txt>
        </View>
      ) : null}

      {/* User text, so it never goes through t(), and it wraps unlike the one-line Rows. */}
      {comment ? (
        <View style={styles.comment}>
          <Txt role="caption" tone="muted">
            {t('history.detail.comment')}
          </Txt>
          <Txt role="body">{comment}</Txt>
        </View>
      ) : null}
      {item.successAction ? (
        <SuccessAction action={item.successAction} label={t('history.detail.message')} />
      ) : null}

      <View style={styles.rowsClip}>
        <View style={styles.rows}>
        <InfoRow
          label={t('history.detail.date')}
          value={`${formatDate(item.timestamp, prefs)} · ${formatTime(item.timestamp, prefs)}`}
        />
        {arrived && arrival ? (
          <InfoRow
            label={t(arrival.estimated ? 'history.detail.arrivalEstimate' : 'history.detail.arrived')}
            figure={approxIf(arrival.estimated, arrived, t)}
          />
        ) : null}
        {arrived ? <InfoRow label={t('history.detail.left')} figure={left} /> : null}
        {fee ? <InfoRow label={t('history.detail.fee')} figure={fee} /> : null}
        {/* The full hit to the balance, for a Bitcoin send that went out with a fee. */}
        {item.direction === 'sent' && item.status !== 'failed' && item.asset === null && item.feesSat > 0 ? (
          <InfoRow
            label={t('history.detail.total')}
            figure={t('home.sats', { amount: formatSats(item.amountSat + item.feesSat) })}
          />
        ) : null}
        {item.conversion ? (
          <ConversionRows conversion={item.conversion} {...conversionSides(item)} pillSpeaks={converted} t={t} />
        ) : null}
        {item.description ? <InfoRow label={t('history.detail.note')} value={item.description} /> : null}
        {send ? (
          <InfoRow label={t('history.detail.destinationNetwork')} value={chainDisplayName(send.chain)} />
        ) : null}
        {item.destination ? copyRow('destination', t('history.detail.destination'), item.destination) : null}
        {item.crossChain ? (
          <InfoRow
            label={t('history.detail.from')}
            value={t('receive.stableRoute', {
              asset: item.crossChain.asset,
              chain: chainDisplayName(item.crossChain.chain),
            })}
          />
        ) : null}
        {item.crossChain?.txHash
          ? copyRow(
              'sourceTx',
              t('history.detail.sourceTx', { chain: chainDisplayName(item.crossChain.chain) }),
              item.crossChain.txHash,
            )
          : null}
        {send?.txHash
          ? copyRow('sourceTx', t('history.detail.sourceTx', { chain: chainDisplayName(send.chain) }), send.txHash)
          : null}
        {hasTechnicalDetails(item) ? (
          <DetailsFold label={t('history.detail.technical')}>
            {item.method ? (
              <InfoRow label={t('history.detail.network')} value={t(`history.network.${item.method}`)} />
            ) : null}
            {item.provider ? <InfoRow label={t('history.detail.provider')} value={item.provider} /> : null}
            {item.txId ? copyRow('txid', t('history.detail.txid'), item.txId) : null}
            {item.transferRef ? copyRow('transferRef', t('history.detail.paymentId'), item.transferRef) : null}
            {item.paymentHash ? copyRow('paymentHash', t('history.detail.paymentHash'), item.paymentHash) : null}
            {item.preimage ? copyRow('preimage', t('history.detail.preimage'), item.preimage) : null}
            {item.invoice ? copyRow('invoice', t('history.detail.invoice'), item.invoice) : null}
          </DetailsFold>
        ) : null}
        </View>
      </View>

      {txUrl ? (
        <GradientButton
          label={t('history.detail.viewExplorer')}
          variant="secondary"
          onPress={() => onExplore(base => explorerTxUrl(item.method, item.txId, base))}
        />
      ) : null}
    </ScrollView>
  )
}

// A deposit still on its way has no payment yet, so it has a detail of its own: where it stands,
// its transaction on the chain, and that transaction in the explorer the person chose. The figure
// is the gross amount, as on its row, since none of it is in the balance yet. The caller passes
// only what the latest read still lists, so a deposit claimed meanwhile takes the sheet down.
export function DepositDetailSheet({
  deposits,
  onClose,
  hidden = false,
}: {
  deposits: readonly SparkDeposit[]
  onClose: () => void
  // Home's hidden balance hides a deposit's figure here too, as on the card it opens from.
  hidden?: boolean
}): React.JSX.Element {
  const { t } = useTranslation()
  const { copied, copy, reset, explorerBase, explore } = useDetailActions(t, deposits.length > 0)

  function close() {
    reset()
    onClose()
  }

  return (
    <Sheet visible={deposits.length > 0} onClose={close} closeLabel={t('history.detail.close')}>
      {deposits.length > 0 && (
        <ScrollView contentContainerStyle={styles.body}>
          <Txt role="section" tone="muted">
            {t('deposits.title')}
          </Txt>
          {deposits.map(deposit => (
            <DepositDetail
              key={`${deposit.txid}:${deposit.vout}`}
              deposit={deposit}
              copied={copied}
              onCopy={copy}
              t={t}
              explorerBase={explorerBase}
              onExplore={explore}
              hidden={hidden}
            />
          ))}
        </ScrollView>
      )}
    </Sheet>
  )
}

function DepositDetail({
  deposit,
  copied,
  onCopy,
  t,
  explorerBase,
  onExplore,
  hidden,
}: {
  deposit: SparkDeposit
  copied: string | null
  onCopy: (field: string, value: string) => void
  t: (key: string, opts?: Record<string, unknown>) => string
  explorerBase: string | null
  onExplore: (urlFor: (base: string) => string | null) => void
  hidden: boolean
}): React.JSX.Element {
  const key = `${deposit.txid}:${deposit.vout}`
  // A return the network accepted is where the money is going, so the explorer follows it. One
  // signed and not seen yet, or refused, is on no chain, so the explorer stays on the received one.
  const followed =
    deposit.refundTxId && deposit.refundState === 'broadcast' ? deposit.refundTxId : deposit.txid
  const txUrl = explorerTxUrl('bitcoin', followed, explorerBase ?? TX_EXPLORER_PRESETS[0].url)
  // A refused return speaks a sentence, too long for a pill, so it stands as a line.
  const refused = refundNeedsHigherFee(deposit)
  const copyRow = (field: string, label: string, value: string) => (
    <CopyRow
      label={label}
      value={truncateMiddle(value)}
      copied={copied === `${field}:${key}`}
      onPress={() => onCopy(`${field}:${key}`, value)}
      copiedLabel={t('history.detail.copied')}
    />
  )
  return (
    <View style={styles.deposit}>
      <Figure role="title" tabular style={{ color: colors.textSecondary }}>
        {t('deposits.approx', { amount: hidden ? '••••' : formatSats(deposit.amountSat) })}
      </Figure>
      {refused ? (
        <Txt role="body" tone="muted" style={styles.statusLine}>
          {t(depositStatusKey(deposit))}
        </Txt>
      ) : (
        <View style={styles.statusPill}>
          <Txt role="labelStrong" tone="muted">
            {t(depositStatusKey(deposit))}
          </Txt>
        </View>
      )}
      <View style={styles.rowsClip}>
        <View style={styles.rows}>
          <InfoRow label={t('history.detail.network')} value={t('history.network.bitcoin')} />
          {copyRow('txid', t('history.detail.txid'), deposit.txid)}
          {deposit.refundTxId
            ? copyRow('refundTxid', t('history.detail.refundTxid'), deposit.refundTxId)
            : null}
        </View>
      </View>
      {txUrl ? (
        <GradientButton
          label={t('history.detail.viewExplorer')}
          variant="secondary"
          onPress={() => onExplore(base => explorerTxUrl('bitcoin', followed, base))}
        />
      ) : null}
    </View>
  )
}

function hasTechnicalDetails(item: HistoryItem): boolean {
  return Boolean(
    item.method || item.provider || item.txId || item.transferRef || item.paymentHash || item.preimage || item.invoice,
  )
}

// Text from the service that was paid, so it stays plain text. The address is drawn in full, since the
// words beside it are the service's own, and it opens only when it is http(s), only on a tap, and only
// on the host that was paid, since LUD-09 leaves the service free to name any other.
function SuccessAction({
  action,
  label,
}: {
  action: HistorySuccessAction
  label: string
}): React.JSX.Element {
  const url = action.kind === 'url' ? httpUrl(action.url) : null
  const opens = action.kind === 'url' && action.foreignHost !== true
  return (
    <View style={styles.comment}>
      <Txt role="caption" tone="muted">
        {label}
      </Txt>
      {action.description ? (
        <Txt role="body">{action.description}</Txt>
      ) : null}
      {action.kind === 'message' ? <Txt role="body">{action.text}</Txt> : null}
      {url && opens ? (
        <Touch onPress={() => Linking.openURL(url)} feedback="link" role="link">
          <Txt role="body" tone="accent">
            {url}
          </Txt>
        </Touch>
      ) : null}
      {url && !opens ? <Txt role="body">{url}</Txt> : null}
    </View>
  )
}

// Each row stands on what the SDK gave, so a side it did not name has no row and a fee it did not
// report is left out, never drawn as zero. What it only quoted for a Convert says so in its label, and
// a quoted fee is never drawn as a fee charged. A conversion that did not go through states no fee, as
// a failed payment states none. A row that is a conversion says its status in the
// pill; on a receive or a send the pill speaks for the payment, so the conversion says its own here.
const UNFINISHED: readonly HistoryConversionStatus[] = ['failed', 'refundPending', 'refunded']

function ConversionRows({
  conversion,
  left,
  arrived,
  pillSpeaks,
  t,
}: {
  conversion: HistoryConversion
  left?: HistoryConversionSide
  arrived?: HistoryConversionSide
  pillSpeaks: boolean
  t: (key: string, opts?: Record<string, unknown>) => string
}): React.JSX.Element {
  const { from, to, automatic, quotedFee } = conversion
  const figure = (side: HistoryConversionSide, value: string) => conversionFigure(side, value, t)
  return (
    <>
      {left?.amount !== undefined ? (
        <InfoRow
          label={t(left.quoted ? 'history.detail.leftQuoted' : 'history.detail.left')}
          figure={figure(left, left.amount)}
        />
      ) : null}
      {arrived?.amount !== undefined ? (
        <InfoRow label={t('history.detail.arrived')} figure={figure(arrived, arrived.amount)} />
      ) : null}
      {[from, to].map(side =>
        side?.fee !== undefined && !UNFINISHED.includes(conversion.status) ? (
          <InfoRow
            key={side.ticker ?? 'sats'}
            label={t('history.detail.conversionFee')}
            figure={figure(side, side.fee)}
          />
        ) : null,
      )}
      {quotedFee ? (
        <InfoRow
          label={t('history.detail.conversionFeeQuoted')}
          figure={figure({ ticker: quotedFee.ticker }, quotedFee.amount)}
        />
      ) : null}
      {automatic ? (
        <InfoRow label={t('history.detail.type')} value={t('history.detail.automatic')} />
      ) : null}
      {pillSpeaks ? null : (
        <InfoRow label={t('history.detail.conversion')} value={conversionStatusText(conversion.status, t)} />
      )}
    </>
  )
}

// A label and its value, laid out by FigureRow: side by side while both fit, the value under the
// label at a large text size. A figure shrinks to fit whole; any other value is cut on one line
// beside its label and wraps under it, where it has the row to itself.
function InfoRow(
  props: { label: string } & ({ value: string; figure?: never } | { figure: string; value?: never }),
): React.JSX.Element {
  const sideBySide = useSideBySide()
  return (
    <FigureRow label={props.label} style={styles.infoRow}>
      {props.figure !== undefined ? (
        <Figure role="bodyStrong" tabular>
          {props.figure}
        </Figure>
      ) : (
        <Txt role="bodyStrong" lines={sideBySide ? 1 : undefined}>
          {props.value}
        </Txt>
      )}
    </FigureRow>
  )
}

// What is only an estimate says so, in the language's own form.
function approxIf(estimated: boolean | undefined, value: string, t: (key: string, o: { amount: string }) => string): string {
  return estimated ? t('send.approxAmount', { amount: value }) : value
}

// The label names the value it copies, since the value shown can be the Copied line instead.
function CopyRow({
  label,
  value,
  copied,
  copiedLabel,
  onPress,
}: {
  label: string
  value: string
  copied: boolean
  copiedLabel: string
  onPress: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Touch onPress={onPress} feedback="row" label={joinLabels(t, [label, value])}>
      <Row spread pad="default" gap="md" divider>
        <Txt role="body" tone="muted">
          {label}
        </Txt>
        <Row gap="sm" style={styles.value}>
          <Txt role="bodyStrong" tone={copied ? 'muted' : 'default'} lines={1} style={styles.value}>
            {copied ? copiedLabel : value}
          </Txt>
          <TabIcon name="copy" color={colors.textSecondary} size={16} />
        </Row>
      </Row>
    </Touch>
  )
}

const styles = StyleSheet.create({
  body: {
    gap: space.lg,
    alignItems: 'center',
  },
  statusPill: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  // A label pill, so it stays textSecondary rather than the CTA-only primary orange.
  zapBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  comment: {
    alignSelf: 'stretch',
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.md,
    gap: space.xs,
  },
  // Clips what falls past it, as the last row's divider does below.
  rowsClip: {
    alignSelf: 'stretch',
    overflow: 'hidden',
  },
  // Which row ends the list depends on the payment, so the last divider is cut by position rather
  // than by naming that row.
  rows: {
    marginBottom: -stroke.hair,
    gap: space.xs,
  },
  value: {
    flexShrink: 1,
  },
  statusLine: {
    textAlign: 'center',
  },
  // One deposit's figure, status, rows and link, laid out as the payment detail lays out its own.
  deposit: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: space.lg,
  },
  // The padding and hairline of the app's list rows.
  infoRow: {
    paddingVertical: space.md,
    ...dividerBottom,
  },
})
