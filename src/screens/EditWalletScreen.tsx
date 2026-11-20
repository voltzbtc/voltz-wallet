import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Keyboard, Linking, ScrollView, StyleSheet, View } from 'react-native'
import { useSafeAreaFrame, useSafeAreaInsets } from 'react-native-safe-area-context'
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import { getWalletIdentity, holdsLiveExit } from '../wallet/wallet'
import { REMOVAL_ERRORS, removeWalletAndCheck } from '../wallet/walletRemoval'
import { isUnconfirmed } from '../wallet/backupMark'
import { loadWalletMeta, saveWalletMeta, type WalletMeta } from '../wallet/walletMeta'
import { usablePhotoSize, type PhotoCrop } from '../wallet/photoCrop'
import { loadRegistry } from '../wallet/walletRegistry'
import type { RootStackParamList } from '../navigation/RootNavigator'
import {
  deleteWalletImage,
  discardPickedImage,
  discardWalletImage,
  persistWalletImage,
  pickWalletImage,
  takeWalletPhoto,
  type WalletPhoto,
} from '../wallet/walletImage'
import { avatarColor, resolveWalletDisplay } from '../wallet/walletIdentity'
import { savedWalletName, walletEditChanged, type WalletEditState } from '../wallet/walletEdit'
import { WalletAvatar } from '../components/WalletAvatar'
import { ConfirmSheet, type ConfirmRequest } from '../components/ConfirmSheet'
import { GradientButton } from '../components/GradientButton'
import { TabIcon } from '../components/TabIcon'
import { WalletRowsSkeleton } from '../components/WalletRowsSkeleton'
import { colors, font, radius, space, touch, walletColors } from '../theme'
import { Field } from '../components/Field'
import { FieldClear } from '../components/FieldClear'
import { Txt } from '../components/Txt'
import { ErrorBox } from '../components/ErrorBox'
import { PasskeyCard } from '../components/PasskeyCard'
import { passkeyLive, passkeyRemovalNote } from '../wallet/passkey'
import { getBreezLnurlDomain } from '../config'
import { Skeleton } from '../components/Skeleton'
import { Touch } from '../components/Touch'
import { Sheet } from '../components/Sheet'
import { MenuRow } from '../components/MenuRow'

// What a photo that did not arrive says, in the words each one needs.
type PhotoIssue = Extract<WalletPhoto['kind'], 'denied' | 'unavailable' | 'failed'>
const PHOTO_ISSUE = {
  denied: 'editWallet.cameraDenied',
  unavailable: 'scan.noCamera',
  failed: 'editWallet.photoFailed',
} as const satisfies Record<PhotoIssue, string>

