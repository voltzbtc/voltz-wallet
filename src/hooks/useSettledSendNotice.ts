import { useEffect, type Dispatch, type SetStateAction } from 'react'
import { useTranslation } from 'react-i18next'
import { onSendSettled } from '../wallet/sendNotice'
import { settledSendNotice } from '../wallet/paymentNotice'
import { noticeFiat } from '../wallet/noticeFiat'
import type { ForegroundNotice } from '../wallet/pushRoute'

// The card for a send the confirm screen left on the way, once the SDK gave its last word, in the
// record's own terms: the rail, the amount in its asset's unit, and a bitcoin amount's value in the
// display currency when a rate answers in time. The record has already given the send up when it is
// heard, so the card is set at once and the value only fills in that same card: a language change,
// an unmount or a later card during the read cannot lose this one or be covered by it.
export function useSettledSendNotice(setNotice: Dispatch<SetStateAction<ForegroundNotice | null>>): void {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  useEffect(() => {
    let alive = true
    const off = onSendSettled((outcome, facts) => {
      const card = settledSendNotice(outcome, facts, t)
      setNotice(card)
      noticeFiat(facts, language).then(fiat => {
        if (alive && fiat !== undefined) {
          const valued = settledSendNotice(outcome, facts, t, fiat)
          setNotice(shown => (shown === card ? valued : shown))
        }
      })
    })
    return () => {
      alive = false
      off()
    }
  }, [setNotice, t, language])
}
