// The real provider renders children only after the native module delivers screen metrics, so under
// Jest the whole tree collapses to `children: null`. The library's own mock is an untransformed .tsx
// inside node_modules, hence this reimplementation.
import React from 'react'
import { View, type ViewProps } from 'react-native'

const INSETS = { top: 0, right: 0, bottom: 0, left: 0 }
const FRAME = { x: 0, y: 0, width: 320, height: 640 }

export const SafeAreaProvider = ({ children }: { children?: React.ReactNode }) => (
  <>{children}</>
)

export const SafeAreaView = ({ children, ...props }: ViewProps) => (
  <View {...props}>{children}</View>
)

export const SafeAreaInsetsContext = React.createContext(INSETS)
export const SafeAreaFrameContext = React.createContext(FRAME)

export const useSafeAreaInsets = () => INSETS
export const useSafeAreaFrame = () => FRAME
export const initialWindowMetrics = { insets: INSETS, frame: FRAME }
