import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  useFocusEffect,
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import Clipboard from '@react-native-clipboard/clipboard'
import { Card } from '../components/Card'
import { ErrorBox } from '../components/ErrorBox'
import { Figure } from '../components/Amount'
import { Field } from '../components/Field'
import { FigureRow } from '../components/FigureRow'
import { GradientButton } from '../components/GradientButton'
import { Row } from '../components/Row'
import { CenterStack, Screen } from '../components/Screen'
import { Skeleton } from '../components/Skeleton'
import { TabIcon } from '../components/TabIcon'
import { Touch } from '../components/Touch'
import { Txt } from '../components/Txt'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { formatSats } from '../wallet/amount'
import { answerWithin } from '../wallet/answerWithin'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { isUnreadableFile } from '../wallet/durableFile'
import {
  confirmAsk,
  exitFundingAddress,
  leaveExit,
  lookAtFunding,
  payMore,
  prepareExit,
  runExitPass,
  startExit,
  waitsOnChainRead,
  type ExitAsk,
  type ExitQuote,
  type FundingLook,
  type PassOutcome,
  type Shortfall,
} from '../wallet/exitPass'
import {
  exitPlanWasSetAside,
  forgetExitPlan,
  isExitPlanUnread,
  isLivePlan,
  loadExitPlan,
  type ExitClosure,
  type ExitPlan,
} from '../wallet/exitPlan'
import {
  exitArriving,
  fundingNeededSat,
  mayGoOn,
  planArriving,
  quoteVerdict,
  type Arriving,
  type QuoteVerdict,
} from '../wallet/exitQuote'
import { formatTime } from '../wallet/history'
import {
  connectActiveSpark,
  sparkConnectedWalletId,
  sparkExitDestination,
  sparkRecoverySteps,
  sparkSkippedReasons,
  sparkSyncState,
  type SparkRecoveryStep,
} from '../wallet/spark'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { colors, font, space } from '../theme'

type Phase =
  | { name: 'loading' }
  // The platform refused the read of the plan, which never reads as no exit.
  | { name: 'unreadable' }
  // The network answers, so Send does this cheaper. One tap past it is still allowed.
  | { name: 'networkUp' }
  | { name: 'intro' }
  | { name: 'destination' }
  | { name: 'quoting' }
  | { name: 'empty'; line: string }
  | { name: 'review'; quoted: ExitQuote; note: string | null }
  | { name: 'fund'; quoted: ExitQuote }
  | { name: 'tracking' }
  // New figures for the plan under way. It leaves `tracking`, so no pass runs under the person's answer.
  | { name: 'ask'; ask: ExitAsk; note: string | null; short?: Shortfall & { address: string } }
  | { name: 'leaving'; ask: ExitAsk }

const CLOSURE_LINE: Record<ExitClosure, string> = {
  nothing: 'nothing',
  fee: 'nothingFee',
  data: 'nothingData',
  later: 'closedLater',
}

const FUNDING_READ_EVERY_MS = 30_000
const PASS_EVERY_MS = 30_000
const CONNECT_WAIT_MS = 10_000

// The day this screen matters a connect may never answer, so what can be shown does not wait for it.
const connectWithin = (): Promise<unknown> =>
  answerWithin(
    connectActiveSpark().then(
      () => true,
      () => null,
    ),
    CONNECT_WAIT_MS,
  )

const cannotReadPlan = (cause: unknown): boolean => isUnreadableFile(cause) || isExitPlanUnread(cause)

const COPIED_MS = 2000

// Copies and says so for two seconds, to the eye through what it returns and to a screen reader
// through an announcement, since the word changing on screen reaches only the eye.
function useCopied(): [boolean, (text: string) => void] {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) {
        clearTimeout(timer.current)
      }
    },
    [],
  )
  const copy = (text: string): void => {
    Clipboard.setString(text)
    AccessibilityInfo.announceForAccessibility(t('emergencyExit.copied'))
    setCopied(true)
    if (timer.current) {
      clearTimeout(timer.current)
    }
    timer.current = setTimeout(() => setCopied(false), COPIED_MS)
  }
  return [copied, copy]
}

// A phase's title and what it says first, one group, so the title reads as the heading of that text
// rather than as one more paragraph at the distance between paragraphs.
function Titled({
  title,
  centered = false,
  children,
}: {
  title: string
  centered?: boolean
  children?: React.ReactNode
}): React.JSX.Element {
  return (
    <View style={styles.titled}>
      <Txt role="subheading" accessibilityRole="header" style={centered && styles.centered}>
        {title}
      </Txt>
      {children}
    </View>
  )
}

