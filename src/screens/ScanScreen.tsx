import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Linking, StyleSheet, View } from 'react-native'
import Svg, { Path } from 'react-native-svg'
import { type TextInputRef } from '../components/Text'
import { parseWalletKey } from '../wallet/domainAccess'
import { useTranslation } from 'react-i18next'
import {
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useRoute,
  type RouteProp,
} from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import Clipboard from '@react-native-clipboard/clipboard'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import {
  Camera,
  useCameraDevice,
  useCameraPermission,
  useCodeScanner,
  type CameraRuntimeError,
} from 'react-native-vision-camera'
import { sparkClassify } from '../wallet/spark'
import { MODULE_DOWNLOADING, qrImageAvailable, readQrFromGallery, type GalleryQr } from '../wallet/qrImage'
import { isTokenIdentifier } from '../wallet/tokenPrefs'
import { TabIcon } from '../components/TabIcon'
import { GradientButton } from '../components/GradientButton'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { useAccent } from '../wallet/dollarMode'
import { isLightningAddress } from '../wallet/lnaddress'
import { asOwnActivity } from '../wallet/relock'
import { colors, radius, space, touch } from '../theme'
import { Txt } from '../components/Txt'
import { Field } from '../components/Field'
import { Touch } from '../components/Touch'
import { Sheet } from '../components/Sheet'
import { ErrorBox } from '../components/ErrorBox'
import { useUnderLock } from '../components/UnderLock'

// A failure from the gallery, in the words each one needs.
type GalleryIssue = Exclude<GalleryQr['kind'], 'read' | 'cancelled'>
const GALLERY_LINE = {
  none: 'scan.galleryNone',
  several: 'scan.gallerySeveral',
  failed: 'scan.galleryFailed',
  downloading: 'scan.moduleDownloading',
} as const satisfies Record<GalleryIssue, string>

// ML Kit fails every frame while its module downloads, and VisionCamera 4.7.3 hands that to onError as
// an unknown error carrying the message as its own (CodeScannerPipeline.kt, invokeOnError).
function isModuleDownloading(error: CameraRuntimeError): boolean {
  return [error.message, error.cause?.message].some(
    text => typeof text === 'string' && text.includes(MODULE_DOWNLOADING),
  )
}

