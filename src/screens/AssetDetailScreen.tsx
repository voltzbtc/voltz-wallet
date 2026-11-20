import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import {
  connectActiveSpark,
  onSparkConnected,
  sparkConnectedWalletId,
  sparkGetFiatRates,
  sparkGetWalletInfo,
  sparkListHistory,
  sparkSubscribeToPayments,
} from '../wallet/spark'
import { exitOnItsWay } from '../wallet/exitQuote'
import { useSyncRefresh } from '../hooks/useSyncRefresh'
import { useContactNames } from '../hooks/useContactNames'
import { useSelectedItem } from '../hooks/useSelectedItem'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { assetFiatValue, formatFiat, satsToFiat, type FiatCurrency } from '../wallet/fiat'
import {
  buildSparkAssetList,
  isBelowCent,
  formatRowAmount,
  BITCOIN_ASSET_ID,
  formatAssetAmount,
  type AssetRow,
} from '../wallet/assets'
import { fetchBtcPriceSeries, type PricePeriod, type PricePoint } from '../wallet/price'
import {
  assetHistoryFilter,
  clearsAt,
  conversionLeft,
  directionLabel,
  historyStatusText,
  isAssetMovement,
  rowAmountText,
  type DateTimePrefs,
} from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { classifyWalletError, type WalletErrorCode } from '../wallet/errors'
import type { HistoryItem } from '../wallet/payment'
import { knownToken, USDB } from '../wallet/tokens'
import { onActiveWalletChanged } from '../wallet/wallet'
import { loadCatalog } from '../wallet/tokenPrefs'
import { AssetIcon } from '../components/AssetIcon'
import { DirectionBadge } from '../components/DirectionBadge'
import { GlassCard } from '../components/GlassCard'
import { GradientButton } from '../components/GradientButton'
import { MenuRow } from '../components/MenuRow'
import { PRICE_CARD_HEIGHT, PriceCard } from '../components/PriceCard'
import { Skeleton } from '../components/Skeleton'
import { SectionLabel } from '../components/SectionLabel'
import { TabIcon } from '../components/TabIcon'
import { TransactionDetailSheet } from '../components/TransactionDetailSheet'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { colors, dividerTop, font, radius, rhythm, space, touch } from '../theme'
import { Screen } from '../components/Screen'
import { Row } from '../components/Row'
import { Txt } from '../components/Txt'
import { Touch } from '../components/Touch'
import { Amount, Figure } from '../components/Amount'
import { FigureRow } from '../components/FigureRow'

// The window is wider than the limit so the local filter still has material to work with.
const MOVEMENT_LIMIT = 5
const MOVEMENT_WINDOW = 25

// Shared by the ready layout and its skeleton, so the placeholder holds the same room. The text bars
// take each line's leading, or the font size where the role sets none.
const HERO_ICON = 48
const BADGE = 32

// The causes a failed connect can have, named under its title, as on Home. The payment words
// classifyWalletError also matches would state a cause that never happened.
const CONNECT_CAUSES: ReadonlySet<WalletErrorCode> = new Set<WalletErrorCode>(['offline', 'deleted'])

type State =
  | { status: 'loading' }
  | {
      status: 'ready'
      // Read from a connection that has not synced, shown only after SYNC_WAIT_MS and marked.
      stale: boolean
      row: AssetRow
      currency: FiatCurrency
      /** Null when the SDK had no rate for the currency. */
      fiatValue: number | null
      spot: number | null
      // The wallet's exit is alive or its plan unread, so the bitcoin figure may count what the exit is
      // moving and the held line goes under it.
      exitHeld: boolean
      // Null until a read has answered, which is not the same as an asset with no movements.
      movements: HistoryItem[] | null
      // There is more than the movements shown, for the list that has them all.
      hasMore: boolean
    }
  // A stable code the screen translates, never the SDK's own text.
  | { status: 'error'; code: WalletErrorCode }

