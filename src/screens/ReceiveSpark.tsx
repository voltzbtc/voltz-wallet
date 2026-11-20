import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Modal,
  Pressable,
  Share,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native'
import { useTranslation } from 'react-i18next'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'
import {
  sparkReceive,
  sparkConversionLimits,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  type SparkReceiveMethod,
  type SparkLnAddress,
} from '../wallet/spark'
import { ensureLnAddressOrAdopt } from '../wallet/deletion'
import {
  sparkConvertAssets,
  tokenIdOf,
  iconIdOf,
  toBaseUnits,
  toBaseUnitsExact,
  formatBaseUnitsExact,
  SPARK_BTC,
  type SparkConvertAsset,
} from '../wallet/sparkConvert'
import { loadCatalog } from '../wallet/tokenPrefs'
import { formatSats, formatBtcTrim, parseAmountSat, parseConvertAmount } from '../wallet/amount'
import { bip21Address, buildBip21 } from '../wallet/bip21'
import { satsToFiat, formatFiat, localizeAmount, type FiatCurrency } from '../wallet/fiat'
import { resolveDefaultFiat } from '../wallet/deviceLocale'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { SegmentedControl } from '../components/SegmentedControl'
import { AmountSheet, type Denom } from '../components/AmountSheet'
import { AssetIcon } from '../components/AssetIcon'
import { AssetPickerSheet, type PickerItem } from '../components/AssetPickerSheet'
import { ChunkedAddress } from '../components/ChunkedAddress'
import { TabIcon } from '../components/TabIcon'
import { Skeleton } from '../components/Skeleton'
import { ensurePushRegistered, pushPromptDue } from '../wallet/pushToken'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { colors, dividerBottom, font, motion, qrFrame, qrFrameLarge, radius, rhythm, space, touch } from '../theme'
import { useAccent, useDollarMode } from '../wallet/dollarMode'
import { Screen } from '../components/Screen'
import { Sheet } from '../components/Sheet'
import { Card } from '../components/Card'
import { Row } from '../components/Row'
import { Txt } from '../components/Txt'
import { Figure } from '../components/Amount'
import { receiveStyles, RECEIVE_QR_SIZE } from '../components/receiveStyles'
import { Touch } from '../components/Touch'
import { GradientButton } from '../components/GradientButton'
import { StableReceivePanel } from '../components/StableReceivePanel'
import { ReceiveHeldByExit } from '../wallet/errors'
import { coinIconId } from '../components/stableLogos'
import { coinDisplayName } from '../wallet/crossChain'
import { BITCOIN_ASSET_ID } from '../wallet/assets'
import { byAssetOrder, USDB } from '../wallet/tokens'
import { joinLabels, joinSentences } from '../i18n/join'
import { useCloseOnLock } from '../components/UnderLock'

const QR_SIZE = RECEIVE_QR_SIZE
const ZOOM_QR = 300
const ZOOM_CARD = ZOOM_QR + space.xl * 2

type UiRail = 'spark' | 'bitcoin' | 'lightning'
// What is being received comes first, bitcoin or a stablecoin. Bitcoin opens on Lightning, the rail a
// person shares by name, and the other two wait under More options.
type ReceiveAsset = 'bitcoin' | 'stable'
// A pegged Spark token (USDB, DePix) lives on Spark alone and is received like any Spark payment;
// USDT and USDC are paid in on another chain. The stable choice is keyed by the token identifier or
// by the coin, which is also how the picker keys its rows.
type CrossChainCoin = 'USDT' | 'USDC'
const CROSS_CHAIN_COINS: CrossChainCoin[] = ['USDT', 'USDC']
// "Not now" on the alerts explanation, kept for this run of the app only, so a later launch explains
// again until the system has asked once.
let alertsDeferred = false

const isCrossChainCoin = (key: string): key is CrossChainCoin =>
  (CROSS_CHAIN_COINS as string[]).includes(key)

// A sheet dismissed or refused by the system has nothing to say to the person, who stays on the screen.
function share(message: string): void {
  Share.share({ message }).catch(() => undefined)
}

// Shared by both sides. A button's label replaces its text for a screen reader, so the choice rides in
// the label.
function AssetChoiceRow({
  label,
  iconId,
  onPress,
}: {
  label: string
  iconId: string
  onPress: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Touch
      onPress={onPress}
      feedback="link"
      label={joinLabels(t, [label, t('receive.chooseAsset')])}
      style={receiveStyles.pickerRow}>
      <Txt role="caption" tone="muted">
        {t('receive.asset')}
      </Txt>
      <Row gap="sm">
        <AssetIcon assetId={iconId} ticker={label} size={20} />
        <Txt role="bodyBold">{label}</Txt>
        <TabIcon name="chevron" color={colors.textSecondary} size={16} />
      </Row>
    </Touch>
  )
}

