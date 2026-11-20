import React from 'react'
import { StyleSheet, View } from 'react-native'
import { Text } from './Text'
import type { SvgProps } from 'react-native-svg'
import { BITCOIN_ASSET_ID } from '../wallet/assets'
import { DEPIX, USDB } from '../wallet/tokens'
import { colors, font, radius, textScale } from '../theme'
import BitcoinLogo from '../assets/asset-icons/bitcoin.svg'
import UsdbLogo from '../assets/asset-icons/usdb.svg'
import DepixLogo from '../assets/asset-icons/depix.svg'
import { STABLE_LOGOS } from './stableLogos'
import { leadingText } from '../i18n/direction'

type Props = {
  assetId: string
  ticker: string
  size?: number
}

// TokenMetadata carries no icon field, so every logo has to ship with the app. A token's mark is keyed
// by its official identifier, so a lookalike with the same name keeps the letter badge.
const SVG_LOGOS: Record<string, React.FC<SvgProps>> = {
  [BITCOIN_ASSET_ID]: BitcoinLogo,
  [USDB.identifier]: UsdbLogo,
  [DEPIX.identifier]: DepixLogo,
  ...STABLE_LOGOS,
}

export function AssetIcon({ assetId, ticker, size = 28 }: Props): React.JSX.Element {
  const Svg = SVG_LOGOS[assetId]
  if (Svg) {
    // Clipped so a square token mark still reads as a coin next to the round Bitcoin logo.
    return (
      <View style={[styles.clip, { width: size, height: size }]}>
        <Svg width={size} height={size} />
      </View>
    )
  }

  return (
    <View style={[styles.badge, { width: size, height: size }]}>
      {/* A drawn badge rather than text in the layout, so its letter scales with the disc and not with
          the type scale. */}
      <Text
        maxFontSizeMultiplier={textScale.badgeMax}
        style={[leadingText(), styles.label, { fontSize: size * 0.5 }]}>
        {ticker.slice(0, 1).toUpperCase()}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  clip: {
    borderRadius: radius.full,
    overflow: 'hidden',
  },
  badge: {
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.full,
    alignItems: 'center',
    justifyContent: 'center',
  },
  label: {
    color: colors.text,
    ...font.family.bold,
  },
})
