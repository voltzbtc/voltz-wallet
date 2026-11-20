import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReduceMotion } from '../hooks/useReduceMotion'
import { useCloseOnLock } from './UnderLock'
import { colors, radius, space } from '../theme'

type Props = {
  visible: boolean
  onClose: () => void
  // Required rather than optional, and the type is the enforcement. Backdrops announce different
  // things on purpose, since cancelling a conversion is not closing a detail. A single fixed label
  // would flatten them, and an optional prop would be forgotten silently, because nobody opens a
  // screen reader to check.
  closeLabel: string
  children: React.ReactNode
  // Every sheet stops at 90% of the window, so the backdrop always shows above it and stays the way
  // out on iOS, where there is no back gesture. A caller passes its own cap only to stop lower. The
  // default gives way while the keyboard is up, as the note on the keyboard below says.
  maxHeight?: `${number}%`
  // A sheet with a text field. See the note on the keyboard below.
  keyboard?: boolean
  // Forwarded because of `autoFocus`. Inside a Modal it fires before the native window is presented,
  // so the keyboard either never rises or rises and drops, and the standard way out is to focus from
  // `onShow` instead, as ScanScreen's manual entry does. A primitive that dropped it would close the
  // only exit for a sheet that opens on a field.
  onShow?: () => void
  // Once the sheet has left the screen. iOS refuses to present anything, a system picker included,
  // while a Modal is still dismissing, so what a sheet's choice opens waits for this. Android's Modal
  // has no such event and an activity starts over a closing dialog, so there it fires on hiding.
  onDismiss?: () => void
  style?: StyleProp<ViewStyle>
}

// The bottom sheet, with one background, one bottom padding and one gap for every sheet in the app.
//
// The bottom padding is `space.xl + insets.bottom` rather than a constant, because only the inset
// knows the device: it comes to 58 on a device with a gesture indicator and 24 on an Android with
// three navigation buttons, where the inset is zero. While the keyboard is up it is `space.xl` alone.
//
// The gap lives on the container and the grabber carries no margin, so the space under the grabber
// is the same gap as the space between children. A child that brings its own `marginBottom` adds to
// the gap rather than replacing it.
//
// Dragging the grabber down closes the sheet, as the grabber promises. The handle takes the panel's
// top padding and reaches into the gap below the grabber, which makes a 44pt strip across the whole
// width without moving anything, and the panel follows the finger unless the person asked to reduce
// motion; the release decides either way. Core PanResponder rather than gesture-handler, which would
// need a root view of its own inside the Modal's window and does not run under this project's jest.
//
// Children are wrapped in a View and never in a scroll. AssetPickerSheet holds a FlatList, and a
// virtualised list inside a scroll view is the thing React Native warns about; a sheet whose content
// can outgrow the cap brings its own ScrollView or list, which shrinks to fit under it while the rest
// keeps its height.
//
// With the keyboard up, the avoider leaves the panel only the room above the keyboard, and 90% of
// that ends content that does not scroll under the keyboard. So while it is up the default cap is that
// room below the status bar. It stays a bound rather than none, so a scroll inside, such as the amount
// sheet's, still shrinks and keeps what follows it above the keyboard. A cap the caller passes holds
// either way.
//
// Back with the keyboard up hides the keyboard and keeps the sheet. Android hands that press to the
// Modal's `onRequestClose` as well as to the keyboard, and closing there drops whatever was typed.
// The keyboard either still reports itself visible when the press arrives, or has just hidden, so a
// press within KEYBOARD_BACK_MS of the keyboard hiding is taken as the one that hid it.
//
// `style` wins over everything here except padding. `styles.sheet` writes `paddingHorizontal`, the
// handle carries the top padding and the array writes `paddingBottom`, and Yoga resolves those over a
// caller's `padding` shorthand by specificity rather than by array order.
const KEYBOARD_BACK_MS = 500
// How far down, or how fast, a release of the grabber has to be to close the sheet.
const CLOSE_DRAG = 80
const CLOSE_SPEED = 1
// The grabber bar's drawn size, exported so a test finds the bar by it rather than by copied figures.
export const GRABBER = { width: 36, height: 4 } as const