// The price chart lives here and not on Home, where it would read as an exchange.
// The same four outcomes as the history list, so money that never moved cannot look like it did.
function movementTone(item: HistoryItem): 'danger' | 'muted' | 'success' | 'default' {
  if (item.status === 'failed') {
    return 'danger'
  }
  if (item.status === 'pending') {
    return 'muted'
  }
  return item.direction === 'received' ? 'success' : 'default'
}

export function AssetDetailScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const names = useContactNames()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const route = useRoute<RouteProp<RootStackParamList, 'AssetDetail'>>()
  const { assetId } = route.params
  const isBitcoin = assetId === BITCOIN_ASSET_ID
  const prefs = useMemo<DateTimePrefs>(() => deviceDateTimePrefs(), [])

  const [state, setState] = useState<State>({ status: 'loading' })
  const [selected, select] = useSelectedItem(state.status === 'ready' ? state.movements : null)
  const [period, setPeriod] = useState<PricePeriod>('1D')
  const [series, setSeries] = useState<PricePoint[]>([])
  const [seriesLoading, setSeriesLoading] = useState(isBitcoin)

  const loadedOnce = useRef(false)

  const load = useCallback(async () => {
    const background = loadedOnce.current
    if (!background) {
      setState({ status: 'loading' })
    }
    try {
      await connectActiveSpark()
      const currency = await resolveDisplayCurrency(i18n.language)
      // The token's own peg rides along so it can be crossed into another display currency, the
      // dollar for USDB and the real for DePix.
      const peg = knownToken(assetId)?.fiatId
      const [info, rates, history, catalog, exit] = await Promise.all([
        sparkGetWalletInfo(),
        sparkGetFiatRates(Array.from(new Set([currency, peg ?? 'USD']))).catch(
          () => ({} as Record<string, number>),
        ),
        // Only keeps other assets from consuming the window. The local filter below is what
        // enforces "only this asset".
        sparkListHistory(MOVEMENT_WINDOW, assetHistoryFilter(assetId)).catch(() => null),
        loadCatalog(),
        // Home's own read, so the two screens hold the same wallets.
        isBitcoin ? exitOnItsWay(sparkConnectedWalletId()).catch(() => 'unread' as const) : Promise.resolve(null),
      ])
      // The SDK's own figure, as Home draws it: nothing is taken off for an exit.
      const balanceSat = info.balanceSat

      // A figure from before the connection's first sync is never shown as current. A plain one
      // already on screen came from a synced connection and stays; otherwise the skeleton does, until
      // the sync or the end of the wait re-runs this load.
      if (info.sync === 'waiting') {
        setState(prev => (prev.status === 'ready' && !prev.stale ? prev : { status: 'loading' }))
        return
      }

      // Without the catalog a zero-balance token opened from Home resolves to nothing and bounces back.
      const row = buildSparkAssetList(balanceSat, info.tokens, catalog).find(
        item => item.assetId === assetId,
      )
      if (!row) {
        // The asset left the wallet while the screen was open, so leave rather than render nothing.
        navigation.goBack()
        return
      }

      const rate = rates[currency]
      const token = info.tokens.find(item => item.identifier === assetId)
      // assetFiatValue returns 0 for a missing rate, which reads as worthless standing alone.
      const canValueToken =
        token !== undefined && peg !== undefined && (peg === currency || rates[peg] > 0)
      const fiatValue = isBitcoin
        ? rate > 0
          ? satsToFiat(balanceSat, rate)
          : null
        : canValueToken && (peg === currency || rate > 0)
        ? assetFiatValue(token.balanceBaseUnits / 10 ** token.decimals, peg, currency, rates)
        : null

      const own = history?.filter(item => isAssetMovement(item, assetId)) ?? null

      // The list cuts a sub-cent balance short; this screen is where the exact figure is read.
      const shownRow =
        token && isBelowCent(token.balanceBaseUnits, token.decimals)
          ? { ...row, amount: formatAssetAmount(token.balanceBaseUnits, token.decimals) }
          : row
      // A read that failed leaves the movements already on screen alone, except an empty list from a
      // connection that had not synced: kept, it would pass for an answer once this one has.
      const kept = (prev: State) =>
        prev.status === 'ready' && !(prev.stale && prev.movements?.length === 0) ? prev.movements : null
      setState(prev => ({
        status: 'ready',
        stale: info.sync !== 'synced',
        row: shownRow,
        currency,
        fiatValue,
        spot: rate > 0 ? rate : null,
        exitHeld: exit !== null,
        movements: own ? own.slice(0, MOVEMENT_LIMIT) : kept(prev),
        hasMore: own ? own.length > MOVEMENT_LIMIT : prev.status === 'ready' && prev.hasMore,
      }))
      loadedOnce.current = true
    } catch (error) {
      // A connect a newer request replaced is no failure; that request brings the next load. Matched
      // by name, since test doubles of spark.ts carry no error classes.
      if ((error as Error | null)?.name === 'SparkConnectSuperseded') {
        return
      }
      if (!background) {
        setState({ status: 'error', code: classifyWalletError(error) })
      }
    }
  }, [assetId, i18n.language, isBitcoin, navigation])

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  // Focus will not fire again for a payment settling while the screen is open, and a burst of
  // them would otherwise run the load per event.
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const scheduleRefresh = useCallback(() => {
    if (refreshTimer.current) {
      return
    }
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null
      load()
    }, 600)
  }, [load])

  useSyncRefresh(scheduleRefresh)

  useEffect(() => onActiveWalletChanged(() => select(null)), [select])

  useEffect(() => {
    let unsub: (() => void) | null = null
    let alive = true
    const off = onSparkConnected(() => {
      if (unsub) {
        unsub()
        unsub = null
      }
      sparkSubscribeToPayments(scheduleRefresh)
        .then(u => (alive ? (unsub = u) : u()))
        .catch(() => undefined)
    })
    return () => {
      alive = false
      off()
      if (unsub) {
        unsub()
      }
      if (refreshTimer.current) {
        clearTimeout(refreshTimer.current)
        refreshTimer.current = null
      }
    }
  }, [scheduleRefresh])

  // The curve is rescaled onto the SDK spot, so it cannot be fetched before one exists.
  const spot = state.status === 'ready' ? state.spot : null
  useEffect(() => {
    if (!isBitcoin || spot === null) {
      setSeriesLoading(false)
      return
    }
    let alive = true
    setSeriesLoading(true)
    fetchBtcPriceSeries(period, spot)
      .then(points => {
        if (alive) {
          setSeries(points ?? [])
          setSeriesLoading(false)
        }
      })
      .catch(() => {
        if (alive) {
          setSeries([])
          setSeriesLoading(false)
        }
      })
    return () => {
      alive = false
    }
  }, [isBitcoin, period, spot])

  if (state.status === 'loading') {
    return (
      <Screen layout="padded">
        <View style={styles.hero}>
          <Skeleton width={HERO_ICON} height={HERO_ICON} borderRadius={radius.full} />
          <Skeleton width={180} height={font.size.xxxl} borderRadius={radius.md} />
          <Skeleton width={110} height={font.size.lg} />
        </View>

        {/* The skeleton must match the shape of what arrives or the layout jumps. */}
        {isBitcoin && (
          <View style={styles.block}>
            <Skeleton height={PRICE_CARD_HEIGHT} borderRadius={radius.lg} />
          </View>
        )}

        <Row gap="sm" style={[styles.actions, styles.block]}>
          <View style={styles.pill}>
            <Skeleton height={touch.action} borderRadius={radius.md} />
          </View>
          <Skeleton width={touch.action} height={touch.action} borderRadius={radius.lg} />
          <View style={styles.pill}>
            <Skeleton height={touch.action} borderRadius={radius.md} />
          </View>
        </Row>

        <View style={styles.block}>
          <Skeleton width={110} height={font.leading.sm} style={styles.skeletonLabel} />
          <View style={styles.skeletonCard}>
            {Array.from({ length: 3 }).map((_, index) => (
              <Row key={index} gap="md" pad="default" style={[styles.movement, index > 0 && styles.movementDivider]}>
                <Skeleton width={BADGE} height={BADGE} borderRadius={radius.full} />
                <View style={styles.movementText}>
                  <Skeleton width={90} height={font.leading.base} />
                  <Skeleton width={130} height={font.leading.sm} />
                </View>
                <Skeleton width={80} height={font.leading.base} />
              </Row>
            ))}
          </View>
        </View>
      </Screen>
    )
  }

  if (state.status === 'error') {
    return (
      <Screen layout="padded">
        <Txt role="labelStrong" tone="danger" style={styles.errorTitle}>
          {t('home.connectionError')}
        </Txt>
        {CONNECT_CAUSES.has(state.code) && (
          <Txt role="caption" tone="muted" style={styles.errorDetail}>
            {t(`errors.${state.code}`)}
          </Txt>
        )}
        <View style={styles.block}>
          <GradientButton label={t('home.retry')} onPress={load} />
        </View>
      </Screen>
    )
  }

  const { row, currency, fiatValue, movements, hasMore } = state
  // "No activity" is a statement about the wallet, so it needs a read that answered on a synced
  // connection. Anything less says what a balance says in the same state.
  const nothingToList = movements === null || movements.length === 0
  const emptyText = movements === null || state.stale ? 'home.notUpdated' : 'asset.noActivity'

  // The sign goes through the locale with the amount, so a language can place it where it reads.
  function signedAmount(item: HistoryItem, amount: string): string {
    if (item.direction === 'converted') {
      return amount
    }
    return t(item.direction === 'received' ? 'asset.amountIn' : 'asset.amountOut', { amount })
  }

  return (
    <Screen scroll contentStyle={styles.content}>
      <View style={styles.hero}>
        <AssetIcon assetId={row.assetId} ticker={row.ticker} size={HERO_ICON} />
        <Amount
          value={formatRowAmount(row)}
          unit={row.ticker}
          role="titleLarge"
          tone="accent"
          fiat={fiatValue !== null ? formatFiat(fiatValue, currency) : undefined}
          style={styles.heroAmount}
        />
        {state.stale && (
          <Txt role="caption" tone="muted" style={styles.staleMark}>
            {t('home.notUpdated')}
          </Txt>
        )}
        {state.exitHeld && (
          <Txt role="caption" tone="muted" style={styles.staleMark}>
            {t('emergencyExit.balanceHeld')}
          </Txt>
        )}
      </View>

      {isBitcoin && state.spot !== null && (
        <PriceCard
          points={series}
          spot={state.spot}
          currency={currency}
          name={row.name}
          period={period}
          onPeriodChange={setPeriod}
          loading={seriesLoading}
          prefs={prefs}
        />
      )}

      <Row gap="sm" style={styles.actions}>
        <View style={styles.pill}>
          <GradientButton
            label={t('home.send')}
            icon={<TabIcon name="send" color={colors.onPrimary} size={22} strokeWidth={3} />}
            onPress={() => navigation.navigate('Send', { assetId })}
          />
        </View>
        <Touch
          onPress={() => navigation.navigate('Scan')}
          feedback="surface"
          label={t('scan.title')}
          style={styles.scan}>
          <TabIcon name="scan" color={colors.textSecondary} size={34} strokeWidth={2} />
        </Touch>
        <View style={styles.pill}>
          <GradientButton
            label={t('home.receive')}
            icon={<TabIcon name="receive" color={colors.onPrimary} size={22} strokeWidth={3} />}
            onPress={() => navigation.navigate('Receive', { assetId })}
          />
        </View>
      </Row>

      {assetId === USDB.identifier && (
        <GlassCard style={styles.linkCard}>
          <MenuRow
            label={t('stable.title')}
            icon="dollar"
            onPress={() => navigation.navigate('StableBalance')}
            divider={false}
          />
        </GlassCard>
      )}

      <View>
        <SectionLabel style={styles.sectionLabel}>{t('asset.activity')}</SectionLabel>
        <GlassCard style={styles.card}>
          {nothingToList ? (
            <Txt role="body" tone="muted" style={styles.empty}>
              {t(emptyText)}
            </Txt>
          ) : (
            movements.map((item, index) => {
              const left = conversionLeft(item, t)
              // Four states, as in History, so money that never moved cannot look like it did. A
              // conversion carries no sign, as in History: it is the wallet moving its own value
              // between assets, and on the asset it lands in a minus would read as money gone.
              // The figure goes under the labels at a large text size, by the rule every label and
              // figure share, as in History.
              return (
                <Touch key={item.id} onPress={() => select(item)} feedback="row">
                  <Row gap="md" pad="default" style={[styles.movement, index > 0 && styles.movementDivider]}>
                    <DirectionBadge direction={item.direction} size={BADGE} />
                    <FigureRow
                      label={
                        <View style={styles.movementText}>
                          <Row gap="xs">
                            {item.zap ? (
                              <TabIcon name="bolt" color={colors.textSecondary} size={14} />
                            ) : null}
                            <Txt role="bodyStrong" wholeWords style={styles.movementLabel}>
                              {item.zap ? t('history.zap') : directionLabel(item, t, names)}
                            </Txt>
                          </Row>
                          <Txt role="caption" tone="muted" wholeWords>
                            {t('history.rowMeta', {
                              time: clearsAt(item.timestamp, prefs),
                              status: historyStatusText(item, t),
                            })}
                          </Txt>
                        </View>
                      }>
                      <Figure
                        role="bodyBold"
                        tone={movementTone(item)}
                        tabular
                        style={item.status === 'failed' && styles.movementFailed}>
                        {signedAmount(item, rowAmountText(item, t))}
                      </Figure>
                      {left ? (
                        <Figure role="caption" tone="muted" tabular>
                          {left}
                        </Figure>
                      ) : null}
                    </FigureRow>
                  </Row>
                </Touch>
              )
            })
          )}
          {hasMore ? (
            <View style={[styles.movement, styles.movementDivider]}>
              <MenuRow
                label={t('asset.seeAll')}
                onPress={() => navigation.navigate('AssetHistory', { assetId })}
                divider={false}
              />
            </View>
          ) : null}
        </GlassCard>
      </View>

      <TransactionDetailSheet item={selected} names={names} onClose={() => select(null)} />
    </Screen>
  )
}

