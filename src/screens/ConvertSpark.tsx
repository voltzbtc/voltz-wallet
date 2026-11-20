import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Animated, Easing, Pressable, ScrollView, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  sparkGetWalletInfo,
  sparkGetFiatRates,
  sparkPrepareConvert,
  sparkPrepareConvertBySpend,
  sparkConfirmConvert,
  sparkDiscardConvertQuote,
  sparkConfirmConvertLeg,
  sparkConversionLimits,
  sparkGetStableBalance,
  sparkSubscribeToPayments,
  type SparkToken,
  type SparkConvertQuote,
  type SparkConvertLimits,
  type SparkSendStatus,
  type BalanceSync,
} from '../wallet/spark'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { useSideBySide } from '../hooks/useSideBySide'
import { useReduceMotion } from '../hooks/useReduceMotion'
import {
  sparkConvertAssets,
  tokenIdOf,
  iconIdOf,
  toBaseUnits,
  toBaseUnitsExact,
  formatBaseUnitsExact,
  quotedFigure,
  fromBaseUnits,
  estimateSparkConvert,
  effectiveConvertCostPct,
  formatCostPct,
  formatPairRate,
  SPARK_BTC,
  type SparkConvertAsset,
  type BtcRates,
  rangeBounds,
} from '../wallet/sparkConvert'
import { loadCatalog } from '../wallet/tokenPrefs'
import { KNOWN_TOKENS, USDB } from '../wallet/tokens'
import { SpendHeldByExit, classifyWalletError, walletErrorKey } from '../wallet/errors'
import { waitForChange, type SettleWatch } from '../wallet/settleWatch'
import { isBelowCent } from '../wallet/assets'
import { formatSats, parseConvertAmount } from '../wallet/amount'
import { assetFiatValue, formatFiat, localizeAmount, type FiatCurrency } from '../wallet/fiat'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { AssetIcon } from '../components/AssetIcon'
import { AssetPickerSheet, type PickerItem } from '../components/AssetPickerSheet'
import { AmountSheet } from '../components/AmountSheet'
import { GradientButton } from '../components/GradientButton'
import { ReceivedOverlay } from '../components/ReceivedOverlay'
import { TabIcon } from '../components/TabIcon'
import { useAccent, useDollarMode } from '../wallet/dollarMode'
import { colors, font, press, radius, rhythm, space, touch } from '../theme'
import { Txt } from '../components/Txt'
import { Figure } from '../components/Amount'
import { ErrorBox } from '../components/ErrorBox'
import { FigureRow } from '../components/FigureRow'
import { SectionLabel } from '../components/SectionLabel'
import { Skeleton } from '../components/Skeleton'
import { Screen } from '../components/Screen'
import { Touch } from '../components/Touch'
import { Sheet } from '../components/Sheet'
// Aliased because this screen already has a local `Row`, a two-cell label-and-value line in the
// confirm sheet, and renaming it would touch every call site to gain nothing.
import { Row as RowPrimitive } from '../components/Row'

type Side = 'send' | 'recv'

// Between two tokens the SDK has no pool, so the quote is two legs through bitcoin and holds both
// handles. `spentBaseUnits` is the first leg's input and `receivedBaseUnits` the second leg's output.
// The pair is kept with the quote, since the screen's sides can change while a confirm is running.
type ConvertQuote = SparkConvertQuote & {
  secondHandle?: string
  pair?: { from: SparkConvertAsset; to: SparkConvertAsset }
}

// Each leg allows 1% of slippage when it runs, so a second leg quoted further than that below the
// review means the price moved since, and the value waits in bitcoin rather than landing short.
const PAIR_REQUOTE_FLOOR = 0.98

// The dollar wallet's sweep lands 30 to 50 seconds after the first leg as measured, later than the
// default wait, which ended on the sats most of the time.
const DOLLAR_SETTLE_WATCH: SettleWatch = { attempts: 30, delayMs: 2000 }

// Sats keep their own grouping in every language, while a token takes the language's separators.
function drawAmount(asset: SparkConvertAsset, amount: string): string {
  return isBtc(asset) ? formatSats(Number(amount)) : localizeAmount(amount)
}

function discardQuote(q: ConvertQuote): void {
  sparkDiscardConvertQuote(q.handle)
  if (q.secondHandle) {
    sparkDiscardConvertQuote(q.secondHandle)
  }
}

function secondLeg(to: SparkConvertAsset, sats: number, rates: BtcRates): Promise<SparkConvertQuote> {
  return sparkPrepareConvertBySpend(
    undefined,
    tokenIdOf(to),
    sats,
    estimateSparkConvert(SPARK_BTC, to, sats, rates) ?? sats,
  )
}

// The first leg spends the typed amount of the source token for bitcoin, and the second spends what the
// first gives for the destination token. No exact output exists across two pools, so a typed receive
// spends the source's estimate of it, then once more scaled by how far the first quote fell short. A
// typed spend goes into the first leg as `exactSpend`, its base units as typed, and `spend` prices it.
async function preparePair(
  from: SparkConvertAsset,
  to: SparkConvertAsset,
  spend: number | null,
  rates: BtcRates,
  target?: number,
  exactSpend?: bigint,
): Promise<ConvertQuote> {
  if (spend === null || spend <= 0) {
    throw new Error('pair not priceable')
  }
  const q = await pairOnce(from, to, spend, rates, exactSpend)
  if (target === undefined || q.receivedBaseUnits <= 0 || q.receivedBaseUnits >= target) {
    return q
  }
  discardQuote(q)
  return pairOnce(from, to, Math.ceil((spend * target) / q.receivedBaseUnits), rates)
}

async function pairOnce(
  from: SparkConvertAsset,
  to: SparkConvertAsset,
  spend: number,
  rates: BtcRates,
  exactSpend?: bigint,
): Promise<ConvertQuote> {
  const first = await sparkPrepareConvertBySpend(
    tokenIdOf(from),
    undefined,
    exactSpend ?? spend,
    estimateSparkConvert(from, SPARK_BTC, spend, rates) ?? spend,
  )
  const second = await secondLeg(to, first.receivedBaseUnits, rates).catch(cause => {
    sparkDiscardConvertQuote(first.handle)
    throw cause
  })
  // What the first leg gives past its floor reaches the second leg as well.
  const lift = first.expectedBaseUnits ? first.expectedBaseUnits / first.receivedBaseUnits : 1
  return {
    ...first,
    receivedBaseUnits: second.receivedBaseUnits,
    receivedExact: second.receivedExact,
    expectedBaseUnits: Math.round((second.expectedBaseUnits ?? second.receivedBaseUnits) * lift),
    secondHandle: second.handle,
    pair: { from, to },
  }
}

