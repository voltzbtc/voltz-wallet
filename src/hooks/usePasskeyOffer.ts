import { useEffect, useState } from 'react'
import { passkeyAvailable, passkeyOffered } from '../wallet/passkey'

export type PasskeyOffer = 'checking' | 'available' | 'absent'

// Whether this screen can offer a passkey. Only the button waits on it: the words are on screen from
// the first frame, and an answer that lands after the screen left is dropped with the screen.
export function usePasskeyOffer(): PasskeyOffer {
  const [offer, setOffer] = useState<PasskeyOffer>(() => (passkeyOffered() ? 'checking' : 'absent'))

  useEffect(() => {
    if (!passkeyOffered()) {
      return
    }
    let current = true
    passkeyAvailable().then(available => {
      if (current) {
        setOffer(available ? 'available' : 'absent')
      }
    })
    return () => {
      current = false
    }
  }, [])

  return offer
}
