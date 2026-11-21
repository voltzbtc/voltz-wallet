import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { AccessibilityInfo, Share, StyleSheet, View } from 'react-native'
import { useRoute, type RouteProp } from '@react-navigation/native'
import { useTranslation } from 'react-i18next'
import Clipboard from '@react-native-clipboard/clipboard'
import {
  claimDomain,
  confirmDomain,
  normaliseDomain,
  providerName,
  clearGrantedPurchase,
  clearPendingPurchase,
  loadPendingPurchase,
  onPendingPurchaseGone,
  quoteDomain,
  recordName,
  recordPurchaseRefusal,
  releasePendingPurchase,
  savePendingPurchase,
  fetchPrices,
  factsOf,
  type DomainConfirmation,
  type DomainFacts,
  type DomainQuote,
  type OnboardDeps,
  type OnboardStatus,
  type PendingPurchase,
  type PurchaseLeft,
} from '../wallet/domainOnboard'
import {
  sparkConfirmSend,
  sparkSyncedBalanceSat,
  sparkGetIdentityPubkey,
  sparkPrepareSend,
} from '../wallet/spark'
import { identitySigner } from '../wallet/identitySigner'
// The key lives beside the other purchase records rather than in the domain module, since it is
// about a charge reference and both purchase paths mint one.
import { idempotencyKeyFor } from '../wallet/purchase'
import { getBreezLnurlDomain, getDistribution } from '../config'
import { currentStore, loadProducts } from '../wallet/store'
import { payLineKey } from '../wallet/withdrawal'
import {
  buyInStore,
  deliveredYearOf,
  dismissStoreOutcome,
  dropStoreWait,
  keptOrderViews,
  liveStoreContext,
  onStoreSettled,
  storeOrderViews,
  syncStorePurchases,
  type DeliveredYear,
  type StoreOrderView,
} from '../wallet/storePurchase'
import { phaseOf } from '../wallet/domainTier'
import {
  domainOrderRefusalKey,
  keptAnswer,
  needsAPerson,
  paidRefusal,
  releases,
  storeErrorKey,
  storeRefusedKey,
  type FinalAnswer,
} from '../wallet/lnRefusal'
import { helpMailUrl } from '../wallet/recover'
import { activeScope, noteLine, onAskedWallet, putBack, sayOnce, takeLine } from '../wallet/releasedLines'
import type { LineScope } from '../wallet/releasedLines'
import { isUnreadableFile } from '../wallet/durableFile'
import { Skeleton } from '../components/Skeleton'
import { setDomainFor } from '../wallet/lnurlDomainPref'
import { getActiveWalletId } from '../wallet/walletRegistry'
import { reconnectActiveWallet } from '../wallet/wallet'
import { GradientButton } from '../components/GradientButton'
import { ErrorBox } from '../components/ErrorBox'
import { TabIcon } from '../components/TabIcon'
import { formatFiat } from '../wallet/fiat'
import { formatDate } from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { formatSats } from '../wallet/amount'
import type { RootStackParamList } from '../navigation/RootNavigator'
import { colors, font, radius, rhythm, space, primarySoftSurface } from '../theme'
import { Txt } from '../components/Txt'
import { Figure } from '../components/Amount'
import { useAccent } from '../wallet/dollarMode'
import { Screen } from '../components/Screen'
import { Card } from '../components/Card'
import { Notice } from '../components/Notice'
import { SupportMailCard, useSupportMail } from '../components/SupportMail'
import { Touch } from '../components/Touch'
import { Row } from '../components/Row'
import { Field } from '../components/Field'
import { useAppActive } from '../hooks/useAppActive'

// The customer brings a domain they already own; nothing here sells domains, so the whole target is
// one DNS record, once.
//
// There is deliberately no "I have finished" button. Pressing one before DNS has spread shows an
// error for something that is merely not ready, which is where a non-technical customer decides they
// did it wrong and stops.
//
// A renewal costs three presses, and each one earns its place. One opens the address screen, from
// the notification or from the menu. One is "Renew for one year" on the notice there, which is what
// navigates here: the invoice is minted on arrival, so a hold is never taken for somebody who only
// glanced at their own address. One is Pay, which moves the money, and money moving defends its own
// press. Nothing sits between the last two: the domain, the amount and the year are already on
// screen, and a sheet that restated them would be a press bought for the backend, not the human.
const POLL_MS = 10_000

// The subdomain actually registered when the field is left empty, and the value the field suggests.
// One constant for both, since a placeholder that disagrees with the default shows one address and
// buys another.
const DEFAULT_SUBDOMAIN = 'pay'

type Step = 'domain' | 'pay' | 'dns'

// Answers about a waited purchase that need a person, which the listener puts on screen itself.
const NEEDS_SUPPORT: ReadonlySet<string> = new Set(['support', 'unknownOrder', 'noReference'])

// The claim's refusals the DNS steps say in their own words. Every other failure of a poll only says
// the status could not be read, since the steps follow a paid year and an unpaid one is a lag the
// next poll settles (I4).
const POLL_REFUSALS: Readonly<Record<string, string>> = {
  domain_belongs_to_another_wallet: 'useDomain.domainTaken',
}

// What takes the screen over while a store purchase of the year is out of the owner's hands. Each
// names the host its order is for, which the first-year form may not be showing.
type StoreView =
  // Ask to Buy, a slow payment, or a paid purchase the gateway has not confirmed yet.
  | { kind: 'waiting'; host: string; reference: string; still: boolean }
  // The gateway refused the purchase for good. `refusal` is its status and code, which say whether
  // the store holds any money for it.
  | { kind: 'refused'; host: string; reference: string; refusal: string }
  // A refusal only a defect produces, which a person has to place.
  | { kind: 'support'; host: string; reference: string }

// What the screen says about a payment made, from the latest answer about it (see `awaiting`).
type PaidLine = 'asking' | 'waiting' | FinalAnswer

function isFinal(line: PaidLine): line is FinalAnswer {
  return line !== 'asking' && line !== 'waiting'
}

// What each final answer says. Only one that leaves sats nobody gave back yet offers support.
const FINAL_LINE: Record<FinalAnswer, string> = {
  kept: 'recover.blockedBody',
  repaid: 'recover.repaidBody',
  paidAgain: 'recover.paidAgainBody',
  paidAgainRepaid: 'recover.paidAgainRepaidBody',
  boughtBefore: 'recover.boughtBeforeBody',
}

// What the proof keeps of the gateway's last paid refusal, for a payment put on screen without an
// answer. A refusal for good outlives the process that heard it this way, and anything else starts
// at `otherwise`.
function lastSaid(proof: PendingPurchase, otherwise: PaidLine): PaidLine {
  return keptAnswer(proof) ?? otherwise
}

// A payment the screen shows, with what the latest answer about it said (see `awaiting`). `released`
// marks a line this screen claimed and said for an answer that gave the slot up, `gone` a payment whose
// proof another reader took out of the slot, and `delivered` the year another reader's grant answered
// for it; the next render drops either.
type Awaiting = PendingPurchase & { line: PaidLine; released?: true; gone?: true; delivered?: DomainConfirmation }

// A payment whose proof left the slot is no longer one the screen stands on, so its line is marked to
// go, as delivered or as gone, by how the writer that took it out says it left. A line this screen
// claimed and said stays (releasedLines.ts), and so does a delivery already marked.
function leftSlot(prev: Awaiting | null, reference: string, left: PurchaseLeft): Awaiting | null {
  if (prev?.reference !== reference || prev.released === true || prev.delivered !== undefined) {
    return prev
  }
  return left.reason === 'granted' ? { ...prev, delivered: left.year } : { ...prev, gone: true }
}

// The mark a question leaves on a payment whose proof it found gone from the record, set even with
// nothing on screen, since a Pay asks right after its send and the quote it paid then goes with the
// slot, or its year shows.
function heardLeft(purchase: PendingPurchase, left: PurchaseLeft): (prev: Awaiting | null) => Awaiting | null {
  return prev => leftSlot(prev ?? { ...purchase, line: 'waiting' }, purchase.reference, left)
}

