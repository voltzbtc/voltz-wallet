import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import QRCode from 'react-native-qrcode-svg'
import Clipboard from '@react-native-clipboard/clipboard'
import {
  sparkListReceiveRoutes,
  sparkReceiveStable,
  type SparkReceiveRoute,
  type SparkStableReceive,
} from '../wallet/spark'
import { chainDisplayName } from '../wallet/crossChain'
import { USDB } from '../wallet/tokens'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { formatSats, parseConvertAmount } from '../wallet/amount'
import { formatBaseUnitsExact, fromBaseUnits, roundBaseUnits, toBaseUnitsExact } from '../wallet/sparkConvert'
import { loadLastReceiveRoute, saveLastReceiveRoute } from '../wallet/settings'
import { useAccent, useDollarMode } from '../wallet/dollarMode'
import { localizeAmount } from '../wallet/fiat'
import { AmountSheet } from './AmountSheet'
import { AssetIcon } from './AssetIcon'
import { AssetPickerSheet, type PickerItem } from './AssetPickerSheet'
import { ChunkedAddress } from './ChunkedAddress'
import { GradientButton } from './GradientButton'
import { Skeleton } from './Skeleton'
import { TabIcon } from './TabIcon'
import { Card } from './Card'
import { Notice } from './Notice'
import { Row } from './Row'
import { Txt } from './Txt'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { receiveStyles, RECEIVE_QR_SIZE } from './receiveStyles'
import { Touch } from './Touch'
import { chainIconId } from './stableLogos'
import { formatClock } from '../wallet/clock'
import { colors, dividerBottom, font, qrFrame, radius, space, touch } from '../theme'

type Props = {
  /** USDT or USDC, chosen by the screen alongside USDB. */
  coin: string
  /** What the header's share button sends, or null while there is nothing to share. */
  onShareable: (text: string | null) => void
  /** Asks again, at the press of Copy, whether an emergency exit holds the wallet. */
  heldAtPress?: () => Promise<boolean>
}

