import React, { useEffect, useRef, useState } from 'react'
import { Animated, Pressable, StyleSheet, View } from 'react-native'
import { Text } from '../components/Text'
import { useTranslation } from 'react-i18next'
import { clearPinFailures, enterPin, pinWaitLeft, type PinEntry } from '../wallet/pin'
import { formatClock } from '../wallet/clock'
import {
  getBiometryKind,
  isBiometricUnlockEnabled,
  unlockWithBiometrics,
  type BiometryKind,
} from '../wallet/biometrics'
import { TabIcon } from '../components/TabIcon'
import { ErrorBox } from '../components/ErrorBox'
import { GradientButton } from '../components/GradientButton'
import { Touch } from '../components/Touch'
import { Txt } from '../components/Txt'
import { useAccent } from '../wallet/dollarMode'
import { colors, font, motion, radius, space, textScale, touch } from '../theme'
import { leadingText } from '../i18n/direction'
import { useAnnounced } from '../hooks/useAnnounced'
import { useReduceMotion } from '../hooks/useReduceMotion'

const PIN_LENGTH = 6
// One dot's turn after a biometric success, so the six and the step after them take motion.fast.
const FILL_STEP_MS = motion.fast / PIN_LENGTH
const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del']
const DOT = 16
const KEY = 72
// Three keys and the two gaps between them.
const KEYPAD_WIDTH = KEY * 3 + space.md * 2
const BIOMETRIC_ICON = 34
const BIOMETRIC_ROW = BIOMETRIC_ICON + 2 * space.sm
// Two lines hold the longest error in every locale, so a reject never moves the keypad under the finger.
const ERROR_SLOT = font.leading.sm * 2

type Props =
  // `setup` picks the first-step title, where 'change' reads "new PIN" after the current one verifies.
  // A rejected onDone is the write failing: the screen says so and Try again repeats the same PIN.
  | { mode: 'set'; setup?: 'create' | 'change'; onDone: (pin: string) => void | Promise<void> }
  // `enter` hands back the PIN typed on the keypad, or '' after a biometric unlock. `onForgot` draws
  // the way out, for the boot lock alone: past it the app is open, and every other gate has a way back.
  | { mode: 'enter'; biometrics?: boolean; onDone: (pin: string) => void | Promise<void>; onForgot?: () => void }

function PinKey({
  label,
  icon,
  accessibilityLabel,
  inert,
  reduced,
  onPress,
}: {
  label: string
  // Drawn in place of a label, for the key that has no digit.
  icon?: React.ReactNode
  // For a key whose glyph a screen reader would read as a symbol rather than as what it does.
  accessibilityLabel?: string
  inert: boolean
  // With reduced motion the key does not shrink under the finger; its pressed surface stays.
  reduced: boolean
  onPress: () => void
}): React.JSX.Element {
  const scale = useRef(new Animated.Value(1)).current
  const face =
    icon ??
    (label !== '' && (
      <Text maxFontSizeMultiplier={textScale.keypadMax} style={[leadingText(), styles.keyLabel]}>
        {label}
      </Text>
    ))
  return (
    <Pressable
      onPress={onPress}
      onPressIn={() => {
        if (!reduced) {
          Animated.spring(scale, {
            toValue: 0.9,
            speed: 50,
            bounciness: 0,
            useNativeDriver: true,
          }).start()
        }
      }}
      onPressOut={() => {
        if (!reduced) {
          Animated.spring(scale, {
            toValue: 1,
            speed: 20,
            bounciness: 8,
            useNativeDriver: true,
          }).start()
        }
      }}
      disabled={inert}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      // An inert slot only holds the grid in shape, so a screen reader skips it rather than announce
      // a button with no name.
      accessible={!inert}
      importantForAccessibility={inert ? 'no-hide-descendants' : 'auto'}
      accessibilityElementsHidden={inert}
      style={styles.keyHit}>
      {({ pressed }) => (
        <Animated.View style={[styles.keyWrap, !reduced && { transform: [{ scale }] }]}>
          <View
            style={[
              styles.key,
              inert ? styles.keyEmpty : styles.keyFill,
              pressed && !inert && styles.keyPressed,
            ]}>
            {face}
          </View>
        </Animated.View>
      )}
    </Pressable>
  )
}

