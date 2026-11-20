import RNFS from 'react-native-fs'
import { asOwnActivity } from './relock'

// Isolates react-native-image-picker so screens never import it directly. The picker is require()'d
// lazily inside each call, so a missing native module (before pod install, for instance) degrades to
// a failed pick instead of crashing on import. Each picker, and the camera's permission dialog, runs
// as the app's own activity, which Android shows by pausing the app, so a trip that begins in it
// raises no cover and is timed against ten minutes instead of two.

const DIR = `${RNFS.DocumentDirectoryPath}/wallet-avatars`

// A photo for a wallet's avatar, from the library or the camera. `width` and `height` are what the
// picker reports for the file it wrote, in the orientation the photo is shown in, which is what the
// adjust step lays over its circle. Every way it can end that has something to say is its own kind.
export type WalletPhoto =
  | { kind: 'image'; uri: string; width?: number; height?: number }
  | { kind: 'cancelled' }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'failed' }

// The picker scales a photo down to fit 1024 on its longer side, so no full-resolution photo is kept
// for an avatar while a crop zoomed three times still has pixels to show.
const AVATAR_OPTIONS = { mediaType: 'photo', maxWidth: 1024, maxHeight: 1024, quality: 0.8 } as const

type PickerAnswer = {
  didCancel?: boolean
  errorCode?: string
  assets?: { uri?: string; width?: number; height?: number }[]
}

// `permission` is a refusal only from the camera, whose permission the person can grant in the
// settings the screen points to. The library asks for none, so there the same code is a picker
// that failed.
function readAnswer(res: PickerAnswer, from: 'camera' | 'library'): WalletPhoto {
  if (res.didCancel) {
    return { kind: 'cancelled' }
  }
  if (res.errorCode === 'camera_unavailable') {
    return { kind: 'unavailable' }
  }
  if (res.errorCode === 'permission' && from === 'camera') {
    return { kind: 'denied' }
  }
  const asset = res.assets?.[0]
  if (res.errorCode || !asset?.uri) {
    return { kind: 'failed' }
  }
  return { kind: 'image', uri: asset.uri, width: asset.width, height: asset.height }
}

// The system's photo picker, which asks for no photo library permission on either platform: the
// Photo Picker on Android 13 and later, PHPicker on iOS.
export async function pickWalletImage(): Promise<WalletPhoto> {
  try {
    const { launchImageLibrary } = require('react-native-image-picker')
    return readAnswer(
      await asOwnActivity(() => launchImageLibrary({ ...AVATAR_OPTIONS, selectionLimit: 1 })),
      'library',
    )
  } catch {
    return { kind: 'failed' }
  }
}

// The camera, once CAMERA is granted. The manifest declares CAMERA for the scanner, and on Android the
// picker then refuses to open the camera without it rather than asking, so the app asks first, on both
// platforms, through the same API the scanner uses. A refusal opens nothing.
export async function takeWalletPhoto(): Promise<WalletPhoto> {
  try {
    const { Camera } = require('react-native-vision-camera')
    const allowed =
      Camera.getCameraPermissionStatus() === 'granted' ||
      (await asOwnActivity(() => Camera.requestCameraPermission())) === 'granted'
    if (!allowed) {
      return { kind: 'denied' }
    }
    const { launchCamera } = require('react-native-image-picker')
    return readAnswer(await asOwnActivity(() => launchCamera({ ...AVATAR_OPTIONS, saveToPhotos: false })), 'camera')
  } catch {
    return { kind: 'failed' }
  }
}

export type PickedImage = { kind: 'image'; uri: string } | { kind: 'cancelled' } | { kind: 'failed' }

// For an image that is read rather than shown, so it comes at full size: a downscaled photo can lose
// the modules of a dense code. A cancelled pick and a failed one are told apart, since the second has
// something to say to the person.
export async function pickFullImage(): Promise<PickedImage> {
  try {
    const { launchImageLibrary } = require('react-native-image-picker')
    const res: PickerAnswer = await asOwnActivity(() => launchImageLibrary({ mediaType: 'photo', selectionLimit: 1 }))
    if (res.didCancel) {
      return { kind: 'cancelled' }
    }
    const uri = res.assets?.[0]?.uri
    return uri ? { kind: 'image', uri } : { kind: 'failed' }
  } catch {
    return { kind: 'failed' }
  }
}

// The picker's own copy, in the app's cache. Only a file URI is one: anything else is not ours to touch.
export async function discardPickedImage(uri: string): Promise<void> {
  if (uri.startsWith('file://')) {
    await RNFS.unlink(uri.replace(/^file:\/\//, '')).catch(() => undefined)
  }
}

// At most one avatar is kept per wallet, but its filename carries a cache-busting timestamp, so the
// removal sweeps by prefix. `keep` is spared, the one a save just pointed the wallet at.
export async function deleteWalletImage(fingerprint: string, keep?: string): Promise<void> {
  try {
    const files = await RNFS.readDir(DIR)
    await Promise.all(
      files
        .filter(f => f.name.startsWith(`${fingerprint}-`) && f.path !== keep)
        .map(f => RNFS.unlink(f.path).catch(() => undefined)),
    )
  } catch {
    // Nothing to delete when the directory was never created.
  }
}

// Copies a picked image into the app's documents beside the current avatar, which the saved name
// still points at until the save lands, so the caller sweeps the old one only after it. The filename
// carries a timestamp so <Image> refetches instead of serving the cached old bytes. Returns the
// permanent path, without a file:// prefix.
export async function persistWalletImage(fingerprint: string, srcUri: string): Promise<string> {
  await RNFS.mkdir(DIR).catch(() => undefined)
  const dest = `${DIR}/${fingerprint}-${Date.now()}.jpg`
  await RNFS.copyFile(srcUri.replace(/^file:\/\//, ''), dest)
  return dest
}

// Drops an avatar a save copied in and could not point the wallet at.
export async function discardWalletImage(path: string): Promise<void> {
  await RNFS.unlink(path).catch(() => undefined)
}
