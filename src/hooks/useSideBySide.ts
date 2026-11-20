import { useWindowDimensions } from 'react-native'
import { textScale } from '../theme'

// Whether a label and its figure, or a pair of half-width buttons such as Home's two actions, still
// fit side by side at the window's width and the system text size. Read on every render, so a size
// chosen in the settings while the app is open regroups the screen at once.
export function useSideBySide(): boolean {
  const { width, fontScale } = useWindowDimensions()
  return width / fontScale >= textScale.sideBySideFrom
}
