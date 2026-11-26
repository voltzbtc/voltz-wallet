import { PixelRatio, Platform, Share } from 'react-native'
import RNFS from 'react-native-fs'
import { create } from 'qrcode'
import NativeVoltzShare from '../../specs/NativeVoltzShare'

// The card a lightning address is shared as: a square PNG with the address, its QR and the mark, and
// a line of text beside it. This module draws the QR's modules, writes the PNG, and is the one reader
// of specs/NativeVoltzShare.ts. Nothing here calls the network: the image and the text leave the
// device only through the system share sheet, to the app the person picks there.

// The side of the shared PNG in pixels, and of the card's viewBox: square, so a status that crops to
// a square loses nothing.
export const CARD_SIZE = 1080

// The one file the card is written to, in the app's cache. A fixed name, so each share overwrites the
// last one; iOS removes it once its sheet closes, and Android keeps it until the next share, since the
// app picked in the chooser reads it after the chooser has returned. The Android provider serves this
// folder and no other (android/app/src/main/res/xml/share_paths.xml).
export const CARD_DIR = `${RNFS.CachesDirectoryPath}/share`
export const CARD_FILE = `${CARD_DIR}/voltz-address.png`

// react-native-qrcode-svg draws the app's QR from the same library at this level when given none, so
// the card's code is module for module the one on the screen for the same text.
const QR_LEVEL = 'M'

// The dark modules of the QR for `value`, as one path in a square of `side` units with no quiet zone.
export function cardQrPath(value: string, side: number): string {
  const modules = create(value, { errorCorrectionLevel: QR_LEVEL }).modules
  const count = modules.size
  const cell = side / count
  const parts: string[] = []
  for (let row = 0; row < count; row += 1) {
    for (let col = 0; col < count; col += 1) {
      if (modules.get(row, col)) {
        parts.push(`M${col * cell} ${row * cell}h${cell}v${cell}h${-cell}z`)
      }
    }
  }
  return parts.join('')
}

// The address in the largest type that keeps it on one line across `width`, up to `max` so a short
// name does not outweigh the code. Latin glyphs of the system font average about 0.6 of their size.
export function cardAddressFontSize(address: string, width: number, max: number): number {
  const fit = width / (Math.max(address.length, 1) * 0.6)
  return Math.min(Math.floor(fit), max)
}

// What toDataURL is asked to draw. Android counts pixels; iOS counts points and multiplies by the
// screen's scale, so both hand back a PNG of CARD_SIZE pixels a side.
export function cardExportSize(): { width: number; height: number } {
  const side = Platform.OS === 'ios' ? CARD_SIZE / PixelRatio.get() : CARD_SIZE
  return { width: side, height: side }
}

// Writes the PNG and opens the system share sheet on it with `message` beside it, so an app that takes
// only text still gets the address. Rejects when the file cannot be written or the sheet cannot open;
// a sheet the person closes is not a failure.
export async function shareCardImage(png: string, message: string, title: string): Promise<void> {
  await RNFS.mkdir(CARD_DIR)
  await RNFS.writeFile(CARD_FILE, png, 'base64')
  if (Platform.OS === 'android') {
    if (!NativeVoltzShare) {
      throw new Error('image share unavailable')
    }
    await NativeVoltzShare.shareImage(CARD_FILE, message, title)
    return
  }
  try {
    await Share.share({ url: `file://${CARD_FILE}`, message }, { subject: title })
  } finally {
    await RNFS.unlink(CARD_FILE).catch(() => undefined)
  }
}

// The address as text alone, for a bio or a chat that takes no image.
export async function shareAddressText(message: string): Promise<void> {
  await Share.share({ message })
}
