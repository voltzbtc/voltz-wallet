import React, { useEffect, useRef } from 'react'
import { AccessibilityInfo, Animated, StyleSheet, View } from 'react-native'
import { useTranslation } from 'react-i18next'
import { useReduceMotion } from '../hooks/useReduceMotion'
import type { NfcSheetPhase } from '../hooks/useNfcRead'
import { colors, motion, space, touch } from '../theme'
import { animateTo } from './animateTo'
import { GradientButton } from './GradientButton'
import { Ring as RingShape } from './Ring'
import { Sheet } from './Sheet'
import { TabIcon } from './TabIcon'
import { Txt } from './Txt'

const ICON = space.xxl
const RING = touch.min * 2
const RING_WIDTH = 1
const RINGS = 2
// One ring's way out, and the head start the next one takes, so they read as a pulse.
const PULSE_MS = motion.slow * 4
const REST_SCALE = 0.45

function Ring({ delay, moving }: { delay: number; moving: boolean }): React.JSX.Element {
  const progress = useRef(new Animated.Value(moving ? 0 : 1)).current

  useEffect(() => {
    if (!moving) {
      progress.setValue(1)
      return
    }
    progress.setValue(0)
    // Every ring's turn takes the same time, or the head start would grow on each pass and the rings
    // drift into one.
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.delay(delay),
        animateTo(progress, 1, PULSE_MS),
        Animated.delay(PULSE_MS - delay),
      ]),
    )
    pulse.start()
    return () => pulse.stop()
  }, [delay, moving, progress])

  // At rest a ring is drawn faintly at its full size, so reduced motion keeps the sign and drops the
  // movement.
  const style = moving
    ? {
        opacity: progress.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
        transform: [
          { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [REST_SCALE, 1] }) },
        ],
      }
    : undefined
  return (
    <Animated.View testID="nfc-ring" style={[styles.ring, style]}>
      <RingShape size={RING} width={RING_WIDTH} color={moving ? colors.textSecondary : colors.surfaceRaised} />
    </Animated.View>
  )
}

// Android's read has no interface of its own, so this says the phone is waiting for a tag and how to
// stop it. The rings stand for that wait, which is why they stop with it.
export function NfcReadSheet({
  phase,
  onCancel,
}: {
  phase: NfcSheetPhase
  onCancel: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  const reduced = useReduceMotion()
  const moving = phase === 'waiting' && !reduced
  // What the sheet says stays through its way out, which `closed` would otherwise rewrite.
  const said = useRef<Exclude<NfcSheetPhase, 'closed'>>('waiting')
  if (phase !== 'closed') {
    said.current = phase
  }
  const line = t(said.current === 'noAddress' ? 'send.nfcNoAddress' : 'send.nfcPrompt')
  // The line changes under a screen reader's focus on the button, which would keep quiet about it.
  useEffect(() => {
    if (phase !== 'closed') {
      AccessibilityInfo.announceForAccessibility(line)
    }
  }, [phase, line])
  return (
    <Sheet visible={phase !== 'closed'} onClose={onCancel} closeLabel={t('common.cancel')}>
      {/* Decorative only, since the line under it says all of this to a screen reader. */}
      <View
        style={styles.sign}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants">
        {Array.from({ length: RINGS }).map((_, index) => (
          <Ring key={index} delay={(index * PULSE_MS) / RINGS} moving={moving} />
        ))}
        <TabIcon name="nfc" color={colors.text} size={ICON} />
      </View>
      <Txt role="body" style={styles.line}>
        {line}
      </Txt>
      <GradientButton
        label={t(said.current === 'noAddress' ? 'common.close' : 'common.cancel')}
        variant="secondary"
        onPress={onCancel}
      />
    </Sheet>
  )
}

const styles = StyleSheet.create({
  sign: {
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    width: RING,
    height: RING,
  },
  ring: {
    position: 'absolute',
    width: RING,
    height: RING,
  },
  line: {
    textAlign: 'center',
  },
})
