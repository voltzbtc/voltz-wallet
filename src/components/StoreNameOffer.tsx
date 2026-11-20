import React, { useEffect, useRef, useState } from 'react'
import { StyleSheet } from 'react-native'
import { useTranslation } from 'react-i18next'
import { sparkCheckLnAddress, sparkGetLnAddress, type SparkLnAddress } from '../wallet/spark'
import { currentDeps, currentDomain } from '../wallet/namePurchase'
import { currentStore, loadProducts, type ProductId } from '../wallet/store'
import { payLineKey } from '../wallet/withdrawal'
import {
  buyInStore,
  dismissStoreOutcome,
  dropStoreWait,
  endNameChecks,
  keepNameCheck,
  keptOrderViews,
  liveStoreContext,
  nameChecks,
  onStoreSettled,
  recordSpendIntent,
  storeCredits,
  storeOrderViews,
  syncStorePurchases,
  type NameCheck,
  type StoreBuyOutcome,
  type StoreCredit,
  type StoreGatewayDeps,
  type StoreOrderView,
} from '../wallet/storePurchase'
import {
  NAME_PRODUCTS,
  attemptCredits,
  availableCredit,
  creditFor,
  nameProduct,
  nameTier,
  reservedFor,
  reservedName,
  spentFrom,
  type NameTier,
} from '../wallet/nameCredit'
import {
  FREE_NAME_CODES,
  gatewayRefusal,
  gatewayRetryAt,
  storeErrorKey,
  storeNameRefusalKey,
  storeRefusedKey,
} from '../wallet/lnRefusal'
import { helpMailUrl } from '../wallet/recover'
import { classifyWalletError, walletErrorKey } from '../wallet/errors'
import { clearsAt } from '../wallet/history'
import { deviceDateTimePrefs } from '../wallet/deviceLocale'
import { GradientButton } from './GradientButton'
import { SupportMailCard, useSupportMail } from './SupportMail'
import { Skeleton } from './Skeleton'
import { Txt } from './Txt'
import { font, radius, space, touch } from '../theme'

// A name in a build that sells through the App Store or Google Play. The price is the store's, in
// the person's currency, and a store build offers no way to pay for a name in sats. A purchase
// delivers a credit of the name's length tier on this domain, and the credit is spent by a signed
// intent followed by the same register the sats path ends in.

// Codes that mean somebody else has the name, after which only another name helps.
const TAKEN: ReadonlySet<string> = new Set([
  'name_taken',
  'held_by_another_wallet',
  'name_held_for_credit',
  'name_paid_by_another_wallet',
  'name is being bought by someone else',
])

// What the gateway settles for a purchase that ends the wait without a credit to spend.
const SUPPORT: ReadonlySet<string> = new Set(['support', 'unknownOrder', 'noReference'])

// The views a sync's answer about an order not on screen may take the place of. The others are a
// check, a finishing or finished name, or an order's own outcome, each of which a person is reading.
const OPEN_VIEWS: ReadonlySet<string> = new Set(['offer', 'opening', 'unread'])

const LENGTH_KEY: Record<NameTier, string> = {
  long: 'store.lengthLong',
  standard: 'store.lengthStandard',
  five: 'store.lengthFive',
  four: 'store.lengthFour',
  short: 'store.lengthShort',
}

// What replaces the offer while a purchase is out of the person's hands.
type View =
  | { kind: 'offer' }
  // The book kept nothing for this domain and the credits have not answered, so what the wallet
  // already paid for is unknown and nothing is offered yet.
  | { kind: 'opening' }
  // The store has not finished, as with Ask to Buy, a slow payment, or a paid purchase the gateway
  // has not confirmed yet. The sync keeps it going with the screen closed.
  | { kind: 'waiting'; name: string; reference: string; still: boolean }
  // This wallet's own credit is reserved for the name and its register's answer was lost; the
  // gateway resolves it within 30 minutes. `attempt` holds the credits that register could spend,
  // the only ones whose spending says it landed.
  | { kind: 'finishing'; name: string; attempt: string[]; still: boolean }
  // A name whose fate a failed read of the credits left open, kept in the book until a read of the
  // list answers (docs/store-bridge.md).
  | ({ kind: 'checking' } & NameCheck)
  // The credits could not be read, so what the wallet already paid for is unknown and nothing is sold.
  | { kind: 'unread' }
  // The credit was spent on the name, while the address itself could not be read.
  | { kind: 'done'; name: string }
  // The gateway refused the purchase for good. `refusal` is its status and code, which say whether
  // the store holds any money for it.
  | { kind: 'refused'; reference: string; refusal: string }
  // A refusal only a defect produces, which a person has to place.
  | { kind: 'support'; reference: string }

