import React, { useEffect } from 'react'
import { AccessibilityInfo, StyleSheet, View, type AccessibilityActionEvent } from 'react-native'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { WalletAvatar } from './WalletAvatar'
import { TabIcon } from './TabIcon'
import { formatFingerprint } from '../wallet/walletIdentity'
import { alpha, colors, layer, motion, radius, space } from '../theme'
import { useAccent } from '../wallet/dollarMode'
import { useTranslation } from 'react-i18next'
import { Touch } from './Touch'
import { Txt } from './Txt'
import { motionFor, useReduceMotion } from '../hooks/useReduceMotion'
import type { PhotoCrop } from '../wallet/photoCrop'

export type WalletRow = {
  id: string
  fingerprint: string
  name: string
  imagePath: string | null
  imageCrop: PhotoCrop | null
  color: string
  monogram: string
  active: boolean
}

// Exported for WalletRowsSkeleton, which holds the same room while the rows load.
export const CARD_HEIGHT = 68
// The active check and the drag handle share one slot at the right, drawn at this size.
const RIGHT_ICON = 20
const ROW_HEIGHT = CARD_HEIGHT + space.sm
// Minus button plus gap, the amount cards shift right while editing.
const REMOVE_SLOT = 34
const SPRING = { mass: 0.7, damping: 20, stiffness: 300 }

type Positions = Record<string, number>

// One tree serves both modes, as in the Home asset list, so cards cross-fade rather than remount.
type Props = {
  rows: WalletRow[]
  editing: boolean
  onEnterEdit: () => void
  onPressRow: (row: WalletRow) => void
  onReorder: (ids: string[]) => void
  onRemove: (row: WalletRow) => void
}

export function WalletList({
  rows,
  editing,
  onEnterEdit,
  onPressRow,
  onReorder,
  onRemove,
}: Props): React.JSX.Element {
  const positions = useSharedValue<Positions>(
    Object.fromEntries(rows.map((row, index) => [row.id, index])),
  )
  const activeId = useSharedValue<string | null>(null)
  const progress = useSharedValue(0) // 0 = idle, 1 = editing
  const reduced = useReduceMotion()
  const { t } = useTranslation()

  useEffect(() => {
    positions.value = Object.fromEntries(rows.map((row, index) => [row.id, index]))
  }, [rows, positions])

  // The edit controls slide the cards over by their width, so under reduced motion they jump.
  useEffect(() => {
    progress.value = withTiming(editing ? 1 : 0, { duration: motionFor(motion.fast, reduced) })
  }, [editing, progress, reduced])

  // The drag's order change for a screen reader, which cannot drag: one place up or down through the
  // same onReorder, then the new place said aloud, since nothing else on screen says it.
  function move(index: number, by: -1 | 1) {
    const to = index + by
    if (to < 0 || to >= rows.length) {
      return
    }
    const ids = rows.map(r => r.id)
    ;[ids[index], ids[to]] = [ids[to], ids[index]]
    onReorder(ids)
    // `total`, not `count`, which makes i18next look for plural forms this key does not have.
    AccessibilityInfo.announceForAccessibility(t('wallets.moved', { position: to + 1, total: rows.length }))
  }

  return (
    <View style={{ height: rows.length * ROW_HEIGHT }}>
      {rows.map((row, index) => (
        <RowItem
          key={row.id}
          row={row}
          index={index}
          count={rows.length}
          editing={editing}
          canRemove={rows.length > 1}
          positions={positions}
          activeId={activeId}
          progress={progress}
          onEnterEdit={onEnterEdit}
          onPressRow={onPressRow}
          onReorder={onReorder}
          onRemove={onRemove}
          onMove={by => move(index, by)}
          reduced={reduced}
        />
      ))}
    </View>
  )
}

type RowProps = {
  row: WalletRow
  index: number
  count: number
  editing: boolean
  canRemove: boolean
  positions: SharedValue<Positions>
  activeId: SharedValue<string | null>
  progress: SharedValue<number>
  onEnterEdit: () => void
  onPressRow: (row: WalletRow) => void
  onReorder: (ids: string[]) => void
  onRemove: (row: WalletRow) => void
  onMove: (by: -1 | 1) => void
  reduced: boolean
}

