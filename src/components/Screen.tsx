import React, { useEffect, useRef, useState } from 'react'
import {
  Keyboard,
  KeyboardAvoidingView,
  ScrollView,
  StyleSheet,
  type RefreshControlProps,
  // Read for which field has focus, never drawn.
  // eslint-disable-next-line no-restricted-imports
  TextInput,
  View,
  type HostInstance,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import type { ScrollGesture } from '../hooks/usePullFeedback'
import { colors, space } from '../theme'

type Layout = 'plain' | 'padded' | 'center'

type Props = {
  children: React.ReactNode
  // Off by default, and that is the load-bearing decision here. HistoryScreen returns three different
  // roots from one component: a ScrollView while loading or empty, a centred View for an error, and a
  // FlatList with data. A Screen that scrolled by default would put a virtualised list inside a
  // scroll view, which React Native warns about and which breaks the virtualisation outright.
  scroll?: boolean
  // Rendered outside the scrolling area, so a call to action stays put while the body moves. Passed
  // as a child of a scrolling Screen instead, a button would scroll away with the content.
  footer?: React.ReactNode
  // Tied to the keyboard rather than to scrolling. With `keyboardShouldPersistTaps`, the first tap on
  // a button while the keyboard is up both dismisses the keyboard and fires the button, instead of
  // only dismissing. ImportScreen's suggestion bar depends on that, and turning it on for every
  // screen would change how each of them answers a tap, so it is opt-in.
  keyboard?: boolean
  // Only a scrolling Screen has anything to pull. A FlatList root takes the same element itself.
  refreshControl?: React.ReactElement<RefreshControlProps>
  layout?: Layout
  style?: StyleProp<ViewStyle>
  contentStyle?: StyleProp<ViewStyle>
  // Any finger landing on the body, scrolling included, for a screen that holds back a change of
  // layout while someone is on it.
  onTouchStart?: () => void
  // The drag and the glide of a scrolling Screen, which a view around it never hears.
  scrollGesture?: ScrollGesture
}

// The app's screen root is `{ flex: 1, backgroundColor: colors.background }` plus one of three
// content layouts.
//
// It also owns the bottom inset, `space.xl + insets.bottom`, because a screen that forgets it puts its
// last row under the home indicator.
//
// A screen whose root is not a plain background, such as SplashScreen's Animated.View, stays out on
// purpose. Giving this a background prop or an `as` prop to fit one would reopen the door it exists to
// close.
export function Screen({
  children,
  scroll = false,
  footer,
  keyboard = false,
  refreshControl,
  layout = 'plain',
  style,
  contentStyle,
  onTouchStart,
  scrollGesture,
}: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  // Applied in all four combinations of scroll and layout, and zeroed only by a footer, so `plain`
  // without `scroll` gets the inset like every other combination.
  // With a footer the whole bottom of the screen belongs to the footer: its own top padding is the
  // gap after the content, and the inset under it is the clearance over the home indicator. The
  // content contributes nothing, or the two stack into a double gap and 34pt of empty list sits
  // behind the footer where no screenshot shows it.
  const bottom = { paddingBottom: footer ? 0 : space.xl + insets.bottom }
  const content = [styles[layout], bottom, contentStyle]

  // `style` lands on the outermost element in every case, footer or not, so one prop never means two
  // things depending on another prop.
  const outer = footer ? undefined : style

  const list = useRef<ScrollView>(null)
  const viewport = useRef<Viewport>({ offset: 0, height: 0 })
  const reveals = scroll && keyboard
  useEffect(() => {
    if (!reveals) {
      return
    }
    // Also on a keyboard that is already up, which iOS announces again when focus moves to another
    // field.
    const shown = Keyboard.addListener('keyboardDidShow', () => revealFocused(list.current, viewport.current))
    return () => shown.remove()
  }, [reveals])

  const body = scroll ? (
    <ScrollView
      ref={list}
      style={[styles.screen, outer]}
      contentContainerStyle={content}
      refreshControl={refreshControl}
      onTouchStart={onTouchStart}
      {...scrollGesture}
      // Only when this screen says it has a keyboard. See the note on the prop.
      keyboardShouldPersistTaps={keyboard ? 'handled' : 'never'}
      onLayout={
        reveals
          ? event => {
              const height = event.nativeEvent.layout.height
              const shrank = height < viewport.current.height
              viewport.current.height = height
              if (shrank) {
                revealFocused(list.current, viewport.current)
              }
            }
          : undefined
      }
      onScroll={
        reveals
          ? event => {
              viewport.current.offset = event.nativeEvent.contentOffset.y
            }
          : undefined
      }
      // A field's focus bubbles up here after the field has made itself the focused input. With a
      // hardware keyboard no keyboard shows and the scroll never shrinks, so this is the only event
      // that brings a field gaining focus out from behind the footer.
      onFocus={reveals ? () => revealFocused(list.current, viewport.current) : undefined}
      scrollEventThrottle={reveals ? 16 : undefined}>
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.screen, content, outer]} onTouchStart={onTouchStart}>
      {children}
    </View>
  )

  const stacked = footer ? (
    <View style={[styles.screen, style]}>
      {body}
      <View style={{ paddingBottom: insets.bottom }}>{footer}</View>
    </View>
  ) : (
    body
  )

  if (!keyboard) {
    return stacked
  }
  return <KeyboardScreen>{stacked}</KeyboardScreen>
}

