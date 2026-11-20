import React from 'react'
import { colors, space } from '../theme'
import { TabIcon } from './TabIcon'
import { Touch } from './Touch'

type Props = {
  // What the field holds now; with nothing in it there is nothing to clear and nothing is drawn.
  value: string
  onClear: () => void
  // What a screen reader hears, since the mark alone says nothing.
  label: string
}

// The clear inside a field, one look and one touch on every field that offers it. A small mark that
// reaches the touch floor by hit slop, since the floor itself would widen the box and leave the input
// narrower.
export function FieldClear({ value, onClear, label }: Props): React.JSX.Element | null {
  if (value.length === 0) {
    return null
  }
  return (
    <Touch onPress={onClear} feedback="link" size={MARK} hitSlop={space.lg} label={label}>
      <TabIcon name="close" color={colors.textSecondary} size={MARK} />
    </Touch>
  )
}

const MARK = 18