function RowItem({
  row,
  index,
  count,
  editing,
  canRemove,
  positions,
  activeId,
  progress,
  onEnterEdit,
  onPressRow,
  onReorder,
  onRemove,
  onMove,
  reduced,
}: RowProps): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const id = row.id
  const dragY = useSharedValue(0)
  const startIndex = useSharedValue(0)

  const pan = Gesture.Pan()
    .enabled(editing)
    .onStart(() => {
      activeId.value = id
      startIndex.value = positions.value[id]
      dragY.value = startIndex.value * ROW_HEIGHT
    })
    .onUpdate(event => {
      dragY.value = startIndex.value * ROW_HEIGHT + event.translationY
      const target = Math.min(Math.max(Math.round(dragY.value / ROW_HEIGHT), 0), count - 1)
      const current = positions.value[id]
      if (target !== current) {
        const next: Positions = {}
        for (const key in positions.value) {
          next[key] = positions.value[key] === target ? current : positions.value[key]
        }
        next[id] = target
        positions.value = next
      }
    })
    .onEnd(() => {
      dragY.value = withSpring(positions.value[id] * ROW_HEIGHT, SPRING)
      activeId.value = null
      const order: string[] = []
      for (let i = 0; i < count; i++) {
        for (const key in positions.value) {
          if (positions.value[key] === i) {
            order.push(key)
          }
        }
      }
      runOnJS(onReorder)(order)
    })

  // A single wallet has nothing to reorder or remove.
  const longPress = Gesture.LongPress()
    .enabled(!editing && count > 1)
    .minDuration(350)
    .onStart(() => runOnJS(onEnterEdit)())

  const tap = Gesture.Tap()
    .enabled(!editing)
    .onStart(() => runOnJS(onPressRow)(row))

  const gesture = editing ? pan : Gesture.Exclusive(longPress, tap)

  const slotStyle = useAnimatedStyle(() => {
    const idx = positions.value[id]
    const isActive = activeId.value === id
    const someone = activeId.value !== null
    return {
      // The rows a drag passes spring to their slots, or jump there under reduced motion.
      top: isActive
        ? dragY.value
        : someone && !reduced
        ? withSpring(idx * ROW_HEIGHT, SPRING)
        : idx * ROW_HEIGHT,
      zIndex: isActive ? layer.lifted : 0,
      opacity: someone && !isActive ? alpha.receded : 1,
    }
  })

  const removeSlotStyle = useAnimatedStyle(() => ({
    width: progress.value * REMOVE_SLOT,
    opacity: progress.value,
  }))

  // The lift grows the card under the finger; under reduced motion it keeps its size.
  const contentStyle = useAnimatedStyle(() =>
    reduced ? {} : { transform: [{ scale: withSpring(activeId.value === id ? 1.04 : 1, SPRING) }] },
  )

  // What a screen reader offers on a card outside edit mode: activate, which a tap does, the moves a
  // drag makes, never past either end, and edit, which the long press opens. None removes a wallet,
  // which stays behind the remove button and its confirmation. A single wallet has only activate.
  const actions = [
    { name: 'activate' },
    ...(index > 0 ? [{ name: 'moveUp', label: t('wallets.moveUp') }] : []),
    ...(index < count - 1 ? [{ name: 'moveDown', label: t('wallets.moveDown') }] : []),
    ...(count > 1 ? [{ name: 'edit', label: t('wallets.edit') }] : []),
  ]
  function onAction(event: AccessibilityActionEvent) {
    switch (event.nativeEvent.actionName) {
      case 'activate':
        onPressRow(row)
        break
      case 'moveUp':
        onMove(-1)
        break
      case 'moveDown':
        onMove(1)
        break
      case 'edit':
        onEnterEdit()
        break
    }
  }

  const checkStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }))
  const handleStyle = useAnimatedStyle(() => ({ opacity: progress.value }))

  return (
    <Animated.View style={[styles.slot, slotStyle]}>
      <Animated.View style={[styles.removeSlot, removeSlotStyle]}>
        <Touch
          onPress={() => canRemove && onRemove(row)}
          disabled={!canRemove}
          feedback="link"
          size={22}
          hitSlop={space.md}
          label={t('common.remove')}
          style={styles.remove}>
          <TabIcon name="minus" color={colors.onPrimary} size={16} strokeWidth={3} />
        </Touch>
      </Animated.View>

      <GestureDetector gesture={gesture}>
        {/* One button per wallet for assistive tech, named by what the card shows, with the active
            wallet marked as selected, since on screen only an accent check says so. The tap is a
            gesture, which a screen reader cannot reach, so its activation calls the same handler. */}
        <Animated.View
          style={[styles.card, contentStyle]}
          accessible={!editing}
          accessibilityRole={editing ? undefined : 'button'}
          accessibilityLabel={`${row.name}, ${formatFingerprint(row.fingerprint)}`}
          accessibilityState={editing ? undefined : { selected: row.active }}
          accessibilityActions={editing ? undefined : actions}
          onAccessibilityAction={editing ? undefined : onAction}>
          <WalletAvatar
            color={row.color}
            imagePath={row.imagePath}
            crop={row.imageCrop}
            monogram={row.monogram}
            size={44}
          />
          <View style={styles.info}>
            {/* One line each, since the card is a fixed 68pt and a long name would push the
                fingerprint out of it. The full name is in the card's accessibility label. */}
            <Txt role="bodyStrong" lines={1}>
              {row.name}
            </Txt>
            <Txt role="caption" tone="muted" lines={1}>
              {formatFingerprint(row.fingerprint)}
            </Txt>
          </View>
          <View style={styles.rightSlot}>
            {row.active && (
              <Animated.View style={[styles.rightIcon, checkStyle]}>
                <TabIcon name="check" color={accent} size={RIGHT_ICON} />
              </Animated.View>
            )}
            <Animated.View style={[styles.rightIcon, handleStyle]} pointerEvents="none">
              <TabIcon name="menu" color={colors.textSecondary} size={RIGHT_ICON} strokeWidth={2} />
            </Animated.View>
          </View>
        </Animated.View>
      </GestureDetector>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  slot: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
  },
  removeSlot: {
    height: '100%',
    justifyContent: 'center',
    overflow: 'hidden',
  },
  remove: {
    width: 22,
    height: 22,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    backgroundColor: colors.danger,
    alignItems: 'center',
    justifyContent: 'center',
  },
  card: {
    flex: 1,
    height: CARD_HEIGHT,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingHorizontal: space.lg,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  info: {
    flex: 1,
    gap: space.xs,
  },
  rightSlot: {
    width: RIGHT_ICON + space.xs,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'center',
  },
  rightIcon: {
    position: 'absolute',
  },
})
