import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, View, type ViewStyle } from 'react-native'
import { Txt } from './Txt'
import { useTranslation } from 'react-i18next'
import {
  SYNC_WAIT_MS,
  sparkListUnclaimedDeposits,
  sparkClaimDeposit,
  type SparkDeposit,
} from '../wallet/spark'
import { refundNeedsHigherFee } from '../wallet/refund'
import { ReceiveHeldByExit, isDepositTooSmall } from '../wallet/errors'
import { formatSats } from '../wallet/amount'
import { GlassCard } from './GlassCard'
import { GradientButton } from './GradientButton'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'
import { DepositDetailSheet } from './TransactionDetailSheet'
import { joinLabels } from '../i18n/join'
import { useAccent } from '../wallet/dollarMode'
import { useAnnounced } from '../hooks/useAnnounced'
import { useUnderLock } from './UnderLock'
import { colors, radius, space } from '../theme'

// `held` and `heldUnread` are a claim refused before the SDK because the wallet's exit is alive or unread.
type Failure = 'claim' | 'held' | 'heldUnread' | 'unchecked' | null

type Props = {
  // Bumped to re-check for deposits when the Home reloads.
  refreshKey?: number
  onClaimed?: () => void
  // Retrying a return the network refused takes its own screen, one deposit at a time.
  onRefund?: (deposit: SparkDeposit) => void
  // The deposit is part of the balance, so a hidden balance hides its amount and fee too.
  hidden?: boolean
  // The connection's sync ran out, so what the card holds is the last state stored.
  stale?: boolean
  // Where the card sits on the screen, which belongs to the caller.
  style?: ViewStyle
}

// How long a read after a claim run or a Try again may take before it counts as failed. A read that
// never answers would otherwise keep the spinner and the figure from before the run, with Try again
// out of reach until the card unmounts.
//
// It is the sync wait, read as each read starts. A stand-in for spark.ts that leaves SYNC_WAIT_MS out
// would otherwise make it setTimeout(fn, undefined), which cuts every read at once, so the fallback
// keeps the same figure.
const REREAD_LIMIT_FALLBACK_MS = 12_000

const sum = (list: SparkDeposit[], value: (d: SparkDeposit) => number): number =>
  list.reduce((total, d) => total + value(d), 0)

// A quote at or above the amount leaves nothing to receive, so accepting it is not offered. Per
// deposit rather than over the sum, which a large one would hide a losing one behind.
const payableOf = (list: SparkDeposit[]): SparkDeposit[] =>
  list.filter(d => d.claimable && (d.quotedFeeSat === undefined || d.quotedFeeSat < d.amountSat))

const quotedOf = (list: SparkDeposit[]): SparkDeposit[] =>
  payableOf(list).filter(d => d.quotedFeeSat !== undefined)

const sameQuote = (a: SparkDeposit, b: SparkDeposit): boolean =>
  a.txid === b.txid && a.vout === b.vout && a.quotedFeeSat === b.quotedFeeSat

// A deposit a claim since the last read may have taken, whose figure a failed refresh cannot vouch
// for. Spelled out rather than through canSendBack, since the card sends nothing back.
const mayHaveBeenClaimed = (d: SparkDeposit): boolean =>
  d.claimable || d.refundable || refundNeedsHigherFee(d)

export function depositsRereadLimitMs(): number {
  return typeof SYNC_WAIT_MS === 'number' && SYNC_WAIT_MS > 0 ? SYNC_WAIT_MS : REREAD_LIMIT_FALLBACK_MS
}

