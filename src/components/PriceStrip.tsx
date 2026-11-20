import React from 'react'
import { StyleSheet, View, useWindowDimensions } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useBtcDayChange } from '../hooks/useBtcDayChange'
import { useBtcPrice } from '../hooks/useBtcPrice'
import { useSideBySide } from '../hooks/useSideBySide'
import { formatFiat } from '../wallet/fiat'
import { shownPercent, signedPercent } from '../wallet/price'
import { colors, font, space, touch } from '../theme'
import { Figure } from './Amount'
import { FigureRow } from './FigureRow'
import { Reenter } from './Reenter'
import { Row } from './Row'
import { Skeleton } from './Skeleton'
import { Text } from './Text'
import { Touch } from './Touch'
import { Txt, tones } from './Txt'

// The band's height for the text size: its lines and the air above and below them, at the touch
// floor or above. Side by side each column holds two lines on the same two leadings, the name over
// the price and the change over its period, so the columns pair line for line. Below the width that
// fits both, the right column goes under the price, `space.xs` apart as in every stacked FigureRow,
// as one line on the change's leading, holding the change with its period beside it or the out of
// date word.
export function priceStripHeight(fontScale: number, sideBySide: boolean): number {
  const line = (leading: number) => Math.ceil(leading * fontScale)
  const column = line(font.leading.lg) + line(font.leading.base)
  const content = sideBySide ? column : column + space.xs + line(font.leading.lg)
  return Math.max(touch.min, content + 2 * space.sm)
}

type Props = {
  onOpen: () => void
  // Whether Home is the screen in front, since the price reads only for somebody looking at it.
  focused: boolean
  // The page's refresh beat, on which the figure re-enters. See Reenter.
  beat: number
  // Whether the hero above says it is not updated, so the two never disagree about the network.
  stale: boolean
}

// The bitcoin price, a band fixed under Home's content and joined to the tab bar: the bar's fill,
// full width, square and flush on it, so the two read as one block. The band keeps its height and
// its fill with a figure or without one, so a price that comes and goes never moves the screen
// above it nor the edge of that block, and with no price at all it draws nothing inside. A price
// that stopped being current has no change beside it, since a change states what is happening now,
// and says "out of date" in its place, since the price line is muted either way.
export function PriceStrip({ onOpen, focused, beat, stale }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const { fontScale } = useWindowDimensions()
  const sideBySide = useSideBySide()
  const line = useBtcPrice(focused)
  const current = line.status === 'price' && line.current && !stale
  const measured = useBtcDayChange(
    current ? line.rate : null,
    line.status === 'price' ? line.readAt : null,
  )
  // As drawn, so the sign and colour follow the digits and a fall that rounds away is never red.
  const change = measured === null ? null : shownPercent(measured)
  const height = priceStripHeight(fontScale, sideBySide)

  if (line.status === 'first') {
    return (
      <View style={[styles.band, { height }]}>
        <BandSkeleton fontScale={fontScale} sideBySide={sideBySide} />
      </View>
    )
  }
  if (line.status === 'none') {
    return <View style={[styles.band, { height }]} />
  }
  const price = formatFiat(line.rate, line.currency)
  const delta =
    !current || change === null
      ? null
      : t('asset.delta', { value: signedPercent(change, i18n.language) })
  const said = t('home.bitcoinPrice', { price })
  return (
    <Touch
      onPress={onOpen}
      // A band lights up as a row does; shrinking it would pull it off the bar it is joined to.
      feedback="row"
      // Replaces the texts inside, so a screen reader hears one line with the words for it, the
      // change said over 24 hours, as the period under it says.
      label={
        !current
          ? `${said}, ${t('home.notUpdated')}`
          : delta === null
          ? said
          : t('home.bitcoinPriceChange', { price, change: delta })
      }
      style={[styles.band, { height }]}>
      <Reenter beat={beat} order={2}>
        {/* The name and the price share the label's box, the price under the name, and that box
            gives way to the change, so the price has every point the change leaves. Side by side
            the change and its period stack in the figure side's own box, at its end beside the
            name; under the price they share one line, so the stacked band is three lines and not
            four. Top-aligned, so a one-line right column, the stale word, stands on the name's
            line rather than halfway between the two. */}
        <FigureRow
          align="flex-start"
          label={
            <>
              <Txt role="subheadingBold" wholeWords style={styles.topLine}>
                Bitcoin
              </Txt>
              {/* Muted like the period across from it: the second line is the detail under the
                  name and the change, current or not. */}
              <Figure role="body" tone="muted" tabular>
                {t('home.priceOfOneBitcoin', { price })}
              </Figure>
            </>
          }>
          {/* The default tone, as the name beside it, so the band reads as one quiet block; the
              sign says the direction. The asset screen's price card keeps the success and danger
              tones. useBtcDayChange measures the last 24 hours, rolling, not the calendar day. */}
          {delta !== null && change !== null && sideBySide && (
            <>
              <Figure role="subheadingBold" tone="default" tabular style={styles.topLine}>
                {delta}
              </Figure>
              <Figure role="caption" tone="muted" style={styles.bottomLine}>
                {t('home.changePeriod')}
              </Figure>
            </>
          )}
          {/* One paragraph, so the period shares the change's baseline and leading, and the two
              shrink together rather than wrap apart. The change is the paragraph's own text, and
              the period a plain Text run in the caption's size, since an alignment belongs to the
              paragraph. */}
          {delta !== null && change !== null && !sideBySide && (
            <Figure role="subheadingBold" tone="default" tabular style={styles.topLine}>
              {delta}{' '}
              <Text style={[styles.periodRun, tones.muted]}>{t('home.changePeriod')}</Text>
            </Figure>
          )}
          {/* The price reads muted either way, so a price that stopped being current says so in
              words, across from the name, where the change would stand. Under the price the band
              counts one line for it, so there it shrinks on that line rather than wrap. */}
          {!current &&
            (sideBySide ? (
              <Txt role="caption" tone="muted" wholeWords style={styles.topLine}>
                {t('home.priceNotCurrent')}
              </Txt>
            ) : (
              <Figure role="caption" tone="muted" style={styles.topLine}>
                {t('home.priceNotCurrent')}
              </Figure>
            ))}
        </FigureRow>
      </Reenter>
    </Touch>
  )
}

