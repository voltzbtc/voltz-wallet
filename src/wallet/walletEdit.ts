import { validateWalletName } from './walletIdentity'
import { sameCrop, type PhotoCrop } from './photoCrop'

// What Edit wallet holds on screen, and what it read when it opened. `name` is the field's text, the
// default name included when the wallet has none of its own.
export type WalletEditState = {
  name: string
  color: string | null
  imagePath: string | null
  // The square of the photo the avatar shows, null with no photo or a photo shown centred.
  imageCrop: PhotoCrop | null
}

// The name as a save writes it. The default name is stored as no name, so it keeps following the
// language, and an empty field saves as that same no name.
export function savedWalletName(typed: string, defaultName: string): string {
  const name = validateWalletName(typed)
  return name === defaultName ? '' : name
}

// A save with no photo writes the path empty, so an empty path and none are the same photo.
const photoOf = (path: string | null): string | null => path?.trim() || null

// Whether a save would write anything other than what was read. Names compare as they would be
// saved, so a trailing space, or emptying a field that showed the default name, is no change.
export function walletEditChanged(read: WalletEditState, now: WalletEditState, defaultName: string): boolean {
  return (
    savedWalletName(read.name, defaultName) !== savedWalletName(now.name, defaultName) ||
    read.color !== now.color ||
    photoOf(read.imagePath) !== photoOf(now.imagePath) ||
    !sameCrop(read.imageCrop, now.imageCrop)
  )
}
