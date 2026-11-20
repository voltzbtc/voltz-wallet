import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Linking, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useNavigation, usePreventRemove, useRoute, type RouteProp } from '@react-navigation/native'
import Clipboard from '@react-native-clipboard/clipboard'
import {
  sparkListUnclaimedDeposits,
  sparkRecommendedFees,
  sparkRefundAddress,
  sparkRefundDeposit,
  type OnchainSpeed,
  type SparkDeposit,
  type SparkFeeRates,
} from '../wallet/spark'
import {
  canSendBack,
  noteRefundFee,
  refundNeedsHigherFee,
  refundTiersAbove,
  refusedRefundFee,
  type RefundTier,
} from '../wallet/refund'
import { formatSats } from '../wallet/amount'
import { explorerTxUrl } from '../wallet/history'
import { loadTxExplorers, resolveTxExplorerUrl, TX_EXPLORER_PRESETS } from '../wallet/settings'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { depositsRereadLimitMs } from '../components/UnclaimedDepositsCard'
import { Card } from '../components/Card'
import { ErrorBox } from '../components/ErrorBox'
import { Field } from '../components/Field'
import { Figure } from '../components/Amount'
import { FigureRow } from '../components/FigureRow'
import { GradientButton } from '../components/GradientButton'
import { Row } from '../components/Row'
import { Screen } from '../components/Screen'
import { SegmentedControl } from '../components/SegmentedControl'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import { Touch } from '../components/Touch'
import { Txt } from '../components/Txt'
import { colors, font, radius, rhythm, space, touch } from '../theme'

type Phase =
  | { name: 'loading' }
  | { name: 'loadFailed' }
  // Nothing left to send back: claimed, or refunded and confirmed, since this screen opened.
  | { name: 'gone' }
  | { name: 'running' }
  // A send that threw and a read that then could not say where the deposit stands.
  | { name: 'unconfirmed' }
  | { name: 'form' }
  | { name: 'review'; address: string; tier: RefundTier }
  | { name: 'done'; txId: string }

const sameDeposit = (txid: string, vout: number) => (d: SparkDeposit) =>
  d.txid === txid && d.vout === vout

// Fails when the limit passes first, so a read that never answers ends in Try again, not a skeleton.
function withinLimit<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('read past its limit')), depositsRereadLimitMs())
  })
  return Promise.race([read(), limit]).finally(() => clearTimeout(timer))
}

// How long a copy says so.
const COPIED_FOR_MS = 2000

const defaultSpeed = (options: RefundTier[]): OnchainSpeed =>
  options.some(tier => tier.speed === 'medium') ? 'medium' : options[0]?.speed ?? 'medium'

