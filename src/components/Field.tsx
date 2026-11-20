import React, { useRef, useState } from 'react'
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native'
import { TextInput, useFontScale, type TextInputRef } from './Text'
import { useAccent } from '../wallet/dollarMode'
import { Skeleton } from './Skeleton'
import { Txt } from './Txt'
import { colors, dangerSoftSurface, font, radius, space, touch } from '../theme'
import { leadingInput } from '../i18n/direction'
import { revealFocusedWith } from './Screen'
import { useAnnounced } from '../hooks/useAnnounced'

type Props = {
  value: string
  onChangeText: (text: string) => void
  // Said above the field when there is one, as a 14pt muted line. A field without it relies on the
  // placeholder alone, so it passes `accessibilityLabel`.
  label?: string
  // Said below it. The two are one component rather than two because a message about a field that
  // is not attached to the field is a message somebody has to connect by eye. Which of them shows,
  // and whether the line reads as guidance or as a problem, is decided by `error` below.
  hint?: string
  error?: string
  // The fill of an error with no line under the box, for a field whose message sits elsewhere, as the
  // restore screen's one line about twelve cells does.
  invalid?: boolean
  // Sits to the left of the input inside the same box, such as a search mark or a word's number.
  leading?: React.ReactNode
  // Sits to the right of the input inside the same box, such as a domain suffix, a unit or a clear
  // button.
  trailing?: React.ReactNode
  // A thin bar over the box's lower edge, for a read the typed value started, so nothing around the
  // field moves.
  progress?: boolean
  // Holds the box left to right in every language, for a value that reads that way whatever the
  // layout, such as a name followed by its domain suffix, which a mirrored row would put first.
  ltr?: boolean
  ref?: React.Ref<TextInputRef>
  style?: StyleProp<ViewStyle>
} & Omit<React.ComponentProps<typeof TextInput>, 'style' | 'value' | 'onChangeText' | 'ref'>