// The part of a footer that is a call to action GradientButton draws concealed: a disabled primary
// button is invisible and keeps its box, so nothing moves when it turns on. With the keyboard up
// that box is an empty band of 120 to 140pt right above the keyboard, over what is being typed, so
// while the keyboard is up a concealed action gives its box back. With the keyboard down it keeps
// it. A component rather than a Screen prop, because a footer can carry more than its action, such
// as ImportScreen's word suggestions, which have to stay while typing.
export function FooterAction({
  concealed,
  children,
}: {
  concealed: boolean
  children: React.ReactNode
}): React.JSX.Element | null {
  const keyboardUp = useKeyboardUp()
  return concealed && keyboardUp ? null : <>{children}</>
}

// What a centred Screen holds across its whole width, a message and its buttons as one block. The
// centred layout otherwise sizes each child to its own content, a button to its label.
export function CenterStack({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <View style={styles.centerStack}>{children}</View>
}

// keyboardDidShow and keyboardDidHide, which both platforms send, rather than the will events that
// only iOS does.
function useKeyboardUp(): boolean {
  const [up, setUp] = useState(() => Keyboard.isVisible())
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setUp(true))
    const hidden = Keyboard.addListener('keyboardDidHide', () => setUp(false))
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return up
}

type Viewport = { offset: number; height: number }

// What a reveal brings into view for an input when more than the input belongs to it. Field puts its
// whole group here, label, box and the line under it, so the hint under a field comes up with the box
// rather than staying behind the footer. Keyed by the input, so any other input that takes the focus
// is revealed by itself.
const revealGroups = new WeakMap<HostInstance, HostInstance>()

// Called from a field's own focus handler, which runs once its input is the focused one and before the
// focus bubbles up to the scroll.
export function revealFocusedWith(group: HostInstance | null): void {
  const input = TextInput.State.currentlyFocusedInput()
  if (input && group) {
    revealGroups.set(input, group)
  }
}

// The avoider shrinks the scroll from the bottom, and nothing scrolls a focused field that the new
// bottom edge, or a footer above the keyboard, now covers: iOS leaves it there. So once the visible
// part shrinks, and whenever a field gains focus, the focused field is brought back above that edge.
//
// The field is measured against the scroll's content view. One outside that view, such as a field in
// the footer, fails the measurement and is left alone. A sheet rendered as a child of the scroll is
// not outside it under Fabric: its Modal sits inside the content view in the shadow tree, so a field
// on the sheet can measure, and the scroll behind the sheet can move (ConvertSpark's picker search).
// The sheet itself is its own window and stays put.
function revealFocused(list: ScrollView | null, viewport: Viewport): void {
  const input = TextInput.State.currentlyFocusedInput()
  // getInnerViewRef is part of ScrollView in React Native 0.86 and missing from its .d.ts.
  const content = (list as (ScrollView & { getInnerViewRef?: () => HostInstance | null }) | null)?.getInnerViewRef?.()
  // A focus can arrive before the scroll has measured itself (a field focused as it mounts, for one),
  // and scrolling against a viewport of no height would put the field at the top.
  if (!list || !input || !content || viewport.height === 0) {
    return
  }
  const reveal = (bottom: number) => {
    if (bottom > viewport.offset + viewport.height) {
      list.scrollTo({ y: bottom - viewport.height, animated: true })
    }
  }
  input.measureLayout(
    content,
    (_x, y, _width, height) => {
      const own = y + height + space.lg
      const group = revealGroups.get(input)
      if (!group) {
        reveal(own)
        return
      }
      // The group's bottom, but never past the point where the input's top would leave the view: at
      // the largest text sizes a hint can be taller than what the keyboard leaves, and the input is
      // what is being typed in.
      group.measureLayout(
        content,
        (_gx, groupY, _gw, groupHeight) =>
          reveal(Math.min(groupY + groupHeight + space.lg, y + viewport.height)),
        () => reveal(own),
      )
    },
    () => {},
  )
}

// Padding on both platforms. On Android 15 and later an app targeting SDK 35 is drawn edge to edge,
// and React Native turns that on by itself (`updateEdgeToEdgeFeatureFlag` in WindowUtil.kt), whatever
// `edgeToEdgeEnabled` says. An edge-to-edge window is not resized for the keyboard, so
// `adjustResize` in the manifest no longer moves anything. Where the system does still resize, the
// avoider measures no overlap and adds nothing.
//
// The offset is where the avoider starts in the window. KeyboardAvoidingView compares its frame,
// which is relative to its parent, with the keyboard's top, which is in window coordinates, so under
// a native header it would leave the header's height of content behind the keyboard.
function KeyboardScreen({ children }: { children: React.ReactNode }): React.JSX.Element {
  const frame = useRef<View>(null)
  const [top, setTop] = useState(0)
  return (
    <View
      ref={frame}
      style={styles.screen}
      onLayout={() => frame.current?.measureInWindow((_x, y) => setTop(y))}>
      <KeyboardAvoidingView style={styles.screen} behavior="padding" keyboardVerticalOffset={top}>
        {children}
      </KeyboardAvoidingView>
    </View>
  )
}

// Exported so a test can assert that a layout contributes nothing, which asserting key by key
// cannot: every key not named stays free to appear.
export const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // The three content layouts. They are exclusive, which is why this is one string prop rather than
  // three booleans that could be combined into nonsense.
  plain: {},
  // Horizontal and top only, because the bottom comes from the inset above, and a bottom margin
  // cannot be right without knowing the device.
  padded: { paddingHorizontal: space.xl, paddingTop: space.xl },
  // flexGrow rather than flex. As a content container, `flex: 1` pins the content to the viewport
  // height so it can never exceed it and the scroll never happens, which is precisely the case
  // `center` exists for: an empty state that still has to scroll at a large text size.
  center: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  centerStack: {
    alignSelf: 'stretch',
    gap: space.md,
  },
})