// Format and storage logic lives in wallet/pin.ts.
export function PinScreen(props: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  // Orange outside DollarModeProvider, which is where the boot lock and onboarding draw this screen.
  const { accent } = useAccent()
  const [entered, setEntered] = useState('')
  const [firstPin, setFirstPin] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  useAnnounced(error)
  // The PIN whose write failed, held only until Try again.
  const [unsaved, setUnsaved] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const shake = useRef(new Animated.Value(0)).current
  // With reduced motion a wrong PIN does not shake; the dots clear and the error text says it.
  const reduced = useReduceMotion()
  // Read after the system's prompt, which outlives the render that opened it.
  const reducedNow = useRef(reduced)
  reducedNow.current = reduced
  // How many dots a biometric success has filled, and the fill's next step, which also stops the keypad.
  const [unlocked, setUnlocked] = useState(0)
  const fillTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const filling = useRef(false)
  useEffect(
    () => () => {
      if (fillTimer.current !== null) {
        clearTimeout(fillTimer.current)
      }
    },
    [],
  )

  // While too many wrong PINs wait out their time: when the keypad takes a PIN again, on the steady
  // clock pinWaitLeft uses, and the moment last drawn, which moves once a second.
  const [waitUntil, setWaitUntil] = useState<number | null>(null)
  // The same moment for the keys, set with the answer that starts the wait rather than at the render
  // after it, so no press between the two gets past it.
  const waitEnds = useRef<number | null>(null)
  // While a typed PIN is being checked.
  const checking = useRef(false)
  const [, setTick] = useState(0)

  function startWait(ms: number) {
    setEntered('')
    waitEnds.current = performance.now() + ms
    setWaitUntil(waitEnds.current)
    // Said once, with the whole wait; the clock drawn below counts it down without speaking.
    setError(t('pin.wait', { time: formatClock(ms, i18n.language) }))
  }

  useEffect(() => {
    if (props.mode !== 'enter') {
      return
    }
    let active = true
    pinWaitLeft()
      .then(left => {
        if (active && left > 0) {
          startWait(left)
        }
      })
      .catch((err: unknown) => console.warn(`pin wait not read: ${(err as Error)?.message ?? String(err)}`))
    return () => {
      active = false
    }
    // The mode never changes on a mounted keypad.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (waitUntil === null) {
      return
    }
    const timer = setInterval(() => {
      if (performance.now() >= waitUntil) {
        waitEnds.current = null
        setWaitUntil(null)
        setError(null)
      } else {
        setTick(n => n + 1)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [waitUntil])

  // The enable-biometrics flow passes biometrics={false} so the keypad can capture the typed PIN.
  const biometricsAllowed = props.mode === 'enter' && props.biometrics !== false
  const [biometryKind, setBiometryKind] = useState<BiometryKind>(null)

  const confirming = props.mode === 'set' && firstPin !== null
  const setTitle = props.mode === 'set' && props.setup === 'change' ? t('pin.new') : t('pin.create')
  const title = props.mode === 'enter' ? t('pin.enter') : confirming ? t('pin.confirm') : setTitle

  function reject(message: string) {
    setEntered('')
    setError(message)
    shake.setValue(0)
    if (reduced) {
      return
    }
    Animated.sequence(
      [12, -12, 8, -8, 0].map(toValue =>
        Animated.timing(shake, {
          toValue, // One beat of a five-step shake. The value is part of a shape, not a transition of its own.
          duration: 55,
          useNativeDriver: true,
        }),
      ),
    ).start()
  }

  async function save(pin: string) {
    if (props.mode !== 'set') {
      return
    }
    setUnsaved(null)
    setSaving(true)
    try {
      await props.onDone(pin)
    } catch (err) {
      console.warn(`pin not saved: ${(err as Error)?.message ?? String(err)}`)
      setUnsaved(pin)
    } finally {
      setSaving(false)
    }
  }

  async function complete(pin: string) {
    if (props.mode === 'set') {
      if (firstPin === null) {
        setFirstPin(pin)
        setEntered('')
        return
      }
      if (pin === firstPin) {
        await save(pin)
      } else {
        setFirstPin(null)
        reject(t('pin.mismatch'))
      }
      return
    }

    checking.current = true
    const entry: PinEntry | null = await enterPin(pin).catch((err: unknown) => {
      console.warn(`pin not checked: ${(err as Error)?.message ?? String(err)}`)
      return null
    })
    if (entry === null) {
      // Not a wrong PIN, so no shake: the dots clear and the keypad takes the next try.
      setEntered('')
      setError(t('pin.checkFailed'))
    } else if (!entry.ok) {
      // A PIN refused because a wait runs was never compared, so it is not called wrong.
      if (!entry.waiting) {
        reject(t('pin.wrong'))
      }
      if (entry.waitMs > 0) {
        startWait(entry.waitMs)
      }
    }
    // Dropped once the wait the answer started is set, so no digit lands between the two.
    checking.current = false
    if (entry?.ok) {
      props.onDone(pin)
    }
  }

  async function tryBiometric() {
    if (props.mode !== 'enter') {
      return
    }
    if (filling.current) {
      return
    }
    if (!(await unlockWithBiometrics(t('pin.biometricPrompt'), t('common.cancel')))) {
      return
    }
    // The owner's biometric ends any run of wrong PINs.
    clearPinFailures().catch((err: unknown) =>
      console.warn(`pin failures not cleared: ${(err as Error)?.message ?? String(err)}`),
    )
    const done = props.onDone
    // A rejected onDone leaves the screen up with the app closed, so the keypad and this key answer again.
    const open = async (): Promise<void> => {
      try {
        await done('')
      } catch (err) {
        console.warn(`biometric unlock not finished: ${(err as Error)?.message ?? String(err)}`)
        filling.current = false
        setUnlocked(0)
      }
    }
    filling.current = true
    if (reducedNow.current) {
      open()
      return
    }
    // The dots stand for the PIN the biometric stood in for, so the app opens on all six.
    const fill = (count: number): void => {
      setUnlocked(count)
      fillTimer.current = setTimeout(() => (count < PIN_LENGTH ? fill(count + 1) : open()), FILL_STEP_MS)
    }
    fill(entered.length + 1)
  }

  // Prompts once so unlocking needs no tap, falling back to the keypad if it is cancelled.
  useEffect(() => {
    if (!biometricsAllowed) {
      return
    }
    let active = true
    ;(async () => {
      if (!(await isBiometricUnlockEnabled())) {
        return
      }
      const kind = await getBiometryKind()
      if (!active || !kind) {
        return
      }
      setBiometryKind(kind)
      tryBiometric()
    })()
    return () => {
      active = false
    }
    // Runs once on mount; tryBiometric/t are stable enough for a one-shot prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function press(key: string) {
    // A wait takes no digit, so nothing typed during it is checked when it ends, and neither does a
    // check still running, whose answer may start one.
    if (filling.current || waitEnds.current !== null || checking.current) {
      return
    }
    if (key === 'del') {
      setEntered(value => value.slice(0, -1))
      return
    }
    if (key === '' || entered.length >= PIN_LENGTH) {
      return
    }
    setError(null)
    const next = entered + key
    setEntered(next)
    if (next.length === PIN_LENGTH) {
      complete(next)
    }
  }

  const filled = Math.max(entered.length, unlocked)

  return (
    <View style={styles.container}>
      <Txt role="heading" style={styles.title}>
        {title}
      </Txt>

      <Animated.View
        accessible
        accessibilityLabel={title}
        accessibilityValue={{ text: t('pin.dotsValue', { count: entered.length, total: PIN_LENGTH }) }}
        style={[styles.dots, !reduced && { transform: [{ translateX: shake }] }]}>
        {Array.from({ length: PIN_LENGTH }).map((_, i) => (
          <View key={i} style={[styles.dot, i < filled && { backgroundColor: accent }]} />
        ))}
      </Animated.View>

      <View style={styles.errorSlot}>
        {error && (
          <Txt role="caption" tone="danger" accessibilityRole="alert" style={styles.error}>
            {waitUntil !== null
              ? t('pin.wait', { time: formatClock(Math.max(0, waitUntil - performance.now()), i18n.language) })
              : error}
          </Txt>
        )}
      </View>

      {unsaved !== null && (
        <View style={styles.unsaved}>
          <ErrorBox message={t('pin.saveFailed')} />
          <GradientButton label={t('common.retry')} onPress={() => save(unsaved)} loading={saving} />
        </View>
      )}

      <View style={styles.keypad}>
        {KEYS.map((key, i) => {
          // The hidden backspace keeps its grid slot so the keypad never shifts.
          const hiddenDel = key === 'del' && entered.length === 0
          const inert = key === '' || hiddenDel
          return (
            <PinKey
              key={i}
              label={inert || key === 'del' ? '' : key}
              icon={key === 'del' && !inert ? <TabIcon name="backspace" color={colors.text} /> : undefined}
              accessibilityLabel={key === 'del' && !inert ? t('common.backspace') : undefined}
              inert={inert}
              reduced={reduced}
              onPress={() => press(key)}
            />
          )
        })}
      </View>

      {/* Both held whether they show or not, so no gate draws its keypad somewhere else. */}
      <View style={styles.biometric}>
        {biometryKind && (
          <Touch
            onPress={tryBiometric}
            feedback="surface"
            hitSlop={space.sm}
            label={t('pin.biometricPrompt')}>
            <TabIcon name={biometryKind === 'face' ? 'faceid' : 'fingerprint'} color={accent} size={BIOMETRIC_ICON} />
          </Touch>
        )}
      </View>

      <View style={styles.forgot}>
        {props.mode === 'enter' && props.onForgot && (
          <Touch onPress={props.onForgot} feedback="link">
            <Txt role="label" tone="muted">
              {t('pin.forgot')}
            </Txt>
          </Touch>
        )}
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
  },
  title: {
    marginBottom: space.xl,
  },
  dots: {
    flexDirection: 'row',
    gap: space.md,
    marginBottom: space.lg,
  },
  // Empty and filled are told apart by the fill alone.
  dot: {
    width: DOT,
    height: DOT,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceVariant,
  },
  errorSlot: {
    alignSelf: 'stretch',
    minHeight: ERROR_SLOT,
    marginBottom: space.md,
  },
  error: {
    textAlign: 'center',
  },
  unsaved: {
    alignSelf: 'stretch',
    gap: space.md,
  },
  // A phone keypad reads 1 2 3 from the left in every language, so the grid never mirrors in RTL.
  keypad: {
    direction: 'ltr',
    flexDirection: 'row',
    flexWrap: 'wrap',
    width: KEYPAD_WIDTH,
    justifyContent: 'center',
    gap: space.md,
    marginTop: space.lg,
  },
  keyHit: {
    width: KEY,
    height: KEY,
  },
  keyWrap: {
    width: KEY,
    height: KEY,
  },
  key: {
    width: KEY,
    height: KEY,
    borderRadius: radius.full,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // A solid fill on both platforms. The native glass carries a light rim of its own on iOS 26, and
  // the keys are the one place it would stand in a grid of twelve on every open.
  keyFill: {
    backgroundColor: colors.surface,
  },
  keyEmpty: {
    backgroundColor: 'transparent',
  },
  keyPressed: {
    backgroundColor: colors.pressedOverlay,
  },
  keyLabel: {
    fontSize: font.size.xxl,
    color: colors.text,
    ...font.family.medium,
  },
  biometric: {
    marginTop: space.xl,
    height: BIOMETRIC_ROW,
    alignItems: 'center',
    justifyContent: 'center',
  },
  forgot: {
    marginTop: space.md,
    minHeight: touch.min,
  },
})
