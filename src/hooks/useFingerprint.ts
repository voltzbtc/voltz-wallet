import { useEffect, useRef, useState } from 'react'
import { fingerprintFromMnemonicAsync } from '../wallet/fingerprint'

// PBKDF2 is the only heavy CPU on the backup screen, so an already derived phrase must be a cache
// hit. The cache sits in a ref rather than module scope so no seed material outlives the screen.
export function useFingerprint(mnemonic: string): string | null {
  const cache = useRef(new Map<string, string>())
  const [fingerprint, setFingerprint] = useState<string | null>(
    mnemonic ? cache.current.get(mnemonic) ?? null : null,
  )

  useEffect(() => {
    if (!mnemonic) {
      setFingerprint(null)
      return undefined
    }
    const cached = cache.current.get(mnemonic)
    if (cached) {
      setFingerprint(cached)
      return undefined
    }
    setFingerprint(null)
    let cancelled = false
    fingerprintFromMnemonicAsync(mnemonic).then(fp => {
      cache.current.set(mnemonic, fp)
      if (!cancelled) {
        setFingerprint(fp)
      }
    })
    return () => {
      cancelled = true
    }
  }, [mnemonic])

  return fingerprint
}
