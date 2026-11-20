import React from 'react'
import { Image, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { colors, font, radius, textScale } from '../theme'
import { leadingText } from '../i18n/direction'
import { cropFrame, readCrop, type PhotoCrop } from '../wallet/photoCrop'

type Props = {
  color: string
  // Absolute file path; absent falls back to the colored monogram disc.
  imagePath?: string | null
  // The square of the photo to show. Without one, or with one that is not a crop, the photo covers
  // the disc from its centre.
  crop?: PhotoCrop | null
  monogram: string
  size?: number
}

export function WalletAvatar({ color, imagePath, crop, monogram, size = 44 }: Props): React.JSX.Element {
  const dim = { width: size, height: size, borderRadius: radius.full }
  if (imagePath) {
    const uri = imagePath.startsWith('file://') ? imagePath : `file://${imagePath}`
    const square = readCrop(crop)
    if (!square) {
      return <Image source={{ uri }} style={[styles.avatar, dim]} />
    }
    const frame = cropFrame(square, size)
    return (
      <View style={[styles.avatar, dim]}>
        <Image
          source={{ uri }}
          style={[
            styles.cropped,
            {
              width: frame.width,
              height: frame.height,
              left: frame.left,
              top: frame.top,
              transform: [{ translateX: frame.translateX }, { translateY: frame.translateY }],
            },
          ]}
        />
      </View>
    )
  }
  return (
    <View style={[styles.avatar, dim, { backgroundColor: color }]}>
      {/* A drawn badge rather than text in the layout, so its letters scale with the disc and not with
          the type scale, which would push them out of the circle at the larger text sizes. */}
      <Text
        maxFontSizeMultiplier={textScale.badgeMax}
        style={[leadingText(), styles.text, { fontSize: Math.round(size * 0.45) }]}>
        {monogram}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  avatar: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  cropped: {
    position: 'absolute',
  },
  text: {
    color: colors.text,
    ...font.family.bold,
  },
})
