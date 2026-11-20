import React from 'react'
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native'
import { useTranslation } from 'react-i18next'
import { colors, rhythm, space } from '../theme'
import { Field } from './Field'
import { TabIcon } from './TabIcon'
import { FieldClear } from './FieldClear'

type Props = {
  value: string
  onChangeText: (text: string) => void
  // What is searched, as the placeholder and as what a screen reader hears.
  label: string
  // A sheet spaces its children itself and has no gutter to keep, which a screen's list search does.
  inSheet?: boolean
}

// The search over a list, the same box, keyboard and clear on every list. It takes no style, so a
// screen cannot choose its own space: on a screen it holds the content margin while the rows reach
// the edges, and leaves `rhythm.searchToList` under it.
export function SearchField({ value, onChangeText, label, inSheet = false }: Props): React.JSX.Element {
  const { t } = useTranslation()
  const style: StyleProp<ViewStyle> = inSheet ? undefined : styles.onScreen
  return (
    <Field
      style={style}
      value={value}
      onChangeText={onChangeText}
      placeholder={label}
      accessibilityLabel={label}
      // A query is not a sentence, and a capital or a correction changes what it finds.
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      returnKeyType="search"
      leading={<TabIcon name="search" color={colors.textSecondary} size={18} />}
      trailing={<FieldClear value={value} onClear={() => onChangeText('')} label={t('send.clear')} />}
    />
  )
}

const styles = StyleSheet.create({
  onScreen: {
    paddingHorizontal: space.xl,
    marginBottom: rhythm.searchToList,
  },
})
