import { useCallback, useRef, useState } from 'react'
import { Platform } from 'react-native'
import { useFocusEffect } from '@react-navigation/native'
import { cancelNfcRead, readNfcDestination } from '../wallet/nfc'

// What Android's reading sheet shows. iOS has a system sheet of its own and stays on 'closed'.
export type NfcSheetPhase = 'closed' | 'waiting' | 'noAddress'

type Handlers = {
  onAddress: (address: string) => void
  onFailure: (cause: unknown) => void
}

// A read from a tag as a person sees it: pressing opens the sheet, and Cancel, the back gesture and
// leaving the screen all end the read. Android gives a waiting read no interface at all, which leaves
// a press looking like nothing happened and invites the next press.
//
// A cancel moves `run`, so whatever a read answers after it does nothing here, on top of nfc.ts
// answering cancelled. A refused second read leaves everything to the read that holds the reader.
export function useNfcRead(
  prompt: string,
  handlers: Handlers,
): { phase: NfcSheetPhase; read: () => Promise<void>; cancel: () => void } {
  const [phase, setPhase] = useState<NfcSheetPhase>('closed')
  const run = useRef(0)
  const latest = useRef({ prompt, handlers })
  latest.current = { prompt, handlers }

  const read = useCallback(async () => {
    const mine = run.current
    const sheet = Platform.OS === 'android'
    if (sheet) {
      setPhase('waiting')
    }
    try {
      const result = await readNfcDestination(latest.current.prompt)
      if (result.kind === 'busy' || mine !== run.current) {
        return
      }
      if (result.kind === 'noAddress' && sheet) {
        setPhase('noAddress')
        return
      }
      setPhase('closed')
      if (result.kind === 'address') {
        latest.current.handlers.onAddress(result.value)
      }
    } catch (cause) {
      if (mine === run.current) {
        setPhase('closed')
        latest.current.handlers.onFailure(cause)
      }
    }
  }, [])

  const cancel = useCallback(() => {
    run.current += 1
    cancelNfcRead()
    setPhase('closed')
  }, [])

  // The cleanup runs on a blur and on unmount alike.
  useFocusEffect(useCallback(() => cancel, [cancel]))

  return { phase, read, cancel }
}