type Prices = Partial<Record<ProductId, string>> | 'unavailable' | null

type Props = {
  visible: boolean
  // The name typed, in the exact form registered, or empty while it is not a valid one.
  name: string
  available: boolean | null
  namesFree: boolean
  // Names refused as somebody else's in this sheet.
  taken: ReadonlySet<string>
  // The sheet's register, which finishes the sheet when it succeeds and throws when it does not.
  claim: (name: string) => Promise<void>
  // Runs a press that takes a new name through the sheet's warning about the address it replaces.
  warnBeforeChange: (go: () => void) => void
  // Finishes the sheet with an address the wallet already answers on, without registering.
  onRegistered: (addr: SparkLnAddress) => void
  onTaken: (name: string) => void
  // The sheet's one error line, so a refusal reads in the same place whichever path made it.
  onError: (message: string | null) => void
  // Whether a view other than the offer has taken over, so the sheet hides its availability line.
  onTakeover: (taking: boolean) => void
  onClose: () => void
}

const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()

// Every opening of the sheet is an instance of its own. On iOS the modal keeps its content mounted
// while it slides away, so a sheet opened again within that animation would otherwise carry the last
// opening's press, still running, whose reads would then land on this opening (I2).
export function StoreNameOffer(props: Props): React.JSX.Element {
  const [shown, setShown] = useState({ visible: props.visible, opening: 0 })
  if (props.visible !== shown.visible) {
    setShown({ visible: props.visible, opening: shown.opening + (props.visible ? 1 : 0) })
  }
  return <Offer key={shown.opening} {...props} />
}

