import React from 'react'
import { View, type ViewProps } from 'react-native'

// Native TurboModule, absent in Jest. Reported as unsupported so components render their
// approximation path.
export const isLiquidGlassSupported = false

export function LiquidGlassView(props: ViewProps): React.JSX.Element {
  return <View {...props} />
}

export function LiquidGlassContainerView(props: ViewProps): React.JSX.Element {
  return <View {...props} />
}