export function UseMyDomainScreen(): React.JSX.Element {
  const { t, i18n } = useTranslation()
  const mail = useSupportMail()
  // The domain being renewed, when there is one. Knowing it is what removes the first step: asking
  // an owner to type a domain the app already holds is a press bought for nothing. Shaped like any
  // typed domain, so a param that is not one falls back to the ordinary purchase instead of opening
  // a payment for a host nobody can name.
  const renewHost = normaliseDomain(
    useRoute<RouteProp<RootStackParamList, 'UseMyDomain'>>().params?.renew ?? '',
  )
  const [step, setStep] = useState<Step>(renewHost ? 'pay' : 'domain')
  // A build that sells through the store buys the year there, at the store's price, and never in
  // sats. A year already paid in sats is still finished below, in every build.
  const store = getDistribution() === 'store'
  // The store's price for a year, in the owner's currency. Null while unknown.
  const [storePrice, setStorePrice] = useState<string | 'unavailable' | null>(null)
  // Nothing is for sale until the store has priced the year, and a store this device cannot reach
  // has nothing to sell at all.
  const storePriced = storePrice !== null && storePrice !== 'unavailable'
  const [storeView, setStoreView] = useState<StoreView | null>(null)
  // Whether the book and the store's list have answered for this screen. Until they have, a purchase
  // the store still holds may be the one on screen next, so neither Pay nor Continue is pressable
  // (docs/store-bridge.md, I3). A build that does not sell through the store reads neither.
  const [resumed, setResumed] = useState(!store)
  // Every press and every answer the root's sync brings starts a new sequence, and what the open's
  // reads and a Check again's read answer applies only while its sequence is still the current one
  // (I2).
  const seq = useRef(0)
  // The press that holds the screen, by a token of its own, or null while none does. Two presses land
  // in one tick before the button re-renders, and each reads a copy of `busy` that still says nobody
  // is pressing. A ref is read and written synchronously, so the second press sees the first. Each of
  // these presses takes a hold, mints a real invoice or opens the store.
  const working = useRef<number | null>(null)
  const tokens = useRef(0)
  // Takes the screen for a press, or answers null while another press holds it.
  const take = useCallback((): number | null => {
    if (working.current !== null) {
      return null
    }
    const token = ++tokens.current
    working.current = token
    setBusy(true)
    setError(null)
    return token
  }, [])
  // Gives the screen back, unless leaving a wait or a refusal took it from this press in the meantime.
  const release = useCallback((token: number): void => {
    if (working.current === token) {
      working.current = null
      setBusy(false)
    }
  }, [])
  // The order whose delivered year is on screen. A first year's is kept for the DNS steps until the
  // domain answers.
  const delivered = useRef<string | null>(null)
  const [typed, setTyped] = useState('')
  // Where the address lives, held apart from the label so that clearing the label to retype it does
  // not read as choosing the root. A root reachable only by emptying this field would not be a choice
  // anybody discovers.
  const [place, setPlace] = useState<'root' | 'sub'>('sub')
  const [subLabel, setSubLabel] = useState(DEFAULT_SUBDOMAIN)
  const [siteHelp, setSiteHelp] = useState(false)
  // The DNS step just copied, which shows Copied for a moment, as the receive screens do.
  const [copiedStep, setCopiedStep] = useState<number | null>(null)
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (copyTimer.current) {
        clearTimeout(copyTimer.current)
      }
    },
    [],
  )
  const { accent } = useAccent()
  // What the gateway charges right now, in US cents. Null while unknown, and the line stays off the
  // screen until it is not: a price nobody confirmed is worse than no price, since the customer
  // decides on it and is then quoted something else.
  const [tierCents, setTierCents] = useState<number | null>(null)
  // Falls back to the same label the choice displays. Without it an emptied field would show one
  // address and buy another, the root, which is a different domain and not what was on screen.
  const subdomain = place === 'sub' ? subLabel || DEFAULT_SUBDOMAIN : ''
  const [status, setStatus] = useState<OnboardStatus | null>(null)
  // What the latest poll of the DNS steps said in place of a status, the refusal's own line or that
  // the read did not answer, which names no cause (I4). Null once a poll answered.
  const [statusNote, setStatusNote] = useState<string | null>(null)
  const [quote, setQuote] = useState<DomainQuote | null>(null)
  // Whether the paid year is already over, which is the only thing that separates the two renewal
  // lines. Null while it is unknown, so an unanswerable read says nothing rather than guessing.
  const [lapsed, setLapsed] = useState<boolean | null>(null)
  const [renewal, setRenewal] = useState<(DomainConfirmation & { host: string }) | null>(null)
  // The proof of a payment the gateway has not turned into a purchase yet. While it is set the
  // screen shows nothing that could take more money, because there is no honest price to offer
  // somebody who has already paid. `line` holds what the latest answer about it said. It is `asking`
  // while the first question is out, `waiting` for the wait a later confirmation ends, and a final
  // answer for one no later confirmation changes (paidRefusal in lnRefusal.ts).
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null)
  // The host of a quote whose Pay failed and found another purchase's proof in the slot, which the
  // screen then waits on. Whether that quote's payment went is not known there, so it gets a line of
  // its own beside the awaited purchase's, never in place of it.
  const [unknownPay, setUnknownPay] = useState<string | null>(null)
  // The record of a payment made could not be read, so one may be owed that nothing on screen can
  // name. It takes the whole screen, with no claim, quote, store order or price below it, for as long
  // as the screen is open.
  const [unread, setUnread] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A payment whose proof another reader gave up (the recovery sweep above all), or which a read before
  // a confirmation found gone, is dropped on the render after it is heard, with the quote it paid, the
  // line about another payment beside it and the line its last press left, which promised the payment
  // would complete. The screen then goes on as a released slot, which offers a fresh quote: a first year
  // goes back to the form. Its line, if it gave sats back, reaches the screen only through the reader
  // that claims it (releasedLines.ts).
  //
  // One whose year another reader's grant delivered goes to what this screen's own grant shows, from
  // the year that grant answered, with nothing asked again: the year renewed, or a first year's DNS
  // steps. A price for that reference would sell the year just bought a second time.
  const [steppedOff, setSteppedOff] = useState(0)
  if (awaiting?.gone === true || awaiting?.delivered !== undefined) {
    setAwaiting(null)
    setUnknownPay(null)
    setError(null)
    if (awaiting.delivered !== undefined) {
      setRenewal({ ...awaiting.delivered, host: awaiting.host })
      setStep('dns')
    } else {
      setSteppedOff(n => n + 1)
      if (quote?.reference === awaiting.reference) {
        setQuote(null)
        if (renewHost === null && step === 'pay') {
          setStep('domain')
        }
      }
    }
  }
  // How each year's proof left the record while this screen was open, by reference, so a read or a
  // failure that later meets one of them gone takes it as the writer said it left.
  const leftRecord = useRef(new Map<string, PurchaseLeft>())
  useEffect(
    () =>
      onPendingPurchaseGone((reference, left) => {
        leftRecord.current.set(reference, left)
        setAwaiting(prev => leftSlot(prev, reference, left))
      }),
    [],
  )
  const timer = useRef<ReturnType<typeof setInterval> | null>(null)
  // Whether the screen is mounted, read when an answer that gives the slot up arrives. An answer heard
  // once the screen is gone, or while the app is out of the foreground, is kept as a line for the first
  // view that takes it (releasedLines.ts), since nobody saw it here.
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const active = useAppActive()
  const seen = useCallback((): boolean => mounted.current && active.current, [active])
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  // Whether the wallet took the domain once it answered, which is the choice stored and the wallet
  // reconnected, since that is what issues addresses on it. Null until the domain answers.
  // `adoptions` counts the tries, and Try again adds one.
  const [adoption, setAdoption] = useState<'adopting' | 'adopted' | 'failed' | null>(null)
  const [adoptions, setAdoptions] = useState(0)
  // Whether the customer has been shown that their root already answers. It gates the warning, not
  // the purchase: pressing again goes through, because the fact was the thing they were missing.
  const [rootBusyTold, setRootBusyTold] = useState(false)
  const prefs = useMemo(() => deviceDateTimePrefs(), [])

  const root = normaliseDomain(typed)
  // Typing a different domain, or moving off the root, makes the warning about the old one stale.
  useEffect(() => {
    setRootBusyTold(false)
  }, [root, place])
  const host = renewHost ?? (root ? (subdomain ? `${subdomain}.${root}` : root) : null)

  // Ticks only while a quote is on screen, which is the only place a deadline is shown.
  useEffect(() => {
    if (step !== 'pay') {
      return
    }
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [step])

  const deps = useCallback(async (): Promise<OnboardDeps> => {
    const domain = getBreezLnurlDomain()
    const owner = await identitySigner()
    return { gatewayUrl: `https://${domain}`, ownerPubkey: owner.pubkey, sign: owner.sign }
  }, [])

  // Each poll applies only while it is the latest, so a slow tick never overwrites a newer read (I2).
  const polls = useRef(0)
  const poll = useCallback(
    (polled: string): void => {
      const n = ++polls.current
      deps()
        .then(d => claimDomain(d, polled))
        .then(
          found => {
            if (polls.current === n) {
              setStatus(found)
              setStatusNote(null)
            }
          },
          (err: Error) => {
            if (polls.current === n) {
              setStatusNote(POLL_REFUSALS[err?.message ?? ''] ?? 'useDomain.statusUnread')
            }
          },
        )
    },
    [deps],
  )

  // Polls while the customer is looking at it, and stops when they leave. The server keeps working
  // either way, and push is what tells them once the app is closed.
  useEffect(() => {
    // A claim is never sent while a record of a payment could not be read.
    if (step !== 'dns' || !host || unread) {
      return
    }
    poll(host)
    timer.current = setInterval(() => poll(host), POLL_MS)
    return () => {
      if (timer.current) {
        clearInterval(timer.current)
      }
    }
  }, [step, host, poll, unread])

  const pollAgain = (): void => {
    if (host) {
      poll(host)
    }
  }

  // Reads the record for a payment's proof, last before a question goes out and again before a failure
  // is told, since only what the record holds now decides whether the wait stands. Null while it holds
  // the proof, which forgets how that proof left before: a Pay files the same quote again after a send
  // that failed, and the sweep files back a charge it finds. Otherwise the answer settle gives. A record
  // that cannot be read drops nothing and takes the screen as unread, and a proof no longer held drops
  // the wait the way the writer that took it out said it left, delivered or gone. The record read is the
  // named wallet's, or the active one's.
  const notHeld = useCallback(async (purchase: PendingPurchase, walletId?: string): Promise<boolean | null> => {
    const held = await loadPendingPurchase(walletId).catch(() => 'unread' as const)
    if (held === 'unread') {
      setUnread(true)
      return true
    }
    if (held?.reference !== purchase.reference) {
      const left = leftRecord.current.get(purchase.reference) ?? { reason: 'gone' }
      setAwaiting(heardLeft(purchase, left))
      return left.reason === 'granted'
    }
    leftRecord.current.delete(purchase.reference)
    return null
  }, [])

  // Asks the gateway to turn the settled payment into the purchase. Kept apart from pay() because a
  // payment already made has to be retryable on its own, without paying again.
  //
  // It asks only while the record still holds this payment's proof (notHeld): the recovery sweep shares
  // the record and may have given it up or cleared it since the payment went on screen, after which the
  // gateway has nothing more to say about it here. A year the sweep delivered meanwhile shows as
  // delivered, and anything else goes on as a released slot, whose answer is false. A read that fails
  // confirms nothing and takes the screen as unread. Every other way answers true, the payment, its
  // delivery or the record having taken the screen. A line its answer leaves goes under the scope read
  // as the question starts, so a switch or a forget while it is out never moves it, and every mark,
  // release or clear of the record it leads to goes to that scope's wallet, so a switch never moves
  // those either. A Pay hands over the scope its press read (`pressed`), since its question starts
  // after a send a switch may have overtaken; the record is then read in that wallet's slot too, where
  // the Pay filed it.
  const settle = useCallback(
    async (purchase: PendingPurchase, pressed?: LineScope): Promise<boolean> => {
      const scope = pressed ?? activeScope()
      const recordOf = pressed?.walletId ?? undefined
      let granted
      try {
        const d = await deps()
        const off = await notHeld(purchase, recordOf)
        if (off !== null) {
          return off
        }
        granted = await confirmDomain(d, purchase.host, purchase.reference)
      } catch (err) {
        // Paid and answered for good. A year's refusal carries no `final`, so it reads as one a person
        // sorts out unless the answer says its sats came back or its year was bought before. The
        // screen stays on the payment either way, and the proof stays while sats are still owed.
        const paidLine = paidRefusal(err)
        if (paidLine !== undefined) {
          if (paidLine === 'coming') {
            setAwaiting({ ...purchase, line: 'waiting' })
            await onAskedWallet(scope, walletId => recordPurchaseRefusal(purchase.reference, false, undefined, walletId))
            return true
          }
          // An answer that releases the slot gives it up, with the quote it paid, so the next opening
          // offers a fresh quote and asks nothing more about this charge. Its line is said here only
          // once this screen claimed the reference (sayOnce), so a line the sweep's card already has
          // is not said twice; one heard after the screen closed is kept for the first view that takes
          // it. Either comes before the slot is given up, so a crash between them leaves the proof,
          // whose next confirmation hears the same answer.
          if (releases(paidLine, err)) {
            setQuote(prev => (prev?.reference === purchase.reference ? null : prev))
            const line = { kind: 'tier', reference: purchase.reference, answer: paidLine, subject: purchase.host } as const
            // Read as the answer lands: a screen open then claims the line, and one closed then keeps it.
            const heardOpen = seen()
            const on = await scope
            if (heardOpen) {
              await sayOnce(line, on, {
                onScreen: seen,
                show: () => setAwaiting({ ...purchase, line: paidLine, released: true }),
                passOver: () => {
                  setAwaiting(prev => (prev?.reference === purchase.reference ? null : prev))
                  // The paid quote went with the slot, so a first purchase goes back to the form,
                  // where a fresh quote starts.
                  if (renewHost === null) {
                    setStep(prev => (prev === 'pay' ? 'domain' : prev))
                  }
                },
              })
            } else {
              await noteLine(line, on)
            }
            await onAskedWallet(on, walletId => releasePendingPurchase(purchase.reference, paidLine, walletId))
            return true
          }
          setAwaiting({ ...purchase, line: paidLine })
          await onAskedWallet(scope, walletId => recordPurchaseRefusal(purchase.reference, true, paidLine, walletId))
          return true
        }
        // A failure that says nothing about the payment, the question's own or the identity read's
        // before it, ends the asking and leaves what the last answer said while the record, read again
        // now, still holds the proof. Gone from it, no line says the payment completes later and the
        // screen goes the way the proof left. How it left never decides that the wait goes: one heard
        // before a Pay filed the same quote again says nothing of the proof that Pay wrote.
        setAwaiting(prev => (prev?.line === 'asking' ? { ...prev, line: 'waiting' } : prev))
        const off = await notHeld(purchase, recordOf)
        if (off !== null) {
          return off
        }
        throw err
      }
      if (granted) {
        const year = granted
        await onAskedWallet(scope, walletId => clearGrantedPurchase(purchase.reference, year, walletId))
        setAwaiting(null)
        setUnknownPay(null)
        // Carries the host it was granted for, never the one on screen, because a purchase
        // recovered from disk can name a different domain, and the sentence that follows names one
        // of them.
        setRenewal({ ...granted, host: purchase.host })
        setStep('dns')
        return true
      }
      // Not an error and not a dead end, since the payment has not been seen yet. It takes the
      // screen over instead of sitting under the price, because a price still on offer beside a
      // payment that is landing is the second invoice waiting to be minted.
      setAwaiting({ ...purchase, line: 'waiting' })
      return true
    },
    [deps, notHeld, renewHost, seen],
  )

  // Puts a payment owed on screen and asks the gateway about it. Until it answers, the line says
  // nothing the gateway has not said, since a payment it refuses for good would otherwise read as
  // coming, and what it last said is on the proof. Answers as settle does, false when the proof had
  // left the record before the question. A Pay names the scope its press read, as settle takes it.
  const askAbout = useCallback(
    async (purchase: PendingPurchase, pressed?: LineScope): Promise<boolean> => {
      setAwaiting({ ...purchase, line: lastSaid(purchase, 'asking') })
      return settle(purchase, pressed)
    },
    [settle],
  )

  // Every road to a price runs through here first. One file holds the buyer's only reference, so a
  // second invoice minted while the first payment is still landing ends with its reference written
  // over the first one's, and the money that already left has nothing pointing back at it. The
  // answer to "I paid and it has not arrived" is finishing that payment, never a fresh price. The
  // file is read rather than the state on screen, since this is the decision that mints. Answers
  // whether the file took the screen: a payment owed, or a file that cannot be read, torn or refused
  // by the platform, which may be that payment and leaves no price or line beside it. A payment whose
  // proof left the record before it was asked about takes nothing, and the press goes on to its price.
  const owed = useCallback(async (): Promise<boolean> => {
    let pending: PendingPurchase | null
    try {
      pending = await loadPendingPurchase()
    } catch {
      setUnread(true)
      return true
    }
    if (!pending) {
      return false
    }
    return askAbout(pending)
  }, [askAbout])

  // A failure before any payment says so only while no payment is on record. The recovery files one
  // at any time, so the slot is read again first, and a payment it holds takes the screen instead,
  // since a line that nothing was charged would sit beside money already sent.
  const sayUnlessOwed = useCallback(async (line: string): Promise<void> => {
    let owedNow: PendingPurchase | null
    try {
      owedNow = await loadPendingPurchase()
    } catch {
      // A record that cannot be read, torn or refused by the platform, may be that payment, so no
      // line is said beside it.
      setUnread(true)
      return
    }
    if (owedNow) {
      setAwaiting({ ...owedNow, line: lastSaid(owedNow, 'waiting') })
      return
    }
    setError(line)
  }, [])

  // The one press offered while a payment is owed. It asks the gateway again, over the same path
  // the screen already takes on mount, so nothing left on this side of a payment can mint.
  const check = async (purchase: PendingPurchase): Promise<void> => {
    const token = take()
    if (token === null) {
      return
    }
    try {
      await settle(purchase)
    } catch (err) {
      setError(reason(t, (err as Error).message, renewHost !== null, true))
    } finally {
      release(token)
    }
  }

  // Reaching this screen in renew mode is itself the press of "Renew for one year", which is why
  // the invoice is minted here and not on the screen that offers it: quoteDomain takes a hold and
  // mints a real invoice, and doing that on focus would charge the treasury for every owner who
  // merely looked at their own address.
  const startRenewal = useCallback(
    async (renewing: string): Promise<void> => {
      const token = take()
      if (token === null) {
        return
      }
      // Whether a payment is owed, null until the file answered and any payment it holds was asked
      // about. A failure before that may sit beside money already sent.
      let owes: boolean | null = null
      try {
        owes = await owed()
        if (owes) {
          return
        }
        const d = await deps()
        // The claim answers which renewal line is true and nothing else. The gateway grants it only
        // while the paid year has not ended and refuses a lapsed year with `domain_tier_not_paid`
        // before it can reach a hostname, so a live domain claims and a lapsed one does not. It
        // must not route here the way a first purchase does, or an onboarded domain would send its
        // owner back to DNS steps instead of selling the year they came for. Run alongside the
        // quote so it costs no waiting, and any other failure leaves the line unsaid rather than
        // guessed.
        const claimed = claimDomain(d, renewing).then(
          () => true,
          (err: Error) => (err.message === 'domain_tier_not_paid' ? false : null),
        )
        // The store's price is already on screen and the store holds nothing until the owner pays.
        if (store) {
          const live = await claimed
          setLapsed(live === null ? null : !live)
          return
        }
        const [live, priced] = await Promise.all([claimed, quoteDomain(d, renewing)])
        setLapsed(live === null ? null : !live)
        setQuote(priced)
      } catch (err) {
        // On a store build only the claim's line was at stake, which stays unsaid (rule 7). A payment
        // the file holds is never told it did not go through, and a file that cannot be read takes
        // the screen.
        if (isUnreadableFile(err)) {
          setUnread(true)
        } else if (owes === null) {
          setError(reason(t, (err as Error).message, true, true))
        } else if (!store) {
          await sayUnlessOwed(reason(t, (err as Error).message, true))
        }
      } finally {
        release(token)
      }
    },
    [deps, owed, release, sayUnlessOwed, store, t, take],
  )

  // A purchase left unfinished by a crash, a backgrounded app, or a lost network in the seconds
  // after paying. Picked up before anything else, so nobody is quoted a second invoice for something
  // they already paid for, renewals included.
  useEffect(() => {
    loadPendingPurchase()
      .then(
        pending => {
          if (pending) {
            // The stored value is the full host, so it is split apart rather than fed into the root
            // field: recombining it with the subdomain yields pay.pay.shop.com.
            //
            // Which half it splits into comes from what the buyer chose, not from the shape of the
            // host, which cannot answer it: `shop.com.br` and `pay.shop.com` both have three labels,
            // and counting them calls the first a subdomain `shop` sitting on `com.br`. The count is
            // kept only for a record written before the choice was stored.
            //
            // No screen shows these two, because setAwaiting below takes the screen with what is
            // owed, and a payment the gateway has seen moves straight to the DNS step, which reads
            // the gateway's own isRoot. They are set right because the moment anything offers a way
            // back to this form, a wrong one is what the buyer would edit.
            restoreHost(pending.host, pending.isRoot)
            // Set before the gateway is asked, so a confirmation that cannot be reached at all still
            // leaves a payment owed on screen rather than a price. One whose proof left the record before
            // it was asked about goes on as a mount that read none, taking a line kept for it; the store's
            // book is read once the wait is dropped, below.
            return askAbout(pending).then(
              held => (held ? undefined : showKept()),
              () => undefined,
            )
          }
          return showKept().then(() => resume(seq.current))
        },
        () => {
          // Nothing reads the store's book or the renewal's claim after this, so nothing is sold. A
          // torn file and a read the platform refused alike may hold a payment owed.
          setUnread(true)
        },
      )
      .catch(() => undefined)
    // Runs once on mount; askAbout closes over settle and deps, which are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // A line an answer left while no view could show it, taken and said here once on mount, with no
  // question to the gateway, and the slot of its reference given up as shown, which a crash between
  // keeping the line and giving the slot up may have left. A screen gone while it was taken puts it
  // back for the next view, on the wallet it was taken from. The store order resume runs after it all
  // the same.
  async function showKept(): Promise<void> {
    const scope = await activeScope()
    const kept = await takeLine('tier', scope)
    if (kept === null) {
      return
    }
    if (!seen()) {
      await putBack(kept, scope)
      return
    }
    // A line names no amount, and a final line offers nothing that reads one: Check again, the one
    // press that does, is offered only while an answer is awaited.
    setAwaiting({ host: kept.subject, reference: kept.reference, amountSats: 0, line: kept.answer, released: true })
    await onAskedWallet(scope, walletId => releasePendingPurchase(kept.reference, kept.answer, walletId))
  }

  // A mount that took a payment owed never read the store's book, so a store build keeps Pay and
  // Continue off (`resumed`). Once that payment's wait is dropped, the book is read as an open with no
  // proof reads it, which gives them back. A sats build has nothing to read there, and its renewal is
  // quoted on the next press rather than minted by a drop nobody pressed for.
  useEffect(() => {
    if (steppedOff > 0 && !resumed) {
      resume(seq.current).catch(() => undefined)
    }
    // Runs when a wait is dropped; resume reads only the book, the refs and the route.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [steppedOff])

  // Read once the screen opens rather than at the quote, since the quote takes a hold on the domain
  // and somebody still deciding must not have to reserve one to learn the price.
  useEffect(() => {
    if (store) {
      loadProducts(['domain_year'])
        .then(found => setStorePrice(found[0]?.displayPrice ?? 'unavailable'))
        .catch(() => setStorePrice('unavailable'))
      return
    }
    deps()
      .then(d => fetchPrices(d.gatewayUrl))
      .then(book => setTierCents(book.domain_tier ?? null))
      .catch(() => setTierCents(null))
  }, [deps, store])

  const startPurchase = async (): Promise<void> => {
    if (!host) {
      return
    }
    const token = take()
    if (token === null) {
      return
    }
    seq.current += 1
    let owes: boolean | null = null
    try {
      owes = await owed()
      if (owes) {
        return
      }
      // An unsettled order of the host the form names is shown in place of a claim and a second
      // order, whichever screen opened it (rule 3). The book and the store's list answer for it here.
      if (store) {
        const held = (await storeOrderViews('tier', host)).find(order => order.outcome.kind !== 'delivered' && shownHere(order, true))
        if (held && (await showOrder(held))) {
          return
        }
      }
      const d = await deps()
      // A claim first, so a domain already paid for skips straight to the DNS step instead of being
      // quoted again. Its refusal is not empty: the gateway answers it with what it measured about
      // the domain, and that is the only moment before the money where those facts exist.
      let facts: DomainFacts = {}
      let refusal = null as string | null
      const current = await claimDomain(d, host).catch(err => {
        facts = factsOf(err)
        refusal = (err as Error)?.message ?? ''
        return null
      })
      if (current) {
        setStatus(current)
        setStep('dns')
        return
      }
      // Said once, before paying, and it does not stand in the way of a second press. Somebody whose
      // root already answers is not making a mistake, they are missing a fact, and a year bought on a
      // root that carries their site is the one outcome here that cannot be undone by going back.
      if (place === 'root' && facts.rootOccupied === true && !rootBusyTold) {
        setRootBusyTold(true)
        return
      }
      if (store) {
        // Only the gateway's answer that the year is unpaid opens an order. Any other refusal is said
        // as it is, and a claim that never answered is an unknown, under which a year paid elsewhere
        // would be charged again (docs/store-bridge.md, rule 1).
        if (refusal !== 'domain_tier_not_paid') {
          setError(reason(t, refusal ?? '', false, false, 'store.retry'))
          return
        }
        await buyYear(host, false)
        return
      }
      setQuote(await quoteDomain(d, host))
      setStep('pay')
    } catch (err) {
      // What throws here ran before any order opened, since buyInStore answers each of its failures
      // as an outcome. A failure before the file of a payment owed answered may sit beside that
      // payment, so it never says nothing was charged; past the file a store build says only to try
      // again. A file that cannot be read takes the screen.
      if (isUnreadableFile(err)) {
        setUnread(true)
      } else if (owes === null) {
        setError(reason(t, (err as Error).message, false, true))
      } else if (store) {
        setError(t('store.retry'))
      } else {
        await sayUnlessOwed(reason(t, (err as Error).message))
      }
    } finally {
      release(token)
    }
  }

  // Two presses land in one tick before the button re-renders, and each reads a copy of `busy` that
  // still says nobody is paying. Both would dispatch the same invoice, and the send that loses the
  // race answers `failed`, which drops the proof of the one that won. A ref is read and written
  // synchronously, so the second press sees the first.
  const paying = useRef(false)

  const pay = async (): Promise<void> => {
    if (!quote || !host || busy || paying.current) {
      return
    }
    paying.current = true
    setBusy(true)
    setError(null)
    // The record is filed, promoted and dropped in the slot of the wallet the press started on, and the
    // question after the send asks under that wallet too, so a switch while the send is out never
    // leaves this wallet's record behind. A press that could not read its wallet files and sends
    // nothing, and reads as a record it cannot read.
    const pressed = await activeScope()
    const payer = pressed.walletId
    if (payer === null) {
      setUnread(true)
      paying.current = false
      setBusy(false)
      return
    }
    try {
      // Written in two steps because the proof has to survive a crash during the send and must not
      // survive one before it. Preparing moves no money and throws for the commonest reason there
      // is, too little balance, and a proof left behind by that throw stands for a payment nobody
      // made: kept, it answers every later price with a wait that never ends while telling the buyer
      // their money is on its way, and the wallet can never buy or renew a domain again.
      const purchase = {
        host,
        reference: quote.reference,
        amountSats: quote.amountSats,
        isRoot: place === 'root',
      }
      const held = await savePendingPurchase({ ...purchase, unpaid: true }, payer)
      if (held.reference !== purchase.reference) {
        // An older payment still holds the file. Paying now would leave it with no proof, so that
        // one is finished first and this price is dropped.
        await askAbout(held, pressed)
        return
      }
      let prepared
      try {
        prepared = await sparkPrepareSend(quote.invoice)
      } catch (err) {
        await clearPendingPurchase(purchase.reference, payer)
        throw err
      }
      // Checked against the balance rather than left to the send, because this send does not refuse
      // for it: preparing succeeds on an invoice the wallet cannot cover, and confirming throws
      // `SdkError.SparkError`, which names nothing. Left to the send, a renewal the balance cannot
      // cover writes a proof of payment for money that never moves and locks the wallet out of
      // buying anything again.
      //
      // Only a synced figure decides. The one stored at the last sync can be days old, so it would
      // refuse a wallet that can pay or let through one that cannot, and the second writes the proof
      // above. Without a synced figure, offline or past the wait, nothing is dispatched.
      const balance = await sparkSyncedBalanceSat().catch(() => null)
      if (balance === null) {
        await clearPendingPurchase(purchase.reference, payer)
        setError(t('useDomain.balanceUnchecked'))
        return
      }
      if (balance < prepared.amount + (prepared.fee ?? 0)) {
        await clearPendingPurchase(purchase.reference, payer)
        setError(t('errors.insufficientFunds'))
        return
      }
      // Everything up to here is knowably unpaid. From the dispatch on it is not, and the record
      // counts, so it is promoted before the send and not after it.
      //
      // The refusal is read again because this is still before the send. A write that lost the slot
      // to another purchase in the meantime means somebody's payment is owed, and sending anyway
      // takes a second amount against a record that is no longer this one's.
      const promoted = await savePendingPurchase(purchase, payer)
      if (promoted.reference !== purchase.reference) {
        await askAbout(promoted, pressed)
        return
      }
      const sent = await sparkConfirmSend(
        prepared.handle,
        undefined,
        idempotencyKeyFor(purchase.reference),
      )
      // The send's own status decides: a failed send charges nothing, and treating it as paid sends
      // the buyer to the DNS step for a purchase that never happened.
      if (sent === 'failed') {
        await clearPendingPurchase(purchase.reference, payer)
        setError(t('useDomain.payFailed'))
        return
      }
      await settle(purchase, pressed)
    } catch (err) {
      // Three refusals are answers rather than ambiguity: the wallet held too little, the invoice was
      // its own, or the invoice had lapsed. Each is decided before anything is dispatched, so the
      // record standing for a payment names one that does not exist and is dropped. Left in place it
      // survives a send that never happened and tells the buyer their money is on its way while it is
      // still theirs, which is worse than a lock out because they stop trying.
      //
      // The slot read is the pressing wallet's, where this Pay filed its record. Another wallet's,
      // active after a switch, would put that wallet's payment on screen and skip this one's drop.
      let stillOwed: PendingPurchase | null
      try {
        stillOwed = await loadPendingPurchase(payer)
      } catch {
        // A record that cannot be read, torn or refused by the platform, may be this payment or
        // another, so nothing is dropped and no line is said beside it.
        setUnread(true)
        return
      }
      // A record naming another purchase is somebody else's money and outranks this failure, whatever
      // caused it. Read before the refusals below so a slot that is not this purchase's is never
      // dropped and never hidden behind an error about this attempt.
      if (stillOwed && stillOwed.reference !== quote.reference) {
        setAwaiting({ ...stillOwed, line: lastSaid(stillOwed, 'waiting') })
        setUnknownPay(host)
        return
      }
      // Three refusals are answers rather than ambiguity: the wallet held too little, the invoice was
      // its own, or the invoice had lapsed. Each is decided before anything is dispatched, so this
      // purchase's record standing for a payment names one that does not exist. Left in place it
      // survives a send that never happened and tells the buyer their money is on its way while it is
      // still theirs, which is worse than a lock out because they stop trying.
      const code = classifyWalletError(err)
      // An exit's hold is decided before anything is dispatched too, refused in spark.ts ahead of the SDK.
      if (code === 'exitHeld' || code === 'exitHeldUnread') {
        await clearPendingPurchase(quote.reference, payer)
        setError(t(walletErrorKey(code)))
        return
      }
      if (code === 'insufficientFunds' || code === 'selfPayment' || code === 'expiredInvoice') {
        await clearPendingPurchase(quote.reference, payer)
        if (code === 'expiredInvoice') {
          // The invoice can lapse before the device clock says the quote has, so the quote is marked
          // lapsed here: the caption then says the price expired and the button asks for a new one,
          // where a generic failure would send the buyer back to Pay on the same dead invoice.
          setQuote(current => (current?.reference === quote.reference ? { ...current, expiresAt: 0 } : current))
          return
        }
        setError(reason(t, (err as Error).message))
        return
      }
      // Past those, whether the send went out is not in the error, it is on disk: the proof is
      // dropped only where nothing was dispatched. While it is there the buyer stays on the payment,
      // since the alternative is a price for a domain that may already be bought and paid for.
      if (stillOwed) {
        setAwaiting({ ...stillOwed, line: lastSaid(stillOwed, 'waiting') })
        return
      }
      setError(reason(t, (err as Error).message, false, true))
    } finally {
      paying.current = false
      setBusy(false)
    }
  }

  // Puts a stored host back into the form, split the way the buyer chose. Without that choice, as in
  // a record written before it was stored or a store order, which names only the host, the count of
  // labels decides, and either split rebuilds the same host.
  function restoreHost(full: string, isRoot?: boolean): void {
    const [first, ...rest] = full.split('.')
    const wasSub = isRoot === undefined ? rest.length >= 2 : !isRoot
    setPlace(wasSub ? 'sub' : 'root')
    if (wasSub) {
      setSubLabel(first ?? '')
    }
    setTyped(wasSub ? rest.join('.') : full)
  }

  // The gateway keeps one order for a host, whichever screen opened it (docs/store-bridge.md, rule 3).
  // An order still out with the store, a support case or a refusal shows on, and blocks, the renewal
  // of its host whichever screen opened it. The first-year form shows on open only what a first year
  // left, and a renewal's once the form names its host (`named`), so a renewal's outcome never takes
  // the form over nor blocks buying a year for another host. A delivered year blocks nothing and shows
  // only on the screen that opened its order, the DNS steps of a first year and the line of a renewal.
  const shownHere = (order: StoreOrderView, named = false): boolean =>
    order.outcome.kind === 'delivered' ? order.renewal === (renewHost !== null) : renewHost !== null || !order.renewal || named

  // What the screen shows on open, and again once a wait or a refusal is left. What a store order of
  // the year showed when its answer arrived survives a close and a restart, so a purchase still out
  // with the store or one that needs support is never bought again here. The book is on the device
  // and shows at once (I1); the store's list then takes away what the store let go, and only once it
  // has answered are Pay and Continue pressable. The list decides only a wait and a support case, so
  // it is read only when the book keeps one this screen shows, and an order the screen does not show
  // never holds its open (rule 3). With nothing kept, the renewal reads its claim. `at` is the
  // sequence this runs in.
  async function resume(at: number): Promise<void> {
    setResumed(false)
    if (store) {
      const kept = (await keptOrderViews('tier', renewHost).catch(() => [])).filter(view => shownHere(view))
      if (seq.current !== at) {
        return
      }
      const held = kept[0] ? await showOrder(kept[0], false, true) : false
      if (kept.some(view => view.outcome.kind === 'waiting' || view.outcome.kind === 'support')) {
        const order = (await storeOrderViews('tier', renewHost).catch(() => [])).find(view => shownHere(view))
        if (seq.current !== at) {
          return
        }
        if (order && (await showOrder(order, false, true))) {
          setResumed(true)
          return
        }
        if (held) {
          setStoreView(null)
        }
      } else if (held) {
        setResumed(true)
        return
      }
    }
    setResumed(true)
    if (renewHost) {
      await startRenewal(renewHost)
    }
  }

  // Shows an order as its kept outcome showed it, and answers whether anything took the screen. A
  // delivered year is the truth until the year is due again, and then the price is. `restore` is the
  // open, where the first-year form names no host until one is typed and takes the host back from the
  // order; a press shows an order of the host the form already names.
  async function showOrder(order: StoreOrderView, still = false, restore = false): Promise<boolean> {
    const { outcome, reference } = order
    if (restore && renewHost === null && outcome.kind !== 'delivered') {
      restoreHost(order.subject)
    }
    switch (outcome.kind) {
      case 'waiting':
        setStoreView({ kind: 'waiting', host: order.subject, reference, still })
        return true
      case 'support':
        setStoreView({ kind: 'support', host: order.subject, reference })
        return true
      case 'refused':
        setStoreView({ kind: 'refused', host: order.subject, reference, refusal: outcome.refusal })
        return true
      case 'delivered': {
        const due =
          outcome.expiresAt === null ||
          phaseOf({ kind: 'customer', expiresAt: outcome.expiresAt, frozenAt: null }, Math.floor(Date.now() / 1000)) !== 'fine'
        if (due) {
          await dismissStoreOutcome(reference).catch(() => undefined)
          return false
        }
        if (restore && renewHost === null) {
          restoreHost(outcome.host)
        }
        yearDelivered(reference, outcome)
        return true
      }
    }
  }

  // The delivered year, as the gateway's answer names it, takes the same road as a year paid in
  // sats, to the renewal line or to the DNS steps of a first purchase.
  function yearDelivered(reference: string, year: DeliveredYear): void {
    delivered.current = reference
    setStoreView(null)
    setRenewal({ host: year.host, expiresAt: year.expiresAt, frozen: year.frozen })
    setStep('dns')
  }

  // Opens the store for one year on `buying`. Called from inside a guarded press. An order holds the
  // host for ten minutes, so none is opened before the store has priced the year, whatever reached
  // this press. This is the only step a store that cannot price closes, and the price line already
  // says it is not available; a store still pricing says so here, since its Skeleton says nothing
  // about the press. Its outcome shows whatever was pressed since, being what the store and the book
  // now hold for the host.
  async function buyYear(buying: string, renewing: boolean): Promise<void> {
    if (!storePriced) {
      if (storePrice === null) {
        setError(t('store.stillPricing'))
      }
      return
    }
    const outcome = await buyInStore('tier', buying, undefined, renewing)
    switch (outcome.kind) {
      case 'unavailable':
        setError(t('store.unavailable'))
        return
      case 'adultsOnly':
        setError(t('ageGate.purchase'))
        return
      case 'orderRetry':
        setError(t('store.retry'))
        return
      case 'orderRefused': {
        const key = domainOrderRefusalKey(outcome.code, renewing)
        setError(key ? t(key) : reason(t, outcome.code, renewing, false, 'store.retry'))
        return
      }
      case 'failed':
        // A cancel leaves the owner where they were, and the order's hold lapses on its own.
        if (outcome.code !== 'cancelled') {
          setError(t(storeErrorKey(outcome.code) ?? 'store.retry'))
        }
        return
      case 'pending':
      case 'paidElsewhere':
        setStoreView({ kind: 'waiting', host: buying, reference: outcome.reference, still: false })
        return
      case 'settledMeanwhile': {
        // The book already holds what the sync settled, and the press shows it before it gives Pay
        // back, since a Pay pressed before the listener's own read lands would open a second order for
        // the year the sync just delivered.
        const order = (await keptOrderViews('tier', buying)).find(view => view.reference === outcome.reference)
        if (order) {
          await showOrder(order)
        }
        return
      }
      case 'settled':
        switch (outcome.result.kind) {
          case 'delivered':
            yearDelivered(outcome.reference, deliveredYearOf(buying, outcome.result.body))
            return
          case 'refused':
            setStoreView({
              kind: 'refused',
              host: buying,
              reference: outcome.reference,
              refusal: `${outcome.result.status} ${outcome.result.code}`,
            })
            return
          case 'support':
          case 'unknownOrder':
          case 'noReference':
            setStoreView({ kind: 'support', host: buying, reference: outcome.reference })
            return
          default:
            setStoreView({ kind: 'waiting', host: buying, reference: outcome.reference, still: false })
        }
    }
  }

  const buyRenewal = async (): Promise<void> => {
    if (!renewHost) {
      return
    }
    const token = take()
    if (token === null) {
      return
    }
    seq.current += 1
    let owes: boolean | null = null
    try {
      owes = await owed()
      if (owes) {
        return
      }
      await buyYear(renewHost, true)
    } catch (err) {
      // What throws here ran before any order opened, since buyInStore answers each of its failures
      // as an outcome. A failure before the file of a payment owed answered may sit beside that
      // payment, so it never says nothing was charged; past the file a store build says only to try
      // again. A file that cannot be read takes the screen.
      if (isUnreadableFile(err)) {
        setUnread(true)
      } else {
        setError(owes === null ? reason(t, (err as Error).message, true, true) : t('store.retry'))
      }
    } finally {
      release(token)
    }
  }

  // The root's sync settles purchases while the screen is open. An answer about the wait on screen
  // takes its place. A delivered year, a refusal or a support case for another order this screen shows
  // on open (rule 3) takes the place of the price or the form too, since a refusal or a support case
  // blocks a second order for the host whether or not the screen was waiting on it. A renewal's order
  // reaches the first-year form only through Continue.
  useEffect(() => {
    if (!store) {
      return
    }
    const shown = storeView
    const free = shown === null && awaiting === null && step !== 'dns'
    const named = host
    return onStoreSettled((reference, result) => {
      if (shown?.kind === 'waiting' && reference === shown.reference) {
        if (result.kind === 'delivered') {
          seq.current += 1
          yearDelivered(reference, deliveredYearOf(shown.host, result.body))
        } else if (result.kind === 'refused') {
          seq.current += 1
          setStoreView({ kind: 'refused', host: shown.host, reference, refusal: `${result.status} ${result.code}` })
        } else if (NEEDS_SUPPORT.has(result.kind)) {
          seq.current += 1
          setStoreView({ kind: 'support', host: shown.host, reference })
        }
        return
      }
      if (!free || (result.kind !== 'delivered' && result.kind !== 'refused' && !NEEDS_SUPPORT.has(result.kind))) {
        return
      }
      // A press holding the screen keeps it until it is done, so its own outcome is never the one that
      // lands last, and no way out shows beside a purchase still running.
      if (working.current !== null) {
        setHeard(prev => new Set(prev).add(reference))
        return
      }
      takeSettled(new Set([reference]), named)
    })
    // Subscribes per screen state; the handlers read only what that state carries and the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store, storeView, awaiting, step, host])

  // Answers of the root's sync about another order, heard while a press held the screen, and taken
  // once the press is done, if the screen is still on the price or the form.
  const [heard, setHeard] = useState<ReadonlySet<string>>(() => new Set())
  useEffect(() => {
    if (busy || heard.size === 0) {
      return
    }
    setHeard(new Set())
    if (storeView === null && awaiting === null && step !== 'dns') {
      takeSettled(heard, host)
    }
    // Runs when an answer is heard or a press ends; takeSettled reads only the book and the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, heard])

  // Shows the first order of `references` the book keeps settled for this screen, unless the sequence
  // moved while the book was read, and takes the line an earlier press left, which is about that press
  // and not about the order now on screen. `named` is the host the form named when the answer arrived.
  function takeSettled(references: ReadonlySet<string>, named: string | null): void {
    const at = seq.current
    keptOrderViews('tier', renewHost)
      .then(async views => {
        const order = views.find(v => references.has(v.reference) && v.outcome.kind !== 'waiting' && shownHere(v))
        if (order && seq.current === at) {
          seq.current += 1
          setError(null)
          await showOrder(order, false, named === null)
        }
      })
      .catch(() => undefined)
  }

  const checkStoreWait = async (waiting: Extract<StoreView, { kind: 'waiting' }>): Promise<void> => {
    const token = take()
    if (token === null) {
      return
    }
    const at = ++seq.current
    let cleared = false
    try {
      await syncStorePurchases(liveStoreContext())
      // The book holds whatever the sync settled, so the screen shows the order as it now stands.
      const kept = await storeOrderViews('tier', waiting.host)
      if (seq.current !== at) {
        return
      }
      const order = kept.find(o => o.reference === waiting.reference) ?? kept.find(o => shownHere(o, true))
      if (!order || !(await showOrder(order, order.reference === waiting.reference))) {
        setStoreView(null)
        cleared = true
      }
    } catch {
      // Only a book in a shape this build cannot read gets here. The line is about this check, so it
      // shows only while no Stop waiting or Close has taken the screen since the check began.
      if (seq.current === at) {
        setError(t('store.retry'))
      }
    } finally {
      release(token)
    }
    // The check read the book and the store's list for the host, which is all an open waits on before
    // it sells, so it gives the purchase press back, and the renewal still reads its line (rule 7).
    if (cleared && seq.current === at) {
      setResumed(true)
      if (renewHost) {
        await startRenewal(renewHost)
      }
    }
  }

  // Leaving a wait or a refusal takes the screen from a press still running, so the way out never
  // waits on a read that may not answer, and the open that follows reads the renewal's line under a
  // press of its own. What a Check again then reads applies nothing (I2); a purchase a press made
  // still shows, being what the store holds.
  const leave = (): number => {
    const at = ++seq.current
    working.current = null
    setBusy(false)
    return at
  }

  // What else the book keeps for this screen, or the price or the form, takes the wait's place.
  const stopStoreWait = async (waiting: Extract<StoreView, { kind: 'waiting' }>): Promise<void> => {
    const at = leave()
    await dropStoreWait(waiting.reference).catch(() => undefined)
    if (seq.current !== at) {
      return
    }
    setStoreView(null)
    await resume(at)
  }

  // Closing a refusal is the owner having read it, so what else the book keeps, or the price or the
  // form, is the truth again.
  const closeRefused = async (reference: string): Promise<void> => {
    const at = leave()
    await dismissStoreOutcome(reference).catch(() => undefined)
    if (seq.current !== at) {
      return
    }
    setStoreView(null)
    await resume(at)
  }

  // The card a mail leaves, beside the press about the same reference only.
  const supportCard = (about: string): React.JSX.Element | null => {
    const note = mail.noteFor(about)
    return note ? <SupportMailCard note={note} /> : null
  }

  const mailSupport = async (reference: string): Promise<void> => {
    const owner = await sparkGetIdentityPubkey().catch(() => '')
    const body = t('recover.mailBody', { pubkey: owner, reference })
    await mail.open(helpMailUrl(t('recover.mailSubject'), body), body, reference)
  }

  // Asking for a fresh price goes back to whichever purchase this is: a renewal must not take the
  // claim-first shortcut, which would answer with DNS steps for a record that already exists.
  const requote = (): Promise<void> => (renewHost ? startRenewal(renewHost) : startPurchase())

  const remaining = quote ? Math.max(0, quote.expiresAt - now) : 0
  const expired = quote !== null && remaining === 0

  // A live domain is only useful once addresses are issued on it. The SDK takes the domain at
  // connect, so the choice is stored and the wallet reconnected, and the steps say the address works
  // only once both answered. A first year's DNS steps have then done their work and are not shown
  // again on the next open; until then the book keeps them, so a failure is tried again on the next
  // open as well as by Try again.
  useEffect(() => {
    if (status?.state !== 'active') {
      return
    }
    let alive = true
    setAdoption('adopting')
    getActiveWalletId()
      .then(async id => {
        await setDomainFor(id ?? 'primary', status.host)
        await reconnectActiveWallet()
      })
      .then(() => {
        if (!alive) {
          return
        }
        setAdoption('adopted')
        if (renewHost === null && delivered.current !== null) {
          dismissStoreOutcome(delivered.current).catch(() => undefined)
          delivered.current = null
        }
      })
      .catch(() => alive && setAdoption('failed'))
    return () => {
      alive = false
    }
  }, [status?.state, status?.host, adoptions, renewHost])

  const target = status?.target ?? ''
  const name = status ? recordName(status.host, status.isRoot) : ''
  // What the owner is told once the money has landed. A domain that was off the edge is not working
  // again until its hostname is back with a certificate and the wallet took it, so until the poll reads
  // it active and the reconnect answered, the line says the addresses come back on their own, and a
  // year kept on the screen for months says it no longer once they did. A grant that arrived without a
  // date takes the waking line, being the one no missing field can contradict.
  const woken = status?.state === 'active' && adoption === 'adopted'
  const renewalLine =
    renewal === null
      ? ''
      : (renewal.frozen && !woken) || renewal.expiresAt === null
      ? t('useDomain.renewWaking')
      : t('useDomain.renewDone', {
          domain: renewal.host,
          date: formatDate(renewal.expiresAt, prefs),
        })
  // A field and its value through one key, so each language writes the pair with its own punctuation.
  const field = (label: string, value: string) => t('useDomain.stepLine', { label: t(label), value })
  const steps = [
    t('useDomain.stepFirst'),
    field('useDomain.stepType', 'CNAME'),
    field('useDomain.stepName', name),
    field('useDomain.stepTarget', target),
  ]

  // The check and the word replace the copy mark only on screen, so a screen reader is told as well.
  function copyStep(index: number, value: string) {
    Clipboard.setString(value)
    AccessibilityInfo.announceForAccessibility(t('useDomain.copied'))
    setCopiedStep(index)
    if (copyTimer.current) {
      clearTimeout(copyTimer.current)
    }
    copyTimer.current = setTimeout(() => setCopiedStep(null), 2000)
  }

  if (unread) {
    // A payment may be owed and nothing on the device names it, so nothing below can be pressed into
    // a claim, a quote or an order, and the one press reaches the person who can look it up by the
    // wallet's key.
    return (
      <Screen scroll layout="padded" contentStyle={styles.content}>
        <Txt role="body" tone="default">
          {t('recover.recordUnread')}
        </Txt>
        <View style={styles.actions}>
          <GradientButton
            label={t('recover.sendToSupport')}
            onPress={() => mailSupport(t('recover.mailRecordUnread'))}
          />
          {supportCard(t('recover.mailRecordUnread'))}
        </View>
      </Screen>
    )
  }

  // Said above the awaited purchase's own line and never in its place.
  const otherLine =
    unknownPay !== null ? (
      <Txt role="caption" tone="muted">
        {t('useDomain.otherPurchase', { host: unknownPay })}
      </Txt>
    ) : null

  return (
    <Screen scroll keyboard layout="padded" contentStyle={styles.content}>
      {awaiting !== null && isFinal(awaiting.line) && (
        <>
          {otherLine}
          {/* Paid, and no later confirmation changes what it came to. Nothing here says it is
              coming or offers to check again or a price; the one press, where sats are still to be
              given back, reaches the person who does it. */}
          <Txt role="label" tone="muted">
            {awaiting.host}
          </Txt>
          <Txt role="body" tone="default">
            {t(FINAL_LINE[awaiting.line], { subject: awaiting.host })}
          </Txt>
          {needsAPerson(awaiting.line) && (
            <View style={styles.actions}>
              <GradientButton label={t('recover.sendToSupport')} onPress={() => mailSupport(awaiting.reference)} />
              {supportCard(awaiting.reference)}
            </View>
          )}
        </>
      )}

      {awaiting !== null && !isFinal(awaiting.line) && (
        <>
          {otherLine}
          {/* One state, one thing to read, one thing to do. The money is gone and the price it paid
              is settled, so showing the domain question or a price again is an invitation to pay
              twice. The domain named is the one on the proof, which is not always the one this
              screen was opened for. */}
          <Txt role="label" tone="muted">
            {awaiting.host}
          </Txt>
          {awaiting.line === 'asking' ? (
            <Skeleton height={font.leading.base} />
          ) : (
            <Txt role="body" tone="default">
              {t('useDomain.settling')}
            </Txt>
          )}
          <View style={styles.actions}>
            <GradientButton
              label={t('receive.lnCheckAgain')}
              onPress={() => check(awaiting)}
              loading={busy}
            />
          </View>
        </>
      )}

      {awaiting === null && storeView?.kind === 'waiting' && (
        <>
          <Txt role="label" tone="muted">
            {storeView.host}
          </Txt>
          <Txt role="bodyStrong" tone="default">
            {t('store.waitingTitle')}
          </Txt>
          <Txt role="body" tone="default">
            {t('store.waitingBody', { name: storeView.host })}
          </Txt>
          {storeView.still && (
            <Txt role="caption" tone="muted">
              {t('store.notYet')}
            </Txt>
          )}
          <View style={styles.actions}>
            <GradientButton
              label={t('receive.lnCheckAgain')}
              onPress={() => checkStoreWait(storeView)}
              loading={busy}
            />
            <GradientButton
              variant="secondary"
              label={t('store.stopWaiting')}
              onPress={() => stopStoreWait(storeView)}
            />
          </View>
        </>
      )}

      {awaiting === null && storeView?.kind === 'refused' && (
        <>
          <Txt role="label" tone="muted">
            {storeView.host}
          </Txt>
          <Txt role="bodyStrong" tone="default">
            {t('store.refusedTitle')}
          </Txt>
          <Txt role="body" tone="default">
            {t(storeRefusedKey(storeView.refusal, currentStore()))}
          </Txt>
          <View style={styles.actions}>
            <GradientButton
              variant="secondary"
              label={t('common.close')}
              onPress={() => closeRefused(storeView.reference)}
            />
          </View>
        </>
      )}

      {awaiting === null && storeView?.kind === 'support' && (
        <>
          <Txt role="label" tone="muted">
            {storeView.host}
          </Txt>
          <Txt role="body" tone="default">
            {t('store.support')}
          </Txt>
          <View style={styles.actions}>
            <GradientButton
              label={t('recover.sendToSupport')}
              onPress={() => mailSupport(storeView.reference)}
            />
            {supportCard(storeView.reference)}
          </View>
        </>
      )}

      {awaiting === null && storeView === null && step === 'domain' && (
        <>
          <Field
            value={typed}
            onChangeText={setTyped}
            label={t('useDomain.domainLabel')}
            error={typed.length > 0 && !root ? t('useDomain.notADomain') : undefined}
            placeholder={t('useDomain.domainPlaceholder')}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />

          {root && (
            <>
              <View style={styles.section}>
                <Txt role="label" tone="muted">
                  {t('useDomain.placeLabel')}
                </Txt>

              {/* Neither choice flashes under a finger, since a card that is also a target changes only
                  when it is chosen. Both places are shown as addresses rather than as settings, since the
                  address is the thing being bought and the only part of this the customer will ever see
                  again. Each carries what it costs them, because choosing the root without being told the
                  domain stops serving anything else is how somebody takes their own site down. */}
                <Touch
                  onPress={() => setPlace('root')}
                  feedback="none"
                  role="radio"
                  state={{ selected: place === 'root' }}
                  style={[styles.choice, place === 'root' && styles.choiceOn]}>
                  <Txt role="bodyStrong" tone="default">
                    {`${t('useDomain.sampleName')}@${root}`}
                  </Txt>
                  <Txt role="caption" tone="muted">
                    {t('useDomain.placeRootNote')}
                  </Txt>
                  {place === 'root' && <ChosenMark />}
                </Touch>

                <Touch
                  onPress={() => setPlace('sub')}
                  feedback="none"
                  role="radio"
                  state={{ selected: place === 'sub' }}
                  style={[styles.choice, place === 'sub' && styles.choiceOn]}>
                  <Txt role="bodyStrong" tone="default">
                    {`${t('useDomain.sampleName')}@${subLabel || DEFAULT_SUBDOMAIN}.${root}`}
                  </Txt>
                  <Txt role="caption" tone="muted">
                    {t('useDomain.placeSubNote')}
                  </Txt>
                  {place === 'sub' && <ChosenMark />}
                </Touch>

                {place === 'sub' && (
                  <Field
                    value={subLabel}
                    onChangeText={text =>
                      setSubLabel(text.replace(/[^a-zA-Z0-9-]/g, '').toLowerCase())
                    }
                    label={t('useDomain.subdomainLabel')}
                    placeholder={DEFAULT_SUBDOMAIN}
                    autoCapitalize="none"
                    autoCorrect={false}
                    style={styles.block}
                  />
                )}
              </View>

              {/* Offered rather than warned. Somebody whose root serves a site is not making a
                  mistake, they are missing a fact, and the way to keep both is real but lives with
                  whoever runs their site, so the app hands it over instead of teaching it. */}
              {place === 'root' && (
                <>
                  <GradientButton
                    label={t('useDomain.rootHaveSite', { domain: root })}
                    variant="secondary"
                    icon={<TabIcon name="help" color={colors.text} size={18} />}
                    onPress={() => setSiteHelp(v => !v)}
                  />
                  {siteHelp && (
                    <Notice>
                      <Txt role="caption" tone="default">
                        {t('useDomain.rootBothPossible')}
                      </Txt>
                      <Txt role="caption" tone="default">
                        {t('useDomain.rootBothOrSub')}
                      </Txt>
                    </Notice>
                  )}
                </>
              )}

              {/* The root is not offered as a choice that might fail. Whether it can work at all is
                  the provider's answer, and it only arrives with the first claim. */}
              {status?.supportsRoot === false && place === 'root' && (
                <Txt role="caption" tone="danger">
                  {t('useDomain.rootUnsupported')}
                </Txt>
              )}

              {/* The same two sentences the DNS step shows, moved to the side of the decision where
                  they still change it. There the customer has already bought the year; here the
                  button underneath is the one that spends it, and pressing it again goes through. */}
              {rootBusyTold && (
                <Notice>
                  <Txt role="caption" tone="default">
                    {t('useDomain.occupied', { host: root })}
                  </Txt>
                  <Txt role="caption" tone="default">
                    {t('useDomain.occupiedWayOut', { suggestion: `${DEFAULT_SUBDOMAIN}.${root}` })}
                  </Txt>
                </Notice>
              )}
              <View style={styles.section}>
                {store ? (
                  <StorePriceLine price={resumed ? storePrice : null} />
                ) : (
                  tierCents !== null && (
                    <Figure role="heading" tone="default">
                      {t('useDomain.priceLine', { price: formatFiat(tierCents / 100, 'USD') })}
                    </Figure>
                  )
                )}
                <Txt role="caption" tone="muted">
                  {t('useDomain.priceWhy')}
                </Txt>
                <Txt role="caption" tone="muted">
                  {t(payLineKey(store ? currentStore() : 'sats'))}
                </Txt>
              </View>
              <View style={styles.actions}>
                <GradientButton
                  label={t('useDomain.continue')}
                  onPress={startPurchase}
                  loading={busy}
                  disabled={!host || !resumed}
                />
              </View>
            </>
          )}
        </>
      )}

      {awaiting === null && storeView === null && step === 'pay' && (quote !== null || renewHost !== null) && (
        <>
          <Txt role="label" tone="muted">
            {quote?.host ?? renewHost}
          </Txt>
          {/* Renewing before the year runs out loses none of the days already paid for, and an owner
              who does not know that waits for the last day. It sits above the price because it is
              what makes paying today reasonable. */}
          {renewHost !== null && lapsed !== null && (
            <Txt role="caption" tone="muted">
              {t(lapsed ? 'useDomain.renewLate' : 'useDomain.renewEarly')}
            </Txt>
          )}
          {store && <StorePriceLine price={resumed ? storePrice : null} />}
          {!store && quote !== null && (
            <>
              <Figure role="heading" tone="default">
                {t('useDomain.amountSats', { amount: formatSats(quote.amountSats) })}
              </Figure>
              {/* The price is anchored in dollars and charged in sats, so the sats figure is only
                  good while the quote is. Saying so beats letting somebody pay an invoice that
                  already lapsed and then be told the purchase did not take. */}
              <Txt role="caption" tone={expired ? 'danger' : 'muted'}>
                {expired
                  ? t('useDomain.quoteExpired')
                  : t('useDomain.quoteValidFor', { time: countdown(remaining, i18n.language) })}
              </Txt>
            </>
          )}
          <Txt role="caption" tone="muted">
            {t('useDomain.priceWhy')}
          </Txt>
          <Txt role="caption" tone="muted">
            {t(payLineKey(store ? currentStore() : 'sats'))}
          </Txt>
          <View style={styles.actions}>
            {store ? (
              <GradientButton
                label={t('useDomain.pay')}
                onPress={buyRenewal}
                disabled={!storePriced || !resumed}
                loading={busy}
              />
            ) : (
              <GradientButton
                label={payLabel(t, quote !== null, expired, busy)}
                onPress={() =>
                  (quote !== null && !expired ? pay() : requote()).catch((err: Error) =>
                    setError(reason(t, err.message, renewHost !== null)),
                  )
                }
                loading={busy}
              />
            )}
          </View>
        </>
      )}

      {step === 'dns' && renewHost !== null && (
        <>
          <Txt role="body" tone="default">
            {renewalLine}
          </Txt>
          {/* A renewal shows no DNS steps, since the record already exists and still points where
              it should. The poll behind this line is the fastest thaw available, since a paid year
              lets the claim past the gateway's tier gate and on to ensure(), which puts the hostname
              back. Only a domain that was off the edge has anything left to report. */}
          {renewal?.frozen === true && (
            <StatusLine
              status={status}
              target={target}
              note={statusNote}
              onCheck={pollAgain}
              quiet
              adoption={adoption}
              onAdopt={() => setAdoptions(n => n + 1)}
            />
          )}
        </>
      )}

      {step === 'dns' && renewHost === null && (
        <>
          <Txt role="subheading" tone="default">
            {t('useDomain.stepsTitle')}
          </Txt>
          <Txt role="caption" tone="muted">
            {status && providerName(status.provider)
              ? t('useDomain.stepsIntroNamed', { provider: providerName(status.provider) })
              : t('useDomain.stepsIntro')}
          </Txt>

          {/* Above the steps rather than below, because it changes whether they should follow them
              at all. A domain with a site on it loses the site to this record, and the customer is
              the only one who knows whether that address is in use. */}
          {status?.occupied === true && (
            <Notice>
              <Txt role="caption" tone="default">
                {t('useDomain.occupied', { host })}
              </Txt>
              <Txt role="caption" tone="default">
                {t('useDomain.occupiedWayOut', { suggestion: `pay.${host}` })}
              </Txt>
            </Notice>
          )}

          <Card gap="md" style={styles.block}>
            {steps.map((line, index) =>
              // Only the last two copy anything. A Pressable with role="text" and an onPress that does
              // nothing is the code saying it is not a target, so the branch is split rather than given a
              // prop: as one <Touch> the first two would grow from 24 to 44, taking the whole card up by 40,
              // would light up under a finger while doing nothing, and would join the accessibility count as
              // two targets announcing "text".
              index >= 2 ? (
                <Touch
                  key={line}
                  onPress={() => copyStep(index, index === 2 ? name : target)}
                  feedback="row"
                  style={styles.stepRow}>
                  {/* Monospaced, since whoever types it into a DNS panel reads it character by character. */}
                  <Txt role="caption" tone="default" style={[styles.stepText, styles.mono]}>
                    {line}
                  </Txt>
                  {copiedStep === index && (
                    <Txt role="micro" tone="accent">
                      {t('useDomain.copied')}
                    </Txt>
                  )}
                  <TabIcon
                    name={copiedStep === index ? 'check' : 'copy'}
                    color={copiedStep === index ? accent : colors.textSecondary}
                    size={14}
                  />
                </Touch>
              ) : (
                <Row key={line} gap="sm" style={styles.stepRow}>
                  <Txt role="caption" tone="default" style={styles.stepText}>
                    {line}
                  </Txt>
                </Row>
              ),
            )}
          </Card>

          {status?.provider === 'cloudflare' && (
            <Txt role="label" tone="default">
              {t('useDomain.noteCloudflare')}
            </Txt>
          )}

          {/* Only where the target is known, and only to somebody the gateway says is standing on an
              occupied name: this is the one way to keep a site and the address on the same root, and
              it is the site's owner who has to do it, not us. */}
          {status?.occupied === true && (
            <GradientButton
              label={t('useDomain.sendSiteNote')}
              variant="secondary"
              icon={<TabIcon name="share" color={colors.text} size={18} />}
              onPress={() =>
                Share.share({
                  message: t('useDomain.siteNote', { domain: status.host, target }),
                }).catch(() => undefined)
              }
            />
          )}

          {/* The owner of a shop does not touch DNS, they forward this to whoever runs their site.
              Without a way to forward it, that is where the process stops. */}
          <GradientButton
            label={t('useDomain.sendSteps')}
            variant="secondary"
            icon={<TabIcon name="share" color={colors.text} size={18} />}
            onPress={() =>
              Share.share({ message: `${t('useDomain.stepsTitle')}\n\n${steps.join('\n')}` }).catch(
                () => undefined,
              )
            }
          />

          <StatusLine
            status={status}
            target={target}
            note={statusNote}
            onCheck={pollAgain}
            adoption={adoption}
            onAdopt={() => setAdoptions(n => n + 1)}
          />
          {status?.state === 'active' && adoption === 'adopted' && (
            <Txt role="caption" tone="muted">
              {t('useDomain.proof')}
            </Txt>
          )}
        </>
      )}

      {/* A failure beside a refusal for good is about a read that said nothing of the payment, and
          its line would say the app still finishes it. */}
      <ErrorBox message={awaiting !== null && isFinal(awaiting.line) ? null : error} style={styles.error} />
    </Screen>
  )
}

// What the latest poll of the DNS steps read. Before any poll answers it is a Skeleton, since saying
// the record has not shown up would claim a read nobody made. A poll that did not answer, or that the
// gateway refused, says only that in place of the status an earlier poll read, with a way to read
// again, so a stale status never sits beside it. An active domain says the address works only once
// the wallet took it (`adoption`), and says so with Try again when it could not.
function StatusLine({
  status,
  target,
  note,
  onCheck,
  quiet = false,
  adoption,
  onAdopt,
}: {
  status: OnboardStatus | null
  target: string
  note: string | null
  onCheck: () => void
  // The renewal's line, which sits under the line about the new year.
  quiet?: boolean
  adoption?: 'adopting' | 'adopted' | 'failed' | null
  onAdopt?: () => void
}): React.JSX.Element {
  const { t } = useTranslation()
  if (note !== null) {
    return (
      <>
        <Txt role="body" tone="default">
          {t(note)}
        </Txt>
        <GradientButton label={t('receive.lnCheckAgain')} onPress={onCheck} />
      </>
    )
  }
  if (status?.state === 'active' && adoption !== undefined && adoption !== 'adopted') {
    return adoption === 'failed' ? (
      <>
        <Txt role="body" tone="default">
          {t('useDomain.adoptFailed')}
        </Txt>
        <GradientButton label={t('common.retry')} onPress={() => onAdopt?.()} />
      </>
    ) : (
      <Txt role="body" tone="default">
        {t('useDomain.adopting')}
      </Txt>
    )
  }
  return status !== null ? (
    <Txt role={quiet ? 'caption' : 'body'} tone={quiet ? 'muted' : 'default'}>
      {statusLine(t, status, target)}
    </Txt>
  ) : (
    <Skeleton width="70%" height={font.leading.base} />
  )
}

// The store's price for a year, in the owner's currency. A store this device cannot reach says so
// rather than showing a price nobody can pay.
// Callers pass null until the screen has resumed, the same gate that keeps Pay and Continue hidden,
// so a price never shows with no button to buy it.
function StorePriceLine({ price }: { price: string | 'unavailable' | null }): React.JSX.Element {
  const { t } = useTranslation()
  if (price === null) {
    return <Skeleton width="40%" height={font.leading.base} />
  }
  if (price === 'unavailable') {
    return (
      <Txt role="caption" tone="muted">
        {t('store.unavailable')}
      </Txt>
    )
  }
  return (
    <Figure role="heading" tone="default">
      {t('useDomain.priceLine', { price })}
    </Figure>
  )
}

// In the language's digits, as the word grid numbers its cells.
function countdown(seconds: number, language: string): string {
  const m = new Intl.NumberFormat(language).format(Math.floor(seconds / 60))
  const s = new Intl.NumberFormat(language, { minimumIntegerDigits: 2 }).format(seconds % 60)
  return `${m}:${s}`
}

// Never blames the customer, and always says the next thing. `awaiting_dns` and `wrong_target` are
// kept apart on purpose: telling somebody to keep waiting for something that will never happen is
// the worse of the two failures.
function statusLine(
  t: (key: string, options?: Record<string, unknown>) => string,
  status: OnboardStatus | null,
  target: string,
): string {
  switch (status?.state) {
    case 'active':
      return t('useDomain.active')
    case 'awaiting_certificate':
      return t('useDomain.certificate')
    case 'wrong_target':
      return t('useDomain.wrongTarget', { target })
    case 'root_unsupported':
      return t('useDomain.rootUnsupported')
    default:
      return t('useDomain.waiting')
  }
}

// The button names what the next press does, and there are only three things that can be: ask for a
// price, pay the one on screen, or wait on a payment already sent. While the first price is still
// being minted it promises the payment it is about to offer, since offering a new price for one
// nobody has seen yet reads as something having failed.
function payLabel(
  t: (key: string) => string,
  priced: boolean,
  expired: boolean,
  busy: boolean,
): string {
  if (!priced) {
    return busy ? t('useDomain.pay') : t('useDomain.requote')
  }
  if (expired) {
    return t('useDomain.requote')
  }
  return busy ? t('useDomain.paying') : t('useDomain.pay')
}

// Anything unrecognised gets the general message rather than being shown raw: a server string is
// untranslated, written for an operator, and reads as though the app broke.
// `spent` is what the caller knows about the money, and it decides only the last line. Refusals
// reached before anything is dispatched can say nothing was charged, which is worth saying; past the
// invoice they cannot, and an unrecognised code is exactly where that is easiest to get wrong.
// `fallback` replaces the sats wording for a code this screen does not know, where no payment was made.
// A paid refusal never arrives here, since settle is the one reader of the confirmation and reads it
// whole, `final` included.
function reason(
  t: (key: string) => string,
  code: string,
  renewing = false,
  spent = false,
  fallback?: string,
): string {
  const known: Record<string, string> = {
    not_a_domain: 'useDomain.notADomain',
    custom_domains_not_configured: 'useDomain.waiting',
    domain_belongs_to_another_wallet: 'useDomain.domainTaken',
    // Held by somebody mid-purchase, not owned by them. It clears on its own, which the general
    // failure text gives no reason to believe. Renewing is the exception: the gateway refuses a
    // domain held by another wallet before its renewal quote ever reaches the hold, so the hold in
    // the way belongs to this owner's own unsettled quote, and telling them a stranger is buying
    // their domain would frighten them for nothing.
    'domain is being bought by someone else': renewing
      ? 'useDomain.renewalInProgress'
      : 'useDomain.domainBeingBought',
    // The shop is shut, not the domain refused. Blaming the customer for an outage sends somebody
    // trying to pay for a dead domain away thinking they did something wrong.
    treasury_unavailable: 'receive.lnShopClosed',
    // Names the missing tier, so somebody buying an address on a domain they have not paid for is
    // told what to buy rather than that their payment failed.
    domain_tier_not_paid: 'useDomain.tierNotPaid',
    // Refused on this device before anything is asked: the address was given up here, and a purchase
    // waits for "Create the address again".
    address_removed: 'receive.lnOffBuy',
  }
  if (known[code]) {
    return t(known[code]!)
  }
  console.warn('domain onboarding refused:', code)
  return t(fallback ?? (spent ? 'useDomain.confirmFailed' : 'useDomain.payFailed'))
}

const CHOSEN_MARK = 20

// The check on the chosen place, since the fill alone would leave colour as the only sign of the
// choice. It keeps the Bitcoin orange in dollar mode, as the fill under it does.
function ChosenMark(): React.JSX.Element {
  return (
    <View style={styles.chosenMark}>
      <TabIcon name="check" color={colors.primary} size={CHOSEN_MARK} strokeWidth={2.5} />
    </View>
  )
}

const styles = StyleSheet.create({
  // What belongs together sits at the group's 8, and each section and action sets itself apart.
  content: { gap: space.sm },
  section: { gap: space.sm, marginTop: rhythm.section - space.sm },
  block: { marginTop: rhythm.section - space.sm },
  actions: { gap: space.md, marginTop: rhythm.groupToAction - space.sm },
  // Room at the end for the check, held by both so choosing does not rewrap the address.
  choice: {
    gap: space.xs,
    padding: space.lg,
    paddingEnd: space.lg + CHOSEN_MARK + space.sm,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderCurve: 'continuous',
  },
  choiceOn: primarySoftSurface,
  chosenMark: {
    position: 'absolute',
    top: space.lg,
    end: space.lg,
  },
  stepRow: { minHeight: font.leading.base, flexDirection: 'row', alignItems: 'center', gap: space.sm },
  // Only the stretch, so the line pushes the copy icon to the end.
  stepText: { flex: 1 },
  mono: { fontFamily: font.mono },
  error: {
    marginTop: space.md,
  },
})
