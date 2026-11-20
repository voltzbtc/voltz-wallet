import NativeVoltzQrImage from '../../specs/NativeVoltzQrImage'
import { discardPickedImage, pickFullImage } from './walletImage'

// The one reader of the still image QR bridge. It answers with text or with why there is none, and it
// never acts on the text: a read code goes through the same check as one from the camera.

// On Android the code reader is a Play Services module that downloads on first use. Until it lands,
// ML Kit fails with this message (play-services-mlkit-barcode-scanning 18.3.1), on the camera and on a
// still image alike.
export const MODULE_DOWNLOADING = 'barcode module to be downloaded'

export type GalleryQr =
  | { kind: 'read'; text: string }
  | { kind: 'cancelled' }
  | { kind: 'none' }
  | { kind: 'several' }
  | { kind: 'downloading' }
  | { kind: 'failed' }

// `get` on the spec answers null in a binary without the module, which then offers no gallery.
export function qrImageAvailable(): boolean {
  return NativeVoltzQrImage !== null
}

// An image with two different codes has no answer here: taking one would be choosing whom to pay. The
// same code twice, as in a card photographed with its copy, is one code.
export function oneCode(codes: readonly string[]): GalleryQr {
  const distinct = [...new Set(codes.map(code => code.trim()).filter(code => code.length > 0))]
  if (distinct.length === 0) {
    return { kind: 'none' }
  }
  return distinct.length === 1 ? { kind: 'read', text: distinct[0] } : { kind: 'several' }
}

async function decode(uri: string): Promise<GalleryQr> {
  if (!NativeVoltzQrImage) {
    return { kind: 'failed' }
  }
  try {
    return oneCode(await NativeVoltzQrImage.decode(uri))
  } catch (error) {
    const message = (error as Error | null)?.message
    return typeof message === 'string' && message.includes(MODULE_DOWNLOADING)
      ? { kind: 'downloading' }
      : { kind: 'failed' }
  }
}

// The picker is the system's, which reads only the one photo chosen, so no storage permission exists
// to ask for. What it leaves in the cache is the person's photo and goes as soon as it is read.
export async function readQrFromGallery(): Promise<GalleryQr> {
  const picked = await pickFullImage()
  if (picked.kind !== 'image') {
    return { kind: picked.kind }
  }
  try {
    return await decode(picked.uri)
  } finally {
    await discardPickedImage(picked.uri)
  }
}