// A pair's minimum is the larger of its two legs', the second's sats priced in the source token.
function pairLimits(
  first: SparkConvertLimits,
  second: SparkConvertLimits,
  from: SparkConvertAsset,
  rates: BtcRates,
): SparkConvertLimits {
  const secondInSource =
    second.minFromBaseUnits === undefined
      ? null
      : estimateSparkConvert(SPARK_BTC, from, second.minFromBaseUnits, rates)
  const mins = [first.minFromBaseUnits, secondInSource === null ? undefined : Math.ceil(secondInSource)]
  const known = mins.filter((m): m is number => m !== undefined)
  return { ...first, minFromBaseUnits: known.length > 0 ? Math.max(...known) : undefined }
}

const isBtc = (a: SparkConvertAsset): boolean => a.id === SPARK_BTC.id

// The display currency plus every peg, since a pegged token is priced by crossing its peg into it.
function rateCoins(currency: string): string[] {
  const pegs = KNOWN_TOKENS.map(token => token.fiatId).filter((f): f is string => f !== undefined)
  return Array.from(new Set([currency, ...pegs]))
}

// Swaps BTC <-> a Spark token through the Flashnet AMM, executed as a send to the wallet's own address.
// Two tokens swap through bitcoin, in two legs.
export function ConvertSpark(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  const sideBySide = useSideBySide()
  const reduced = useReduceMotion()
  const stableOn = useDollarMode()

  const [assets, setAssets] = useState<SparkConvertAsset[]>([SPARK_BTC])
  const [balances, setBalances] = useState<Record<string, number>>({})
  // Max, the range and the picker's amounts offer a balance as spendable, so only a read from a
  // synced connection shows them.
  const [balancesSync, setBalancesSync] = useState<BalanceSync>('waiting')
  const [rates, setRates] = useState<Record<string, number>>({})
  // Null until the saved choice is read, which draws no fiat line rather than one in a default.
  const [currency, setCurrency] = useState<FiatCurrency | null>(null)
  const [from, setFrom] = useState<SparkConvertAsset>(SPARK_BTC)
  const [to, setTo] = useState<SparkConvertAsset>(SPARK_BTC)
  // Only the last-edited side is authoritative, and the other one derives live.
  const [send, setSend] = useState('')
  const [recv, setRecv] = useState('')
  const [edited, setEdited] = useState<Side>('recv')
  const [quote, setQuote] = useState<ConvertQuote | null>(null)
  const [quoting, setQuoting] = useState(false)
  // Kept apart from the quote so a ready quote fills the cards without popping the sheet.
  const [reviewing, setReviewing] = useState(false)
  const [result, setResult] = useState<SparkSendStatus | null>(null)
  // What the success shows when it is not the quote's output, as in dollar mode, where it is the USDB
  // that arrived or the sats still waiting to turn into dollars.
  const [landed, setLanded] = useState<{ asset: SparkConvertAsset; baseUnits: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [picking, setPicking] = useState<Side | null>(null)
  const [editing, setEditing] = useState<Side | null>(null)
  const [limits, setLimits] = useState<SparkConvertLimits | null>(null)
  const tokenPair = !isBtc(from) && !isBtc(to)
  // The dollar wallet converts loose sats into USDB, and between the two legs the sats are loose. So in
  // dollar mode a token becomes dollars by its first leg alone, the mode running the second, and the
  // pickers offer only that pair, since any other would find its sats gone into USDB.
  const toDollar = tokenPair && stableOn && to.id === USDB.identifier
  // Bumped on each edit, so a slower in-flight quote can check it and drop its stale result.
  const quoteRun = useRef(0)
  const sidesChosen = useRef(false)
  // The first run of the sides' read has answered. Before it both sides are bitcoin, which is what
  // no conversion looks like.
  const [sidesRead, setSidesRead] = useState(false)
  // A confirm in flight owns the sides and the review until it settles.
  const confirming = useRef(false)

  const swapSpin = useRef(new Animated.Value(0)).current
  const swapAngle = useRef(0)
  const swapRotate = swapSpin.interpolate({
    inputRange: [0, 360],
    outputRange: ['0deg', '360deg'],
    extrapolate: 'extend',
  })

  // Returns the map it just stored as well as the tokens, so a caller waiting for a balance to move
  // reads the same numbers the screen is showing instead of fetching them a second time.
  const refreshBalances = useCallback(async (): Promise<{
    tokens: SparkToken[]
    balances: Record<string, number>
  }> => {
    const { balanceSat, tokens, sync } = await sparkGetWalletInfo().catch(() => ({
      balanceSat: 0,
      tokens: [] as SparkToken[],
      sync: 'waiting' as BalanceSync,
    }))
    const map: Record<string, number> = { [SPARK_BTC.id]: balanceSat }
    for (const tk of tokens) {
      map[tk.identifier] = tk.balanceBaseUnits
    }
    setBalances(map)
    setBalancesSync(sync)
    return { tokens, balances: map }
  }, [])

  // Moves the balances only, so the sides, the typed amount and a quote under review stay.
  useSyncRefresh(refreshBalances)

  // Default To is the first token, so a BTC to stablecoin convert works out of the box.
  useEffect(() => {
    let active = true
    ;(async () => {
      const [tokens, priced, catalog] = await Promise.all([
        refreshBalances(),
        resolveDisplayCurrency(i18n.language).then(async shown => ({
          shown,
          rate: await sparkGetFiatRates(rateCoins(shown)).catch(() => ({})),
        })),
        loadCatalog().catch(() => undefined),
      ])
      if (!active) {
        return
      }
      setCurrency(priced.shown)
      setRates(priced.rate)
      const list = sparkConvertAssets(tokens.tokens, catalog)
      setAssets(list)
      setSidesRead(true)
      // The context catching up is a later run, and the confirm's own leg can be what moves it.
      if (confirming.current) {
        return
      }
      // Dollar mode opens on a held token turning into USDB, the one conversion the mode allows. A
      // pegged remainder under a cent is what a conversion leaves behind, below any minimum.
      const usdb = list.find(a => a.id === USDB.identifier)
      const held = list.find(a => {
        const base = tokens.balances[a.id] ?? 0
        return (
          !isBtc(a) &&
          a.id !== USDB.identifier &&
          base > 0 &&
          !(a.fiatId !== undefined && isBelowCent(base, a.decimals))
        )
      })
      const movesSend = stableOn && usdb !== undefined && held !== undefined
      if (movesSend) {
        setFrom(held)
        setTo(usdb)
      } else {
        // With no token to turn into dollars, the form is bitcoin into dollars, which the mode does anyway.
        if (stableOn) {
          setFrom(SPARK_BTC)
        }
        setTo(list.find(a => !isBtc(a)) ?? SPARK_BTC)
      }
      // A run that moves the send side, or any later run, changes the sides under whatever was typed or
      // is under review, so both go. A first run in the mode off only settles the receive side.
      if (sidesChosen.current || movesSend) {
        quoteRun.current += 1
        setReviewing(false)
        setQuote(prev => {
          if (prev) {
            discardQuote(prev)
          }
          return null
        })
        setSend('')
        setRecv('')
      }
      sidesChosen.current = true
    })()
    return () => {
      active = false
    }
  }, [refreshBalances, i18n.language, stableOn])

  // Best-effort, so missing limits just hide the Min chip and the range hint.
  useEffect(() => {
    let active = true
    const load = tokenPair
      ? Promise.all([
          sparkConversionLimits(tokenIdOf(from), undefined),
          sparkConversionLimits(undefined, tokenIdOf(to)),
        ]).then(([first, second]) => pairLimits(first, second, from, rates))
      : sparkConversionLimits(tokenIdOf(from), tokenIdOf(to))
    load.then(l => active && setLimits(l)).catch(() => active && setLimits(null))
    return () => {
      active = false
    }
  }, [from, to, tokenPair, rates])

  // The SDK converts BTC <-> token only, so both sides on one asset would quote a nonsensical ~100% cost.
  useEffect(() => {
    if (from.id === to.id) {
      setTo(isBtc(from) ? assets.find(a => !isBtc(a)) ?? SPARK_BTC : SPARK_BTC)
    }
  }, [from, to, assets])

  // A deposit or payment arriving while the screen is open must update the balances, Max and range.
  useEffect(() => {
    let unsub: (() => void) | null = null
    let alive = true
    sparkSubscribeToPayments(() => {
      refreshBalances()
    })
      .then(u => (alive ? (unsub = u) : u()))
      .catch(() => undefined)
    return () => {
      alive = false
      if (unsub) {
        unsub()
      }
    }
  }, [refreshBalances])

  // A quote still in flight belongs to the amounts and sides being left, so it is dropped when it lands.
  function reset() {
    quoteRun.current += 1
    setLanded(null)
    setQuoting(false)
    setReviewing(false)
    setResult(null)
    setError(null)
    setQuote(prev => {
      if (prev) {
        discardQuote(prev)
      }
      return null
    })
  }

  // The send side honors an exact spend through the send-driven search, the receive side takes the SDK's
  // native exact-out path, and a pair of tokens runs both legs through preparePair. A retry after a failed
  // confirm passes clearError false to keep that error up.
  const prepareQuote = useCallback(
    async (clearError = true) => {
      const editedAsset = edited === 'send' ? from : to
      const editedStr = edited === 'send' ? send : recv
      // A double, for the estimates alone.
      const editedBase = toBaseUnits(editedStr, editedAsset.decimals)
      // What the SDK is handed: sats as they are, and a token's base units read from its figure exactly,
      // since a double carries about 15 significant digits and a token up to 18 places.
      const typed: number | bigint | null = isBtc(editedAsset)
        ? editedBase > 0
          ? editedBase
          : null
        : toBaseUnitsExact(editedStr, editedAsset.decimals)
      // A spend of sats into a token is searched from the token's price. With none, the only seed left
      // would be the sats read as the token's base units, so nothing is asked and the field is read-only.
      const unseeded =
        edited === 'send' && isBtc(from) && !isBtc(to) && estimateSparkConvert(from, to, editedBase, rates) === null
      if (typed === null || from.id === to.id || unseeded) {
        setQuoting(false)
        setQuote(prev => {
          if (prev) {
            discardQuote(prev)
          }
          return null
        })
        return
      }
      const run = ++quoteRun.current
      setQuoting(true)
      try {
        const q: ConvertQuote = tokenPair
          ? await preparePair(
              from,
              to,
              edited === 'send' ? editedBase : estimateSparkConvert(to, from, editedBase, rates),
              rates,
              edited === 'send' ? undefined : editedBase,
              edited === 'send' && typeof typed === 'bigint' ? typed : undefined,
            )
          : edited === 'send'
          ? await sparkPrepareConvertBySpend(
              tokenIdOf(from),
              tokenIdOf(to),
              typed,
              // Unpriced only for a token spent into sats, which is quoted by its exact input and never
              // reads the seed.
              estimateSparkConvert(from, to, editedBase, rates) ?? editedBase,
            )
          : await sparkPrepareConvert(tokenIdOf(from), tokenIdOf(to), typed)
        if (run !== quoteRun.current) {
          discardQuote(q)
          return
        }
        if (clearError) {
          setError(null)
        }
        setQuote(prev => {
          if (prev && prev.handle !== q.handle) {
            discardQuote(prev)
          }
          return q
        })
      } catch (cause) {
        if (run === quoteRun.current) {
          setQuote(null)
          const code = classifyWalletError(cause)
          setError(code === 'unknown' ? t('convert.reviewFailed') : t(`errors.${code}`))
        }
      } finally {
        if (run === quoteRun.current) {
          setQuoting(false)
        }
      }
    },
    [send, recv, edited, from, to, rates, t, tokenPair],
  )

  useEffect(() => {
    const timer = setTimeout(() => {
      prepareQuote()
    }, 450)
    return () => clearTimeout(timer)
  }, [prepareQuote])

  // The opposite field derived from a typed source, empty when the pair cannot be priced.
  function counter(
    srcStr: string,
    srcAsset: SparkConvertAsset,
    dstAsset: SparkConvertAsset,
  ): string {
    const srcBase = toBaseUnits(srcStr, srcAsset.decimals)
    if (srcBase <= 0) {
      return ''
    }
    const dstBase = estimateSparkConvert(srcAsset, dstAsset, srcBase, rates)
    return dstBase === null ? '' : fromBaseUnits(dstBase, dstAsset.decimals)
  }

  // Once a quote lands both cards show its executed amounts, the edited side included, because a
  // send-driven swap executes exact-out and the real spend can differ a hair from what was typed.
  const quotedSend = quote
    ? quotedFigure(quote.spentBaseUnits, quote.spentExact, from.decimals)
    : null
  const quotedRecv = quote
    ? quotedFigure(quote.receivedBaseUnits, quote.receivedExact, to.decimals)
    : null
  const sendDisplay = quotedSend ?? (edited === 'send' ? send : counter(recv, to, from))
  const recvDisplay = quotedRecv ?? (edited === 'recv' ? recv : counter(send, from, to))
  const priceable = counter('1', from, to) !== '' || counter('1', to, from) !== ''
  // Without the token's price a spend of sats into it has nothing to search from, so only the receive,
  // quoted by its exact output, is offered, and nothing fills the spend.
  const spendUnpriced = isBtc(from) && !isBtc(to) && !priceable

  function fieldFiat(display: string, asset: SparkConvertAsset): string | null {
    if (currency === null) {
      return null
    }
    const base = toBaseUnits(display, asset.decimals)
    const rate = rates[currency]
    if (base <= 0 || !(rate > 0)) {
      return null
    }
    if (isBtc(asset)) {
      return formatFiat((base / 1e8) * rate, currency)
    }
    const value = assetFiatValue(base / 10 ** asset.decimals, asset.fiatId, currency, rates)
    return value > 0 ? formatFiat(value, currency) : null
  }

  const maxBase = balances[from.id] ?? 0
  const maxField =
    maxBase > 0 && balancesSync === 'synced' ? fromBaseUnits(maxBase, from.decimals) : null
  const minFromBase = limits?.minFromBaseUnits
  const minField =
    minFromBase !== undefined && minFromBase > 0 ? fromBaseUnits(minFromBase, from.decimals) : null
  // A balance under the pair's minimum would render the range inverted, so a hint replaces it.
  const belowMinBalance = minFromBase !== undefined && maxBase > 0 && minFromBase > maxBase
  const bounds =
    minFromBase !== undefined && minFromBase > 0 && maxBase > 0 && !belowMinBalance
      ? rangeBounds(minFromBase, maxBase, from.decimals)
      : null
  const rangeHint =
    minField !== null && maxField !== null
      ? belowMinBalance || bounds === null
        ? t('convert.belowMinBalance')
        : t('receive.range', {
            min: drawAmount(from, bounds.min),
            max: `${drawAmount(from, bounds.max)} ${from.ticker}`,
          })
      : null

  // The other side stays unless it is the asset just picked, in which case it moves to bitcoin, or to the
  // first token when bitcoin is what was picked. Two different tokens convert through bitcoin.
  // The amounts belong to the conversion that ran, so the next one starts from an empty form.
  function finish() {
    reset()
    setSend('')
    setRecv('')
  }

  function firstToken(): SparkConvertAsset {
    return assets.find(a => !isBtc(a)) ?? SPARK_BTC
  }
  function otherSide(prev: SparkConvertAsset, picked: SparkConvertAsset): SparkConvertAsset {
    if (prev.id !== picked.id) {
      return prev
    }
    return isBtc(picked) ? firstToken() : SPARK_BTC
  }
  function choose(side: Side, asset: SparkConvertAsset) {
    if (side === 'send') {
      setFrom(asset)
      setTo(prev => otherSide(prev, asset))
    } else {
      setTo(asset)
      setFrom(prev => otherSide(prev, asset))
    }
    setSend('')
    setRecv('')
    reset()
    setPicking(null)
  }

  function swap() {
    // Under reduced motion the arrow stays put; the sides swapping is the whole of the change.
    if (!reduced) {
      swapAngle.current += 180
      Animated.timing(swapSpin, {
        toValue: swapAngle.current,
        // Off the motion scale on purpose, because 350 sits almost exactly between base and slow, and
        // either step would change the feel of the swap by a fifth.
        duration: 350,
        easing: Easing.inOut(Easing.ease),
        useNativeDriver: true,
      }).start()
    }
    setFrom(to)
    setTo(from)
    setSend(recv)
    setRecv(send)
    setEdited(edited === 'send' ? 'recv' : 'send')
    reset()
  }

  function fillMax() {
    if (maxField === null) {
      return
    }
    setSend(maxField)
    setEdited('send')
    reset()
  }

  // The figure the range line shows, which is at or above the real minimum.
  function fillMin() {
    if (minField === null) {
      return
    }
    setSend(bounds ? fromBaseUnits(bounds.minBase, from.decimals) : minField)
    setEdited('send')
    reset()
  }

  // No re-prepare on tap. The debounced quote is seconds old and the confirm's slippage covers the drift,
  // while a second prepare would add a failure point that makes the button look dead when the AMM pool
  // errors.
  function review() {
    if (quote === null || busy || from.id === to.id) {
      return
    }
    setReviewing(true)
  }

  // Reads the wallet without refreshBalances' fallback, so a failed read is unknown rather than zero.
  async function readBalances(): Promise<Record<string, number> | null> {
    try {
      const { balanceSat, tokens, sync } = await sparkGetWalletInfo()
      const map: Record<string, number> = { [SPARK_BTC.id]: balanceSat }
      for (const tk of tokens) {
        map[tk.identifier] = tk.balanceBaseUnits
      }
      setBalances(map)
      setBalancesSync(sync)
      return map
    } catch {
      return null
    }
  }

  function stop(message: string) {
    setError(message)
    setReviewing(false)
    setQuote(null)
  }

  // The value is bitcoin now, so the form offers the leg that is left instead of the one that ran.
  function stopInBitcoin(pairTo: SparkConvertAsset) {
    stop(t('convert.stoppedInBitcoin'))
    setFrom(SPARK_BTC)
    setTo(pairTo)
    setSend('')
    setRecv('')
    setEdited('send')
  }

  // In dollar mode the wallet turns loose sats into USDB by itself, so only the first leg runs and the
  // second is the mode's. The success shows what landed, the USDB once it arrives, or the sats still
  // waiting to turn into dollars when the wait runs out first. It sets the result itself, so it
  // returns null unless the first leg failed.
  async function confirmToDollar(
    q: ConvertQuote,
    pairFrom: SparkConvertAsset,
  ): Promise<SparkSendStatus | null> {
    if (q.secondHandle) {
      sparkDiscardConvertQuote(q.secondHandle)
    }
    // Read now rather than from the screen, which can predate a sweep that has landed since.
    const base = (await readBalances()) ?? balances
    const usdbBefore = base[USDB.identifier] ?? 0
    const satsBefore = base[SPARK_BTC.id] ?? 0
    const sourceBefore = base[pairFrom.id] ?? 0
    // Null when the leg threw after the swap ran, which leaves the balance to say what arrived.
    let arrivedSats: number | null
    try {
      const first = await sparkConfirmConvertLeg(q.handle)
      if (first.status === 'failed') {
        return 'failed'
      }
      arrivedSats = first.receivedBaseUnits
    } catch (cause) {
      // Refused before the SDK was called, so the source is whole and the balance has nothing to say.
      if (cause instanceof SpendHeldByExit) {
        throw cause
      }
      const after = await readBalances()
      if (after === null) {
        stop(t('convert.checkBalance'))
        return null
      }
      if ((after[pairFrom.id] ?? 0) >= sourceBefore) {
        throw cause
      }
      arrivedSats = null
    }
    // The mode sweeps every loose sat at once, at one price. Dollars that rise while this leg's sats are
    // still loose come from elsewhere and move the baseline. Once fewer sats remain than the leg brought,
    // the rise from the baseline is the sweep that took them, and this leg's part of it is its part of
    // the sats swept, since sats already waiting go in the same sweep.
    let last: Record<string, number> | null = null
    let baseline = usdbBefore
    let satsPrev = satsBefore + (arrivedSats ?? 0)
    let credited = 0
    await waitForChange(
      async () => {
        const now = await readBalances()
        if (now === null) {
          return credited
        }
        last = now
        const usdb = now[USDB.identifier] ?? 0
        const satsNow = now[SPARK_BTC.id] ?? 0
        const gone = arrivedSats === null ? satsNow <= satsBefore : satsNow < arrivedSats
        if (!gone) {
          baseline = Math.max(baseline, usdb)
          satsPrev = satsNow
        } else if (usdb > baseline) {
          const swept = satsPrev - satsNow
          const part = arrivedSats !== null && swept > arrivedSats ? arrivedSats / swept : 1
          credited = Math.round((usdb - baseline) * part)
        }
        return credited
      },
      0,
      ms => new Promise(resolve => setTimeout(resolve, ms)),
      DOLLAR_SETTLE_WATCH,
    )
    const sats = arrivedSats ?? Math.max(0, (last?.[SPARK_BTC.id] ?? satsBefore) - satsBefore)
    if (credited > 0) {
      setLanded({ asset: q.pair?.to ?? to, baseUnits: credited })
    } else if (sats > 0) {
      setLanded({ asset: SPARK_BTC, baseUnits: sats })
    } else {
      stop(t('convert.checkBalance'))
      return null
    }
    setReviewing(false)
    setResult('complete')
    return null
  }

  // The context can lag the SDK, which is the one that sweeps loose sats back into USDB, so a leg that
  // leaves sats runs only on the SDK's own off. An unknown mode fails as any confirm does, with nothing
  // spent. Null tells confirm the screen has already said why.
  function refuseLooseSats(q: ConvertQuote, stable: boolean | null): null {
    discardQuote(q)
    if (stable === null) {
      throw new Error('stable balance unknown')
    }
    stop(t('convert.pairNeedsBitcoin'))
    return null
  }

  // Only a leg into bitcoin asks. Sats going out into a token leave nothing loose for the mode to take.
  async function confirmSingle(q: ConvertQuote): Promise<SparkSendStatus | null> {
    if (isBtc(to)) {
      const stable = await sparkGetStableBalance().catch(() => null)
      if (stable !== false) {
        return refuseLooseSats(q, stable)
      }
    }
    return sparkConfirmConvert(q.handle)
  }

  // The SDK can raise its wait for the converted side after the swap already ran, so a throw is read
  // against the balance before the screen says where the value is. The second leg was sized on an
  // estimate of the first, so it is quoted again on the sats that arrived, and checked against them
  // and against the review. Null tells confirm there is nothing more to wait for.
  async function confirmPair(q: ConvertQuote): Promise<SparkSendStatus | null> {
    const pairFrom = q.pair?.from ?? from
    const pairTo = q.pair?.to ?? to
    const stable = await sparkGetStableBalance().catch(() => null)
    if (stable === true && pairTo.id === USDB.identifier) {
      return confirmToDollar(q, pairFrom)
    }
    if (stable !== false) {
      return refuseLooseSats(q, stable)
    }
    const sourceBefore = balances[pairFrom.id] ?? 0
    let first: { status: SparkSendStatus; receivedBaseUnits: number }
    try {
      first = await sparkConfirmConvertLeg(q.handle)
    } catch (cause) {
      if (q.secondHandle) {
        sparkDiscardConvertQuote(q.secondHandle)
      }
      if (cause instanceof SpendHeldByExit) {
        throw cause
      }
      const after = await readBalances()
      if (after === null) {
        stop(t('convert.checkBalance'))
        return null
      }
      if ((after[pairFrom.id] ?? 0) < sourceBefore) {
        stopInBitcoin(pairTo)
        return null
      }
      throw cause
    }
    if (q.secondHandle) {
      sparkDiscardConvertQuote(q.secondHandle)
    }
    if (first.status === 'failed') {
      return 'failed'
    }
    let second: SparkConvertQuote
    try {
      second = await secondLeg(pairTo, first.receivedBaseUnits, rates)
    } catch {
      stopInBitcoin(pairTo)
      return null
    }
    if (
      second.spentBaseUnits > first.receivedBaseUnits ||
      second.receivedBaseUnits < q.receivedBaseUnits * PAIR_REQUOTE_FLOOR
    ) {
      sparkDiscardConvertQuote(second.handle)
      stopInBitcoin(pairTo)
      return null
    }
    const satsBefore = (await readBalances())?.[SPARK_BTC.id]
    setQuote({
      ...q,
      receivedBaseUnits: second.receivedBaseUnits,
      receivedExact: second.receivedExact,
      expectedBaseUnits: second.expectedBaseUnits,
    })
    try {
      const status = await sparkConfirmConvert(second.handle)
      if (status === 'failed') {
        stopInBitcoin(pairTo)
        return null
      }
      return status
    } catch {
      const after = await readBalances()
      if (after === null || satsBefore === undefined) {
        stop(t('convert.checkBalance'))
        return null
      }
      // The sats left for the pool, so the destination token is on its way.
      if ((after[SPARK_BTC.id] ?? 0) < satsBefore) {
        return 'pending'
      }
      stopInBitcoin(pairTo)
      return null
    }
  }

  async function confirm() {
    if (!quote || busy) {
      return
    }
    setBusy(true)
    confirming.current = true
    setError(null)
    try {
      // What the destination held before the swap, so the wait below can tell arrival from silence.
      const before = balances[to.id] ?? 0
      const status = quote.secondHandle ? await confirmPair(quote) : await confirmSingle(quote)
      if (status === null) {
        return
      }
      // Nothing moved and the handle is spent, so the screen keeps the amounts, says it failed, and
      // offers Convert again on a fresh quote, as a confirm that throws does.
      if (status === 'failed') {
        setError(t('convert.failed'))
        setReviewing(false)
        setQuote(null)
        prepareQuote(false)
        return
      }
      // The success animation waits for the wallet's own balance read to show the change rather than
      // for the call, so it never runs over a stale number. A timed-out wait still celebrates, since
      // the swap was accepted and this screen does not judge that.
      await waitForChange(
        async () => (await refreshBalances()).balances[to.id] ?? before,
        before,
        ms => new Promise(resolve => setTimeout(resolve, ms)),
      )
      setResult(status)
    } catch (cause) {
      const code = classifyWalletError(cause)
      setError(code === 'unknown' ? t('convert.failed') : t(walletErrorKey(code)))
      // The handle is consumed once send starts, so a failed confirm needs a fresh quote to retry with.
      setReviewing(false)
      setQuote(null)
      prepareQuote(false)
    } finally {
      confirming.current = false
      setBusy(false)
    }
  }

  // Cancel drops the prepared quote while the amounts stay, so it quotes them again for the next review.
  // A confirm in flight owns the sheet until it settles, or a fresh quote would bring Convert back over
  // what the confirm is about to say.
  function cancelReview() {
    if (busy) {
      return
    }
    reset()
    prepareQuote()
  }

  // Sats come back as a number, and a token in its base units as typed, kept as its exact figure.
  function onSheetConfirm(value: number | undefined) {
    fillEdited(value === undefined || value <= 0 ? '' : String(value))
  }

  function onTokenSheetConfirm(base: bigint | undefined) {
    fillEdited(base === undefined ? '' : formatBaseUnitsExact(base, editAsset.decimals))
  }

  function fillEdited(str: string) {
    const side = editing
    setEditing(null)
    if (side === null) {
      return
    }
    reset()
    if (side === 'send') {
      setSend(str)
    } else {
      setRecv(str)
    }
    setEdited(side)
  }

  if (result === 'complete' || result === 'pending') {
    const shown = landed ?? { asset: to, baseUnits: quote?.receivedBaseUnits ?? 0 }
    return (
      <ReceivedOverlay
        visible
        // A token counts in its natural unit trimmed to 2 decimals, since base units churn the low digits.
        amount={{
          value: isBtc(shown.asset) ? shown.baseUnits : shown.baseUnits / 10 ** shown.asset.decimals,
          unit: shown.asset.ticker,
          format: isBtc(shown.asset)
            ? formatSats
            : (n: number) => localizeAmount(fromBaseUnits(Math.round(n * 100), 2)),
        }}
        label={t(result === 'pending' ? 'convert.onTheWay' : 'convert.done')}
        // A conversion with no end yet is not called converted. Unlike a send, no record follows it to
        // tell its end (sparkConfirmConvertLeg reads the status and keeps nothing), so the line points at
        // the balance.
        pending={result === 'pending' ? t('convert.pendingLine') : undefined}
        onDone={finish}
      />
    )
  }

  // Only held assets have anything to convert, so the send picker filters by balance and shows it.
  // Bitcoin is titled by name, as its card is, since its ticker here is the unit.
  function pickerTitle(a: SparkConvertAsset): { ticker: string; name: string } {
    return isBtc(a) ? { ticker: a.name, name: '' } : { ticker: a.ticker, name: a.name }
  }
  const sendChoices = assets.filter(
    a => (balances[a.id] ?? 0) > 0 && (!stableOn || (!isBtc(a) && a.id !== USDB.identifier)),
  )
  const recvChoices = assets.filter(a => a.id !== from.id && (!stableOn || a.id === USDB.identifier))
  // A side whose list holds nothing but what it already shows is a fact, not a picker.
  const canPick = (choices: SparkConvertAsset[], current: SparkConvertAsset) =>
    choices.some(a => a.id !== current.id)
  const pickerItems: PickerItem[] =
    picking === 'send'
      ? sendChoices
          .map(a => ({
            assetId: a.id,
            // Bitcoin's id here is 'btc', which no logo is keyed by, so the mark goes by the icon id.
            iconId: iconIdOf(a),
            ...pickerTitle(a),
            subtitle:
              balancesSync === 'synced'
                ? `${
                    isBtc(a)
                      ? formatSats(balances[a.id])
                      : localizeAmount(fromBaseUnits(balances[a.id], a.decimals))
                  } ${a.ticker}`
                : undefined,
          }))
      : recvChoices.map(a => ({ assetId: a.id, iconId: iconIdOf(a), ...pickerTitle(a) }))
  const spentFigure = quote
    ? quotedFigure(quote.spentBaseUnits, quote.spentExact, from.decimals)
    : ''
  const receivedFigure = quote
    ? quotedFigure(quote.receivedBaseUnits, quote.receivedExact, to.decimals)
    : ''
  const spent = quote ? `${drawAmount(from, spentFigure)} ${from.ticker}` : ''
  const receivedAmount = quote ? `${drawAmount(to, receivedFigure)} ${to.ticker}` : ''
  // In dollar mode the second leg is the mode's own conversion, so what arrives is an estimate.
  const received = toDollar ? t('send.approxAmount', { amount: receivedAmount }) : receivedAmount
  // Sats per one token for a bitcoin swap, so the executed rate reads the same in both directions, and
  // the destination token per source token for a pair.
  const tokenAsset = isBtc(from) ? to : from
  const btcBase = quote ? (isBtc(from) ? quote.spentBaseUnits : quote.receivedBaseUnits) : 0
  const tokenBase = quote ? (isBtc(from) ? quote.receivedBaseUnits : quote.spentBaseUnits) : 0
  const rateLabel =
    quote && tokenPair && quote.spentBaseUnits > 0
      ? t('convert.ratePair', {
          from: from.ticker,
          to: to.ticker,
          amount: localizeAmount(
            formatPairRate(
              quote.receivedBaseUnits /
                10 ** to.decimals /
                (quote.spentBaseUnits / 10 ** from.decimals),
            ),
          ),
        })
      : quote && tokenBase > 0
      ? t('convert.rateSats', {
          ticker: tokenAsset.ticker,
          amount: formatSats(Math.round((btcBase * 10 ** tokenAsset.decimals) / tokenBase)),
        })
      : ''
  // The AMM's real cost is the spread baked into the price, so it comes from amountIn against what the
  // pool gives at spot, never the floor an exact input signs. conversionEstimate.fee is unreliable,
  // and can report ~1594 sats on a convert that costs about 7.
  const costPct = quote
    ? effectiveConvertCostPct(from, to, quote.spentBaseUnits, quote.expectedBaseUnits ?? quote.receivedBaseUnits, rates)
    : null
  const feeLabel =
    // The wordier "in the price" label is only for a pair that cannot be priced at all.
    costPct !== null
      ? t('convert.feeApprox', { pct: formatCostPct(costPct) })
      : t('convert.feeInPrice')
  const editAsset = editing === 'send' ? from : to
  const editStr = editing === 'send' ? send : recv
  // Only the send side spends the balance, and only a synced read locks the keypad, as for Max. In the
  // sheet's unit, which is the asset's own.
  const sheetAvailable =
    editing === 'send' && balancesSync === 'synced' && Number.isSafeInteger(maxBase) ? maxBase : undefined

  // The range is a sentence and every amount in it is read whole, so it wraps between words with no
  // line cap; at a text size where the chips no longer fit beside it they go under it, by the rule
  // every label and figure share.
  const limitsHint = rangeHint && (
    <Txt
      role="caption"
      tone="muted"
      tabular
      wholeWords
      // A zero basis in a column would lay the sentence out at no height above the chips.
      style={sideBySide ? styles.hint : undefined}>
      {rangeHint}
    </Txt>
  )
  const limitsChips = (
    <RowPrimitive gap="sm" style={styles.chips}>
      {!spendUnpriced && minField !== null && maxField !== null && (
        <Chip label={t('convert.min')} onPress={fillMin} />
      )}
      {!spendUnpriced && maxField !== null && <Chip label={t('convert.max')} onPress={fillMax} />}
    </RowPrimitive>
  )
  // Everything on this line depends on a balance, so a wallet with none draws no line at all, and a
  // known minimum alone is not a line of nothing that moves the swap button when the quote goes away.
  const limitsLine =
    maxField === null ? null : sideBySide ? (
      <RowPrimitive spread gap="md" style={styles.limits}>
        {limitsHint}
        {limitsChips}
      </RowPrimitive>
    ) : (
      <View style={[styles.limits, styles.limitsStacked]}>
        {limitsHint}
        {limitsChips}
      </View>
    )

  return (
    <Screen scroll keyboard layout="padded">
      <SectionLabel style={styles.label}>
        {t('convert.send')}
      </SectionLabel>
      <AmountField
        asset={from}
        value={sendDisplay}
        editable={!spendUnpriced && (priceable || edited === 'send' || tokenPair)}
        fiat={fieldFiat(sendDisplay, from)}
        note={spendUnpriced ? t('convert.rateUnavailable') : undefined}
        onPickAsset={canPick(sendChoices, from) ? () => setPicking('send') : undefined}
        onPressAmount={() => setEditing('send')}
        accessibilityLabel={t('convert.send')}
      />
      {limitsLine}

      <View style={styles.swapRow}>
        <Touch
          onPress={swap}
          disabled={stableOn}
          feedback="link"
          label={t('convert.swap')}
          hitSlop={space.md}
          style={styles.swapBtn}>
          <Animated.View style={{ transform: [{ rotate: swapRotate }] }}>
            <TabIcon name="convert" color={accent} size={20} />
          </Animated.View>
        </Touch>
      </View>

      <SectionLabel style={styles.label}>
        {t('convert.receive')}
      </SectionLabel>
      {sidesRead ? (
        <AmountField
          asset={to}
          value={recvDisplay}
          // A typed receive on a pair is spent through its estimate, which needs a rate.
          editable={!(tokenPair && !priceable)}
          fiat={fieldFiat(recvDisplay, to)}
          note={!priceable ? t('convert.rateUnavailable') : undefined}
          onPickAsset={canPick(recvChoices, to) ? () => setPicking('recv') : undefined}
          onPressAmount={() => setEditing('recv')}
          accessibilityLabel={t('convert.receive')}
        />
      ) : (
        <AmountFieldSkeleton />
      )}

      <View style={styles.action}>
        <ErrorBox message={error} />
        {result === null && (
          <GradientButton
            label={t('convert.action')}
            onPress={review}
            disabled={quote === null || quoting || busy || from.id === to.id}
            loading={quoting || busy}
          />
        )}
      </View>

      <AssetPickerSheet
        visible={picking !== null}
        title={picking === 'send' ? t('convert.send') : t('convert.receive')}
        items={pickerItems}
        selectedId={picking === 'send' ? from.id : picking === 'recv' ? to.id : null}
        onSelect={id => {
          const asset = assets.find(a => a.id === id)
          if (asset && picking) {
            choose(picking, asset)
          }
        }}
        onClose={() => setPicking(null)}
      />

      <AmountSheet
        visible={editing !== null}
        unit={editAsset.ticker}
        allowDecimal={editAsset.decimals > 0}
        initial={editStr}
        parse={parseConvertAmount}
        // A token is weighed and handed on in its base units, its balance included.
        {...(isBtc(editAsset)
          ? { available: sheetAvailable, onConfirm: onSheetConfirm }
          : {
              tokenBounds: {
                decimals: editAsset.decimals,
                available: sheetAvailable === undefined ? undefined : BigInt(sheetAvailable),
              },
              onConfirm: onTokenSheetConfirm,
            })}
        onClose={() => setEditing(null)}
      />

      <Sheet
        visible={reviewing && quote !== null && result === null}
        onClose={cancelReview}
        closeLabel={t('convert.cancel')}>
        {/* At the largest text sizes each figure stands under its label and the review outgrows the
            sheet's cap, so it scrolls there and Confirm stays in reach. */}
        <ScrollView contentContainerStyle={styles.confirmBody}>
          <Txt role="subheading">{t('convert.confirmTitle')}</Txt>
          <View style={styles.confirmRows}>
            <Row label={t('convert.youSend')} value={spent} />
            <Row label={t('convert.youReceive')} value={received} />
            <Row label={t('convert.rate')} value={rateLabel} />
            <Row label={t('convert.fee')} value={feeLabel} />
          </View>
          <Txt role="body" tone="muted" style={styles.confirmAsk}>
            {t('convert.sure')}
          </Txt>
          <GradientButton label={t('convert.confirm')} onPress={confirm} loading={busy} />
          <Touch onPress={cancelReview} feedback="link" hitSlop={space.sm} style={styles.cancelBtn}>
            <Txt role="bodyStrong" tone="muted">
              {t('convert.cancel')}
            </Txt>
          </Touch>
        </ScrollView>
      </Sheet>
    </Screen>
  )
}

function AmountField({
  asset,
  value,
  editable,
  fiat,
  note,
  onPickAsset,
  onPressAmount,
  accessibilityLabel,
}: {
  asset: SparkConvertAsset
  value: string
  editable: boolean
  fiat?: string | null
  note?: string
  onPickAsset: (() => void) | undefined
  onPressAmount: () => void
  accessibilityLabel: string
}): React.JSX.Element {
  const { t } = useTranslation()
  // Bitcoin's ticker here is its unit, which the line under the amount already carries. A token's
  // ticker is its unit too, so it is named once, in the selector, and the line under it holds only
  // the fiat.
  const btc = isBtc(asset)
  const name = btc ? asset.name : asset.ticker
  const line = (
    <Figure role="caption" tone="muted" tabular>
      {note ?? (fiat ? t('send.approxAmount', { amount: fiat }) : value || !editable ? '' : t('convert.tapToEnter'))}
    </Figure>
  )
  // The line that says to tap has to be what it says.
  const invitesTap = editable && !value && !fiat && note === undefined
  return (
    <View style={styles.field}>
      {/* The asset names the figure, so the two take one row by the rule every label and figure
          share, and the amount goes under the asset at a large text size. */}
      <FigureRow
        label={
          onPickAsset ? (
            <Pressable
              onPress={onPickAsset}
              accessibilityRole="button"
              accessibilityLabel={`${name}, ${t('receive.chooseAsset')}`}
              hitSlop={space.sm}
              style={({ pressed }) => [styles.selector, pressed && styles.selectorPressed]}>
              <AssetIcon assetId={iconIdOf(asset)} ticker={asset.ticker} size={FIELD_ICON} />
              <Txt role="subheading" wholeWords style={styles.selectorName}>
                {name}
              </Txt>
              <TabIcon name="chevron" color={colors.textSecondary} size={16} />
            </Pressable>
          ) : (
            <View style={styles.selector}>
              <AssetIcon assetId={iconIdOf(asset)} ticker={asset.ticker} size={FIELD_ICON} />
              <Txt role="subheading" wholeWords style={styles.selectorName}>
                {name}
              </Txt>
            </View>
          )
        }>
        <Pressable
          onPress={onPressAmount}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={accessibilityLabel}
          hitSlop={space.sm}
          style={styles.amountTrigger}>
          <Figure role="titleStrong" tone={value ? 'default' : 'muted'} tabular>
            {value ? drawAmount(asset, value) : '0'}
          </Figure>
        </Pressable>
      </FigureRow>
      <FigureRow
        label={
          btc ? (
            <Txt role="microCaps" tone="muted">
              {asset.ticker}
            </Txt>
          ) : null
        }>
        {invitesTap ? (
          <Pressable
            onPress={onPressAmount}
            accessibilityRole="button"
            accessibilityLabel={t('convert.tapToEnter')}
            hitSlop={space.sm}
            style={styles.amountTrigger}>
            {line}
          </Pressable>
        ) : (
          line
        )}
      </FigureRow>
    </View>
  )
}

// The field's two lines, the asset and its amount and the line under them, so the form keeps its
// height when the sides are read.
function AmountFieldSkeleton(): React.JSX.Element {
  return (
    <View style={styles.field}>
      <RowPrimitive spread>
        <RowPrimitive>
          <Skeleton width={FIELD_ICON} height={FIELD_ICON} borderRadius={radius.full} />
          <Skeleton width={90} height={font.size.lg} />
        </RowPrimitive>
        <Skeleton width={72} height={font.size.xxl} />
      </RowPrimitive>
      <Skeleton width={110} height={font.leading.sm} style={styles.fieldNote} />
    </View>
  )
}

// The slop reaches up and down only. Min and Max sit a gap apart, and a slop to the sides would lay
// each one's target over its neighbour.
const CHIP_SLOP = { top: space.md, bottom: space.md }

function Chip({ label, onPress }: { label: string; onPress: () => void }): React.JSX.Element {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      hitSlop={CHIP_SLOP}
      style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}>
      <Txt role="microCaps" tone="muted">
        {label}
      </Txt>
    </Pressable>
  )
}

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <FigureRow label={label}>
      <Figure role="bodyBold" tabular>
        {value}
      </Figure>
    </FigureRow>
  )
}

