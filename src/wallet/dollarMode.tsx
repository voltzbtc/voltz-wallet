import React, { createContext, useContext, useEffect, useState } from 'react'
import {
  onSparkConnected,
  onStableBalanceChanged,
  sparkConnectedWalletId,
  sparkGetStableBalance,
  sparkSubscribeToPayments,
} from './spark'
import { getActiveWalletId } from './walletRegistry'
import { PRIMARY_ID } from './seed'
import { onActiveWalletChanged } from './wallet'
import { loadDollarMode, saveDollarMode } from './settings'
import { colors, gradients } from '../theme'

// Whether the dollar wallet is active, shared app-wide so the shared chrome (the wordmark, the tab
// bar) can switch its accent from the bitcoin orange to the USDB green in step with the Home screen.
// Read from the SDK on each connect, on every SDK event of that connection, and again after a failed
// read, since one failure at connect would otherwise hold the wrong mode until the next connect.
const DollarModeContext = createContext(false)

// The read needs the network, and an offline wallet hears no SDK event that would ask again.
const READ_RETRY_MS = 15_000
const EVENT_BURST_MS = 600

export function useDollarMode(): boolean {
  return useContext(DollarModeContext)
}

// The app accent follows the wallet mode, the USDB green while the dollar wallet is on and the
// bitcoin orange otherwise. Use this in place of a hardcoded `colors.primary`/`gradients.primary`
// wherever the orange is a brand accent (CTAs, links, active states, selection marks), so the whole
// app recolors in step with the dollar wallet.
//
// There is deliberately no `accentSoft` here. The soft fills paired with a solid colour are warnings
// about the recovery phrase and notices about a domain, and those must read the same in both modes,
// since a seed warning tinted green reads as something to do with the dollar balance. No soft fill
// follows the mode, so a soft accent would have no honest consumer.
export function useAccent(): { accent: string; gradient: readonly [string, string] } {
  return useDollarMode()
    ? { accent: colors.dollar, gradient: gradients.dollar }
    : { accent: colors.primary, gradient: gradients.primary }
}

export function DollarModeProvider({
  children,
  initial = false,
}: {
  children: React.ReactNode
  // The last known mode, read from disk before the first paint, so the app opens in the right accent
  // instead of flashing orange while the SDK connects.
  initial?: boolean
}): React.JSX.Element {
  const [active, setActive] = useState(initial)

  useEffect(() => {
    let alive = true
    let reads = 0
    // Reads numbered below this one lost to a newer answer or to the switch itself.
    let settled = 0
    let retry: ReturnType<typeof setTimeout> | null = null
    let gathering: ReturnType<typeof setTimeout> | null = null
    let offPayments: (() => void) | null = null
    // Asks the SDK and caches the answer under the wallet it belongs to. Reconnecting after a switch
    // takes seconds, which is why the cache below carries the accent in the meantime.
    const refresh = () => {
      const connected = sparkConnectedWalletId()
      if (connected === null) {
        return
      }
      if (retry) {
        clearTimeout(retry)
        retry = null
      }
      const read = ++reads
      sparkGetStableBalance()
        .then(async on => {
          const walletId = (await getActiveWalletId()) ?? PRIMARY_ID
          // Between a switch and its reconnect the SDK is still the previous wallet, whose answer
          // belongs on neither the accent nor the new wallet's cache. The reconnect reads again.
          if (!alive || read < settled || walletId !== connected) {
            return
          }
          settled = read
          setActive(on)
          saveDollarMode(walletId, on).catch(() => undefined)
        })
        .catch(() => {
          if (alive && read === reads) {
            retry = setTimeout(refresh, READ_RETRY_MS)
          }
        })
    }
    // A burst of settled payments would fire one read per event. The mode changes on none of them on
    // its own, so one read after the burst is as current as one per event.
    const afterBurst = () => {
      gathering ??= setTimeout(() => {
        gathering = null
        refresh()
      }, EVENT_BURST_MS)
    }
    // Subscribing at mount would run before the SDK connects and throw, so it attaches on connect.
    const offConnected = onSparkConnected(() => {
      offPayments?.()
      offPayments = null
      refresh()
      sparkSubscribeToPayments(afterBurst)
        .then(off => (alive ? (offPayments = off) : off()))
        .catch(() => undefined)
    })
    // The switch itself is the only change no other signal reports, and waiting for one would leave
    // the accent on the previous mode.
    const offStable = onStableBalanceChanged(on => {
      settled = ++reads
      if (alive) {
        setActive(on)
      }
    })
    // Switching wallets fires before the SDK reconnects, so paint the new wallet's own cached mode at
    // once rather than leaving the previous wallet's accent up for the whole reconnect.
    const offWallet = onActiveWalletChanged(id => {
      loadDollarMode(id)
        .then(on => alive && setActive(on))
        .catch(() => undefined)
    })
    return () => {
      alive = false
      if (retry) {
        clearTimeout(retry)
      }
      if (gathering) {
        clearTimeout(gathering)
      }
      offConnected()
      offStable()
      offWallet()
      offPayments?.()
    }
  }, [])

  return <DollarModeContext.Provider value={active}>{children}</DollarModeContext.Provider>
}