// The ready band's shape while the first read is out: the same two columns in the same row, each
// line on its leading at the text size with a bar the height of its type, so the lines read apart
// and the figures land where the bars stood. Under the price the change and period share a line.
function BandSkeleton({
  fontScale,
  sideBySide,
}: {
  fontScale: number
  sideBySide: boolean
}): React.JSX.Element {
  const bar = (leading: number, size: number, width: number) => (
    <View style={[styles.skeletonLine, { height: Math.ceil(leading * fontScale) }]}>
      <Skeleton width={width} height={Math.round(size * fontScale)} />
    </View>
  )
  return (
    <FigureRow
      label={
        <>
          {bar(font.leading.lg, font.size.lg, 72)}
          {bar(font.leading.base, font.size.base, 144)}
        </>
      }>
      {sideBySide ? (
        <>
          {bar(font.leading.lg, font.size.lg, 64)}
          {bar(font.leading.base, font.size.sm, 32)}
        </>
      ) : (
        <Row>
          {bar(font.leading.lg, font.size.lg, 64)}
          {bar(font.leading.lg, font.size.sm, 32)}
        </Row>
      )}
    </FigureRow>
  )
}

const styles = StyleSheet.create({
  // The tab bar's fill and the page gutter inside, so the text lines up with the content above,
  // with no radius, margin or line, since anything of the kind would part it from the bar.
  band: {
    backgroundColor: colors.surface,
    paddingHorizontal: space.xl,
    justifyContent: 'center',
  },
  // The name and the change share the first line, on the leading of their 18pt size.
  topLine: {
    lineHeight: font.leading.lg,
  },
  // The period sits on the price's line across from it, so the two columns pair line for line.
  bottomLine: {
    lineHeight: font.leading.base,
  },
  // The caption's type with no leading of its own, so the paragraph it rides in sets the one line
  // the band counts, and a taller run never takes the room Figure keeps under its box on iOS.
  periodRun: {
    fontSize: font.size.sm,
    ...font.family.regular,
  },
  // A bar sits in the middle of its line, as the type does.
  skeletonLine: {
    justifyContent: 'center',
  },
})
