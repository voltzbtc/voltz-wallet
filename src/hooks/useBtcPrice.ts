import { useEffect, useRef, useState } from 'react'
import { AppState } from 'react-native'
import { useTranslation } from 'react-i18next'
import { onSparkConnected, sparkConnectedWalletId, sparkGetFiatRates, SYNC_WAIT_MS } from '../wallet/spark'
import { resolveDisplayCurrency } from '../wallet/fiatDisplay'
import { onDisplayCurrencyChanged } from '../wallet/displayCurrencyNotice'
import { onActiveWalletChanged } from '../wallet/wallet'
import {
  PRICE_MAX_AGE_MS,
  PRICE_READ_EVERY_MS,
  priceIsOld,
  rateFor,
  type PriceLine,
} from '../wallet/priceLine'

// The live price for the strip on Home. It lives only while the screen is in front and the app with
// it: every timer stops when either leaves, and what was shown is judged again by its age on the way
// back, since no timer ran to take it down.
//
// `latest` numbers the read whose answer counts, so a read landing after a newer one, a currency
// change, a wallet switch or a trip to the background lands nothing. A read that fails, or a figure
// that ages out, leaves the price up and takes `current` off it, and only a feed with no such currency
// or a change of currency takes the price away.
//
// With no connection there is nothing to read through, and the connect brings the first read. Offline
// after a restart nothing may ever answer, so the skeleton waits as long as a balance waits for its
// sync and no more.
export function useBtcPrice(focused: boolean = true): PriceLine {
  const { i18n } = useTranslation()
  const language = i18n.language
  const [line, setLine] = useState<PriceLine>({ status: 'first' })
  // Outlives the effect, which a language change runs again with a figure on screen.
  const readAt = useRef<number | null>(null)

  useEffect(() => {
    let latest = 0
    let running = false
    let every: ReturnType<typeof setInterval> | null = null
    let expiry: ReturnType<typeof setTimeout> | null = null
    let firstWait: ReturnType<typeof setTimeout> | null = null

    const clearExpiry = () => {
      if (expiry !== null) {
        clearTimeout(expiry)
        expiry = null
      }
    }
    const clearFirstWait = () => {
      if (firstWait !== null) {
        clearTimeout(firstWait)
        firstWait = null
      }
    }
    const firstAnswered = () => {
      clearFirstWait()
      setLine(prev => (prev.status === 'first' ? { status: 'none' } : prev))
    }
    const blank = () => {
      readAt.current = null
      clearExpiry()
      setLine(prev => (prev.status === 'price' ? { status: 'none' } : prev))
    }
    // A read that failed mutes the figure, which stays until its age is up and then goes.
    const outdated = () => {
      setLine(prev => (prev.status === 'price' && prev.current ? { ...prev, current: false } : prev))
    }
    const armExpiry = (shownAt: number) => {
      clearExpiry()
      expiry = setTimeout(blank, shownAt + PRICE_MAX_AGE_MS - Date.now())
    }

    const read = () => {
      if (!running || sparkConnectedWalletId() === null) {
        return
      }
      const mine = ++latest
      const sentAt = Date.now()
      resolveDisplayCurrency(language)
        .then(async currency => ({ currency, rates: await sparkGetFiatRates([currency]) }))
        .then(({ currency, rates }) => {
          if (mine !== latest) {
            return
          }
          firstAnswered()
          const rate = rateFor(rates, currency)
          if (rate === null) {
            blank()
            return
          }
          if (priceIsOld(sentAt, Date.now())) {
            blank()
            return
          }
          readAt.current = sentAt
          armExpiry(sentAt)
          setLine({ status: 'price', rate, currency, current: true, readAt: sentAt })
        })
        .catch(() => {
          if (mine === latest) {
            firstAnswered()
            outdated()
          }
        })
    }

    const start = () => {
      if (running) {
        return
      }
      running = true
      const shownAt = readAt.current
      if (shownAt !== null) {
        if (priceIsOld(shownAt, Date.now())) {
          blank()
        } else {
          armExpiry(shownAt)
        }
      }
      firstWait = setTimeout(firstAnswered, SYNC_WAIT_MS)
      every = setInterval(read, PRICE_READ_EVERY_MS)
      read()
    }

    const stop = () => {
      running = false
      latest += 1
      clearExpiry()
      clearFirstWait()
      if (every !== null) {
        clearInterval(every)
        every = null
      }
    }

    // Registered before the start, whose own read covers a connection already up.
    const offConnected = onSparkConnected(read)
    const offCurrency = onDisplayCurrencyChanged(() => {
      latest += 1
      blank()
      read()
    })
    const offWallet = onActiveWalletChanged(() => {
      latest += 1
    })
    const appState = AppState.addEventListener('change', state => {
      if (state === 'active' && focused) {
        start()
      } else {
        stop()
      }
    })
    // A view is mounted by somebody looking at it, unless the system woke the app in the background.
    if (focused && AppState.currentState !== 'background' && AppState.currentState !== 'inactive') {
      start()
    }

    return () => {
      stop()
      offConnected()
      offCurrency()
      offWallet()
      appState.remove()
    }
  }, [language, focused])

  return line
}