export function Sheet({
  visible,
  onClose,
  closeLabel,
  children,
  maxHeight,
  keyboard = false,
  onShow,
  onDismiss,
  style,
}: Props): React.JSX.Element {
  const insets = useSafeAreaInsets()
  const keyboardHidAt = useRef(0)
  // The keyboard's top edge while it is up in a sheet with a field, and null while it is down.
  const [keyboardTop, setKeyboardTop] = useState<number | null>(null)
  const reduced = useReduceMotion()
  // When the PIN is asked again the sheet closes, as a dismissal would. iOS takes the 'none' below in the
  // update that hides it, so it leaves at once; Android plays the exit its Dialog's theme fixed when it
  // was made, and the native cover stays up until that exit ends (PrivacyCover.kt). One its owner keeps
  // open comes back when the lock lifts.
  const underLock = useCloseOnLock(visible, onClose)
  const drag = useRef(new Animated.Value(0)).current
  // Counts the releases that asked to close, so the render that follows one can tell whether the
  // caller closed the sheet or kept it.
  const [closeAsks, setCloseAsks] = useState(0)
  // The responder is made once, so it reads the latest props through these.
  const latest = useRef({ onClose, reduced })
  latest.current = { onClose, reduced }

  const handle = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: (_, g) => g.dy > 0,
        onPanResponderMove: (_, g) => {
          if (!latest.current.reduced) {
            drag.setValue(Math.max(0, g.dy))
          }
        },
        // A release short of the threshold puts the panel straight back. A spring there would be a
        // motion decision of its own, which the design ratchet holds to the shared scale.
        onPanResponderRelease: (_, g) => {
          if (g.dy > CLOSE_DRAG || (g.dy > 0 && g.vy > CLOSE_SPEED)) {
            setCloseAsks(n => n + 1)
            latest.current.onClose()
          } else {
            drag.setValue(0)
          }
        },
        onPanResponderTerminate: () => drag.setValue(0),
      }),
    [drag],
  )

  // A sheet closed by dragging opens again in place, not where the finger left it. A caller may also
  // refuse to close, as Convert's review does while a conversion runs, and a sheet still shown after
  // the release goes back in place too. One that did close keeps its offset and slides out from it.
  useEffect(() => {
    if (visible) {
      drag.setValue(0)
    }
  }, [visible, closeAsks, drag])

  useEffect(() => {
    if (!visible) {
      return
    }
    const sub = Keyboard.addListener('keyboardDidHide', () => {
      keyboardHidAt.current = Date.now()
    })
    return () => sub.remove()
  }, [visible])

  const dismissed = useRef(onDismiss)
  dismissed.current = onDismiss
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (wasVisible.current && !visible && Platform.OS !== 'ios') {
      dismissed.current?.()
    }
    wasVisible.current = visible
  }, [visible])

  // The events KeyboardAvoidingView listens to on each platform, so the cap changes with the room.
  useEffect(() => {
    if (!visible || !keyboard) {
      setKeyboardTop(null)
      return
    }
    const ios = Platform.OS === 'ios'
    const up = Keyboard.addListener(ios ? 'keyboardWillShow' : 'keyboardDidShow', event =>
      setKeyboardTop(event?.endCoordinates?.screenY ?? 0),
    )
    const down = Keyboard.addListener(ios ? 'keyboardWillHide' : 'keyboardDidHide', () => setKeyboardTop(null))
    return () => {
      up.remove()
      down.remove()
    }
  }, [visible, keyboard])

  // The room the avoider leaves ends at the keyboard's top, the figure it pads by in a window that
  // starts at the top of the screen, and the status bar takes the top inset of that room. A top of
  // zero, as iOS reports with cross-fade transitions, leaves the avoider unpadded and the whole room.
  const keyboardUp = keyboardTop !== null
  const cap =
    maxHeight ??
    (keyboardTop === null ? '90%' : keyboardTop > insets.top ? keyboardTop - insets.top : '100%')
  // The keyboard covers the home indicator, so its inset would only be empty room above the keyboard.
  const bottomInset = keyboardUp ? 0 : insets.bottom

  function requestClose() {
    if (Keyboard.isVisible()) {
      Keyboard.dismiss()
      return
    }
    if (Date.now() - keyboardHidAt.current < KEYBOARD_BACK_MS) {
      return
    }
    onClose()
  }

  const panel = (
    <Animated.View
      style={[
        styles.sheet,
        { paddingBottom: space.xl + bottomInset, maxHeight: cap, transform: [{ translateY: drag }] },
        style,
      ]}>
      <View style={styles.handle} {...handle.panHandlers}>
        <View style={styles.grabber} />
      </View>
      {children}
    </Animated.View>
  )

  const backdrop = (
    <Pressable style={styles.backdrop} onPress={onClose} accessibilityRole="button" accessibilityLabel={closeLabel} />
  )

  return (
    // A slide is movement, so with reduced motion the sheet fades in and out instead.
    <Modal
      visible={visible && !underLock}
      transparent
      animationType={underLock ? 'none' : reduced ? 'fade' : 'slide'}
      onRequestClose={requestClose}
      onShow={onShow}
      onDismiss={Platform.OS === 'ios' ? onDismiss : undefined}>
      {keyboard ? (
        // Inside the Modal, because the Modal is its own native window and a provider outside it does
        // not reach in. No offset, because that window starts at the top of the screen. Padding on
        // Android too: on Android 15 and later React Native draws every Modal window edge to edge
        // (ReactModalHostView.kt), and the system does not resize an edge-to-edge window for the
        // keyboard. See the note in Screen.tsx.
        //
        // It fills the window with the backdrop inside, because an auto-height avoider gives the panel's
        // maxHeight nothing to resolve against, and iOS then leaves a searchable list's last row unpainted.
        <KeyboardAvoidingView style={styles.fill} behavior="padding">
          {backdrop}
          {panel}
        </KeyboardAvoidingView>
      ) : (
        <>
          {backdrop}
          {panel}
        </>
      )}
    </Modal>
  )
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  backdrop: { flex: 1, backgroundColor: colors.scrim },
  sheet: {
    backgroundColor: colors.sheet,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    borderCurve: 'continuous',
    paddingHorizontal: space.xl,
    gap: space.lg,
  },
  // The panel's top padding above the grabber and the gap below it, so the strip is 44pt tall and
  // the first child still starts where it did. The negative bottom margin gives the gap back.
  handle: {
    alignItems: 'center',
    marginHorizontal: -space.xl,
    paddingTop: space.xl,
    paddingBottom: space.lg,
    marginBottom: -space.lg,
  },
  grabber: {
    alignSelf: 'center',
    width: GRABBER.width,
    height: GRABBER.height,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
  },
})