// Paste and manual entry sit outside the camera area, so a denied permission still reaches Send.
export function ScanScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const { accent } = useAccent()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const params = useRoute<RouteProp<RootStackParamList, 'Scan'>>().params
  const tokenMode = params?.mode === 'token'
  const walletMode = params?.mode === 'wallet'
  const { hasPermission, requestPermission } = useCameraPermission()
  const device = useCameraDevice('back')
  const isFocused = useIsFocused()
  const underLock = useUnderLock()
  const insets = useSafeAreaInsets()
  // A QR stays in frame across many callbacks, so only the first read may act.
  const handled = useRef(false)
  const [checking, setChecking] = useState(false)
  // Why the last code was not taken, in the words Send uses for the same text.
  const [invalid, setInvalid] = useState<'unrecognized' | 'wrongNetwork' | null>(null)
  const [manualOpen, setManualOpen] = useState(false)
  const [manualText, setManualText] = useState('')
  const manualRef = useRef<TextInputRef>(null)
  const manualLabel = tokenMode ? t('addAsset.placeholder') : t('send.destinationPlaceholder')
  // The download failure arrives on every frame, so the line is set once and not per frame.
  const [readerDownloading, setReaderDownloading] = useState(false)
  const readerDownloadingRef = useRef(false)
  const [picking, setPicking] = useState(false)
  // A ref as well, since two taps land before the state above renders.
  const pickingRef = useRef(false)
  const [galleryIssue, setGalleryIssue] = useState<GalleryIssue | null>(null)
  // The camera's area, which the cut-out in the mask around the square is drawn in.
  const [area, setArea] = useState<{ width: number; height: number } | null>(null)
  // Read when the gallery answers, which can be after the person has left this screen.
  const onScreen = useRef(true)
  onScreen.current = isFocused
  useEffect(
    () => () => {
      onScreen.current = false
    },
    [],
  )

  useFocusEffect(
    useCallback(() => {
      handled.current = false
    }, []),
  )

  // The permission dialog is an activity over the app on Android, so a trip that begins under it
  // raises no cover and is timed against ten minutes instead of two.
  useEffect(() => {
    if (!hasPermission) {
      asOwnActivity(requestPermission).catch(() => undefined)
    }
  }, [hasPermission, requestPermission])

  // A ref lets the camera callback see the latest logic without re-subscribing the scanner.
  const submit = useRef(async (_value: string) => {})
  submit.current = async (value: string) => {
    const raw = value.trim()
    if (raw.length === 0 || handled.current) {
      return
    }
    handled.current = true
    setInvalid(null)
    setGalleryIssue(null)
    if (walletMode) {
      // A shape check only. What authorises the grant is the owner's signature on the next screen,
      // and the short code shown there is what catches a substituted key.
      const key = parseWalletKey(raw)
      if (!key) {
        setInvalid('unrecognized')
        handled.current = false
        return
      }
      navigation.navigate('AuthorizeWallet', { domain: params?.domain ?? '', scanned: key })
      return
    }
    if (tokenMode) {
      // A shape check only, since Add asset resolves the id through the SDK for real validation.
      if (!isTokenIdentifier(raw)) {
        setInvalid('unrecognized')
        handled.current = false
        return
      }
      navigation.navigate('AddAsset', { scanned: raw })
      return
    }
    setChecking(true)
    // Yield to the event loop so the "checking" state paints before classification runs.
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    try {
      // sparkClassify never throws, returning 'other' for unparseable input. An address that fails to
      // parse may only be a network that is down, which Send can tell and this screen cannot.
      const kind = await sparkClassify(raw)
      if (kind === 'wrongNetwork' || (kind === 'other' && !isLightningAddress(raw))) {
        setInvalid(kind === 'wrongNetwork' ? 'wrongNetwork' : 'unrecognized')
        handled.current = false
      } else if (kind === 'lnurlWithdraw') {
        navigation.replace('Redeem', { destination: raw })
      } else {
        // Back to a Send that opened the camera, or into this screen's place when none did, so a
        // finished send lands where it started and never on a second Send.
        navigation.popTo('Send', { destination: raw, picked: Date.now() })
      }
    } finally {
      setChecking(false)
    }
  }

  const codeScanner = useCodeScanner({
    codeTypes: ['qr'],
    onCodeScanned: codes => {
      const value = codes.find(c => c.value)?.value
      if (value) {
        if (readerDownloadingRef.current) {
          readerDownloadingRef.current = false
          setReaderDownloading(false)
        }
        submit.current(value)
      }
    },
  })

  // Any other error is logged as VisionCamera logs it when no handler is given.
  function onCameraError(error: CameraRuntimeError) {
    if (!isModuleDownloading(error)) {
      console.error(error)
      return
    }
    if (!readerDownloadingRef.current) {
      readerDownloadingRef.current = true
      setReaderDownloading(true)
    }
  }

  async function pasteAndSubmit() {
    const text = (await Clipboard.getString()).trim()
    if (text.length > 0) {
      submit.current(text)
    }
  }

  // The text takes the path a scanned code takes, so an image never reaches a payment on its own say.
  async function pickFromGallery() {
    if (pickingRef.current) {
      return
    }
    pickingRef.current = true
    setPicking(true)
    setInvalid(null)
    setGalleryIssue(null)
    try {
      const result = await readQrFromGallery()
      if (!onScreen.current) {
        return
      }
      if (result.kind === 'read') {
        await submit.current(result.text)
      } else if (result.kind !== 'cancelled') {
        setGalleryIssue(result.kind)
      }
    } finally {
      pickingRef.current = false
      setPicking(false)
    }
  }

  function submitManual() {
    setManualOpen(false)
    const text = manualText
    setManualText('')
    submit.current(text)
  }

  function cameraArea(): React.JSX.Element {
    if (!hasPermission) {
      return (
        <View style={styles.center}>
          <Txt role="bodyStrong" style={styles.centered}>
            {t('scan.permission')}
          </Txt>
          {/* Settings that will not open leave the line and the link up, which say enough. */}
          <Touch
            onPress={() => Linking.openSettings().catch(() => undefined)}
            feedback="link"
            style={styles.settingsButton}>
            <Txt role="bodyBold" tone="accent">
              {t('scan.openSettings')}
            </Txt>
          </Touch>
        </View>
      )
    }
    if (device == null) {
      return (
        <View style={styles.center}>
          <Txt role="bodyStrong" style={styles.centered}>
            {t('scan.noCamera')}
          </Txt>
        </View>
      )
    }
    return (
      <>
        <Camera
          style={StyleSheet.absoluteFill}
          device={device}
          // Off under the picker, so nothing the camera sees can answer before the chosen image does,
          // and off under the lock, so the camera neither runs nor reads a code behind the PIN.
          isActive={isFocused && !manualOpen && !picking && !underLock}
          codeScanner={codeScanner}
          onError={onCameraError}
        />
        <View
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
          onLayout={({ nativeEvent }) => setArea(nativeEvent.layout)}>
          <CameraMask area={area} />
          <View style={styles.finder}>
            <Viewfinder color={accent} />
          </View>
          {/* On the mask, under the square, where the camera shows only darkened behind the words. */}
          <View style={styles.instruction}>
            <Txt role="bodyStrong" style={styles.centered}>
              {checking
                ? t('scan.checking')
                : readerDownloading
                  ? t('scan.moduleDownloading')
                  : t('scan.instruction')}
            </Txt>
          </View>
        </View>
      </>
    )
  }

  return (
    <View style={styles.container}>
      <View style={styles.cameraArea}>{cameraArea()}</View>

      {/* The bar ends the screen, so it owns the bottom inset as Screen does, or on a phone with a
          home indicator the chips sit on top of it. */}
      <View style={[styles.bar, { paddingBottom: space.xl + insets.bottom }]}>
        <ErrorBox
          message={
            invalid === null || checking
              ? null
              : t(invalid === 'wrongNetwork' ? 'send.unsupported' : 'errors.invalidInput')
          }
        />
        <ErrorBox message={galleryIssue !== null ? t(GALLERY_LINE[galleryIssue]) : null} />
        <View style={styles.barRow}>
          <Touch onPress={pasteAndSubmit} feedback="surface" style={styles.chip}>
            <TabIcon name="paste" color={colors.text} size={18} />
            <Txt role="label">{t('scan.paste')}</Txt>
          </Touch>
          <Touch onPress={() => setManualOpen(true)} feedback="surface" style={styles.chip}>
            <TabIcon name="keyboard" color={colors.text} size={18} />
            <Txt role="label">{t('scan.enter')}</Txt>
          </Touch>
          {qrImageAvailable() && (
            <Touch onPress={pickFromGallery} disabled={picking} feedback="surface" style={styles.chip}>
              <TabIcon name="image" color={colors.text} size={18} />
              <Txt role="label">{t('scan.gallery')}</Txt>
            </Touch>
          )}
        </View>
      </View>

      <Sheet
        visible={manualOpen}
        onClose={() => setManualOpen(false)}
        closeLabel={t('common.close')}
        keyboard
        // The field asks for focus, and on iOS a Modal's autoFocus fires before the sheet is on
        // screen, so the keyboard comes up against nothing. Sheet forwards onShow for exactly this.
        onShow={() => manualRef.current?.focus()}>
        <Txt role="subheading">{t('scan.manualTitle')}</Txt>
        <Field
          ref={manualRef}
          value={manualText}
          onChangeText={setManualText}
          autoCapitalize="none"
          autoCorrect={false}
          multiline
          placeholder={manualLabel}
          accessibilityLabel={manualLabel}
          style={styles.manualField}
        />
        <GradientButton
          label={t('scan.manualConfirm')}
          onPress={submitManual}
          disabled={manualText.trim().length === 0}
        />
      </Sheet>
    </View>
  )
}