export function EditWalletScreen(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  const adjusted = useRoute<RouteProp<RootStackParamList, 'EditWallet'>>().params?.photo
  const [fingerprint, setFingerprint] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string | null>(null)
  const [imageUri, setImageUri] = useState<string | null>(null)
  // Goes with the photo: a new photo brings its own, and removing the photo clears it.
  const [imageCrop, setImageCrop] = useState<PhotoCrop | null>(null)
  // What the wallet held when the screen read it. Save shows only while the screen differs from it,
  // and never before it answered or when it failed, since there is nothing to compare against.
  const [opened, setOpened] = useState<WalletEditState | null>(null)
  // While false, save leaves the stored image untouched rather than persisting or deleting it.
  const [imageChanged, setImageChanged] = useState(false)
  const [canRemove, setCanRemove] = useState(false)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  const [choosingSource, setChoosingSource] = useState(false)
  // The row picked in the sheet, acted on once the sheet has left the screen. Remove waits too,
  // since the panel would otherwise lose its row and shrink while it slides out.
  const source = useRef<'camera' | 'library' | 'remove' | null>(null)
  const [photoIssue, setPhotoIssue] = useState<PhotoIssue | null>(null)
  // A picker answers after however long the person spends in it, by which time the screen may be gone.
  const mounted = useRef(true)
  useEffect(
    () => () => {
      mounted.current = false
    },
    [],
  )
  // The wallet's reads answered, so the avatar and the name stop being placeholders. Also when they
  // failed, since a skeleton has no end otherwise.
  const [read, setRead] = useState(false)
  // The registry id of the wallet on screen, read once. Removal names it rather than whichever wallet
  // is active when the tap lands, because a removal that failed halfway may already have made
  // another wallet active, and a second tap would then delete that one.
  const [walletId, setWalletId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const saving = useRef(false)
  const [error, setError] = useState<string | null>(null)
  const insets = useSafeAreaInsets()
  // The app's own window, which follows a split screen or a resize as the device's screen would not.
  const { width } = useSafeAreaFrame()
  const columns = swatchColumns(width)
  const defaultName = t('drawer.walletName')
  // The palette, then the colour the wallet has from its fingerprint. That one is on no palette, so
  // without its own swatch a wallet with no colour chosen has nothing to show as chosen, and no way
  // back to it once another is picked.
  const swatchRows = useMemo(() => {
    const swatches: Swatch[] = walletColors.map(fill => ({ fill, chosen: fill }))
    if (fingerprint) {
      swatches.push({ fill: avatarColor(fingerprint), chosen: null })
    }
    const rows: Swatch[][] = []
    for (let i = 0; i < swatches.length; i += columns) {
      rows.push(swatches.slice(i, i + columns))
    }
    return rows
  }, [columns, fingerprint])

  useEffect(() => {
    let alive = true
    getWalletIdentity()
      .then(async id => {
        if (!alive) {
          return
        }
        const fp = id.fingerprint || null
        setFingerprint(fp)
        if (fp) {
          const meta = await loadWalletMeta(fp)
          // A save with no photo writes the path empty, so empty is no photo, as
          // resolveWalletDisplay reads it.
          const photo = meta.imagePath?.trim() || null
          const shown: WalletEditState = {
            // The wallet's name, in the field as a value. As a placeholder it reads as an empty field.
            name: meta.name?.trim() || defaultName,
            // A save with no colour writes it empty.
            color: meta.color?.trim() || null,
            imagePath: photo,
            imageCrop: (photo && meta.imageCrop) || null,
          }
          setName(shown.name)
          setColor(shown.color)
          setImageUri(shown.imagePath)
          setImageCrop(shown.imageCrop)
          setOpened(shown)
        }
        const reg = await loadRegistry()
        if (alive) {
          setWalletId(reg.active)
          setCanRemove(reg.active !== null && reg.wallets.length > 1)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) {
          setRead(true)
        }
      })
    return () => {
      alive = false
    }
  }, [defaultName])

  const display = fingerprint
    ? resolveWalletDisplay(
        fingerprint,
        { name, color: color ?? undefined, imagePath: imageUri ?? undefined, imageCrop: imageCrop ?? undefined },
        defaultName,
      )
    : null

  // A photo back from the adjust step, taken once. It replaces the photo on screen and its crop.
  useEffect(() => {
    if (!adjusted) {
      return
    }
    setImageUri(adjusted.uri)
    setImageCrop(adjusted.crop)
    setImageChanged(true)
    setPhotoIssue(null)
    navigation.setParams({ photo: undefined })
  }, [adjusted, navigation])

  // A tap reaches the avatar and Remove with the name field focused, and the keyboard would sit
  // over the sheet either opens.
  useEffect(() => {
    if (choosingSource || asking) {
      Keyboard.dismiss()
    }
  }, [choosingSource, asking])

  const changed =
    opened !== null && walletEditChanged(opened, { name, color, imagePath: imageUri, imageCrop }, defaultName)

  function chooseSource(from: 'camera' | 'library' | 'remove') {
    source.current = from
    setChoosingSource(false)
  }

  // Nothing on screen changes until a photo comes back from the adjust step, so a cancelled pick, a
  // refused camera or a failed picker leaves the photo, its crop and the colour as they were.
  async function openSource() {
    const from = source.current
    source.current = null
    if (!from) {
      return
    }
    if (from === 'remove') {
      removePhoto()
      return
    }
    const picked = from === 'camera' ? await takeWalletPhoto() : await pickWalletImage()
    if (!mounted.current) {
      if (picked.kind === 'image') {
        await discardPickedImage(picked.uri)
      }
      return
    }
    if (picked.kind === 'cancelled') {
      return
    }
    if (picked.kind !== 'image') {
      setPhotoIssue(picked.kind)
      return
    }
    if (usablePhotoSize(picked.width, picked.height)) {
      navigation.navigate('AdjustWalletPhoto', { uri: picked.uri, width: picked.width!, height: picked.height! })
      return
    }
    // Without a size there is nothing to lay the circle over, so the photo is used as it comes and
    // drawn centred, as every photo was before crops.
    setImageUri(picked.uri)
    setImageCrop(null)
    setImageChanged(true)
  }

  function removePhoto() {
    setImageUri(null)
    setImageCrop(null)
    setImageChanged(true)
  }

  // A photo would cover the color, so the two are mutually exclusive.
  function pickColor(c: string | null) {
    setColor(c)
    if (imageUri) {
      removePhoto()
    }
  }

  // The app's own sheet on both platforms, since the system's action sheet follows the phone's theme.
  function editAvatar() {
    setPhotoIssue(null)
    setChoosingSource(true)
  }

  async function save() {
    // Each save sweeps every photo but the one it copied, so a second save running beside it would
    // delete the photo the first one points the name at. A press while one runs does nothing.
    if (!fingerprint || saving.current) {
      return
    }
    saving.current = true
    setError(null)
    const patch: WalletMeta = { name: savedWalletName(name, defaultName), color: color ?? '' }
    // The saved name points at the photo on disk, so the old photo goes only once the save landed,
    // and a new one the save could not point at goes with the failure.
    let copied: string | undefined
    try {
      if (imageChanged) {
        copied = imageUri ? await persistWalletImage(fingerprint, imageUri) : undefined
        patch.imagePath = copied ?? ''
        // Undefined drops the key from the file, so no photo keeps no crop behind.
        patch.imageCrop = copied ? (imageCrop ?? undefined) : undefined
      }
      await saveWalletMeta(fingerprint, patch)
    } catch {
      if (copied) {
        await discardWalletImage(copied)
      }
      // The typed name, colour and photo stay, so the same tap can try again.
      saving.current = false
      setError(t('editWallet.saveFailed'))
      return
    }
    if (imageChanged) {
      await deleteWalletImage(fingerprint, copied)
    }
    navigation.goBack()
  }

  async function doRemove(id: string) {
    // The removal sweeps the wallet's photos, so beside a save still copying one it would delete that
    // copy under the save or leave it behind. A removal confirmed while a save runs does nothing, and the
    // save then leaves the screen.
    if (saving.current) {
      return
    }
    setError(null)
    setBusy(true)
    const outcome = await removeWalletAndCheck(id, fingerprint ?? '')
    if (outcome === 'gone') {
      navigation.navigate('Main')
      return
    }
    setBusy(false)
    setError(t(REMOVAL_ERRORS[outcome]))
  }

  // Warned before confirming, since removing deletes the seed from the device. Where Voltz may hold
  // something for the wallet, the same question offers to delete that first; the deletion screen then
  // removes the wallet once Voltz holds the request, since removing it before would drop the record
  // this device follows the request with.
  async function remove() {
    const id = walletId
    if (!id) {
      return
    }
    if (!canRemove) {
      // The only wallet stays on the device, so the button leads to deleting its data alone.
      setAsking({
        title: t('editWallet.onlyWalletTitle'),
        body: t('editWallet.onlyWalletBody'),
        confirm: t('deleteData.row'),
        cancel: t('editWallet.cancel'),
        // Primary, since this only opens the deletion screen, whose own confirm is the danger one.
        onConfirm: () => navigation.navigate('DeleteData'),
      })
      return
    }
    const warning = (await isUnconfirmed(id)) ? 'backup.removeUnconfirmed' : 'editWallet.removeWarning'
    const passkey = await passkeyRemovalNote(id)
    setAsking({
      title: t('editWallet.removeTitle'),
      body: passkey ? `${t(warning)}\n\n${t(passkey)}` : t(warning),
      confirm: t('editWallet.remove'),
      cancel: t('editWallet.cancel'),
      danger: true,
      option: deletionOffered
        ? { label: t('editWallet.alsoDelete'), note: t('editWallet.alsoDeleteNote') }
        : undefined,
      onConfirm: alsoDelete => (alsoDelete ? deleteThenRemove(id) : doRemove(id)),
    })
  }

  // The deletion screen removes the wallet only once Voltz holds the request, and a live exit
  // refuses that removal, so asked there it would come after the request was sent. Asked here,
  // nothing is sent.
  async function deleteThenRemove(id: string) {
    setError(null)
    if (await holdsLiveExit(id)) {
      setError(t(REMOVAL_ERRORS.liveExit))
      return
    }
    navigation.navigate('DeleteData', { thenRemove: id })
  }

  // Only where Voltz holds something for the wallet: without a build domain the address lives on the
  // SDK's default server and nothing of this wallet reaches Voltz. Deletion signs as the active wallet,
  // which is the one on screen.
  const deletionOffered = Boolean(getBreezLnurlDomain()) && walletId !== null

  if (busy) {
    return <WalletRowsSkeleton />
  }

  return (
    // The bottom inset keeps Remove clear of the home indicator once the content is scrolled to its end.
    // With the name field focused, a ScrollView left at 'never' spends the first tap on hiding the
    // keyboard, so the clear inside the field, Save and the swatches would each need two.
    <ScrollView
      keyboardShouldPersistTaps="handled"
      style={styles.scroll}
      contentContainerStyle={[styles.container, { paddingBottom: space.xl + insets.bottom }]}>
      <View style={styles.preview}>
        {read ? (
          <Touch onPress={editAvatar} feedback="surface" label={t('editWallet.photo')} style={styles.avatarWrap}>
            {display && (
              <WalletAvatar
                color={display.color}
                imagePath={display.imagePath}
                crop={display.imageCrop}
                monogram={display.monogram}
                size={AVATAR}
              />
            )}
            <View style={styles.cameraBadge}>
              <TabIcon name="camera" color={colors.text} size={16} />
            </View>
          </Touch>
        ) : (
          <Skeleton width={AVATAR} height={AVATAR} borderRadius={radius.full} />
        )}
        {photoIssue && (
          <View style={styles.photoIssue}>
            <ErrorBox message={t(PHOTO_ISSUE[photoIssue])} />
            {photoIssue === 'denied' && (
              // Settings that will not open leave the line and the link up, which say enough.
              <Touch
                onPress={() => Linking.openSettings().catch(() => undefined)}
                feedback="link"
                style={styles.settingsLink}>
                <Txt role="bodyBold" tone="accent">
                  {t('scan.openSettings')}
                </Txt>
              </Touch>
            )}
          </View>
        )}
      </View>

      {read ? (
        <Field
          label={t('editWallet.name')}
          value={name}
          onChangeText={setName}
          placeholder={defaultName}
          maxLength={24}
          // Empty saves as the default name, which then keeps following the language.
          trailing={<FieldClear value={name} onClear={() => setName('')} label={t('editWallet.clearName')} />}
        />
      ) : (
        <View style={styles.fieldSkeleton}>
          <Skeleton width={110} height={font.leading.sm} />
          <Skeleton height={touch.selector} borderRadius={radius.lg} />
        </View>
      )}

      <View style={styles.section}>
        <Txt role="label" tone="muted">
          {t('editWallet.color')}
        </Txt>
        <View style={styles.grid}>
          {swatchRows.map((row, index) => (
            <View key={index} style={styles.gridRow}>
              {row.map(({ fill, chosen }) => {
                const selected = !imageUri && color === chosen
                return (
                  <View key={fill} style={styles.colorPlace}>
                    <Touch
                      onPress={() => pickColor(chosen)}
                      feedback="surface"
                      label={t(`editWallet.swatch.${swatchName(chosen)}`)}
                      state={{ selected }}
                      style={[styles.colorCell, { backgroundColor: fill }]}>
                      {selected && <TabIcon name="check" color={colors.text} size={24} strokeWidth={3} />}
                    </Touch>
                  </View>
                )
              })}
              {Array.from({ length: columns - row.length }, (_, pad) => (
                <View key={`pad-${pad}`} style={styles.colorPlace} />
              ))}
            </View>
          ))}
        </View>
      </View>

      <ErrorBox message={error} style={styles.error} />
      {/* Concealed rather than unmounted, so its box holds Remove in place as it comes and goes. */}
      <GradientButton label={t('editWallet.save')} onPress={save} disabled={!changed} />

      {passkeyLive() && walletId && <PasskeyCard walletId={walletId} style={styles.passkey} />}

      {/* The only wallet cannot be removed, and still reaches its data deletion through here. */}
      {(canRemove || deletionOffered) && (
        <View style={styles.removeButton}>
          <GradientButton label={t('editWallet.remove')} variant="danger" onPress={remove} />
        </View>
      )}
      <ConfirmSheet request={asking} onClose={() => setAsking(null)} />
      <Sheet
        visible={choosingSource}
        onClose={() => setChoosingSource(false)}
        onDismiss={openSource}
        closeLabel={t('editWallet.cancel')}>
        <View>
          <MenuRow icon="camera" label={t('editWallet.takePhoto')} onPress={() => chooseSource('camera')} right={null} />
          <MenuRow
            icon="image"
            label={t('editWallet.choosePhoto')}
            onPress={() => chooseSource('library')}
            right={null}
            divider={Boolean(imageUri)}
          />
          {imageUri && (
            <MenuRow
              icon="close"
              danger
              label={t('editWallet.removePhoto')}
              onPress={() => chooseSource('remove')}
              right={null}
              divider={false}
            />
          )}
        </View>
      </Sheet>
    </ScrollView>
  )
}

const AVATAR = 96
const CAMERA_BADGE = 32
const MAX_SWATCH_COLUMNS = 6

type WalletColor = (typeof walletColors)[number]

// `chosen` is what the swatch saves, and null is no colour of the wallet's own.
type Swatch = { fill: string; chosen: WalletColor | null }

// What a screen reader says for each swatch, since the colour itself is all the swatch shows. In the
// order of walletColors, whose comments name the same colours; a test holds the two lists together.
export const SWATCH_NAMES = [
  'orange',
  'red',
  'crimson',
  'pink',
  'purple',
  'violet',
  'indigo',
  'blue',
  'teal',
  'green',
  'bronze',
  'gray',
] as const

function swatchName(chosen: WalletColor | null): (typeof SWATCH_NAMES)[number] | 'automatic' {
  return chosen === null ? 'automatic' : SWATCH_NAMES[walletColors.indexOf(chosen)]
}

// Up to six to a row, each sharing the row's width, so the grid runs gutter to gutter on any screen.
// A narrower screen takes one fewer column rather than drawing a swatch under the 44pt target, which
// six columns would below about 352pt of window.
export function swatchColumns(windowWidth: number): number {
  const room = windowWidth - space.xl * 2
  const fit = Math.floor((room + space.sm) / (touch.min + space.sm))
  return Math.max(1, Math.min(MAX_SWATCH_COLUMNS, fit))
}

const styles = StyleSheet.create({
  scroll: {
    flex: 1,
    backgroundColor: colors.background,
  },
  container: {
    padding: space.xl,
  },
  preview: {
    alignItems: 'center',
    marginBottom: space.xl,
  },
  avatarWrap: {
    width: AVATAR,
    height: AVATAR,
  },
  // On the circle's edge rather than across it, so the camera mark never covers the wallet's letters.
  cameraBadge: {
    position: 'absolute',
    right: 0,
    bottom: 0,
    width: CAMERA_BADGE,
    height: CAMERA_BADGE,
    borderRadius: radius.full,
    backgroundColor: colors.surfaceRaised,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photoIssue: {
    alignSelf: 'stretch',
    gap: space.sm,
    marginTop: space.lg,
  },
  // Touch holds the 44pt floor, which the padding alone misses by the text's leading.
  settingsLink: {
    alignSelf: 'center',
    paddingVertical: space.md,
    paddingHorizontal: space.lg,
  },
  fieldSkeleton: {
    gap: space.sm,
  },
  // The same distance from the name field above as the field keeps from the preview, since the
  // label alone would otherwise sit on the field's edge.
  section: {
    gap: space.sm,
    marginTop: space.xl,
    marginBottom: space.xl,
  },
  grid: {
    gap: space.sm,
  },
  gridRow: {
    flexDirection: 'row',
    gap: space.sm,
  },
  // Every place in a row, swatch or empty, is this same plain cell, so each takes one share of the
  // width and a short last row keeps the size of the full ones. The share stays off the swatch: a
  // pressable with flex, an aspect ratio and the touch floor of its own does not hold its share when
  // it sits alone on a short row, and draws larger than the rest.
  colorPlace: {
    flex: 1,
  },
  // Fills its cell, and takes its height from that width.
  colorCell: {
    width: '100%',
    aspectRatio: 1,
    borderRadius: radius.full,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  passkey: {
    marginTop: space.lg,
  },
  removeButton: {
    marginTop: space.lg,
  },
  error: {
    marginBottom: space.md,
  },
})
