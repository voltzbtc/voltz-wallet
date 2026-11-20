import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { AccessibilityInfo, AppState, Keyboard, Platform, StyleSheet, View } from 'react-native'
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
import {
  sparkClassify,
  sparkInspectDestination,
  sparkConfirmSend,
  sparkConfirmSendHeld,
  sparkDropHeldSend,
  sparkPrepareSend,
  sparkDiscardSendQuote,
  sparkPrepareCrossChainSend,
  sparkParseLnurlPay,
  sparkPrepareLnurlPay,
  sparkConfirmLnurlPay,
  sparkConnectedWalletId,
  sparkFollowSend,
  sparkSentRail,
  sparkGetFiatRates,
  sparkGetStableBalance,
  sparkGetWalletInfo,
  sparkRetryHeldSend,
  sparkSendTakesKey,
  sparkSyncState,
  type BalanceSync,
  type SparkWalletInfo,
  type SparkCrossChainQuote,
  type SparkCrossChainRoute,
  type SparkDestinationKind,
  type SparkSendConversion,
  type SparkSendQuote,
  type OnchainSpeed,
  type SparkSendStatus,
  type SparkLnurlPay,
} from '../wallet/spark'
import { mintSendKey } from '../wallet/sendKey'
import {
  assetOfToken,
  sparkConvertAssets,
  tokenIdOf,
  iconIdOf,
  toBaseUnits,
  fromBaseUnits,
  formatBaseUnitsExact,
  effectiveConvertCostPct,
  formatCostPct,
  SPARK_BTC,
  type SparkConvertAsset,
} from '../wallet/sparkConvert'
import { USDB } from '../wallet/tokens'
import {
  PREFER_SPARK_ROUTE,
  carriesToken,
  dustLimitSat,
  isOnchainKind,
  nothingArrives,
  payeeNote,
  routedQuote,
  sendReceives,
  sendTotal,
  takesSparkRoute,
} from '../wallet/sendAll'
import { nfcState, openNfcSettings, type NfcState } from '../wallet/nfc'
import { useNfcRead } from '../hooks/useNfcRead'
import { NfcReadSheet } from '../components/NfcReadSheet'
import { classifyWalletError, isExpiredInvoiceRefusal, isUsedInvoiceRefusal, walletErrorKey } from '../wallet/errors'
import {
  crossChainBoundsSat,
  formatSats,
  parseAmountSat,
  parseConvertAmount,
} from '../wallet/amount'
import { fiatSymbol, satsToFiat, formatFiat, localizeAmount, type FiatCurrency } from '../wallet/fiat'
import { resolveDefaultFiat } from '../wallet/deviceLocale'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { AmountSheet, type Denom } from '../components/AmountSheet'
import { AssetIcon } from '../components/AssetIcon'
import { AssetPickerSheet, type PickerItem } from '../components/AssetPickerSheet'
import { receiveStyles } from '../components/receiveStyles'
import { SectionLabel } from '../components/SectionLabel'
import { joinLabels } from '../i18n/join'
import { coinIconId } from '../components/stableLogos'
import {
  answersWithin,
  bestOffer,
  chainDisplayName,
  contractNote,
  crossChainSource,
  groupRoutes,
  providerDisplayName,
  quoteLapsed,
  quoteLapsesInMs,
  routeContenders,
  type CrossChainSource,
} from '../wallet/crossChain'
import { GradientButton } from '../components/GradientButton'
import { SegmentedControl } from '../components/SegmentedControl'
import { TabIcon } from '../components/TabIcon'
import { ReceivedOverlay } from '../components/ReceivedOverlay'
import { SaveContactSheet } from '../components/SaveContactSheet'
import { Skeleton } from '../components/Skeleton'
import { SendBalance } from '../components/SendBalance'
import { useContacts } from '../hooks/useContacts'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { ErrorBox } from '../components/ErrorBox'
import { ChunkedAddress } from '../components/ChunkedAddress'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { colors, dividerTop, font, radius, rhythm, space, touch } from '../theme'
import { useAccent, useDollarMode } from '../wallet/dollarMode'
import { dollarsOfSats, formatSmallFiat } from '../wallet/assets'
import { contactKey, matchContacts } from '../wallet/history'
import { couldBeAddress, probeLightningAddress } from '../wallet/lnaddress'
import { isBitcoinUri } from '../wallet/paymentInput'
import { exitHoldOnSend, type SendHold } from '../wallet/exitHold'
import { onActiveWalletChanged } from '../wallet/wallet'
import { Txt } from '../components/Txt'
import { Amount, Figure } from '../components/Amount'
import { FigureRow } from '../components/FigureRow'
import { Card } from '../components/Card'
import { DetailsFold } from '../components/DetailsFold'
import { Row } from '../components/Row'
import { Screen } from '../components/Screen'
import { Field } from '../components/Field'
import { Touch } from '../components/Touch'
import { noticeTitle, tokenUnit, type NoticeRail } from '../wallet/paymentNotice'

type Nav = NativeStackNavigationProp<RootStackParamList, 'Send'>

// A cross-chain send counts its source leaving and a different asset arriving, never a plain quote's fields.
type Quote =
  | { kind: 'plain'; value: SparkSendQuote }
  | { kind: 'crossChain'; value: SparkCrossChainQuote }

// What a confirm sent, taken from the quote at the press, because the quote can change or go after it
// and the overlay must not. `amount` is in the base units of `asset`, sats when there is none.
type Sent = {
  status: Exclude<SparkSendStatus, 'failed'>
  // The rail the SDK's record of the send names, which the quote's kind does not settle.
  rail?: NoticeRail
  crossChain: boolean
  amount: number
  asset?: SparkConvertAsset
  fiat?: string
  // What a dollar wallet reads the sats as, at the rate of the press. Absent under a cent.
  dollars?: number
}

// The figures of a review on a dollar wallet, whose dollars are a reading of sats at this rate.
type DollarReview = { rate: number }

// Pays any BTC or Lightning destination and moves Spark tokens. LNURL endpoints take the LNURL-pay flow.
// A cross-chain stablecoin figure shows down to a cent's ten-thousandth, never an 18-decimal tail.
const STABLE_PLACES = 6
// Dollars are typed to the cent.
const DOLLAR_PLACES = 2
// A screen left open keeps its quote current this many times, and after that asks. Each one is a
// request to a provider nobody is looking at.
const MAX_AUTO_REFRESHES = 3
// Past this a quote that has not answered counts as failed, since Confirm stays off until it does.
const REFRESH_LIMIT_MS = 15_000
// A pause in typing long enough to read as a finished destination.
const TYPING_PAUSE_MS = 400
// How long a copy says so.
const COPIED_FOR_MS = 2000
// What the keypad hands back: sats, dollars of a USDB-funded send, or a token's base units under
// the token's identifier, which never reads as either of the other two.
const SATS_UNIT = 'sats'
const USDB_DOLLARS_UNIT = 'usdb-dollars'

// Why a destination is not paid. Text the parser could not read is said the way Scan and errors.ts say
// it, an address its own server denies the way Contacts does, and another network's address as the
// wallet's limit, since it was read whole.
type Refusal = 'unsupported' | 'unrecognized' | 'notFound' | 'offline' | 'connecting'
const REFUSAL_KEY: Record<Refusal, string> = {
  unsupported: 'send.unsupported',
  unrecognized: 'errors.invalidInput',
  notFound: 'contacts.addressNotFound',
  offline: 'errors.offline',
  connecting: 'send.stillConnecting',
}