// `atLeast` marks a floor: the figure says what arrives at the least, never more than arrives.
const SatsLine = ({
  label,
  sat,
  atLeast = false,
}: {
  label: string
  sat: number
  atLeast?: boolean
}): React.JSX.Element => {
  const { t } = useTranslation()
  const sats = t('send.sats', { amount: formatSats(sat) })
  return (
    <FigureRow label={label} labelRole="caption" align="baseline">
      <Figure role="bodyBold" tabular>
        {atLeast ? t('emergencyExit.atLeast', { amount: sats }) : sats}
      </Figure>
    </FigureRow>
  )
}

// What arrives, from exitArriving, the one source every exit screen and Home read.
const ArrivesLine = ({ arriving }: { arriving: Arriving }): React.JSX.Element => {
  const { t } = useTranslation()
  return <SatsLine label={t('emergencyExit.reviewArrives')} sat={arriving.sat} atLeast={arriving.floor} />
}

function CopyAddress({ address }: { address: string }): React.JSX.Element {
  const { t } = useTranslation()
  const [copied, copy] = useCopied()
  return (
    <Touch onPress={() => copy(address)} feedback="surface" label={t('emergencyExit.copyAddress')}>
      <Card gap="sm">
        <Txt role="caption" tone="muted">
          {t(copied ? 'emergencyExit.copied' : 'emergencyExit.copyAddress')}
        </Txt>
        <Row gap="sm">
          <Txt role="label" style={styles.shrink}>
            {address}
          </Txt>
          <TabIcon name="copy" color={colors.textSecondary} size={16} />
        </Row>
      </Card>
    </Touch>
  )
}

function VerdictLine({ verdict }: { verdict: QuoteVerdict }): React.JSX.Element | null {
  const { t } = useTranslation()
  return verdict === 'notWorth' || verdict === 'tooSmall' || verdict === 'thin' ? (
    <ErrorBox message={t(`emergencyExit.${verdict}`)} />
  ) : null
}

// The pair a host refused, in the form `submitpackage` takes, for a node of the person's own.
const pairText = (step: SparkRecoveryStep): string =>
  step.cpfpTxHex === undefined ? step.txHex : JSON.stringify([step.txHex, step.cpfpTxHex])

function RefusedSteps({ plan, steps }: { plan: ExitPlan; steps: SparkRecoveryStep[] }): React.JSX.Element | null {
  const { t } = useTranslation()
  const [copied, copy] = useCopied()
  const refused = plan.refused.find(entry => entry.reason !== '')
  const step = refused && steps.find(candidate => candidate.txid === refused.txid)
  if (!refused || !step) {
    return null
  }
  return (
    <View style={styles.body}>
      <ErrorBox message={t('emergencyExit.trackRefused', { reason: refused.reason })} />
      <Txt role="caption" tone="muted">
        {t('emergencyExit.trackCopyHint')}
      </Txt>
      <GradientButton
        variant="secondary"
        label={t(copied ? 'emergencyExit.copied' : 'emergencyExit.trackCopyPair')}
        onPress={() => copy(pairText(step))}
      />
    </View>
  )
}

// What the exit left at the fee address, with nothing to say when that is nothing.
function LeftAtFeeAddress({
  look,
  onRetry,
}: {
  look: FundingLook | 'reading'
  onRetry: () => void
}): React.JSX.Element | null {
  const { t } = useTranslation()
  if (look === 'reading') {
    return null
  }
  if (look.status === 'failed') {
    return (
      <View style={styles.action}>
        <Txt role="caption" tone="muted" style={styles.centered}>
          {t('emergencyExit.doneUnread')}
        </Txt>
        <GradientButton label={t('common.retry')} variant="secondary" onPress={onRetry} />
      </View>
    )
  }
  return (
    <>
      {look.confirmedSat > 0 ? (
        <Txt role="caption" tone="muted" style={styles.centered}>
          {t('emergencyExit.doneLeft', { amount: formatSats(look.confirmedSat) })}
        </Txt>
      ) : null}
      {look.pendingSat > 0 ? (
        <Txt role="caption" tone="muted" style={styles.centered}>
          {t('emergencyExit.donePending', { amount: formatSats(look.pendingSat) })}
        </Txt>
      ) : null}
    </>
  )
}

