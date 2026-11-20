import React, { useEffect } from 'react'
import { StyleSheet, View, useWindowDimensions, type AccessibilityActionEvent } from 'react-native'
import { useSideBySide } from '../hooks/useSideBySide'
import { useTranslation } from 'react-i18next'
import { Gesture, GestureDetector } from 'react-native-gesture-handler'
import Animated, {
  ReduceMotion,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated'
import { AssetIcon } from './AssetIcon'
import { NAME_LINES, assetRowHeight } from './assetRowHeight'
import { TabIcon } from './TabIcon'
import { formatRowAmount, type AssetRow } from '../wallet/assets'
import { alpha, colors, font, layer, motion, radius, space, stroke } from '../theme'
import { motionFor, useReduceMotion } from '../hooks/useReduceMotion'
import { Touch } from './Touch'
import { Figure } from './Amount'
import { Txt } from './Txt'
import { CrossFade } from './CrossFade'
import { FigureRow } from './FigureRow'

// Minus button plus gap, the amount the content shifts right while editing.
const REMOVE_SLOT = 34
// Settles quicker and shorter than the reanimated default. Its animations opt out of Reanimated's own
// reduce-motion rule, which reads the setting once at launch; useReduceMotion decides what moves.
const SPRING = { mass: 0.7, damping: 20, stiffness: 300, reduceMotion: ReduceMotion.Never }

type Positions = Record<string, number>

// One tree serves both modes, so entering edit cross-fades the row's parts instead of remounting.
type Props = {
  assets: AssetRow[]
  editing: boolean
  hidden: boolean
  // A figure that changes now crosses over to the new value. See CrossFade.
  fading?: boolean
  onEnterEdit: () => void
  onReorder: (ids: string[]) => void
  onRemove: (assetId: string) => void
  onOpen: (asset: AssetRow) => void
}

export function AssetList({
  assets,
  editing,
  hidden,
  fading = false,
  onEnterEdit,
  onReorder,
  onRemove,
  onOpen,
}: Props): React.JSX.Element {
  const sideBySide = useSideBySide()
  const { fontScale } = useWindowDimensions()
  const rowHeight = assetRowHeight(sideBySide, fontScale)
  // With reduced motion a lifted row does not grow, the rows it passes jump to their slots, and the
  // edit controls appear at once, since the remove slot opens by its width.
  const reduced = useReduceMotion()
  const positions = useSharedValue<Positions>(
    Object.fromEntries(assets.map((asset, index) => [asset.assetId, index])),
  )
  const activeId = useSharedValue<string | null>(null)
  const progress = useSharedValue(0) // 0 = idle, 1 = editing

  useEffect(() => {
    positions.value = Object.fromEntries(assets.map((asset, index) => [asset.assetId, index]))
  }, [assets, positions])

  useEffect(() => {
    progress.value = withTiming(editing ? 1 : 0, {
      duration: motionFor(motion.fast, reduced),
      reduceMotion: ReduceMotion.Never,
    })
  }, [editing, progress, reduced])

  // A screen reader's move, one place at a time, through the same write a drag ends in.
  function move(index: number, by: -1 | 1) {
    const ids = assets.map(asset => asset.assetId)
    const to = index + by
    if (to < 0 || to >= ids.length) {
      return
    }
    ;[ids[index], ids[to]] = [ids[to]!, ids[index]!]
    onReorder(ids)
  }

  return (
    <View style={{ height: assets.length * rowHeight }}>
      {assets.map((asset, index) => (
        <RowItem
          key={asset.assetId}
          asset={asset}
          index={index}
          count={assets.length}
          rowHeight={rowHeight}
          sideBySide={sideBySide}
          editing={editing}
          hidden={hidden}
          fading={fading}
          positions={positions}
          activeId={activeId}
          progress={progress}
          reduced={reduced}
          onEnterEdit={onEnterEdit}
          onReorder={onReorder}
          onRemove={onRemove}
          onOpen={onOpen}
          onMove={by => move(index, by)}
        />
      ))}
    </View>
  )
}

type RowProps = {
  asset: AssetRow
  index: number
  count: number
  rowHeight: number
  sideBySide: boolean
  editing: boolean
  hidden: boolean
  fading: boolean
  positions: SharedValue<Positions>
  activeId: SharedValue<string | null>
  progress: SharedValue<number>
  reduced: boolean
  onEnterEdit: () => void
  onReorder: (ids: string[]) => void
  onRemove: (assetId: string) => void
  onOpen: (asset: AssetRow) => void
  onMove: (by: -1 | 1) => void
}

function RowItem({
  asset,
  index,
  count,
  rowHeight,
  sideBySide,
  editing,
  hidden,
  fading,
  positions,
  activeId,
  progress,
  reduced,
  onEnterEdit,
  onReorder,
  onRemove,
  onOpen,
  onMove,
}: RowProps): React.JSX.Element {
  const { t } = useTranslation()
  const id = asset.assetId
  const dragY = useSharedValue(0)
  const startIndex = useSharedValue(0)

  const pan = Gesture.Pan()
    .enabled(editing)
    .onStart(() => {
      activeId.value = id
      startIndex.value = positions.value[id]
      dragY.value = startIndex.value * rowHeight
    })
    .onUpdate(event => {
      dragY.value = startIndex.value * rowHeight + event.translationY
      const target = Math.min(Math.max(Math.round(dragY.value / rowHeight), 0), count - 1)
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
      dragY.value = withSpring(positions.value[id] * rowHeight, SPRING)
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

  const longPress = Gesture.LongPress()
    .enabled(!editing)
    .minDuration(350)
    .onStart(() => runOnJS(onEnterEdit)())

  // `onStart` rather than `onEnd(event, success)`, because inside an Exclusive composition the tap
  // ends without activating while it waits on the long press to fail, leaving `success` false.
  const tap = Gesture.Tap()
    .enabled(!editing)
    .onStart(() => runOnJS(onOpen)(asset))

  const gesture = editing ? pan : Gesture.Exclusive(longPress, tap)

  const slotStyle = useAnimatedStyle(() => {
    const idx = positions.value[id]
    const isActive = activeId.value === id
    const someone = activeId.value !== null
    return {
      // Static when idle, so rows do not jitter on mount, and springs only during a drag.
      top: isActive
        ? dragY.value
        : someone && !reduced
        ? withSpring(idx * rowHeight, SPRING)
        : idx * rowHeight,
      zIndex: isActive ? layer.lifted : 0,
      opacity: someone && !isActive ? alpha.receded : 1,
    }
  })

  // A line of its own rather than the row's edge, since whichever row is on top after a drag has none.
  const dividerStyle = useAnimatedStyle(() => ({ opacity: positions.value[id] > 0 ? 1 : 0 }))

  const removeSlotStyle = useAnimatedStyle(() => ({
    width: progress.value * REMOVE_SLOT,
    opacity: progress.value,
  }))

  // The same key either way, since a key the style stops setting keeps its last value on the view.
  const contentStyle = useAnimatedStyle(() => ({
    transform: [{ scale: reduced ? 1 : withSpring(activeId.value === id ? 1.04 : 1, SPRING) }],
  }))

  const amountStyle = useAnimatedStyle(() => ({ opacity: 1 - progress.value }))
  const handleStyle = useAnimatedStyle(() => ({ opacity: progress.value }))

  // Fades out while the list is edited, so the figure sits in an animated box rather than being one.
  const amount = hidden ? '••••' : `${formatRowAmount(asset)} ${asset.ticker}`
  // What a screen reader offers on a row outside edit mode, since it reaches neither gesture: activate,
  // which a tap does, the moves a drag makes, never past either end, and edit, which the long press
  // opens.
  const actions = [
    { name: 'activate' },
    ...(index > 0 ? [{ name: 'moveUp', label: t('wallets.moveUp') }] : []),
    ...(index < count - 1 ? [{ name: 'moveDown', label: t('wallets.moveDown') }] : []),
    { name: 'edit', label: t('wallets.edit') },
  ]
  function onAction(event: AccessibilityActionEvent) {
    switch (event.nativeEvent.actionName) {
      case 'activate':
        onOpen(asset)
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

  const figure = (
    <Animated.View style={[styles.amount, amountStyle]}>
      <CrossFade value={amount} armed={fading} tapped={String(hidden)} style={styles.amount}>
        <Figure role="bodyBold" tabular>
          {amount}
        </Figure>
      </CrossFade>
    </Animated.View>
  )

  return (
    <Animated.View style={[styles.slot, { height: rowHeight }, slotStyle]}>
      <Animated.View style={[styles.divider, dividerStyle]} />
      <Animated.View style={[styles.removeSlot, removeSlotStyle]}>
        <Touch
          onPress={() => asset.removable && onRemove(id)}
          disabled={!asset.removable}
          feedback="link"
          size={22}
          hitSlop={space.md}
          label={t('common.remove')}
          style={styles.remove}>
          <TabIcon name="minus" color={colors.onPrimary} size={16} strokeWidth={3} />
        </Touch>
      </Animated.View>

      <GestureDetector gesture={gesture}>
        {/* Grouping makes assistive tech hear one button, and announce the dots when hidden. */}
        <Animated.View
          style={[styles.dragArea, contentStyle]}
          accessible={!editing}
          accessibilityRole={editing ? undefined : 'button'}
          accessibilityHint={editing ? undefined : t('home.assetHint')}
          accessibilityActions={editing ? undefined : actions}
          onAccessibilityAction={editing ? undefined : onAction}>
          <AssetIcon assetId={id} ticker={asset.ticker} />
          {/* The rule every label and figure share. Side by side the name gives way before the
              amount does, since a clipped balance misreads money; too narrow for both at this text
              size, the figure moves under the name and each keeps a readable line of its own. */}
          <FigureRow
            cap="65%"
            label={
              <Txt
                role="bodyStrong"
                lines={sideBySide ? 1 : NAME_LINES}
                style={[styles.name, !sideBySide && styles.stackedName]}>
                {asset.name}
              </Txt>
            }>
            {figure}
          </FigureRow>
          <Animated.View style={[styles.handle, handleStyle]} pointerEvents="none">
            <TabIcon name="menu" color={colors.textSecondary} size={20} strokeWidth={2} />
          </Animated.View>
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
    flexDirection: 'row',
    alignItems: 'center',
  },
  // A hairline, as between the rows of every other list in the app.
  divider: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    height: stroke.hair,
    backgroundColor: colors.divider,
  },
  // Never wider than the mark it holds; the width itself is animated.
  removeSlot: {
    maxWidth: REMOVE_SLOT,
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
  // An asset holding funds cannot be hidden, so its minus stays visible but disabled.
  dragArea: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
  },
  name: {
    flexShrink: 1,
  },
  // Bounded by its side of the row, which FigureRow caps; past that the figure shrinks its type.
  amount: {
    maxWidth: '100%',
  },
  stackedName: {
    lineHeight: font.leading.base,
  },
  handle: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    justifyContent: 'center',
  },
})
