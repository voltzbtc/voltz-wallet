import { sparkGetFiatRates } from './spark'
import { resolveDisplayCurrency } from './fiatDisplay'
import { rateFor } from './priceLine'
import { formatFiat, satsToFiat } from './fiat'
import type { PaymentFacts } from './paymentNotice'

// How long a send's card stays open to its value. The card is shown at once and the value fills in
// when a rate answers; one that answers later would change a card the person may be reading.
export const NOTICE_RATE_WAIT_MS = 2_000

// A bitcoin amount's value in the display currency, read now, or nothing when no rate answers in time.
// A token's amount is its own value and gets none, since the sats rate would price its base units.
export async function noticeFiat(facts: PaymentFacts, language: string): Promise<string | undefined> {
  if (facts.asset || facts.tokenUnread) {
    return undefined
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<undefined>(resolve => {
    timer = setTimeout(() => resolve(undefined), NOTICE_RATE_WAIT_MS)
  })
  const read = (async () => {
    const currency = await resolveDisplayCurrency(language)
    const rate = rateFor(await sparkGetFiatRates([currency]), currency)
    return rate === null ? undefined : formatFiat(satsToFiat(facts.sat, rate), currency)
  })().catch(() => undefined)
  try {
    return await Promise.race([read, late])
  } finally {
    clearTimeout(timer)
  }
}
