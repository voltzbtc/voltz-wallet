import { useCallback, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  connectActiveSpark,
  sparkConnectedWalletId,
  sparkGetWalletInfo,
  sparkSetStableBalance,
} from '../wallet/spark'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { PRIMARY_ID } from '../wallet/seed'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { saveDollarInviteSeen } from '../wallet/settings'
import { usdbBaseUnits } from '../wallet/dollarOffer'

type Options = {
  // Told of the direction as it is tried, and of the way back when it fails.
  onShown?: (active: boolean) => void
  // Asks for the mode again after a switch that never reached the SDK.
  reread?: () => void
}

export type StableSwitch = {
  // The direction the confirmation is asking about, null with no confirmation open.
  pending: boolean | null
  switching: boolean
  error: string | null
  ask: (next: boolean) => void
  cancel: () => void
  confirm: () => Promise<void>
  noteError: (message: string | null) => void
}

// The one writer of the dollar mode. Either direction converts the whole balance, so it asks first,
// and it locks while the SDK works, so a double tap cannot fire a second conversion.
export function useStableSwitch({ onShown, reread }: Options = {}): StableSwitch {
  const { t } = useTranslation()
  const [pending, setPending] = useState<boolean | null>(null)
  const [switching, setSwitching] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const locked = useRef(false)

  const ask = useCallback((next: boolean) => {
    if (!locked.current) {
      setPending(next)
    }
  }, [])

  const cancel = useCallback(() => setPending(null), [])

  const apply = useCallback(
    async (next: boolean) => {
      locked.current = true
      setSwitching(true)
      setError(null)
      let answered: boolean | null = null
      try {
        const wanted = (await getActiveWalletId()) ?? PRIMARY_ID
        // Switching wallets does not reconnect the SDK, and the mode reaches the whole seed, so a tap
        // landing before the reconnect would convert the wallet the person just left.
        if (sparkConnectedWalletId() !== wanted) {
          setError(t('stable.switchFailed'))
          await connectActiveSpark().catch(() => undefined)
          reread?.()
          return
        }
        // The connection an ended exit leaves has no stable balance until the next connection request
        // replaces it, so the tap asks for one first, and converts only if the wallet is still the same.
        await connectActiveSpark().catch(() => undefined)
        if (sparkConnectedWalletId() !== wanted) {
          setError(t('stable.switchFailed'))
          reread?.()
          return
        }
        onShown?.(next)
        await sparkSetStableBalance(next)
        answered = next
      } catch (cause) {
        onShown?.(!next)
        const code = classifyWalletError(cause)
        setError(code === 'unknown' ? t('stable.switchFailed') : t(walletErrorKey(code)))
      } finally {
        locked.current = false
        setSwitching(false)
      }
      // The balance going back to bitcoin still reads as USDB here, and that is no reason to invite
      // the person who just left. Lost, it repeats one invitation.
      if (answered === false) {
        const walletId = sparkConnectedWalletId()
        if (walletId !== null) {
          sparkGetWalletInfo()
            .then(info => saveDollarInviteSeen(walletId, usdbBaseUnits(info.tokens)))
            .catch(() => undefined)
        }
      }
    },
    [onShown, reread, t],
  )

  const confirm = useCallback(async () => {
    const next = pending
    setPending(null)
    if (next !== null && !locked.current) {
      await apply(next)
    }
  }, [apply, pending])

  return { pending, switching, error, ask, cancel, confirm, noteError: setError }
}