// Lightning is the screen's own rail, so the sheet offers it only as the way back from the other two.
function RailOptions({
  visible,
  rail,
  onSelect,
  onClose,
}: {
  visible: boolean
  rail: UiRail
  onSelect: (next: UiRail) => void
  onClose: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const rows: { value: UiRail; label: string }[] = [
    { value: 'lightning', label: t('receive.optionLightning') },
    { value: 'bitcoin', label: t('receive.optionBitcoin') },
    { value: 'spark', label: t('receive.optionSpark') },
  ]
  return (
    <Sheet visible={visible} onClose={onClose} closeLabel={t('common.close')}>
      <Txt role="subheading">{t('receive.moreOptions')}</Txt>
      <View>
        {rows
          .filter(row => row.value !== 'lightning' || rail !== 'lightning')
          .map(row => (
            <Touch
              key={row.value}
              onPress={() => onSelect(row.value)}
              feedback="row"
              state={row.value === rail ? { selected: true } : undefined}
              style={styles.optionRow}>
              <Txt role="body">{row.label}</Txt>
              {row.value === rail ? <TabIcon name="check" color={accent} size={20} /> : null}
            </Touch>
          ))}
      </View>
    </Sheet>
  )
}

// Receives BTC over Lightning, on-chain, or the wallet's Spark address, which also bills tokens, and
// USDT/USDC paid in on another chain.
// `heldAtPress` asks again whether an emergency exit holds the wallet, before a code leaves the screen
// by Copy or Share. ReceiveScreen hands it in; it answers true when the wallet is held.
export function ReceiveSpark({
  heldAtPress,
  onHeld,
}: {
  heldAtPress?: () => Promise<boolean>
  // Told when spark.ts refuses a code because an exit holds the wallet, so the screen says why.
  onHeld?: (hold: 'exit' | 'unread') => void
} = {}): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  // Read on every render, so the zoomed code still flies from its place after a rotation or a split
  // screen resize.
  const screen = useWindowDimensions()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList, 'Receive'>>()
  const route = useRoute<RouteProp<RootStackParamList, 'Receive'>>()
  const [receiveAsset, setReceiveAsset] = useState<ReceiveAsset>('bitcoin')
  // A token never rides Lightning, so a screen opened for one starts on Spark and mints no invoice
  // on the way to learning which token it is.
  const [pickedRail, setUiRail] = useState<UiRail>(() => {
    const wanted = route.params?.assetId
    return wanted !== undefined && wanted !== BITCOIN_ASSET_ID ? 'spark' : 'lightning'
  })
  // Opens on USDB, which needs no amount, so the stable side starts on a usable address.
  const [stableKey, setStableKey] = useState<string>(USDB.identifier)
  // What the header shares on the cross-chain side, which owns its own quote.
  const [stableShare, setStableShare] = useState<string | null>(null)
  // The known tokens show at zero balance, since a token can be received before it is held.
  const [assets, setAssets] = useState<SparkConvertAsset[]>(() => sparkConvertAssets([]))
  const [asset, setAsset] = useState<SparkConvertAsset>(SPARK_BTC)
  // The wallet read that names a token can land after a rail was picked, so the rail follows the asset
  // rather than the order of the writes.
  const uiRail: UiRail = tokenIdOf(asset) === undefined ? pickedRail : 'spark'
  const [picking, setPicking] = useState(false)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [destination, setDestination] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [lnAddr, setLnAddr] = useState<SparkLnAddress | null>(null)
  const [lnLoaded, setLnLoaded] = useState(false)
  const [alertsOffer, setAlertsOffer] = useState(false)
  const [alertsOpen, setAlertsOpen] = useState(false)
  // The value a copy took, so a code that changes under the label never reads as copied.
  const [copiedValue, setCopiedValue] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [amountDenom, setAmountDenom] = useState<Denom>('sats')
  // The rate a typed fiat value was read at, kept with it so the figure never moves on its own and is
  // never drawn in another currency.
  const [amountRate, setAmountRate] = useState<{ rate: number; currency: FiatCurrency } | null>(null)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [zoomOpen, setZoomOpen] = useState(false)
  // The zoomed code is a window over the app, so the PIN asked again closes it at once, with no flight
  // back that would play over the lock.
  const underLock = useCloseOnLock(zoomOpen, () => setZoomOpen(false))
  const [fiatRate, setFiatRate] = useState<number | null>(null)
  const [onchainFeeSat, setOnchainFeeSat] = useState(0)
  const [dollarMinSat, setDollarMinSat] = useState<number | null>(null)
  const dollarMode = useDollarMode()
  const [fiatCurrency, setFiatCurrency] = useState<FiatCurrency>(resolveDefaultFiat(i18n.language))
  const [usdRate, setUsdRate] = useState<number | null>(null)
  // Decided when the sheet opens: dollars for a dollar wallet whose rate is in. A rate landing later
  // waits for the next opening, or the sheet's fiat unit would change under what is being typed.
  const [sheetInDollars, setSheetInDollars] = useState(false)
  const cache = useRef(new Map<string, string>()).current
  // Switching rail or amount overlaps the awaited sparkReceive calls, so only the latest may commit.
  const genSeq = useRef(0)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const qrRef = useRef<View>(null)
  const [source, setSource] = useState<{ cx: number; cy: number; size: number } | null>(null)
  const zoom = useRef(new Animated.Value(0)).current
  // Under reduced motion the enlarged code fades in and out where it is drawn, without the flight.
  const reduced = useReduceMotion()

  const crossChainCoin = receiveAsset === 'stable' && isCrossChainCoin(stableKey) ? stableKey : null
  // A pegged token is a stablecoin, so it is chosen on the stable side and the Bitcoin side's Spark
  // rail offers only the rest.
  const stableAssets = assets.filter(item => item.fiatId !== undefined)
  const bitcoinSideAssets = assets.filter(item => item.fiatId === undefined)

  // Unified Bitcoin folds two legs into one BIP21, the other tabs use a single SDK method.
  const unified = uiRail === 'bitcoin'

  // Without an answer no minimum is named, since a guessed figure would be a claim about money.
  useEffect(() => {
    if (!dollarMode || !unified) {
      return
    }
    let alive = true
    sparkConversionLimits(undefined, USDB.identifier).then(
      limits => alive && setDollarMinSat(limits.minFromBaseUnits ?? null),
      () => alive && setDollarMinSat(null),
    )
    return () => {
      alive = false
    }
  }, [dollarMode, unified])
  const rail: SparkReceiveMethod = uiRail === 'spark' ? 'spark' : 'lightning'

  const isBtcAsset = asset.id === SPARK_BTC.id
  const sheetRate = sheetInDollars ? usdRate : fiatRate
  const sheetCurrency = sheetInDollars ? 'USD' : fiatCurrency
  // Base units of the asset, which is what the SDK bills in: sats for Bitcoin, and a token's read from
  // its typed figure exactly, since a double carries about 15 significant digits and a token up to 18
  // places.
  const typedAmount = amount.trim() !== ''
  const amountBase = typedAmount && isBtcAsset ? toBaseUnits(amount, asset.decimals) : undefined
  const tokenBase = typedAmount && !isBtcAsset ? toBaseUnitsExact(amount, asset.decimals) : null
  const satsAmount = amountBase !== undefined && amountBase > 0
  const hasAmount = satsAmount || tokenBase !== null
  const dollarAmount = satsAmount && amountDenom === 'fiat' && amountRate?.currency === 'USD' && dollarMode
  // Only the on-chain rail carries no amount, since a Bitcoin address cannot lock a value.
  const billsAmount = rail === 'lightning' || rail === 'spark'
  const receiveSats = billsAmount && satsAmount ? amountBase : undefined
  const receiveAmount = billsAmount && tokenBase !== null ? tokenBase : receiveSats
  // The token rides along only with an amount, since the amountless Spark address already takes every token.
  const receiveToken = receiveAmount === undefined ? undefined : tokenIdOf(asset)

  // Amountless Lightning shows the fixed @, with the LNURL in the QR so any wallet can scan it.
  const showLnAddress = uiRail === 'lightning' && !hasAmount && lnAddr !== null
  const qrValue = showLnAddress && lnAddr ? lnAddr.lnurl : destination
  // An amountless on-chain code keeps its BIP21 in the QR, while what is read, copied and shared is
  // the address alone, which is what a paste field takes. With an amount the URI is the request.
  const bareOnchain = unified && !hasAmount && destination !== null
  const displayValue =
    showLnAddress && lnAddr
      ? lnAddr.address
      : bareOnchain
      ? bip21Address(destination)
      : destination
  // A bech32 address groups into 4s, while an invoice, an @ or a BIP21 URI stays on one line.
  const chunked = uiRail === 'spark' || (unified && !hasAmount)
  const copied = copiedValue !== null && copiedValue === displayValue
  // A name reads well in a chat and the LNURL reaches a wallet that has no lightning addresses, so
  // the message carries both, the name first.
  const shareValue = showLnAddress && lnAddr ? `${lnAddr.address}\n${lnAddr.lnurl}` : displayValue

  const generate = useCallback(
    async (method: SparkReceiveMethod, base?: number | bigint, token?: string) => {
      const seq = ++genSeq.current
      // The token belongs in the key, since an invoice for 10 USDB and one for 10 sats are asked for alike.
      const key = `${method}|${base ?? ''}|${token ?? ''}`
      const cached = cache.get(key)
      if (cached) {
        setDestination(cached)
        setFailed(false)
        return
      }
      setDestination(null)
      setFailed(false)
      try {
        const quote = await sparkReceive(method, base, undefined, token)
        cache.set(key, quote.destination)
        if (seq === genSeq.current) {
          setDestination(quote.destination)
        }
      } catch (cause) {
        if (cause instanceof ReceiveHeldByExit) {
          onHeld?.(cause.hold)
        }
        if (seq === genSeq.current) {
          setFailed(true)
        }
      }
    },
    [cache, genSeq, onHeld],
  )

  // Draws both legs in parallel and folds them into one BIP21 URI, keyed apart from the single-method rails.
  const generateUnified = useCallback(
    async (base?: number) => {
      const seq = ++genSeq.current
      const key = `unified|${base ?? ''}`
      const cached = cache.get(key)
      if (cached) {
        setDestination(cached)
        setFailed(false)
        return
      }
      setDestination(null)
      setFailed(false)
      try {
        if (base === undefined) {
          // A bolt11 expires and there is no BOLT12, so an amountless request pairs the address with Spark.
          const [onchain, spark] = await Promise.all([
            sparkReceive('onchain'),
            sparkReceive('spark'),
          ])
          const uri = buildBip21({ address: onchain.destination, spark: spark.destination })
          cache.set(key, uri)
          if (seq === genSeq.current) {
            setOnchainFeeSat(onchain.feeSat)
            setDestination(uri)
          }
          return
        }
        const [onchain, lightning, spark] = await Promise.all([
          sparkReceive('onchain'),
          sparkReceive('lightning', base),
          sparkReceive('spark'),
        ])
        const uri = buildBip21({
          address: onchain.destination,
          amountSat: base,
          lightning: lightning.destination,
          spark: spark.destination,
        })
        cache.set(key, uri)
        if (seq === genSeq.current) {
          setOnchainFeeSat(onchain.feeSat)
          setDestination(uri)
        }
      } catch (cause) {
        if (cause instanceof ReceiveHeldByExit) {
          onHeld?.(cause.hold)
        }
        if (seq === genSeq.current) {
          setFailed(true)
        }
      }
    },
    [cache, genSeq, onHeld],
  )

  // The code for the rail and amount on screen. Try again calls the same path, so a retry passes
  // through genSeq like any other request and an answer to a request it superseded never shows.
  const regenerate = useCallback(() => {
    // A cross-chain receive quotes on its own, and minting an invoice for it would be wasted.
    if (crossChainCoin) {
      return
    }
    if (unified) {
      generateUnified(receiveSats)
      return
    }
    if (rail === 'lightning' && !hasAmount && (!lnLoaded || lnAddr)) {
      // No code is asked for here, so a previous rail's request is dropped along with what it left: a
      // late answer, a failure or a code would otherwise stand in for the address.
      genSeq.current += 1
      setDestination(null)
      setFailed(false)
      return
    }
    generate(rail, receiveAmount, receiveToken)
  }, [
    crossChainCoin,
    unified,
    rail,
    receiveSats,
    receiveAmount,
    receiveToken,
    hasAmount,
    lnLoaded,
    lnAddr,
    generate,
    generateUnified,
  ])

  useEffect(() => {
    regenerate()
  }, [regenerate])

  useEffect(() => {
    let alive = true
    // The catalog brings a token that was added but is not held yet, such as DePix before the first one.
    Promise.all([sparkGetWalletInfo(), loadCatalog().catch(() => undefined)])
      .then(([info, catalog]) => {
        if (!alive) {
          return
        }
        const pickable = sparkConvertAssets(info.tokens, catalog)
        setAssets(pickable)
        const wanted = route.params?.assetId
        if (wanted) {
          const preselected = pickable.find(item => iconIdOf(item) === wanted)
          if (preselected) {
            // Opened from a stablecoin's own screen, the receive opens where that coin is chosen.
            if (preselected.fiatId !== undefined) {
              setReceiveAsset('stable')
              setStableKey(preselected.id)
            }
            setAsset(preselected)
          }
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [route.params?.assetId])

  const mounted = useRef(true)
  const loadAddress = useCallback(() => {
    ensureLnAddressOrAdopt()
      .then(addr => {
        if (!mounted.current) {
          return
        }
        // An empty answer never clears an address already shown.
        setLnAddr(current => addr ?? current)
        // Registers silently when notifications are already allowed. The system dialog is never
        // shown from here on its own: while it is still to come, the card below explains it, and
        // only its button asks. Failures stay silent because receiving works without it; the
        // payment lands either way.
        ensurePushRegistered(false)
          .catch(() => false)
          .then(() => (addr && !alertsDeferred ? pushPromptDue() : false))
          .then(due => {
            if (mounted.current && due && !alertsDeferred) {
              setAlertsOffer(true)
            }
          })
          .catch(() => undefined)
      })
      .catch(() => undefined)
      .finally(() => mounted.current && setLnLoaded(true))
  }, [])

  useEffect(() => {
    mounted.current = true
    loadAddress()
    return () => {
      mounted.current = false
    }
  }, [loadAddress])

  // With no address to show the rail fell back to an invoice, so a failure there asks for the address
  // first: it is what the screen opened for, and the invoice follows only if it still has none.
  function retry() {
    if (uiRail === 'lightning' && !hasAmount && lnAddr === null) {
      setLnLoaded(false)
      loadAddress()
      return
    }
    regenerate()
  }

  useEffect(() => {
    let alive = true
    ;(async () => {
      const currency = await resolveDisplayCurrency(i18n.language)
      const coins = Array.from(new Set([currency, 'USD']))
      const rates = await sparkGetFiatRates(coins).catch(() => ({} as Record<string, number>))
      if (alive && rates.USD !== undefined) {
        setUsdRate(rates.USD)
      }
      if (alive && rates[currency] !== undefined) {
        setFiatCurrency(currency)
        setFiatRate(rates[currency])
      }
    })()
    return () => {
      alive = false
    }
  }, [i18n.language])

  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    [],
  )

  // The cross-chain panel has no buttons of its own under a QR, so the header shares for it.
  useLayoutEffect(() => {
    navigation.setOptions({
      // eslint-disable-next-line react/no-unstable-nested-components
      headerRight: () =>
        crossChainCoin && stableShare ? (
          <Pressable
            onPress={() =>
              heldAtPress
                ? heldAtPress().then(
                    held => !held && share(stableShare),
                    () => undefined,
                  )
                : share(stableShare)
            }
            hitSlop={space.md}
            accessibilityRole="button"
            accessibilityLabel={t('receive.share')}>
            <TabIcon name="share" color={colors.text} size={22} />
          </Pressable>
        ) : undefined,
    })
  }, [navigation, crossChainCoin, stableShare, heldAtPress, t])

  // What the press acted on is what goes out, even when the read answers after the code moved on.
  function unlessHeld(act: () => void): void {
    if (!heldAtPress) {
      act()
      return
    }
    heldAtPress().then(
      held => !held && act(),
      () => undefined,
    )
  }

  function copy() {
    if (!displayValue) {
      return
    }
    const value = displayValue
    unlessHeld(() => copyValue(value))
  }

  function copyValue(value: string) {
    Clipboard.setString(value)
    setCopiedValue(value)
    // The check mark is visual only; a screen reader hears nothing unless told.
    AccessibilityInfo.announceForAccessibility(t('receive.copied'))
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopiedValue(null), 2000)
  }

  // Any tap on the card is the one time it is answered here: the system asks once, and after that
  // only its settings change the answer.
  // The sheet closes with the offer, or an offer that comes back on this mount would open it unasked.
  function turnOnAlerts() {
    setAlertsOffer(false)
    setAlertsOpen(false)
    ensurePushRegistered(true).catch(() => undefined)
  }

  function deferAlerts() {
    alertsDeferred = true
    setAlertsOffer(false)
    setAlertsOpen(false)
  }

  function confirmAmount(value: number | undefined, denom?: Denom) {
    setSheetOpen(false)
    setAmount(value === undefined ? '' : String(value))
    setAmountDenom(denom ?? 'sats')
    setAmountRate(denom === 'fiat' && sheetRate !== null ? { rate: sheetRate, currency: sheetCurrency } : null)
  }

  // A token comes back in its base units as typed and is kept as its exact figure, never a double.
  function confirmTokenAmount(base: bigint | undefined) {
    setSheetOpen(false)
    setAmount(base === undefined ? '' : formatBaseUnitsExact(base, asset.decimals))
    setAmountDenom('sats')
    setAmountRate(null)
  }

  function openSheet() {
    setSheetInDollars(dollarMode && isBtcAsset && usdRate !== null)
    setSheetOpen(true)
  }

  // Changing asset drops the typed amount, since the same digits mean a different value per asset.
  function applyAsset(next: SparkConvertAsset) {
    if (next.id === asset.id) {
      return
    }
    setAsset(next)
    setAmount('')
    setAmountDenom('sats')
  }

  // A pegged token is billed on the Spark rail, as any token is; a cross-chain coin has its own panel.
  // The whole side sits on Spark, and a cross-chain coin's panel does not read the rail.
  function enterStable(key: string) {
    setUiRail('spark')
    applyAsset(stableAssets.find(item => item.id === key) ?? SPARK_BTC)
  }

  // Bitcoin always reopens on Lightning, so the Spark rail never outlives the token that asked for it.
  function selectReceiveAsset(next: ReceiveAsset) {
    setReceiveAsset(next)
    if (next === 'bitcoin') {
      setUiRail('lightning')
      applyAsset(SPARK_BTC)
    } else {
      enterStable(stableKey)
    }
  }

  function selectStable(key: string) {
    setStableKey(key)
    enterStable(key)
  }

  // A bolt11 and an on-chain address cannot carry a token, so leaving the Spark rail returns to Bitcoin.
  function selectRail(next: UiRail) {
    setOptionsOpen(false)
    setUiRail(next)
    if (next !== 'spark') {
      applyAsset(SPARK_BTC)
    }
  }

  function openZoom() {
    qrRef.current?.measureInWindow((x, y, width) => {
      setSource({ cx: x + width / 2, cy: y + width / 2, size: width })
      setZoomOpen(true)
    })
  }
  function closeZoom() {
    Animated.timing(zoom, { toValue: 0, duration: motion.fast, useNativeDriver: true }).start(() =>
      setZoomOpen(false),
    )
  }
  useEffect(() => {
    if (zoomOpen) {
      zoom.setValue(0)
      Animated.timing(zoom, { toValue: 1, duration: motion.base, useNativeDriver: true }).start()
    }
  }, [zoomOpen, zoom])

  // "Receive anytime" is said only of the fixed address on screen, and nothing is said while the read
  // that decides it is in flight. An amount, or no address at all, makes the code an invoice good for
  // one payment.
  const hint = unified
    ? t('receive.hintBitcoin')
    : uiRail === 'lightning'
    ? showLnAddress
      ? t('receive.hintSparkLightning')
      : lnLoaded || hasAmount
      ? t('receive.hintInvoice')
      : null
    : hasAmount
    ? t('receive.hintInvoice')
    : isBtcAsset
    ? t('receive.hintSpark')
    : t('receive.hintSparkToken', { ticker: asset.ticker })

  function amountLabel(): string {
    if (tokenBase !== null) {
      return `${localizeAmount(formatBaseUnitsExact(tokenBase, asset.decimals))} ${asset.ticker}`
    }
    if (!satsAmount) {
      return isBtcAsset
        ? t('receive.addAmount')
        : t('receive.amountToken', { ticker: asset.ticker })
    }
    if (amountDenom === 'fiat' && amountRate !== null) {
      const typed = formatFiat(satsToFiat(amountBase, amountRate.rate), amountRate.currency)
      // The invoice fixes sats, so a dollar figure is what those sats are worth at this rate.
      return dollarAmount ? t('receive.approxFiat', { amount: typed }) : typed
    }
    return amountDenom === 'btc'
      ? `${localizeAmount(formatBtcTrim(amountBase))} BTC`
      : t('receive.sats', { amount: formatSats(amountBase) })
  }
  // Gated to Lightning because satsToFiat reads sats, while the Spark rail can hold a token's base units.
  // A typed amount is priced at its own rate, and a rate in the same currency says nothing new.
  const amountFiatRate = amountDenom === 'fiat' && amountRate !== null ? amountRate.rate : fiatRate
  const amountFiatCurrency = amountDenom === 'fiat' && amountRate !== null ? amountRate.currency : fiatCurrency
  const amountFiat =
    rail === 'lightning' && satsAmount && amountFiatRate !== null
      ? formatFiat(satsToFiat(amountBase, amountFiatRate), amountFiatCurrency)
      : null

  // Bitcoin reads by name here, since its ticker in this model is the unit sats rather than a name.
  const assetLabel = isBtcAsset ? asset.name : asset.ticker
  const bitcoinItems: PickerItem[] = bitcoinSideAssets.map(item => ({
    assetId: iconIdOf(item),
    ticker: item.ticker,
    name: item.name,
  }))
  const stableItems: PickerItem[] = [
    ...stableAssets.map(item => ({ assetId: item.id, ticker: item.ticker, name: item.name })),
    ...CROSS_CHAIN_COINS.map(coin => ({
      assetId: coin,
      iconId: coinIconId(coin),
      ticker: coin,
      name: coinDisplayName(coin),
    })),
  ].sort((a, b) => byAssetOrder(a.assetId, b.assetId))
  const stableToken = stableAssets.find(item => item.id === stableKey)
  const stableLabel = stableToken ? stableToken.ticker : stableKey
  const stableIconId = stableToken ? stableToken.id : coinIconId(stableKey)

  return (
    <Screen scroll layout="padded" contentStyle={styles.container}>
      {/* What arrives and how much, one group above the code. */}
      <View style={styles.group}>
        <SegmentedControl<ReceiveAsset>
          options={[
            { label: t('receive.assetBitcoin'), value: 'bitcoin' },
            { label: t('receive.assetStable'), value: 'stable' },
          ]}
          value={receiveAsset}
          onChange={selectReceiveAsset}
        />

        {/* The coin comes before its network, picked from the same asset row the Bitcoin side uses. */}
        {receiveAsset === 'stable' && (
          <AssetChoiceRow
            label={stableLabel}
            iconId={stableIconId}
            onPress={() => setPicking(true)}
          />
        )}

        {/* A row with nothing to choose from is not drawn. */}
        {!crossChainCoin && receiveAsset === 'bitcoin' && uiRail === 'spark' && bitcoinSideAssets.length > 1 && (
          <AssetChoiceRow
            label={assetLabel}
            iconId={iconIdOf(asset)}
            onPress={() => setPicking(true)}
          />
        )}

        {crossChainCoin ? null : hint === null ? (
          <Skeleton width={QR_SIZE} height={font.leading.sm} style={styles.hintSkeleton} />
        ) : (
          <Txt role="caption" tone="muted" style={styles.hint}>
            {hint}
          </Txt>
        )}

        {/* The row is a line of text, so its own box falls under the 44pt target. */}
        {!crossChainCoin && billsAmount && (
          <Touch
            onPress={openSheet}
            feedback="link"
            hitSlop={space.sm}
            style={receiveStyles.addAmount}>
            <TabIcon name={hasAmount ? 'edit' : 'plus'} color={accent} size={18} />
            <Figure role="bodyBold" tone="accent">
              {amountLabel()}
            </Figure>
          </Touch>
        )}
      </View>

      {crossChainCoin ? (
        <StableReceivePanel coin={crossChainCoin} onShareable={setStableShare} heldAtPress={heldAtPress} />
      ) : (
        <View style={styles.group}>
          {failed ? (
            <Card centered gap="md" style={receiveStyles.card}>
              <Txt role="label" tone="danger" style={styles.failed}>
                {t('receive.failed')}
              </Txt>
              <GradientButton label={t('common.retry')} variant="secondary" onPress={retry} />
            </Card>
          ) : qrValue !== null && displayValue !== null ? (
            <Card centered style={receiveStyles.card}>
              <Touch ref={qrRef} onPress={openZoom} feedback="surface" label={t('receive.enlargeQr')} style={styles.qrWrap}>
                <QRCode value={qrValue} size={QR_SIZE} />
              </Touch>
              <View style={receiveStyles.addressBlock}>
                <ChunkedAddress value={displayValue} chunked={chunked} />
              </View>
              {/* The fixed address alone, since a one-time invoice has no name to change. */}
              {showLnAddress && (
                <Touch
                  onPress={() => navigation.navigate('LnAddress', { choose: true })}
                  feedback="link"
                  hitSlop={space.sm}>
                  <Txt role="label" tone="accent">
                    {t('receive.lnChange')}
                  </Txt>
                </Touch>
              )}
              {dollarAmount ? (
                <Figure role="caption" tone="muted" style={styles.fiat}>
                  {t('receive.sats', { amount: formatSats(amountBase) })}
                </Figure>
              ) : amountFiat ? (
                <Figure role="caption" tone="muted" style={styles.fiat}>
                  {t('receive.approxFiat', { amount: amountFiat })}
                </Figure>
              ) : null}
            </Card>
          ) : (
            <Card centered style={receiveStyles.card}>
              {/* Mirrors the ready card so the layout does not grow when the destination resolves. */}
              <Skeleton
                width={QR_SIZE + space.md * 2}
                height={QR_SIZE + space.md * 2}
                borderRadius={radius.md}
              />
              <View style={receiveStyles.addressBlock}>
                <Skeleton width={QR_SIZE} height={font.leading.sm} />
                <Skeleton width={QR_SIZE * 0.55} height={font.leading.xs} />
              </View>
            </Card>
          )}

          {/* Off until a code is on screen, so the row holds its place and acts only on what is shown.
              A failed code has a retry instead, and nothing to act on. */}
          {!failed && (
            <Row gap="sm">
              <View style={styles.action}>
                <GradientButton
                  label={copied ? t('receive.copied') : t('receive.copy')}
                  variant="secondary"
                  singleLine
                  disabled={displayValue === null}
                  icon={<TabIcon name={copied ? 'check' : 'copy'} color={copied ? accent : colors.text} size={18} />}
                  onPress={copy}
                />
              </View>
              <View style={styles.action}>
                <GradientButton
                  label={t('receive.share')}
                  variant="secondary"
                  singleLine
                  disabled={shareValue === null}
                  icon={<TabIcon name="share" color={colors.text} size={18} />}
                  onPress={() => {
                    const value = shareValue
                    if (value) {
                      unlessHeld(() => share(value))
                    }
                  }}
                />
              </View>
            </Row>
          )}

          {/* Only for the code that names a Bitcoin address, since no other rail pays this way. */}
          {unified && qrValue !== null && !failed && (
            <Txt role="caption" tone="muted" style={styles.centered}>
              {joinSentences(t, [
                onchainFeeSat > 0
                  ? t('receive.onchainFeeAmount', { amount: formatSats(onchainFeeSat) })
                  : t('receive.onchainFeeNote'),
                dollarMode && dollarMinSat !== null && dollarMinSat > 0
                  ? t('receive.dollarMinimum', { amount: formatSats(dollarMinSat) })
                  : null,
              ])}
            </Txt>
          )}

          {/* Outside the card, so a code still loading or failed never takes the other rails away. */}
          {receiveAsset === 'bitcoin' && (
            <Touch
              onPress={() => setOptionsOpen(true)}
              feedback="link"
              hitSlop={space.sm}
              style={receiveStyles.addAmount}>
              <Txt role="label" tone="muted">
                {t('receive.moreOptions')}
              </Txt>
              <TabIcon name="chevron" color={colors.textSecondary} size={16} />
            </Touch>
          )}
        </View>
      )}

      {/* A quiet line, so what this screen is for stays its strongest thing and on screen. */}
      {alertsOffer && (
        <Touch
          onPress={() => setAlertsOpen(true)}
          feedback="link"
          hitSlop={space.sm}
          style={receiveStyles.addAmount}>
          <TabIcon name="bell" color={colors.textSecondary} size={16} />
          <Txt role="label" tone="muted">
            {t('receive.pushPromptTitle')}
          </Txt>
          <TabIcon name="chevron" color={colors.textSecondary} size={16} />
        </Touch>
      )}

      <Sheet visible={alertsOffer && alertsOpen} onClose={() => setAlertsOpen(false)} closeLabel={t('common.close')}>
        <Txt role="subheading">{t('receive.pushPromptTitle')}</Txt>
        <Txt role="caption" tone="muted">
          {t('receive.pushPromptBody')}
        </Txt>
        <GradientButton label={t('receive.pushPromptAllow')} onPress={turnOnAlerts} />
        <Touch onPress={deferAlerts} feedback="link">
          <Txt role="label" tone="muted" style={styles.centered}>
            {t('receive.pushPromptLater')}
          </Txt>
        </Touch>
      </Sheet>

      {/* The sheet speaks the asset's own unit, and a token has no sats or fiat view, so both toggles stay off. */}
      <AmountSheet
        visible={sheetOpen}
        unit={isBtcAsset ? 'sats' : asset.ticker}
        allowDecimal={asset.decimals > 0}
        satsBtcToggle={isBtcAsset}
        fiatRate={isBtcAsset ? sheetRate ?? undefined : undefined}
        fiatCurrency={sheetCurrency}
        initialDenom={sheetInDollars ? 'fiat' : undefined}
        initial={amount}
        parse={isBtcAsset ? parseAmountSat : parseConvertAmount}
        // A token is handed on in its base units, exactly as typed.
        {...(isBtcAsset
          ? { onConfirm: confirmAmount }
          : { tokenBounds: { decimals: asset.decimals }, onConfirm: confirmTokenAmount })}
        onClose={() => setSheetOpen(false)}
      />

      <AssetPickerSheet
        visible={picking}
        title={t('receive.chooseAsset')}
        items={receiveAsset === 'stable' ? stableItems : bitcoinItems}
        // A cross-chain coin is billed by its panel while the Spark asset stays Bitcoin, so the coin is
        // the choice there; a token is the asset the invoice names. Each side keys its items its own way.
        selectedId={receiveAsset === 'stable' ? crossChainCoin ?? asset.id : iconIdOf(asset)}
        onSelect={id => {
          if (receiveAsset === 'stable') {
            selectStable(id)
          } else {
            // Bitcoin-side items are keyed by the display id (iconIdOf), so map back through it.
            const next = assets.find(item => iconIdOf(item) === id)
            if (next) {
              applyAsset(next)
            }
          }
          setPicking(false)
        }}
        onClose={() => setPicking(false)}
      />

      <RailOptions
        visible={optionsOpen}
        rail={uiRail}
        onSelect={selectRail}
        onClose={() => setOptionsOpen(false)}
      />

      <Modal visible={zoomOpen && !underLock} transparent animationType="none" onRequestClose={closeZoom}>
        <Animated.View style={[styles.zoomBackdrop, { opacity: zoom }]}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel={t('common.close')}
            onPress={closeZoom}
          />
          {qrValue && source && (
            <Animated.View
              style={[
                styles.zoomCard,
                !reduced && {
                  transform: [
                    {
                      translateX: zoom.interpolate({
                        inputRange: [0, 1],
                        outputRange: [source.cx - screen.width / 2, 0],
                      }),
                    },
                    {
                      translateY: zoom.interpolate({
                        inputRange: [0, 1],
                        outputRange: [source.cy - screen.height / 2, 0],
                      }),
                    },
                    {
                      scale: zoom.interpolate({
                        inputRange: [0, 1],
                        outputRange: [source.size / ZOOM_CARD, 1],
                      }),
                    },
                  ],
                },
              ]}>
              <QRCode value={qrValue} size={ZOOM_QR} />
            </Animated.View>
          )}
        </Animated.View>
      </Modal>
    </Screen>
  )
}

const styles = StyleSheet.create({
  container: {
    gap: rhythm.section,
  },
  // A gap rather than per-element margins, since the asset row shows only on the Spark tab.
  group: {
    gap: space.sm,
  },
  // A line about the code below, so it leaves the control by the rhythm and centres with the rest.
  hint: {
    marginTop: rhythm.hintToContent - space.sm,
    textAlign: 'center',
  },
  hintSkeleton: {
    marginTop: rhythm.hintToContent - space.sm,
    alignSelf: 'center',
  },
  qrWrap: qrFrame,
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: touch.selector,
    paddingVertical: space.md,
    // Cancelling the sheet padding and adding it back inside runs the highlight to the edges.
    marginHorizontal: -space.xl,
    paddingHorizontal: space.xl,
    ...dividerBottom,
  },
  failed: {
    textAlign: 'center',
  },
  centered: {
    textAlign: 'center',
  },
  // Half the row each, so a long translation of one never pushes the other out.
  action: {
    flex: 1,
  },
  fiat: {
    marginTop: space.sm,
    textAlign: 'center',
  },
  zoomBackdrop: {
    flex: 1,
    backgroundColor: colors.scrimStrong,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomCard: qrFrameLarge,
})
