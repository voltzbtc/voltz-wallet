import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  onSparkConnected,
  sparkGetFiatRates,
  sparkGetPayment,
  sparkSubscribeToReceives,
  type ReceiveUpdate,
} from '../wallet/spark'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { onDisplayCurrencyChanged } from '../wallet/displayCurrencyNotice'
import { satsToFiat, formatFiat, localizeAmount, type FiatCurrency } from '../wallet/fiat'
import { formatSats } from '../wallet/amount'
import { fromBaseUnits } from '../wallet/sparkConvert'
import { dollarsOfSats } from '../wallet/assets'
import { useDollarMode } from '../wallet/dollarMode'
import { priceIsOld, rateFor } from '../wallet/priceLine'
import type { HistoryAsset } from '../wallet/payment'
import { noticeTitle, tokenUnit, type NoticeRail } from '../wallet/paymentNotice'
import { ReceivedOverlay } from './ReceivedOverlay'
import { IncomingBanner } from './IncomingBanner'

type Props = {
  onDismiss?: () => void
}

// One read of the feed, dated by the moment it left. Either rate is null when the feed had none.
type Rates = {
  fiat: { value: number; currency: FiatCurrency } | null
  usd: number | null
  readAt: number
}

// How long the arriving pill waits for an outcome before asking for the payment by id. Nothing says
// the SDK reports every failed receive, so without a limit the pill could stay up forever.
export const INCOMING_OUTCOME_LIMIT_MS = 120_000