// The app's text field, and the only place that draws a TextInput. It fixes one radius, curve, fill,
// text colour and size, one height, and one way of saying each state.
//
// No state draws an outline. At rest the box is its fill and the label or placeholder says what it is
// for. Focus is a step of fill and the caret in the wallet's accent, because a field that looks
// identical whether or not it has the keyboard is a field somebody taps twice. An error is the danger
// fill and the red line under the box, and it wins over focus.
//
// Height comes from a minimum rather than from vertical padding: the box is `touch.selector` tall and
// centres what is in it, which holds when the device scales type, where padding arithmetic does not.
// It is the height and the side padding of a picker row, since the two stack as one column.
//
// `multiline` makes it a top-aligned box of a fixed three lines, for a pasted address.
//
// The input keeps room for a few characters at the size it draws, and a trailing piece that would
// leave it less wraps onto a line of its own inside the box. A trailing text grows with the type as
// the input does, so at the largest sizes a domain suffix alone is as wide as the box, and an input
// that only takes what is left is drawn with no width while the line under it reports on the name.
export function Field({
  value,
  onChangeText,
  label,
  hint,
  error,
  invalid = false,
  leading,
  trailing,
  progress = false,
  ltr = false,
  ref,
  style,
  ...rest
}: Props): React.JSX.Element {
  const [focused, setFocused] = useState(false)
  // The caret follows the wallet. It is one of the two things that say the keyboard is here, so it
  // must not flash orange while the rest of the chrome is green.
  const { accent } = useAccent()
  // Truthiness, not nullity. A form clears its error with `setError('')`, and a nullity check would
  // leave the box red for good and draw a blank line under it that displaces the hint as well.
  const wrong = Boolean(error) || invalid
  const below = error || hint
  // The alert role on the line says nothing by itself, so the error is announced; a hint is not.
  useAnnounced(error)
  const fontScale = useFontScale()
  const group = useRef<View>(null)
  const multiline = rest.multiline === true

  return (
    <View ref={group} style={[styles.group, style]}>
      {label != null && (
        <Txt role="label" tone="muted">
          {label}
        </Txt>
      )}
      <View
        style={[
          styles.box,
          multiline && styles.boxMultiline,
          ltr && styles.ltr,
          focused && styles.focused,
          wrong && dangerSoftSurface,
        ]}>
        {leading}
        <TextInput
          ref={ref}
          value={value}
          onChangeText={onChangeText}
          placeholderTextColor={colors.textSecondary}
          style={[
            styles.input,
            multiline && styles.inputMultiline,
            { minWidth: font.size.base * fontScale * INPUT_MIN_EMS },
            leadingInput(),
            ltr && styles.inputLtr,
          ]}
          // The label above is a separate text, so a screen reader on the input hears it only through
          // this. Before the spread, so a caller can still name the input another way.
          accessibilityLabel={label}
          {...rest}
          // After the spread, so no caller can leave the system's caret in a field of this app. iOS
          // takes the tint only when the prop changes, and a recycled input that turns multiline gets a
          // new native view with no tint under the same prop (RCTCopyBackedTextInput copies none), so a
          // multiline field sets it when focus brings the caret.
          selectionColor={multiline && !focused ? undefined : accent}
          cursorColor={accent}
          // The app is dark in every system appearance, and iOS follows the system.
          keyboardAppearance="dark"
          // After the spread, so a caller adding its own handlers cannot silently take the focus step
          // with them.
          onFocus={event => {
            // So a scroll that reveals this field brings up the line under the box with it.
            revealFocusedWith(group.current)
            setFocused(true)
            rest.onFocus?.(event)
          }}
          onBlur={event => {
            setFocused(false)
            rest.onBlur?.(event)
          }}
        />
        {multiline && trailing ? <View style={styles.trailingTop}>{trailing}</View> : trailing}
        {progress && (
          <View style={styles.progress}>
            <Skeleton height={space.xs} />
          </View>
        )}
      </View>
      {/* An error replaces the hint rather than stacking with it. Two lines under one field, one
          saying what to do and one saying what went wrong, is where a person stops reading either. */}
      {below ? (
        <Txt role="caption" tone={error ? 'danger' : 'muted'} accessibilityRole={error ? 'alert' : undefined}>
          {below}
        </Txt>
      ) : null}
    </View>
  )
}

// The input's floor in ems of its own type, room for a short name before a trailing piece wraps.
const INPUT_MIN_EMS = 4

const styles = StyleSheet.create({
  group: { gap: space.sm },
  box: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    alignItems: 'center',
    // A wrapping row centres each line within its own height, so the lines are centred in the
    // box's floor here, where a single line sat before wrapping was allowed.
    alignContent: 'center',
    columnGap: space.sm,
    // The floor rather than computed padding, for the same reason as every other target in the app.
    minHeight: touch.selector,
    paddingHorizontal: space.lg,
    backgroundColor: colors.surfaceVariant,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  boxMultiline: {
    flexWrap: 'nowrap',
    alignItems: 'flex-start',
  },
  // One step of fill, the sign of focus now that nothing outlines the box.
  focused: { backgroundColor: colors.surfaceRaised },
  ltr: { direction: 'ltr' },
  // The left edge is the leading one once the box is held left to right, on both platforms.
  inputLtr: { textAlign: 'left' },
  input: {
    flex: 1,
    color: colors.text,
    fontSize: font.size.base,
    // Removes the extra vertical space Android reserves for a hint line, which otherwise makes the
    // same field taller there than on iOS.
    paddingVertical: 0,
  },
  // Fixed rather than a minimum, because iOS caches the native contentSize of a multiline input.
  inputMultiline: {
    height: touch.multiline,
    paddingVertical: space.md,
    textAlignVertical: 'top',
  },
  trailingTop: { paddingTop: space.md },
  // Over the box's own lower edge, so the controls under the field stay where a finger expects.
  progress: {
    position: 'absolute',
    left: space.lg,
    right: space.lg,
    bottom: space.sm,
  },
})
