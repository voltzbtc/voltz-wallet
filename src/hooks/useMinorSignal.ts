import { useSyncExternalStore } from 'react'
import { ageVerdictNow, onAgeVerdict } from '../wallet/ageSignal'

// Whether the store's age signal has answered that this person is under 18. False while it is asked,
// and for any answer that says less (see src/wallet/ageSignal.ts).
export function useMinorSignal(): boolean {
  return useSyncExternalStore(onAgeVerdict, () => ageVerdictNow() === 'minor')
}