function Offer({
  visible,
  name,
  available,
  namesFree,
  taken,
  claim,
  warnBeforeChange,
  onRegistered,
  onTaken,
  onError,
  onTakeover,
  onClose,
}: Props): React.JSX.Element {
  const { t } = useTranslation()
  const mail = useSupportMail()
  const [view, setView] = useState<View>({ kind: 'opening' })
  const [prices, setPrices] = useState<Prices>(null)
  // Null while unknown. A list that could not be read never reads as owning nothing, so every
  // decision reads it again first.
  const [credits, setCredits] = useState<StoreCredit[] | null>(null)
  const [domain, setDomain] = useState<string | null>(null)
  // The name a register lost to somebody else after the credit was chosen. The credit stays, and
  // from here only a name of its tier goes on.
  const [midway, setMidway] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Two taps in one batch both read a `busy` that still says false, and each would open the store.
  const working = useRef(false)
  // Every press and every answer the root's sync brings starts a new sequence, and what a read sent on
  // opening shows applies only while its sequence is still the current one. An answer that arrives
  // late never takes the place of what a press put on screen (docs/store-bridge.md, I2). An opening is
  // an instance of its own, so it starts at the first.
  const seq = useRef(0)
  // The credits keep a sequence of their own, which only a press moves on. An answer of the root's sync
  // settles an order and never the credits, so the open's credits still apply after it, and a support
  // case it settles still offers a credit they show (rule 4).
  const reads = useRef(0)
  // Set once this opening closes. A press still running then opens no order, spends no credit, keeps
  // or ends no check and says nothing to the sheet around it, since the next opening reads all of it
  // again. A register already sent still finishes the sheet, and a name lost to somebody else is
  // still taken, since both are the name's state whichever opening asked.
  const closed = useRef(false)
  const say = (message: string | null): void => {
    if (!closed.current) {
      onError(message)
    }
  }

  // The oldest credit the wallet holds on this domain, whatever its tier.
  const spare = credits !== null && domain !== null ? availableCredit(credits, domain) : null
  // Whether names are offered. A name on the customer's own domain costs nothing and needs no credit,
  // so unread credits stop nothing there, and a purchase that needs support blocks new charges but
  // never a credit already paid.
  const offering =
    view.kind === 'offer' ||
    ((view.kind === 'unread' || view.kind === 'opening') && namesFree) ||
    (view.kind === 'support' && spare !== null)

  useEffect(() => {
    onTakeover(!offering)
  }, [offering, onTakeover])

  // The card a mail leaves, beside the press about the same reference only.
  const supportCard = (about: string): React.JSX.Element | null => {
    const note = mail.noteFor(about)
    return note ? <SupportMailCard raised note={note} /> : null
  }

  // Runs once per instance, since every opening is an instance of its own, which starts on its
  // Skeleton with nothing read. The price is the store's for the product and no press changes it, so
  // it applies whenever it answers, and once the sheet closed it lands on an instance nobody sees.
  useEffect(() => {
    if (!visible) {
      return
    }
    loadProducts([...NAME_PRODUCTS])
      .then(found => setPrices(Object.fromEntries(found.map(p => [p.id, p.displayPrice]))))
      .catch(() => setPrices('unavailable'))
    opening(seq.current).catch(() => undefined)
    return () => {
      closed.current = true
    }
    // Runs per open; opening reads only the gateway, the book and the setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  // What the sheet shows on opening, and again after Stop waiting and on Check again when the credits
  // could not be read. What an order's answer showed survives a close and a restart
  // (docs/store-bridge.md), so a purchase still out with the store or one that needs support is never
  // bought again here. A name a failed read left open comes first, then a kept order, then a
  // reservation the gateway is resolving. The book is on the device and shows at once, before the
  // identity read, the store's list and the credits answer; until the last two have, nothing is sold.
  // `at` is the sequence this runs in.
  async function opening(at: number): Promise<void> {
    const current = (): boolean => seq.current === at
    const readsAt = reads.current
    // The domain needs no read, so the book is read before the identity, which the credits need (I1).
    const place = currentDomain()
    const [[kept], [check]] = await Promise.all([keptOrderViews('name', place), nameChecks(place)])
    if (!current()) {
      return
    }
    setDomain(place)
    const early: View | null = check ? { kind: 'checking', ...check } : kept ? viewOf(kept) : null
    if (early) {
      setView(early)
    }
    // The store's list takes away a purchase it no longer holds, which the book alone still shows.
    const refined = storeOrderViews('name', place).then(([order]) => order)
    refined.catch(() => undefined)
    let deps: StoreGatewayDeps
    try {
      deps = await currentDeps()
    } catch {
      // Without the identity the credits cannot be read, so nothing is sold. A check stays as it is,
      // and a kept order stays while the store's list still holds it.
      if (check) {
        return
      }
      const order = kept ? await refined.catch(() => undefined) : undefined
      if (current()) {
        setView(order ? viewOf(order) : { kind: 'unread' })
      }
      return
    }
    const list = await storeCredits(deps)
    if (reads.current !== readsAt) {
      return
    }
    setCredits(list)
    if (!current()) {
      return
    }
    if (list === null) {
      if (!early) {
        setView({ kind: 'unread' })
      }
      return
    }
    if (check) {
      endNameChecks(deps.domain).catch(() => undefined)
      if (spentFrom(list, check.attempt, check.name)) {
        setView({ kind: 'done', name: check.name })
        return
      }
    }
    const order = await refined
    if (!current()) {
      return
    }
    if (order) {
      setView(viewOf(order))
      return
    }
    const finishing = reservedName(list, deps.domain)
    setView(
      finishing
        ? { kind: 'finishing', name: finishing, attempt: attemptCredits(list, deps.domain, finishing), still: false }
        : { kind: 'offer' },
    )
  }

  // The root's sync settles purchases while the sheet is open. An answer about the wait on screen
  // takes its place, and a delivery goes straight on to the name the person chose when they bought it;
  // one that lands while a press runs is checked once the press is done (`missed`). A refusal or a
  // support case for another order of this domain takes the offer's place too, since a support case
  // blocks new charges whether or not the sheet was waiting on it (rule 4).
  const [missed, setMissed] = useState<string | null>(null)
  useEffect(() => {
    if (!visible) {
      return
    }
    const shown = view
    return onStoreSettled((reference, result) => {
      if (shown.kind === 'waiting' && reference === shown.reference) {
        if (result.kind === 'refused') {
          seq.current += 1
          setView({ kind: 'refused', reference, refusal: `${result.status} ${result.code}` })
        } else if (SUPPORT.has(result.kind)) {
          seq.current += 1
          setView({ kind: 'support', reference })
        } else if (result.kind === 'delivered') {
          if (working.current) {
            setMissed(reference)
          } else {
            checkWaiting(shown)
          }
        }
        return
      }
      if ((result.kind !== 'refused' && !SUPPORT.has(result.kind)) || !OPEN_VIEWS.has(shown.kind)) {
        return
      }
      const at = seq.current
      keptOrderViews('name', currentDomain())
        .then(views => {
          const order = views.find(v => v.reference === reference && (v.outcome.kind === 'refused' || v.outcome.kind === 'support'))
          if (order && seq.current === at) {
            seq.current += 1
            setView(viewOf(order))
          }
        })
        .catch(() => undefined)
    })
    // Subscribes per view; the handlers read only what the view carries and the refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, visible])

  // A delivery that landed while a press ran, checked once the press is done if its wait is still up.
  useEffect(() => {
    if (missed === null || busy) {
      return
    }
    setMissed(null)
    if (view.kind === 'waiting' && view.reference === missed) {
      checkWaiting(view)
    }
    // Runs when a missed delivery or the end of a press arrives; checkWaiting reads only the wait.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missed, busy])

  // The view an order's kept outcome showed when it arrived. A name's delivery is its credit, which
  // the offer shows from the gateway's list.
  function viewOf(order: StoreOrderView): View {
    switch (order.outcome.kind) {
      case 'waiting':
        return { kind: 'waiting', name: order.subject, reference: order.reference, still: false }
      case 'support':
        return { kind: 'support', reference: order.reference }
      case 'refused':
        return { kind: 'refused', reference: order.reference, refusal: order.outcome.refusal }
      case 'delivered':
        return { kind: 'offer' }
    }
  }

  function refusal(code: string | undefined, fallback = 'store.retry'): string {
    const key = code === undefined ? undefined : storeNameRefusalKey(code)
    if (key) {
      return t(key)
    }
    console.warn('store name purchase refused:', code)
    return t(fallback)
  }

  // Reads the credits again. A failed read keeps the last list on screen and answers null, which no
  // caller takes as owning nothing. A list that answers settles every name kept as a check, since
  // what became of each is read from it.
  async function reread(deps: StoreGatewayDeps): Promise<StoreCredit[] | null> {
    const list = await storeCredits(deps)
    if (list) {
      setCredits(list)
      setDomain(deps.domain)
      endChecks(deps.domain)
    }
    return list
  }

  // Ends every check on the domain, which a credits list that answered settles, unless this opening
  // closed, whose next opening reads the list itself.
  function endChecks(place: string): void {
    if (!closed.current) {
      endNameChecks(place).catch(() => undefined)
    }
  }

  // After the store charged or a register went out, a read that fails leaves the name's fate open. The
  // check is kept in the book, so a reopen and a restart show it again.
  function holdCheck(open: NameCheck): void {
    setView({ kind: 'checking', ...open })
    if (!closed.current) {
      keepNameCheck(open).catch(() => undefined)
    }
  }

  // Where a press lands when its answer leaves the name for another try or another name. A support
  // case or a refusal on screen is about a paid order and stays, whether the press was made beside it
  // or the root's sync put it up while the press ran (rule 4), and the press's line shows beside it.
  function backToOffer(): void {
    setView(shown => (shown.kind === 'support' || shown.kind === 'refused' ? shown : { kind: 'offer' }))
  }

  function lost(target: string): void {
    onTaken(target)
    setMidway(target)
    backToOffer()
  }

  // A pending name is this wallet's own reservation or somebody else's, and only the credit list
  // tells them apart, since the gateway answers both with the same code.
  async function pending(target: string, deps: StoreGatewayDeps): Promise<void> {
    const list = await reread(deps)
    if (list === null) {
      holdCheck({ domain: deps.domain, name: target, after: 'pending', attempt: [] })
      return
    }
    if (reservedFor(list, deps.domain, target)) {
      setView({ kind: 'finishing', name: target, attempt: attemptCredits(list, deps.domain, target), still: false })
      return
    }
    backToOffer()
    say(t('store.otherPending'))
  }

  // A register with no clear answer may have landed, so the address and then what the gateway did
  // with the credits this register could spend are read back before anything is offered.
  async function verify(target: string, deps: StoreGatewayDeps, attempt: string[]): Promise<void> {
    const held = await sparkGetLnAddress().catch(() => undefined)
    if (held && sameName(held.username, target)) {
      endChecks(deps.domain)
      onRegistered(held)
      return
    }
    const list = await reread(deps)
    if (list === null) {
      holdCheck({ domain: deps.domain, name: target, after: 'register', attempt })
      return
    }
    if (spentFrom(list, attempt, target)) {
      setView({ kind: 'done', name: target })
      return
    }
    if (reservedFor(list, deps.domain, target)) {
      setView({ kind: 'finishing', name: target, attempt, still: false })
      return
    }
    // The register never took and the credit is back. The LNURL server's own refusal of a name
    // somebody holds is no contract, so whether the name is free is measured.
    backToOffer()
    if ((await sparkCheckLnAddress(target).catch(() => null)) === false) {
      lost(target)
      return
    }
    say(t('store.retry'))
  }

  // A refusal that clears on its own carries the second it clears, which the line names. The sheet
  // sends nothing more, and the next press is the person's.
  function heldUntil(target: string, until: number): void {
    backToOffer()
    say(t('store.heldTryLater', { name: target, time: clearsAt(until, deviceDateTimePrefs()) }))
  }

  // A name that costs nothing is registered directly. Refused while another wallet holds it, the
  // register says when the hold clears, as a spend's refusal does. Refused by an exit's hold on the
  // wallet in front, which spark.ts makes before the SDK is asked, it says so with the Receive lines.
  async function registerFree(target: string): Promise<void> {
    await claim(target).catch((err: unknown) => {
      const until = gatewayRetryAt(err)
      if (until !== undefined) {
        heldUntil(target, until)
        return
      }
      const code = classifyWalletError(err)
      if (code === 'receiveHeld' || code === 'receiveHeldUnread') {
        say(t(walletErrorKey(code)))
        return
      }
      say(refusal(gatewayRefusal(err), 'receive.lnFailed'))
    })
  }

  async function spendFailed(target: string, deps: StoreGatewayDeps, attempt: string[], err: unknown): Promise<void> {
    const code = gatewayRefusal(err)
    // The register is refused before the gateway reserves any credit, so the credit stays for the next
    // press.
    const until = gatewayRetryAt(err)
    if (code !== undefined && until !== undefined) {
      heldUntil(target, until)
      return
    }
    if (code !== undefined && TAKEN.has(code)) {
      lost(target)
      await reread(deps)
      return
    }
    if (code === 'name_pending') {
      await pending(target, deps)
      return
    }
    if (code !== undefined && storeNameRefusalKey(code) !== undefined) {
      say(refusal(code))
      await reread(deps)
      return
    }
    await verify(target, deps, attempt)
  }

  // `list` is the credits read just before, which name what this register can spend.
  async function spend(target: string, deps: StoreGatewayDeps, list: StoreCredit[]): Promise<void> {
    if (closed.current) {
      return
    }
    const attempt = attemptCredits(list, deps.domain, target)
    const intent = await recordSpendIntent(deps, target)
    if (intent.kind !== 'recorded') {
      // Names the step that failed, since this often runs right after the store charged and a bare
      // failure would read as the purchase not going through. An address given up meanwhile is no
      // failure to retry: its words point at "Create the address again", as the order's do.
      const why = intent.kind === 'refused' ? intent.code : undefined
      say(why === 'too many requests' || why === 'address_removed' ? refusal(why) : t('store.spendRetry'))
      return
    }
    try {
      await claim(target)
    } catch (err) {
      await spendFailed(target, deps, attempt, err)
    }
  }

  async function settle(target: string, outcome: StoreBuyOutcome, deps: StoreGatewayDeps): Promise<void> {
    switch (outcome.kind) {
      case 'unavailable':
        say(t('store.unavailable'))
        return
      case 'orderRetry':
        say(t('store.retry'))
        return
      case 'orderRefused':
        if (outcome.retryAt !== undefined) {
          heldUntil(target, outcome.retryAt)
          return
        }
        if (FREE_NAME_CODES.has(outcome.code)) {
          await registerFree(target)
          return
        }
        if (outcome.code === 'name_pending') {
          await pending(target, deps)
          return
        }
        if (TAKEN.has(outcome.code)) {
          onTaken(target)
          return
        }
        say(refusal(outcome.code))
        return
      case 'failed':
        // A cancel leaves the person where they were, and the order's hold lapses on its own.
        if (outcome.code !== 'cancelled') {
          say(t(storeErrorKey(outcome.code) ?? 'store.retry'))
        }
        return
      case 'pending':
      case 'paidElsewhere':
        setView({ kind: 'waiting', name: target, reference: outcome.reference, still: false })
        return
      case 'settledMeanwhile': {
        // What the root's sync settled is kept in the book, or is the credit it delivered.
        const own = (await storeOrderViews('name', deps.domain)).find(order => order.reference === outcome.reference)
        if (own) {
          setView(viewOf(own))
          return
        }
        const list = await reread(deps)
        if (list === null) {
          holdCheck({ domain: deps.domain, name: target, after: 'settled', attempt: [] })
        } else if (creditFor(list, deps.domain, target)) {
          await spend(target, deps, list)
        }
        return
      }
      case 'settled':
        switch (outcome.result.kind) {
          case 'delivered': {
            // A register is sent only with the credits read first, or a lost answer could never be
            // told apart from a credit spent on this name before. The store charged, so a list that
            // cannot be read is the check, which spends the credit once the list answers.
            const list = await reread(deps)
            if (list === null) {
              holdCheck({ domain: deps.domain, name: target, after: 'delivered', attempt: [] })
              return
            }
            await spend(target, deps, list)
            return
          }
          case 'refused':
            setView({
              kind: 'refused',
              reference: outcome.reference,
              refusal: `${outcome.result.status} ${outcome.result.code}`,
            })
            return
          case 'support':
          case 'unknownOrder':
          case 'noReference':
            setView({ kind: 'support', reference: outcome.reference })
            return
          default:
            setView({ kind: 'waiting', name: target, reference: outcome.reference, still: false })
        }
    }
  }

  // `checking` marks a Check again. Its view already says to check again about a purchase that may be
  // paid, so a check that cannot run leaves that view as it was and never says the purchase failed.
  async function guarded(task: () => Promise<void>, checking = false): Promise<void> {
    if (working.current) {
      return
    }
    working.current = true
    seq.current += 1
    reads.current += 1
    setBusy(true)
    say(null)
    try {
      await task()
    } catch (err) {
      console.warn('store name purchase failed:', (err as Error)?.message ?? err)
      if (!checking) {
        say(t('store.retry'))
      }
    } finally {
      working.current = false
      setBusy(false)
    }
  }

  // The one press of the offer. A credit that already pays for the name is spent; otherwise Buy opens
  // the store. `using` is a press on Use this name, which never opens the store (docs/store-bridge.md,
  // I3). A name on the customer's own domain costs nothing and is registered directly.
  const act = (using: boolean): Promise<void> =>
    guarded(async () => {
      if (namesFree) {
        await registerFree(name)
        return
      }
      if (taken.has(name)) {
        return
      }
      const deps = await currentDeps()
      const list = await reread(deps)
      if (list === null) {
        setView({ kind: 'unread' })
        return
      }
      if (reservedFor(list, deps.domain, name)) {
        setView({ kind: 'finishing', name, attempt: attemptCredits(list, deps.domain, name), still: false })
        return
      }
      if (creditFor(list, deps.domain, name)) {
        await spend(name, deps, list)
        return
      }
      // The credit the label named is gone by the press, so the sheet shows what the list says, the
      // price, and opening the store is the next press, on Buy.
      if (using) {
        say(t('store.creditGone'))
        return
      }
      const [kept] = await storeOrderViews('name', deps.domain)
      if (kept) {
        setView(viewOf(kept))
        return
      }
      if (closed.current) {
        return
      }
      await settle(name, await buyInStore('name', name, undefined, false, () => !closed.current), deps)
    })

  // Settles what the store holds open, then spends the credit the purchase delivered, if it has. A
  // refusal or a purchase that needs support stays on screen as the book kept it, and no other credit
  // is spent on the name in its place. An answer the root's sync brings about the wait meanwhile takes
  // the wait's place and moves the sequence on, and what this check read before it then applies
  // nothing (I2). The sync writes the book before the sheet hears it, so an outcome read from the views
  // is the one the sync showed.
  const checkWaiting = (waiting: Extract<View, { kind: 'waiting' }>): Promise<void> =>
    guarded(async () => {
      const at = seq.current
      await syncStorePurchases(liveStoreContext())
      const deps = await currentDeps()
      const kept = await storeOrderViews('name', deps.domain)
      const own = kept.find(order => order.reference === waiting.reference)
      if (own && own.outcome.kind !== 'waiting') {
        setView(viewOf(own))
        // A purchase that needs support blocks new charges and never a credit the wallet holds, which
        // only the credits show (rule 4).
        if (own.outcome.kind === 'support') {
          await reread(deps)
        }
        return
      }
      const list = await reread(deps)
      if (seq.current !== at) {
        return
      }
      if (list && creditFor(list, deps.domain, waiting.name)) {
        setView({ kind: 'offer' })
        await spend(waiting.name, deps, list)
        return
      }
      if (own) {
        setView({ ...waiting, still: true })
        return
      }
      // The store let the purchase go, and a list that cannot be read cannot say whether it delivered.
      if (list === null) {
        holdCheck({ domain: deps.domain, name: waiting.name, after: 'settled', attempt: [] })
        return
      }
      // The store holds nothing open for it, so what else the book keeps, or the offer, is the truth.
      setView(kept[0] ? viewOf(kept[0]) : { kind: 'offer' })
    }, true)

  // What else the book keeps, or the offer, takes the wait's place, read again as on opening, since
  // the credits the open read may not have answered.
  const stopWaiting = (waiting: Extract<View, { kind: 'waiting' }>): Promise<void> =>
    guarded(async () => {
      await dropStoreWait(waiting.reference)
      setView({ kind: 'opening' })
      await opening(seq.current)
    })

  // The register may have landed, which the address shows, or the gateway may have handed the
  // credit back, which the list shows.
  const checkFinishing = (finishing: Extract<View, { kind: 'finishing' }>): Promise<void> =>
    guarded(async () => {
      const held = await sparkGetLnAddress().catch(() => undefined)
      if (held && sameName(held.username, finishing.name)) {
        onRegistered(held)
        return
      }
      const deps = await currentDeps()
      const list = await reread(deps)
      if (list === null || reservedFor(list, deps.domain, finishing.name)) {
        setView({ ...finishing, still: true })
        return
      }
      setView(spentFrom(list, finishing.attempt, finishing.name) ? { kind: 'done', name: finishing.name } : { kind: 'offer' })
    }, true)

  // A credit the gateway delivered, or may have, while the list could not be read. Once the list
  // answers it is spent on the name it was bought for.
  async function spendDelivered(target: string, deps: StoreGatewayDeps): Promise<void> {
    const list = await reread(deps)
    if (list === null) {
      return
    }
    if (reservedFor(list, deps.domain, target)) {
      setView({ kind: 'finishing', name: target, attempt: attemptCredits(list, deps.domain, target), still: false })
      return
    }
    setView({ kind: 'offer' })
    if (creditFor(list, deps.domain, target)) {
      await spend(target, deps, list)
    }
  }

  const checkAgain = (checking: Extract<View, { kind: 'checking' | 'unread' }>): Promise<void> =>
    guarded(async () => {
      if (checking.kind === 'unread') {
        await opening(seq.current)
        return
      }
      const deps = await currentDeps()
      if (checking.after === 'register') {
        await verify(checking.name, deps, checking.attempt)
      } else if (checking.after === 'pending') {
        await pending(checking.name, deps)
      } else {
        await spendDelivered(checking.name, deps)
      }
    }, true)

  async function sendToSupport(reference: string): Promise<void> {
    const deps = await currentDeps().catch(() => null)
    const body = t('recover.mailBody', { pubkey: deps?.pubkey ?? '', reference })
    await mail.open(helpMailUrl(t('recover.mailSubject'), body), body, reference)
  }

  const closeButton = <GradientButton variant="secondary" label={t('common.close')} onPress={onClose} />

  // Closing a refusal is the person having read it, so it is not shown again.
  const closeRefused = (reference: string): void => {
    dismissStoreOutcome(reference)
      .catch(() => undefined)
      .then(onClose)
  }

  // The shape of the offer, its price, the line under it and its button, until the credits answer.
  if (view.kind === 'opening' && !namesFree) {
    return (
      <>
        <Skeleton width="60%" height={font.leading.base} style={styles.priceSkeleton} />
        <Skeleton width="80%" height={font.leading.sm} style={styles.lineSkeleton} />
        <Skeleton height={touch.action} borderRadius={radius.md} />
      </>
    )
  }
  if (view.kind === 'waiting') {
    return (
      <>
        <Txt role="bodyStrong" tone="default" style={styles.centre}>
          {t('store.waitingTitle')}
        </Txt>
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.waitingBody', { name: view.name })}
        </Txt>
        {view.still ? (
          <Txt role="caption" tone="muted" style={styles.centre}>
            {t('store.notYet')}
          </Txt>
        ) : null}
        <GradientButton label={t('receive.lnCheckAgain')} onPress={() => checkWaiting(view)} loading={busy} />
        <GradientButton variant="secondary" label={t('store.stopWaiting')} onPress={() => stopWaiting(view)} />
      </>
    )
  }
  if (view.kind === 'finishing') {
    return (
      <>
        <Txt role="body" tone="default" style={styles.centre}>
          {t('store.ownPending', { name: view.name })}
        </Txt>
        {view.still ? (
          <Txt role="caption" tone="muted" style={styles.centre}>
            {t('store.notYet')}
          </Txt>
        ) : null}
        <GradientButton label={t('receive.lnCheckAgain')} onPress={() => checkFinishing(view)} loading={busy} />
      </>
    )
  }
  if (view.kind === 'checking' || (view.kind === 'unread' && !namesFree)) {
    const checking = view
    return (
      <>
        <Txt role="body" tone="default" style={styles.centre}>
          {checking.kind === 'unread'
            ? t('store.unread')
            : t(checking.after === 'delivered' ? 'store.checkingPaid' : 'store.checking', { name: checking.name })}
        </Txt>
        <GradientButton label={t('receive.lnCheckAgain')} onPress={() => checkAgain(checking)} loading={busy} />
      </>
    )
  }
  if (view.kind === 'done') {
    return (
      <>
        <Txt role="body" tone="default" style={styles.centre}>
          {t('store.done', { address: domain ? `${view.name}@${domain}` : view.name })}
        </Txt>
        {closeButton}
      </>
    )
  }
  if (view.kind === 'refused') {
    const reference = view.reference
    return (
      <>
        <Txt role="bodyStrong" tone="default" style={styles.centre}>
          {t('store.refusedTitle')}
        </Txt>
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t(storeRefusedKey(view.refusal, currentStore()))}
        </Txt>
        <GradientButton variant="secondary" label={t('common.close')} onPress={() => closeRefused(reference)} />
      </>
    )
  }
  if (view.kind === 'support' && spare === null) {
    const reference = view.reference
    return (
      <>
        <Txt role="body" tone="default" style={styles.centre}>
          {t('store.support')}
        </Txt>
        <GradientButton label={t('recover.sendToSupport')} onPress={() => sendToSupport(reference)} />
        {supportCard(reference)}
        {closeButton}
      </>
    )
  }

  const tier = name === '' ? null : nameTier(name)
  const ready = name !== '' && available === true
  // A credit that pays for the name typed, once the name checks out.
  const match = tier !== null && credits !== null && domain !== null ? creditFor(credits, domain, name) : null
  const wouldCover = match !== null
  const covering = ready ? match : null
  // A purchase that needs support stays on screen beside the credit, and nothing new is sold.
  const support = view.kind === 'support' ? view.reference : null
  // Use this name spends a credit, and Buy opens the store.
  const using = namesFree || wouldCover || (spare !== null && tier === null)
  const price = prices !== null && prices !== 'unavailable' && name !== '' ? prices[nameProduct(name)] : undefined
  // Nothing is for sale when the bridge is missing or the store does not offer this length.
  const unsellable = prices === 'unavailable' || (prices !== null && name !== '' && price === undefined)
  // After a name was lost midway the credit is the way forward, and a name it does not pay for is
  // never a quiet second purchase. A name refused as taken is never offered.
  const button =
    !taken.has(name) &&
    !(midway !== null && spare !== null && tier !== null && !wouldCover) &&
    (support === null || wouldCover || tier === null)
  const selling = ready && button && !namesFree && !wouldCover

  return (
    <>
      {support !== null ? (
        <>
          <Txt role="body" tone="default" style={styles.centre}>
            {t('store.support')}
          </Txt>
          <GradientButton variant="secondary" label={t('recover.sendToSupport')} onPress={() => sendToSupport(support)} />
          {supportCard(support)}
        </>
      ) : null}
      {midway !== null && spare !== null ? (
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.takenMidway', { name: midway, length: t(LENGTH_KEY[spare.tier]) })}
        </Txt>
      ) : spare !== null && tier === null ? (
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.creditReady', { length: t(LENGTH_KEY[spare.tier]) })}
        </Txt>
      ) : null}
      {spare !== null && tier !== null && !wouldCover ? (
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.notCovered', { length: t(LENGTH_KEY[spare.tier]) })}
        </Txt>
      ) : null}
      {covering !== null ? (
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.covered')}
        </Txt>
      ) : null}
      {selling && !unsellable ? (
        <>
          {price === undefined ? (
            <Skeleton width="60%" height={font.leading.base} style={styles.priceSkeleton} />
          ) : (
            <Txt role="heading" tone="default" style={styles.centre}>
              {t('store.namePrice', { name, price })}
            </Txt>
          )}
          <Txt role="caption" tone="muted" style={styles.centre}>
            {t('receive.lnPriceWhy')}
          </Txt>
          <Txt role="caption" tone="muted" style={styles.centre}>
            {t(payLineKey(currentStore()))}
          </Txt>
        </>
      ) : null}
      {selling && unsellable ? (
        <Txt role="caption" tone="muted" style={styles.centre}>
          {t('store.unavailable')}
        </Txt>
      ) : null}
      {button ? (
        <GradientButton
          label={t(using ? 'receive.lnUseName' : 'store.buyName')}
          // Whatever pays for it, a press here takes a new name. A paid purchase comes back by the sync
          // or by Check again, never by this press.
          onPress={() => warnBeforeChange(() => act(using))}
          disabled={!ready || (selling && (unsellable || price === undefined))}
          loading={busy}
        />
      ) : null}
    </>
  )
}

const styles = StyleSheet.create({
  centre: { textAlign: 'center' },
  priceSkeleton: { alignSelf: 'center', marginVertical: space.xs },
  lineSkeleton: { alignSelf: 'center' },
})