const FINDER = 240
// How far the mask runs past the area on every side. A layout's size is fractional at most
// densities and the native view rounds it, which left a line of camera along an edge, so the cover
// is wider than any rounding rather than rounded to the pixel. What it overruns is off screen or
// under the bar, which is drawn after it.
const MASK_BLEED = 1
const FINDER_WIDTH = 3
const FINDER_ARM = 48

// Darkened everywhere but the square, so the one thing to look at is where the code goes while the
// person still sees what the camera points at. The hole is the viewfinder's shape, and until the area
// is measured the whole of it is darkened the same way.
function CameraMask({ area }: { area: { width: number; height: number } | null }): React.JSX.Element {
  if (area === null) {
    return <View style={styles.mask} />
  }
  const width = area.width + 2 * MASK_BLEED
  const height = area.height + 2 * MASK_BLEED
  const left = (width - FINDER) / 2
  const top = (height - FINDER) / 2
  const r = radius.xl
  const inner = FINDER - r * 2
  const corner = `A${r} ${r} 0 0 1`
  const hole =
    `M${left + r} ${top}h${inner}${corner} ${left + FINDER} ${top + r}v${inner}` +
    `${corner} ${left + FINDER - r} ${top + FINDER}h${-inner}${corner} ${left} ${top + FINDER - r}v${-inner}` +
    `${corner} ${left + r} ${top}Z`
  return (
    <Svg width={width} height={height} style={styles.maskCover}>
      <Path d={`M0 0H${width}V${height}H0Z${hole}`} fill={colors.cameraMask} fillRule="evenodd" />
    </Svg>
  )
}

