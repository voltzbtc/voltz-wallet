import React from 'react'
import {
  Pressable,
  StyleSheet,
  type AccessibilityRole,
  type AccessibilityState,
  type StyleProp,
  type View,
  type ViewStyle,
} from 'react-native'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { alpha, press, touch } from '../theme'

// How a target answers a finger, decided by what the control is rather than by the screen it sits on.
//
//   `row`     a line in a list, which lights up: the surface behind it is what changes
//   `surface` a button or a card, which shrinks; the dim is secondary and stays subtle
//   `link`    text acting as a link, where there is no surface to change and only the text can dim
//   `none`    this target does not answer on its own. It is a declaration rather than a fourth
//             treatment, since the area that closes a sheet should not flash under a finger, and a
//             target inside another target would answer twice. Writing it out is what makes
//             somebody think first.
//
// Never scale for a row. A list line that shrinks under the finger drags its neighbours visually and
// reads as the list moving, which is a different message from the one being pressed.
type Feedback = 'row' | 'surface' | 'link' | 'none'

type Props = {
  onPress: () => void
  children: React.ReactNode
  feedback?: Feedback
  // Only for a target with nothing readable inside it, such as an icon, a swatch or a backdrop.
  // When the target does contain text, both platforms already announce that text, and a label here
  // *replaces* it, which usually makes the announcement worse rather than better.
  label?: string
  // What the press leads to, read after the label or the text inside. It adds to them rather than
  // replacing them, so it carries words the screen does not draw, such as a reminder's reason.
  hint?: string
  role?: AccessibilityRole
  // Selected, checked, expanded, busy. A control that looks chosen but does not say so is invisible
  // to a screen reader.
  state?: AccessibilityState
  disabled?: boolean
  // Extends the touch area beyond the box, which `style` cannot do because it is not a style. It
  // covers the small icons the floor alone does not reach: the floor grows the box, this reaches
  // outside it.
  hitSlop?: number
  // A drawn size below the floor, for a target that reaches 44 by hit slop instead of by pixels.
  // It is not an opt-out, because the development check below warns unless `size` plus the slop on
  // both sides clears `touch.min`, so shrinking the box costs enlarging the area, and the two stay
  // tied together.
  //
  // It fits an icon whose surroundings are fixed by something other than the target: a remove circle
  // inside a dense list row, or a reveal eye inside a field, where the floor would widen the icon and
  // push the input narrower. A use in any other shape is worth stopping for.
  //
  // It exists because minWidth and minHeight beat width and height in Yoga regardless of order, so a
  // caller passing `style={styles.remove}` after the floor does not undo it: a 22pt circle would
  // silently double in diameter inside a row sized for 22.
  size?: number
  // Passed through rather than reinvented. Losing `testID` breaks a test loudly, while losing
  // `onLongPress` removes a gesture in silence.
  onLongPress?: () => void
  testID?: string
  style?: StyleProp<ViewStyle>
  // For a target something has to measure, as a code that grows out of its own place.
  ref?: React.Ref<View>
}

// Every tappable thing, so feedback, what a screen reader announces and the 44pt floor are decided
// once rather than per screen.
//
// `justifyContent: 'center'` below centres content vertically in the common case, where the target
// lays out as a column. A caller writing `flexDirection: 'row'` turns that into the horizontal axis:
// a child with `flex: 1` eats the slack, and otherwise the caller passes its own alignment, which
// wins because `style` comes after.
//
// The 44pt floor lives here rather than in a rule, which is the point. Declaring it in prose means
// every future control has to remember; declaring it in the component means none of them can forget.
export function Touch({
  onPress,
  children,
  feedback = 'row',
  label,
  hint,
  role = 'button',
  state,
  disabled = false,
  hitSlop,
  size,
  onLongPress,
  testID,
  style,
  ref,
}: Props): React.JSX.Element {
  const reduced = useReduceMotion()
  // The arithmetic that makes `size` a declaration rather than an escape. Hit slop is one number here,
  // so it applies to every side and counts twice on each axis.
  if (__DEV__ && size != null && size + 2 * (hitSlop ?? 0) < touch.min) {
    console.warn(
      `Touch: size ${size} with hit slop ${hitSlop ?? 0} reaches ${
        size + 2 * (hitSlop ?? 0)
      }, under the ${touch.min} floor.`,
    )
  }

  return (
    <Pressable
      ref={ref}
      onPress={onPress}
      onLongPress={onLongPress}
      disabled={disabled}
      hitSlop={hitSlop}
      testID={testID}
      accessibilityRole={role}
      accessibilityLabel={label}
      accessibilityHint={hint}
      // Merged rather than replaced, so a caller passing `selected` does not erase the disabled state
      // the same call already declared.
      accessibilityState={{ disabled, ...state }}
      style={({ pressed }) => [
        styles.target,
        size != null && { minHeight: size, minWidth: size },
        disabled && styles.disabled,
        style,
        pressed && !disabled && pressedStyle(feedback, reduced),
      ]}>
      {children}
    </Pressable>
  )
}

// Scale is movement, so it goes when the device asks for less of it. The dim stays: reduced motion is
// about things moving, not about things changing, and a press with no feedback at all is worse for
// everybody than a press that only dims.
function pressedStyle(feedback: Feedback, reduced: boolean): ViewStyle {
  if (feedback === 'none') {
    return styles.none
  }
  if (feedback === 'surface') {
    return reduced ? styles.surfaceReduced : styles.surface
  }
  return feedback === 'link' ? styles.link : styles.row
}

const styles = StyleSheet.create({
  // The floor, and the reason this component exists at all. On both axes, since the rule is 44 by 44
  // and a floor on the height alone leaves a header icon 24 wide and 44 tall.
  target: { minHeight: touch.min, minWidth: touch.min, justifyContent: 'center' },
  disabled: { opacity: alpha.disabled },
  row: { backgroundColor: press.row },
  surface: { opacity: press.scaled, transform: [{ scale: press.scale }] },
  surfaceReduced: { opacity: press.scaled },
  link: { opacity: press.dim },
  none: {},
})
