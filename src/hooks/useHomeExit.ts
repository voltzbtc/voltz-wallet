import { useCallback, useState } from 'react'
import { useFocusEffect } from '@react-navigation/native'
import { emergencyExitLive } from '../wallet/emergencyExit'
import { runExitPass, waitsOnPerson } from '../wallet/exitPass'
import { isLivePlan, loadExitPlan } from '../wallet/exitPlan'

// No exit, one under way, or one whose latest pass cannot go on without the person, which only its
// follow-up answers.
export type HomeExit = 'none' | 'underWay' | 'waits'

// What this wallet's exit asks of Home, and one pass each time Home gains focus with it. There is no
// work in the background, so this and the exit's own screen are what keep an exit moving. Nothing that
// waits on the person is kept: each focus starts from the plan, and its pass says it again.
export function useHomeExit(walletId: string | null, onPassEnd: () => void): HomeExit {
  // Kept with the wallet it was read for, so after a switch the previous wallet's exit is never shown
  // while the new wallet's plan is read.
  const [state, setState] = useState<{ walletId: string | null; exit: HomeExit }>({ walletId: null, exit: 'none' })

  useFocusEffect(
    useCallback(() => {
      if (!emergencyExitLive() || walletId === null) {
        setState({ walletId, exit: 'none' })
        return
      }
      let active = true
      ;(async () => {
        // A plan the platform will not read may be a live one, and only its screen says so.
        const live = await loadExitPlan(walletId).then(isLivePlan, () => true)
        if (active) {
          setState({ walletId, exit: live ? 'underWay' : 'none' })
        }
        if (!live) {
          return
        }
        const outcome = await runExitPass(walletId).catch(() => null)
        if (active) {
          if (outcome?.kind === 'done' || outcome?.kind === 'closed') {
            setState({ walletId, exit: 'none' })
          } else if (outcome !== null && waitsOnPerson(outcome)) {
            setState({ walletId, exit: 'waits' })
          }
          onPassEnd()
        }
      })()
      return () => {
        active = false
      }
    }, [walletId, onPassEnd]),
  )

  return state.walletId === walletId ? state.exit : 'none'
}
