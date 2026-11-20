import React, { useMemo, useRef, useState } from 'react'
import { I18nManager, LayoutChangeEvent, PanResponder, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import Svg, { Circle, Defs, LinearGradient, Line, Path, Stop } from 'react-native-svg'
import { GlassCard } from './GlassCard'
import { SegmentedControl } from './SegmentedControl'
import { Skeleton } from './Skeleton'
import { Txt } from './Txt'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import {
  PRICE_PERIODS,
  isScrubGesture,
  periodChange,
  shownPercent,
  signedPercent,
  scrubIndex,
  type PricePeriod,
  type PricePoint,
} from '../wallet/price'
import { formatFiat, type FiatCurrency } from '../wallet/fiat'
import { formatDate, formatTime, type DateTimePrefs } from '../wallet/history'
import { holdDirection } from '../i18n/direction'
import { colors, font, radius, space, touch } from '../theme'

const CHART_HEIGHT = 132

// The card as it lays out, so the asset screen's skeleton holds the same room: the padding, the label
// and price lines with the gap between them, then the chart and the period track, each with its gap.
export const PRICE_CARD_HEIGHT =
  space.lg * 2 +
  font.leading.xs +
  space.xs +
  font.leading.xxl +
  space.sm +
  CHART_HEIGHT +
  space.sm +
  touch.selector
// The line's round caps and the scrub knob would clip against the plot edge without this.
const PAD_X = 4
const PAD_TOP = 8
const PAD_BOTTOM = 8
// Headroom as a share of the series range, so a flat day is not drawn glued to an edge.
const RANGE_PAD = 0.12

type Props = {
  /** Already converted to `currency`. */
  points: PricePoint[]
  spot: number
  currency: FiatCurrency
  name: string
  period: PricePeriod
  onPeriodChange: (period: PricePeriod) => void
  loading: boolean
  prefs: DateTimePrefs
}

// Core Animated + PanResponder, not reanimated + gesture-handler, whose worklets cannot run under
// this project's jest setup and would leave the component stubbed and untestable.
export function PriceCard({
  points,
  spot,
  currency,
  name,
  period,
  onPeriodChange,
  loading,
  prefs,
}: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [width, setWidth] = useState(0)
  const [scrub, setScrub] = useState<number | null>(null)

  // The responder is built once, so it has to read live values through refs, not a stale closure.
  const pointsRef = useRef(points)
  const widthRef = useRef(width)
  pointsRef.current = points
  widthRef.current = width

  const change = useMemo(() => periodChange(points), [points])
  // The sign and the colour follow the figure drawn, so a fall too small to show is never a red minus zero.
  const shownPct = shownPercent(change.pct)
  const rising = shownPct >= 0
  const lineColor = rising ? colors.success : colors.danger
  // periodChange answers 0 below two points, rendering a green "+0.00%" beside "chart unavailable".
  const hasChange = !loading && points.length >= 2

  const responder = useMemo(
    () => {
      const pick = (x: number) => {
        const index = scrubIndex(x, widthRef.current, pointsRef.current.length, PAD_X)
        if (index !== null) {
          setScrub(index)
        }
      }
      return PanResponder.create({
        // Claiming on contact would eat every vertical swipe starting on this band.
        onStartShouldSetPanResponder: () => false,
        onMoveShouldSetPanResponder: (_event, gesture) => isScrubGesture(gesture.dx, gesture.dy),
        // Without this the ScrollView steals the drag mid-scrub and the page slides instead.
        onPanResponderTerminationRequest: () => false,
        onPanResponderGrant: event => pick(event.nativeEvent.locationX),
        onPanResponderMove: event => pick(event.nativeEvent.locationX),
        onPanResponderRelease: () => setScrub(null),
        onPanResponderTerminate: () => setScrub(null),
      })
    },
    [],
  )

  const active = scrub !== null && scrub < points.length ? points[scrub] : null
  const shownValue = active ? active.v : spot
  const label = active
    ? `${formatDate(active.t / 1000, prefs)} ${formatTime(active.t / 1000, prefs)}`
    : `${name} · ${currency}`

  // The locale places the percent sign. Turkish writes it before the number, French with a space.
  const deltaText = t('asset.delta', { value: signedPercent(shownPct, i18n.language) })

  const geometry = useMemo(() => {
    if (points.length < 2 || width <= 0) {
      return null
    }
    const values = points.map(p => p.v)
    const low = Math.min(...values)
    const high = Math.max(...values)
    const span = high - low || Math.abs(high) || 1
    const min = low - span * RANGE_PAD
    const max = high + span * RANGE_PAD
    const plotW = width - PAD_X * 2
    const plotH = CHART_HEIGHT - PAD_TOP - PAD_BOTTOM
    const coords = points.map((point, index) => ({
      x: PAD_X + (index / (points.length - 1)) * plotW,
      y: PAD_TOP + (1 - (point.v - min) / (max - min)) * plotH,
    }))
    const line = coords.map((c, i) => `${i ? 'L' : 'M'}${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ')
    const area = `${line} L${coords[coords.length - 1].x.toFixed(1)} ${CHART_HEIGHT} L${coords[0].x.toFixed(1)} ${CHART_HEIGHT} Z`
    return { coords, line, area }
  }, [points, width])

  const knob = geometry && scrub !== null ? geometry.coords[scrub] : null

  return (
    <GlassCard style={styles.card}>

      {/* The price leads and its change follows, by the rule every label and figure share: the change
          goes under the price when both no longer fit, so the price keeps its size. The change is a
          short percentage, so the price may take most of the row. */}
      <FigureRow
        figureFirst
        cap="70%"
        align="flex-start"
        label={
          hasChange ? (
            <Txt role="bodyBold" tone={rising ? 'success' : 'danger'} tabular>
              {I18nManager.isRTL ? holdDirection(deltaText) : deltaText}
            </Txt>
          ) : null
        }>
        <Txt role="section" tone="muted" tabular lines={1}>
          {label}
        </Txt>
        <Figure role="titleStrong" tabular style={styles.price}>
          {formatFiat(shownValue, currency)}
        </Figure>
      </FigureRow>

      <View
        style={styles.chart}
        onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
        accessible
        accessibilityRole="image"
        accessibilityLabel={
          hasChange
            ? t('asset.chartLabel', {
                name,
                price: formatFiat(spot, currency),
                change: deltaText,
              })
            : t('asset.chartLabelNoChange', { name, price: formatFiat(spot, currency) })
        }
        {...responder.panHandlers}>
        {loading && <Skeleton height={CHART_HEIGHT} borderRadius={radius.md} />}

        {/* Keyed on the data, since geometry is null until onLayout and would flash on open. */}
        {!loading && points.length < 2 && (
          <View style={styles.unavailable}>
            <Txt role="caption" tone="muted">
              {t('asset.chartUnavailable')}
            </Txt>
          </View>
        )}

        {!loading && points.length >= 2 && geometry !== null && (
          // Not mirrored under RTL, because a time axis reads oldest to newest in every locale.
          <Svg width={width} height={CHART_HEIGHT}>
            <Defs>
              <LinearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
                <Stop offset="0" stopColor={lineColor} stopOpacity={0.2} />
                <Stop offset="1" stopColor={lineColor} stopOpacity={0} />
              </LinearGradient>
            </Defs>
            <Path d={geometry.area} fill="url(#priceFill)" />
            <Path
              d={geometry.line}
              fill="none"
              stroke={lineColor}
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            {knob && (
              <>
                <Line
                  x1={knob.x}
                  x2={knob.x}
                  y1={0}
                  y2={CHART_HEIGHT}
                  stroke={colors.divider}
                  strokeWidth={1}
                />
                <Circle
                  cx={knob.x}
                  cy={knob.y}
                  r={4}
                  fill={lineColor}
                  stroke={colors.surface}
                  strokeWidth={2}
                />
              </>
            )}
          </Svg>
        )}
      </View>

      <View style={styles.periods}>
        <SegmentedControl
          options={PRICE_PERIODS.map(item => ({ label: t(`asset.periods.${item}`), value: item }))}
          value={period}
          onChange={onPeriodChange}
        />
      </View>
    </GlassCard>
  )
}

const styles = StyleSheet.create({
  card: {
    padding: space.lg,
  },
  price: {
    marginTop: space.xs,
    lineHeight: font.leading.xxl,
  },
  periods: {
    marginTop: space.sm,
  },
  chart: {
    height: CHART_HEIGHT,
    marginTop: space.sm,
    justifyContent: 'center',
  },
  unavailable: {
    alignItems: 'center',
    justifyContent: 'center',
  },
})
