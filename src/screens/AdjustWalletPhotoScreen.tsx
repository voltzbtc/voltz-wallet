import React, { useEffect, useRef, useState } from 'react'
import { Image, StyleSheet, View, type GestureResponderEvent } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { useSafeAreaFrame } from 'react-native-safe-area-context'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { CENTRED, coverSize, cropRect, moveView, type CropView, type Point } from '../wallet/photoCrop'
import { discardPickedImage } from '../wallet/walletImage'
import { GradientButton } from '../components/GradientButton'
import { Screen } from '../components/Screen'
import { Txt } from '../components/Txt'
import { colors, space } from '../theme'

// The largest the circle grows on a wide window, so the photo stays one glance on a tablet.
const MAX_CIRCLE = 360

type Touchpoint = { pageX: number; pageY: number }

// Where a gesture began, which every move is measured from. A finger landing or lifting starts it
// again from where the photo is, so the photo never jumps when a pinch becomes a drag.
type Gesture = { start: CropView; from: Point; spread: number; fingers: number }

// The photo just picked or taken, moved and zoomed inside the circle its avatar will be. Use hands the
// crop back to Edit wallet; leaving any other way (Cancel, back, the swipe) drops the picker's copy and
// leaves the wallet's photo as it was.
export function AdjustWalletPhotoScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const { uri, width, height } = useRoute<RouteProp<RootStackParamList, 'AdjustWalletPhoto'>>().params
  const { width: stageWidth } = useSafeAreaFrame()
  const diameter = Math.min(stageWidth - space.xl * 2, MAX_CIRCLE)
  const stageHeight = diameter + space.xl * 2
  const [view, setView] = useState<CropView>(CENTRED)
  const current = useRef(view)
  const gesture = useRef<Gesture | null>(null)
  // The circle's centre on the page, read where the first finger lands.
  const centre = useRef<Point>({ x: 0, y: 0 })
  const settled = useRef(false)

  useEffect(
    () => () => {
      if (!settled.current) {
        discardPickedImage(uri)
      }
    },
    [uri],
  )

  function cancel() {
    settled.current = true
    discardPickedImage(uri)
    navigation.goBack()
  }

  function use() {
    settled.current = true
    navigation.popTo('EditWallet', { photo: { uri, crop: cropRect(current.current, width, height) } }, { merge: true })
  }

  // In circle diameters from the circle's centre, the unit the crop math works in.
  function midpoint(touches: Touchpoint[]): Point {
    const x = touches.reduce((sum, touch) => sum + touch.pageX, 0) / touches.length
    const y = touches.reduce((sum, touch) => sum + touch.pageY, 0) / touches.length
    return { x: (x - centre.current.x) / diameter, y: (y - centre.current.y) / diameter }
  }

  function spread(touches: Touchpoint[]): number {
    if (touches.length < 2) {
      return 0
    }
    return Math.hypot(touches[0].pageX - touches[1].pageX, touches[0].pageY - touches[1].pageY) / diameter
  }

  function begin(touches: Touchpoint[]) {
    gesture.current = { start: current.current, from: midpoint(touches), spread: spread(touches), fingers: touches.length }
  }

  function touchesOf(event: GestureResponderEvent): Touchpoint[] {
    const { touches, pageX, pageY } = event.nativeEvent
    return touches?.length ? touches : [{ pageX, pageY }]
  }

  function grant(event: GestureResponderEvent) {
    // The stage alone takes touches, its photo and mask let them through, so the location is on the
    // stage, whose centre is the circle's.
    const { pageX, pageY, locationX, locationY } = event.nativeEvent
    centre.current = { x: pageX - locationX + stageWidth / 2, y: pageY - locationY + stageHeight / 2 }
    begin(touchesOf(event))
  }

  function move(event: GestureResponderEvent) {
    const touches = touchesOf(event)
    const began = gesture.current
    if (!began || touches.length !== began.fingers) {
      begin(touches)
      return
    }
    const now = spread(touches)
    const factor = began.spread > 0 && now > 0 ? now / began.spread : 1
    const next = moveView(began.start, began.from, midpoint(touches), factor, width, height)
    current.current = next
    setView(next)
  }

  function end() {
    gesture.current = null
  }

  // Drawn at its zoomed size rather than scaled, so the platform decodes it at the size it shows and
  // a zoomed photo stays sharp.
  const cover = coverSize(width, height)
  const photoWidth = cover.width * view.zoom * diameter
  const photoHeight = cover.height * view.zoom * diameter
  const radius = diameter / 2
  const cx = stageWidth / 2
  const cy = stageHeight / 2
  // The page dimmed around the circle, so what falls outside the avatar still shows where it is.
  const mask = `M0 0H${stageWidth}V${stageHeight}H0Z M${cx - radius} ${cy}a${radius} ${radius} 0 1 0 ${diameter} 0a${radius} ${radius} 0 1 0 ${-diameter} 0Z`

  return (
    <Screen
      footer={
        <View style={styles.actions}>
          <GradientButton label={t('adjustPhoto.use')} onPress={use} />
          <GradientButton label={t('editWallet.cancel')} variant="secondary" onPress={cancel} />
        </View>
      }>
      <View
        testID="adjust-stage"
        style={[styles.stage, { height: stageHeight }]}
        onStartShouldSetResponder={() => true}
        onMoveShouldSetResponder={() => true}
        onResponderTerminationRequest={() => false}
        onResponderGrant={grant}
        onResponderMove={move}
        onResponderRelease={end}
        onResponderTerminate={end}>
        <View pointerEvents="none" style={StyleSheet.absoluteFill}>
          <Image
            source={{ uri }}
            style={[
              styles.photo,
              {
                width: photoWidth,
                height: photoHeight,
                left: (stageWidth - photoWidth) / 2,
                top: (stageHeight - photoHeight) / 2,
                transform: [{ translateX: view.x * diameter }, { translateY: view.y * diameter }],
              },
            ]}
          />
          <Svg width={stageWidth} height={stageHeight}>
            <Path d={mask} fill={colors.scrim} fillRule="evenodd" />
          </Svg>
        </View>
      </View>
      <Txt role="caption" tone="muted" style={styles.hint}>
        {t('adjustPhoto.hint')}
      </Txt>
    </Screen>
  )
}

const styles = StyleSheet.create({
  stage: {
    overflow: 'hidden',
    marginTop: space.xl,
  },
  photo: {
    position: 'absolute',
  },
  hint: {
    textAlign: 'center',
    marginTop: space.lg,
    paddingHorizontal: space.xl,
  },
  // The page's gutter at the sides, and the stage's own gap above the buttons.
  actions: {
    gap: space.md,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    paddingBottom: space.xl,
  },
})