export function SendSpark(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  const dollarMode = useDollarMode()
  const navigation = useNavigation<Nav>()
  const route = useRoute<RouteProp<RootStackParamList, 'Send'>>()

  const [destination, setDestination] = useState(route.params?.destination ?? '')
  // The name of a contact picked as the destination, which then stands in place of the field.
  const [pickedContact, setPickedContact] = useState<string | null>(null)
  const { contacts, answered: contactsAnswered } = useContacts()
  const [quote, setQuote] = useState<Quote | null>(null)
  const [onchainSpeed, setOnchainSpeed] = useState<OnchainSpeed>('medium')
  const [kind, setKind] = useState<SparkDestinationKind | null>(null)
  const [lnurlPay, setLnurlPay] = useState<SparkLnurlPay | null>(null)
  const lnurlRef = useRef<SparkLnurlPay | null>(null)
  const [result, setResult] = useState<Sent | null>(null)
  // The address to offer as a contact, which replaces the overlay once it has finished.
  const [contactOffer, setContactOffer] = useState<string | null>(null)
  // Set only by a send the SDK says finished, because a server's thanks arrives while still on the way.
  const [note, setNote] = useState<string | undefined>(undefined)
  // A quote whose confirm ended without an overlay. Its handle is spent whatever happened, and a send
  // that threw may still have gone out, so this quote never confirms again. Held by handle, so any
  // later quote starts clean.
  const [spent, setSpent] = useState<{ handle: string; uncertain: boolean } | null>(null)
  // The key the spent quote's send went out under, while its end is in doubt. spark.ts holds the
  // request under the handle, and Try again sends it again under this key and no other. Dropped with the
  // quote, so no later request ever goes out under it.
  const [held, setHeld] = useState<{ handle: string; key: string } | null>(null)
  const heldRef = useRef(held)
  heldRef.current = held
  // Set from the press of Try again until it answers, since a second press can land before a render.
  const retrying = useRef(false)
  // A QR wrapped in a bitcoin URI but routed over Spark must review as the spark address.
  const [resolvedDest, setResolvedDest] = useState('')
  const [error, setError] = useState<string | null>(null)
  // The bitcoin address the dollar wallet cannot pay yet. Apart from `error`, since it comes with a way
  // out and goes when the mode does.
  const [needsBitcoinMode, setNeedsBitcoinMode] = useState(false)
  // A unified code whose invoice ran out, held before its on-chain leg until the person asks for it.
  const [invoiceRanOut, setInvoiceRanOut] = useState(false)
  // The destination whose on-chain leg the person asked for after its invoice ran out.
  const onchainAsked = useRef<string | null>(null)
  // Why the text is not a destination, apart from `error`, since a contact it matches answers instead.
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  const [preparing, setPreparing] = useState(false)
  // A prepare started by a pause in typing, which keeps the field and its keyboard on screen.
  const [fieldHeld, setFieldHeld] = useState(false)
  // A classification of typed text is out, which the field shows without moving.
  const [classifying, setClassifying] = useState(false)
  const [busy, setBusy] = useState(false)
  // The step a dollar send is on, named beside the spinner only while it runs.
  const [sendStage, setSendStage] = useState<'converting' | 'sending' | null>(null)
  // The review's rates as they stood at the press, so one landing during a send moves no figure.
  const [pressedRates, setPressedRates] = useState<{
    dollar: DollarReview | undefined
    fiat: number | null
  } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  // The balance as read when the sheet opened. A receive with this screen open rewrites nothing, and
  // the lock would refuse money that already arrived.
  const [sheetBalanceRead, setSheetBalanceRead] = useState(false)
  // Asked of the SDK for this sheet, since the mode's context can lag it and a dollar sale of the whole
  // balance only sweeps the sats with the label on in this connection.
  const [sheetModeOn, setSheetModeOn] = useState(false)
  // Held rather than chosen again, since a second tap on Use all lands before a render.
  const spendingAll = useRef(false)
  // What the SDK turned away only because its fee moved, which the same press can try again.
  const [retryable, setRetryable] = useState<{
    dest: string
    amount?: number | bigint
    comment?: string
    spendAll: boolean
    amountToken?: string
    dollarBalance?: boolean
  } | null>(null)
  // The destination takes its amount from the person, so a way to give or change one stays on
  // screen while no quote is up (Breez's send UX guide).
  const [takesAmount, setTakesAmount] = useState(false)
  // The last amount typed for this destination, which the keypad reopens with: `text` as the keypad
  // takes it back, sats for bitcoin whatever unit its toggle showed, `denom` that unit and
  // `currency` its money. `unit` is what the keypad handed back, and the same digits in another
  // unit are another value, so the keypad takes them back only in that unit (Breez's send UX guide).
  const [typedAmount, setTypedAmount] = useState<{
    text: string
    denom?: Denom
    currency?: FiatCurrency
    unit: string
    shown: string
  } | null>(null)
  // A fee that moved at the press, priced again. The review says so until the next press (Breez's send
  // payment guide).
  const [feeMoved, setFeeMoved] = useState(false)
  const feeMovedNext = useRef(false)
  // What the newest prepare was asked for, which a fee that moved at the press prices again as it was.
  const prepareAsked = useRef<{
    dest: string
    amount?: number | bigint
    comment?: string
    spendAll: boolean
    amountToken?: string
    dollarBalance: boolean
  } | null>(null)
  // A send in doubt that Back left behind. Its line stays with the destination it was sent to, since
  // a second send there with the amount kept is a few taps away.
  const [doubtLeft, setDoubtLeft] = useState(false)
  // 'unsupported' until the first check answers, so the chip never shows before it is known.
  const [nfc, setNfc] = useState<NfcState>('unsupported')
  const [balanceSat, setBalanceSat] = useState(0)
  // Until a read from a synced connection lands, the balance is never shown or checked as current.
  const [balanceSync, setBalanceSync] = useState<BalanceSync>('waiting')
  // Token balances count base units and never map to sats.
  const [tokenBalances, setTokenBalances] = useState<Record<string, number>>({})
  const [fiatRate, setFiatRate] = useState<number | null>(null)
  // Cross-chain routes bound order value in dollars, whatever the display currency is.
  const [usdRate, setUsdRate] = useState<number | undefined>(undefined)
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>(resolveDefaultFiat(i18n.language))

  const [assets, setAssets] = useState<SparkConvertAsset[]>([SPARK_BTC])
  const assetsRef = useRef<SparkConvertAsset[]>([SPARK_BTC])
  const [asset, setAsset] = useState<SparkConvertAsset>(SPARK_BTC)
  // The asset of the screen Send was opened from, kept through the first destination read and then let
  // go, so every later destination starts from bitcoin as before (Breez's UX principles).
  const fromAssetScreen = useRef<SparkConvertAsset | null>(null)
  const firstDestinationRead = useRef(false)
  // The token that first destination could not carry, which the step and its review say once.
  const [assetMoved, setAssetMoved] = useState<string | null>(null)
  const [pickingAsset, setPickingAsset] = useState(false)
  // A Spark invoice can name its own token and the SDK rejects a mismatch, so the picker is hidden.
  const [invoiceToken, setInvoiceToken] = useState<string | undefined>(undefined)

  const [routes, setRoutes] = useState<SparkCrossChainRoute[]>([])
  const [selectedRoute, setSelectedRoute] = useState<SparkCrossChainRoute | null>(null)
  const [pickingRoute, setPickingRoute] = useState(false)
  const routeRef = useRef<SparkCrossChainRoute | null>(null)
  // Re-parsing the destination lists every route again, so a refusal is remembered per destination.
  const refusedRoutes = useRef(new Set<string>())
  // The quotes of each provider of a route, when it has more than one. `quote` is the one marked.
  const [offers, setOffers] = useState<SparkCrossChainQuote[]>([])
  const offersRef = useRef<SparkCrossChainQuote[]>([])

  const isBtcAsset = asset.id === SPARK_BTC.id
  const sendTokenId = invoiceToken ?? (isBtcAsset ? undefined : tokenIdOf(asset))
  // For the steps before a quote. Once there is one, the review draws the asset the quote spends.
  const sendAsset = invoiceToken ? assetOfToken(invoiceToken, assets) ?? asset : asset

  // Only the newest prepare answers. Contacts and Scan come back to this same screen, where an older
  // one can still be in flight for the destination it replaced.
  const prepareSeq = useRef(0)
  // The amount asked for, which a quote's own amountIn can differ from, in the unit of its source.
  const crossChainAsked = useRef<{ routeId: string; amount: number; source: CrossChainSource } | null>(null)
  const refreshSeq = useRef(0)
  const autoRefreshes = useRef(0)
  const [refreshing, setRefreshing] = useState(false)
  const [quoteUpdated, setQuoteUpdated] = useState(false)
  // Lapsed with the automatic updates used up, so only a press asks for another.
  const [quoteStale, setQuoteStale] = useState(false)

  // An emergency exit under way holds Send shut. Read on each focus, since the exit's screen opens over
  // this one, and again at the press of Confirm. A prepare waits for the newest read, and only the newest
  // lands on screen.
  const [exitHold, setExitHold] = useState<SendHold>('none')
  const exitRead = useRef<Promise<SendHold> | null>(null)
  const readExitHold = useCallback((): Promise<SendHold> => {
    const read = exitHoldOnSend(sparkConnectedWalletId())
    exitRead.current = read
    read.then(hold => {
      if (exitRead.current === read) {
        setExitHold(hold)
      }
    })
    return read
  }, [])
  useFocusEffect(
    useCallback(() => {
      readExitHold()
    }, [readExitHold]),
  )

  const autoTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Only the newest classification answers, whether the text moved on or something else took over.
  const classifySeq = useRef(0)
  const cancelAutoPrepare = useCallback(() => {
    classifySeq.current += 1
    setClassifying(false)
    if (autoTimer.current) {
      clearTimeout(autoTimer.current)
      autoTimer.current = null
    }
  }, [])
  useEffect(() => cancelAutoPrepare, [cancelAutoPrepare])

  const dropRefresh = useCallback(() => {
    refreshSeq.current += 1
    autoRefreshes.current = 0
    setRefreshing(false)
    setQuoteUpdated(false)
    setQuoteStale(false)
  }, [])

  const holdOffers = useCallback((next: SparkCrossChainQuote[]) => {
    offersRef.current = next
    setOffers(next)
  }, [])
  // Each offer holds a prepared send, and only the kept one may still go out.
  const dropOffers = useCallback(
    (keep?: string) => {
      offersRef.current.forEach(offer => {
        if (offer.handle !== keep) {
          sparkDiscardSendQuote(offer.handle)
        }
      })
      holdOffers([])
    },
    [holdOffers],
  )

  // A token, route or endpoint left from a previous destination would send the wrong asset or chain.
  const resetDerived = useCallback(() => {
    dropRefresh()
    dropOffers()
    crossChainAsked.current = null
    setPickedContact(null)
    setQuote(null)
    setError(null)
    setRefusal(null)
    setNeedsBitcoinMode(false)
    setInvoiceRanOut(false)
    onchainAsked.current = null
    setRetryable(null)
    setTakesAmount(false)
    setTypedAmount(null)
    setDoubtLeft(false)
    setFeeMoved(false)
    setKind(null)
    lnurlRef.current = null
    setLnurlPay(null)
    setAsset(fromAssetScreen.current ?? SPARK_BTC)
    setAssetMoved(null)
    setInvoiceToken(undefined)
    routeRef.current = null
    refusedRoutes.current.clear()
    setSelectedRoute(null)
    setRoutes([])
  }, [dropRefresh, dropOffers])

  // True when the refusal leaves no network to choose.
  const refuseRoute = (offered: SparkCrossChainRoute[], refused: SparkCrossChainRoute): boolean => {
    refusedRoutes.current.add(refused.id)
    const left = offered.filter(item => item.id !== refused.id)
    setRoutes(left)
    routeRef.current = null
    setSelectedRoute(null)
    if (left.length === 0) {
      setError(t('send.noRoutes'))
    }
    return left.length === 0
  }

  const markOffer = (offer: SparkCrossChainQuote, among: SparkCrossChainRoute[]) => {
    const marked = among.find(item => item.id === offer.routeId)
    if (marked) {
      routeRef.current = marked
      setSelectedRoute(marked)
    }
    if (crossChainAsked.current) {
      crossChainAsked.current = { ...crossChainAsked.current, routeId: offer.routeId }
    }
    setQuote({ kind: 'crossChain', value: offer })
  }

  // With the field up during a prepare, the text can move on while that prepare is out.
  const dropPrepare = useCallback(() => {
    prepareSeq.current += 1
    setPreparing(false)
  }, [])

  const clear = useCallback(() => {
    cancelAutoPrepare()
    dropPrepare()
    setDestination('')
    setResult(null)
    resetDerived()
  }, [cancelAutoPrepare, dropPrepare, resetDerived])

  // The contact's name is the wallet's own, and the list and the chip go with it.
  const chipShown = useRef(false)
  chipShown.current = pickedContact !== null
  useEffect(
    () =>
      onActiveWalletChanged(() => {
        if (chipShown.current) {
          clear()
        }
      }),
    [clear],
  )

  // A parse that failed gives no reason, and a destination that may be right is never called wrong on
  // a read that did not land. Before the connection's first sync that read may only have come too
  // early. A synced connection says nothing of the network now, since it stays synced through a drop,
  // so an address is taken to its own server. A bitcoin: URI is no address, and the SDK refused it
  // offline.
  const refusalOf = async (text: string, read: SparkDestinationKind): Promise<Refusal> => {
    if (read === 'wrongNetwork') {
      return 'unsupported'
    }
    if (read === 'unread') {
      return 'offline'
    }
    const sync = sparkSyncState()
    if (sync !== 'synced') {
      return sync === 'waiting' ? 'connecting' : 'offline'
    }
    if (isBitcoinUri(text) || !couldBeAddress(text)) {
      return 'unrecognized'
    }
    return (await probeLightningAddress(text)) === 'wrong' ? 'notFound' : 'offline'
  }

  // The amount arrives in the destination's own unit, sats for Bitcoin and base units for a token, and
  // a typed amount's token travels with it as `amountToken`. A token typed on the keypad comes as a
  // bigint, since a double cannot carry an 18-place figure, and only a Spark address takes one.
  // Nothing here reads the chosen asset: a destination handed in resets it in the same render, and
  // an amount the destination names is never in a token the person picked.
  const runPrepare = useRef(
    async (
      _dest: string,
      _amount?: number | bigint,
      _comment?: string,
      _spendAll?: boolean,
      _amountToken?: string,
      _dollarBalance?: boolean,
      _typed?: boolean,
    ) => {},
  )
  runPrepare.current = async (
    dest: string,
    amount?: number | bigint,
    comment?: string,
    spendAll = false,
    amountToken?: string,
    dollarBalance = false,
    typed = false,
  ) => {
    const trimmed = dest.trim()
    if (trimmed.length === 0) {
      return
    }
    cancelAutoPrepare()
    dropRefresh()
    dropOffers()
    setError(null)
    setRefusal(null)
    setNeedsBitcoinMode(false)
    setInvoiceRanOut(false)
    setRetryable(null)
    setResult(null)
    setQuote(null)
    setFeeMoved(feeMovedNext.current)
    feeMovedNext.current = false
    prepareAsked.current = { dest, amount, comment, spendAll, amountToken, dollarBalance }
    setFieldHeld(typed)
    setPreparing(true)
    const seq = ++prepareSeq.current
    const replaced = () => seq !== prepareSeq.current
    const askAmount = () => {
      setTakesAmount(true)
      setSheetOpen(true)
    }
    const all = dollarBalance ? ([true, true] as const) : spendAll ? ([true] as const) : ([] as const)
    let offered: SparkCrossChainRoute[] = []
    try {
      const hold = await (exitRead.current ?? readExitHold())
      if (replaced()) {
        return
      }
      if (hold !== 'none') {
        setExitHold(hold)
        return
      }
      const info = await sparkInspectDestination(trimmed)
      if (replaced()) {
        return
      }
      if (info.kind === 'other' || info.kind === 'unread' || info.kind === 'wrongNetwork') {
        const why = await refusalOf(trimmed, info.kind)
        if (!replaced()) {
          setRefusal(why)
        }
        return
      }
      // A withdraw voucher is a receive, so it routes to Redeem instead of reaching prepareSendPayment.
      if (info.kind === 'lnurlWithdraw') {
        navigation.replace('Redeem', { destination: trimmed })
        return
      }
      // The asset Send was opened on holds through the first destination read. One that cannot carry it
      // is paid in bitcoin and says so, except where it would not be: an invoice that names its own
      // token, or a dollar wallet that funds any send from USDB anyway.
      if (!firstDestinationRead.current) {
        firstDestinationRead.current = true
        const picked = fromAssetScreen.current
        fromAssetScreen.current = null
        const pickedToken = picked ? tokenIdOf(picked) : undefined
        if (pickedToken !== undefined && !carriesToken(info, pickedToken)) {
          setAsset(SPARK_BTC)
          if (info.tokenIdentifier === undefined && !(dollarMode && pickedToken === USDB.identifier)) {
            setAssetMoved(picked?.ticker ?? null)
          }
        }
      }
      // The address beside an invoice that ran out may belong to the same request, which then settles
      // late and on the slower network, so the person hears of the expiry before anything is priced.
      if (info.expiredInvoice && onchainAsked.current !== trimmed) {
        setInvoiceRanOut(true)
        return
      }
      // A withdrawal is priced against bitcoin the wallet holds, and the dollar wallet holds none, so
      // the SDK funds it with a swap inside the send. That swap races the withdrawal: the leaf it
      // produces can still be TransferLocked when the withdrawal reserves leaves, the send fails
      // after the conversion has run, and the sweeper converts the sats back. Money moves twice while
      // the send reports only that it could not. The guard stays until the SDK closes that race
      // (docs/dollar-mode-onchain.md); lifting it is this one condition.
      if (isOnchainKind(info.kind) && dollarMode) {
        setNeedsBitcoinMode(true)
        return
      }
      setKind(info.kind)
      setResolvedDest(info.resolved ?? trimmed)
      // Parsing the endpoint costs a network round-trip, so it is reused when re-preparing with an amount.
      if (info.kind === 'lnurlPay' || info.kind === 'lightningAddress') {
        // It takes its amount from the person whatever the endpoint answers, so a read that fails
        // leaves the amount a tap away, and that tap reads the endpoint again (Breez's send UX guide).
        setTakesAmount(true)
        if (!lnurlRef.current) {
          const parsed = await sparkParseLnurlPay(trimmed)
          if (replaced()) {
            return
          }
          lnurlRef.current = parsed
          setLnurlPay(parsed)
        }
        // Sats only, so a token's base units ask for the amount again rather than pay as sats.
        if (amount === undefined || typeof amount === 'bigint') {
          askAmount()
          return
        }
        const priced = await sparkPrepareLnurlPay(lnurlRef.current.handle, amount, comment, ...all)
        if (!replaced()) {
          setQuote({ kind: 'plain', value: priced })
        }
        return
      }
      // One EVM address exists on every EVM chain, so the route is picked before any amount.
      if (info.kind === 'crossChainAddress') {
        const available = (info.routes ?? []).filter(item => !refusedRoutes.current.has(item.id))
        offered = available
        setRoutes(available)
        if (available.length === 0) {
          setError(t('send.noRoutes'))
          return
        }
        setTakesAmount(true)
        // One network to speak of decides alone, on a first look only. After a refusal the send would
        // go to another network without the person seeing it, so the list stays.
        if (!routeRef.current && refusedRoutes.current.size === 0) {
          const groups = groupRoutes(available)
          if (groups.length === 1) {
            routeRef.current = groups[0].routes[0]
            setSelectedRoute(groups[0].routes[0])
          }
        }
        const chosen = routeRef.current
        if (!chosen) {
          setPickingRoute(true)
          return
        }
        // Sats or dollars only, so a token's base units ask for the amount again rather than pay as either.
        if (amount === undefined || typeof amount === 'bigint') {
          askAmount()
          return
        }
        // The source travels with the amount, since the digits mean something else in the other one.
        const source: CrossChainSource = amountToken === USDB.identifier ? 'usdb' : 'sats'
        crossChainAsked.current = { routeId: chosen.id, amount, source }
        const contenders = routeContenders(available, chosen, source)
        if (contenders.length === 1) {
          const priced = await sparkPrepareCrossChainSend(chosen.id, amount, source)
          if (!replaced()) {
            setQuote({ kind: 'crossChain', value: priced })
          }
          return
        }
        const { answers, failures } = await answersWithin(
          contenders.map(item => sparkPrepareCrossChainSend(item.id, amount, source)),
          REFRESH_LIMIT_MS,
          late => sparkDiscardSendQuote(late.handle),
        )
        if (replaced()) {
          answers.forEach(answer => sparkDiscardSendQuote(answer.handle))
          return
        }
        if (answers.length === 0) {
          throw failures[0] ?? new Error('timeout')
        }
        holdOffers(answers)
        markOffer(bestOffer(answers), available)
        return
      }
      const billed = info.kind === 'sparkAddress' ? info.tokenIdentifier : undefined
      setInvoiceToken(billed)
      const amountless = isOnchainKind(info.kind) || info.kind === 'sparkAddress'
      if (
        amountless &&
        amount === undefined &&
        info.amount === undefined &&
        info.requestedAmount === undefined
      ) {
        // A Spark address takes bitcoin or any token, so with tokens in the wallet it is the one
        // destination whose keypad waits for a tap. The asset row comes first, and the amount link
        // under it opens the keypad. Opening it here would ask how much before of what, over the row
        // that answers it, and the same digits mean a different value in each asset. A cross-chain
        // address likewise asks for its network before the keypad.
        const hasTokens = assetsRef.current.some(item => item.id !== SPARK_BTC.id)
        if (info.kind === 'sparkAddress' && billed === undefined && hasTokens) {
          setTakesAmount(true)
          return
        }
        askAmount()
        return
      }
      const token = billed ?? amountToken
      // A BIP21 that named an amount supplies it through requestedAmount, since the resolved leg embeds none.
      const preview = await sparkPrepareSend(
        info.resolved ?? trimmed,
        amount ?? info.requestedAmount,
        token,
        ...all,
      )
      if (replaced()) {
        return
      }
      // A bolt11 with no embedded amount comes back as 0 and still needs a value.
      if (preview.amount === 0 && amount === undefined) {
        askAmount()
        return
      }
      setQuote({ kind: 'plain', value: routedQuote(preview, PREFER_SPARK_ROUTE) })
    } catch (cause) {
      if (replaced()) {
        return
      }
      const code = classifyWalletError(cause)
      // A network that refuses outright would refuse again, so it leaves the choice. With nothing left
      // to choose, "choose another network" would point at an empty list.
      const refused = routeRef.current
      if (code === 'routeUnavailable' && refused && refuseRoute(offered, refused)) {
        return
      }
      if (code === 'feeIncreased') {
        setRetryable({ dest, amount, comment, spendAll, amountToken, dollarBalance })
      }
      setError(code === 'unknown' ? t('send.reviewFailed') : t(`errors.${code}`))
    } finally {
      if (!replaced()) {
        setPreparing(false)
      }
    }
  }

  // Asks for the same route and amount again without passing through runPrepare, which would take the
  // review off the screen. A quote that cannot be replaced never comes back: the person lands on the
  // destination step, with the amount still one press away unless the network itself refused.
  const refreshQuote = useRef(async () => {})
  refreshQuote.current = async () => {
    const asked = crossChainAsked.current
    if (!asked) {
      return
    }
    const seq = ++refreshSeq.current
    const replacing = quote?.value.handle
    setRefreshing(true)
    setQuoteStale(false)
    setQuoteUpdated(false)
    setError(null)
    let limit: ReturnType<typeof setTimeout> | undefined
    try {
      const next = await Promise.race([
        sparkPrepareCrossChainSend(asked.routeId, asked.amount, asked.source),
        new Promise<never>((_, reject) => {
          limit = setTimeout(() => reject(new Error('timeout')), REFRESH_LIMIT_MS)
        }),
      ])
      if (seq === refreshSeq.current) {
        // The screen no longer offers the handle it replaced, and the map is what signs.
        if (replacing !== undefined && replacing !== next.handle) {
          sparkDiscardSendQuote(replacing)
        }
        setQuote({ kind: 'crossChain', value: next })
        holdOffers(offersRef.current.map(offer => (offer.routeId === next.routeId ? next : offer)))
        setQuoteUpdated(true)
        setRefreshing(false)
      }
    } catch (cause) {
      if (seq !== refreshSeq.current) {
        return
      }
      setRefreshing(false)
      setQuote(null)
      const code = classifyWalletError(cause)
      const refused = routeRef.current
      if (code === 'routeUnavailable' && refused) {
        if (refuseRoute(routes, refused)) {
          return
        }
      } else {
        setRetryable({
          dest: destination,
          amount: asked.amount,
          spendAll: false,
          amountToken: asked.source === 'usdb' ? USDB.identifier : undefined,
        })
      }
      setError(code === 'unknown' ? t('send.reviewFailed') : t(`errors.${code}`))
    } finally {
      clearTimeout(limit)
    }
  }

  // Asked on every focus and every return to the app, so NFC switched on in the system settings, or
  // from the quick settings over the app (Android's 'focus'), shows without reopening Send. Only the
  // newest answer lands, and until it does the chip keeps the last one, which a tap follows.
  const nfcCheck = useRef(0)
  const recheckNfc = useCallback(() => {
    const seq = ++nfcCheck.current
    nfcState().then(state => {
      if (seq === nfcCheck.current) {
        setNfc(state)
      }
    })
  }, [])
  useFocusEffect(recheckNfc)
  useEffect(() => {
    const subs = [
      AppState.addEventListener('change', state => {
        if (state === 'active') {
          recheckNfc()
        }
      }),
      // Only Android emits 'focus', when quick settings drawn over the app hand control back. iOS's
      // AppState refuses the event type, which a debug build raises as an error on every opening.
      ...(Platform.OS === 'android' ? [AppState.addEventListener('focus', recheckNfc)] : []),
    ]
    return () => {
      nfcCheck.current += 1
      subs.forEach(sub => sub.remove())
    }
  }, [recheckNfc])

  // Never touches the chosen asset or a prepared quote, so a re-read that lands after a tap only
  // moves the balance.
  const applyBalances = useCallback((info: SparkWalletInfo): SparkConvertAsset[] => {
    setBalanceSat(info.balanceSat)
    setTokenBalances(
      Object.fromEntries(info.tokens.map(token => [token.identifier, token.balanceBaseUnits])),
    )
    setBalanceSync(info.sync)
    const spendable = sparkConvertAssets(info.tokens.filter(token => token.balanceBaseUnits > 0))
    assetsRef.current = spendable
    setAssets(spendable)
    return spendable
  }, [])

  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useSyncRefresh(() => {
    sparkGetWalletInfo()
      .then(info => mounted.current && applyBalances(info))
      .catch(() => undefined)
  })

  useEffect(() => {
    let alive = true
    sparkGetWalletInfo()
      .then(info => {
        if (!alive) {
          return
        }
        const spendable = applyBalances(info)
        const wanted = route.params?.assetId
        if (wanted) {
          const preselected = spendable.find(item => iconIdOf(item) === wanted)
          // Past the first destination the choice is that destination's, and a late read changes nothing.
          if (preselected && !firstDestinationRead.current) {
            fromAssetScreen.current = preselected
            setAsset(preselected)
          }
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [route.params?.assetId, applyBalances])

  useEffect(() => {
    let alive = true
    ;(async () => {
      const currency = await resolveDisplayCurrency(i18n.language)
      const wanted = currency === 'USD' ? [currency] : [currency, 'USD']
      const rates = await sparkGetFiatRates(wanted).catch(() => ({} as Record<string, number>))
      if (!alive) {
        return
      }
      setUsdRate(rates.USD)
      if (rates[currency] !== undefined) {
        setFiatCurrency(currency)
        setFiatRate(rates[currency])
      }
    })()
    return () => {
      alive = false
    }
  }, [i18n.language])

  useEffect(() => {
    if (!sheetOpen) {
      return
    }
    let alive = true
    setSheetBalanceRead(false)
    setSheetModeOn(false)
    sparkGetWalletInfo()
      .then(info => {
        if (alive) {
          applyBalances(info)
          setSheetBalanceRead(true)
        }
      })
      .catch(() => undefined)
    if (dollarMode) {
      sparkGetStableBalance()
        .then(on => alive && setSheetModeOn(on))
        .catch(() => undefined)
    }
    return () => {
      alive = false
    }
  }, [sheetOpen, applyBalances, dollarMode])

  // The switch's screen is the way out of the refusal. Back from it with the mode off, the address is
  // still in the field and nothing prepares on its own, since the way back to bitcoin may still run.
  useEffect(() => {
    if (!dollarMode) {
      setNeedsBitcoinMode(false)
    }
  }, [dollarMode])

  // Contacts and Scan return to this same screen, so whatever the last destination left goes first. A
  // suggestion under the field comes through here too, so picking it is picking from Contacts.
  useEffect(() => {
    if (route.params?.destination) {
      setDestination(route.params.destination)
      setSheetOpen(false)
      resetDerived()
      setPickedContact(route.params.contactName ?? null)
      runPrepare.current(route.params.destination)
    }
  }, [route.params?.destination, route.params?.contactName, route.params?.picked, resetDerived])

  // Each of these has its own list or keypad, and the keyboard of a field still mounted would cover it.
  useEffect(() => {
    if (sheetOpen || pickingRoute || pickingAsset) {
      Keyboard.dismiss()
    }
  }, [sheetOpen, pickingRoute, pickingAsset])

  // Back during review returns to the destination step and stays on the screen. Intercepting the
  // removal keeps the system's own back button, which iOS 26 draws as a round glass control; a custom
  // headerLeft is wrapped in a wider capsule instead. It also covers the Android back key. Once a
  // result is shown the interception ends, so the success overlay can leave, and while a confirm is in
  // flight back does nothing, since the send is out and only its answer can end this review. A prepare
  // for a destination already read draws the review's shape, so back there is back from a review too.
  const onReview = quote !== null || (preparing && !fieldHeld && kind !== null)
  usePreventRemove(onReview && result === null, () => {
    if (!busy) {
      backToDestination()
    }
  })
  useLayoutEffect(() => {
    navigation.setOptions({ gestureEnabled: !onReview })
  }, [navigation, onReview])

  // What is typed is only half a destination most of the time, so nothing prepares until the SDK takes
  // it for one. Text with an @ asks the domain over the network, and the local rules spare that request
  // until the text can be an address. A bitcoin: URI asks nothing, whatever its query holds.
  async function classifyTyped(text: string, seq: number) {
    if (text.includes('@') && !isBitcoinUri(text) && !couldBeAddress(text)) {
      setRefusal('unrecognized')
      return
    }
    setClassifying(true)
    const typedKind = await sparkClassify(text)
    if (seq !== classifySeq.current) {
      return
    }
    if (typedKind === 'other' || typedKind === 'unread' || typedKind === 'wrongNetwork') {
      const why = await refusalOf(text, typedKind)
      if (seq === classifySeq.current) {
        setClassifying(false)
        setRefusal(why)
      }
      return
    }
    setClassifying(false)
    runPrepare.current(text, undefined, undefined, false, undefined, false, true)
  }

  function onChangeDestination(text: string) {
    setDestination(text)
    dropPrepare()
    resetDerived()
    cancelAutoPrepare()
    const trimmed = text.trim()
    if (trimmed.length > 0) {
      const seq = classifySeq.current
      autoTimer.current = setTimeout(() => classifyTyped(trimmed, seq), TYPING_PAUSE_MS)
    }
  }

  async function paste() {
    const text = (await Clipboard.getString()).trim()
    if (text.length === 0) {
      return
    }
    setDestination(text)
    resetDerived()
    runPrepare.current(text)
  }

  function payOnchainInstead() {
    onchainAsked.current = destination.trim()
    runPrepare.current(destination)
  }

  async function turnOnNfc() {
    setError(null)
    if (!(await openNfcSettings())) {
      setError(t('send.nfcSettingsFailed'))
    }
  }

  const nfcRead = useNfcRead(t('send.nfcPrompt'), {
    onAddress: dest => {
      setDestination(dest)
      resetDerived()
      runPrepare.current(dest)
    },
    onFailure: cause => {
      if (String(cause).toLowerCase().includes('cancel')) {
        return
      }
      const code = classifyWalletError(cause)
      setError(code === 'unknown' ? t('send.nfcFailed') : t(`errors.${code}`))
    },
  })

  function readNfc() {
    setError(null)
    nfcRead.read()
  }

  // Sats, or dollars of a USDB-funded send, which hold two places and are scaled to base units here.
  function confirmAmount(
    value: number | undefined,
    denom?: Denom,
    _mode?: unknown,
    comment?: string,
  ) {
    setSheetOpen(false)
    if (value === undefined || value <= 0) {
      setTypedAmount(null)
      return
    }
    if (sheetUsdb.current) {
      setTypedAmount({
        text: String(value),
        unit: sheetUnit.current,
        shown: formatFiat(value, 'USD'),
      })
      runPrepare.current(destination, toBaseUnits(String(value), USDB.decimals), comment, false, USDB.identifier)
      return
    }
    setTypedAmount({
      text: String(value),
      denom,
      currency: sheetFiat,
      unit: sheetUnit.current,
      shown: t('send.sats', { amount: formatSats(value) }),
    })
    runPrepare.current(destination, value, comment, false, typedToken)
  }

  // An LNURL's keypad needs the bounds and the handle its endpoint answers, so an endpoint not read
  // yet is read first, and the keypad opens once it answers.
  function openAmount() {
    if ((kind === 'lnurlPay' || kind === 'lightningAddress') && !lnurlRef.current) {
      runPrepare.current(destination)
      return
    }
    setSheetOpen(true)
  }

  // The sheet hands a token's base units exactly as typed, at every place the token holds.
  function confirmTokenAmount(base: bigint | undefined) {
    setSheetOpen(false)
    if (base === undefined || base <= 0n) {
      setTypedAmount(null)
      return
    }
    const text = formatBaseUnitsExact(base, sendAsset.decimals)
    setTypedAmount({
      text,
      unit: sheetUnit.current,
      shown: t('send.tokenFee', { amount: localizeAmount(text), ticker: sendAsset.ticker }),
    })
    runPrepare.current(destination, base, undefined, false, typedToken)
  }

  function chooseAsset(next: SparkConvertAsset) {
    setPickingAsset(false)
    if (next.id === asset.id) {
      return
    }
    setAsset(next)
    setQuote(null)
    setError(null)
    // The same digits are another value in another asset.
    setTypedAmount(null)
  }

  function pickOffer(next: SparkCrossChainQuote) {
    if (refreshing) {
      return
    }
    setQuoteUpdated(false)
    setError(null)
    markOffer(next, routes)
  }

  function chooseRoute(next: SparkCrossChainRoute) {
    setPickingRoute(false)
    dropOffers()
    routeRef.current = next
    setSelectedRoute(next)
    setQuote(null)
    setError(null)
    // Another network can fund the send from another source, where the digits mean another value.
    setTypedAmount(null)
  }

  const spentQuote = quote && spent?.handle === quote.value.handle ? spent : null
  // Try again stands only beside the doubt it answers, on the quote whose send it was.
  const heldQuote = spentQuote?.uncertain && held?.handle === spentQuote.handle ? held : null
  // Any other quote, or none, lets the held send go, as Back, Back to destination and a new destination
  // let a spent quote go.
  const shownHandle = quote?.value.handle
  useEffect(() => {
    if (held !== null && shownHandle !== held.handle) {
      setHeld(null)
    }
  }, [held, shownHandle])
  const heldHandle = held?.handle
  useEffect(() => {
    if (heldHandle === undefined) {
      return
    }
    return () => sparkDropHeldSend(heldHandle)
  }, [heldHandle])

  // Back and Back to destination keep what led to the review, the destination, what was read of it and
  // the amount typed, so changing one of them never means pasting and typing it all again (Breez's send
  // payment guide; Glow's back returns to the step the person saw). A prepare still out is dropped,
  // and its answer with it.
  function backToDestination() {
    if (spentQuote?.uncertain) {
      setDoubtLeft(true)
    }
    cancelAutoPrepare()
    dropPrepare()
    dropRefresh()
    dropOffers()
    setQuote(null)
    setError(null)
    setRetryable(null)
    setResult(null)
    setFeeMoved(false)
  }

  // Runs on the quote's own timer and on each return to the app, where that timer may have been lost.
  const checkQuote = useRef(() => {})
  checkQuote.current = () => {
    if (
      quote?.kind !== 'crossChain' ||
      busy ||
      result !== null ||
      refreshing ||
      quoteStale ||
      spentQuote ||
      AppState.currentState !== 'active' ||
      !quoteLapsed(quote.value.expiresAt, Date.now())
    ) {
      return
    }
    if (autoRefreshes.current >= MAX_AUTO_REFRESHES) {
      setQuoteStale(true)
      return
    }
    autoRefreshes.current += 1
    refreshQuote.current()
  }
  const liveExpiry = quote?.kind === 'crossChain' ? quote.value.expiresAt : null
  const liveHandle = quote?.value.handle
  useEffect(() => {
    const wait = liveExpiry === null ? null : quoteLapsesInMs(liveExpiry, Date.now())
    if (wait === null) {
      return
    }
    const timer = setTimeout(() => checkQuote.current(), wait)
    const sub = AppState.addEventListener('change', state => {
      if (state === 'active') {
        checkQuote.current()
      }
    })
    return () => {
      clearTimeout(timer)
      sub.remove()
    }
  }, [liveHandle, liveExpiry])
  useEffect(
    () => () => {
      refreshSeq.current += 1
    },
    [],
  )

  async function confirm() {
    if (!quote || busy || refreshing) {
      return
    }
    // The press is the one thing a lost timer cannot miss.
    if (quote.kind === 'crossChain' && quoteLapsed(quote.value.expiresAt, Date.now())) {
      refreshQuote.current()
      return
    }
    // Busy before the read, so a second press cannot pass while it is out.
    setBusy(true)
    const hold = await readExitHold()
    if (!mounted.current) {
      return
    }
    if (hold !== 'none') {
      setExitHold(hold)
      setBusy(false)
      return
    }
    const { handle } = quote.value
    dropOffers(handle)
    const overSpark = quote.kind === 'plain' && takesSparkRoute(quote.value, PREFER_SPARK_ROUTE)
    const leaving = sentFigures(quote)
    const converts = quote.value.conversion !== undefined
    setBusy(true)
    setError(null)
    setQuoteUpdated(false)
    setFeeMoved(false)
    setPressedRates({ dollar: reviewDollar, fiat: fiatRate })
    if (converts) {
      setSendStage('converting')
    }
    // A send that takes a key goes out under one drawn for this request alone, so that if it throws,
    // Try again can ask for it by that key and send this same request again under it.
    const key = quote.kind === 'plain' && sparkSendTakesKey(handle) ? mintSendKey() : undefined
    const speed = network === 'onchain' ? onchainSpeed : undefined
    try {
      const paid = lnurlPay
        ? await (key === undefined ? sparkConfirmLnurlPay(handle) : sparkConfirmLnurlPay(handle, key))
        : null
      const status =
        paid?.status ??
        (key !== undefined
          ? await sparkConfirmSendHeld(handle, key, speed, overSpark)
          : overSpark
          ? await sparkConfirmSend(handle, undefined, undefined, true)
          : await sparkConfirmSend(handle, speed))
      await settle(handle, status, paid?.successAction, leaving, converts, quote.kind === 'plain')
    } catch (cause) {
      const code = classifyWalletError(cause)
      // spark.ts holds every keyed send that throws, and only one kept here in doubt is ever dropped
      // by the screen, so any other is let go at once rather than held until a restart.
      const letGo = () => {
        if (key !== undefined) {
          sparkDropHeldSend(handle)
        }
      }
      // The provider checks a quote's age before its send starts, so this send never left, whatever the
      // device's clock made of it, and the quote is replaced rather than marked as in doubt. A send the
      // SDK funds with a conversion runs that first, so its token may already be sats, and the next
      // quote is priced from that balance.
      if (code === 'quoteExpired' && quote.kind === 'crossChain') {
        refreshQuote.current()
        return
      }
      // spark.ts refuses before the SDK is called, so nothing left, and the hold takes the screen as
      // the read at the press does.
      if (code === 'exitHeld' || code === 'exitHeldUnread') {
        letGo()
        setSpent({ handle, uncertain: false })
        setExitHold(code === 'exitHeld' ? 'exit' : 'unread')
        return
      }
      // The SDK prices the fee again just before it pays and refuses a higher one, so nothing left,
      // unless a conversion ahead of that step already ran (docs/breez-sdk-binding.md). The same
      // destination and amount are then priced again in place, and the review asks for a press of the
      // new fee, since nothing is signed at a fee the person has not seen (Breez's send payment guide;
      // BitBox use-payment-review.ts:264-275).
      if (code === 'feeIncreased' && !converts) {
        if (quote.kind === 'crossChain') {
          setFeeMoved(true)
          refreshQuote.current()
          return
        }
        const again = prepareAsked.current
        if (again) {
          letGo()
          feeMovedNext.current = true
          runPrepare.current(
            again.dest,
            again.amount,
            again.comment,
            again.spendAll,
            again.amountToken,
            again.dollarBalance,
          )
          return
        }
      }
      // A lapsed invoice is refused ahead of the conversion too, so that send never left. An invoice the
      // operators already hold a payment for keeps the doubt, since that payment may be this send's
      // own, which the SDK finishes on a later sync (isUsedInvoiceRefusal).
      const refused = code === 'feeIncreased' && !converts
      const uncertain = !refused && !isExpiredInvoiceRefusal(cause)
      setSpent({ handle, uncertain })
      if (uncertain && key !== undefined) {
        setHeld({ handle, key })
      } else {
        letGo()
      }
      setError(sendFailureLine(cause, code, converts))
    } finally {
      setSendStage(null)
      setPressedRates(null)
      setBusy(false)
    }
  }

  // The line for a send that threw, the same at a confirm and on Try again. An invoice already used is
  // named only on an invoice's send with no conversion ahead of it: a conversion's token leg answers
  // AlreadyExists too (spark/src/token/allowance/error.rs), about no invoice at all.
  function sendFailureLine(cause: unknown, code: ReturnType<typeof classifyWalletError>, converts: boolean) {
    if (kind === 'bolt11' && !converts && isUsedInvoiceRefusal(cause)) {
      return t('errors.invoiceUsed')
    }
    return code === 'unknown' ? t('send.failed') : t(walletErrorKey(code))
  }

  // What a send's answer shows, the same whether a confirm or Try again brought it.
  async function settle(
    handle: string,
    status: SparkSendStatus,
    successAction: Parameters<typeof payeeNote>[0],
    leaving: Omit<Sent, 'status'>,
    converts: boolean,
    plain: boolean,
  ) {
    // On-chain and cross-chain land minutes later, so waiting here would only delay "On the way".
    const followed = status === 'pending' && plain && network !== 'onchain'
    // The SDK answers a send only once its conversion has landed and the send has gone out, and it
    // holds back every event of the conversion's legs, so this answer is the one sign of the step.
    if (followed && converts) {
      setSendStage('sending')
    }
    const outcome = followed ? await sparkFollowSend(handle) : status
    setHeld(null)
    if (outcome === 'failed') {
      setSpent({ handle, uncertain: false })
      setError(t('send.failed'))
    } else {
      setNote(outcome === 'complete' ? payeeNote(successAction) : undefined)
      setResult({ ...leaving, status: outcome, rail: sparkSentRail(handle) })
    }
  }

  // Try again on a send in doubt. spark.ts reads the payment under the key first and sends the held
  // request again only when its storage holds no row for it. A read with no answer leaves the doubt and
  // Try again as they were, and an answer that comes after the quote was let go shows nothing.
  async function tryAgain() {
    const kept = heldQuote
    if (!kept || !quote || busy || refreshing || retrying.current) {
      return
    }
    retrying.current = true
    setBusy(true)
    const current = () => mounted.current && heldRef.current?.handle === kept.handle
    try {
      const hold = await readExitHold()
      if (!current()) {
        return
      }
      if (hold !== 'none') {
        setExitHold(hold)
        return
      }
      const leaving = sentFigures(quote)
      setPressedRates({ dollar: reviewDollar, fiat: fiatRate })
      const answer = await sparkRetryHeldSend(kept.handle, kept.key)
      if (!current() || 'read' in answer) {
        return
      }
      setError(null)
      await settle(kept.handle, answer.status, answer.successAction, leaving, false, quote.kind === 'plain')
    } catch (cause) {
      if (!current()) {
        return
      }
      const code = classifyWalletError(cause)
      if (code === 'exitHeld' || code === 'exitHeldUnread') {
        setExitHold(code === 'exitHeld' ? 'exit' : 'unread')
        return
      }
      // A retry turned away (a fee that moved, a lapsed invoice, an invoice that already has a payment,
      // which may be the first attempt's) says only that this attempt did not go. The first one's end is
      // still unknown, so the doubt and Try again stay.
      setError(sendFailureLine(cause, code, quote.value.conversion !== undefined))
    } finally {
      retrying.current = false
      setSendStage(null)
      setPressedRates(null)
      setBusy(false)
    }
  }

  // A cross-chain send is typed in what funds it, never in what arrives.
  const tokenAmountEntry = kind === 'sparkAddress' && sendTokenId !== undefined
  // The token the sheet is showing, which is the unit of whatever it hands back.
  const typedToken = tokenAmountEntry ? sendTokenId : undefined
  const canPickAsset =
    kind === 'sparkAddress' &&
    invoiceToken === undefined &&
    assets.some(item => item.id !== SPARK_BTC.id)
  const canPickRoute = kind === 'crossChainAddress' && routes.length > 0

  // Decided as the sheet opens: dollars on a dollar wallet whose rate is in. A rate landing later waits
  // for the next opening. A ref and not state, since the sheet reads its opening unit in the same pass.
  // A send funded with USDB is typed in dollars with no rate at all, and the source chosen here is the
  // unit of what the sheet hands back, whatever the mode does while it is open.
  const sheetDollars = useRef(false)
  const sheetUsdb = useRef(false)
  const sheetUnit = useRef(SATS_UNIT)
  const sheetWasOpen = useRef(false)
  // The unit the keypad would open in now. A marked offer, a route, an asset or the mode can move
  // it between two openings.
  const usdbSource =
    kind === 'crossChainAddress' &&
    selectedRoute !== null &&
    crossChainSource(selectedRoute, dollarMode) === 'usdb'
  const openingUnit = typedToken ?? (usdbSource ? USDB_DOLLARS_UNIT : SATS_UNIT)
  if (sheetOpen && !sheetWasOpen.current) {
    sheetUsdb.current = usdbSource
    sheetDollars.current = dollarMode && usdRate !== undefined && !tokenAmountEntry && !sheetUsdb.current
    sheetUnit.current = openingUnit
  }
  sheetWasOpen.current = sheetOpen
  const sheetFiat: FiatCurrency = sheetDollars.current ? 'USD' : fiatCurrency
  // The amount typed last, only while the keypad would take it back in the unit it was typed in.
  const keptUnit = sheetOpen ? sheetUnit.current : openingUnit
  const keptAmount = typedAmount !== null && typedAmount.unit === keptUnit ? typedAmount : null

  // The least an output to this address can be, which the SDK checks only as it sends (Breez's send UX
  // guide).
  const dustMin = isOnchainKind(kind) ? dustLimitSat(resolvedDest || destination.trim()) : undefined

  // Bounds a quote would be refused for, so the keypad can say so before asking for one.
  const amountBounds = lnurlPay
    ? { min: lnurlPay.minSat, max: lnurlPay.maxSat }
    : kind === 'crossChainAddress' && selectedRoute
    ? sheetUsdb.current
      ? { min: selectedRoute.usdbMin, max: selectedRoute.usdbMax }
      : crossChainBoundsSat(selectedRoute, usdRate)
    : dustMin !== undefined
    ? { min: dustMin }
    : {}

  // In the sheet's unit, which for a token is the token itself. Only a figure read for this sheet from
  // a synced connection counts, and the dollar wallet spends a token the sheet cannot price yet.
  const tokenBalance = sendTokenId === undefined ? undefined : tokenBalances[sendTokenId]
  const trustedBalance =
    sheetBalanceRead && balanceSync === 'synced' && !dollarMode
      ? tokenAmountEntry
        ? tokenBalance !== undefined && Number.isSafeInteger(tokenBalance)
          ? tokenBalance
          : undefined
        : balanceSat
      : undefined
  const sheetAvailable = tokenAmountEntry ? undefined : trustedBalance
  // Cutting a balance down to a limit and calling it everything would be false, and a cross-chain send
  // prices its leg in a way fees-included cannot follow.
  const canUseAll =
    trustedBalance !== undefined &&
    trustedBalance > 0 &&
    kind !== 'crossChainAddress' &&
    (lnurlPay === null || (trustedBalance >= lnurlPay.minSat && trustedBalance <= lnurlPay.maxSat))

  // A dollar wallet's whole balance goes out as a sale of its USDB, on the destinations that path
  // covers with no guard in the way. A figure not synced never becomes an order to spend everything.
  const usdbHeld = tokenBalances[USDB.identifier]
  const synced = sheetBalanceRead && balanceSync === 'synced'
  const canUseAllDollars =
    synced &&
    sheetModeOn &&
    usdbHeld !== undefined &&
    usdbHeld > 0 &&
    Number.isSafeInteger(usdbHeld) &&
    (kind === 'bolt11' || kind === 'lnurlPay' || kind === 'lightningAddress')
  // Text and no lock: how much USDB a send takes depends on the pool, so the review weighs it.
  const usdbHeldDollars = (usdbHeld ?? 0) / 10 ** USDB.decimals
  const dollarAvailable = !synced
    ? undefined
    : sheetUsdb.current
    ? t('send.approxFiat', { amount: formatSmallFiat(usdbHeldDollars, 'USD') })
    : dollarMode && usdRate !== undefined && !tokenAmountEntry
    ? t('send.approxFiat', {
        // A balance is a ceiling, so it is cut rather than rounded: US$ 1.235 reads 1.23, never 1.24.
        amount: formatSmallFiat(usdbHeldDollars + satsToFiat(balanceSat, usdRate), 'USD'),
      })
    : undefined

  function spendDollarBalance(comment?: string) {
    if (spendingAll.current) {
      return
    }
    spendingAll.current = true
    setSheetOpen(false)
    // All of it is no figure to type again, and the balance typed back would add the fee on top.
    setTypedAmount(null)
    runPrepare.current(destination, usdbHeld, comment, true, undefined, true).finally(() => {
      spendingAll.current = false
    })
  }

  // Goes straight to base units: through the sheet's unit a token's balance would be rounded.
  function spendEverything(comment?: string) {
    if (spendingAll.current || trustedBalance === undefined) {
      return
    }
    spendingAll.current = true
    setSheetOpen(false)
    setTypedAmount(null)
    runPrepare.current(destination, trustedBalance, comment, true, typedToken).finally(() => {
      spendingAll.current = false
    })
  }

  const shownFiatRate = pressedRates ? pressedRates.fiat : fiatRate
  const fiatOf = (sat: number): string | null =>
    shownFiatRate !== null
      ? t('send.approxFiat', { amount: formatFiat(satsToFiat(sat, shownFiatRate), fiatCurrency) })
      : null

  // The token the quote itself spends names the asset drawn, never the screen's choice, so the review
  // and the send cannot disagree. Null keeps Confirm off, since no unit can be said for the figures.
  const quotedAsset = quote?.kind === 'plain' ? assetOfToken(quote.value.tokenIdentifier, assets) : null
  const unnamed = quote?.kind === 'plain' && quotedAsset === null

  const liveDollar: DollarReview | undefined =
    dollarMode && usdRate !== undefined ? { rate: usdRate } : undefined
  const reviewDollar = pressedRates ? pressedRates.dollar : liveDollar

  function sentFigures(sending: Quote): Omit<Sent, 'status'> {
    if (sending.kind === 'crossChain') {
      const q = sending.value
      if (q.source === 'usdb') {
        return { crossChain: true, amount: q.amountIn, asset: assetOfToken(USDB.identifier, assets) ?? undefined }
      }
      return {
        crossChain: true,
        amount: q.amountIn,
        fiat: fiatFigure(q.amountIn),
        dollars: dollarsOfSats(q.amountIn, liveDollar?.rate) ?? undefined,
      }
    }
    // With fees included `amount` is what left, and the overlay says what arrived.
    const amount = sendReceives(sending.value, onchainSpeed) ?? sending.value.amount
    return quotedAsset && quotedAsset.id !== SPARK_BTC.id
      ? { crossChain: false, amount, asset: quotedAsset }
      : {
          crossChain: false,
          amount,
          fiat: fiatFigure(amount),
          dollars: dollarsOfSats(amount, liveDollar?.rate) ?? undefined,
        }
  }

  function fiatFigure(sat: number): string | undefined {
    return fiatRate !== null ? formatFiat(satsToFiat(sat, fiatRate), fiatCurrency) : undefined
  }

  // A cross-chain address falls into the lightning branch harmlessly, since the label reaches only PlainReview.
  const network: 'lightning' | 'onchain' | 'spark' =
    isOnchainKind(kind) ? 'onchain' : kind === 'sparkAddress' ? 'spark' : 'lightning'
  // The SDK exposes no per-tier ETA, so these are the usual mempool estimates.
  const etaLabel = t(
    network !== 'onchain'
      ? 'send.etaInstant'
      : onchainSpeed === 'fast'
      ? 'send.etaFast'
      : onchainSpeed === 'slow'
      ? 'send.etaSlow'
      : 'send.etaMedium',
  )
  const addressLike = isOnchainKind(kind) || kind === 'sparkAddress' || kind === 'crossChainAddress'

  // An embedded amount skips the sheet's balance check, so the review guards it in each rail's own unit.
  // A balance read before the first sync claims nothing, and the SDK's own refusal stands.
  const insufficient = (() => {
    if (balanceSync !== 'synced') {
      return false
    }
    if (quote?.kind === 'crossChain') {
      const q = quote.value
      if (q.source === 'usdb') {
        return q.amountIn > (tokenBalances[USDB.identifier] ?? 0)
      }
      return q.conversion
        ? q.conversion.amountIn > (tokenBalances[q.conversion.tokenIdentifier] ?? 0)
        : q.amountIn + q.feeSat > balanceSat
    }
    if (quote?.kind !== 'plain') {
      return false
    }
    const q = quote.value
    const spends = sendTotal(q, onchainSpeed)
    // With the dollar wallet on the SDK injects a conversion leg, so what leaves is token base units.
    // The SDK covers a conversion with amountIn alone, and adding the fee would refuse what it
    // accepts.
    if (q.conversion) {
      return q.conversion.amountIn > (tokenBalances[q.conversion.tokenIdentifier] ?? 0)
    }
    return spends > (q.tokenIdentifier === undefined ? balanceSat : tokenBalances[q.tokenIdentifier] ?? 0)
  })()
  const nothingLeft =
    quote?.kind === 'plain' && nothingArrives(quote.value, onchainSpeed, resolvedDest || destination.trim())
  // An amount the destination named, or one typed before this, can still be under the dust limit, and
  // the SDK would refuse it only at the press, read as a send in doubt.
  const belowDust =
    quote?.kind === 'plain' &&
    dustMin !== undefined &&
    !nothingLeft &&
    (sendReceives(quote.value, onchainSpeed) ?? quote.value.amount) < dustMin

  // A destination typed by hand counts as the contact it matches, and the address drawn is what pays.
  const knownContact = contacts.find(item => contactKey(item.address) === contactKey(destination))
  const contactName = pickedContact ?? knownContact?.name
  // Who an LNURL pays as the SDK read it, the lightning address it came from or its service's domain,
  // and the service's own words only when it names neither (Breez's UX guide).
  const lnurlName = lnurlPay ? lnurlPay.payee.trim() || lnurlPay.description : undefined
  // A bare lnurl1 string names nobody, so the review leads with who it pays and folds the string away.
  // A lightning address already reads as who it pays.
  const folded = kind === 'lnurlPay'
  const payHeading =
    contactName !== undefined
      ? t('send.payTo', { name: contactName })
      : folded && lnurlName
      ? t('send.payAddress', { name: lnurlName })
      : undefined
  // The keypad names whoever the review will, a lightning address included.
  const sheetTitle =
    payHeading ?? (lnurlName && kind === 'lightningAddress' ? t('send.payAddress', { name: lnurlName }) : undefined)

  if (contactOffer !== null) {
    return (
      <Screen>
        <SaveContactSheet address={contactOffer} onDone={() => navigation.goBack()} />
      </Screen>
    )
  }

  // A pending send may still fail, and an address the wallet could not check the list for may already
  // be a contact, since the SDK takes a repeated one without complaint.
  const offersContact = (sent: Sent) =>
    sent.status === 'complete' &&
    kind === 'lightningAddress' &&
    contactsAnswered &&
    knownContact === undefined

  if (result) {
    const token = result.asset
    // Only the SDK's `complete` says "sent". A cross-chain send lands minutes later on the other chain,
    // so its `complete` covers only the Spark side and it is never "sent" on confirm.
    const sent = !result.crossChain && result.status === 'complete'
    // A cross-chain send's record names the Spark leg to the provider, not the chain it lands on, so
    // it names no rail. A token the app does not know goes unnamed, with a line saying so.
    const rail = result.crossChain ? undefined : result.rail
    const ticker = token ? tokenUnit(token.id) : null
    return (
      <ReceivedOverlay
        visible
        amount={
          result.dollars !== undefined
            ? {
                value: result.dollars,
                unit: '',
                format: (n: number) => t('send.approxFiat', { amount: formatFiat(n, 'USD') }),
              }
            : token
            ? {
                value: Number(fromBaseUnits(result.amount, token.decimals)),
                unit: ticker ?? '',
                // Two places, like every other token figure in the app. A whole-number default would
                // draw a send of 0.25 USDB as "0 USDB".
                format: (n: number) => localizeAmount(fromBaseUnits(Math.round(n * 100), 2)),
              }
            : {
                value: result.amount,
                unit: t('common.sats'),
                format: formatSats,
              }
        }
        label={noticeTitle(sent ? 'sent' : 'onTheWay', rail, t)}
        // A pending send is followed to its end by the wallet's record, which tells it in the app
        // (sendNotice.ts). That end is the Spark side alone for a cross-chain send, whose delivery
        // only History follows.
        pending={sent ? undefined : t(result.crossChain ? 'send.pendingDelivery' : 'send.pendingTold')}
        note={note}
        fiat={result.dollars === undefined ? result.fiat : undefined}
        beneath={
          result.dollars !== undefined
            ? t('send.sats', { amount: formatSats(result.amount) })
            : token && ticker === null
            ? t('notice.unknownToken')
            : undefined
        }
        onDone={() =>
          offersContact(result) ? setContactOffer(destination.trim()) : navigation.goBack()
        }
      />
    )
  }

  // A line per token, named by its first route, with the contract when it is what sets two lines
  // apart. Who delivers is said on the review.
  const routeGroups = groupRoutes(routes)
  const routeItems: PickerItem[] = routeGroups.map(group => ({
    assetId: group.routes[0].id,
    iconId: coinIconId(group.asset),
    ticker: group.asset,
    name: chainDisplayName(group.chain),
    subtitle: contractNote(group, routeGroups),
  }))
  const markedGroup = routeGroups.find(group => group.routes.some(item => item.id === selectedRoute?.id))
  // Bitcoin is titled by name, as its card is, since its ticker here is the unit.
  const assetItems: PickerItem[] = assets.map(item =>
    item.id === SPARK_BTC.id
      ? { assetId: iconIdOf(item), ticker: item.name, name: '' }
      : { assetId: iconIdOf(item), ticker: item.ticker, name: item.name },
  )

  // The review's action is the screen's footer, never the review's last row: the footer stays in view
  // and carries the bottom inset, while the end of the scroll is below the fold on a short screen and
  // under the gesture bar of an edge-to-edge Android window.
  const suggestions = pickedContact === null && !quote ? matchContacts(contacts, destination) : []
  const refusalText = refusal === null || suggestions.length > 0 ? null : t(REFUSAL_KEY[refusal])
  const holdLine =
    exitHold === 'none' ? null : t(exitHold === 'exit' ? 'emergencyExit.sendHeld' : 'emergencyExit.sendHeldUnread')
  const openExit = () => navigation.navigate('EmergencyExit', { selection: 'all' })
  const fieldShown = !quote && (!preparing || fieldHeld) && holdLine === null

  const reviewAction =
    quote && !preparing ? (
      <View style={styles.footer}>
        <ErrorBox
          message={
            holdLine ??
            error ??
            (insufficient
              ? t('errors.insufficientFunds')
              : nothingLeft
              ? t('send.nothingArrives')
              : belowDust
              ? t('receive.belowMin', {
                  min: t('receive.limitSats', { count: dustMin, amount: formatSats(dustMin ?? 0) }),
                })
              : unnamed && balanceSync === 'stale'
              ? t('home.notUpdated')
              : null)
          }
          style={styles.error}
        />
        {(spentQuote?.uncertain || doubtLeft) && (
          <Txt role="caption" tone="muted" style={styles.error}>
            {t('send.checkHistory')}
          </Txt>
        )}
        {(feeMoved || quoteUpdated || quoteStale) && (
          <Txt role="caption" tone="muted" style={styles.error}>
            {t(quoteStale ? 'send.quoteStale' : feeMoved ? 'send.feeMovedReview' : 'send.quoteUpdated')}
          </Txt>
        )}
        {assetMoved !== null && (
          <Txt role="caption" tone="muted" style={styles.error}>
            {t('send.assetMoved', { ticker: assetMoved })}
          </Txt>
        )}
        {/* A step of a money operation named beside its spinner, not a loading placeholder. */}
        {sendStage !== null && (
          <Txt role="caption" tone="muted" style={styles.error}>
            {t(sendStage === 'converting' ? 'send.stageConverting' : 'send.stageSending')}
          </Txt>
        )}
        {holdLine !== null ? (
          <GradientButton label={t('emergencyExit.sendHeldOpen')} onPress={openExit} />
        ) : heldQuote ? (
          <>
            <GradientButton label={t('common.retry')} onPress={tryAgain} loading={busy} />
            <View style={styles.secondAction}>
              <GradientButton
                label={t('send.backToDestination')}
                variant="secondary"
                onPress={backToDestination}
                disabled={busy}
              />
            </View>
          </>
        ) : spentQuote ? (
          <GradientButton label={t('send.backToDestination')} onPress={backToDestination} />
        ) : quoteStale ? (
          <GradientButton label={t('send.refreshQuote')} onPress={() => refreshQuote.current()} />
        ) : (
          <GradientButton
            label={t('send.confirm')}
            onPress={confirm}
            loading={busy}
            disabled={insufficient || nothingLeft || belowDust || refreshing || unnamed}
          />
        )}
      </View>
    ) : undefined

  return (
    // `keyboard` so that a tap on the field's clear button acts with the keyboard up, rather than only
    // closing the keyboard and leaving the text to be added to.
    <Screen scroll keyboard layout="padded" footer={reviewAction}>
      {fieldShown && (
        <>
          <Txt role="label" tone="muted" style={styles.label}>
            {t('send.destination')}
          </Txt>
          {pickedContact !== null ? (
            <View style={styles.contactChip}>
              <View style={styles.contactChipText}>
                <Txt role="bodyStrong" lines={1}>
                  {pickedContact}
                </Txt>
                <Txt role="caption" tone="muted" lines={1} style={styles.contactChipAddress}>
                  {destination}
                </Txt>
              </View>
              <Touch onPress={clear} feedback="link" size={18} hitSlop={space.lg} label={t('send.clear')}>
                <TabIcon name="close" color={colors.textSecondary} size={18} />
              </Touch>
            </View>
          ) : (
            <Field
              value={destination}
              onChangeText={onChangeDestination}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
              placeholder={t('send.destinationPlaceholder')}
              accessibilityLabel={t('send.destination')}
              progress={classifying || preparing}
              trailing={
                destination.trim().length > 0 ? (
                  <Touch
                    onPress={clear}
                    feedback="link"
                    // Declares its drawn size, because taking the floor here does damage rather than
                    // good. It sits over a 96pt input, so a 44 by 44 box from the top of the field
                    // would cover its second line, and tapping there to place the cursor would wipe a
                    // pasted address.
                    //
                    // 18 plus 16 of slop on each side is 50, over the floor.
                    size={18}
                    hitSlop={space.lg}
                    label={t('send.clear')}>
                    <TabIcon name="close" color={colors.textSecondary} size={18} />
                  </Touch>
                ) : undefined
              }
            />
          )}

          <Row gap="sm" style={styles.actions}>
            <Touch onPress={paste} feedback="surface" style={styles.chip}>
              <TabIcon name="paste" color={colors.text} size={18} />
              <Txt role="label" lines={1} adjustsFontSizeToFit style={styles.chipLabel}>
                {t('send.paste')}
              </Txt>
            </Touch>
            <Touch onPress={() => navigation.navigate('Scan')} feedback="surface" style={styles.chip}>
              <TabIcon name="scan" color={colors.text} size={18} />
              <Txt role="label" lines={1} adjustsFontSizeToFit style={styles.chipLabel}>
                {t('send.scan')}
              </Txt>
            </Touch>
            <Touch
              onPress={() => navigation.navigate('Contacts', { pick: true })}
              feedback="surface"
              style={styles.chip}>
              <TabIcon name="contacts" color={colors.text} size={18} />
              <Txt role="label" lines={1} adjustsFontSizeToFit style={styles.chipLabel}>
                {t('send.contacts')}
              </Txt>
            </Touch>
          </Row>
          {/* Its own row, because a fourth flex chip leaves each label about 72dp on a 360dp phone
              and the longer translations spill past the border. */}
          {nfc !== 'unsupported' && (
            <Touch
              onPress={nfc === 'on' ? readNfc : turnOnNfc}
              feedback="surface"
              style={[styles.chip, styles.nfcChip]}>
              <TabIcon name="nfc" color={colors.text} size={18} />
              <Txt role="label" lines={1} adjustsFontSizeToFit style={styles.chipLabel}>
                {nfc === 'on' ? t('send.nfc') : t('send.nfcOff')}
              </Txt>
            </Touch>
          )}

          {/* Under the buttons, so a match that appears while typing never moves them. */}
          {suggestions.length > 0 && (
            <View style={styles.suggestions}>
              {suggestions.map(item => (
                <Touch
                  key={item.id}
                  onPress={() =>
                    navigation.setParams({
                      destination: item.address,
                      contactName: item.name,
                      picked: Date.now(),
                    })
                  }
                  feedback="row"
                  style={styles.suggestion}>
                  <Txt role="bodyStrong" lines={1}>
                    {item.name}
                  </Txt>
                  <Txt role="caption" tone="muted" lines={1}>
                    {item.address}
                  </Txt>
                </Touch>
              ))}
            </View>
          )}

          {(canPickAsset || canPickRoute || takesAmount) && (
            <View style={styles.choices}>
              {canPickAsset && (
                <ChoiceRow
                  label={t('send.asset')}
                  value={isBtcAsset ? t('send.assetBitcoin') : asset.ticker}
                  iconId={iconIdOf(asset)}
                  ticker={asset.ticker}
                  accessibilityLabel={t('send.chooseAsset')}
                  onPress={() => setPickingAsset(true)}
                />
              )}
              {canPickRoute && (
                <ChoiceRow
                  label={t('send.route')}
                  value={
                    selectedRoute
                      ? t('send.routeValue', {
                          asset: selectedRoute.asset,
                          chain: chainDisplayName(selectedRoute.chain),
                        })
                      : t('send.chooseRoute')
                  }
                  iconId={selectedRoute ? coinIconId(selectedRoute.asset) : undefined}
                  ticker={selectedRoute?.asset}
                  accessibilityLabel={t('send.chooseRoute')}
                  onPress={() => setPickingRoute(true)}
                />
              )}
              {keptAmount !== null ? (
                <ChoiceRow
                  label={t('send.amountLabel')}
                  value={keptAmount.shown}
                  accessibilityLabel={t('send.changeAmount')}
                  onPress={openAmount}
                />
              ) : (
                <Touch
                  onPress={openAmount}
                  disabled={canPickRoute && !selectedRoute}
                  feedback="link"
                  hitSlop={space.sm}
                  style={styles.addAmount}>
                  <TabIcon name="plus" color={accent} size={18} />
                  <Txt role="bodyBold" tone="accent">
                    {tokenAmountEntry
                      ? t('send.amountToken', { ticker: sendAsset.ticker })
                      : t('send.addAmount')}
                  </Txt>
                </Touch>
              )}
            </View>
          )}
          {/* A destination that names its own amount, back from its review or after a read that
              failed, goes to it again. So does an invoice whose amount only its pricing tells,
              which opens the keypad when it names none. */}
          {!preparing &&
            kind !== null &&
            !takesAmount &&
            !invoiceRanOut &&
            refusal === null &&
            retryable === null && (
              <Touch
                onPress={() => runPrepare.current(destination)}
                feedback="link"
                hitSlop={space.sm}
                style={styles.addAmount}>
                <Txt role="bodyBold" tone="accent">
                  {t('send.review')}
                </Txt>
                <TabIcon name="chevron" color={accent} size={16} />
              </Touch>
            )}
        </>
      )}

      {!quote && (
        <ErrorBox
          message={
            holdLine ??
            error ??
            refusalText ??
            (invoiceRanOut ? t('send.invoiceRanOut') : null) ??
            (needsBitcoinMode ? t('send.onchainNeedsBitcoinMode') : null)
          }
          style={styles.errorStandalone}
        />
      )}
      {!quote && assetMoved !== null && holdLine === null && (
        <Txt role="caption" tone="muted" style={styles.errorStandalone}>
          {t('send.assetMoved', { ticker: assetMoved })}
        </Txt>
      )}
      {!quote && doubtLeft && holdLine === null && (
        <Txt role="caption" tone="muted" style={styles.errorStandalone}>
          {t('send.checkHistory')}
        </Txt>
      )}
      {!quote && holdLine !== null && (
        <Touch onPress={openExit} feedback="link" hitSlop={space.sm} style={styles.addAmount}>
          <Txt role="bodyBold" tone="accent">
            {t('emergencyExit.sendHeldOpen')}
          </Txt>
          <TabIcon name="chevron" color={accent} size={16} />
        </Touch>
      )}
      {!quote && !preparing && holdLine === null && error === null && invoiceRanOut && (
        <Touch onPress={payOnchainInstead} feedback="link" hitSlop={space.sm} style={styles.addAmount}>
          <Txt role="bodyBold" tone="accent">
            {t('send.payOnchainInstead')}
          </Txt>
          <TabIcon name="chevron" color={accent} size={16} />
        </Touch>
      )}
      {!quote && holdLine === null && needsBitcoinMode && (
        <Touch
          onPress={() => navigation.navigate('StableBalance')}
          feedback="link"
          hitSlop={space.sm}
          style={styles.addAmount}>
          <Txt role="bodyBold" tone="accent">
            {t('send.openDollarWallet')}
          </Txt>
          <TabIcon name="chevron" color={accent} size={16} />
        </Touch>
      )}
      {!quote && !preparing && holdLine === null && retryable && (
        <GradientButton
          label={t('common.retry')}
          variant="secondary"
          onPress={() =>
            runPrepare.current(
              retryable.dest,
              retryable.amount,
              retryable.comment,
              retryable.spendAll,
              retryable.amountToken,
              retryable.dollarBalance,
            )
          }
        />
      )}

      {(preparing && !fieldHeld) || unnamed ? (
        // The review's shape, its figure and then the destination card, so nothing jumps when the
        // quote answers.
        <View style={styles.reviewStack}>
          <View style={styles.hero}>
            <Skeleton width="30%" height={font.leading.sm} />
            <Skeleton width="55%" height={font.leading.display} style={styles.heroAmount} />
          </View>
          <View>
            <Skeleton width="20%" height={font.leading.sm} style={styles.sectionCap} />
            <Skeleton height={font.leading.base + space.lg * 2} borderRadius={radius.lg} />
          </View>
        </View>
      ) : (
        quote && (
          <View style={styles.reviewStack}>
            {quote.kind === 'plain' ? (
              quotedAsset && (
                <PlainReview
                  quote={quote.value}
                  asset={quotedAsset}
                  destination={resolvedDest || destination.trim()}
                  heading={payHeading}
                  folded={folded}
                  addressLike={addressLike}
                  etaLabel={etaLabel}
                  railLabel={t(kind === 'silentPaymentAddress' ? 'send.netSilentPayment' : 'send.netOnchain')}
                  instant={network !== 'onchain'}
                  onchainSpeed={onchainSpeed}
                  onSpeedChange={setOnchainSpeed}
                  fiatOf={fiatOf}
                  balanceSat={balanceSat}
                  balanceSync={balanceSync}
                  spendableAssets={assets}
                  tokenBalances={tokenBalances}
                  dollar={quote.value.tokenIdentifier === undefined ? reviewDollar : undefined}
                  usdRate={usdRate}
                />
              )
            ) : (
              <CrossChainReview
                quote={quote.value}
                refreshing={refreshing}
                destination={resolvedDest || destination.trim()}
                fiatOf={fiatOf}
                balanceSat={balanceSat}
                balanceSync={balanceSync}
                spendableAssets={assets}
                tokenBalances={tokenBalances}
                dollar={reviewDollar}
                usdRate={usdRate}
                offers={offers}
                onPickOffer={pickOffer}
              />
            )}
          </View>
        )
      )}

      {/* Sats for Bitcoin, the token's own unit for a token send, and dollars for a USDB source. */}
      <NfcReadSheet phase={nfcRead.phase} onCancel={nfcRead.cancel} />

      <AmountSheet
        visible={sheetOpen}
        unit={tokenAmountEntry ? sendAsset.ticker : sheetUsdb.current ? USDB.ticker : 'sats'}
        dollars={sheetUsdb.current}
        allowDecimal={sheetUsdb.current || (tokenAmountEntry && sendAsset.decimals > 0)}
        maxDecimals={sheetUsdb.current ? DOLLAR_PLACES : undefined}
        availableNote={dollarAvailable}
        onUseAll={canUseAll ? spendEverything : canUseAllDollars ? spendDollarBalance : undefined}
        commentMax={lnurlPay?.commentAllowed}
        title={sheetTitle}
        satsBtcToggle={!tokenAmountEntry && !sheetUsdb.current}
        fiatRate={
          tokenAmountEntry || sheetUsdb.current
            ? undefined
            : sheetDollars.current
            ? usdRate
            : fiatRate ?? undefined
        }
        fiatCurrency={sheetFiat}
        initialDenom={
          keptAmount
            ? // Sats typed in one money open in sats where the toggle now holds another.
              keptAmount.denom === 'fiat' && keptAmount.currency !== sheetFiat
              ? 'sats'
              : keptAmount.denom
            : sheetDollars.current
            ? 'fiat'
            : undefined
        }
        initial={keptAmount?.text ?? ''}
        parse={tokenAmountEntry || sheetUsdb.current ? parseConvertAmount : parseAmountSat}
        // A token is weighed and handed on in its base units, its balance included.
        {...(tokenAmountEntry
          ? {
              tokenBounds: {
                decimals: sendAsset.decimals,
                available: trustedBalance === undefined ? undefined : BigInt(trustedBalance),
              },
              onConfirm: confirmTokenAmount,
            }
          : {
              min: amountBounds.min,
              max: amountBounds.max,
              available: sheetAvailable,
              onConfirm: confirmAmount,
            })}
        onClose={() => setSheetOpen(false)}
      />

      <AssetPickerSheet
        visible={pickingAsset}
        title={t('send.chooseAsset')}
        items={assetItems}
        // The asset the send signs with, keyed as the items are.
        selectedId={iconIdOf(sendAsset)}
        onSelect={id => {
          // Items are keyed by the display id (iconIdOf), so map back through the same function.
          const next = assets.find(item => iconIdOf(item) === id)
          if (next) {
            chooseAsset(next)
          } else {
            setPickingAsset(false)
          }
        }}
        onClose={() => setPickingAsset(false)}
      />

      <AssetPickerSheet
        visible={pickingRoute}
        title={t('send.chooseRoute')}
        items={routeItems}
        selectedId={markedGroup?.routes[0].id ?? null}
        onSelect={id => {
          const next = routes.find(item => item.id === id)
          if (next) {
            chooseRoute(next)
          } else {
            setPickingRoute(false)
          }
        }}
        onClose={() => setPickingRoute(false)}
      />
    </Screen>
  )
}

function ChoiceRow({
  label,
  value,
  iconId,
  ticker,
  accessibilityLabel,
  onPress,
}: {
  label: string
  value: string
  iconId?: string
  ticker?: string
  accessibilityLabel: string
  onPress: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  // The label replaces what the row draws, so it carries the choice before the action, as Receive's
  // picker row does. A row with nothing chosen yet shows the action as its value, said once.
  const spoken = value === accessibilityLabel ? value : joinLabels(t, [value, accessibilityLabel])
  return (
    <Touch onPress={onPress} feedback="link" label={spoken} style={receiveStyles.pickerRow}>
      <Txt role="caption" tone="muted">
        {label}
      </Txt>
      <Row gap="sm">
        {iconId && ticker && <AssetIcon assetId={iconId} ticker={ticker} size={20} />}
        <Txt role="bodyBold">{value}</Txt>
        <TabIcon name="chevron" color={colors.textSecondary} size={16} />
      </Row>
    </Touch>
  )
}

function PlainReview({
  quote,
  asset,
  destination,
  heading,
  folded,
  addressLike,
  etaLabel,
  railLabel,
  instant,
  onchainSpeed,
  onSpeedChange,
  fiatOf,
  balanceSat,
  balanceSync,
  spendableAssets,
  tokenBalances,
  dollar,
  usdRate,
}: {
  quote: SparkSendQuote
  asset: SparkConvertAsset
  destination: string
  // Who is paid, a contact's name or what the SDK read of an LNURL. It sits over the address, which is
  // what pays.
  heading?: string
  // The destination names nobody, so it waits in a fold under the memo.
  folded: boolean
  addressLike: boolean
  etaLabel: string
  railLabel: string
  instant: boolean
  onchainSpeed: OnchainSpeed
  onSpeedChange: (speed: OnchainSpeed) => void
  fiatOf: (sat: number) => string | null
  balanceSat: number
  balanceSync: BalanceSync
  spendableAssets: SparkConvertAsset[]
  tokenBalances: Record<string, number>
  // Set on a dollar wallet with a rate, and then the review reads in dollars, with sats a tap away.
  dollar?: DollarReview
  usdRate?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const [unitChoice, setUnitChoice] = useState<'dollars' | 'sats'>('dollars')
  const dollars = dollar !== undefined && unitChoice === 'dollars' ? dollar : undefined
  // A reading of sats, so it says so, and under a cent the sats say more than a zero would.
  const satsFigure = (sat: number): string => {
    const value = dollarsOfSats(sat, dollars?.rate)
    return value === null
      ? t('send.sats', { amount: formatSats(sat) })
      : t('send.approxFiat', { amount: formatFiat(value, 'USD') })
  }
  const heroDollars = dollarsOfSats(quote.amount, dollars?.rate)
  const token = quote.tokenIdentifier !== undefined
  const conversion = quote.conversion
  // The fallback is keyed on the identifier being USDB's, not on the lookup having missed. Keyed on
  // the miss, it would answer "not found" with USDB's decimals and ticker, which is right only while
  // USDB is the only token anyone can convert. A person can add an arbitrary token from
  // the asset screen, and both lines this governs show money: what leaves the wallet, and the token
  // balance. Wrong scale and wrong name together is the complete pair.
  //
  // It follows the same discipline as ConvertSpark's fiat line, which returns null rather than
  // guessing, and puts a check in place of an inference.
  const conversionAsset =
    (conversion && spendableAssets.find(a => a.id === conversion.tokenIdentifier)) ??
    (conversion?.tokenIdentifier === USDB.identifier
      ? ({
          id: USDB.identifier,
          ticker: USDB.ticker,
          name: USDB.name,
          decimals: USDB.decimals,
          fiatId: USDB.fiatId,
        } as SparkConvertAsset)
      : null)
  const conversionBalance = conversion ? tokenBalances[conversion.tokenIdentifier] ?? 0 : 0
  const shown = quote.amount
  const onchainTier = quote.onchainFees?.[onchainSpeed]
  const fees = onchainTier ? onchainTier.totalSat : quote.fee
  const total = sendTotal(quote, onchainSpeed)
  const receives = sendReceives(quote, onchainSpeed)
  // A token's figures that follow from the amount are drawn from the SDK's exact one when it gave
  // it, since a double drops digits past about 15. Its fee is small enough to add as a number.
  const exactBase = token ? quote.amountBase : undefined
  const tokenFigure = (base: number, exact: bigint | undefined) =>
    localizeAmount(
      exact === undefined
        ? fromBaseUnits(base, asset.decimals)
        : formatBaseUnitsExact(exact, asset.decimals),
    )
  const feeBase = BigInt(Math.round(fees ?? 0))
  const exactTotal =
    exactBase === undefined ? undefined : quote.feesIncluded ? exactBase : exactBase + feeBase
  const exactReceives = exactBase === undefined ? undefined : exactBase - feeBase
  const amountText = token ? tokenFigure(shown, exactBase) : formatSats(shown)
  const feeText =
    fees === undefined
      ? t('send.feePending')
      : token
      ? t('send.tokenFee', { amount: localizeAmount(fromBaseUnits(fees, asset.decimals)), ticker: asset.ticker })
      : satsFigure(fees)
  const totalText = token
    ? t('send.tokenFee', {
        amount: tokenFigure(total, exactTotal),
        ticker: asset.ticker,
      })
    : satsFigure(total)
  return (
    <>
      <View style={styles.hero}>
        <Txt role="section" tone="muted">
          {t('send.youSend')}
        </Txt>
        {heroDollars !== null ? (
          <Amount
            value={t('send.approxFiat', { amount: formatFiat(heroDollars, 'USD') })}
            unit=""
            role="display"
            fiat={t('send.sats', { amount: formatSats(shown) })}
            style={styles.heroAmount}
          />
        ) : (
          <Amount
            value={amountText}
            unit={token ? asset.ticker : t('common.sats')}
            role="display"
            fiat={(!token && dollar === undefined && fiatOf(shown)) || undefined}
            style={styles.heroAmount}
          />
        )}
        {dollar !== undefined && (
          <View style={styles.reviewUnit}>
            <SegmentedControl<'dollars' | 'sats'>
              options={[
                { label: fiatSymbol('USD'), value: 'dollars' },
                { label: t('common.sats'), value: 'sats' },
              ]}
              value={unitChoice}
              onChange={setUnitChoice}
            />
          </View>
        )}
      </View>

      <View>
        {heading === undefined ? (
          <SectionLabel style={styles.sectionCap}>{t('send.to')}</SectionLabel>
        ) : (
          <Txt role="bodyBold" style={styles.sectionCap}>
            {heading}
          </Txt>
        )}
        <Card>
          {!folded && <ChunkedAddress value={destination} chunked={addressLike} />}
          {quote.description ? (
            <Txt role="caption" tone="muted" lines={2} style={folded ? undefined : styles.memo}>
              {quote.description}
            </Txt>
          ) : null}
          {folded && (
            <DetailsFold label={t('send.details')}>
              <ChunkedAddress value={destination} chunked={false} />
            </DetailsFold>
          )}
        </Card>
      </View>

      <Card padding="inset">
        {receives !== undefined && (
          <FigureRow
            label={t('send.receives')}
            labelRole="caption"
            align="baseline"
            style={[styles.drowPad]}>
            <Figure role="caption" tabular>
              {token
                ? t('send.tokenFee', {
                    amount: tokenFigure(receives, exactReceives),
                    ticker: asset.ticker,
                  })
                : satsFigure(receives)}
            </Figure>
          </FigureRow>
        )}
        {/* Only on-chain does the rail change what the person chooses, and for the other two the
            arrival already says what matters. */}
        {onchainTier && (
          <FigureRow
            label={t('send.network')}
            labelRole="caption"
            align="baseline"
            style={[styles.drowPad, receives !== undefined && styles.drowBorder]}>
            <Txt role="caption" tabular>
              {railLabel}
            </Txt>
          </FigureRow>
        )}
        <FigureRow
          label={t('send.arrival')}
          labelRole="caption"
          align="baseline"
          style={[styles.drowPad, (onchainTier || receives !== undefined) && styles.drowBorder]}>
          <Txt role="caption" tone={instant ? 'success' : 'default'} tabular>
            {etaLabel}
          </Txt>
        </FigureRow>
        {onchainTier ? (
          <>
            {/* Voltz adds nothing on top, since a spread would characterize intermediation. */}
            <View style={[styles.speedRow, styles.drowBorder]}>
              <Txt role="caption" tone="muted">
                {t('send.speed')}
              </Txt>
              <SegmentedControl
                options={[
                  { label: t('send.speedFast'), value: 'fast' as OnchainSpeed },
                  { label: t('send.speedMedium'), value: 'medium' as OnchainSpeed },
                  { label: t('send.speedSlow'), value: 'slow' as OnchainSpeed },
                ]}
                value={onchainSpeed}
                onChange={onSpeedChange}
              />
            </View>
            <FigureRow
              label={t('send.fee')}
              labelRole="caption"
              align="baseline"
              style={[styles.drowPad, styles.drowBorder]}>
              <Figure role="caption" tabular>
                {t('send.sats', { amount: formatSats(onchainTier.totalSat) })}
              </Figure>
            </FigureRow>
            {quote.onchainFees?.estimate && (
              <Row pad="default" style={[styles.drow, styles.drowBorder]}>
                <Txt role="caption" tone="muted">
                  {t('send.feeEstimated')}
                </Txt>
              </Row>
            )}
          </>
        ) : (
          <FigureRow
            label={t('send.fee')}
            labelRole="caption"
            align="baseline"
            style={[styles.drowPad, styles.drowBorder]}>
            <Figure role="caption" tabular>
              {feeText}
            </Figure>
          </FigureRow>
        )}
        {fees !== undefined && (
          <FigureRow
            label={t('send.total')}
            labelRole="bodyBold"
            labelTone="default"
            align="baseline"
            style={[styles.drowPad, styles.drowBorder]}>
            <Figure role="bodyBold" tabular>
              {totalText}
            </Figure>
            {!token && dollar === undefined && fiatOf(total) && (
              <Figure role="micro" tone="muted" tabular style={styles.totalFiat}>
                {fiatOf(total)}
              </Figure>
            )}
          </FigureRow>
        )}
        {conversion && conversionAsset && (
          <ConversionRows conversion={conversion} asset={conversionAsset} usdRate={usdRate} />
        )}
        {/* Below the total, since it splits the fee above and changes nothing the person pays. */}
        {onchainTier && (
          <View style={styles.drowBorder}>
            <DetailsFold label={t('send.details')}>
              <FigureRow
                label={t('send.feeMiner')}
                labelRole="caption"
                align="baseline"
                style={[styles.drowPad]}>
                <Figure role="caption" tabular>
                  {t('send.sats', { amount: formatSats(onchainTier.minerSat) })}
                </Figure>
              </FigureRow>
              <FigureRow
                label={t('send.feeSpark')}
                labelRole="caption"
                align="baseline"
                style={[styles.drowPad, styles.drowBorder]}>
                <Figure role="caption" tabular>
                  {t('send.sats', { amount: formatSats(onchainTier.sparkSat) })}
                </Figure>
              </FigureRow>
            </DetailsFold>
          </View>
        )}
      </Card>

      {conversion && conversionAsset ? (
        <SendBalance
          balanceSat={balanceSat}
          sync={balanceSync}
          token={{
            assetId: conversion.tokenIdentifier,
            name: conversionAsset.name,
            ticker: conversionAsset.ticker,
            amount: fromBaseUnits(conversionBalance, conversionAsset.decimals),
          }}
        />
      ) : conversion ? (
        // The token half is dropped rather than guessed, and the sats balance still stands.
        <SendBalance balanceSat={balanceSat} sync={balanceSync} />
      ) : (
        !token && <SendBalance balanceSat={balanceSat} sync={balanceSync} />
      )}
    </>
  )
}

// What leaves the wallet when the amounts around it are sats and the spend is a token, drawn only with
// both halves: the number alone reads as whatever the reader assumes. The AMM's cost is in the price,
// so it reads the two amounts at spot, as the dollar sheet does, sits inside what converts and adds
// nothing to what leaves.
function ConversionRows({
  conversion,
  asset,
  usdRate,
}: {
  conversion: SparkSendConversion
  asset: SparkConvertAsset
  usdRate?: number
}): React.JSX.Element {
  const { t } = useTranslation()
  const cost =
    usdRate !== undefined
      ? effectiveConvertCostPct(asset, SPARK_BTC, conversion.amountIn, conversion.expectedOut ?? conversion.amountOut, {
          USD: usdRate,
        })
      : null
  return (
    <>
      <FigureRow
        label={t('send.converts')}
        labelRole="caption"
        align="baseline"
        style={[styles.drowPad, styles.drowBorder]}>
        <Figure role="caption" tabular>
          {t('send.tokenFee', {
            amount: localizeAmount(fromBaseUnits(conversion.amountIn, asset.decimals)),
            ticker: asset.ticker,
          })}
        </Figure>
      </FigureRow>
      <FigureRow
        label={t('send.conversionFee')}
        labelRole="caption"
        align="baseline"
        style={[styles.drowPad, styles.drowBorder]}>
        <Figure role="caption" tabular>
          {cost !== null ? t('convert.feeApprox', { pct: formatCostPct(cost) }) : t('convert.feeInPrice')}
        </Figure>
      </FigureRow>
    </>
  )
}

// A stablecoin arrives while the source leaves, so what the person came to do leads and each side is
// labelled apart. Every figure's unit comes from the quote, never from the mode: a quote is good for
// the source it was prepared with, whatever the wallet did since. The order that leaves is bitcoin
// with the mode off, and hiding those sats would be false.
function CrossChainReview({
  quote,
  refreshing,
  destination,
  fiatOf,
  balanceSat,
  balanceSync,
  spendableAssets,
  tokenBalances,
  dollar,
  usdRate,
  offers,
  onPickOffer,
}: {
  quote: SparkCrossChainQuote
  refreshing: boolean
  destination: string
  fiatOf: (sat: number) => string | null
  balanceSat: number
  balanceSync: BalanceSync
  spendableAssets: SparkConvertAsset[]
  tokenBalances: Record<string, number>
  dollar?: DollarReview
  usdRate?: number
  offers: SparkCrossChainQuote[]
  onPickOffer: (offer: SparkCrossChainQuote) => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const direct = quote.source === 'usdb'
  const total = quote.amountIn + quote.feeSat
  const conversion = quote.conversion
  const tokenId = direct ? USDB.identifier : conversion?.tokenIdentifier
  const token = tokenId === undefined ? null : assetOfToken(tokenId, spendableAssets)
  const leavesReading = dollarsOfSats(total, dollar?.rate)
  const leavesBeneath = direct
    ? null
    : leavesReading !== null
    ? t('send.approxFiat', { amount: formatFiat(leavesReading, 'USD') })
    : fiatOf(total)
  // The figures of a quote being replaced, which Confirm is off for, so nothing reads them as current.
  const pending = <Skeleton width="30%" height={font.leading.sm} />
  return (
    <>
      <View style={styles.hero}>
        <Txt role="section" tone="muted">
          {t('send.recipientGets')}
        </Txt>
        {refreshing ? (
          <Skeleton width="55%" height={font.leading.display} style={styles.heroAmount} />
        ) : (
          // What lands depends on the provider's execution, so it is marked as an estimate.
          <Amount
            value={t('send.approxAmount', {
              amount: localizeAmount(fromBaseUnits(quote.estimatedOut, quote.decimals, STABLE_PLACES)),
            })}
            unit={quote.asset}
            role="display"
            style={styles.heroAmount}
          />
        )}
      </View>

      <View>
        <SectionLabel style={styles.sectionCap}>{t('send.to')}</SectionLabel>
        <Card>
          <ChunkedAddress value={destination} chunked />
        </Card>
      </View>

      {offers.length > 1 && (
        <View>
          <SectionLabel style={styles.sectionCap}>{t('send.deliveredBy')}</SectionLabel>
          <Card padding="inset">
            {offers.map((offer, index) => {
              const marked = offer.routeId === quote.routeId
              return (
                <Touch
                  key={offer.handle}
                  onPress={() => onPickOffer(offer)}
                  feedback="row"
                  role="radio"
                  state={{ selected: marked }}
                  disabled={refreshing}>
                  <FigureRow
                    label={
                      <Row gap="sm">
                        <Txt role="caption" tone="muted">
                          {providerDisplayName(offer.provider)}
                        </Txt>
                        {marked && <TabIcon name="check" color={accent} size={16} />}
                      </Row>
                    }
                    align="baseline"
                    style={[styles.drowPad, index > 0 && styles.drowBorder]}>
                    {refreshing && marked ? (
                      pending
                    ) : (
                      <>
                        <Figure role="caption" tabular>
                          {t('send.approxAmount', {
                            amount: t('send.tokenFee', {
                              amount: localizeAmount(fromBaseUnits(offer.estimatedOut, offer.decimals, STABLE_PLACES)),
                              ticker: offer.asset,
                            }),
                          })}
                        </Figure>
                        <Figure role="micro" tone="muted" tabular style={styles.totalFiat}>
                          {t('send.tokenFee', {
                            amount: localizeAmount(fromBaseUnits(offer.feeAmount, offer.decimals, STABLE_PLACES)),
                            ticker: offer.asset,
                          })}
                        </Figure>
                      </>
                    )}
                  </FigureRow>
                </Touch>
              )
            })}
          </Card>
        </View>
      )}

      <Card padding="inset">
        {/* With a conversion the token is what leaves, and those sats are never the wallet's. */}
        {conversion === undefined && (
          <FigureRow
            label={t('send.leavesWallet')}
            labelRole="bodyBold"
            labelTone="default"
            align="baseline"
            style={[styles.drowPad]}>
            {refreshing ? (
              pending
            ) : (
              <>
                <Figure role="bodyBold" tabular>
                  {direct
                    ? t('send.tokenFee', {
                        amount: localizeAmount(fromBaseUnits(quote.amountIn, USDB.decimals)),
                        ticker: USDB.ticker,
                      })
                    : t('send.sats', { amount: formatSats(total) })}
                </Figure>
                {leavesBeneath && (
                  <Figure role="micro" tone="muted" tabular style={styles.totalFiat}>
                    {leavesBeneath}
                  </Figure>
                )}
              </>
            )}
          </FigureRow>
        )}
        {conversion && token && <ConversionRows conversion={conversion} asset={token} usdRate={usdRate} />}
        <FigureRow
          label={t('send.network')}
          labelRole="caption"
          align="baseline"
          style={[styles.drowPad, styles.drowBorder]}>
          <Txt role="caption" tabular>
            {t('send.netCrossChain', { chain: chainDisplayName(quote.chain) })}
          </Txt>
        </FigureRow>
        {quote.contractAddress && (
          <View style={styles.drowBorder}>
            <DetailsFold key={quote.contractAddress} label={t('send.contract')}>
              <ContractCopy contract={quote.contractAddress} />
            </DetailsFold>
          </View>
        )}
        <FigureRow
          label={t('send.arrival')}
          labelRole="caption"
          align="baseline"
          style={[styles.drowPad, styles.drowBorder]}>
          <Txt role="caption" tabular>
            {t('send.etaCrossChain')}
          </Txt>
        </FigureRow>
        {/* What the provider named under the card charges to deliver, spread, bridge or gas and
            slippage included (SparkCrossChainQuote.feeAmount), so it is no network's fee. */}
        <FigureRow
          label={t('send.deliveryFee')}
          labelRole="caption"
          align="baseline"
          style={[styles.drowPad, styles.drowBorder]}>
          {refreshing ? (
            pending
          ) : (
            <>
              <Figure role="caption" tabular>
                {t('send.tokenFee', {
                  amount: localizeAmount(fromBaseUnits(quote.feeAmount, quote.decimals, STABLE_PLACES)),
                  ticker: quote.asset,
                })}
              </Figure>
              {quote.feeSat > 0 && (
                <Figure role="micro" tone="muted" tabular style={styles.totalFiat}>
                  {t('send.sats', { amount: formatSats(quote.feeSat) })}
                </Figure>
              )}
            </>
          )}
        </FigureRow>
      </Card>

      {token ? (
        <SendBalance
          balanceSat={balanceSat}
          sync={balanceSync}
          token={{
            assetId: token.id,
            name: token.name,
            ticker: token.ticker,
            amount: fromBaseUnits(tokenBalances[token.id] ?? 0, token.decimals),
          }}
        />
      ) : (
        <SendBalance balanceSat={balanceSat} sync={balanceSync} />
      )}

      <Txt role="caption" tone="muted" style={styles.note}>
        {t('send.crossChainNote', { provider: providerDisplayName(quote.provider) })}
      </Txt>
      <Txt role="caption" tone="muted" style={styles.note}>
        {t('send.crossChainExpiry')}
      </Txt>
    </>
  )
}

// A contract is compared character by character against an explorer, so it reads and copies whole.
// The line under it is always there, so a copy changes its words and moves nothing.
function ContractCopy({ contract }: { contract: string }): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
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
  return (
    <Touch
      onPress={() => {
        Clipboard.setString(contract)
        AccessibilityInfo.announceForAccessibility(t('history.detail.copied'))
        setCopied(true)
        if (timer.current) {
          clearTimeout(timer.current)
        }
        timer.current = setTimeout(() => setCopied(false), COPIED_FOR_MS)
      }}
      feedback="row"
      label={t('receive.copyAddress', { address: contract })}>
      <View style={styles.contract}>
        <ChunkedAddress value={contract} chunked />
        <View style={receiveStyles.copyHint}>
          <TabIcon name={copied ? 'check' : 'copy'} color={copied ? accent : colors.textSecondary} size={14} />
          <Txt role="micro" tone={copied ? 'accent' : 'muted'}>
            {copied ? t('receive.copied') : t('receive.tapToCopy')}
          </Txt>
        </View>
      </View>
    </Touch>
  )
}

const styles = StyleSheet.create({
  reviewUnit: {
    alignSelf: 'stretch',
    marginTop: space.md,
  },
  label: {
    marginBottom: space.sm,
  },
  contactChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.md,
  },
  contactChipText: {
    flex: 1,
  },
  contactChipAddress: {
    marginTop: space.xs,
  },
  suggestions: {
    marginTop: space.sm,
    gap: space.sm,
  },
  suggestion: {
    gap: space.xs,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.md,
  },
  actions: {
    marginTop: space.md,
  },
  errorStandalone: {
    marginVertical: space.md,
  },
  nfcChip: {
    flex: 0,
    marginTop: space.sm,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    flex: 1,
    // The button radius rather than the card one.
    paddingVertical: space.md,
    minHeight: touch.min,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
  },
  // A chip is a third of the row, so a long translation (Contacts in Arabic) shrinks to fit inside it
  // on one line rather than running to its edge.
  chipLabel: {
    flexShrink: 1,
  },
  choices: {
    marginTop: space.xl,
    gap: space.sm,
  },
  addAmount: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    paddingVertical: space.md,
  },
  reviewStack: {
    gap: rhythm.section,
  },
  hero: {
    alignItems: 'center',
  },
  // Amount does not carry the gap under the caption above it or the centring the hero wants, so
  // both live here.
  heroAmount: {
    marginTop: space.sm,
    alignItems: 'center',
  },
  sectionCap: {
    marginBottom: rhythm.sectionLabelToList,
  },
  memo: {
    marginTop: space.md,
    textAlign: 'center',
  },
  note: {
    textAlign: 'center',
  },
  // Baseline rather than the centre Row gives, because a 14pt label beside a 16pt total should sit
  // on the same line of type instead of being centred against it.
  drow: {
    alignItems: 'baseline',
  },
  // The padding of the app's list rows, for the rows FigureRow lays out.
  drowPad: {
    paddingVertical: space.md,
  },
  // The hairline every list divider takes, so the review's rows split like the rest of the app's.
  drowBorder: {
    ...dividerTop,
  },
  speedRow: {
    paddingVertical: space.md,
    gap: space.sm,
  },
  contract: {
    paddingVertical: space.md,
    alignItems: 'center',
    gap: space.sm,
  },
  // Gives way in its row like the figures it holds, so they shrink inside the row rather than past it.
  totalFiat: {
    marginTop: space.xs,
  },
  error: {
    marginBottom: space.md,
  },
  footer: {
    padding: space.xl,
  },
  secondAction: {
    marginTop: space.md,
  },
})