// A deposit the automatic ceiling refused waits here. When the refusal was about price, the quoted fee
// is named before the tap and then carried on the claim, so it is not refused a second time, and money on
// its way says so with no button. A claim that failed for another reason is retried by the SDK on every
// sync, and is offered Try again. The card never offers to send a deposit back: no answer the SDK gives
// says a deposit is beyond claiming (a failure can come on the network, or after the provider took the
// claim), so the one way back it offers is the retry of a return the person already started and the
// network refused, which would otherwise stay stuck in flight.
export function UnclaimedDepositsCard({
  refreshKey,
  onClaimed,
  onRefund,
  hidden = false,
  stale = false,
  style,
}: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const [deposits, setDeposits] = useState<SparkDeposit[]>([])
  const [detailOpen, setDetailOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  // Why the card is not just the list it read: a claim in the last run failed, or the last read
  // failed (after a claim run or on a refresh), so the list it holds may count deposits already claimed.
  const [failure, setFailureState] = useState<Failure>(null)
  // Held in refs as well, since a second tap and a late read arrive before a render.
  const claiming = useRef(false)
  const mounted = useRef(true)
  // What the card draws now, which a claim run reads when it ends rather than what held at the tap.
  const failureNow = useRef<Failure>(null)
  const hiddenNow = useRef(hidden)
  hiddenNow.current = hidden
  // A run that ends under the lock says nothing over it.
  const underLock = useUnderLock()
  const underLockNow = useRef(underLock)
  underLockNow.current = underLock
  const setFailure = useCallback((next: Failure | ((prev: Failure) => Failure)) => {
    failureNow.current = typeof next === 'function' ? next(failureNow.current) : next
    setFailureState(failureNow.current)
  }, [])
  // Only the last read started may set the list, so a refresh that began before a claim run never
  // lands over the read that follows it.
  const readSeq = useRef(0)
  // The number of the last read whose list the card took. A claim run's read that a newer read
  // superseded still replaces the list from before the run while that newer read has not answered.
  const landed = useRef(0)
  // The last list the card took. A failed refresh reads it to keep the card that was up, and never
  // draws one that was not, since nothing then says there are funds to claim.
  const held = useRef<SparkDeposit[]>([])
  // The limits of the reads in flight, cleared when the card unmounts.
  const limits = useRef(new Set<ReturnType<typeof setTimeout>>())

  useEffect(() => {
    mounted.current = true
    const pending = limits.current
    return () => {
      mounted.current = false
      pending.forEach(timer => clearTimeout(timer))
      pending.clear()
    }
  }, [])

  // Settles with the list, or fails with the read or when the limit passes first. An answer after the
  // limit goes to late instead, where the caller keeps it only while no newer read has started.
  const withinLimit = useCallback(
    (late: (list: SparkDeposit[]) => void): Promise<SparkDeposit[]> =>
      new Promise((resolve, reject) => {
        let cut = false
        const timer = setTimeout(() => {
          limits.current.delete(timer)
          cut = true
          reject(new Error('deposits read past its limit'))
        }, depositsRereadLimitMs())
        limits.current.add(timer)
        sparkListUnclaimedDeposits().then(
          list => {
            clearTimeout(timer)
            limits.current.delete(timer)
            if (cut) {
              late(list)
            } else {
              resolve(list)
            }
          },
          error => {
            clearTimeout(timer)
            limits.current.delete(timer)
            if (!cut) {
              reject(error)
            }
          },
        )
      }),
    [],
  )

  // Every list the card takes goes through here, so held is always the list the card holds.
  const take = useCallback(
    (seq: number, list: SparkDeposit[]) => {
      landed.current = seq
      held.current = list
      setDeposits(list)
    },
    [],
  )

  const reload = useCallback(() => {
    let alive = true
    const seq = ++readSeq.current
    sparkListUnclaimedDeposits()
      .then(list => {
        if (alive && seq === readSeq.current) {
          take(seq, list)
          // A read that answered is the check the unchecked line was waiting for.
          setFailure(prev => (prev === 'unchecked' ? null : prev))
        }
      })
      .catch(() => {
        // A read that failed is not an empty list. The card stays, with its figure hidden until a read
        // answers, since the deposits may have been claimed meanwhile.
        if (alive && seq === readSeq.current && held.current.some(mayHaveBeenClaimed)) {
          setFailure('unchecked')
        }
      })
    return () => {
      alive = false
    }
  }, [take, setFailure])
  useEffect(reload, [reload, refreshKey])

  const payable = payableOf(deposits)
  const quoted = quotedOf(deposits)
  const readySat = sum(payable.filter(d => d.quotedFeeSat === undefined), d => d.amountSat)
  const feeSat = sum(quoted, d => d.quotedFeeSat ?? 0)
  // The claim is refused above its ceiling, and the ceiling is the quote, so this is the floor.
  const leastSat = sum(quoted, d => d.amountSat) - feeSat
  const arrivingSat = sum(deposits.filter(d => d.stage === 'arriving' && !d.claimable), d => d.amountSat)
  // Each line names its figure, since the card can hold deposits in different stages at once. A quote at
  // or above the amount leaves nothing to receive, which is too small at today's fees as well.
  const smallSat = sum(
    deposits.filter(d => d.stage === 'tooSmall' || (d.claimable && !payable.includes(d))),
    d => d.amountSat,
  )
  const stuckSat = sum(deposits.filter(d => d.stage === 'stuck'), d => d.amountSat)
  const returning = deposits.some(d => d.stage === 'returning' && !refundNeedsHigherFee(d))
  const stalled = deposits.some(refundNeedsHigherFee)
  // A return the network refused, whose retry at a higher fee is the only way back the card offers.
  const refused = deposits.find(refundNeedsHigherFee)
  // Unchecked keeps the card up whatever the list holds, since only a read that answers can say there
  // is nothing left to claim.
  const unchecked = failure === 'unchecked'
  // The detail lists what the latest read answered. A read that could not check, or one that lists
  // nothing, closes it and forgets it, so a later read never opens it with nobody tapping.
  const canOpen = !unchecked && deposits.length > 0
  useEffect(() => {
    if (!canOpen) {
      setDetailOpen(false)
    }
  }, [canOpen])
  const cardUp = deposits.length > 0 || unchecked
  // Called before the card can leave, and only for a line it draws.
  const failureKey =
    failure === 'unchecked'
      ? 'deposits.unchecked'
      : failure === 'held'
      ? 'emergencyExit.receiveHeld'
      : failure === 'heldUnread'
      ? 'emergencyExit.receiveHeldUnread'
      : 'deposits.claimFailed'
  const failureLine = cardUp && failure !== null ? t(failureKey) : null
  useAnnounced(failureLine)
  if (!cardUp) {
    return null
  }
  const show = (sats: number) => (hidden ? '••••' : formatSats(sats))

  // Reads the deposits first, since the list on screen can be old: the automatic claim, or a refund
  // started meanwhile, which claim_deposit does not refuse, may have taken one. Only what that read
  // lists as claimable at the quote the person saw is signed, a deposit quoted otherwise is drawn
  // again with the newest quote the card has read, for the next tap, and a read that fails or does
  // not answer signs nothing. Then claims in sequence and reads again whatever happened, because a
  // claim that fails after others passed leaves those already claimed in the list the card was
  // showing, and the next tap would claim them again.
  async function claimAll() {
    if (claiming.current) {
      return
    }
    claiming.current = true
    setBusy(true)
    setFailure(null)
    const seen = payable
    // A tap that leaves a deposit at a quote the person did not see redraws the fee line without a
    // word, so a screen reader is told the line as drawn. Nothing is said when the line shows no
    // figure: the balance hidden, or the card unchecked, both read when the run ends.
    const sayMovedFee = () => {
      const drawn = quotedOf(held.current)
      const shown = !hiddenNow.current && !underLockNow.current && failureNow.current !== 'unchecked'
      if (mounted.current && shown && drawn.some(d => !seen.some(s => sameQuote(s, d)))) {
        AccessibilityInfo.announceForAccessibility(
          t('deposits.fee', { amount: formatSats(sum(drawn, d => d.quotedFeeSat ?? 0)) }),
        )
      }
    }
    const first = ++readSeq.current
    let current: SparkDeposit[]
    try {
      // An answer past the limit is the check the unchecked line waits for, and it signs nothing.
      current = await withinLimit(late => {
        if (mounted.current && first === readSeq.current) {
          take(first, late)
          setFailure(prev => (prev === 'unchecked' ? null : prev))
          // The tap that started this read signed nothing, so a quote that moved is said as for an
          // answer in time.
          sayMovedFee()
        }
      })
    } catch {
      // A newer read that answered meanwhile is the list on screen, and nothing was signed either way.
      claiming.current = false
      if (mounted.current) {
        setBusy(false)
        setFailure(landed.current > first ? null : 'unchecked')
      }
      return
    }
    if (!mounted.current) {
      claiming.current = false
      return
    }
    if (landed.current < first) {
      take(first, current)
    }
    const toClaim = current.filter(d => d.claimable && seen.some(s => sameQuote(s, d)))
    if (toClaim.length === 0) {
      claiming.current = false
      setBusy(false)
      sayMovedFee()
      if (!current.some(d => d.claimable)) {
        onClaimed?.()
      }
      return
    }
    let claimFailed: Failure = null
    try {
      for (const d of toClaim) {
        try {
          await sparkClaimDeposit(d.txid, d.vout, d.quotedFeeSat)
        } catch (error) {
          if (error instanceof ReceiveHeldByExit) {
            claimFailed = error.hold === 'exit' ? 'held' : 'heldUnread'
            break
          }
          // Too small for today's fees is an outcome the read below states, so it is not a failed run
          // and it does not hold back the deposits after it.
          if (!isDepositTooSmall(error)) {
            throw error
          }
        }
      }
    } catch {
      claimFailed = 'claim'
    }
    const seq = ++readSeq.current
    const answered = (list: SparkDeposit[]) => {
      take(seq, list)
      setFailure(claimFailed)
      sayMovedFee()
      // Fires when no claimable deposit is left, which a list holding only deposits the SDK cannot
      // claim yet also meets, not only an empty one. The effect is a Home refresh, so firing on that
      // list as well costs a read and nothing else.
      if (!list.some(d => d.claimable)) {
        onClaimed?.()
      }
    }
    try {
      const list = await withinLimit(late => {
        if (mounted.current && seq === readSeq.current) {
          answered(late)
        }
      })
      if (!mounted.current) {
        return
      }
      // A read started after this one sets the list when it answers, and the failed claim is still
      // said beside it. Until then this list, read after the claims, replaces the one from before.
      if (seq !== readSeq.current) {
        if (landed.current < seq) {
          take(seq, list)
        }
        setFailure(claimFailed)
        sayMovedFee()
        return
      }
      answered(list)
    } catch {
      // The list from before the run may count deposits already claimed, so its figure is hidden
      // until a read answers, even with a newer read on its way. One that already answered has
      // replaced that list. A read past its limit is a failed one.
      if (mounted.current) {
        setFailure(landed.current > seq ? claimFailed : 'unchecked')
      }
    } finally {
      claiming.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  // Reads the deposits again when the last read failed, after a claim run or on a refresh. Nothing is
  // claimed from here, since the list the card holds may name deposits already claimed.
  async function recheck() {
    if (claiming.current) {
      return
    }
    claiming.current = true
    setBusy(true)
    const seq = ++readSeq.current
    // A newer read clears the line itself when it answers.
    const answered = (list: SparkDeposit[]) => {
      if (!mounted.current || seq !== readSeq.current) {
        return
      }
      take(seq, list)
      setFailure(null)
      // No claimable deposit is left, by the same rule as after a claim run, so Home reads the balance
      // again: this is the read a claim run could not make, or, after a failed refresh, the deposits
      // may have been claimed meanwhile.
      if (!list.some(d => d.claimable)) {
        onClaimed?.()
      }
    }
    try {
      answered(await withinLimit(answered))
    } catch {
      // Stays unchecked, with Try again still offered, after a failure or once the limit passes.
    } finally {
      claiming.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  // Try again on a deposit whose claim failed for a reason other than its fee or its size. It reads the
  // list first, as a claim run does, and claims only what that read lists as failing, since a deposit
  // being sent back is not refused by a claim. Each is claimed with no ceiling of its own, so never above
  // the one the automatic claim uses. A claim's answer is not a verdict on the deposit (a refusal can come
  // on the network, or after the provider took it), so nothing is said of it and the read after is what
  // the card draws.
  async function retryStuck() {
    if (claiming.current) {
      return
    }
    claiming.current = true
    setBusy(true)
    setFailure(null)
    const first = ++readSeq.current
    let current: SparkDeposit[]
    try {
      current = await withinLimit(late => {
        if (mounted.current && first === readSeq.current) {
          take(first, late)
          setFailure(prev => (prev === 'unchecked' ? null : prev))
        }
      })
    } catch {
      // Nothing was claimed, and a newer read that answered meanwhile is the list on screen.
      claiming.current = false
      if (mounted.current) {
        setBusy(false)
        setFailure(landed.current > first ? null : 'unchecked')
      }
      return
    }
    if (!mounted.current) {
      claiming.current = false
      return
    }
    if (landed.current < first) {
      take(first, current)
    }
    for (const d of current.filter(deposit => deposit.stage === 'stuck')) {
      await sparkClaimDeposit(d.txid, d.vout).catch(() => undefined)
    }
    const seq = ++readSeq.current
    const answered = (list: SparkDeposit[]) => {
      if (!mounted.current || seq !== readSeq.current) {
        return
      }
      take(seq, list)
      setFailure(prev => (prev === 'unchecked' ? null : prev))
      if (!list.some(d => d.claimable)) {
        onClaimed?.()
      }
    }
    try {
      answered(await withinLimit(answered))
    } catch {
      // The claims may have taken a deposit, so the list from before is not drawn as it was.
      if (mounted.current) {
        setFailure(landed.current > seq ? null : 'unchecked')
      }
    } finally {
      claiming.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  // The summary's lines, drawn under the title and read as the summary's label when it opens the
  // detail. The arriving figure is the gross amount, since what lands is known only once it lands.
  const lines: string[] = unchecked
    ? []
    : [
        ...(readySat > 0 ? [t('deposits.amount', { amount: show(readySat) })] : []),
        ...(quoted.length > 0
          ? [
              t('deposits.atLeast', { amount: show(leastSat) }),
              t('deposits.fee', { amount: show(feeSat) }),
            ]
          : []),
        ...(arrivingSat > 0 ? [t('deposits.arrivingAmount', { amount: show(arrivingSat) })] : []),
        ...(smallSat > 0 ? [t('deposits.tooSmall', { amount: show(smallSat) })] : []),
        ...(stuckSat > 0 ? [t('deposits.retrying', { amount: show(stuckSat) })] : []),
        ...(returning ? [t('deposits.returning')] : []),
        ...(stalled ? [t('deposits.refundStalled')] : []),
      ]
  if (stale) {
    lines.push(t('home.notUpdated'))
  }
  const header = (
    <>
      <View style={styles.icon}>
        <TabIcon name="receive" color={accent} size={22} strokeWidth={2.5} />
      </View>
      <View style={styles.text}>
        <Txt role="bodyBold">{t('deposits.title')}</Txt>
        {lines.map((line, index) => (
          <Txt key={index} role="caption" tone="muted">
            {line}
          </Txt>
        ))}
      </View>
      {canOpen && <TabIcon name="chevron" color={colors.textSecondary} size={18} />}
    </>
  )

  return (
    <GlassCard style={StyleSheet.flatten([styles.card, style])}>
      {canOpen ? (
        <Touch
          onPress={() => setDetailOpen(true)}
          feedback="surface"
          label={joinLabels(t, [t('deposits.title'), ...lines])}
          hint={t('history.detail.depositHint')}
          style={styles.row}>
          {header}
        </Touch>
      ) : (
        <View style={styles.row}>{header}</View>
      )}
      {failureLine && (
        <Txt role="caption" tone="danger" accessibilityRole="alert">
          {failureLine}
        </Txt>
      )}
      {unchecked ? (
        <GradientButton label={t('common.retry')} onPress={recheck} loading={busy} />
      ) : (
        <>
          {payable.length > 0 ? (
            // The spinner says the claim is running, so the label stays the action's name.
            <GradientButton
              label={t(quoted.length > 0 ? 'deposits.acceptFee' : 'deposits.claim')}
              onPress={claimAll}
              loading={busy}
            />
          ) : (
            stuckSat > 0 && <GradientButton label={t('common.retry')} onPress={retryStuck} loading={busy} />
          )}
          {refused && (
            <GradientButton
              label={t('deposits.refundRetry')}
              variant="secondary"
              disabled={busy}
              onPress={() => onRefund?.(refused)}
            />
          )}
        </>
      )}
      <DepositDetailSheet
        deposits={detailOpen && canOpen ? deposits : []}
        hidden={hidden}
        onClose={() => setDetailOpen(false)}
      />
    </GlassCard>
  )
}

// The size of a direction badge, the disc this stands beside in a list.
const ICON_DISC = 40

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
    gap: space.md,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  icon: {
    width: ICON_DISC,
    height: ICON_DISC,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceVariant,
    alignItems: 'center',
    justifyContent: 'center',
  },
  text: {
    flex: 1,
    gap: space.xs,
  },
})
