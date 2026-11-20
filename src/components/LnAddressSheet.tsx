import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Keyboard, ScrollView, StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import {
  sparkCheckLnAddress,
  sparkConnectedWalletId,
  sparkGetIdentityPubkey,
  sparkGetLnAddress,
  sparkRegisterLnAddress,
  type SparkLnAddress,
} from '../wallet/spark'
import { normalizeUsername, validateUsername } from '../wallet/lnaddress'
import { confirmName, currentDeps, currentDomain, quoteName, type NameQuote, type RefusalError } from '../wallet/namePurchase'
import { formatSats } from '../wallet/amount'
import { clearsAt } from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import {
  DISOWNED,
  FREE_NAME_CODES,
  gatewayRefusal,
  gatewayRetryAt,
  holdsTheName,
  keptAnswer,
  needsAPerson,
  paidRefusal,
  refusalKey,
  releases,
  type FinalAnswer,
  type PaidAnswer,
} from '../wallet/lnRefusal'
import { helpMailUrl, takeName } from '../wallet/recover'
import {
  activeScope,
  noteLine,
  onAskedWallet,
  putBack,
  sayOnce,
  takeLine,
  type LineScope,
  type ReleasedLine,
} from '../wallet/releasedLines'
import {
  clearGranted,
  clearPending,
  clearUnpaid,
  disownPending,
  loadPending,
  onPendingGone,
  payAndSettle,
  recordRefusal,
  releasePending,
  settlePending,
  type GoneReason,
  type PendingPurchase,
} from '../wallet/purchase'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { getDistribution } from '../config'
import { GradientButton } from './GradientButton'
import { payLineKey } from '../wallet/withdrawal'
import { Sheet } from './Sheet'
import { Skeleton } from './Skeleton'
import { ConfirmBody, type ConfirmRequest } from './ConfirmSheet'
import { StoreNameOffer } from './StoreNameOffer'
import { Txt } from './Txt'
import { Field } from './Field'
import { font, radius, space, touch } from '../theme'
import { Touch } from './Touch'
import { SupportMailCard, useSupportMail } from './SupportMail'
import { useAppActive } from '../hooks/useAppActive'

// What an unrecognised failure says once the money has left. The general "could not create the
// address" is the worst line in the flow when the person reading it has already paid.
const PAID_FALLBACK = 'receive.lnSettling'

// The code a failure carries. A register the LNURL server refuses arrives as the SDK's NetworkError,
// whose message on React Native is only the class name, with the gateway's code in its body
// (gatewayRefusal); the gateway's own routes put the code in the message.
function refusalCode(err: unknown): string {
  return gatewayRefusal(err) ?? (err as Error | undefined)?.message ?? ''
}

// What the sheet says about a payment made, from the latest answer about it. `asking` is the open's
// first question still out, `waiting` is the wait a later confirmation can end, and the rest are the
// final answers no later confirmation changes (paidRefusal in lnRefusal.ts): no check again, no price.
// `released` is a final answer that gave the slot up (releases in lnRefusal.ts), whose line is said in
// this view and not again.
// `gone` marks a payment whose proof another reader took out of the slot, which the next render drops,
// and `delivered` one whose name another reader's grant put on the wallet, which shows the address.
type PaidLine = 'asking' | 'waiting' | FinalAnswer
type Awaiting = { name: string; reference: string; line: PaidLine; released?: boolean; gone?: true; delivered?: true }

// A payment whose proof left the slot is no longer one the sheet stands on, so its line is marked to
// go, as delivered or as gone, by how the writer that took it out says it left. A line this sheet
// claimed and said stays (releasedLines.ts), and so does a delivery already marked.
function leftSlot(prev: Awaiting | null, reference: string, reason: GoneReason): Awaiting | null {
  if (prev?.reference !== reference || prev.released === true || prev.delivered === true) {
    return prev
  }
  return reason === 'granted' ? { ...prev, delivered: true } : { ...prev, gone: true }
}

function isFinal(line: PaidLine): line is FinalAnswer {
  return line !== 'asking' && line !== 'waiting'
}

// The gateway's answer as the line it puts on screen, and the mark it leaves on the proof.
function lineOf(answer: PaidAnswer): PaidLine {
  return answer === 'coming' ? 'waiting' : answer
}

function keep(reference: string, answer: PaidAnswer, walletId: string): Promise<void> {
  return answer === 'coming'
    ? recordRefusal('name', reference, false, undefined, walletId)
    : recordRefusal('name', reference, true, answer, walletId)
}

// The wallet a claim is for, which the name goes on and the clear after its delivery goes to: a paid
// name's reference and the scope its question started on, or, for a name taken for free, no reference
// and the scope its press or its claim started on.
type ClaimOn = { reference?: string; scope: LineScope | Promise<LineScope> }

// What each final answer says. Only one that leaves sats nobody gave back yet offers support.
const FINAL_LINE: Record<FinalAnswer, string> = {
  kept: 'recover.blockedBody',
  repaid: 'recover.repaidBody',
  paidAgain: 'recover.paidAgainBody',
  paidAgainRepaid: 'recover.paidAgainRepaidBody',
  // The sheet is about a name, so a charge that bought what it was for before bought the name.
  boughtBefore: 'recover.boughtBeforeNameBody',
}

// A payment put on screen without an answer about it keeps what the last answer said, which is still
// the latest word on that payment. Another payment starts at `line`.
function unanswered(prev: Awaiting | null, name: string, reference: string, line: PaidLine): Awaiting {
  return prev?.reference === reference ? prev : { name, reference, line }
}

// What the proof keeps of the gateway's last paid refusal, for a payment put on screen without an
// answer. A refusal for good outlives the process that heard it this way, and anything else starts
// at `otherwise`.
function lastSaid(proof: PendingPurchase, otherwise: PaidLine): PaidLine {
  return keptAnswer(proof) ?? otherwise
}