// USDT or USDC paid in on another chain, converted and delivered to this wallet by the provider. The
// coin comes first and then its network, the way a sender picks them in an exchange. The SDK mints no
// address without an amount, so nothing is quoted until one is typed, and each quote is a single-use
// address with a short price, so none is cached.
export function StableReceivePanel({ coin, onShareable, heldAtPress }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { accent } = useAccent()
  const dollarMode = useDollarMode()
  const [routes, setRoutes] = useState<SparkReceiveRoute[] | null>(null)
  // A list that failed to load is told apart from one that loaded empty, and can be asked for again.
  const [routesFailed, setRoutesFailed] = useState(false)
  const [reload, setReload] = useState(0)
  const [route, setRoute] = useState<SparkReceiveRoute | null>(null)
  const [amount, setAmount] = useState('')
  const [sheetOpen, setSheetOpen] = useState(false)
  const [picking, setPicking] = useState(false)
  const [quote, setQuote] = useState<SparkStableReceive | null>(null)
  const [quoting, setQuoting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'amount' | 'address' | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // Changing coin, network or amount overlaps quotes, so only the latest may commit.
  const seq = useRef(0)
  // The network last received on, and the coin the network was last chosen for.
  const lastRouteId = useRef<string | null>(null)
  const pickedFor = useRef<string | null>(null)

  useEffect(() => {
    let alive = true
    setRoutes(null)
    setRoutesFailed(false)
    ;(async () => {
      const [list, last] = await Promise.all([
        sparkListReceiveRoutes(dollarMode).catch(() => null),
        loadLastReceiveRoute().catch(() => null),
      ])
      if (!alive) {
        return
      }
      if (list === null) {
        setRoutesFailed(true)
        setRoutes([])
        return
      }
      lastRouteId.current = last
      pickedFor.current = null
      setQuote(null)
      setRoutes(list)
    })()
    return () => {
      alive = false
    }
  }, [dollarMode, reload])

  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    [],
  )

  const requestQuote = useCallback(
    async (target: SparkReceiveRoute, value: string) => {
      const mine = ++seq.current
      setQuote(null)
      setError(null)
      setCopied(null)
      setQuoting(true)
      try {
        const next = await sparkReceiveStable(target.id, value)
        if (mine === seq.current) {
          setQuote(next)
          setNow(Date.now())
        }
      } catch (cause) {
        if (mine !== seq.current) {
          return
        }
        const code = classifyWalletError(cause)
        // A network that refuses outright would refuse again, so it leaves the choice.
        if (code === 'routeUnavailable') {
          setRoutes(prev => (prev ?? []).filter(item => item.id !== target.id))
          setRoute(null)
        }
        setError(code === 'unknown' ? t('receive.failed') : t(walletErrorKey(code)))
      } finally {
        if (mine === seq.current) {
          setQuoting(false)
        }
      }
    },
    [t],
  )

  // A figure typed for one route and carried to another is checked against the new one first: more
  // places than its coin holds, or under its floor, is said here in the keypad's words, since the SDK
  // refuses either with a failure that names neither. The floor reads as the keypad draws it, at two
  // places rounded up, so typed back it passes.
  const quoteOn = useCallback(
    (target: SparkReceiveRoute, value: string) => {
      const base = toBaseUnitsExact(value, target.decimals)
      const refusal =
        base === null
          ? t('receive.routePlaces')
          : target.min !== undefined && base < target.min
          ? t('receive.belowMin', {
              min: `${localizeAmount(
                formatBaseUnitsExact(roundBaseUnits(target.min, target.decimals, 2, 'up'), target.decimals),
              )} ${target.asset}`,
            })
          : null
      if (refusal === null) {
        requestQuote(target, value)
        return
      }
      // A quote still in flight was asked for the previous route, so it may not land over the refusal.
      seq.current += 1
      setQuote(null)
      setQuoting(false)
      setCopied(null)
      setError(refusal)
    },
    [requestQuote, t],
  )

  // A coin gets a network when the list arrives and when the coin changes: the last one used for it,
  // else the network the previous coin was on, else the first. A route refused later is not replaced,
  // so the person chooses again rather than being moved to a network they did not pick.
  useEffect(() => {
    if (!routes || pickedFor.current === coin) {
      return
    }
    pickedFor.current = coin
    const options = routes.filter(item => item.asset === coin)
    const target =
      options.find(item => item.id === lastRouteId.current) ??
      options.find(item => item.chain === route?.chain) ??
      options[0] ??
      null
    setRoute(target)
    setError(null)
    if (target && amount) {
      quoteOn(target, amount)
    } else {
      setQuote(null)
    }
  }, [coin, routes, route, amount, quoteOn])

  // The countdown only runs while a price is held, and stops on the tick that finds it gone.
  useEffect(() => {
    if (!quote || quote.expiresAtMs <= Date.now()) {
      return
    }
    const timer = setInterval(() => {
      const at = Date.now()
      setNow(at)
      if (at >= quote.expiresAtMs) {
        clearInterval(timer)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [quote])

  const sendLine = quote
    ? t('receive.sendExactly', {
        amount: localizeAmount(quote.sendAmount),
        asset: quote.asset,
        chain: chainDisplayName(quote.chain),
      })
    : null
  const expired = quote !== null && quote.expiresAtMs <= now
  // An expired address still takes money at an uncertain price, so it is not shared either.
  useEffect(() => {
    onShareable(quote && sendLine && !expired ? `${sendLine}\n${quote.address}` : null)
  }, [quote, sendLine, expired, onShareable])

  // The sheet hands the amount in the route's base units, so the figure quoted is the one typed, at
  // every place the coin holds.
  function confirmAmount(base: bigint | undefined) {
    setSheetOpen(false)
    if (base === undefined || !route) {
      return
    }
    const typed = formatBaseUnitsExact(base, route.decimals)
    setAmount(typed)
    requestQuote(route, typed)
  }

  function applyRoute(next: SparkReceiveRoute) {
    setRoute(next)
    setError(null)
    lastRouteId.current = next.id
    saveLastReceiveRoute(next.id).catch(() => undefined)
    if (amount) {
      quoteOn(next, amount)
    } else {
      setQuote(null)
    }
  }

  function chooseNetwork(id: string) {
    setPicking(false)
    const next = routes?.find(item => item.id === id)
    if (next) {
      applyRoute(next)
    }
  }

  // An address quoted before an exit started never leaves the screen once it holds the wallet.
  function copy(what: 'amount' | 'address', text: string) {
    if (!heldAtPress) {
      copyNow(what, text)
      return
    }
    heldAtPress().then(
      held => !held && copyNow(what, text),
      () => undefined,
    )
  }

  function copyNow(what: 'amount' | 'address', text: string) {
    Clipboard.setString(text)
    setCopied(what)
    // The check mark is visual only; a screen reader hears nothing unless told.
    AccessibilityInfo.announceForAccessibility(t('receive.copied'))
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopied(null), 2000)
  }

  const coinRoutes = (routes ?? []).filter(item => item.asset === coin)
  const networkItems: PickerItem[] = coinRoutes.map(item => ({
    assetId: item.id,
    iconId: chainIconId(item.chain),
    ticker: chainDisplayName(item.chain),
    name: '',
  }))
  const networkLabel = route ? chainDisplayName(route.chain) : t('receive.chooseStableNetwork')
  const remaining = quote ? quote.expiresAtMs - now : 0
  const received = quote
    ? quote.landing === 'usdb'
      ? `${localizeAmount(fromBaseUnits(Math.round(quote.receiveAmount * 100), 2))} ${USDB.ticker}`
      : `${formatSats(quote.receiveAmount)} ${t('common.sats')}`
    : ''

  if (routesFailed) {
    return (
      <Card centered gap="md" style={receiveStyles.card}>
        <Txt role="label" tone="danger" style={styles.centered}>
          {t('receive.failed')}
        </Txt>
        <GradientButton
          label={t('common.retry')}
          variant="secondary"
          onPress={() => setReload(n => n + 1)}
        />
      </Card>
    )
  }

  if (routes !== null && coinRoutes.length === 0 && !error) {
    return (
      <Card centered style={receiveStyles.card}>
        <Txt role="caption" tone="muted" style={styles.centered}>
          {t('receive.noStableRoutes')}
        </Txt>
      </Card>
    )
  }

  return (
    <>
      {routes === null ? (
        <Skeleton height={touch.selector} borderRadius={radius.lg} />
      ) : (
        <>
          <Touch
            onPress={() => setPicking(true)}
            feedback="link"
            // A button label replaces its text for a screen reader, so the choice rides in it.
            label={route ? `${networkLabel}, ${t('receive.chooseStableNetwork')}` : networkLabel}
            style={receiveStyles.pickerRow}>
            <Txt role="caption" tone="muted">
              {t('receive.stableNetwork')}
            </Txt>
            <Row gap="sm">
              {route && (
                <AssetIcon assetId={chainIconId(route.chain)} ticker={networkLabel} size={20} />
              )}
              <Txt role="bodyBold">{networkLabel}</Txt>
              <TabIcon name="chevron" color={colors.textSecondary} size={18} />
            </Row>
          </Touch>
        </>
      )}

      <Txt role="caption" tone="muted">
        {t('receive.hintStable', { asset: coin })}
      </Txt>

      {route && (
        <Touch
          onPress={() => setSheetOpen(true)}
          feedback="link"
          hitSlop={space.sm}
          style={receiveStyles.addAmount}>
          <TabIcon name={amount ? 'edit' : 'plus'} color={accent} size={18} />
          <Figure role="bodyBold" tone="accent">
            {amount
              ? `${localizeAmount(amount)} ${route.asset}`
              : t('receive.amountToken', { ticker: route.asset })}
          </Figure>
        </Touch>
      )}

      {error ? (
        <Card centered style={receiveStyles.card}>
          <Txt role="label" tone="danger" style={styles.centered}>
            {error}
          </Txt>
        </Card>
      ) : quote && expired && route ? (
        <Card centered gap="md" style={receiveStyles.card}>
          <Txt role="bodyBold" style={styles.centered}>
            {t('receive.quoteExpired')}
          </Txt>
          <Txt role="caption" tone="muted" style={styles.centered}>
            {t('receive.quoteExpiredHint')}
          </Txt>
          <GradientButton
            label={t('receive.refreshQuote')}
            variant="secondary"
            onPress={() => requestQuote(route, amount)}
          />
        </Card>
      ) : quote && sendLine ? (
        <>
          {/* The same card every receive rail draws, with the code, the address and tap to
              copy. */}
          <Card centered style={receiveStyles.card}>
            <View style={styles.qrWrap}>
              <QRCode value={quote.qr} size={RECEIVE_QR_SIZE} />
            </View>
            <Touch
              onPress={() => copy('address', quote.address)}
              feedback="link"
              label={`${quote.address}, ${t('receive.copy')}`}
              style={receiveStyles.addressBlock}>
              <ChunkedAddress value={quote.address} chunked />
              <View style={receiveStyles.copyHint}>
                <TabIcon
                  name={copied === 'address' ? 'check' : 'copy'}
                  color={copied === 'address' ? accent : colors.textSecondary}
                  size={14}
                />
                <Txt role="micro" tone={copied === 'address' ? 'accent' : 'muted'}>
                  {copied === 'address' ? t('receive.copied') : t('receive.tapToCopy')}
                </Txt>
              </View>
            </Touch>
          </Card>

          {/* Label and value rows, through the rule every label and figure share, so a figure goes
              under its label when both no longer fit. */}
          <Card padding="inset">
            <Touch
              onPress={() => copy('amount', quote.sendAmount)}
              feedback="link"
              label={`${sendLine}, ${t('receive.copyAmount')}`}>
              <FigureRow
                label={t('receive.amountToSend')}
                labelRole="caption"
                style={[styles.line, styles.divider]}>
                <Row gap="xs" style={styles.figureRow}>
                  <Figure role="caption" tabular>
                    {`${localizeAmount(quote.sendAmount)} ${quote.asset}`}
                  </Figure>
                  <TabIcon
                    name={copied === 'amount' ? 'check' : 'copy'}
                    color={copied === 'amount' ? accent : colors.textSecondary}
                    size={14}
                  />
                </Row>
              </FigureRow>
            </Touch>
            <FigureRow label={t('receive.youGet')} labelRole="caption" style={[styles.line, styles.divider]}>
              <Figure role="caption" tabular>
                {t('send.approxAmount', { amount: received })}
              </Figure>
            </FigureRow>
            <FigureRow label={t('receive.priceValidFor')} labelRole="caption" style={styles.line}>
              <Txt role="caption" tabular>
                {formatClock(remaining, i18n.language)}
              </Txt>
            </FigureRow>
          </Card>

          {/* The app's warning box, as on the recovery phrase, because one 0x address exists on
              every EVM chain and a coin sent on the wrong one may be lost. */}
          <Notice>
            <Txt role="caption">
              {t('receive.onlyThisNetwork', {
                asset: quote.asset,
                chain: chainDisplayName(quote.chain),
              })}
            </Txt>
            <Txt role="caption">{t('receive.singleUse')}</Txt>
          </Notice>

          <Txt role="caption" tone="muted" style={styles.centered}>
            {t('receive.providerNote', { provider: 'Flashnet' })}
          </Txt>
        </>
      ) : route && !quoting ? (
        // Where the code will be, saying what it waits for, so the screen is not blank below the link.
        <Card centered style={receiveStyles.card}>
          <Txt role="caption" tone="muted" style={styles.centered}>
            {t('receive.amountFirst')}
          </Txt>
        </Card>
      ) : quoting ? (
        <Card centered style={receiveStyles.card}>
          {/* Mirrors the ready card so the layout does not grow when the quote resolves. */}
          <Skeleton
            width={RECEIVE_QR_SIZE + space.md * 2}
            height={RECEIVE_QR_SIZE + space.md * 2}
            borderRadius={radius.md}
          />
          <View style={receiveStyles.addressBlock}>
            <Skeleton width={RECEIVE_QR_SIZE} height={font.leading.sm} />
            <Skeleton width={RECEIVE_QR_SIZE} height={font.leading.sm} />
            <Skeleton width={RECEIVE_QR_SIZE * 0.55} height={font.leading.xs} />
          </View>
        </Card>
      ) : null}

      {/* The typed amount is what lands, in the paid asset's unit, which for a stablecoin is dollars.
          Only a route can be given an amount, and only its decimals turn one into base units. */}
      {route ? (
        <AmountSheet
          visible={sheetOpen}
          unit={route.asset}
          allowDecimal
          satsBtcToggle={false}
          // The route bounds what the payer sends, which fees make larger than what lands: its floor
          // is safe to apply to the typed amount, its ceiling is not, and the SDK refuses past it.
          tokenBounds={{ decimals: route.decimals, min: route.min }}
          maxDecimals={route.decimals}
          // A figure carried from a route with more places cannot be confirmed here, and the line
          // on the panel already asks for a new one, so the keypad opens empty for it.
          initial={toBaseUnitsExact(amount, route.decimals) === null ? '' : amount}
          parse={parseConvertAmount}
          onConfirm={confirmAmount}
          onClose={() => setSheetOpen(false)}
        />
      ) : null}

      <AssetPickerSheet
        visible={picking}
        title={t('receive.chooseStableNetwork')}
        items={networkItems}
        selectedId={route?.id ?? null}
        searchable={false}
        onSelect={chooseNetwork}
        onClose={() => setPicking(false)}
      />
    </>
  )
}

const styles = StyleSheet.create({
  // Gives way in its row like the figure it holds, beside its copy mark.
  figureRow: {
    flexShrink: 1,
    minWidth: 0,
  },
  // The padding and hairline of the app's list rows.
  line: {
    paddingVertical: space.md,
  },
  divider: {
    ...dividerBottom,
  },
  qrWrap: qrFrame,
  centered: {
    textAlign: 'center',
  },
})