// Sends one deposit back to a Bitcoin address. The figure confirmed is what arrives, so the fee is fixed
// at review and travels to the SDK unchanged, with no second read of the rates in between.
export function RefundDepositScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation()
  const { txid, vout } = useRoute<RouteProp<RootStackParamList, 'RefundDeposit'>>().params
  const [phase, setPhase] = useState<Phase>({ name: 'loading' })
  const [deposit, setDeposit] = useState<SparkDeposit | null>(null)
  const [tiers, setTiers] = useState<RefundTier[]>([])
  const [speed, setSpeed] = useState<OnchainSpeed>('medium')
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState(false)
  const [resolving, setResolving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)
  const [explorerBase, setExplorerBase] = useState(TX_EXPLORER_PRESETS[0].url)
  // Set before the first await, since a second tap lands before a render.
  const sending = useRef(false)
  const mounted = useRef(true)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadSeq = useRef(0)
  const resolveSeq = useRef(0)
  // The rates the speeds were priced at, kept so a refusal reprices them with no second read.
  const ratesRead = useRef<SparkFeeRates | null>(null)

  // Back does nothing while the refund runs, since its answer decides what the screen may say.
  usePreventRemove(busy, () => undefined)

  const load = useCallback(async () => {
    const mine = ++loadSeq.current
    setPhase({ name: 'loading' })
    try {
      const [found, rates, refusedFee] = await withinLimit(async () => {
        const [list, read] = await Promise.all([sparkListUnclaimedDeposits(), sparkRecommendedFees()])
        const listed = list.find(sameDeposit(txid, vout))
        // The fee on record matters only to a refund the network refused, which the next must outbid.
        const fee = listed && refundNeedsHigherFee(listed) ? await refusedRefundFee(txid, vout) : null
        return [listed, read, fee] as const
      })
      if (!mounted.current || mine !== loadSeq.current) {
        return
      }
      if (!found) {
        setPhase({ name: 'gone' })
      } else if (!canSendBack(found)) {
        setPhase({ name: 'running' })
      } else {
        const options = refundTiersAbove(found.amountSat, rates, refusedFee)
        ratesRead.current = rates
        setDeposit(found)
        setTiers(options)
        setSpeed(defaultSpeed(options))
        setPhase({ name: 'form' })
      }
    } catch {
      // A guessed fee would be a number nobody can stand behind, so there is no fallback rate.
      if (mounted.current && mine === loadSeq.current) {
        setPhase({ name: 'loadFailed' })
      }
    }
  }, [txid, vout])

  useEffect(() => {
    mounted.current = true
    load()
    return () => {
      mounted.current = false
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    }
  }, [load])

  useEffect(() => {
    if (phase.name !== 'done') {
      return
    }
    let alive = true
    loadTxExplorers()
      .then(config => alive && setExplorerBase(resolveTxExplorerUrl(config)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [phase.name])

  function changeAddress(text: string) {
    resolveSeq.current += 1
    setResolving(false)
    setAddress(text)
    setAddressError(false)
  }

  // An empty read is the iOS paste prompt, not an error, so the next tap pastes.
  async function paste() {
    const text = await Clipboard.getString()
    if (text) {
      changeAddress(text.trim())
    }
  }

  async function toReview() {
    const tier = tiers.find(option => option.speed === speed)
    if (!tier || address.trim() === '') {
      return
    }
    const mine = ++resolveSeq.current
    setResolving(true)
    const resolved = await sparkRefundAddress(address).catch(() => null)
    if (!mounted.current || mine !== resolveSeq.current) {
      return
    }
    setResolving(false)
    if (resolved === null) {
      setAddressError(true)
      return
    }
    setError(null)
    setPhase({ name: 'review', address: resolved, tier })
  }

  async function confirm() {
    if (sending.current || phase.name !== 'review') {
      return
    }
    sending.current = true
    setBusy(true)
    setError(null)
    const finish = (next?: Phase) => {
      sending.current = false
      if (mounted.current) {
        setBusy(false)
        if (next) {
          setPhase(next)
        }
      }
    }
    const before = deposit
    // An automatic claim can take the deposit with this screen open, and nothing refuses a refund then.
    let current: SparkDeposit | undefined
    try {
      current = (await withinLimit(sparkListUnclaimedDeposits)).find(sameDeposit(txid, vout))
    } catch {
      if (mounted.current) {
        setError(t('deposits.refundLoadFailed'))
      }
      finish()
      return
    }
    if (!current) {
      finish({ name: 'gone' })
      return
    }
    if (!canSendBack(current)) {
      finish({ name: 'running' })
      return
    }
    // The fee goes on record before the SDK can sign it, since the SDK keeps no fee of a refusal and a
    // retry has to outbid it, also after a restart. Unrecorded, nothing is signed.
    try {
      await noteRefundFee(txid, vout, phase.tier.feeSat)
    } catch {
      if (mounted.current) {
        setError(t('deposits.refundFailed'))
      }
      finish()
      return
    }
    try {
      const txId = await sparkRefundDeposit(txid, vout, phase.address, phase.tier.feeSat)
      finish({ name: 'done', txId })
    } catch {
      // The SDK stores a signed refund before it broadcasts and throws when the network refuses it, so
      // a throw may mean a refund exists. Only the list can say.
      let after: SparkDeposit | undefined
      try {
        after = (await withinLimit(sparkListUnclaimedDeposits)).find(sameDeposit(txid, vout))
      } catch {
        finish({ name: 'unconfirmed' })
        return
      }
      const signed = after?.refundTxId !== undefined && after.refundTxId !== before?.refundTxId
      if (!after) {
        finish({ name: 'gone' })
      } else if (signed && refundNeedsHigherFee(after)) {
        // The refusal is recorded, and a rebroadcast of the same fee will not cure it, so the speeds
        // offered next start above the fee just signed.
        if (mounted.current) {
          setDeposit(after)
          if (ratesRead.current) {
            const options = refundTiersAbove(after.amountSat, ratesRead.current, phase.tier.feeSat)
            setTiers(options)
            setSpeed(defaultSpeed(options))
          }
        }
        finish({ name: 'form' })
      } else if (signed) {
        finish({ name: 'running' })
      } else {
        // Nothing new was signed, so asking again is safe. A refund already refused needs a higher fee.
        if (mounted.current) {
          setError(t(after.refundTxId === undefined ? 'deposits.refundFailed' : 'deposits.refundFeeRefused'))
        }
        finish()
      }
    }
  }

  const back = () => navigation.goBack()

  function copyTxId(txId: string) {
    Clipboard.setString(txId)
    // The word changes only on screen, and a screen reader hears nothing of it.
    AccessibilityInfo.announceForAccessibility(t('history.detail.copied'))
    setCopied(true)
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS)
  }

  if (phase.name === 'loading') {
    return (
      <Screen scroll layout="padded" contentStyle={styles.body}>
        {/* The form's shape: the amount, the address field and the speed. */}
        <Card gap="sm">
          <Skeleton width="40%" height={font.leading.sm} />
          <Skeleton width="30%" height={font.leading.base} />
        </Card>
        <View style={styles.group}>
          <Skeleton width="40%" height={font.leading.sm} />
          <Skeleton height={touch.selector} borderRadius={radius.lg} />
        </View>
        <View style={styles.group}>
          <Skeleton width="25%" height={font.leading.sm} />
          <Skeleton height={touch.selector} borderRadius={radius.lg} />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'loadFailed') {
    return (
      <Screen layout="center">
        <View style={styles.action}>
          <ErrorBox message={t('deposits.refundLoadFailed')} style={styles.error} />
          <GradientButton label={t('common.retry')} variant="secondary" onPress={load} />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'gone' || phase.name === 'running' || phase.name === 'unconfirmed') {
    const message = {
      gone: 'deposits.refundGone',
      running: 'deposits.returning',
      unconfirmed: 'deposits.refundUnconfirmed',
    }[phase.name]
    return (
      <Screen layout="center">
        <Txt role="body" style={styles.centered}>
          {t(message)}
        </Txt>
        <View style={styles.action}>
          <GradientButton label={t('common.back')} variant="secondary" onPress={back} />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'done') {
    const url = explorerTxUrl('bitcoin', phase.txId, explorerBase)
    return (
      <Screen scroll layout="padded" contentStyle={styles.body}>
        <View style={styles.group}>
          <Txt role="bodyBold">{t('deposits.refundDoneTitle')}</Txt>
          <Txt role="caption" tone="muted">
            {t('deposits.refundDoneBody')}
          </Txt>
        </View>
        <Touch onPress={() => copyTxId(phase.txId)} feedback="surface" label={t('history.detail.txid')}>
          <Card gap="sm">
            <Txt role="caption" tone="muted">
              {copied ? t('history.detail.copied') : t('history.detail.txid')}
            </Txt>
            <Row gap="sm">
              <Txt role="label" style={styles.txId}>
                {phase.txId}
              </Txt>
              <TabIcon name="copy" color={colors.textSecondary} size={16} />
            </Row>
          </Card>
        </Touch>
        <View style={styles.actions}>
          {url ? (
            <GradientButton
              label={t('history.detail.viewExplorer')}
              variant="secondary"
              onPress={() => Linking.openURL(url)}
            />
          ) : null}
          <GradientButton label={t('common.close')} onPress={back} />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'review') {
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <ErrorBox message={error} style={styles.error} />
            <GradientButton label={t('send.confirm')} onPress={confirm} loading={busy} />
          </View>
        }>
        <Card gap="md">
          <FigureRow label={t('deposits.refundArrives')} labelRole="caption" align="baseline">
            <Figure role="bodyBold" tabular>
              {t('send.sats', { amount: formatSats(phase.tier.netSat) })}
            </Figure>
          </FigureRow>
          <FigureRow label={t('deposits.refundFee')} labelRole="caption" align="baseline">
            <Figure role="caption" tabular>
              {t('send.sats', { amount: formatSats(phase.tier.feeSat) })}
            </Figure>
          </FigureRow>
          <Txt role="caption" tone="muted">
            {t('send.to')}
          </Txt>
          <Txt role="label" style={styles.txId}>
            {phase.address}
          </Txt>
        </Card>
        <Touch onPress={() => setPhase({ name: 'form' })} feedback="link" disabled={busy}>
          <Txt role="label" tone="muted" style={styles.centered}>
            {t('common.back')}
          </Txt>
        </Touch>
      </Screen>
    )
  }

  const amountSat = deposit?.amountSat ?? 0
  const refused = deposit !== null && refundNeedsHigherFee(deposit)
  const chosen = tiers.find(option => option.speed === speed)
  const speedLabels: Record<OnchainSpeed, string> = {
    fast: t('send.speedFast'),
    medium: t('send.speedMedium'),
    slow: t('send.speedSlow'),
  }

  return (
    <Screen
      scroll
      keyboard
      layout="padded"
      contentStyle={styles.body}
      footer={
        tiers.length > 0 ? (
          <View style={styles.footer}>
            <GradientButton
              label={t('deposits.refundContinue')}
              onPress={toReview}
              loading={resolving}
              disabled={address.trim() === ''}
            />
          </View>
        ) : undefined
      }>
      <ErrorBox message={refused && tiers.length > 0 ? t('deposits.refundStalled') : null} />
      <Card gap="sm">
        <Txt role="caption" tone="muted">
          {t('deposits.refundAmount')}
        </Txt>
        <Figure role="bodyBold" tabular>
          {t('send.sats', { amount: formatSats(amountSat) })}
        </Figure>
      </Card>

      {tiers.length === 0 ? (
        <Txt role="body">{t('deposits.refundTooSmall')}</Txt>
      ) : (
        <>
          <Field
            value={address}
            onChangeText={changeAddress}
            label={t('deposits.refundAddress')}
            error={addressError ? t('deposits.refundBadAddress') : undefined}
            autoCapitalize="none"
            autoCorrect={false}
            trailing={
              <Touch onPress={paste} feedback="link" hitSlop={space.sm}>
                <Row gap="xs">
                  <TabIcon name="paste" color={colors.text} size={16} />
                  <Txt role="label">{t('addAsset.paste')}</Txt>
                </Row>
              </Touch>
            }
          />
          <View style={styles.group}>
            <Txt role="label" tone="muted">
              {t('send.speed')}
            </Txt>
            <SegmentedControl
              options={tiers.map(option => ({ label: speedLabels[option.speed], value: option.speed }))}
              value={speed}
              onChange={setSpeed}
            />
            {chosen && (
              <Txt role="caption" tone="muted">
                {t('deposits.refundPreview', {
                  amount: formatSats(chosen.netSat),
                  fee: formatSats(chosen.feeSat),
                })}
              </Txt>
            )}
          </View>
        </>
      )}
    </Screen>
  )
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  // Stretched, since a centred screen would otherwise shrink the button to its label.
  action: {
    alignSelf: 'stretch',
    marginTop: space.lg,
  },
  group: {
    gap: space.sm,
  },
  actions: {
    gap: space.md,
  },
  error: {
    marginBottom: space.md,
  },
  footer: {
    padding: space.xl,
  },
  body: {
    gap: rhythm.section,
  },
  txId: {
    flexShrink: 1,
  },
})
