import React from 'react'
import { Pressable, StyleSheet, View } from 'react-native'
import { Text } from './Text'
import { colors, font, radius, space, touch } from '../theme'
import { leadingText } from '../i18n/direction'

type Option<T extends string | number> = {
  label: string
  value: T
  // A mark before the label, for a choice between things that have one (a coin, a network).
  icon?: React.ReactNode
}

type Props<T extends string | number> = {
  options: Option<T>[]
  value: T
  onChange: (value: T) => void
}

export function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
}: Props<T>): React.JSX.Element {
  return (
    <View style={styles.track}>
      {options.map(option => {
        const active = option.value === value
        return (
          <Pressable
            key={String(option.value)}
            onPress={() => onChange(option.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: active }}
            // The segment is 40 inside a 48 track; the slop reaches the track's edge for a 48pt target.
            hitSlop={{ top: space.xs, bottom: space.xs }}
            style={({ pressed }) => [
              styles.segment,
              active && styles.segmentActive,
              pressed && !active && styles.segmentPressed,
            ]}>
            {option.icon}
            {/* At six segments a long label breaks mid-word instead of shrinking. */}
            <Text
              numberOfLines={1}
              style={[leadingText(), styles.label, active && styles.labelActive]}>
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const styles = StyleSheet.create({
  // The height of every full-width selector, and the field radius, since it stacks with picker rows.
  // The segment's radius is the track's less its padding, so the two curves stay concentric.
  track: {
    flexDirection: 'row',
    minHeight: touch.selector,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    padding: space.xs,
    gap: space.xs,
  },
  // A row, so an optional mark sits before the label; a label alone lays out the same either way.
  segment: {
    flex: 1,
    flexDirection: 'row',
    gap: space.xs,
    paddingVertical: space.sm,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentActive: {
    backgroundColor: colors.surface,
  },
  // A segment lights up under the finger, as a list row does, rather than fading. The chosen one keeps
  // its own fill, since pressing it again changes nothing.
  segmentPressed: {
    backgroundColor: colors.pressedOverlay,
  },
  // Shrinks beside a mark rather than pushing past the segment.
  label: {
    flexShrink: 1,
    fontSize: font.size.sm,
    ...font.family.medium,
    color: colors.textSecondary,
  },
  labelActive: {
    color: colors.text,
  },
})
