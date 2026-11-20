import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useFocusEffect, useNavigation } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  SYNC_WAIT_MS,
  connectActiveSpark,
  onSparkConnected,
  onSparkRecoverableFunds,
  sparkConnectedWalletId,
  sparkGetWalletInfo,
  sparkGetFiatRates,
  sparkRefreshWallet,
  sparkSubscribeToPayments,
  sparkSyncState,
  type BalanceSync,
} from '../wallet/spark'
import { emergencyExitLive } from '../wallet/emergencyExit'
import { answerWithin } from '../wallet/answerWithin'
import { identitySigner } from '../wallet/identitySigner'
import { classifyWalletError, type WalletErrorCode } from '../wallet/errors'
import { loadRegistry } from '../wallet/walletRegistry'
import { onActiveWalletChanged } from '../wallet/wallet'
import { usePullFeedback } from '../hooks/usePullFeedback'
import { usePullRefresh } from '../hooks/usePullRefresh'
import { useHomeExit } from '../hooks/useHomeExit'
import { exitOnItsWay, type ExitOnItsWay } from '../wallet/exitQuote'
import { useLiveFigures, type LiveSource } from '../hooks/useLiveFigures'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { useSideBySide } from '../hooks/useSideBySide'
import { useAppActive } from '../hooks/useAppActive'
import { useUpdateNotice } from '../hooks/useUpdateNotice'
import { putBackCard, recoverPurchases, type ChargeKind, type Recovery, type RecoveryStatus } from '../wallet/recover'
import { scopeOn } from '../wallet/releasedLines'
import { onPendingGone } from '../wallet/purchase'
import { onPendingPurchaseGone } from '../wallet/domainOnboard'
import { readDeletionOnFocus } from '../wallet/deletion'
import {
  formatFiat,
  localizeAmount,
  satsToFiat,
  walletFiatTotal,
  type FiatCurrency,
} from '../wallet/fiat'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { formatSats, formatBtc } from '../wallet/amount'
import {
  BITCOIN_ASSET_ID,
  buildSparkAssetList,
  inShownOrder,
  orderForDollarMode,
  type AssetRow,
} from '../wallet/assets'
import { loadHomeTokens, removeToken } from '../wallet/tokenPrefs'
import { KNOWN_TOKENS, USDB, knownToken } from '../wallet/tokens'
import { useAccent, useDollarMode } from '../wallet/dollarMode'
import { dollarOffer, usdbBaseUnits } from '../wallet/dollarOffer'
import { drawnUnit, heroRead, nextUnit, type HeroUnit } from '../wallet/heroFigure'
import { loadDollarInviteSeen, loadHeroUnit, saveDollarInviteSeen, saveHeroUnit } from '../wallet/settings'
import { useStableSwitch } from '../hooks/useStableSwitch'
import { StableConfirmSheet } from '../components/StableConfirmSheet'
import { Card } from '../components/Card'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { Txt } from '../components/Txt'
import { GlassCard } from '../components/GlassCard'
import { AssetList } from '../components/AssetList'
import { assetRowHeight } from '../components/assetRowHeight'
import { UnclaimedDepositsCard } from '../components/UnclaimedDepositsCard'
import { UpdateBanner } from '../components/UpdateBanner'
import { BackupCard } from '../components/BackupCard'
import { RecoveredPurchaseCard } from '../components/RecoveredPurchaseCard'
import { RecoverableFundsCard } from '../components/RecoverableFundsCard'
import { Skeleton } from '../components/Skeleton'
import { SectionLabel } from '../components/SectionLabel'
import { AddRow } from '../components/AddRow'
import { ErrorBox } from '../components/ErrorBox'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { colors, dividerTop, font, gradients, radius, space, touch } from '../theme'
import { Amount, Figure } from '../components/Amount'
import { CrossFade } from '../components/CrossFade'
import { PriceStrip } from '../components/PriceStrip'
import { Reenter } from '../components/Reenter'
import { Screen } from '../components/Screen'
import { Row } from '../components/Row'
import { Touch } from '../components/Touch'

type State =
  | { status: 'loading' }
  | {
      status: 'ready'
      // The wallet whose connection answered, so a refresh never keeps a figure across a switch.
      walletId: string | null
      // Read from a connection that has not synced, shown only after SYNC_WAIT_MS and marked.
      stale: boolean
      // The SDK's bitcoin balance as it answers, with nothing taken off for an exit.
      balanceSat: number
      // What a live exit is moving, read with the balance, or 'unread' when its plan cannot be read or
      // does not answer in time. Either takes the total label off the figure and puts the held line
      // under it.
      exit: ExitOnItsWay | 'unread' | null
      currency: FiatCurrency
      rates: Record<string, number>
      assets: AssetRow[]
      tokenFiat: { amount: number; pegFiat?: string }[]
      // USDB held, by identifier, for the invitation back to the dollar wallet.
      usdb: number
    }
  // A stable code the screen translates, never the SDK's own text.
  | { status: 'error'; code: WalletErrorCode }

type Ready = Extract<State, { status: 'ready' }>

// Funds that left the balance, kept apart from the figures above so they can join none of them, and
// null while the emergency exit is off.
type Recoverable = { walletId: string | null; sat: number; sync: BalanceSync }

// What the hero states, in the unit a tap chose. It is labelled the total only when it values every
// nonzero holding; otherwise it is the bitcoin balance under its own label, and the tokens are left to
// the asset list. `line` goes under the figure, and `units` is what a tap walks.
type Hero =
  | { kind: 'dollar'; figure: string; whole: true }
  | { kind: 'fiat'; figure: string; line: string | null; units: HeroUnit[]; whole: boolean }
  | {
      kind: 'bitcoin'
      amount: string
      unit: string
      line: string | null
      units: HeroUnit[]
      whole: boolean
    }

type Action = 'Send' | 'Receive' | 'Scan'

// The causes a failed connect can have, named under its title. classifyWalletError also matches
// payment words ("invalid", "expired") that a connect error can carry, and a line about an invoice
// under "Connection error" would state a cause that never happened.
const CONNECT_CAUSES: ReadonlySet<WalletErrorCode> = new Set<WalletErrorCode>(['offline', 'deleted'])

// How long a load waits for the rates. They come from the server on every read while the balance comes
// from the device, so a slow network holds the rates and must not hold the balance with them. Long
// enough that a normal open draws its first figure with its value.
const RATES_WAIT_MS = 3_000

// The label's bar while the figure loads, about the width of "Total Balance" at 16pt.
const LABEL_SKELETON = 112

// The rows the skeleton draws before the catalog is read.
const SKELETON_ROWS = 4

// The recovery cards about a payment whose proof the sweep keeps in its slot (recover.ts, finish): one
// still landing, and a name granted and not on the wallet yet, waiting or blocked.
const ON_PROOF: ReadonlySet<RecoveryStatus> = new Set<RecoveryStatus>(['settling', 'waiting', 'blocked'])

