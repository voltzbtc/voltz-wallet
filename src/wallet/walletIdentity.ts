import { hueColor } from '../theme'
import type { WalletMeta } from './walletMeta'
import { readCrop, type PhotoCrop } from './photoCrop'

// Pure helpers for the wallet identity shown in the drawer. The BIP32 master fingerprint (8 hex
// chars) doubles as the per-wallet visual identity, so multiple wallets read apart at a glance.
// Kept out of the component so it can be unit-tested.

// The fingerprint lowercased and left unbroken, so it reads as ONE wallet id rather than two
// values.
export function formatFingerprint(fingerprint: string): string {
  return fingerprint.trim().toLowerCase()
}

// Two-char monogram for the avatar disc, from the fingerprint's first byte.
export function avatarMonogram(fingerprint: string): string {
  return fingerprint.trim().slice(0, 2).toUpperCase()
}

// Deterministic hue, so the same wallet always looks the same and different wallets almost always
// differ. Saturation and lightness are fixed for a legible disc on the dark theme.
export function avatarColor(fingerprint: string): string {
  const fp = fingerprint.trim()
  let hash = 0
  for (let i = 0; i < fp.length; i++) {
    hash = (hash * 31 + fp.charCodeAt(i)) % 360
  }
  const hue = ((hash % 360) + 360) % 360
  return hueColor(hue)
}

const MAX_NAME_LENGTH = 24

// An empty result means no custom name, so the caller falls back to the default label.
export function validateWalletName(name: string): string {
  return name.trim().slice(0, MAX_NAME_LENGTH)
}

export type WalletDisplay = {
  name: string
  imagePath: string | null
  // Only beside a photo.
  imageCrop: PhotoCrop | null
  color: string
  monogram: string
}

// Custom name, photo and color when set, otherwise the deterministic defaults from the fingerprint.
// defaultName is injected so this stays i18n-free and unit-testable.
export function resolveWalletDisplay(
  fingerprint: string,
  meta: WalletMeta | null,
  defaultName: string,
): WalletDisplay {
  return {
    name: meta?.name?.trim() || defaultName,
    imagePath: meta?.imagePath?.trim() || null,
    imageCrop: (meta?.imagePath?.trim() && readCrop(meta.imageCrop)) || null,
    color: meta?.color?.trim() || avatarColor(fingerprint),
    monogram: avatarMonogram(fingerprint),
  }
}