const styles = StyleSheet.create({
  content: {
    padding: space.xl,
    gap: space.xxl,
  },
  // The ready label's own inset.
  skeletonLabel: {
    marginHorizontal: space.xs,
  },
  skeletonCard: {
    marginTop: rhythm.sectionLabelToList,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  // Amount does not carry the centring the hero block wants around it, so this adds it.
  heroAmount: {
    alignItems: 'center',
  },
  staleMark: {
    textAlign: 'center',
  },
  hero: {
    alignItems: 'center',
    gap: space.sm,
  },
  block: {
    marginTop: space.xxl,
  },
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
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
  sectionLabel: {
    marginBottom: rhythm.sectionLabelToList,
  },
  // The padding sits on the rows, so a row's highlight reaches the card's edges.
  card: {
    padding: 0,
  },
  linkCard: {
    padding: 0,
    paddingHorizontal: space.lg,
  },
  movement: {
    paddingHorizontal: space.lg,
  },
  // Not <EmptyState>, because this one sits inside a card with rows above it, so it keeps the
  // card's own rhythm rather than the standalone state's larger breathing room.
  empty: {
    padding: space.lg,
  },
  movementDivider: {
    ...dividerTop,
  },
  movementText: {
    gap: space.xs,
  },
  movementFailed: {
    textDecorationLine: 'line-through',
  },
  // Gives way to the labels before it reaches them, so they always keep a share of the row.
  // Wraps between words beside the zap mark rather than running past the row.
  movementLabel: {
    flexShrink: 1,
  },
  errorTitle: {
    textAlign: 'center',
  },
  errorDetail: {
    marginTop: space.sm,
    textAlign: 'center',
  },
})
