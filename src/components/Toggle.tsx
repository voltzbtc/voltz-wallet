import React from 'react'
// The one place the app draws the platform switch, so its thumb and track have one definition.
// eslint-disable-next-line no-restricted-imports
import { Switch } from 'react-native'
import { useAccent } from '../wallet/dollarMode'
import { colors } from '../theme'

type Props = {
  value: boolean
  onValueChange: (value: boolean) => void
  disabled?: boolean
  // Left out when the row beside it already names it, since a second name reads twice.
  accessibilityLabel?: string
}

// The app's on and off control. The thumb is white in both states: left to the platform, Android
// paints it the theme's teal when on. The track takes the wallet's accent when on, and when off the
// raised fill, the step that stays visible on a card.
export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: Props): React.JSX.Element {
  const { accent } = useAccent()
  return (
    <Switch
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      accessibilityLabel={accessibilityLabel}
      thumbColor={colors.onPrimary}
      trackColor={{ true: accent, false: colors.surfaceRaised }}
      ios_backgroundColor={colors.surfaceRaised}
    />
  )
}
