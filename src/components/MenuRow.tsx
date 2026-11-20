import React from 'react'
import { StyleSheet, View } from 'react-native'
import { Txt } from './Txt'
import { TabIcon, type TabIconName } from './TabIcon'
import { Touch } from './Touch'
import { colors, dividerBottom, space } from '../theme'

type Props = {
  label: string
  icon?: TabIconName
  leading?: React.ReactNode
  // A row without one is not a target: it draws at full strength with no press feedback, and a
  // control passed in `right`, such as a Toggle, answers on its own.
  onPress?: () => void
  // Dims the row and refuses the press, for a target that is locked for now.
  disabled?: boolean
  value?: string
  // Defaults to a chevron when the row navigates. Pass null to drop it.
  right?: React.ReactNode
  // Only for a container padded by space.xl, since a row inside a card must not overflow it.
  bleed?: boolean
  // Pass false on the last row of a group so the hairline does not dangle over empty space.
  divider?: boolean
  // Makes assistive tech announce the active choice in a picker.
  selected?: boolean
  // For a row whose action takes something away, such as removing a photo.
  danger?: boolean
}

export function MenuRow({
  label,
  icon,
  leading,
  onPress,
  disabled = false,
  value,
  right,
  bleed = false,
  divider = true,
  selected,
  danger = false,
}: Props): React.JSX.Element {
  const trailing =
    right !== undefined ? right : onPress ? <TabIcon name="chevron" color={colors.textSecondary} size={18} /> : null
  const style = [styles.row, bleed && styles.bleed, divider && styles.divider]
  const lead =
    leading ?? (icon && <TabIcon name={icon} color={danger ? colors.danger : colors.textSecondary} size={22} />)
  const shown = value != null && (
    <Txt role="body" tone="muted" wholeWords style={styles.value}>
      {value}
    </Txt>
  )
  // The label fills the row, so where it sits inside that width is its alignment.
  const name = (
    <Txt role="body" tone={danger ? 'danger' : undefined} wholeWords style={styles.label}>
      {label}
    </Txt>
  )
  // Never a disabled Touch, which dims the row and leaves a Toggle inside it unresponsive on iOS.
  if (!onPress) {
    return (
      <View style={style}>
        {lead}
        {name}
        {shown}
        {trailing}
      </View>
    )
  }
  return (
    <Touch
      onPress={onPress}
      disabled={disabled}
      feedback="row"
      state={selected != null ? { selected } : undefined}
      style={style}>
      {lead}
      {name}
      {shown}
      {trailing}
    </Touch>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    paddingVertical: space.lg,
  },
  // Stretching past the container padding and re-insetting runs the fill to the edges.
  bleed: {
    marginHorizontal: -space.xl,
    paddingHorizontal: space.xl,
  },
  divider: {
    ...dividerBottom,
  },
  label: {
    flex: 1,
  },
  // Gives way to the label before it reaches it. The label grows from a basis of 0, so a value that
  // kept its width would take the whole row at a large text size and leave the label none.
  value: {
    maxWidth: '50%',
  },
})
