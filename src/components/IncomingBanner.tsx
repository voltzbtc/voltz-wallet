import React, { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useTranslation } from 'react-i18next'
import { formatSats } from '../wallet/amount'
import type { HistoryAsset } from '../wallet/payment'
import { noticeTitle, tokenUnit, type NoticeRail } from '../wallet/paymentNotice'
import { useAccent } from '../wallet/dollarMode'
import { localizeAmount } from '../wallet/fiat'
import { colors, font, layer, motion, radius, space } from '../theme'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useUnderLock } from './UnderLock'

type Props = {
  visible: boolean
  amountSat: number
  // A token arrives in its own unit, since amountSat is then its base units.
  asset?: HistoryAsset
  // The rail the record names, which the label follows.
  rail?: NoticeRail
  // The dollars a bitcoin amount reads as on a dollar wallet. They lead, and the sats go under them.
  dollars?: string
}

// A nodeless Lightning receive clears through a swap and is not instant. This never shows a check,
// which belongs to the moment the money lands.
export function IncomingBanner({ visible, amountSat, asset, rail, dollars }: Props): React.JSX.Element | null {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const insets = useSafeAreaInsets()
  // With reduced motion the pill only fades in and its dot holds still.
  const reduced = useReduceMotion()
  const enter = useRef(new Animated.Value(0)).current
  const pulse = useRef(new Animated.Value(0)).current

  useEffect(() => {
    Animated.timing(enter, {
      toValue: visible ? 1 : 0,
      duration: motion.base,
      useNativeDriver: true,
    }).start()
  }, [visible, enter])

  const figure = asset ? localizeAmount(asset.amount) : formatSats(amountSat)
  // A token the app does not know by its identifier goes unnamed, and a screen reader hears why.
  const ticker = asset ? tokenUnit(asset.assetId) : null
  const unit = asset ? ticker ?? '' : t('common.sats')
  const label = noticeTitle('incoming', rail, t)
  const said = asset && ticker === null ? `${figure}, ${t('notice.unknownToken')}` : `${figure} ${unit}`
  const spoken = dollars ? `${dollars}, ${said}` : said

  // The pill takes no touch and no focus, so a screen reader hears of the payment only if told, and
  // not while the lock is up.
  const underLock = useUnderLock()
  useEffect(() => {
    if (visible && !underLock) {
      AccessibilityInfo.announceForAccessibility(`${label}, ${spoken}`)
    }
  }, [visible, underLock, label, spoken])

  useEffect(() => {
    if (!visible || reduced) {
      return
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 700, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 700, useNativeDriver: true }),
      ]),
    )
    loop.start()
    return () => loop.stop()
  }, [visible, reduced, pulse])

  if (!visible) {
    return null
  }

  const translateY = enter.interpolate({ inputRange: [0, 1], outputRange: [-space.xl, 0] })
  // Fixed rather than read from the pulse, which a loop stopped midway leaves part faded.
  const dotOpacity = reduced ? 1 : pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 0.3] })

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.wrap,
        { top: insets.top + space.sm, opacity: enter },
        !reduced && { transform: [{ translateY }] },
      ]}>
      <View style={styles.pill}>
        <Animated.View style={[styles.dot, { opacity: dotOpacity, backgroundColor: accent }]} />
        {/* The rule every label and figure share: the figure goes under the label when both no
            longer fit, and beside it neither can take the pill from the other. */}
        <FigureRow label={label} labelRole="label" labelTone="muted" hug>
          {dollars ? (
            <View>
              <Figure role="labelStrong" tabular>
                {dollars}
              </Figure>
              <Figure role="caption" tone="muted" tabular>
                {unit ? `${figure} ${unit}` : figure}
              </Figure>
            </View>
          ) : (
            <Figure role="labelStrong" tabular>
              {figure}
              {unit ? <Text style={styles.unit}> {unit}</Text> : null}
            </Figure>
          )}
        </FigureRow>
      </View>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: space.xl,
    alignItems: 'center',
    zIndex: layer.banner,
  },
  // Capped at the screen's margins, so the figure inside shrinks rather than running off the edge.
  pill: {
    maxWidth: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    paddingHorizontal: space.lg,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.primary,
  },
  unit: {
    color: colors.textSecondary,
    fontSize: font.size.sm,
  },
})