// The four corners of the square a code goes in, a shape drawn over the camera rather than an outline
// around anything. Its weight is chosen to stay visible against arbitrary footage.
function Viewfinder({ color }: { color: string }): React.JSX.Element {
  const near = FINDER_WIDTH / 2
  const far = FINDER - near
  const r = radius.xl
  const corners = [
    `M${near} ${FINDER_ARM}V${r}Q${near} ${near} ${r} ${near}H${FINDER_ARM}`,
    `M${FINDER - FINDER_ARM} ${near}H${FINDER - r}Q${far} ${near} ${far} ${r}V${FINDER_ARM}`,
    `M${far} ${FINDER - FINDER_ARM}V${FINDER - r}Q${far} ${far} ${FINDER - r} ${far}H${FINDER - FINDER_ARM}`,
    `M${FINDER_ARM} ${far}H${r}Q${near} ${far} ${near} ${FINDER - r}V${FINDER - FINDER_ARM}`,
  ]
  return (
    <Svg width={FINDER} height={FINDER}>
      <Path
        d={corners.join('')}
        stroke={color}
        strokeWidth={FINDER_WIDTH}
        strokeLinecap="round"
        fill="none"
      />
    </Svg>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: colors.background,
  },
  cameraArea: {
    flex: 1,
  },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: space.xl,
    backgroundColor: colors.background,
  },
  centered: {
    textAlign: 'center',
  },
  // Touch holds the 44pt floor, which the padding alone missed by the text's leading.
  settingsButton: {
    marginTop: space.lg,
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  mask: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: colors.cameraMask,
  },
  maskCover: {
    position: 'absolute',
    top: -MASK_BLEED,
    left: -MASK_BLEED,
  },
  finder: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  instruction: {
    position: 'absolute',
    top: '50%',
    left: 0,
    right: 0,
    marginTop: FINDER / 2 + space.xl,
    paddingHorizontal: space.xl,
  },
  bar: {
    backgroundColor: colors.background,
    paddingHorizontal: space.xl,
    paddingTop: space.lg,
    gap: space.sm,
  },
  barRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  chip: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.sm,
    // The button radius rather than the card one.
    paddingVertical: space.md,
    minHeight: touch.min,
    borderRadius: radius.md,
    borderCurve: 'continuous',
    backgroundColor: colors.surfaceVariant,
  },
  manualField: {
    marginBottom: space.lg,
  },
})