export function EmergencyExitScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { selection } = useRoute<RouteProp<RootStackParamList, 'EmergencyExit'>>().params
  const prefs = useMemo(() => deviceDateTimePrefs(), [])
  const [phase, setPhase] = useState<Phase>({ name: 'loading' })
  const [walletId, setWalletId] = useState<string | null>(null)
  const [plan, setPlan] = useState<ExitPlan | null>(null)
  const [outcome, setOutcome] = useState<PassOutcome | null>(null)
  const [address, setAddress] = useState('')
  const [addressError, setAddressError] = useState<string | null>(null)
  // The address the person was told could not be checked, whose second tap goes on with it.
  const [unchecked, setUnchecked] = useState<string | null>(null)
  // An earlier plan went aside torn. The person is told once a new exit is what reaches that money.
  const [earlierAside, setEarlierAside] = useState(false)
  const [feeAddress, setFeeAddress] = useState<string | null>(null)
  const [funding, setFunding] = useState<FundingLook | 'reading'>('reading')
  const [left, setLeft] = useState<FundingLook | 'reading'>('reading')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const starting = useRef(false)
  // Each read carries the number it was asked under, and only the latest lands, on a screen still here.
  const readSeq = useRef(0)
  const mounted = useRef(true)

  usePreventRemove(busy, () => undefined)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      readSeq.current += 1
    }
  }, [])

  const follow = useCallback((live: ExitPlan) => {
    setPlan(live)
    setOutcome(null)
    setPhase({ name: 'tracking' })
  }, [])

  const load = useCallback(async () => {
    const mine = ++readSeq.current
    setPhase({ name: 'loading' })
    try {
      const id = await getActiveWalletId()
      if (!id) {
        throw new Error('no active wallet')
      }
      const kept = await loadExitPlan(id)
      const aside = await exitPlanWasSetAside(id).catch(() => false)
      await connectWithin()
      if (!mounted.current || mine !== readSeq.current) {
        return
      }
      setWalletId(id)
      setEarlierAside(aside)
      if (kept) {
        follow(kept)
      } else if (selection === 'recoverable') {
        setPhase({ name: 'destination' })
      } else {
        setPhase(sparkSyncState() === 'synced' ? { name: 'networkUp' } : { name: 'intro' })
      }
    } catch {
      // Without a wallet and its plan there is no safe screen to go on to, whatever failed.
      if (mounted.current && mine === readSeq.current) {
        setPhase({ name: 'unreadable' })
      }
    }
  }, [follow, selection])

  useEffect(() => {
    load()
  }, [load])

  const pass = useCallback(() => {
    // A pass asked while a button holds the wallet comes back idle, which here reads as no connection.
    if (!walletId || starting.current) {
      return
    }
    runExitPass(walletId).then(
      answer => {
        if (!mounted.current) {
          return
        }
        setOutcome(answer)
        if (answer.kind !== 'idle') {
          setPlan(answer.plan)
        }
      },
      cause => {
        if (mounted.current) {
          // A plan that could not be written stops the pass before anything leaves, and it stays as it was.
          if (cannotReadPlan(cause)) {
            setPhase({ name: 'unreadable' })
          } else {
            setOutcome(current => (plan ? { kind: 'stuck', plan } : current))
          }
        }
      },
    )
  }, [plan, walletId])

  const passRef = useRef(pass)
  passRef.current = pass
  const tracking = phase.name === 'tracking' && isLivePlan(plan)

  useFocusEffect(
    useCallback(() => {
      if (!tracking) {
        return
      }
      passRef.current()
      const timer = setInterval(() => passRef.current(), PASS_EVERY_MS)
      return () => clearInterval(timer)
    }, [tracking]),
  )

  const readFundingNow = useCallback(async (at: string) => {
    // The last answer stays up meanwhile. Taken away on every timed read, it would hide what was
    // found and the button with it; Start reads the funding again itself, so nothing rests on it.
    const mine = ++readSeq.current
    const look = await lookAtFunding(at).catch((): FundingLook => ({ status: 'failed' }))
    if (mounted.current && mine === readSeq.current) {
      setFunding(look)
    }
  }, [])

  const readLeft = useCallback(async (at: string) => {
    const mine = ++readSeq.current
    setLeft('reading')
    const look = await lookAtFunding(at).catch((): FundingLook => ({ status: 'failed' }))
    if (mounted.current && mine === readSeq.current) {
      setLeft(look)
    }
  }, [])

  // The fee address is spoken of only once the plan ended, done or closed, since the app sends no child
  // of it after that and nothing there waits to be spent by one.
  const planEnded = plan?.verdict === 'done' || plan?.verdict === 'closed'
  const finishedAt = phase.name === 'tracking' && planEnded ? (plan?.feeKey?.address ?? null) : null
  useEffect(() => {
    if (finishedAt) {
      readLeft(finishedAt)
    }
  }, [finishedAt, readLeft])

  const funded = phase.name === 'fund'
  useFocusEffect(
    useCallback(() => {
      if (!funded || !feeAddress) {
        return
      }
      readFundingNow(feeAddress)
      const timer = setInterval(() => readFundingNow(feeAddress), FUNDING_READ_EVERY_MS)
      return () => {
        clearInterval(timer)
        readSeq.current += 1
      }
    }, [feeAddress, funded, readFundingNow]),
  )

  function changeAddress(text: string) {
    readSeq.current += 1
    setAddress(text)
    setAddressError(null)
    setUnchecked(null)
  }

  // An empty read is the iOS paste prompt, not an error, so the next tap pastes.
  async function paste() {
    const text = await Clipboard.getString()
    if (text) {
      changeAddress(text.trim())
    }
  }

  function shortLine({ missingSat, pending, oneCoin }: Shortfall): string {
    if (missingSat !== null) {
      return t(oneCoin ? 'emergencyExit.fundShortOneCoin' : 'emergencyExit.fundShort', {
        amount: formatSats(missingSat),
      })
    }
    return t(pending ? 'emergencyExit.fundShortWait' : 'emergencyExit.fundShortNoFigure')
  }

  function emptyLine(quoted: ExitQuote): string {
    const { feeTooHigh, noData, operators } = sparkSkippedReasons(quoted.quote)
    // First, since a later try can change this one and it may hold back more than the rest.
    if (operators) {
      return t('emergencyExit.nothingOperators')
    }
    if (feeTooHigh) {
      return t('emergencyExit.nothingFee')
    }
    return t(noData ? 'emergencyExit.nothingData' : 'emergencyExit.nothing')
  }

  // Every quote reaches the person through here, so one with nothing in it never shows a way to start.
  function showQuote(quoted: ExitQuote, note: string | null) {
    setPhase(
      quoteVerdict(quoted.quote) === 'empty'
        ? { name: 'empty', line: emptyLine(quoted) }
        : { name: 'review', quoted, note },
    )
  }

  async function quoteExit() {
    if (address.trim() === '' || !walletId) {
      return
    }
    const mine = ++readSeq.current
    setError(null)
    setPhase({ name: 'quoting' })
    try {
      await connectWithin()
      const checked = sparkConnectedWalletId() === walletId ? await sparkExitDestination(address) : null
      if (!mounted.current || mine !== readSeq.current) {
        return
      }
      if (checked === null) {
        setError(t('emergencyExit.quoteFailed'))
        setPhase({ name: 'destination' })
        return
      }
      if (checked.status === 'refused') {
        const line = { notAddress: 'destinationBad', uri: 'destinationUri', own: 'destinationOwn' }[checked.reason]
        setAddressError(t(`emergencyExit.${line}`))
        setPhase({ name: 'destination' })
        return
      }
      if (checked.status === 'unchecked' && unchecked !== checked.address) {
        setUnchecked(checked.address)
        setPhase({ name: 'destination' })
        return
      }
      const answer = await prepareExit(walletId, checked.address, selection)
      if (!mounted.current || mine !== readSeq.current) {
        return
      }
      if (answer.kind === 'live') {
        follow(answer.plan)
      } else if (answer.kind === 'quoted') {
        setAddress(checked.address)
        showQuote(answer.quoted, null)
      } else {
        setError(t(answer.kind === 'noRate' ? 'emergencyExit.noRate' : 'emergencyExit.quoteFailed'))
        setPhase({ name: 'destination' })
      }
    } catch (cause) {
      if (mounted.current && mine === readSeq.current) {
        setPhase(cannotReadPlan(cause) ? { name: 'unreadable' } : { name: 'destination' })
        setError(t('emergencyExit.quoteFailed'))
      }
    }
  }

  async function toFunding(quoted: ExitQuote) {
    if (!walletId) {
      return
    }
    setFunding('reading')
    setError(null)
    setPhase({ name: 'fund', quoted })
    const at = feeAddress ?? (await exitFundingAddress(walletId).catch(() => null))
    if (mounted.current) {
      setFeeAddress(at)
      if (!at) {
        setFunding({ status: 'failed' })
      }
    }
  }

  async function start(quoted: ExitQuote) {
    if (starting.current || !walletId) {
      return
    }
    starting.current = true
    setBusy(true)
    setError(null)
    const funds = quoted.quote.funding !== undefined
    const failed = t(funds ? 'emergencyExit.startFailed' : 'emergencyExit.startFailedNoFee')
    try {
      const answer = await startExit(walletId, address, quoted)
      if (!mounted.current) {
        return
      }
      switch (answer.kind) {
        case 'started':
        case 'live':
          follow(answer.plan)
          break
        case 'requoted':
          showQuote(answer.quoted, t('emergencyExit.requoted'))
          break
        case 'refused':
          setError(t(answer.verdict === 'tooSmall' ? 'emergencyExit.tooSmall' : 'emergencyExit.notWorth'))
          break
        case 'short':
          setError(shortLine(answer))
          break
        case 'unread':
          setFunding({ status: 'failed' })
          break
        case 'noRate':
          setError(t('emergencyExit.noRate'))
          break
        case 'empty':
          setError(t('emergencyExit.operatorsDown'))
          break
        default:
          setError(failed)
      }
    } catch (cause) {
      if (mounted.current) {
        if (cannotReadPlan(cause)) {
          setPhase({ name: 'unreadable' })
        }
        setError(failed)
      }
    } finally {
      starting.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }

  async function raiseFee() {
    if (starting.current || !walletId) {
      return
    }
    starting.current = true
    setBusy(true)
    setError(null)
    const answer = await payMore(walletId).catch(() => ({ kind: 'failed' }) as const)
    starting.current = false
    if (!mounted.current) {
      return
    }
    setBusy(false)
    if (answer.kind === 'ask') {
      setPhase({ name: 'ask', ask: answer.ask, note: null })
    } else if (answer.kind === 'closed') {
      follow(answer.plan)
    } else {
      setError(t(answer.kind === 'top' ? 'emergencyExit.payMoreTop' : 'emergencyExit.payMoreFailed'))
    }
  }

  async function confirmFigures(ask: ExitAsk) {
    if (starting.current || !walletId) {
      return
    }
    starting.current = true
    setBusy(true)
    setError(null)
    const answer = await confirmAsk(walletId, ask).catch(() => ({ kind: 'failed' }) as const)
    starting.current = false
    if (!mounted.current) {
      return
    }
    setBusy(false)
    switch (answer.kind) {
      case 'paid':
      case 'closed':
        follow(answer.plan)
        break
      case 'ask':
        setPhase({ name: 'ask', ask: answer.ask, note: t('emergencyExit.requoted') })
        break
      case 'short':
        // Here and not on the follow-up, whose next pass would take the line away.
        setPhase({ name: 'ask', ask, note: null, short: answer })
        break
      default:
        setError(t('emergencyExit.payMoreFailed'))
    }
  }

  async function leave() {
    if (starting.current || !walletId) {
      return
    }
    starting.current = true
    setBusy(true)
    setError(null)
    const ended = await leaveExit(walletId).catch(() => null)
    starting.current = false
    if (!mounted.current) {
      return
    }
    setBusy(false)
    if (ended) {
      follow(ended)
    } else {
      setError(t('emergencyExit.payMoreFailed'))
    }
  }

  async function closeDone() {
    if (walletId) {
      await forgetExitPlan(walletId).catch(() => undefined)
    }
    navigation.goBack()
  }

  if (phase.name === 'loading' || phase.name === 'quoting') {
    return (
      <Screen scroll layout="padded" contentStyle={styles.body}>
        <Card gap="md">
          <Skeleton width="60%" height={font.leading.base} />
          <Skeleton width="100%" height={font.leading.base} />
          <Skeleton width="100%" height={font.leading.base} />
        </Card>
      </Screen>
    )
  }

  if (phase.name === 'unreadable') {
    return (
      <Screen layout="center">
        <CenterStack>
          <ErrorBox message={t('emergencyExit.unreadable')} />
          <GradientButton label={t('common.retry')} variant="secondary" onPress={load} />
        </CenterStack>
      </Screen>
    )
  }

  if (phase.name === 'networkUp') {
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <GradientButton
              label={t('emergencyExit.networkUpSend')}
              onPress={() => navigation.navigate('Send')}
            />
            <GradientButton
              variant="secondary"
              label={t('emergencyExit.networkUpContinue')}
              onPress={() => setPhase({ name: 'intro' })}
            />
          </View>
        }>
        {earlierAside ? <ErrorBox message={t('emergencyExit.aside')} /> : null}
        <Titled title={t('emergencyExit.networkUpTitle')}>
          <Txt role="body">{t('emergencyExit.networkUpBody')}</Txt>
        </Titled>
      </Screen>
    )
  }

  if (phase.name === 'intro') {
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <GradientButton
              label={t('emergencyExit.introUnderstood')}
              onPress={() => setPhase({ name: 'destination' })}
            />
          </View>
        }>
        {earlierAside ? <ErrorBox message={t('emergencyExit.aside')} /> : null}
        <Titled title={t('emergencyExit.introAll')}>
          <Txt role="body">{t('emergencyExit.introDays')}</Txt>
        </Titled>
        {(['introFee', 'introOpen', 'introDevice', 'introOtherDevice'] as const).map(line => (
          <Txt key={line} role="body">
            {t(`emergencyExit.${line}`)}
          </Txt>
        ))}
      </Screen>
    )
  }

  if (phase.name === 'empty') {
    return (
      <Screen layout="center">
        <Txt role="body" style={styles.centered}>
          {phase.line}
        </Txt>
        <View style={styles.action}>
          <GradientButton label={t('common.retry')} variant="secondary" onPress={quoteExit} />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'review') {
    const { quoted } = phase
    const verdict = quoteVerdict(quoted.quote)
    const refused = !mayGoOn(verdict)
    const needed = fundingNeededSat(quoted.quote)
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <ErrorBox message={error} style={styles.error} />
            {refused ? (
              <GradientButton label={t('common.back')} variant="secondary" onPress={() => navigation.goBack()} />
            ) : (
              <GradientButton
                label={t(needed > 0 ? 'emergencyExit.continue' : 'emergencyExit.start')}
                loading={busy}
                onPress={() => (needed > 0 ? toFunding(quoted) : start(quoted))}
              />
            )}
          </View>
        }>
        <ErrorBox message={phase.note} />
        <Card gap="md">
          <SatsLine label={t('emergencyExit.reviewValueBeforeFees')} sat={Number(quoted.quote.recoverableValueSats)} />
          <SatsLine label={t('emergencyExit.reviewFee')} sat={Number(quoted.quote.totalFeeSats)} />
          <ArrivesLine arriving={exitArriving(quoted.quote)} />
          {needed > 0 ? (
            <Txt role="caption" tone="muted">
              {t('emergencyExit.reviewLeftover')}
            </Txt>
          ) : null}
          <Txt role="caption" tone="muted">
            {t('send.to')}
          </Txt>
          <Txt role="label" style={styles.shrink}>
            {address}
          </Txt>
        </Card>
        {quoted.quote.skipped.length > 0 ? (
          <Txt role="caption" tone="muted">
            {t('emergencyExit.trackFailedLeaves')}
          </Txt>
        ) : null}
        <VerdictLine verdict={verdict} />
        {needed > 0 ? <Txt role="caption">{t('emergencyExit.introDays')}</Txt> : null}
      </Screen>
    )
  }

  if (phase.name === 'fund') {
    const { quoted } = phase
    const needed = fundingNeededSat(quoted.quote)
    const look = funding === 'reading' ? null : funding
    const enough = look?.status === 'read' && look.confirmedSat >= needed
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <ErrorBox message={error} style={styles.error} />
            <GradientButton
              label={t('emergencyExit.start')}
              loading={busy}
              disabled={!enough}
              onPress={() => start(quoted)}
            />
          </View>
        }>
        <Titled title={t('emergencyExit.fundTitle')}>
          <Txt role="body">{t('emergencyExit.fundBody', { amount: formatSats(needed) })}</Txt>
        </Titled>
        {feeAddress ? <CopyAddress address={feeAddress} /> : null}
        <Txt role="caption" tone="muted">
          {t('emergencyExit.fundQuotedAt', { time: formatTime(quoted.quotedAt / 1000, prefs) })}
        </Txt>
        {funding === 'reading' ? <Skeleton width="60%" height={font.leading.sm} /> : null}
        {look?.status === 'read' ? (
          <Txt role="caption">{t('emergencyExit.fundFound', { amount: formatSats(look.confirmedSat) })}</Txt>
        ) : null}
        {look?.status === 'read' && look.pendingSat > 0 ? (
          <Txt role="caption">{t('emergencyExit.fundPending', { amount: formatSats(look.pendingSat) })}</Txt>
        ) : null}
        {look?.status === 'failed' ? (
          <>
            <ErrorBox message={t('emergencyExit.fundUnread')} />
            <GradientButton
              label={t('common.retry')}
              variant="secondary"
              onPress={() => {
                setFunding('reading')
                if (feeAddress) {
                  readFundingNow(feeAddress)
                } else {
                  toFunding(quoted)
                }
              }}
            />
          </>
        ) : null}
      </Screen>
    )
  }

  if (phase.name === 'leaving') {
    return (
      <Screen layout="center">
        <Txt role="body" style={styles.centered}>
          {t('emergencyExit.askLaterBody')}
        </Txt>
        <View style={styles.action}>
          <ErrorBox message={error} />
          <GradientButton label={t('emergencyExit.askLater')} loading={busy} onPress={leave} />
          <GradientButton
            variant="secondary"
            label={t('common.back')}
            onPress={() => setPhase({ name: 'ask', ask: phase.ask, note: null })}
          />
        </View>
      </Screen>
    )
  }

  if (phase.name === 'ask') {
    const { ask, note, short } = phase
    const { quote } = ask.quoted
    const allowed = mayGoOn(ask.verdict)
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <ErrorBox message={error} style={styles.error} />
            {allowed ? (
              <GradientButton label={t('emergencyExit.askConfirm')} loading={busy} onPress={() => confirmFigures(ask)} />
            ) : null}
            {!allowed && ask.reason === 'forced' ? (
              <GradientButton
                variant="secondary"
                label={t('emergencyExit.askLater')}
                onPress={() => setPhase({ name: 'leaving', ask })}
              />
            ) : null}
            <GradientButton
              variant="secondary"
              label={t('common.back')}
              onPress={() => {
                setError(null)
                setPhase({ name: 'tracking' })
              }}
            />
          </View>
        }>
        <ErrorBox message={note} />
        <Titled title={t(ask.reason === 'raise' ? 'emergencyExit.askTitleRaise' : 'emergencyExit.askTitleRedo')}>
          {allowed ? <Txt role="body">{t('emergencyExit.askBody')}</Txt> : null}
        </Titled>
        <Card gap="md">
          <SatsLine label={t('emergencyExit.reviewValueBeforeFees')} sat={Number(quote.recoverableValueSats)} />
          <SatsLine label={t('emergencyExit.reviewFee')} sat={Number(quote.totalFeeSats)} />
          <ArrivesLine arriving={exitArriving(quote)} />
        </Card>
        {quote.skipped.length > 0 ? (
          <Txt role="caption" tone="muted">
            {t('emergencyExit.trackFailedLeaves')}
          </Txt>
        ) : null}
        <VerdictLine verdict={ask.verdict} />
        {short ? (
          <>
            <ErrorBox message={shortLine(short)} />
            <CopyAddress address={short.address} />
          </>
        ) : null}
      </Screen>
    )
  }

  if (phase.name === 'tracking' && plan) {
    const steps = sparkRecoverySteps(plan.recovery)
    if (plan.verdict === 'closed') {
      return (
        <Screen layout="center">
          <Txt role="body" style={styles.centered}>
            {t(`emergencyExit.${CLOSURE_LINE[plan.closure ?? 'nothing']}`)}
          </Txt>
          {finishedAt ? <LeftAtFeeAddress look={left} onRetry={() => readLeft(finishedAt)} /> : null}
          <View style={styles.action}>
            <GradientButton label={t('common.close')} onPress={closeDone} />
          </View>
        </Screen>
      )
    }
    if (plan.verdict === 'done') {
      return (
        <Screen layout="center">
          <Titled centered title={t('emergencyExit.doneTitle')}>
            <Txt role="body" style={styles.centered}>
              {t('emergencyExit.doneBody')}
            </Txt>
          </Titled>
          {plan.recovery.failed.length > 0 ? (
            <Txt role="caption" tone="muted" style={styles.centered}>
              {t('emergencyExit.trackFailedLeaves')}
            </Txt>
          ) : null}
          {finishedAt ? <LeftAtFeeAddress look={left} onRetry={() => readLeft(finishedAt)} /> : null}
          <View style={styles.action}>
            <GradientButton label={t('common.close')} onPress={closeDone} />
          </View>
        </Screen>
      )
    }
    const heights = steps.flatMap(step => (step.spendableAtHeight === undefined ? [] : [step.spendableAtHeight]))
    const arriving = planArriving(plan)
    const short = outcome?.kind === 'short' ? outcome : null
    const asking = outcome?.kind === 'ask' ? outcome : null
    // A pass with this wallet not connected is idle, which on a live plan is no connection too.
    const noAnswer =
      outcome?.kind === 'offline' ||
      outcome?.kind === 'idle' ||
      (plan.refused.length > 0 && plan.refused.every(entry => entry.reason === ''))
    return (
      <Screen
        scroll
        layout="padded"
        contentStyle={styles.body}
        footer={
          <View style={styles.footer}>
            <ErrorBox message={error} style={styles.error} />
            <GradientButton
              variant="secondary"
              label={t('emergencyExit.payMore')}
              loading={busy}
              onPress={raiseFee}
            />
          </View>
        }>
        <Titled title={t('emergencyExit.trackTitle')}>
          <Txt role="body">{t('emergencyExit.trackBody')}</Txt>
        </Titled>
        <Card gap="sm">
          <Txt role="bodyBold">
            {t('emergencyExit.trackProgress', {
              done: steps.filter(step => step.stage === 'confirmed').length,
              total: steps.length,
            })}
          </Txt>
          {heights.length > 0 ? (
            <Txt role="caption" tone="muted">
              {t('emergencyExit.trackWaiting', { height: Math.min(...heights) })}
            </Txt>
          ) : null}
          <Txt role="caption" tone="muted">
            {t('emergencyExit.trackCheckedAt', { time: formatTime(plan.checkedAt / 1000, prefs) })}
          </Txt>
        </Card>
        {arriving !== null ? (
          <Card gap="md">
            <ArrivesLine arriving={arriving} />
          </Card>
        ) : null}
        {noAnswer ? <ErrorBox message={t('emergencyExit.trackOffline')} /> : null}
        {outcome?.kind === 'stuck' ? <ErrorBox message={t('emergencyExit.trackStuck')} /> : null}
        {steps.some(waitsOnChainRead) ? (
          <Txt role="caption" tone="muted">
            {t('emergencyExit.trackAwaitingRead')}
          </Txt>
        ) : null}
        {asking ? (
          <>
            <ErrorBox message={t('emergencyExit.askNeeded')} />
            <GradientButton
              label={t('emergencyExit.askOpen')}
              onPress={() => setPhase({ name: 'ask', ask: asking.ask, note: null })}
            />
          </>
        ) : null}
        <RefusedSteps plan={plan} steps={steps} />
        {short ? (
          <>
            <ErrorBox message={shortLine(short)} />
            <CopyAddress address={short.address} />
          </>
        ) : null}
        {plan.recovery.failed.length > 0 ? (
          <Txt role="caption" tone="muted">
            {t('emergencyExit.trackFailedLeaves')}
          </Txt>
        ) : null}
      </Screen>
    )
  }

  return (
    <Screen
      scroll
      keyboard
      layout="padded"
      contentStyle={styles.body}
      footer={
        <View style={styles.footer}>
          <ErrorBox message={error} style={styles.error} />
          <GradientButton
            label={t(unchecked === null ? 'emergencyExit.continue' : 'emergencyExit.networkUpContinue')}
            onPress={quoteExit}
            disabled={address.trim() === ''}
          />
        </View>
      }>
      {earlierAside ? <ErrorBox message={t('emergencyExit.aside')} /> : null}
      <Field
        value={address}
        onChangeText={changeAddress}
        label={t('emergencyExit.destinationLabel')}
        hint={t('emergencyExit.destinationHint')}
        error={addressError ?? (unchecked === null ? undefined : t('emergencyExit.destinationUnchecked'))}
        autoCapitalize="none"
        autoCorrect={false}
      />
      <GradientButton
        variant="secondary"
        label={t('addAsset.paste')}
        icon={<TabIcon name="paste" color={colors.text} size={18} />}
        onPress={paste}
      />
    </Screen>
  )
}

const styles = StyleSheet.create({
  centered: {
    textAlign: 'center',
  },
  // Across the centred layout, which would otherwise size a button to its label.
  action: {
    alignSelf: 'stretch',
    marginTop: space.lg,
    gap: space.md,
  },
  titled: {
    gap: space.sm,
  },
  error: {
    marginBottom: space.md,
  },
  footer: {
    padding: space.xl,
    rowGap: space.sm,
  },
  body: {
    gap: space.lg,
  },
  shrink: {
    flexShrink: 1,
  },
})