// What the not updated mark needs beyond the section gap it sits in, at this text size.
function staleMarkRoom(fontScale: number): number {
  return Math.max(0, Math.ceil(font.leading.sm * (fontScale - 1)))
}

export function HomeScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const [state, setState] = useState<State>({ status: 'loading' })
  // Undefined until the choice is read, so the hero never draws one unit to replace it with another,
  // and null with no choice made, where the wallet's own lead draws.
  const [chosenUnit, setChosenUnit] = useState<HeroUnit | null | undefined>(undefined)
  useEffect(() => {
    loadHeroUnit()
      .catch(() => null)
      .then(unit => setChosenUnit(prev => (prev === undefined ? unit : prev)))
  }, [])
  // Its own cycle for the dollar hero, swapping display currency against USD.
  // The dollar wallet exists so the balance does not move, and a display currency would move it with
  // the exchange rate, so USD leads and the tap reaches the chosen currency.
  const [dollarUnit, setDollarUnit] = useState<'local' | 'usd'>('usd')
  const [hidden, setHidden] = useState(false)
  const [recoverable, setRecoverable] = useState<Recoverable | null>(null)
  const [editing, setEditing] = useState(false)
  // The last hide could not be written. Said until the next hide, a new edit, or another wallet.
  const [hideFailed, setHideFailed] = useState(false)
  // Bumped on each successful load so the unclaimed-deposits card re-checks.
  const [reloadSeq, setReloadSeq] = useState(0)
  // A purchase the gateway says was paid for and never received. Null for almost every wallet on
  // almost every open, and then nothing is drawn.
  const [recovered, setRecovered] = useState<Recovery | null>(null)
  // The card on screen, for the sweep to weigh against a kept line, and whether a card put up now would
  // be seen (recover.ts, showCard).
  const shownCard = useRef<Recovery | null>(null)
  const active = useAppActive()
  const update = useUpdateNotice()
  useEffect(() => {
    shownCard.current = recovered
  }, [recovered])
  // The card a sweep answered that is not painted yet. One made from a kept line left the list when the
  // sweep claimed it, so a card dropped before it is painted, by a switch, a newer card, a dismiss or
  // the screen going, goes back to the list of the wallet the sweep asked about (recover.ts,
  // putBackCard), and the next view or sweep of that wallet says it.
  const unpainted = useRef<Recovery | null>(null)
  const giveBack = useCallback((): void => {
    const card = unpainted.current
    unpainted.current = null
    putBackCard(card)
  }, [])
  // Painted once committed beside a balance, the only place the card is drawn.
  useLayoutEffect(() => {
    if (unpainted.current !== null && recovered === unpainted.current && state.status === 'ready') {
      unpainted.current = null
    }
  }, [recovered, state.status])
  // The card on screen goes at the buyer's word, and an answer not painted yet goes with it unseen.
  const dropCard = useCallback((): void => {
    giveBack()
    setRecovered(null)
  }, [giveBack])
  // Bumped by a wallet switch and when the Home unmounts, so a load, a sweep or a refused hide that
  // started before either lands nowhere. React drops a write to an unmounted tree without a trace, so
  // the unmount moves the switch's epoch and one check turns both away.
  const epoch = useRef(0)
  useEffect(
    () => () => {
      epoch.current += 1
    },
    [],
  )
  // An answer not painted yet goes back to its slot with the Home.
  useEffect(() => giveBack, [giveBack])
  // A card about a payment whose proof is still in its slot stands on that proof, and the slot is shared
  // with the address sheet and the domain screen, which can deliver the charge or give the proof up
  // while the card is up. It then goes, whichever way the proof left, since it would go on saying the
  // payment is landing or the name is not on the wallet yet. The next sweep says what is left to say,
  // and a card about a final answer stays.
  useEffect(() => {
    const drop = (kind: ChargeKind, reference: string): void =>
      setRecovered(prev =>
        prev !== null && prev.kind === kind && prev.reference === reference && ON_PROOF.has(prev.status) ? null : prev,
      )
    const offName = onPendingGone((kind, reference) => {
      if (kind === 'name') {
        drop('name', reference)
      }
    })
    const offYear = onPendingPurchaseGone(reference => drop('tier', reference))
    return () => {
      offName()
      offYear()
    }
  }, [])

  // The bitcoin the wallet holds, in the unit `drawn` reads in.
  function bitcoinAmount(balanceSat: number, drawn: HeroUnit): string {
    return drawn === 'btc'
      ? `${localizeAmount(formatBtc(balanceSat))} BTC`
      : `${formatSats(balanceSat)} ${t('common.sats')}`
  }

  // Muted and short, under the figure it qualifies, until this connection's first sync re-reads it.
  // One line that shrinks to fit, since it goes where a second line would move the page.
  function renderStaleMark(s: Ready): React.JSX.Element | null {
    if (!s.stale) {
      return null
    }
    return (
      <Figure role="caption" tone="muted" style={styles.staleMark}>
        {t('home.notUpdated')}
      </Figure>
    )
  }

  // The dollar hero reads in USD and in the display currency, so it leads only when the whole wallet
  // has a value in both. Otherwise the figure is whatever the wallet can state in the unit chosen, so
  // offline a dollar balance never reads as a total of 0 sats.
  function heroFor(s: Ready, chosen: HeroUnit | null): Hero {
    // While an exit is alive or its plan unread, part of the SDK's figure may be leaving through it, and
    // the binding gives no status per leaf to say which part, so the figure is the bitcoin balance as
    // the SDK states it and never the total.
    if (s.exit !== null) {
      const rate = s.rates[s.currency]
      const drawn = chosen === 'btc' ? 'btc' : 'sats'
      return {
        kind: 'bitcoin',
        amount: drawn === 'btc' ? localizeAmount(formatBtc(s.balanceSat)) : formatSats(s.balanceSat),
        unit: drawn === 'btc' ? 'BTC' : t('common.sats'),
        line: rate > 0 ? formatFiat(satsToFiat(s.balanceSat, rate), s.currency) : null,
        units: ['sats', 'btc'],
        whole: false,
      }
    }
    const local = walletFiatTotal(s.balanceSat, s.tokenFiat, s.currency, s.rates)
    if (stableOn && local !== null) {
      const usd = walletFiatTotal(s.balanceSat, s.tokenFiat, 'USD', s.rates)
      if (usd !== null) {
        return {
          kind: 'dollar',
          figure: dollarUnit === 'usd' ? formatFiat(usd, 'USD') : formatFiat(local, s.currency),
          whole: true,
        }
      }
    }
    const read = heroRead(s)
    const drawn = drawnUnit(read.units, chosen)
    const rate = s.rates[s.currency]
    const ownFiat = rate > 0 ? formatFiat(satsToFiat(s.balanceSat, rate), s.currency) : null
    const holdsTokens = s.tokenFiat.some(token => token.amount > 0)
    const { units, whole } = read
    const line = !whole
      ? ownFiat
      : holdsTokens
      ? t('home.inBitcoin', { amount: bitcoinAmount(s.balanceSat, drawn) })
      : drawn === 'fiat'
      ? bitcoinAmount(s.balanceSat, 'sats')
      : ownFiat
    if (drawn === 'fiat' && read.fiat !== null) {
      return { kind: 'fiat', figure: formatFiat(read.fiat, s.currency), line, units, whole }
    }
    const digits = drawn === 'btc' ? localizeAmount(formatBtc(read.sats)) : formatSats(read.sats)
    return {
      kind: 'bitcoin',
      amount: read.approx ? t('send.approxAmount', { amount: digits }) : digits,
      unit: drawn === 'btc' ? 'BTC' : t('common.sats'),
      line,
      units,
      whole,
    }
  }

  // What a screen reader hears for the hero. The touch's label replaces its children, so it carries
  // the figure the hero draws, in the unit drawn, and says hidden when the figure is hidden.
  function heroAnnouncement(h: Hero, label: string): string {
    if (hidden) {
      return t('home.balanceHiddenLabel', { label })
    }
    const amount = h.kind === 'bitcoin' ? `${h.amount} ${h.unit}` : h.figure
    return t('home.balanceFigureLabel', { label, amount })
  }

  // A hidden balance stays as it is: a tap there would move a figure nobody can see. The dollar hero
  // keeps its own two steps.
  function cycleHero(h: Hero): void {
    if (h.kind === 'dollar') {
      setDollarUnit(u => (u === 'usd' ? 'local' : 'usd'))
      return
    }
    if (hidden) {
      return
    }
    const next = nextUnit(h.units, drawnUnit(h.units, chosenUnit ?? null))
    setChosenUnit(next)
    saveHeroUnit(next).catch(() => undefined)
  }

  // Says what the mode does instead of naming it. Sats under the conversion minimum stay as sats
  // until the balance crosses it, so they are counted as waiting; a hidden balance keeps the line
  // that states no amount.
  function dollarLine(s: Ready): string {
    return s.balanceSat > 0 && !hidden
      ? t('home.dollarWaiting', { amount: formatSats(s.balanceSat) })
      : t('home.dollarIncoming')
  }

  // Drawn at the text's own height, so the gap above it reads like the rest of the block. The slop
  // above reaches into the figure's box only below its digits.
  function renderDollarLine(s: Ready): React.JSX.Element {
    const text = dollarLine(s)
    return (
      <Touch
        onPress={() => navigation.navigate('StableBalance')}
        feedback="link"
        size={20}
        hitSlop={space.md}
        label={`${text}, ${t('stable.title')}`}
        style={styles.dollarLine}>
        <Row gap="xs">
          <TabIcon name="receive" color={colors.textSecondary} size={14} />
          <Txt role="label" tone="muted" tabular style={styles.dollarLineText}>
            {text}
          </Txt>
          <TabIcon name="chevron" color={colors.textSecondary} size={14} />
        </Row>
      </Touch>
    )
  }

  // Tells what the tap offers and moves nothing. The mode's sheet asks, and the tap on the figure above
  // stays a change of unit.
  function renderDollarOffer(): React.JSX.Element {
    return (
      <Touch
        onPress={() => stableSwitch.ask(true)}
        feedback="link"
        size={20}
        hitSlop={space.md}
        label={t('home.dollarOffer')}
        style={styles.dollarLine}>
        <Row gap="xs">
          <Txt role="label" tone="muted" style={styles.dollarLineText}>
            {t('home.dollarOffer')}
          </Txt>
          <TabIcon name="chevron" color={colors.textSecondary} size={14} />
        </Row>
      </Touch>
    )
  }

  // Reorder acts on the shown list only. Nothing is persisted, so the next load rebuilds the order.
  function reorderAssets(ids: string[]) {
    setState(prev => {
      if (prev.status !== 'ready') {
        return prev
      }
      const byId = new Map(prev.assets.map(asset => [asset.assetId, asset]))
      const assets = ids
        .map(id => byId.get(id))
        .filter((asset): asset is AssetRow => asset !== undefined)
      return { ...prev, assets }
    })
  }

  // Only zero-balance catalog rows reach this, so hiding one can never conceal funds. The row
  // leaves at once; a hide the lists refused puts it back where it stood, on the same wallet, and
  // says so, since the next read would bring it back with no word.
  function removeAsset(assetId: string) {
    const run = epoch.current
    const shown = state.status === 'ready' ? state : null
    const index = shown ? shown.assets.findIndex(asset => asset.assetId === assetId) : -1
    const row = shown?.assets[index]
    setHideFailed(false)
    removeToken(assetId).catch(() => {
      if (run !== epoch.current) {
        return
      }
      setHideFailed(true)
      setState(prev =>
        prev.status === 'ready' &&
        prev.walletId === shown?.walletId &&
        row !== undefined &&
        !prev.assets.some(asset => asset.assetId === assetId)
          ? { ...prev, assets: [...prev.assets.slice(0, index), row, ...prev.assets.slice(index)] }
          : prev,
      )
    })
    setState(prev =>
      prev.status === 'ready'
        ? { ...prev, assets: prev.assets.filter(asset => asset.assetId !== assetId) }
        : prev,
    )
  }

  // Gates the skeleton, so a refocus refreshes in the background instead of flashing empty.
  const loadedOnce = useRef(false)
  // What the skeleton draws, so the panel keeps its height when the rows land.
  const [knownRows, setKnownRows] = useState(SKELETON_ROWS)
  useEffect(() => {
    loadHomeTokens()
      .then(tokens => {
        if (!loadedOnce.current) {
          setKnownRows(buildSparkAssetList(0, [], tokens.catalog, tokens.hidden).length)
        }
      })
      .catch(() => undefined)
  }, [])
  // The number of the last load started, the only one whose answer lands, so a slow read that started
  // before a sync never paints over the read that followed it.
  const latestLoad = useRef(0)
  // The answer of the load started last, set as it starts.
  const newestLoad = useRef<Promise<boolean>>(Promise.resolve(false))
  // Whether the active wallet's connection is up. Send, Receive and Scan show from the first frame and
  // call the SDK as they open, so a press made before the connect lands is held until it does, and one
  // made after a switch never opens on the previous wallet's connection.
  const linked = useRef(false)
  const pendingAction = useRef<Action | null>(null)
  // The same held press as state, so its control shows that it is waiting. Every write goes through
  // hold, which keeps the two in step.
  const [heldAction, setHeldAction] = useState<Action | null>(null)
  const hold = useCallback((route: Action | null) => {
    pendingAction.current = route
    setHeldAction(route)
  }, [])
  // Read through a ref, because a load that depended on the navigation object would re-run the focus
  // effect each time that object changed identity.
  const nav = useRef(navigation)
  nav.current = navigation

  const openAction = useCallback(
    (route: Action) => {
      if (linked.current) {
        navigation.navigate(route)
      } else if (pendingAction.current === null) {
        // The first press is the one kept: a later one, the same or another, is ignored rather than
        // swapped in behind a control that already shows it is waiting.
        hold(route)
      }
    },
    [navigation, hold],
  )

  // What this wallet paid for and never received, asked of the gateway rather than of this device.
  // It runs after a load that worked, because the ask is signed by the wallet's own key and there is
  // no card to place beside a balance that is not on screen yet. Throttled per wallet inside
  // wallet/recover.ts, so a tab switch costs a file read and no request.
  const sweep = useCallback(async () => {
    // A switch announced while the sweep is out moves the epoch, and the answer is then about a
    // wallet this screen no longer shows.
    const run = epoch.current
    try {
      const registry = await loadRegistry()
      const activeId = registry.active
      if (!activeId) {
        return
      }
      // The sweep asks as the wallet whose key signs, which right after a switch is still the
      // previous one, so that wallet's charges are filed, kept and throttled under it and never
      // under the wallet the registry moved to; its card is not put up here (recover.ts, showCard).
      // The key is read across an await, so the connection is read on both sides of it, and a key
      // and a wallet from two connections never ask together; the next focus asks again.
      //
      // A connected wallet the list no longer holds was removed, and a removal that finished before
      // the list was read already forgot its lines, so a scope taken now would count that forget as
      // run before the sweep and let its lines back in under the id. The list's answer, the pick and
      // the scope are taken in one step, so a removal the list did not show yet meets the scope instead.
      const walletId = sparkConnectedWalletId()
      if (walletId === null || !registry.wallets.some(wallet => wallet.id === walletId)) {
        return
      }
      // Read with the wallet and before any await, so the wallet removed or its data deleted while
      // the key and the deletion read are out gets no line, mark or claim from this sweep.
      const lines = scopeOn(walletId)
      const { pubkey, sign } = await identitySigner()
      if (sparkConnectedWalletId() !== walletId) {
        return
      }
      // Read ahead of the purchases, so a seed whose data was deleted from another device, a request
      // that finished while the app was away and a mark this device lost are each settled before
      // anything recovered below registers an address the gateway would refuse. A failure leaves the
      // read due for the next focus. Only for the wallet the session signs as: right after a switch
      // the signer is still the previous wallet, and its answer would land on this wallet's mark.
      if (walletId === activeId) {
        await readDeletionOnFocus({ walletId, pubkey, sign }).catch(() => undefined)
      }
      const found = await recoverPurchases({
        walletId,
        lines,
        pubkey,
        sign,
        showing: shownCard.current,
        onScreen: () => active.current,
      })
      if (run !== epoch.current) {
        putBackCard(found)
        return
      }
      // A later sweep answering null is the throttle declining to ask, never a purchase being
      // withdrawn. Clearing on it would take a card off the screen one tab switch after it arrived,
      // and nothing else in the app says the same thing, so only the dismiss and a switch clear it.
      if (found !== null) {
        // A card not painted yet is replaced unseen.
        giveBack()
        unpainted.current = found
      }
      setRecovered(prev => found ?? prev)
    } catch {
      // Never costs the screen its balance. The question stays open and the next focus asks again.
    }
  }, [active, giveBack])

  // Whether the rates failed on the last load. It keeps the last figure in money, which a pull's answer
  // would pass off as current. Rates only running late still land on that figure.
  const ratesRefused = useRef(false)

  // What the wallet held at the last figures that landed, and whether the read that brought them moved
  // it, as against moving only the rates.
  const holdings = useRef<string | null>(null)
  const holdingsMoved = useRef(false)
  // What a load with a reason is owed once figures land, the cards and the sweep. It lives outside the
  // load, so whichever read lands pays it when a read has replaced that load.
  const workOwed = useRef(false)
  // Until when the clock leaves the figures to a pull or an explicit load, which replaces nothing the
  // clock read. A time and not a flag, since either can go unanswered and the clock has to go on.
  const clockWaits = useRef(0)
  // Read inside a load, which outlives the render that started it.
  const editingNow = useRef(editing)
  editingNow.current = editing

  // Answers whether figures landed. A replaced load paints nothing, so its own read says nothing about
  // what is on screen, and it hands on the answer of the load that replaced it. A load with a `source`
  // is one nobody asked for, so it leaves the editor open and the rows where they are, and the clock's
  // asks for none of the work that hangs on a change.
  const readFigures = useCallback(async (source?: LiveSource): Promise<boolean> => {
    const background = loadedOnce.current
    const run = epoch.current
    const mine = ++latestLoad.current
    if (!background) {
      setState({ status: 'loading' })
    }
    if (source === undefined) {
      setEditing(false)
    }
    if (source !== 'timer') {
      workOwed.current = true
    }
    try {
      await connectActiveSpark()
      if (run === epoch.current) {
        linked.current = true
        const held = pendingAction.current
        hold(null)
        if (held && nav.current.isFocused()) {
          nav.current.navigate(held)
        }
      }
      const walletId = sparkConnectedWalletId()
      const currency = await resolveDisplayCurrency(i18n.language)
      // Peg rates ride along, since crossing a dollar balance into a non-USD currency needs both.
      const pegs = KNOWN_TOKENS.map(k => k.fiatId).filter((f): f is string => f !== undefined)
      const rateCoins = Array.from(new Set([currency, ...pegs]))
      let ratesFailed = false
      const ratesRead = sparkGetFiatRates(rateCoins).catch(() => {
        ratesFailed = true
        return null
      })
      const [info, rates, homeTokens, exit] = await Promise.all([
        sparkGetWalletInfo(),
        answerWithin(ratesRead, RATES_WAIT_MS),
        loadHomeTokens(),
        // Bounded by its own wait, past which it answers 'unread'.
        exitOnItsWay(walletId).catch(() => 'unread' as const),
      ])
      if (run !== epoch.current) {
        return false
      }
      if (mine !== latestLoad.current) {
        return newestLoad.current
      }
      setRecoverable(
        emergencyExitLive() && info.recoverableSat > 0
          ? { walletId, sat: info.recoverableSat, sync: info.sync }
          : null,
      )
      // Before the first sync the stored figure is the last sync's, however old. A plain figure this
      // wallet already showed came from a synced connection and stays, and so does a marked one
      // through a read nobody asked for, which draws no skeleton; otherwise the skeleton does, until
      // the sync or the end of the wait re-runs this load.
      if (info.sync === 'waiting') {
        setState(prev =>
          prev.status === 'ready' && (!prev.stale || source !== undefined) && prev.walletId === walletId
            ? prev
            : { status: 'loading' },
        )
        return false
      }
      // The SDK's own figure, exit or not: once a branch's first step confirms and a sync runs, the
      // balance already leaves its leaves out, so taking the plan off it would count them twice.
      const balanceSat = info.balanceSat
      const assets = buildSparkAssetList(
        balanceSat,
        info.tokens,
        homeTokens.catalog,
        homeTokens.hidden,
      )
      setKnownRows(assets.length)
      const tokenFiat = info.tokens.map(tk => ({
        amount: tk.balanceBaseUnits / 10 ** tk.decimals,
        pegFiat: KNOWN_TOKENS.find(k => k.identifier === tk.identifier)?.fiatId,
      }))
      // Rates are a price and not a balance, so a read that failed or ran late leaves the last ones
      // valid. Dropping them would turn a total back into sats for a network blip.
      const sameFigure = (prev: State): prev is Ready =>
        prev.status === 'ready' && prev.walletId === walletId && prev.currency === currency
      // Sorted, since the SDK rebuilds its token map on every read and hands it over in no fixed order.
      const heldTokens = info.tokens.map(tk => `${tk.identifier}:${tk.balanceBaseUnits}`).sort()
      const held = [walletId, balanceSat, ...heldTokens].join()
      holdingsMoved.current = info.sync === 'synced' && holdings.current !== null && holdings.current !== held
      holdings.current = held
      const keepRows = (prev: State): prev is Ready =>
        source !== undefined && prev.status === 'ready' && prev.walletId === walletId
      setState(prev => ({
        status: 'ready',
        walletId,
        stale: info.sync !== 'synced',
        balanceSat,
        exit,
        currency,
        rates: rates ?? (sameFigure(prev) ? prev.rates : {}),
        assets: keepRows(prev) ? (editingNow.current ? prev.assets : inShownOrder(prev.assets, assets)) : assets,
        tokenFiat,
        usdb: usdbBaseUnits(info.tokens),
      }))
      ratesRefused.current = ratesFailed
      if (rates === null) {
        ratesRead.then(late => {
          if (late !== null && mine === latestLoad.current) {
            setState(prev => (sameFigure(prev) ? { ...prev, rates: late } : prev))
          }
        })
      }
      loadedOnce.current = true
      if (workOwed.current) {
        workOwed.current = false
        setReloadSeq(s => s + 1)
        sweep()
      }
      return true
    } catch (error) {
      if (run === epoch.current) {
        hold(null)
      }
      if (run === epoch.current && mine !== latestLoad.current) {
        return newestLoad.current
      }
      // A connect a newer request replaced is no failure: that request's connect, or the switch it
      // came with, brings the next load. Matched by name, since screens never import the binding's
      // error classes and test doubles of spark.ts carry none.
      if ((error as Error | null)?.name === 'SparkConnectSuperseded') {
        return false
      }
      // A background refresh keeps the cached balance rather than blanking the screen.
      if (!background && run === epoch.current && mine === latestLoad.current) {
        setState({ status: 'error', code: classifyWalletError(error) })
      }
      return false
    }
    // resolveDisplayCurrency owns the locale default, so only the language is a dependency.
  }, [i18n.language, sweep, hold])

  const startRead = useCallback(
    (source?: LiveSource): Promise<boolean> => {
      const answer = readFigures(source)
      newestLoad.current = answer
      if (source === undefined) {
        clockWaits.current = Date.now() + SYNC_WAIT_MS
        const answered = () => {
          if (newestLoad.current === answer) {
            clockWaits.current = 0
          }
        }
        answer.then(answered, answered)
      }
      return answer
    },
    [readFigures],
  )
  const load = useCallback((): Promise<boolean> => startRead(), [startRead])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  const [focused, setFocused] = useState(true)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, []),
  )

  const feedback = usePullFeedback()
  const dropFeedback = feedback.drop

  // A switch fires before the reconnect, so Home drops the previous wallet's figure at once and the
  // next load starts from the skeleton. The card goes with it, since it is about the previous
  // wallet's payment and would tell this one that a payment of its own is landing or stuck.
  useEffect(
    () =>
      onActiveWalletChanged(() => {
        epoch.current += 1
        loadedOnce.current = false
        linked.current = false
        hold(null)
        giveBack()
        setRecovered(null)
        dropFeedback()
        holdings.current = null
        setHideFailed(false)
        setState({ status: 'loading' })
      }),
    [hold, giveBack, dropFeedback],
  )

  const pulling = useRef(false)

  // A read nobody asked for fades the figures it changes, and re-enters the page only when the wallet
  // itself moved: a rate moves the total every few seconds, and a page that rose for each would never
  // sit still. A pull answers for itself.
  const liveRead = useCallback(
    async (source: LiveSource) => {
      // The clock has no figure to keep current over a skeleton or a failed connect, and its next turn
      // comes soon enough for a read a pull or an explicit load is already making.
      if (source === 'timer' && (!loadedOnce.current || Date.now() < clockWaits.current)) {
        return
      }
      const run = epoch.current
      feedback.reading()
      const landed = await startRead(source)
      const moved = landed && holdingsMoved.current && !pulling.current
      holdingsMoved.current = false
      if (run === epoch.current) {
        feedback.answered(moved)
      }
    },
    [feedback, startRead],
  )
  const requestLive = useLiveFigures(liveRead, focused)
  const refreshLive = useCallback(() => requestLive(), [requestLive])

  // The rows hold still while the editor is open and the hero moves on without them, so Done reads
  // again rather than leave the rows behind until the clock's next turn. The close a load makes needs
  // no read, as that load brings fresh rows. The ref goes first, since the read can land before the
  // render that clears it.
  const closeEditor = useCallback(() => {
    editingNow.current = false
    setEditing(false)
    setHideFailed(false)
    requestLive()
  }, [requestLive])

  // The first sync, or the end of the wait for it, is what turns a skeleton or a marked figure into
  // the one shown.
  useSyncRefresh(refreshLive)

  useEffect(() => (emergencyExitLive() ? onSparkRecoverableFunds(refreshLive) : undefined), [refreshLive])

  // Funds leaving the figure emit nothing, so the end of a pass is what reads it again.
  const homeExit = useHomeExit(state.status === 'ready' ? state.walletId : null, refreshLive)
  const exitUnderWay = homeExit !== 'none'

  // Subscribing at mount would run before the SDK connects and throw, so it attaches on connect. Every
  // event counts, conversions and payments alike, and a burst comes to two reads.
  useEffect(() => {
    let unsub: (() => void) | null = null
    let alive = true
    const off = onSparkConnected(() => {
      if (unsub) {
        unsub()
        unsub = null
      }
      sparkSubscribeToPayments(refreshLive)
        .then(u => (alive ? (unsub = u) : u()))
        .catch(() => undefined)
    })
    return () => {
      alive = false
      off()
      if (unsub) {
        unsub()
      }
    }
  }, [refreshLive])

  // Syncs first and reads after, so nothing on screen moves before the sync answers. The mark goes up
  // ahead of the read, which can fail or never answer and would leave the figure looking current. A
  // failed connect has no sync to ask for, so there the pull is Try again. Off while editing, where a
  // load would close the editor, and while loading, with nothing on screen to refresh.
  const refreshControl = usePullRefresh(
    async () => {
      const run = epoch.current
      let heard = false
      pulling.current = true
      clockWaits.current = Date.now() + SYNC_WAIT_MS
      try {
        if (state.status === 'ready') {
          await sparkRefreshWallet()
          if (run !== epoch.current) {
            return
          }
          const sync = sparkSyncState()
          heard = sync === 'synced'
          if (sync === 'stale') {
            setState(prev => (prev.status === 'ready' ? { ...prev, stale: true } : prev))
          }
          feedback.reading()
        }
        // Bounded, since the load the answer comes from can be one that never answers.
        const landed = await answerWithin(load(), SYNC_WAIT_MS)
        if (run === epoch.current) {
          feedback.pulled(heard && landed === true && !ratesRefused.current)
        }
      } finally {
        pulling.current = false
      }
    },
    state.status === 'error' || (state.status === 'ready' && !editing),
  )

  // Home reads as a dollar account, which turns the accent green and keeps Convert only for a token
  // that can become dollars.
  // One source for the mode, shared with the wordmark, the tab bar and every CTA, so the screen can
  // never disagree with the chrome around it.
  const stableOn = useDollarMode()
  const stableSwitch = useStableSwitch({ reread: () => { load() } })
  const switchFailed = stableSwitch.error
  // The USDB the invitation was last answered at, with the wallet it belongs to, so a switch never
  // reads the previous wallet's figure.
  const [inviteSeen, setInviteSeen] = useState<{ walletId: string; baseUnits: number } | null>(null)
  const readyWalletId = state.status === 'ready' ? state.walletId : null
  useEffect(() => {
    if (readyWalletId === null) {
      return
    }
    let alive = true
    loadDollarInviteSeen(readyWalletId).then(baseUnits => {
      if (alive) {
        setInviteSeen({ walletId: readyWalletId, baseUnits })
      }
    })
    return () => {
      alive = false
    }
  }, [readyWalletId])
  const invited = useRef(false)
  // Only with the SDK on the wallet shown, since the switch moves the connected wallet, and nothing
  // while no wallet is connected.
  const offer =
    state.status === 'ready' && !stableSwitch.switching
      ? dollarOffer({
          available: state.walletId !== null && sparkConnectedWalletId() === state.walletId,
          modeOn: stableOn,
          synced: !state.stale,
          balanceSat: state.balanceSat,
          usdb: state.usdb,
          seen: inviteSeen?.walletId === state.walletId ? inviteSeen.baseUnits : null,
        })
      : { line: false, invite: false }

  // Remembered per wallet, so more USDB later opens it once more and the same figure never does.
  function answerInvite(): void {
    if (state.status === 'ready' && state.walletId !== null) {
      setInviteSeen({ walletId: state.walletId, baseUnits: state.usdb })
      saveDollarInviteSeen(state.walletId, state.usdb).catch(() => undefined)
    }
  }

  function closeSwitch(): void {
    stableSwitch.cancel()
    if (invited.current) {
      invited.current = false
      answerInvite()
    }
  }

  // Read on every render, so a text size chosen with the app open regroups the actions at once.
  const sideBySide = useSideBySide()
  const { fontScale } = useWindowDimensions()
  const { accent } = useAccent()
  const hero = state.status === 'ready' && chosenUnit !== undefined ? heroFor(state, chosenUnit) : null
  const heroWaiting = state.status === 'loading' || (state.status === 'ready' && hero === null)
  const dollarMode = hero?.kind === 'dollar'
  const heroLabel = hero?.whole === false ? t('home.bitcoinBalance') : t('home.balance')
  // In dollar mode a token can only become dollars, so Convert shows when there is one to convert.
  const convertible =
    !stableOn ||
    (state.status === 'ready' &&
      state.assets.some(
        a =>
          a.assetId !== BITCOIN_ASSET_ID &&
          a.assetId !== USDB.identifier &&
          Number(a.amount) > 0 &&
          // A pegged remainder under a cent is what a conversion leaves, below any minimum.
          !(knownToken(a.assetId)?.fiatId !== undefined && Number(a.amount) < 0.01),
      ))

  const scan = (
    <Touch
      onPress={() => openAction('Scan')}
      feedback="surface"
      label={t('scan.title')}
      disabled={heldAction === 'Scan'}
      state={{ busy: heldAction === 'Scan' }}
      style={[styles.scan, !sideBySide && styles.scanStacked]}>
      <TabIcon name="scan" color={colors.textSecondary} size={34} strokeWidth={2} />
    </Touch>
  )

  const body = (
    // Scrolls, because the fixed blocks above the assets take most of a 667pt screen and a fourth
    // asset or a card would otherwise push the last rows and Add asset out of reach. The rows reorder
    // inside it as the wallet list does inside the Wallets screen.
    <Screen
      scroll
      layout="padded"
      contentStyle={styles.content}
      refreshControl={refreshControl}
      onTouchStart={update.noteTouch}
      scrollGesture={feedback.scroll}>
      <View style={[styles.balanceBlock, { marginBottom: staleMarkRoom(fontScale) }]}>
        {/* The label names the figure, so it waits with it. Until the hero's kind is known nothing
            says whether the figure will be the total, and "Total Balance" over a skeleton that turns
            out to be the bitcoin balance states something false. A failed connect has no figure to
            name. */}
        {heroWaiting && <Skeleton width={LABEL_SKELETON} height={font.leading.base * fontScale} />}
        {hero && (
          <Row gap="sm" style={styles.labelRow}>
            <Txt role="bodyStrong" tone="muted">
              {heroLabel}
            </Txt>
            {/* Reaches 44pt by hit slop, since the floor would make this row 44 tall and push the
                label a full step away from the balance it names. The slop below stops at the
                balance toggle, which sits on top, so the slop above has to cover the difference. */}
            <Touch
              onPress={() => setHidden(h => !h)}
              feedback="link"
              size={20}
              hitSlop={space.lg}
              label={hidden ? t('passphrase.reveal') : t('passphrase.hide')}>
              <TabIcon name={hidden ? 'eye-off' : 'eye'} color={colors.textSecondary} size={18} />
            </Touch>
          </Row>
        )}

        {heroWaiting && (
          <>
            <Skeleton width={200} height={styles.balance.lineHeight * fontScale} borderRadius={radius.md} />
            <Skeleton width={96} height={styles.balanceFiat.lineHeight * fontScale} />
          </>
        )}

        {state.status === 'ready' && hero && (
          <Reenter beat={feedback.beat} order={0} style={styles.heroEntry}>
            <CrossFade
              value={[
                heroAnnouncement(hero, heroLabel),
                hero.kind === 'dollar' ? null : hero.line,
                stableOn ? dollarLine(state) : null,
                offer.line ? t('home.dollarOffer') : null,
              ].join()}
              armed={feedback.fading}
              tapped={[hidden, chosenUnit, dollarUnit].join()}
              style={styles.heroFigures}>
              <Touch
                onPress={() => cycleHero(hero)}
                feedback="link"
                label={heroAnnouncement(hero, heroLabel)}
                style={styles.balancePress}>
                {hidden ? (
                  <Figure role="display" tone="accent" style={styles.balance}>
                    ••••••
                  </Figure>
                ) : hero.kind === 'bitcoin' ? (
                  <Amount
                    value={hero.amount}
                    unit={hero.unit}
                    role="display"
                    tone="accent"
                    style={styles.balanceAmount}
                  />
                ) : (
                  <Figure role="display" tone="accent" tabular style={styles.balance}>
                    {hero.figure}
                  </Figure>
                )}
              </Touch>
              {/* Held with no line in it, and the mark takes it then, so what is under the hero stays
                  where it is whichever figures the wallet can state. */}
              {hero.kind !== 'dollar' && (
                <View style={[styles.heroLine, { minHeight: font.leading.lg * fontScale }]}>
                  {hero.line !== null ? (
                    <Figure role="subheading" tone="muted" tabular style={styles.balanceFiat}>
                      {hidden ? '••••' : hero.line}
                    </Figure>
                  ) : (
                    renderStaleMark(state)
                  )}
                </View>
              )}
              {stableOn && (
                <View style={[styles.heroLine, { minHeight: font.leading.lg * fontScale }]}>
                  {renderDollarLine(state)}
                </View>
              )}
              {state.exit !== null && (
                <Txt role="caption" tone="muted" style={styles.staleMark}>
                  {t('emergencyExit.balanceHeld')}
                </Txt>
              )}
              {offer.line && renderDollarOffer()}
              {switchFailed !== null && (
                <Txt role="caption" tone="danger" style={styles.staleMark}>
                  {switchFailed}
                </Txt>
              )}
              {/* In the gap under the block, out of the flow, so its coming and going moves nothing.
                  The block keeps what a larger text size asks beyond that gap, mark or no mark. */}
              {(hero.kind === 'dollar' || hero.line !== null) && state.stale && (
                <View style={styles.markInGap}>{renderStaleMark(state)}</View>
              )}
            </CrossFade>
          </Reenter>
        )}

        {state.status === 'error' && (
          <>
            <Txt role="labelStrong" tone="danger" style={styles.errorTitle}>
              {t('home.connectionError')}
            </Txt>
            {CONNECT_CAUSES.has(state.code) && (
              <Txt role="caption" tone="muted" style={styles.errorDetail}>
                {t(`errors.${state.code}`)}
              </Txt>
            )}
          </>
        )}
      </View>

      {/* Outside the ready state on purpose: this is the card for the day the SDK does not answer. */}
      {update.notice && (
        <UpdateBanner notice={update.notice} onDismiss={update.dismiss} style={styles.depositsCard} />
      )}

      {state.status === 'ready' && (
        <UnclaimedDepositsCard
          refreshKey={reloadSeq}
          onClaimed={load}
          onRefund={d => navigation.navigate('RefundDeposit', { txid: d.txid, vout: d.vout })}
          hidden={hidden}
          stale={state.stale}
          style={styles.depositsCard}
        />
      )}

      {state.status === 'ready' &&
        (exitUnderWay || state.exit !== null || (recoverable && recoverable.walletId === state.walletId)) && (
          <RecoverableFundsCard
            recoverableSat={recoverable?.sat ?? 0}
            sync={state.stale ? 'stale' : recoverable?.sync ?? 'waiting'}
            hidden={hidden}
            exitUnderWay={exitUnderWay || state.exit !== null}
            exitWaits={homeExit === 'waits'}
            exit={state.exit}
            onOpen={
              emergencyExitLive()
                ? () => navigation.navigate('EmergencyExit', { selection: 'recoverable' })
                : undefined
            }
            style={styles.depositsCard}
          />
        )}

      {offer.invite && (
        <Card gap="sm" style={styles.depositsCard}>
          <Txt role="bodyBold">{t('home.dollarInviteTitle')}</Txt>
          <Txt role="caption" tone="muted">
            {t('home.dollarInviteBody', { ticker: USDB.ticker })}
          </Txt>
          <Row gap="lg" style={styles.inviteActions}>
            <Touch
              onPress={() => {
                invited.current = true
                stableSwitch.ask(true)
              }}
              feedback="link"
              hitSlop={space.sm}>
              <Txt role="bodyBold" tone="accent">
                {t('home.dollarInviteOpen')}
              </Txt>
            </Touch>
            <Touch onPress={answerInvite} feedback="link" hitSlop={space.sm}>
              <Txt role="bodyStrong" tone="muted">
                {t('home.dollarInviteLater')}
              </Txt>
            </Touch>
          </Row>
        </Card>
      )}

      {state.status === 'ready' && (
        <BackupCard
          walletId={state.walletId}
          funded={state.balanceSat > 0 || state.tokenFiat.some(token => token.amount > 0)}
          refreshKey={reloadSeq}
          onPress={() => navigation.navigate('RecoveryPhrase')}
          style={styles.depositsCard}
        />
      )}

      {state.status === 'ready' && (
        <RecoveredPurchaseCard
          result={recovered}
          style={styles.depositsCard}
          onDismiss={dropCard}
          onChooseName={() => {
            dropCard()
            navigation.navigate('LnAddress', { choose: true })
          }}
        />
      )}

      {/* Only the figures wait for the sync, since Send reads its own balance and waits for its own. */}
      {/* Side by side the two halves hold their labels on one line; at the larger text sizes they
          stack, each across the screen, with the scan below them, so no label breaks in a word. */}
      {state.status !== 'error' && (
        <View style={[styles.actions, !sideBySide && styles.actionsStacked]}>
          <View style={sideBySide && styles.pill}>
            <GradientButton
              label={t('home.send')}
              singleLine
              icon={<TabIcon name="send" color={colors.onPrimary} size={22} strokeWidth={3} />}
              gradient={stableOn ? gradients.dollar : undefined}
              loading={heldAction === 'Send'}
              onPress={() => openAction('Send')}
            />
          </View>
          {sideBySide && scan}
          <View style={sideBySide && styles.pill}>
            <GradientButton
              label={t('home.receive')}
              singleLine
              icon={<TabIcon name="receive" color={colors.onPrimary} size={22} strokeWidth={3} />}
              gradient={stableOn ? gradients.dollar : undefined}
              loading={heldAction === 'Receive'}
              onPress={() => openAction('Receive')}
            />
          </View>
          {!sideBySide && scan}
        </View>
      )}

      {state.status === 'loading' && (
        <>
          <View style={styles.assetsSection}>
            <View style={styles.assetsHeader}>
              <Skeleton width={72} height={font.leading.sm} />
            </View>
            <GlassCard style={styles.assetsCard}>
              {Array.from({ length: knownRows }).map((_, index) => (
                <View
                  key={index}
                  style={[
                    styles.skeletonRow,
                    { height: assetRowHeight(sideBySide, fontScale) },
                    index > 0 && styles.skeletonRowDivider,
                  ]}>
                  <Skeleton width={28} height={28} borderRadius={radius.full} />
                  <Skeleton width={120} height={font.leading.base} />
                  <View style={styles.skeletonSpacer} />
                  <Skeleton width={64} height={font.leading.base} />
                </View>
              ))}
            </GlassCard>
          </View>
        </>
      )}

      {state.status === 'ready' && (
        <View style={styles.assetsSection}>
          <View style={styles.assetsHeader}>
            <SectionLabel>{t('home.assets')}</SectionLabel>
            {editing ? (
              <Touch onPress={closeEditor} feedback="link" hitSlop={space.sm}>
                <Txt role="labelStrong" tone="accent">
                  {t('home.done')}
                </Txt>
              </Touch>
            ) : !convertible ? null : (
              <Touch
                onPress={() => navigation.navigate('Convert')}
                feedback="link"
                hitSlop={space.md}
                style={styles.convertLink}>
                <TabIcon name="convert" color={accent} size={15} strokeWidth={2.75} />
                <Txt role="labelStrong" tone="accent">
                  {t('home.convert')}
                </Txt>
              </Touch>
            )}
          </View>
          <GlassCard style={styles.assetsCard}>
            <Reenter beat={feedback.beat} order={1}>
              <AssetList
                assets={
                  dollarMode ? orderForDollarMode(state.assets, state.balanceSat) : state.assets
                }
                editing={editing}
                hidden={hidden}
                fading={feedback.fading}
                onEnterEdit={() => {
                  setHideFailed(false)
                  setEditing(true)
                }}
                onReorder={reorderAssets}
                onRemove={removeAsset}
                onOpen={asset =>
                  navigation.navigate('AssetDetail', { assetId: asset.assetId, name: asset.name })
                }
              />
            </Reenter>
          </GlassCard>
          {/* Under the card rather than over it, so the rows stay under the finger that edits. */}
          <ErrorBox message={hideFailed ? t('home.hideFailed') : null} style={styles.hideFailed} />
          {!editing && (
            <AddRow
              label={t('home.addAsset')}
              onPress={() => navigation.navigate('AddAsset')}
              style={[styles.flush, styles.addAssetRow]}
            />
          )}
        </View>
      )}

      {state.status === 'error' && (
        <View style={styles.retry}>
          <GradientButton label={t('home.retry')} onPress={load} />
        </View>
      )}
      <StableConfirmSheet
        pending={stableSwitch.pending}
        onConfirm={() => {
          invited.current = false
          stableSwitch.confirm()
        }}
        onClose={closeSwitch}
      />
    </Screen>
  )

  // The price band stays outside the scroll, at the foot of the page where the tab bar meets it, so
  // the content ends above it and never passes behind it.
  return (
    <View style={styles.page} {...feedback.touch}>
      {body}
      <PriceStrip
        focused={focused}
        beat={feedback.beat}
        stale={state.status === 'ready' && state.stale}
        onOpen={() => navigation.navigate('AssetDetail', { assetId: BITCOIN_ASSET_ID, name: 'Bitcoin' })}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  // The tab bar under this screen holds the bottom inset, so the content leaves only its own air.
  content: {
    paddingBottom: space.xl,
  },
  balanceBlock: {
    // No top padding, since the container's edge padding is already the gap to the header.
    alignItems: 'center',
    gap: space.sm,
  },
  // Across the block, since a view entering sizes to its content in a centred column.
  heroEntry: {
    alignSelf: 'stretch',
  },
  // The same column the block lays its other lines out in, for the figures inside CrossFade.
  heroFigures: {
    alignSelf: 'stretch',
    alignItems: 'center',
    gap: space.sm,
  },
  labelRow: {
    justifyContent: 'center',
  },
  // Whichever figure it holds, so the block has one height from the skeleton on.
  balancePress: {
    alignItems: 'center',
    minHeight: font.leading.display,
  },
  // A fixed box, so the skeleton can match it, on the grid step just above the line the engine gives
  // a 40pt figure, which is what the sats hero's Amount takes, so the hero is close to one height
  // whichever branch draws it. It stays on the two branches that remain a plain Txt, the hidden dots
  // and the dollar hero, whose unit is baked into its formatted string. Never the font size: that box
  // cuts the top of any glyph taller than a digit.
  balance: {
    lineHeight: font.leading.display,
    textAlign: 'center',
  },
  balanceAmount: {
    alignItems: 'center',
  },
  // A Touch sizes to its content, so without the cap a long language or a large text size pushes the
  // chevron off the screen instead of wrapping the line.
  dollarLine: {
    maxWidth: '100%',
  },
  dollarLineText: {
    flexShrink: 1,
    textAlign: 'center',
  },
  inviteActions: {
    flexWrap: 'wrap',
  },
  // Its leading, not its size. The line can be a sentence in the app language ("3 000 sats in
  // bitcoin"), and Devanagari, Thai and Vietnamese marks rise above an 18pt box.
  balanceFiat: {
    lineHeight: font.leading.lg,
  },
  heroLine: {
    alignItems: 'center',
  },
  staleMark: {
    textAlign: 'center',
  },
  // Centred in the section gap under the block at the default text size.
  markInGap: {
    position: 'absolute',
    top: '100%',
    left: 0,
    right: 0,
    marginTop: (space.xxl - font.leading.sm) / 2,
  },
  skeletonRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  skeletonRowDivider: dividerTop,
  skeletonSpacer: {
    flex: 1,
  },
  errorTitle: {
    textAlign: 'center',
  },
  errorDetail: {
    marginTop: space.sm,
    textAlign: 'center',
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.xxl,
  },
  // A column of full-width actions, each child stretched across the screen.
  actionsStacked: {
    flexDirection: 'column',
    alignItems: 'stretch',
  },
  pill: {
    flex: 1,
  },
  scan: {
    width: touch.action,
    height: touch.action,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scanStacked: {
    width: '100%',
  },
  assetsSection: {
    marginTop: space.xxl,
  },
  depositsCard: {
    marginTop: space.xxl,
  },
  // Wraps, so at the larger text sizes Convert drops under the label instead of off the screen.
  assetsHeader: {
    // Convert's touch floor, for the skeleton's bar too, so the panel stays put when the rows land.
    minHeight: touch.min,
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    // A wrapping row sits its line at the top of the floor, so with no Convert link to fill that floor
    // the label would rise and the gap to the card would grow.
    alignContent: 'center',
    justifyContent: 'space-between',
    rowGap: space.sm,
    marginBottom: space.md,
  },
  // Add asset sits on the 24pt gutter, flush with the card's edges as the section label is, so the
  // inset AddRow brings for other screens is taken off here.
  flush: {
    paddingHorizontal: 0,
  },
  // A full-width row with no flexible child, so Touch would centre what it holds. Here the floor moves
  // content instead of only growing it, so the row brings its own alignment.
  convertLink: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: space.xs,
  },
  assetsCard: {
    // No vertical padding, since each fixed 60px row's own half-height already matches the gap.
    paddingVertical: 0,
    // A large full-bleed panel, which design-system.md gives radius.xxl, for the skeleton as well.
    borderRadius: radius.xxl,
    borderCurve: 'continuous',
  },
  // The same distance under the card as the Wallets screen keeps under its list.
  addAssetRow: {
    marginTop: space.xs,
  },
  // The distance the Wallets screen keeps between its error and its list.
  hideFailed: {
    marginTop: space.md,
  },
  retry: {
    marginTop: space.xxl,
  },
})
