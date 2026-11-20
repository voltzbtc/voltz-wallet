import { useCallback, useRef, useState } from 'react'
import { generateMnemonic, type MnemonicLength } from '../wallet/seed'
import { fingerprintFromMnemonicAsync } from '../wallet/fingerprint'

// Both lengths are drawn and derived up front, so switching is a cache hit rather than fresh
// entropy and a slow PBKDF2 on screen. The draw runs on a macrotask so the backup screen paints
// its skeleton first. Only regenerate() draws again.
export function useSeedPair() {
  const [seeds, setSeeds] = useState<Record<MnemonicLength, string> | null>(null)
  const [fingerprints, setFingerprints] = useState<Record<MnemonicLength, string> | null>(null)
  const [length, setLength] = useState<MnemonicLength>(12)
  // Bumped on every regenerate so a slower in-flight draw can't overwrite a newer one.
  const draw = useRef(0)

  const regenerate = useCallback(() => {
    const mine = ++draw.current
    setSeeds(null)
    setFingerprints(null)
    setTimeout(() => {
      if (mine !== draw.current) {
        return
      }
      const drawn: Record<MnemonicLength, string> = { 12: generateMnemonic(12), 24: generateMnemonic(24) }
      setSeeds(drawn)
      Promise.all([
        fingerprintFromMnemonicAsync(drawn[12]),
        fingerprintFromMnemonicAsync(drawn[24]),
      ]).then(([f12, f24]) => {
        if (mine === draw.current) {
          setFingerprints({ 12: f12, 24: f24 })
        }
      })
    }, 0)
  }, [])

  // Forgets both drawn phrases once the chosen one is stored, so no copy outlives the write. A draw
  // still on its macrotask is dropped too.
  const clear = useCallback(() => {
    draw.current++
    setSeeds(null)
    setFingerprints(null)
  }, [])

  return {
    length,
    setLength,
    regenerate,
    clear,
    mnemonic: seeds ? seeds[length] : '',
    fingerprint: fingerprints ? fingerprints[length] : null,
    ready: seeds !== null,
  }
}