export function ReceivedOverlayHost({ onDismiss }: Props): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const [incoming, setIncoming] = useState<{
    id: string
    sat: number
    asset?: HistoryAsset
    rail?: NoticeRail
    dollars?: number
  } | null>(null)
  const [received, setReceived] = useState<{
    id: string
    sat: number
    asset?: HistoryAsset
    rail?: NoticeRail
    fiat?: string
    dollars?: number
    zap?: { comment?: string }
  } | null>(null)
  // The newest read that answered. A figure is drawn from it only within PRICE_MAX_AGE_MS of the
  // moment it left, so a connection hours old never prices a payment at its own rate.
  const rates = useRef<Rates | null>(null)
  const reading = useRef<Promise<Rates | null> | null>(null)
  // Moved by a change of language or display currency, either of which can change the currency a
  // figure is in. Rates held, or a read begun, before the move never price a payment after it.
  const basis = useRef(0)
  const mounted = useRef(true)
  // Read by the receive listener, which outlives any one render.
  const language = useRef(i18n.language)
  language.current = i18n.language
  const dollarMode = useRef(false)
  dollarMode.current = useDollarMode()

  const freshRates = useCallback((): Rates | null => {
    const held = rates.current
    return held && !priceIsOld(held.readAt, Date.now()) ? held : null
  }, [])

  // Best effort, since a missing rate only hides a figure. An answer older than the one held is
  // dropped, so a slow read never takes the place of a newer one.
  const readRates = useCallback((): Promise<Rates | null> => {
    const begun = basis.current
    const run = (async () => {
      const currency = await resolveDisplayCurrency(language.current)
      const readAt = Date.now()
      const answer = await sparkGetFiatRates(Array.from(new Set([currency, 'USD'])))
      if (mounted.current && begun === basis.current && !(rates.current && rates.current.readAt > readAt)) {
        const value = rateFor(answer, currency)
        rates.current = { fiat: value === null ? null : { value, currency }, usd: rateFor(answer, 'USD'), readAt }
      }
      return freshRates()
    })()
      .catch(() => null)
      .finally(() => {
        if (reading.current === run) {
          reading.current = null
        }
      })
    reading.current = run
    return run
  }, [freshRates])

  // A read already on its way answers for a payment that finds the rates old, rather than a second one.
  const ratesForPayment = useCallback(
    (): Promise<Rates | null> => reading.current ?? readRates(),
    [readRates],
  )

  // What a dollar wallet reads an amount in sats as. The sats are still sats when this shows, since
  // the conversion comes after the announcement, and under the minimum it never comes, so the figure is
  // marked approximate and nothing says it converted. A token arrives in its own exact unit.
  const dollarsOf = useCallback(
    (sat: number, asset: HistoryAsset | undefined, at: Rates | null): number | undefined => {
      const dollars = dollarMode.current && !asset ? dollarsOfSats(sat, at?.usd) : null
      return dollars ?? undefined
    },
    [],
  )

  // The pill's payment, read by events and by the limit's answer, which land between renders.
  const pill = useRef<string | null>(null)
  // The last payment announced. The limit's read can find it settled before the SDK's own event comes,
  // and that event brings the same payment again.
  const announced = useRef<string | null>(null)
  const pillLimit = useRef<ReturnType<typeof setTimeout> | null>(null)

  const dropPill = useCallback(() => {
    if (pillLimit.current) {
      clearTimeout(pillLimit.current)
      pillLimit.current = null
    }
    pill.current = null
    setIncoming(null)
  }, [])

  const show = useCallback((update: ReceiveUpdate) => {
    if (update.stage === 'failed') {
      if (pill.current === update.id) {
        dropPill()
      }
      return
    }
    if (update.stage === 'incoming') {
      dropPill()
      const { id } = update
      pill.current = id
      const at = freshRates()
      setIncoming({
        id,
        sat: update.sat,
        asset: update.asset,
        rail: update.rail,
        dollars: dollarsOf(update.sat, update.asset, at),
      })
      // Read now, so the announcement that follows finds a rate it may use.
      if (!at) {
        ratesForPayment()
      }
      // Anything but a settled answer only takes the pill down, since it proves nothing about the money.
      pillLimit.current = setTimeout(() => {
        pillLimit.current = null
        sparkGetPayment(id).then(
          item => {
            if (pill.current !== id) {
              return
            }
            if (item.status === 'complete') {
              show({
                id,
                stage: 'received',
                sat: item.amountSat,
                ...(item.asset ? { asset: item.asset } : {}),
                ...(item.method ? { rail: item.method } : {}),
                ...(item.zap ? { zap: item.zap } : {}),
              })
            } else {
              dropPill()
            }
          },
          () => {
            if (pill.current === id) {
              dropPill()
            }
          },
        )
      }, INCOMING_OUTCOME_LIMIT_MS)
      return
    }
    dropPill()
    if (update.id === announced.current) {
      return
    }
    const { id } = update
    announced.current = id
    // A token's raw amount is its base units, which the sats rate would price as sats.
    const fiatOf = (at: Rates | null): string | undefined =>
      at?.fiat && !update.asset ? formatFiat(satsToFiat(update.sat, at.fiat.value), at.fiat.currency) : undefined
    const at = freshRates()
    setReceived({
      id,
      sat: update.sat,
      asset: update.asset,
      rail: update.rail,
      fiat: fiatOf(at),
      dollars: dollarsOf(update.sat, update.asset, at),
      zap: update.zap,
    })
    if (at || update.asset) {
      return
    }
    // With no rate young enough the payment shows in sats at once, and the line under it waits for a
    // read. Only that line: dollars would replace the figure and restart its count-up.
    ratesForPayment().then(next => {
      const fiat = fiatOf(next)
      if (fiat) {
        setReceived(shown => (shown && shown.id === id && shown.fiat === undefined ? { ...shown, fiat } : shown))
      }
    })
  }, [dollarsOf, dropPill, freshRates, ratesForPayment])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      if (pillLimit.current) {
        clearTimeout(pillLimit.current)
      }
      pill.current = null
    }
  }, [])

  const newBasis = useCallback(() => {
    basis.current += 1
    rates.current = null
    reading.current = null
  }, [])

  // Each connection, and each change of language or display currency, reads ahead of any payment.
  useEffect(() => {
    newBasis()
    return onSparkConnected(() => {
      readRates()
    })
  }, [i18n.language, newBasis, readRates])
  useEffect(
    () =>
      onDisplayCurrencyChanged(() => {
        newBasis()
        readRates()
      }),
    [newBasis, readRates],
  )

  // Subscribing at mount hits requireSdk() before Home connects, and the swallowed throw leaves
  // settled receives silent. A reconnect also kills the old listener, so this reruns per connect.
  useEffect(() => {
    let unsub: (() => void) | null = null
    let alive = true
    const off = onSparkConnected(() => {
      if (unsub) {
        unsub()
        unsub = null
      }
      sparkSubscribeToReceives(show)
        .then(u => (alive ? (unsub = u) : u()))
        .catch(() => undefined)
    })
    return () => {
      alive = false
      off()
      if (unsub) {
        unsub()
      }
    }
  }, [show])

  const places = received?.asset ? (received.asset.amount.split('.')[1] ?? '').length : 0
  // A token the app does not know goes unnamed, since its ticker is whatever its issuer typed; the line
  // under the figure says so.
  const receivedTicker = received?.asset ? tokenUnit(received.asset.assetId) : null
  const unknownToken = received?.asset !== undefined && receivedTicker === null

  return (
    <>
      <IncomingBanner
        visible={incoming !== null}
        amountSat={incoming?.sat ?? 0}
        asset={incoming?.asset}
        rail={incoming?.rail}
        dollars={
          incoming?.dollars === undefined
            ? undefined
            : t('receive.approxFiat', { amount: formatFiat(incoming.dollars, 'USD') })
        }
      />
      {received ? (
        <ReceivedOverlay
          visible
          amount={
            received.dollars !== undefined
              ? {
                  value: received.dollars,
                  unit: '',
                  format: (n: number) => t('receive.approxFiat', { amount: formatFiat(n, 'USD') }),
                }
              : received.asset
              ? {
                  value: Number(received.asset.amount),
                  unit: receivedTicker ?? '',
                  // As many places as the payment carries, so the count-up lands on the exact figure.
                  format: (n: number) => localizeAmount(fromBaseUnits(Math.round(n * 10 ** places), places)),
                }
              : { value: received.sat, unit: t('common.sats'), format: formatSats }
          }
          // A zap keeps its own title, Lightning being what a zap is.
          label={received.zap ? undefined : noticeTitle('received', received.rail, t)}
          fiat={received.dollars === undefined ? received.fiat : undefined}
          beneath={
            received.dollars !== undefined
              ? t('receive.sats', { amount: formatSats(received.sat) })
              : unknownToken
              ? t('notice.unknownToken')
              : undefined
          }
          zap={received.zap}
          onDone={() => {
            setReceived(null)
            onDismiss?.()
          }}
        />
      ) : null}
    </>
  )
}