type Props = {
  visible: boolean
  // Owned by the SDK and shown as a fixed suffix, since only the username is chosen here.
  domain?: string
  // The year on this domain is already paid, so a name on it is not for sale. It only changes what
  // the button says: what happens next was always the free path.
  namesFree?: boolean
  // The paid year lapsed and the domain was taken off the edge, so nothing can be registered on it
  // until it is renewed. Every name reads as unavailable here, which is true and useless.
  domainFrozen?: boolean
  // The address this wallet answers on now, which a new name replaces, and whether reading it failed.
  // A failed read counts as an address: warning about nothing costs a press, and not warning costs
  // every payment sent to the old one.
  currentAddress?: string
  addressUnread?: boolean
  onClose: () => void
  onRegistered: (addr: SparkLnAddress) => void
}

// Username rules are the LUD-16 ones in wallet/lnaddress.
export function LnAddressSheet({
  visible,
  domain,
  namesFree = false,
  domainFrozen = false,
  currentAddress,
  addressUnread = false,
  onClose,
  onRegistered,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const mail = useSupportMail()
  // A build that sells through the store never offers to pay in sats. What was already paid in sats
  // is still resumed below, in every build.
  const store = getDistribution() === 'store'
  // A store purchase out of the buyer's hands takes the place of the offer, and the availability of
  // the name typed stops being the thing to read.
  const [storeTakeover, setStoreTakeover] = useState(false)
  // Names the gateway refused as somebody else's during a store purchase. The LNURL server can still
  // answer that such a name is free, since a hold or a reservation lives only in the gateway.
  const [taken, setTaken] = useState<ReadonlySet<string>>(() => new Set())
  const warning = useRef(false)
  const [username, setUsername] = useState('')
  const [available, setAvailable] = useState<boolean | null>(null)
  const [checking, setChecking] = useState(false)
  // Kept apart from `available`. A check that could not run is not a name that is taken, and it is
  // not the blank state before typing either; folded into that state, the button goes dead and the
  // screen says nothing at all.
  const [checkFailed, setCheckFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Paid and waiting is not a failure. Through the error channel it would read red, stacked over a
  // price, under a button still offering to charge again, so it is its own state, and it replaces the
  // price step rather than sitting on top of it.
  const [awaiting, setAwaiting] = useState<Awaiting | null>(null)
  // The name of a quote whose Pay failed and found another purchase's proof in the slot, which the
  // sheet then waits on. Whether that quote's payment went is not known there, so it gets a line of
  // its own beside the awaited purchase's, never in place of it.
  const [unknownPay, setUnknownPay] = useState<string | null>(null)
  // The proof file could not be read, so a payment may be owed that nothing on screen can name. It
  // takes the sheet before any offer or price, since either beside such a payment invites paying
  // twice, and only the next open whose read answers gives the sheet back.
  const [unread, setUnread] = useState(false)
  // The open's read of the proof has not answered, so a payment it may name is not known yet, and
  // no price stands where it would. Each opening counts, so a read an earlier opening sent that
  // answers late never ends the wait of a later one.
  const [reading, setReading] = useState(false)
  const opening = useRef(0)
  // A name is bought before it is claimed. What the wallet was handed on first use stays free, so
  // nobody is ever left unable to receive; this is what being memorable costs.
  const [quote, setQuote] = useState<NameQuote | null>(null)
  // The reference of the payment the quote or the slot stands for, set the moment money leaves or an
  // opening reads its proof, because from then on the pending file is evidence, not a leftover. Cleared
  // when nothing was sent, when that proof is given up, and when an opening with no send out reads no
  // proof: a flag left over the slot given up would keep a price for a name the field no longer shows,
  // under a button that pays for it.
  const paid = useRef<string | null>(null)
  // The wallet whose slot a Pay filed its quote's proof in, the one its press started on, which the
  // clear of that proof on close goes to whatever wallet is active by then.
  const filedOn = useRef<{ reference: string; walletId: string } | null>(null)
  // Holds the send open across the whole of pay(), which `busy` cannot: state reaches the button
  // only on the next commit, so presses landing in the same batch all read it as false and each one
  // pays. Nothing in the service hands any of those payments back.
  const sending = useRef(false)
  // The same reason as `sending`, for the handlers that mint a price or finish a purchase. Two taps
  // landing in one React batch both read a `busy` that still says false, because state reaches the
  // button after the second tap has already been handled. A ref is written before the first await
  // and is therefore the only guard the second tap can see.
  const working = useRef(false)
  // Held while a holder's paid-again answer puts its name on the wallet (heard).
  const taking = useRef(false)
  // Whether the sheet's window is on screen, which is when the name field may take focus.
  const [presented, setPresented] = useState(false)
  const [asking, setAsking] = useState<ConfirmRequest | null>(null)
  useEffect(() => {
    if (!visible) {
      setPresented(false)
      // Nothing confirms a question from a sheet that left.
      warning.current = false
      setAsking(null)
    }
  }, [visible])
  // Whether the sheet is open and mounted, read when an answer that gives the slot up arrives. An
  // answer heard while it is not, or while the app is out of the foreground, is kept as a line for the
  // first view that takes it (releasedLines.ts), since nobody saw it here.
  const onScreen = useRef(visible)
  useLayoutEffect(() => {
    onScreen.current = visible
  }, [visible])
  useEffect(() => {
    return () => {
      onScreen.current = false
    }
  }, [])
  const active = useAppActive()
  const seen = (): boolean => onScreen.current && active.current

  // A line about a charge that gave the slot up was said in the view that heard it, and that charge
  // left the slot then, so a sheet opened again offers a fresh quote rather than saying it again. It is
  // dropped while the opening renders, so no committed frame of the reopened sheet carries it; dropped
  // by an effect, it would stay on the first frame. One heard while the sheet was closed is kept as a
  // line, which the opening takes below.
  const [openedAs, setOpenedAs] = useState(visible)
  if (openedAs !== visible) {
    setOpenedAs(visible)
    if (visible && awaiting?.released === true) {
      setAwaiting(null)
    }
  }

  // A payment whose proof another reader gave up (the recovery sweep above all), or which a read before
  // a confirmation found gone, is dropped on the render after it is heard, while the sheet stays on
  // screen or sits closed. The sheet then goes on as a released slot, which offers a fresh quote: the
  // quote on screen stood on that payment, or on a Pay that found its proof, and the line about another
  // payment and a press's line were about it. Its line, if it gave sats back, reaches the screen only
  // through the reader that claims it (releasedLines.ts). The paid flag goes once the drop is committed.
  // A name another reader's grant delivered is handed on below instead.
  const [steppedOff, setSteppedOff] = useState(0)
  if (awaiting?.gone === true) {
    setAwaiting(null)
    setUnknownPay(null)
    setQuote(null)
    setError(null)
    setSteppedOff(n => n + 1)
  }
  useLayoutEffect(() => {
    if (steppedOff > 0 && !sending.current) {
      paid.current = null
    }
  }, [steppedOff])
  // How each name proof left the slot while the sheet was mounted, by reference, so a read or a failure
  // that later meets one of them gone takes it as the writer said it left.
  const leftSlots = useRef(new Map<string, GoneReason>())
  useEffect(
    () =>
      onPendingGone((kind, reference, how) => {
        if (kind === 'name') {
          leftSlots.current.set(reference, how)
          setAwaiting(prev => leftSlot(prev, reference, how))
        }
      }),
    [],
  )
  // A name another reader's grant delivered shows as this sheet's own grant shows it: the address read
  // as claim() reads it, handed to the screen, which closes the sheet. Nothing is asked again, and no
  // price is offered for a name just bought. A read that fails or names another address closes the
  // sheet all the same, and the screen reads the address again on its close.
  const handing = awaiting?.delivered === true ? awaiting : null
  const handingFor = handing?.reference ?? null
  useEffect(() => {
    if (handing === null) {
      return
    }
    const { name, reference } = handing
    let live = true
    sparkGetLnAddress()
      .catch(() => null)
      .then(addr => {
        if (!live) {
          return
        }
        givenUp(reference)
        setError(null)
        if (addr && addr.username === name) {
          finished(addr)
          return
        }
        setUsername('')
        setQuote(null)
        setAwaiting(null)
        setUnknownPay(null)
        onClose()
      })
    return () => {
      live = false
    }
    // Runs when a delivery is marked; the handlers it ends in close over nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handingFor])

  // A purchase left unfinished by a crash or a lost network in the seconds after paying. Picked up
  // before anything else, so the buyer is never charged twice for the same name.
  useEffect(() => {
    if (!visible) {
      return
    }
    // The sheet stays mounted while closed, and a line left by an earlier press, a hold's time above
    // all, is about a moment that may have passed. What the open reads says what is true now.
    setError(null)
    setUnknownPay(null)
    const at = (opening.current += 1)
    // Only the latest opening's read decides the sheet. An earlier one answers before it in the
    // proofs' queue (purchase.ts), so the latest read says the same or newer, and an earlier answer
    // acted on would mark the sheet unread or resume a proof under an opening that has not read yet.
    const answered = (): boolean => {
      if (opening.current !== at) {
        return false
      }
      setReading(false)
      return true
    }
    setReading(true)
    loadPending('name')
      .then(
        pending => {
          if (!answered()) {
            return undefined
          }
          setUnread(false)
          if (!pending) {
            if (!sending.current) {
              paid.current = null
            }
            // A wait still on the sheet is for a proof that left the slot, so it goes, whatever its
            // line, and nothing is asked about it. A name marked delivered still hands its address on.
            setAwaiting(prev => (prev === null || prev.released === true ? null : leftSlot(prev, prev.reference, 'gone')))
            return showKept(at)
          }
          paid.current = pending.reference
          setUsername(pending.subject)
          // Set before the gateway is asked, and never taken back by a failure. A payment that cannot
          // be finished right now is still a payment: dropping this state would return the sheet to
          // the price step, where the only button on offer mints a second invoice for the same name,
          // and no part of the service can give the first one back. Until the gateway answers, the
          // line says nothing it has not said, since a payment it refuses for good would otherwise
          // read as coming, and what it last said is on the proof.
          setAwaiting(prev =>
            unanswered(prev, pending.subject, pending.reference, lastSaid(pending, 'asking')),
          )
          // A proof given up between this read and the question goes on as an opening that read none.
          return resume(pending.subject, pending.reference).then(asked =>
            asked === 'gone' ? showKept(at) : undefined,
          )
        },
        () => {
          // Met here, ahead of the catch below, whose line says a payment was made, which nothing
          // read says either. A torn proof and a read the platform refused alike leave nothing read.
          if (answered()) {
            setUnread(true)
          }
          return undefined
        },
      )
      .catch((err: Error) => {
        // A purchase that was paid for and cannot be finished is the one thing the buyer must not be
        // left guessing about.
        console.warn('resuming purchase failed:', err?.message ?? err)
        setError(reason(t, refusalCode(err), PAID_FALLBACK))
      })
    // Runs when the sheet opens; resume closes over nothing that changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // The card a mail leaves, beside the press about the same reference only.
  const supportCard = (about: string): React.JSX.Element | null => {
    const note = mail.noteFor(about)
    return note ? <SupportMailCard raised note={note} /> : null
  }

  // A line an answer left while no view could show it, taken and said here once, with no question to
  // the gateway and no price, and the slot of its reference given up as shown, which a crash between
  // keeping the line and giving the slot up may have left. Only an opening with no proof held takes
  // one, and a sheet closed or opened again while it was taken puts it back for the next view, on the
  // wallet it was taken from.
  async function showKept(at: number): Promise<void> {
    const scope = await activeScope()
    const kept = await takeLine('name', scope)
    if (kept === null) {
      return
    }
    if (!seen() || opening.current !== at) {
      await putBack(kept, scope)
      return
    }
    // The line keeps the whole address as heard; the sheet says the name.
    const name = kept.subject.split('@')[0] ?? kept.subject
    setUsername(name)
    setAwaiting({ name, reference: kept.reference, line: kept.answer, released: true })
    await onAskedWallet(scope, walletId => releasePending('name', kept.reference, kept.answer, walletId))
  }

  // Guarded because it ends in claim(), which registers the name, or in a holder's answer, which may.
  // claim() reads the current address first and skips the register when it already matches, but that
  // read is awaited: two of these in flight both read the address from before either finished, and
  // both register. A second register is a second change against the gateway's rate-limited budget,
  // spent on a name just paid for. The refusal is read inside the guard for the same reason.
  //
  // It asks only while the slot still holds this payment's proof, read last before the question (onSlot):
  // the recovery sweep shares the slot and may have given it up since the wait went on screen, after which
  // the gateway has nothing more to say about it and the sheet goes on as a released slot ('gone'), or
  // shows the address when the sweep's grant delivered the name. A read that fails confirms nothing and
  // takes the sheet as unread, as at the open.
  async function resume(name: string, reference: string): Promise<'gone' | undefined> {
    if (working.current) {
      return undefined
    }
    working.current = true
    // The domain the confirmation goes to, which a line about its answer names, and the wallet its line
    // is kept for.
    let askedOn = currentDomain()
    const scope = activeScope()
    try {
      const deps = await currentDeps()
      askedOn = deps.domain
      const now = await onSlot(reference)
      if (now !== 'held') {
        return now === 'gone' ? 'gone' : undefined
      }
      const outcome = await settlePending('name', () => confirmName(deps, name, reference))
      if (outcome === 'done') {
        // The grant is the gateway's latest word and takes back a refusal for good, on screen and
        // on the proof, so a register that fails after it reads as the wait it is.
        setAwaiting({ name, reference, line: 'waiting' })
        await onAskedWallet(scope, walletId => recordRefusal('name', reference, false, undefined, walletId))
        await claim(name, { reference, scope })
        return
      }
      setAwaiting({ name, reference, line: 'waiting' })
    } catch (err) {
      return await refused(err, name, reference, askedOn, scope)
    } finally {
      working.current = false
    }
  }

  // Reads the slot for a name's proof, last before a question goes out and again before a failure is
  // told, since only what the slot holds now decides whether the wait stands. 'held' while it holds
  // the proof, which forgets how that proof left before: a Pay files the same quote again after a send
  // that failed, and the sweep files back a charge it finds. A slot that cannot be read drops nothing
  // and takes the sheet as unread, as at the open. A proof no longer held drops the wait the way the
  // writer that took it out said it left, which is the answer: a delivered name hands its address on,
  // and one gone goes on as a released slot.
  async function onSlot(reference: string): Promise<'held' | 'unread' | GoneReason> {
    const held = await loadPending('name').catch(() => 'unread' as const)
    if (held === 'unread') {
      setUnread(true)
      return 'unread'
    }
    if (held?.reference !== reference) {
      const left = leftSlots.current.get(reference) ?? 'gone'
      setAwaiting(prev => leftSlot(prev, reference, left))
      return left
    }
    leftSlots.current.delete(reference)
    return 'held'
  }

  // Every failure here leaves the waiting state alone while its proof is in the slot, since a purchase
  // that cannot be finished right now is still a purchase. The exception is the gateway refusing this wallet's key on the
  // reference, which is not "not yet" but "not here": that record predates the store being keyed by
  // wallet and is another wallet's. Held on it, this wallet can never buy a name of its own, and
  // never reaches the price step that recovers a purchase whose record was lost.
  //
  // Answers 'gone' when the slot, read again, no longer holds the proof and it left as gone, so an
  // opening goes on as one that read none.
  async function refused(
    err: unknown,
    name: string,
    reference: string,
    askedOn: string,
    scope: Promise<LineScope>,
  ): Promise<'gone' | undefined> {
    const message = (err as Error | undefined)?.message ?? ''
    // The gateway's own word on this payment, which takes the line as a payment not seen yet does.
    const paidLine = paidRefusal(err)
    if (paidLine !== undefined) {
      await heard(name, reference, askedOn, paidLine, err, scope)
      return undefined
    }
    console.warn('resuming purchase failed:', message)
    // A failure that says nothing about the payment, a lost network or the identity read before the
    // question above all, ends the asking and leaves what the last answer said while the slot, read
    // again now, still holds the proof. Gone from it, no line says the name is landing and the sheet
    // goes the way the proof left. How it left never decides that the wait goes: one heard before a
    // Pay or the sweep filed the same reference again says nothing of the proof held now.
    setAwaiting(prev => (prev?.line === 'asking' ? { ...prev, line: 'waiting' } : prev))
    const now = await onSlot(reference)
    if (now !== 'held') {
      return now === 'gone' ? 'gone' : undefined
    }
    setError(reason(t, refusalCode(err), PAID_FALLBACK))
    if (message !== DISOWNED) {
      return undefined
    }
    // A failure releases nothing, a torn record and a read the platform refused alike, and stops the
    // sheet as at the open, since what the slot holds is not known. The key refused is the one the
    // question was signed with, so the mark goes on the wallet it started on.
    const { walletId } = await scope
    if (walletId === null) {
      return undefined
    }
    const released = await disownPending('name', reference, walletId).catch(() => {
      setUnread(true)
      return false
    })
    if (!released) {
      return undefined
    }
    paid.current = null
    setAwaiting(null)
    setUnknownPay(null)
    return undefined
  }

  // The gateway's word on a payment made: its line, then what it does to the proof. Runs inside the
  // guard of the press or opening that asked (pay, resume). A holder's answer to a payment that bought
  // nothing puts the name on the wallet only while the wallet answers on no address at all, by the
  // sweep's rule (takeName), so an address in use, chosen here or on another device, is never swapped
  // for it. A Pay and an opening can both be asking about one payment, so the take has a guard of its
  // own: one still reading the address holds the other back, and one that finished left the name,
  // which takeName reads as held. An answer that releases the slot gives it up, along with the quote it
  // paid, so the next opening offers only a fresh quote and asks nothing more about this charge: no
  // second question, no second register. Its line is said here only once this sheet claimed the
  // reference (sayOnce), after the address is read, so a line the sweep's card or a closing sheet
  // already has is not said twice; one heard while the sheet is closed is kept for the first view that
  // takes it. Either comes before the slot is given up, so a crash between them leaves the proof,
  // whose next confirmation hears the same answer. The line goes under the scope the question started
  // on, read before it was asked, so a switch or a forget while it was out never moves it, and the mark
  // or the release of the slot goes to that scope's wallet, so a switch never moves either.
  async function heard(
    name: string,
    reference: string,
    askedOn: string,
    answer: PaidAnswer,
    err: unknown,
    scope: Promise<LineScope>,
  ): Promise<void> {
    const released = releases(answer, err)
    const said: Awaiting = { name, reference, line: lineOf(answer), released }
    if (!released) {
      setAwaiting(said)
      await onAskedWallet(scope, walletId => keep(reference, answer, walletId))
      return
    }
    // Read as the answer lands: a sheet open then claims the line once the address is read, and one
    // closed then keeps it.
    const heardOpen = seen()
    const on = await scope
    // Taken for the wallet that asked, so a switch meanwhile puts the name on no other wallet's key.
    if (holdsTheName(err) && !taking.current) {
      taking.current = true
      try {
        await onAskedWallet(on, walletId => takeName(name, walletId))
      } finally {
        taking.current = false
      }
    }
    setQuote(null)
    const line: ReleasedLine = { kind: 'name', reference, answer, subject: `${name}@${askedOn}` }
    const view = { onScreen: seen, show: () => setAwaiting(said), passOver: () => passOver(reference) }
    const release = (): Promise<void> => onAskedWallet(on, walletId => releasePending('name', reference, answer, walletId))
    if (heardOpen) {
      await sayOnce(line, on, view)
      await release()
    } else {
      await noteLine(line, on)
      await release()
      // A sheet opened again meanwhile read the proof as still held and waits on this answer, so it
      // takes the line as the next view would.
      if (seen()) {
        await sayOnce(line, on, view)
      }
    }
    // An opening that read the proof before it was given up still shows it awaited, and its own
    // question waits out this one's guard; it goes on as a released slot, since the line was said or
    // is kept. That read also marked the sheet as paid on this reference.
    passOver(reference)
    givenUp(reference)
  }

  // The slot of this reference was given up, so the sheet no longer stands on its payment. A payment of
  // another reference read meanwhile stays.
  function givenUp(reference: string): void {
    if (paid.current === reference) {
      paid.current = null
    }
  }

  // A sheet still awaiting a reference whose slot was given up goes on as a released slot, which
  // offers a fresh quote. A line already said for it stays.
  function passOver(reference: string): void {
    setAwaiting(prev => (prev?.reference === reference && prev.released !== true ? null : prev))
  }

  // Registering replaces the address in one step: the server keys users on (domain, pubkey), so the
  // upsert swaps the name and reserves the old one for this wallet. Never free the old address
  // first: a register that then fails leaves the wallet with no address at all.
  //
  // The reference is what the clear needs to retire a proof written before the store was keyed by
  // wallet. A claim with none, the free-name path, leaves any such proof exactly where it is.
  //
  // A name goes only on the wallet the claim is for, by the sweep's rule (recover.ts, takeName): the one
  // whose question heard a paid name's grant, or the one active as a free name's press or claim
  // started. After a switch the live connection is another wallet's, whose key would take the name and
  // whose address the read below would answer, so nothing is read, registered or cleared; a paid
  // proof waits in the slot of the wallet that paid, and a free name is left for the next press. The
  // connection is read in the step that starts the address read, which reads on the connection live
  // then, and again inside the register's turn (spark.ts, sparkRegisterLnAddress). A claim that could
  // not read its wallet has none to put the name on.
  async function claim(name: string, on: ClaimOn = { scope: activeScope() }): Promise<void> {
    const { reference } = on
    // What the sheet says when the name is left for the wallet that paid: that it waits, as the sweep's
    // card says of a name it could not put on that wallet. A free name has no payment to wait on.
    const leftForPayer = (): void => {
      if (reference !== undefined) {
        setAwaiting({ name, reference, line: 'waiting' })
      }
    }
    const { walletId } = await on.scope
    if (walletId === null || sparkConnectedWalletId() !== walletId) {
      leftForPayer()
      return
    }
    // A purchase interrupted after the server took the name leaves a record for something already
    // done. Registering it a second time counts as another change and is refused, which would put an
    // error on a purchase that worked.
    const atual = await sparkGetLnAddress().catch(() => null)
    if (atual && atual.username === name) {
      await clearDelivered(reference, walletId)
      finished(atual)
      return
    }
    const addr = await sparkRegisterLnAddress(name, undefined, walletId)
    if (addr === null) {
      leftForPayer()
      return
    }
    // Cleared here and nowhere earlier, because until the name exists the record is the only way
    // back to a purchase that was paid for.
    await clearDelivered(reference, walletId)
    finished(addr)
  }


  // The clear once a name is on the wallet the claim is for, a paid one heard as delivered. One with no
  // reference, the free path, names no charge delivered, so it drops only a record standing for no
  // payment and leaves a paid proof the recovery sweep filed meanwhile for the reader that names it.
  function clearDelivered(reference: string | undefined, walletId: string): Promise<void> {
    return reference === undefined ? clearUnpaid('name', walletId) : clearGranted('name', reference, walletId)
  }

  function finished(addr: SparkLnAddress): void {
    setUsername('')
    setQuote(null)
    setAwaiting(null)
    setUnknownPay(null)
    onRegistered(addr)
  }

  const normalized = normalizeUsername(username)
  const valid = validateUsername(normalized)
  // The name the field shows now. An answer to See the price for any other lands nowhere, since a price
  // left on screen for a name the field no longer shows would charge for it.
  const shown = useRef(normalized)
  useLayoutEffect(() => {
    shown.current = normalized
  }, [normalized])

  // Only a well-formed username reaches the server, since a malformed one gets the format hint.
  useEffect(() => {
    if (!valid) {
      setAvailable(null)
      setCheckFailed(false)
      setChecking(false)
      return
    }
    setChecking(true)
    setCheckFailed(false)
    const timer = setTimeout(() => {
      sparkCheckLnAddress(normalized)
        .then(free => {
          setAvailable(free)
          setCheckFailed(false)
        })
        .catch(() => {
          setAvailable(null)
          setCheckFailed(true)
        })
        .finally(() => setChecking(false))
    }, 400)
    return () => clearTimeout(timer)
  }, [normalized, valid, attempt])

  // A wallet holds one address, so a new name stops the old one receiving. Said before anything is
  // priced or sold, on the sheet's press and on the store's, and held open by a ref since a second tap
  // lands before the question. A paid purchase coming back never passes here: the money already went.
  function warnBeforeChange(go: () => void): void {
    if (!currentAddress && !addressUnread) {
      go()
      return
    }
    if (warning.current) {
      return
    }
    warning.current = true
    Keyboard.dismiss()
    setAsking({
      title: t('receive.lnChangeTitle'),
      body: currentAddress
        ? t('receive.lnChangeWarning', { address: currentAddress })
        : t('receive.lnChangeWarningUnread'),
      confirm: t('receive.lnChangeConfirm'),
      cancel: t('common.cancel'),
      onConfirm: go,
    })
  }

  function endAsking(): void {
    warning.current = false
    setAsking(null)
  }

  // Asks the price. Kept apart from paying so the buyer sees what it costs before committing.
  async function ask() {
    if (!valid || available !== true || busy || working.current) {
      return
    }
    working.current = true
    setBusy(true)
    setError(null)
    const asked = normalized
    // The wallet a name taken for free here goes on, the one active as the press starts.
    const scope = activeScope()
    try {
      const priced = await quoteName(await currentDeps(), asked)
      if (shown.current !== asked) {
        return
      }
      setQuote(priced)
    } catch (err) {
      if (shown.current !== asked) {
        return
      }
      // Two things carry no price: a name on a domain the customer owns, and one the generator could
      // have produced, which any wallet may claim. The gateway says so instead of quoting, and the
      // name is taken directly rather than sold.
      if (FREE_NAME_CODES.has((err as Error).message)) {
        // Refused while another wallet holds the name, the register says when the hold clears, as
        // the quote's refusal below does.
        await claim(asked, { scope }).catch((registerErr: unknown) => {
          const clears = gatewayRetryAt(registerErr)
          if (clears === undefined) {
            throw registerErr
          }
          setError(t('store.heldTryLater', { name: asked, time: clearsAt(clears, deviceDateTimePrefs()) }))
        })
        return
      }
      // A name another wallet's store credit holds while its register resolves clears on its own, and
      // the gateway says when, so the line gives that time rather than calling the name taken.
      const until = (err as RefusalError).retryAt
      if (until !== undefined) {
        setError(t('store.heldTryLater', { name: asked, time: clearsAt(until, deviceDateTimePrefs()) }))
        return
      }
      setError(reason(t, refusalCode(err)))
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  async function pay() {
    if (!quote || busy || sending.current) {
      return
    }
    sending.current = true
    setBusy(true)
    setError(null)
    // A Pay writes this quote's proof again, so how it left the slot after an earlier send that failed
    // says nothing of this one.
    leftSlots.current.delete(quote.reference)
    // The domain the confirmation goes to, which a line about its answer names, and the wallet its line
    // is kept for.
    let askedOn = currentDomain()
    const scope = activeScope()
    try {
      const deps = await currentDeps()
      askedOn = deps.domain
      // The proof is filed, promoted and dropped in the slot of the wallet the press started on, so a
      // switch while the send is out never leaves this wallet's proof behind. A press that could not
      // read its wallet files and sends nothing, and reads as a record it cannot read.
      const { walletId: payer } = await scope
      if (payer === null) {
        setUnread(true)
        return
      }
      paid.current = quote.reference
      filedOn.current = { reference: quote.reference, walletId: payer }
      const result = await payAndSettle(
        {
          kind: 'name',
          subject: quote.username,
          reference: quote.reference,
          amountSats: quote.amountSats,
        },
        quote.invoice,
        () => confirmName(deps, quote.username, quote.reference),
        payer,
      )
      if (result.outcome === 'owed') {
        // Nothing was sent. A name this wallet has already paid for is still owed, and paying the
        // invoice on screen would replace the only proof of it with a second charge.
        setUsername(result.owed.subject)
        setAwaiting(prev =>
          unanswered(
            prev,
            result.owed.subject,
            result.owed.reference,
            lastSaid(result.owed, 'waiting'),
          ),
        )
        return
      }
      if (result.outcome === 'failed') {
        // Nothing was charged, so the quote on screen is unpaid again. Left standing, the flag holds
        // the price of the name the buyer has moved off, under a button that pays that invoice.
        paid.current = null
        setError(t('receive.lnPayFailed'))
        return
      }
      if (result.outcome === 'settling') {
        setAwaiting({ name: quote.username, reference: quote.reference, line: 'waiting' })
        return
      }
      await claim(quote.username, { reference: quote.reference, scope })
    } catch (err) {
      // The money already left on this one, so it is never a refusal of the name. Only `final: false`
      // makes it a wait; every other answer is final.
      const paidLine = paidRefusal(err)
      if (paidLine !== undefined) {
        await heard(quote.username, quote.reference, askedOn, paidLine, err, scope)
        return
      }
      // Whether the send went out is not in the error, it is on disk: the proof is dropped only when
      // nothing was sent. While it is there the buyer stays on the payment, since the alternative is
      // a price for a name that may already be bought and paid for. A failure that says nothing about
      // the payment leaves a refusal for good that an answer meanwhile put on screen. A proof that
      // cannot be read, torn or refused by the platform, takes the sheet, whose line claims no payment.
      // The slot read is the pressing wallet's, where this Pay filed its proof, since another wallet's,
      // active after a switch, would put that wallet's payment on the sheet; a press that could not read
      // its wallet has no slot, and reads as a proof it cannot read.
      const { walletId: payer } = await scope
      const held =
        payer === null ? ('unread' as const) : await loadPending('name', payer).catch(() => 'unread' as const)
      if (held === 'unread') {
        setUnread(true)
        return
      }
      // The slot is shared with the recovery sweep, so a proof of another reference says nothing of
      // this send. The sheet then waits on that proof's payment, as the open does with a proof it finds,
      // and says of this quote only what is true whether or not its payment went.
      if (held && held.reference !== quote.reference) {
        setUsername(held.subject)
        setAwaiting(prev => unanswered(prev, held.subject, held.reference, lastSaid(held, 'waiting')))
        setUnknownPay(quote.username)
        return
      }
      if (held) {
        setAwaiting(prev =>
          prev !== null && isFinal(prev.line)
            ? prev
            : { name: quote.username, reference: quote.reference, line: 'waiting' },
        )
        setError(reason(t, refusalCode(err), PAID_FALLBACK))
        return
      }
      // A proof another reader took out of the slot while this Pay asked about it goes the way it
      // left, a delivered name to its address and a proof given up to a fresh quote, with no line
      // about this attempt. An exit's hold is refused in spark.ts before the SDK is called, and the
      // purchase itself gives up the proof it promoted, so a proof gone with that refusal left with
      // this Pay: the quote stands unpaid under the hold's line.
      const code = classifyWalletError(err)
      const exitHeld = code === 'exitHeld' || code === 'exitHeldUnread'
      const left = leftSlots.current.get(quote.reference)
      if (left !== undefined && !(exitHeld && left === 'gone')) {
        const asked: Awaiting = { name: quote.username, reference: quote.reference, line: 'waiting' }
        setAwaiting(prev => leftSlot(prev ?? asked, quote.reference, left))
        return
      }
      paid.current = null
      setError(exitHeld ? t(walletErrorKey(code)) : reason(t, refusalCode(err)))
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  // The mail the recovery card sends, so support finds the payment by the wallet's key and reference.
  async function sendToSupport(reference: string): Promise<void> {
    const pubkey = await sparkGetIdentityPubkey().catch(() => '')
    const body = t('recover.mailBody', { pubkey, reference })
    await mail.open(helpMailUrl(t('recover.mailSubject'), body), body, reference)
  }

  function close(): void {
    // Only a quote nobody paid is discarded. The paid flag, not the quote, decides: the resume path
    // leaves `quote` null while the file still holds the buyer's only proof of a payment made. While
    // the proof cannot be read nothing is cleared, since what it holds is not known.
    if (quote && paid.current === null && !unread) {
      // Named with this sheet's own reference, because the slot is shared: the recovery sweep files
      // a proof there for any charge the gateway says is owed. `awaiting?.reference` would not do: it
      // is undefined on this branch, since a quote nobody paid leaves nothing awaiting, and an
      // undefined reference drops whatever the slot holds. A record a Pay filed goes from the slot it
      // was filed in, whatever wallet is active by then.
      const filed = filedOn.current
      const walletId = filed?.reference === quote.reference ? filed.walletId : undefined
      clearPending('name', quote.reference, walletId).catch(() => undefined)
    }
    mail.setNote(null)
    onClose()
  }

  function status(): { text: string; tone: 'ok' | 'bad' | 'checking' } | null {
    if (error) {
      return { text: error, tone: 'bad' }
    }
    if (username.trim() === '') {
      return null
    }
    if (!valid) {
      return { text: t('receive.lnInvalid'), tone: 'bad' }
    }
    if (taken.has(normalized)) {
      return { text: t('receive.lnTaken'), tone: 'bad' }
    }
    if (checking) {
      return { text: '', tone: 'checking' }
    }
    if (available === true) {
      return { text: t('receive.lnAvailable'), tone: 'ok' }
    }
    if (available === false) {
      // Checked before "taken", since a frozen domain answers false for every name and the customer
      // would go on picking worse ones forever.
      return {
        text: t(domainFrozen ? 'receive.lnDomainFrozen' : 'receive.lnTaken'),
        tone: 'bad',
      }
    }
    if (checkFailed) {
      return { text: t('receive.lnCheckFailed'), tone: 'bad' }
    }
    return null
  }
  const st = storeTakeover ? (error ? { text: error, tone: 'bad' as const } : null) : status()

  // The gateway answers with a machine-readable reason, and the SDK throws its own strings. Every
  // path that puts text on this screen goes through here, including the ones that escape the inner
  // handlers: anything unrecognised gets the fallback rather than being shown raw. A string like
  // `SdkError.NetworkError` is untranslated, written for an operator, and reads as though the app
  // broke. The fallback is the caller's to choose, because "could not create the address" is
  // false once the money has left.
  function reason(translate: typeof t, code: string, fallback = 'receive.lnFailed'): string {
    const key = refusalKey(code)
    if (key) {
      return translate(key)
    }
    console.warn('ln address purchase refused:', code)
    return translate(fallback)
  }

  // A free name's register refused by an exit's hold, which spark.ts makes on the wallet in front
  // before the SDK is asked, says so with the Receive lines rather than calling the address failed.
  function askRefusal(err: unknown): string {
    const code = classifyWalletError(err)
    return code === 'receiveHeld' || code === 'receiveHeldUnread'
      ? t(walletErrorKey(code))
      : reason(t, refusalCode(err))
  }

  // Said above the awaited purchase's own line and never in its place.
  const otherLine =
    unknownPay !== null ? (
      <Txt role="caption" tone="muted" style={styles.centre}>
        {t('receive.lnOtherPurchase', { name: unknownPay })}
      </Txt>
    ) : null

  return (
    <Sheet
      visible={visible}
      onClose={asking ? endAsking : close}
      closeLabel={asking ? asking.cancel : t('common.back')}
      keyboard
      // On iOS a Modal's autoFocus fires before the sheet is on screen, so the keyboard rises against
      // nothing or not at all. Once Sheet reports the window shown, the field mounts again with
      // autoFocus and takes focus in a window that is there. A ref focused from onShow would need
      // Field to hand one on, which it does not.
      onShow={() => setPresented(true)}>
      {/* The sheet stops at its cap, and at the largest text sizes a title, the field and a long
          line pass it, so the content scrolls under the cap rather than leaving the one button
          below the screen's edge, out of reach and out of the accessibility tree. The question
          stands in for it, which stays mounted under display none, as a purchase and a price live
          in what it holds. */}
      {asking && <ConfirmBody request={asking} onClose={endAsking} />}
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={asking ? styles.hidden : undefined}
        contentContainerStyle={styles.body}>
        <Txt role="subheading" tone="default">
          {t('receive.lnTitle')}
        </Txt>
        <Field
          key={presented ? 'presented' : 'presenting'}
          autoFocus={presented}
          value={username}
          onChangeText={u => {
            // Usernames are lowercase per LUD-16, so the field and the preview must agree.
            setUsername(u.toLowerCase())
            setError(null)
            // A price belongs to the name it was asked for. Leaving it on screen after the field
            // changes offers to charge for one name while showing another.
            if (paid.current === null) {
              setQuote(null)
            }
          }}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('receive.lnPlaceholder')}
          accessibilityLabel={t('receive.lnTitle')}
          // The address reads name@domain in every language, and the suffix is part of it.
          ltr
          trailing={
            domain ? (
              <Txt role="bodyStrong" tone="muted">
                @{domain}
              </Txt>
            ) : null
          }
        />
        {st && !awaiting && !unread ? (
          st.tone === 'checking' ? (
            // The line's own height while the answer loads, as the asking state below does, rather than
            // a word saying so.
            <Skeleton width="40%" height={font.leading.sm} style={styles.statusSkeleton} />
          ) : (
            <Txt role="label" tone={st.tone === 'ok' ? 'success' : 'danger'} style={styles.centre}>
              {st.text}
            </Txt>
          )
        ) : null}
        {checkFailed && !awaiting && !storeTakeover && !unread ? (
          <Touch onPress={() => setAttempt(n => n + 1)} feedback="link" style={styles.retry}>
            <Txt role="label" tone="accent" style={styles.centre}>
              {t('receive.lnCheckRetry')}
            </Txt>
          </Touch>
        ) : null}
        {unread ? (
          // A payment may be owed and nothing on the device names it, so there is no price and no
          // offer, and the one press reaches the person who can look it up by the wallet's key.
          <>
            <Txt role="body" tone="muted" style={styles.centre}>
              {t('recover.recordUnread')}
            </Txt>
            <GradientButton
              label={t('recover.sendToSupport')}
              onPress={() => sendToSupport(t('recover.mailRecordUnread'))}
            />
            {supportCard(t('recover.mailRecordUnread'))}
          </>
        ) : awaiting !== null && isFinal(awaiting.line) ? (
          // Paid, and no later confirmation changes what it came to. Nothing here says it is coming or
          // offers to check again or a price; the one press, where sats are still to be given back,
          // reaches the person who does it.
          <>
            {otherLine}
            <Txt role="body" tone="muted" style={styles.centre}>
              {t(FINAL_LINE[awaiting.line], { subject: awaiting.name })}
            </Txt>
            {needsAPerson(awaiting.line) ? (
              <>
                <GradientButton
                  label={t('recover.sendToSupport')}
                  onPress={() => sendToSupport(awaiting.reference)}
                />
                {supportCard(awaiting.reference)}
              </>
            ) : null}
          </>
        ) : awaiting ? (
          // One state, one thing to read, one thing to do. The price is settled and the money is
          // gone, so showing either again only invites paying twice.
          <>
            {otherLine}
            {/* One line, in the same neutral tone whatever it says. A failure here is a step that
                  has not happened yet on a purchase that is paid for, so painting it as an error
                  would contradict the state it is reporting. */}
            {awaiting.line === 'asking' ? (
              <Skeleton height={font.leading.base} />
            ) : (
              <Txt role="body" tone="muted" style={styles.centre}>
                {error ?? t('receive.lnSettling')}
              </Txt>
            )}
            <GradientButton
              label={t('receive.lnCheckAgain')}
              onPress={() => {
                setError(null)
                resume(awaiting.name, awaiting.reference).catch((err: Error) =>
                  setError(reason(t, refusalCode(err), PAID_FALLBACK)),
                )
              }}
              loading={busy}
            />
          </>
        ) : store ? (
          <StoreNameOffer
            visible={visible}
            name={valid ? normalized : ''}
            available={taken.has(normalized) ? false : available}
            namesFree={namesFree}
            taken={taken}
            claim={name => claim(name)}
            warnBeforeChange={warnBeforeChange}
            onRegistered={finished}
            onTaken={name => setTaken(prev => new Set(prev).add(name))}
            onError={setError}
            onTakeover={setStoreTakeover}
            onClose={close}
          />
        ) : reading ? (
          // The button's own shape while the proof is read, in place of a price. The store's offer
          // above stays mounted: it never reads the sats proof, and an opening that unmounted it would
          // drop a purchase it is waiting on. A read that never answers keeps this shape with no
          // bound, since every later read and write of the proofs waits behind it in their queue and
          // no price can be paid meanwhile (docs/store-bridge.md, Screens).
          <Skeleton height={touch.action} borderRadius={radius.md} />
        ) : quote ? (
          <>
            <Txt role="heading" tone="default" style={styles.price}>
              {t('receive.lnPrice', {
                amount: formatSats(quote.amountSats),
                name: quote.username,
              })}
            </Txt>
            <Txt role="caption" tone="muted" style={styles.priceWhy}>
              {t('receive.lnPriceWhy')}
            </Txt>
            <Txt role="caption" tone="muted" style={styles.priceWhy}>
              {t(payLineKey('sats'))}
            </Txt>
            <GradientButton
              label={t('receive.lnPay')}
              onPress={() => pay().catch((err: Error) => setError(reason(t, refusalCode(err))))}
              loading={busy}
            />
          </>
        ) : (
          <GradientButton
            label={t(namesFree ? 'receive.lnUseName' : 'receive.lnSeePrice')}
            onPress={() =>
              warnBeforeChange(() => {
                ask().catch((err: Error) => setError(askRefusal(err)))
              })
            }
            disabled={!valid || available !== true}
            loading={busy}
          />
        )}
      </ScrollView>
    </Sheet>
  )
}

const styles = StyleSheet.create({
  // The sheet's own gap, which stops at the scroll view and so is given again inside it.
  body: { gap: space.lg },
  hidden: { display: 'none' },
  price: { textAlign: 'center' },
  priceWhy: { textAlign: 'center' },
  // The 44pt floor comes from Touch; this only stops the target stretching the sheet. Centred, as
  // every other line of the sheet is.
  retry: { alignSelf: 'center' },
  centre: { textAlign: 'center' },
  statusSkeleton: { alignSelf: 'center' },
})