const FIELD_ICON = 28
const CHIP_HEIGHT = font.leading.xs + space.xs * 2

const styles = StyleSheet.create({
  label: {
    marginBottom: rhythm.sectionLabelToList,
  },
  field: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
    gap: space.sm,
  },
  // The selector keeps to its own width inside the label's share, so a tap beside it opens nothing.
  selector: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    alignSelf: 'flex-start',
    maxWidth: '100%',
  },
  selectorName: { flexShrink: 1 },
  selectorPressed: { opacity: press.dim },
  // The amount is a target of its own width, never under the minimum, beside or under the selector.
  amountTrigger: { minWidth: touch.min, maxWidth: '100%', alignItems: 'flex-end', justifyContent: 'center' },
  fieldNote: { alignSelf: 'flex-end' },
  // A chip's height as a floor, so the line stands the same when a missing price takes its chips.
  limits: {
    marginTop: space.sm,
    minHeight: CHIP_HEIGHT,
  },
  limitsStacked: {
    gap: space.sm,
  },
  hint: {
    flex: 1,
  },
  chips: { marginLeft: 'auto' },
  chip: {
    borderRadius: radius.full,
    backgroundColor: colors.surfaceVariant,
    paddingVertical: space.xs,
    paddingHorizontal: space.md,
  },
  chipPressed: { backgroundColor: colors.surface },
  swapRow: { alignItems: 'center', marginVertical: space.md },
  swapBtn: {
    width: touch.min,
    height: touch.min,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceVariant,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: { marginTop: space.xl, gap: space.md },
  // The gap the sheet puts between its children, which now sit in the scroll.
  confirmBody: { gap: space.lg },
  confirmRows: { gap: space.sm },
  confirmAsk: { textAlign: 'center' },
  cancelBtn: { alignSelf: 'center', paddingVertical: space.sm },
})
