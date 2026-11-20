import React, { Profiler } from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text, TextInput } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { GradientButton } from '../src/components/GradientButton'
import { Skeleton } from '../src/components/Skeleton'
import { SupportMailCard } from '../src/components/SupportMail'
import { claimDomain, confirmDomain, fetchPrices, quoteDomain, type OnboardState, type OnboardStatus } from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkGetIdentityPubkey, sparkPrepareSend } from '../src/wallet/spark'
import { reconnectActiveWallet } from '../src/wallet/wallet'
import { currentDeps } from '../src/wallet/namePurchase'
import { liveStoreContext, syncStorePurchases, type StoreContext } from '../src/wallet/storePurchase'
import { formatDate } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import type { NativeBuyResult, NativeProduct, NativePurchase } from '../specs/NativeVoltzStore'

// The schedule harness of the domain year (docs/store-bridge.md, "Reads and invariants"). It drives
// the real UseMyDomainScreen, on the first-year form and on the renewal, against the real store flow,
// with the identity read, the claim, every gateway route, every store call and the wallet's
// reconnect held as a deferred this file settles. For each plan it plays every order of the settles,
// with the plan's presses and events inserted at every position, and after every step it checks one
// oracle per invariant, O6 liveness and O7 no false denial. A second press lands at every position
// too, between the first press and each of its settles as well as after them. A group of plans runs
// the build that pays in sats, for O7's clause about it.
//
// The poll of the DNS steps runs on a timer. Timers are held too, and one tick of the poll is an event
// the harness places like a settle, at most once per schedule.
//
// The book (store-orders.json) is read from the in-memory file system. The screen's first read of it
// is held like the others, since nothing may be sold before it answers; every later one answers at
// once, the way the device's disk answers ahead of any network read, and every write lands. The file
// of a sats payment owed answers at once too.
//
// Events beside the settles and the presses:
// - The root's sync with no press, whose list read, identity read and confirmation are held, settling
//   the plan's verdict.
// - Send to support, the DNS steps' Check again and the reconnect's Try again, which supersede
//   nothing, since the first opens the mail and adds only the support card on screen, and the other
//   two each read again only what they show.
// - Typing a domain, once, either the one the book is about or another; and the place toggle, once.
// - On the sats build, the recovery filing a proof of a payment owed, once.
//
// Outcome values pruned, and why:
// - The price always answers with a price. A store that cannot price keeps Pay disabled and only the
//   step inside buyYear closed (rule 5), which useMyDomainStore.test.tsx covers. Its order against
//   the other reads is still enumerated.
// - The store's open list answers or never answers, and never fails. storeOrderViews holds every
//   purchase on a list it cannot read, which shows what `listed` shows, and syncStorePurchases reads a
//   list it cannot read as empty, which shows what `empty` shows. A list read after the open always
//   answers, so the root's sync always settles.
// - The claim answers a status (awaiting the record, or active), the gateway's refusal for an unpaid
//   year or for a domain another wallet holds, or a failure on the connection. Its other refusals each
//   pick one line through reason(), which the hand-written tests drive.
// - A press's own store reads answer one value each. The order handed out is the one the book holds
//   for the host while it is open and another otherwise, and the store answers Ask to Buy. Their
//   refusals each set one error line and open nothing, which the hand-written tests drive; one plan
//   has the order refused with a code this build does not know, the one refusal whose line comes
//   from a fallback.
// - A confirmation's `retry` verdict is a 503 whose three retries inside sendSigned answer at once,
//   since the screens read only the verdict. noReference, otherWallet and noWallet never reach a
//   screen through a sync here (see the name harness for why).
// - A book write never fails; dropStoreWait and dismissStoreOutcome are caught on this screen.
// - On the sats build the balance answers at once with enough, and the send never throws. Too little
//   balance clears the record and says errors.insufficientFunds before any send, and a send that throws
//   is decided by the record on disk, both of which useMyDomainRenew.test.tsx drives.
// - Share, the clipboard, the support mail and the help toggle change nothing a purchase reads.
// - Plans come in groups. Each group holds the reads and inserts the events that decide what it
//   checks, and every other read answers at once, so the schedules grow by group and not by product
//   (see PLANS).

const HOST = 'pay.bakery.com.br'
const ROOT = 'bakery.com.br'
const OTHER_ROOT = 'other.com.br'
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
const REF_C = '5a1b4c0e-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
const SATS_REF = 'sats-ref-1'
const OWED_REF = 'sats-owed-1'
const PRICE = 'US$ 99.99'
const PUBKEY = `02${'a'.repeat(64)}`
const LATER = Math.floor(Date.now() / 1000) + 365 * 86_400

let mockBuild: 'store' | 'direct' = 'store'
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => mockBuild }))

let mockParams: { renew?: string } | undefined
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: mockParams }) }))

jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => 'usevoltz.app'),
  sparkGetIdentityPubkey: jest.fn(),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(),
  sparkConfirmSend: jest.fn(),
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkConnectedWalletId: () => 'w_a',
  onSparkConnected: () => () => undefined,
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({ wallets: [{ id: 'w_a' }], activeId: 'w_a' })),
  getActiveWalletId: jest.fn(async () => 'w_a'),
}))

jest.mock('../src/wallet/wallet', () => ({ reconnectActiveWallet: jest.fn() }))

jest.mock('../src/wallet/domainOnboard', () => {
  const real = jest.requireActual('../src/wallet/domainOnboard')
  return { ...real, claimDomain: jest.fn(), quoteDomain: jest.fn(), confirmDomain: jest.fn(), fetchPrices: jest.fn() }
})

// The button keeps its props, which the harness reads (label, disabled, loading, onPress), and drops
// the gradient and the spinner, which cost a render on every step and decide nothing here.
jest.mock('../src/components/GradientButton', () => ({ GradientButton: () => null }))

// The gateway's retries wait in the app and not here.
jest.mock('../src/wallet/namePurchase', () => {
  const real = jest.requireActual('../src/wallet/namePurchase')
  return { ...real, currentDeps: async () => ({ ...(await real.currentDeps()), sleep: async () => undefined }) }
})

// The screen's own writes to the book, and the purchase that opens an order, are reported to O2, which
// tells an earlier press's write after a later press from what the store flow writes for a verdict. A
// verdict is a fact about the order, written whichever press asked.
let mockWrote: (fn: string) => void = () => undefined
jest.mock('../src/wallet/storePurchase', () => {
  const real = jest.requireActual('../src/wallet/storePurchase') as Record<string, (...args: unknown[]) => unknown>
  const reported =
    (fn: string) =>
    (...args: unknown[]) => {
      mockWrote(fn)
      return real[fn]!(...args)
    }
  return { ...real, dropStoreWait: reported('dropStoreWait'), dismissStoreOutcome: reported('dismissStoreOutcome'), buyInStore: reported('buyInStore') }
})

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
const double = jest.requireMock('../specs/NativeVoltzStore') as Double
const RNFS = (require('react-native-fs') as {
  default: {
    DocumentDirectoryPath: string
    exists(p: string): Promise<boolean>
    readFile(p: string): Promise<string>
    writeFile(p: string, c: string): Promise<void>
    __reset(): void
  }
}).default
const fileExists = RNFS.exists.bind(RNFS)
const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
const PENDING_FILE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>
const fill = (text: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((out, [k, v]) => out.split(`{{${k}}}`).join(v), text)

const LABEL = {
  pay: en.useDomain.pay!,
  continue: en.useDomain.continue!,
  check: en.receive.lnCheckAgain!,
  stop: en.store.stopWaiting!,
  close: en.common.close!,
  requote: en.useDomain.requote!,
  support: en.recover.sendToSupport!,
  retry: en.common.retry!,
}
// The buttons a press may land on.
const PRESSABLE = new Set(Object.values(LABEL))
const PRICE_LINE = fill(en.useDomain.priceLine!, { price: PRICE })
const RENEWED = fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(LATER, deviceDateTimePrefs()) })

type Screen = 'renewal' | 'first year'
type Kept = 'nothing' | 'check' | 'askToBuy' | 'paidWait' | 'support' | 'refusal' | 'delivered' | 'dropped'
const IN_FLIGHT: Partial<Record<Kept, string>> = {
  askToBuy: en.store.waitingTitle!,
  paidWait: en.store.waitingTitle!,
  support: en.store.support!,
  refusal: en.store.refusedTitle!,
}
// Lines that say a purchase failed or may not have gone through.
const FAILURE_LINES = [en.useDomain.confirmFailed!, en.useDomain.payFailed!, en.useDomain.tierNotPaid!, en.store.retry!]
// The lines O7 looks for, every one whose text says nothing was charged or the payment did not go
// through. A test purchase's refusal is the gateway's verified answer that the store charged
// nothing, so it may show beside that refusal and nowhere else.
const DENIALS = [en.useDomain.payFailed!, en.receive.lnPayFailed!, en.store.refusedTest!]
const TEST_REFUSALS = new Set(['403 environment_not_allowed', '403 xcode_environment'])
const NAMES_CONNECTION = /connection/i
// What the DNS steps say for each state the poll can read.
const STATE_LINE: Partial<Record<OnboardState, string>> = { awaiting_dns: en.useDomain.waiting!, active: en.useDomain.active! }
// Every line that stands for the status, of which the steps show exactly one.
const STATUS_LINES = [en.useDomain.waiting!, en.useDomain.active!, en.useDomain.adopting!, en.useDomain.adoptFailed].filter(
  (line): line is string => line !== undefined,
)

const purchase: NativePurchase = {
  productIds: ['domain_year'],
  key: 'tx-1',
  reference: REF.toUpperCase(),
  state: 'purchased',
  purchasedAt: 1,
  verified: true,
  revoked: false,
}

function bookOf(kept: Kept, renewal: boolean, frozen: boolean): object {
  const opened = { orders: { [REF]: 'w_a' }, about: { [REF]: { kind: 'tier', place: HOST, subject: HOST, renewal } } }
  switch (kept) {
    case 'nothing':
      return {}
    case 'check':
      return {
        checks: { 'w_a usevoltz.app pay': { domain: 'usevoltz.app', name: 'pay', after: 'delivered', attempt: [], wallet: 'w_a' } },
      }
    case 'askToBuy':
      // An Ask to Buy on Apple, which has no transaction until it is approved.
      return { ...opened, bought: { [REF]: 'pending' } }
    case 'paidWait':
      // A paid purchase the gateway has not confirmed, which the store's list holds.
      return { ...opened, bought: { [REF]: 'purchased' } }
    case 'support':
      return { ...opened, outcomes: { [REF]: { kind: 'support', code: 'wrong_bundle' } } }
    case 'refusal':
      return { ...opened, outcomes: { [REF]: { kind: 'refused', refusal: '409 refused' } } }
    case 'delivered':
      return { ...opened, outcomes: { [REF]: { kind: 'delivered', host: HOST, expiresAt: LATER, frozen } } }
    case 'dropped':
      // An order whose wait was left with Stop waiting while the store still lists its purchase, which
      // the root's sync then confirms.
      return opened
  }
}

type Listing = 'listed' | 'empty' | 'never'
// What one claim answers, which is a status awaiting the record or an active one, the gateway's
// refusal of an unpaid year or of a domain another wallet holds, a failure on the connection, or
// nothing.
type Claim = 'live' | 'active' | 'notPaid' | 'taken' | 'fails' | 'never'
type Verdict = 'delivered' | 'refunded' | 'support' | 'unknownOrder' | 'pending' | 'notVerified' | 'later' | 'retry'
const VERDICTS: Verdict[] = ['delivered', 'refunded', 'support', 'unknownOrder', 'pending', 'notVerified', 'later', 'retry']
type Identity = 'answers' | 'failsOpen' | 'failsPress'

type Route = 'book' | 'products' | 'identity' | 'openList' | 'claim' | 'order' | 'buy' | 'confirm' | 'adopt' | 'prices' | 'quote' | 'prepare' | 'send' | 'grant'
// The routes the base group holds; the identity read answers at once there.
const BASE_HELD: Route[] = ['book', 'products', 'openList', 'claim', 'order', 'buy', 'confirm']

type Plan = {
  group: string
  build: 'store' | 'direct'
  screen: Screen
  kept: Kept
  // The flag of the order the book keeps, which screen opened it, and whether its delivered year was
  // off the edge.
  renewal: boolean
  frozen: boolean
  lists: [Listing, Exclude<Listing, 'never'>]
  // The n-th claim answers claims[n], and every later one the last.
  claims: Claim[]
  verdict: Verdict
  // Whether the order route answers with an order or refuses with a code this build does not know.
  order: 'order' | 'refused'
  identity: Identity
  // The wallet's reconnect after the domain answers active, the n-th answering adopt[n] and every
  // later one the last.
  adopt: Array<'answers' | 'fails'>
  sync: boolean
  // Whether one tick of the DNS steps' poll is an event.
  tick: boolean
  presses: number
  // 'start' types the book's domain before anything answers, 'event' offers typing it or another
  // domain once, and 'none' leaves the form to what the book puts back.
  typing: 'start' | 'event' | 'none'
  toggle: boolean
  // On the sats build, whether the recovery files a proof once, and what the quotes (the n-th answers
  // quotes[n]), the prepare, the send and the confirmation answer.
  recover: boolean
  quotes: Array<'answers' | 'fails'>
  prepare: 'answers' | 'insufficient'
  send: 'complete' | 'failed'
  grant: 'grants' | 'waits' | 'fails'
  // The routes whose reads are held and settled in every order; every other read answers at once,
  // which is the order a read that interacts with nothing the group checks takes on a device.
  held: Route[]
}

const planOf = (over: Partial<Plan> & Pick<Plan, 'group' | 'screen' | 'kept'>): Plan => ({
  build: 'store',
  renewal: false,
  frozen: false,
  lists: ['empty', 'empty'],
  claims: ['live'],
  verdict: 'later',
  order: 'order',
  identity: 'answers',
  adopt: ['answers'],
  sync: false,
  tick: true,
  presses: 1,
  typing: over.screen === 'first year' ? 'start' : 'none',
  toggle: false,
  recover: false,
  quotes: ['answers'],
  prepare: 'answers',
  send: 'complete',
  grant: 'grants',
  held: BASE_HELD,
  ...over,
})

// An unsettled order is shown on open by both screens when the first year opened it, and only by the
// renewal when the renewal did (docs/store-bridge.md, rule 3). A delivered year only by its own screen.
const shownOnOpen = (p: Pick<Plan, 'screen' | 'kept' | 'renewal'>): boolean =>
  p.kept === 'delivered' ? p.renewal === (p.screen === 'renewal') : IN_FLIGHT[p.kept] !== undefined && (p.screen === 'renewal' || !p.renewal)

type Lists = [Listing, Exclude<Listing, 'never'>]
const BASE_LISTS: Partial<Record<Kept, Lists[]>> = {
  askToBuy: [
    ['empty', 'empty'],
    ['never', 'empty'],
  ],
  support: [
    ['listed', 'listed'],
    ['empty', 'empty'],
    ['never', 'listed'],
  ],
}

function basePlans(screen: Screen, kept: Kept, renewal: boolean): Plan[] {
  const own = kept === 'delivered' && renewal === (screen === 'renewal')
  // The renewal's claim is sent on open and picks a line; the first-year form sends its claim on
  // Continue, and a delivered year's DNS steps poll it.
  const claims: Claim[][] =
    screen === 'renewal'
      ? own
        ? [['live'], ['fails', 'live']]
        : [['live'], ['fails', 'live'], ['never', 'live']]
      : own
        ? [['live'], ['fails', 'live']]
        : [['notPaid'], ['live'], ['fails']]
  // The first-year form is typed into unless the book puts a first-year order's host back.
  const typing = screen === 'first year' && !renewal && kept !== 'nothing' && kept !== 'check' ? 'none' : undefined
  return (BASE_LISTS[kept] ?? [['empty', 'empty'] as Lists]).flatMap(lists =>
    claims.map(c => planOf({ group: 'base', screen, kept, renewal, lists, claims: c, ...(typing ? { typing } : {}) })),
  )
}

// What each group holds. A verdict group holds the store's list and the confirmation, the poll group
// the claim and the reconnect, and the sats group every read on the way to a payment but the price.
const VERDICT_HELD: Route[] = ['openList', 'confirm']
// The root's sync matters by when its confirmation answers against a press, so only that is held.
const SYNC_HELD: Route[] = ['confirm']
const POLL_HELD: Route[] = ['claim', 'adopt']
const SATS_HELD: Route[] = ['claim', 'quote', 'prepare', 'send', 'grant']

// Each screen with the order it opened itself, and the claim its press sends.
const OWN: Array<{ screen: Screen; renewal: boolean; claims: Claim[] }> = [
  { screen: 'renewal', renewal: true, claims: ['live'] },
  { screen: 'first year', renewal: false, claims: ['notPaid'] },
]

const PLANS: Plan[] = [
  // Every kept outcome on both screens, the identity read answering at once.
  ...(['renewal', 'first year'] as const).flatMap(screen =>
    (['nothing', 'check', 'askToBuy', 'support', 'refusal', 'delivered'] as const).flatMap(kept =>
      (kept === 'nothing' || kept === 'check' ? [false] : [true, false]).flatMap(renewal => basePlans(screen, kept, renewal)),
    ),
  ),
  // A paid wait, and every confirmation verdict inside Check again.
  ...OWN.flatMap(({ screen, renewal, claims }) => [
    ...(['listed', 'never'] as const).flatMap(first =>
      VERDICTS.map(verdict =>
        planOf({ group: 'check verdict', screen, kept: 'paidWait', renewal, lists: [first, 'listed'], verdict, claims, typing: 'none', tick: false, held: VERDICT_HELD }),
      ),
    ),
    ...(['listed', 'never', 'empty'] as const).map(first =>
      planOf({ group: 'check verdict', screen, kept: 'paidWait', renewal, lists: [first, 'empty'], claims, typing: 'none', tick: false, held: VERDICT_HELD }),
    ),
    planOf({ group: 'check verdict', screen, kept: 'paidWait', renewal, lists: ['listed', 'listed'], identity: 'failsPress', claims, typing: 'none', tick: false, held: VERDICT_HELD }),
  ]),
  // The root's sync with no press, settling every verdict.
  ...OWN.flatMap(({ screen, renewal, claims }) => [
    ...VERDICTS.map(verdict =>
      planOf({ group: 'sync', screen, kept: 'paidWait', renewal, lists: ['listed', 'listed'], verdict, claims, sync: true, typing: 'none', tick: false, held: SYNC_HELD }),
    ),
    ...(['delivered', 'support', 'refunded'] as Verdict[]).map(verdict =>
      planOf({ group: 'sync', screen, kept: 'askToBuy', renewal, lists: ['empty', 'listed'], verdict, claims, sync: true, typing: 'none', tick: false, held: SYNC_HELD }),
    ),
  ]),
  // A second press at every point after the first, its reads still out or answered. A paid wait the
  // store still lists is checked under the verdicts that leave it waiting, end it in a refusal and
  // end it in a support case, so Stop waiting, Close and Send to support each land inside a Check again.
  ...OWN.flatMap(({ screen, renewal, claims }) =>
    ([
      ['askToBuy', ['empty', 'empty'], 'later'],
      ['paidWait', ['listed', 'empty'], 'later'],
      ['paidWait', ['listed', 'listed'], 'pending'],
      ['paidWait', ['listed', 'listed'], 'refunded'],
      ['paidWait', ['listed', 'listed'], 'support'],
      ['support', ['listed', 'listed'], 'later'],
      ['refusal', ['empty', 'empty'], 'later'],
    ] as Array<[Kept, Lists, Verdict]>).map(([kept, lists, verdict]) =>
      planOf({ group: 'second press', screen, kept, renewal, lists, verdict, claims, presses: 2, typing: 'none', tick: false, held: ['openList', 'confirm', 'claim'] }),
    ),
  ),
  // The first-year form against a renewal's unsettled order, with its domain or another typed, and
  // the place toggle.
  ...([
    ['nothing', ['empty', 'empty']],
    ['askToBuy', ['empty', 'empty']],
    ['paidWait', ['listed', 'listed']],
    ['support', ['listed', 'listed']],
    ['refusal', ['empty', 'empty']],
  ] as Array<[Kept, Lists]>).map(([kept, lists]) =>
    planOf({
      group: 'typing',
      screen: 'first year',
      kept,
      renewal: kept !== 'nothing',
      lists,
      claims: ['notPaid'],
      typing: 'event',
      toggle: true,
      held: ['book', 'openList', 'claim'],
    }),
  ),
  // The identity read failing from the open on.
  ...OWN.flatMap(({ screen, renewal, claims }) =>
    ([
      ['nothing', ['empty', 'empty']],
      ['paidWait', ['listed', 'listed']],
      ['support', ['listed', 'listed']],
    ] as Array<[Kept, Lists]>).map(([kept, lists]) =>
      planOf({
        group: 'identity',
        screen,
        kept,
        renewal: kept === 'nothing' ? false : renewal,
        lists,
        claims,
        identity: 'failsOpen',
        typing: screen === 'first year' && kept === 'nothing' ? 'start' : 'none',
        held: ['identity', 'book', 'openList', 'claim'],
      }),
    ),
  ),
  // The root's sync settling an order the book keeps with no wait, while the screen's own purchase
  // press is out, so the refusal, the support case or the delivered year it brings meets a press still
  // running. One plan has that press refused with a code this build does not know, whose line meets
  // the delivered year.
  ...OWN.flatMap(({ screen, renewal, claims }) => {
    const sync: Partial<Plan> & Pick<Plan, 'group' | 'screen' | 'kept'> = {
      group: 'sync another',
      screen,
      kept: 'dropped',
      renewal,
      lists: ['listed', 'listed'],
      claims,
      sync: true,
      presses: 2,
      typing: screen === 'first year' ? 'start' : 'none',
      tick: false,
    }
    return [
      ...(['refunded', 'support', 'delivered'] as Verdict[]).map(verdict => planOf({ ...sync, verdict, held: ['order', 'buy', 'confirm'] })),
      planOf({ ...sync, verdict: 'delivered', order: 'refused', held: ['order', 'confirm'] }),
    ]
  }),
  // An order refused with a code this build does not know, which opened nothing and charged nothing.
  ...OWN.map(({ screen, claims }) => planOf({ group: 'identity', screen, kept: 'nothing', claims, order: 'refused', held: ['book', 'openList', 'claim'] })),
  // The identity read failing from the first press on, under each screen's own press.
  ...OWN.map(({ screen, claims }) =>
    planOf({ group: 'identity', screen, kept: 'nothing', claims, identity: 'failsPress', held: ['identity', 'book', 'openList', 'claim'] }),
  ),
  // The DNS steps' poll, and the wallet's reconnect once the domain answers.
  ...([['fails', 'live'], ['live', 'fails'], ['taken', 'live'], ['fails', 'active']] as Claim[][]).map(claims =>
    planOf({ group: 'poll', screen: 'first year', kept: 'delivered', claims, typing: 'none', held: POLL_HELD }),
  ),
  // The reconnect answering, failing for good, and failing once before Try again lands it.
  ...([['answers'], ['fails'], ['fails', 'answers']] as Array<Plan['adopt']>).map(adopt =>
    planOf({ group: 'poll', screen: 'first year', kept: 'delivered', claims: ['active'], adopt, typing: 'none', held: POLL_HELD }),
  ),
  ...([['fails', 'live'], ['live', 'fails']] as Claim[][]).map(claims =>
    planOf({ group: 'poll', screen: 'renewal', kept: 'delivered', renewal: true, frozen: true, claims, held: POLL_HELD }),
  ),
  // A renewal that was off the edge whose domain answers, with the reconnect answering, failing for
  // good, and failing once before Try again lands it.
  ...([['answers'], ['fails'], ['fails', 'answers']] as Array<Plan['adopt']>).map(adopt =>
    planOf({ group: 'poll', screen: 'renewal', kept: 'delivered', renewal: true, frozen: true, claims: ['active'], adopt, held: POLL_HELD }),
  ),
  // The sats build, where a denial needs no payment on record and every send that left answered failed.
  ...(['complete', 'failed'] as const).map(send => planOf({ group: 'sats', build: 'direct', held: SATS_HELD, screen: 'renewal', kept: 'nothing', send })),
  planOf({ group: 'sats', build: 'direct', held: SATS_HELD, screen: 'renewal', kept: 'nothing', prepare: 'insufficient' }),
  planOf({ group: 'sats', build: 'direct', held: SATS_HELD, screen: 'renewal', kept: 'nothing', grant: 'fails' }),
  ...(['waits', 'fails'] as const).map(grant =>
    planOf({ group: 'sats', build: 'direct', held: SATS_HELD, screen: 'renewal', kept: 'nothing', quotes: ['fails', 'answers'], recover: true, grant }),
  ),
  ...(['waits', 'fails'] as const).map(grant =>
    planOf({ group: 'sats', build: 'direct', held: SATS_HELD, screen: 'first year', kept: 'nothing', claims: ['notPaid'], recover: true, grant }),
  ),
  // A store build finishes a sats payment owed too, at every press.
  ...(['renewal', 'first year'] as const).map(screen =>
    planOf({ group: 'sats', held: ['grant'], screen, kept: 'nothing', claims: screen === 'renewal' ? ['live'] : ['notPaid'], recover: true, grant: 'fails' }),
  ),
]

type Outcome = { value: unknown } | { error: unknown } | 'never'
type Read = {
  route: Route
  press: number
  // The root's sync, the support mail, or the screen.
  origin: 'screen' | 'root' | 'mail'
  // A claim the DNS steps' poll sent, and the host a claim or an order named.
  poll: boolean
  subject: string | null
  // What a claim was planned to answer.
  claim: Claim | null
  settle: (() => void) | null
  settled: boolean
  failed: boolean
  network: boolean
  value?: unknown
}

const world = {
  plan: PLANS[0]!,
  reads: [] as Read[],
  presses: 0,
  pressed: 0,
  buys: 0,
  commits: 0,
  sent: {} as Partial<Record<Route, number>>,
  purchasePress: false,
  ticked: false,
  bookRead: false,
  finished: false,
  delivered: false,
  retries: 0,
  tag: null as 'root' | 'mail' | null,
  // A read sent while a settle is played belongs to the settled read's press, since the read is its
  // continuation. Null outside a settle, where a read belongs to the latest press.
  stepPress: null as number | null,
  synced: false,
  typed: false,
  toggled: false,
  recovered: false,
  // A Continue pressed while the form named the book's host, after which a renewal's order may show,
  // and the press O5 checks once its reads have answered.
  matched: false,
  match: null as { press: number; claims: number; blocking: boolean } | null,
  // A first-year order of the host the form showed, whose host the form then names.
  restored: false,
  // The host the form last named, which a store view on top of it hides.
  host: null as string | null,
  // A denial already on screen when the recovery filed a proof, which the screen has not read since:
  // the line was verified when said, and the next press reads the slot again.
  staleDenial: false,
  // The latest press that left a wait or a refusal on the renewal, after which the renewal reads its
  // line again, and the screen's writes an earlier press made after a later one.
  left: null as number | null,
  lateWrites: [] as string[],
  tree: null as ReactTestRenderer.ReactTestRenderer | null,
  // The order the store last opened for.
  boughtFor: null as string | null,
  // The presses that were Pay or the first-year Continue, which open an order and the store.
  buying: new Set<number>(),
}

mockWrote = fn => {
  if (world.stepPress !== null && world.stepPress < world.presses) {
    world.lateWrites.push(fn)
  }
}

// The screen's intervals, which never fire on their own. The DNS poll's is the one ticked.
const POLL_MS = 10_000
const intervals = new Map<number, { tick: () => void; ms: number }>()
let nextInterval = 1

const reply = (status: number, body: unknown): { status: number; body: unknown } => ({ status, body })
const statusOf = (state: OnboardState): OnboardStatus => ({
  host: HOST,
  provider: 'cloudflare',
  supportsRoot: true,
  isRoot: false,
  target: 'saas.usevoltz.app',
  state,
})

const VERDICT_REPLY: Record<Verdict, { status: number; body: unknown }> = {
  delivered: reply(200, { state: 'delivered', reference: REF, kind: 'tier', host: HOST, expiresAt: LATER, frozen: false }),
  refunded: reply(409, { error: 'refunded' }),
  support: reply(409, { error: 'wrong_bundle' }),
  unknownOrder: reply(409, { error: 'unknown_order' }),
  pending: reply(402, { error: 'purchase_pending' }),
  notVerified: reply(402, { error: 'not_paid' }),
  later: reply(429, { error: 'too many requests' }),
  retry: reply(503, { error: 'unavailable' }),
}

// Whether the book still holds the order of `reference` as one the store or the gateway has not
// settled, as the plan's starting book and what happened since leave it.
const unsettledKinds = new Set<Kept>(['askToBuy', 'paidWait', 'support'])

function outcomeOf(route: Route, n: number, subject: string | null): Outcome {
  const { plan } = world
  switch (route) {
    case 'book':
      return { value: undefined }
    case 'products':
      return { value: [{ id: 'domain_year', displayPrice: PRICE }] satisfies NativeProduct[] }
    case 'identity': {
      const fails = (plan.identity === 'failsOpen' && world.pressed === 0) || (plan.identity === 'failsPress' && world.pressed > 0)
      return fails ? { error: new Error('not connected') } : { value: PUBKEY }
    }
    case 'openList': {
      const listing = world.finished ? 'empty' : n === 0 ? plan.lists[0] : plan.lists[1]
      return listing === 'never' ? 'never' : { value: listing === 'listed' ? [purchase] : [] }
    }
    case 'claim': {
      const claim = plan.claims[Math.min(n, plan.claims.length - 1)]!
      switch (claim) {
        case 'never':
          return 'never'
        case 'live':
          return { value: statusOf('awaiting_dns') }
        case 'active':
          return { value: statusOf('active') }
        case 'notPaid':
          return { error: new Error('domain_tier_not_paid') }
        case 'taken':
          return { error: new Error('domain_belongs_to_another_wallet') }
        case 'fails':
          return { error: new TypeError('Network request failed') }
      }
      break
    }
    case 'order': {
      if (plan.order === 'refused') {
        return { value: reply(409, { error: 'a_code_this_build_does_not_know' }) }
      }
      // The gateway hands back the order it holds for the host while one is open, and opens another
      // once the book's has settled, or for another host.
      const open = unsettledKinds.has(plan.kept) || plan.kept === 'dropped'
      const reference = subject !== HOST ? REF_C : open && !world.finished ? REF : REF_B
      return {
        value: reply(200, { reference, productId: 'domain_year', state: 'held', kind: 'tier', subject, appAccountToken: reference }),
      }
    }
    case 'buy':
      return { value: { status: 'pending', code: null, subCode: null, message: null, purchase: null } satisfies NativeBuyResult }
    case 'confirm':
      return { value: VERDICT_REPLY[plan.verdict] }
    case 'adopt':
      return plan.adopt[Math.min(n, plan.adopt.length - 1)] === 'answers' ? { value: undefined } : { error: new Error('connect failed') }
    case 'prices':
      return { value: { domain_tier: 9990 } }
    case 'quote':
      return plan.quotes[Math.min(n, plan.quotes.length - 1)] === 'answers'
        ? {
            value: {
              host: subject ?? HOST,
              priceUsdCents: 9990,
              days: 365,
              amountSats: 5000,
              invoice: 'lnbc1',
              reference: SATS_REF,
              expiresAt: Math.floor(Date.now() / 1000) + 3600,
            },
          }
        : { error: new Error('boom') }
    case 'prepare':
      return plan.prepare === 'answers' ? { value: { handle: 'h1', amount: 5000, fee: 10 } } : { error: new Error('insufficient funds') }
    case 'send':
      return { value: plan.send }
    case 'grant':
      return plan.grant === 'grants'
        ? { value: { expiresAt: LATER, frozen: false } }
        : plan.grant === 'waits'
          ? { value: null }
          : { error: new Error('boom') }
  }
  throw new Error(`no outcome for ${route}`)
}

function onDns(): boolean {
  if (!world.tree) {
    return false
  }
  const shown = texts(world.tree)
  return shown.includes(en.useDomain.stepsTitle!) || shown.includes(RENEWED) || shown.includes(en.useDomain.renewWaking!)
}

function issue<T>(route: Route, subject: string | null = null): Promise<T> {
  const n = world.sent[route] ?? 0
  world.sent[route] = n + 1
  const outcome = outcomeOf(route, n, subject)
  return new Promise<T>((resolve, reject) => {
    const read: Read = {
      route,
      press: world.stepPress ?? world.presses,
      origin: world.tag ?? 'screen',
      poll: route === 'claim' && onDns(),
      subject,
      claim: route === 'claim' ? world.plan.claims[Math.min(n, world.plan.claims.length - 1)]! : null,
      settle: null,
      settled: false,
      failed: false,
      network: false,
    }
    world.reads.push(read)
    if (outcome !== 'never') {
      read.settle = () => {
        read.settled = true
        if (route === 'confirm') {
          const verdict = world.plan.verdict
          world.delivered = world.delivered || verdict === 'delivered'
          world.finished = world.finished || verdict === 'delivered' || verdict === 'refunded'
          world.retries = verdict === 'retry' ? 3 : 0
        }
        if ('error' in outcome) {
          read.failed = true
          read.network = outcome.error instanceof TypeError
          reject(outcome.error)
        } else {
          read.value = outcome.value
          resolve(outcome.value as T)
        }
      }
      if (!world.plan.held.includes(route)) {
        read.settle()
      }
    }
  })
}

const ROUTES: Record<string, Route> = { '/api/store/order': 'order', '/api/store/confirm': 'confirm' }
const respond = (answer: { status: number; body: unknown }): Response =>
  ({ status: answer.status, ok: answer.status < 300, text: async () => JSON.stringify(answer.body) }) as unknown as Response

beforeAll(() => {
  global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    const route = ROUTES[new URL(url).pathname]
    if (!route) {
      throw new Error(`no route ${url}`)
    }
    if (route === 'confirm' && world.retries > 0) {
      world.retries -= 1
      return respond(VERDICT_REPLY.retry)
    }
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    return respond(await issue<{ status: number; body: unknown }>(route, typeof body.subject === 'string' ? body.subject : null))
  }) as unknown as typeof fetch
  jest.spyOn(double.default, 'loadProducts').mockImplementation(() => issue('products'))
  jest.spyOn(double.default, 'openPurchases').mockImplementation(() => issue('openList'))
  jest.spyOn(double.default, 'buy').mockImplementation((_productId: string, reference: string) => {
    world.buys += 1
    world.boughtFor = reference.toLowerCase()
    return issue('buy')
  })
  jest.mocked(sparkGetIdentityPubkey).mockImplementation(() => issue('identity'))
  jest.mocked(claimDomain).mockImplementation((_deps, host) => issue('claim', host))
  jest.mocked(reconnectActiveWallet).mockImplementation(() => issue('adopt'))
  jest.mocked(fetchPrices).mockImplementation(() => issue('prices'))
  jest.mocked(quoteDomain).mockImplementation((_deps, host) => issue('quote', host))
  jest.mocked(confirmDomain).mockImplementation(() => issue('grant'))
  jest.mocked(sparkPrepareSend).mockImplementation(() => issue('prepare'))
  jest.mocked(sparkConfirmSend).mockImplementation(() => issue('send'))
  jest.spyOn(RNFS, 'exists').mockImplementation(async (file: string) => {
    if (file === BOOK_FILE && !world.bookRead) {
      world.bookRead = true
      await issue('book')
    }
    return fileExists(file)
  })
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.spyOn(global, 'setInterval').mockImplementation(((tick: () => void, ms: number) => {
    const id = nextInterval++
    intervals.set(id, { tick, ms })
    return id
  }) as unknown as typeof setInterval)
  jest.spyOn(global, 'clearInterval').mockImplementation(((id: number) => {
    intervals.delete(id)
  }) as unknown as typeof clearInterval)
})

// The root's sync, as startStoreSync runs it, over a context whose reads are marked as the root's.
const rootContext: StoreContext = {
  ...liveStoreContext(),
  gateway: async () => {
    world.tag = 'root'
    let deps
    try {
      deps = currentDeps()
    } finally {
      world.tag = null
    }
    const request = ((url: string, init: RequestInit) => {
      world.tag = 'root'
      try {
        return global.fetch(url, init)
      } finally {
        world.tag = null
      }
    }) as typeof fetch
    return { ...(await deps), request }
  },
}

function rootSync(): void {
  world.tag = 'root'
  try {
    syncStorePurchases(rootContext).catch(() => undefined)
  } finally {
    world.tag = null
  }
}

type Tree = ReactTestRenderer.ReactTestRenderer
type Instance = ReactTestRenderer.ReactTestInstance

function texts(tree: Tree, keep: (node: Instance) => boolean = () => true): string[] {
  return tree.root.findAllByType(Text).filter(keep).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter((c): c is string => typeof c === 'string')
  })
}

type Button = { label: string; enabled: boolean; press: () => void }
function buttons(tree: Tree, keep: (node: Instance) => boolean = () => true): Button[] {
  return tree.root.findAllByType(GradientButton).filter(keep).map(node => ({
    label: node.props.label as string,
    enabled: !node.props.disabled && !node.props.loading,
    press: node.props.onPress as () => void,
  }))
}

// The two places of the address, which the form offers once a domain is typed.
function places(tree: Tree): Array<{ selected: boolean; press: () => void; label: string }> {
  return tree.root
    .findAll(node => typeof node.props.onPress === 'function' && typeof node.props.state?.selected === 'boolean')
    .map(node => ({
      selected: node.props.state.selected as boolean,
      press: node.props.onPress as () => void,
      label: texts({ root: node } as unknown as Tree)[0] ?? '',
    }))
}

// The host the form names, which is the domain typed and, on the subdomain, the label before it.
function formHost(tree: Tree): string | null {
  const fields = tree.root.findAllByType(TextInput)
  const root = fields[0]?.props.value as string | undefined
  if (!root) {
    return null
  }
  const sub = places(tree).find(p => p.selected)?.label.startsWith(`name@${root}`) ? null : (fields[1]?.props.value as string | undefined) || 'pay'
  return sub ? `${sub}.${root}` : root
}

function snapshot(tree: Tree, keep: (node: Instance) => boolean = () => true): string {
  return JSON.stringify([
    texts(tree, keep),
    buttons(tree, keep).map(b => [b.label, b.enabled]),
    tree.root.findAllByType(Skeleton).length,
  ])
}

// Outside the card a support mail leaves under its press (its line, the address, the mail's text and
// Copy). Send to support adds that card whether the mail opens or not, and changes nothing else.
function outsideSupportCard(node: Instance): boolean {
  for (let at = node.parent; at; at = at.parent) {
    if (at.type === SupportMailCard) {
      return false
    }
  }
  return true
}

// Runs until a round commits nothing and issues no read. A round drains every microtask, and a commit
// can start effects whose work only the next round sees.
async function flush(): Promise<void> {
  for (let round = 0; round < 8; round++) {
    const reads = world.reads.length
    const commits = world.commits
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
    })
    if (world.reads.length === reads && world.commits === commits) {
      return
    }
  }
  throw new Error('the screen never settled')
}

type BookShape = {
  bought?: Record<string, string>
  outcomes?: Record<string, { kind: string; refusal?: string }>
  about?: Record<string, { kind: string; subject: string; renewal?: boolean }>
}
async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await RNFS.readFile(file)) as T
  } catch {
    return null
  }
}

function latest(route: Route, where: (read: Read) => boolean = () => true): Read | undefined {
  return [...world.reads].reverse().find(r => r.route === route && where(r))
}
// The latest read of a route the screen sent since the last press, which is the one it may act on.
function current(route: Route): Read | undefined {
  return latest(route, r => r.origin === 'screen' && r.press === world.presses && !r.poll)
}
const outstanding = (read: Read | undefined): boolean => read !== undefined && !read.settled

function listed(): boolean {
  const list = latest('openList', r => r.settled) ?? latest('openList')
  return list === undefined || !list.settled || (list.value as NativePurchase[]).some(p => p.key === purchase.key)
}

// The references whose order the book still holds as one the store or the gateway has not settled,
// given what the store's list last answered (docs/store-bridge.md, rules 1 and 3).
function unsettled(book: BookShape, holds: boolean = listed()): string[] {
  return Object.keys(book.about ?? {}).filter(reference => {
    const outcome = book.outcomes?.[reference]
    const held = reference === REF ? holds : true
    if (outcome) {
      return outcome.kind === 'refused' || (outcome.kind === 'support' && held)
    }
    const bought = book.bought?.[reference]
    return bought === 'pending' || (bought === 'purchased' && held)
  })
}

// Whether the screen shows the outcome the book keeps for the order, as the listener of the root's
// sync puts it on screen.
function showsKept(book: BookShape, shown: string[]): boolean {
  const outcome = book.outcomes?.[REF]
  switch (outcome?.kind) {
    case 'refused':
      return shown.includes(en.store.refusedTitle!)
    case 'support':
      return shown.includes(en.store.support!)
    case 'delivered':
      return shown.includes(en.useDomain.stepsTitle!) || shown.includes(RENEWED) || shown.includes(en.useDomain.renewWaking!)
    default:
      return false
  }
}

// Whether an unsettled order blocks this screen's purchase, which on the renewal is any order of its
// host and on the first-year form a first year's, or a renewal's once Continue named its host (rule 3
// as the form keeps it).
function keptHere(book: BookShape): boolean {
  return unsettled(book).some(reference => {
    const about = book.about![reference]!
    return world.plan.screen === 'renewal' || about.renewal !== true || (world.matched && about.subject === HOST)
  })
}

// Whether the screen no longer waits on a read, which it does not once a later press followed the
// press that sent it, or once a newer poll followed a poll. The price applies whenever it answers, so
// no press supersedes it, and the support mail's identity read is not the screen's.
function superseded(read: Read): boolean {
  if (read.origin === 'mail') {
    return true
  }
  if (read.origin !== 'screen' || read.route === 'products') {
    return false
  }
  if (read.poll) {
    return world.reads.some((r, i) => i > world.reads.indexOf(read) && r.poll)
  }
  return read.press < world.presses
}
const quiet = (): boolean => world.reads.every(r => r.settled || superseded(r))

type Counts = { schedules: number; O1: number; O2: number; O3: number; O4: number; O5: number; O6: number; line: number; O7: number }
const counts: Counts = { schedules: 0, O1: 0, O2: 0, O3: 0, O4: 0, O5: 0, O6: 0, line: 0, O7: 0 }
const failures = new Map<string, { first: string; steps: number }>()

function fail(oracle: string, plan: string, at: string, tree: Tree): void {
  const key = `${oracle} ${plan}`
  // SCHEDULE_TRACE prints every failing step, not only the first of each oracle and plan.
  if (process.env[`SCHEDULE_${'TRACE'}`]) {
    console.log(`FAIL ${key} at ${at} :: ${texts(tree).join(' | ')}`)
  }
  const seen = failures.get(key)
  if (seen) {
    seen.steps += 1
    return
  }
  const shown = `${texts(tree).join(' | ')} :: ${buttons(tree).map(b => `${b.label}${b.enabled ? '' : '(off)'}`).join(', ')}`
  failures.set(key, { first: `${at} :: ${shown}`, steps: 1 })
}

type Option =
  | { kind: 'settle'; read: Read }
  | { kind: 'press'; button: Button }
  | { kind: 'tick'; tick: () => void }
  | { kind: 'sync' }
  | { kind: 'type'; root: string }
  | { kind: 'toggle' }
  | { kind: 'recover' }
  | { kind: 'end' }

const describePlan = (p: Plan): string =>
  `[${p.group}: ${p.build} ${p.screen} ${p.kept}${p.kept === 'nothing' || p.kept === 'check' ? '' : p.renewal ? ' of a renewal' : ' of a first year'}` +
  ` lists=${p.lists.join('/')} claims=${p.claims.join(',')} verdict=${p.verdict}${p.order === 'refused' ? ' order=refused' : ''} identity=${p.identity}` +
  `${p.build === 'direct' ? ` quotes=${p.quotes.join(',')} prepare=${p.prepare} send=${p.send} grant=${p.grant} recover=${p.recover}` : ''}` +
  `${p.kept === 'delivered' ? ` adopt=${p.adopt.join(',')}${p.frozen ? ' frozen' : ''}` : ''} held=${p.held === BASE_HELD ? 'base' : p.held.join(',')}]`

async function play(plan: Plan, prefix: number[]): Promise<Array<[number, number]>> {
  RNFS.__reset()
  double.control.reset()
  mockBuild = plan.build
  if (plan.build === 'store') {
    await RNFS.writeFile(BOOK_FILE, JSON.stringify(bookOf(plan.kept, plan.renewal, plan.frozen)))
  }
  Object.assign(world, {
    plan,
    reads: [],
    presses: 0,
    pressed: 0,
    buys: 0,
    commits: 0,
    sent: {},
    purchasePress: false,
    ticked: false,
    bookRead: false,
    finished: false,
    delivered: false,
    retries: 0,
    tag: null,
    stepPress: null,
    synced: false,
    typed: false,
    toggled: false,
    recovered: false,
    matched: false,
    match: null,
    restored: false,
    host: null,
    staleDenial: false,
    left: null,
    lateWrites: [],
    tree: null,
    boughtFor: null,
    buying: new Set<number>(),
  })
  intervals.clear()
  mockParams = plan.screen === 'renewal' ? { renew: HOST } : undefined
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <Profiler id="screen" onRender={() => (world.commits += 1)}>
        <UseMyDomainScreen />
      </Profiler>,
    )
    world.tree = tree
  })
  // The owner types the domain before anything answers.
  if (plan.typing === 'start') {
    world.typed = true
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]?.props.onChangeText(ROOT)
    })
  }
  await flush()
  const trace: Array<[number, number]> = []
  let delivered = false
  const name = describePlan(plan)
  const history: string[] = []
  const store = plan.build === 'store'
  const inFlightLine = store ? IN_FLIGHT[plan.kept] : undefined
  const onOpen = store && shownOnOpen(plan)
  const keptLine = onOpen ? (inFlightLine ?? (plan.renewal ? (plan.frozen ? en.useDomain.renewWaking : RENEWED) : en.useDomain.stepsTitle)) : undefined

  async function check(
    step: string,
    stale: boolean,
    before: string | null,
    buysBefore: number,
    ordersBefore: number,
    claimsBefore: number,
    blockedBefore: boolean,
    besideCard = false,
  ): Promise<void> {
    const shown = texts(tree)
    const at = `${history.join(' > ')} @${step}`
    const book = (await readJson<BookShape>(BOOK_FILE)) ?? {}
    const left = unsettled(book)
    // O1 checks that what the book keeps for this screen is on screen from the first render after the
    // book read.
    if (step === 'book' && keptLine) {
      counts.O1 += 1
      if (!shown.includes(keptLine)) {
        fail('O1 the kept outcome is not on the first render', name, at, tree)
      }
    }
    // O2 checks that a read an earlier press sent, or a poll a newer poll followed, changes nothing on
    // screen once a later press came, and that the earlier press makes none of the screen's own writes
    // to the book (dropping a wait, dismissing an outcome, opening an order) after it.
    // A confirmation is the gateway's verdict about the order, written to the book whichever press
    // asked, and it reaches the screen through the listener of the root's sync, which shows what the
    // book now keeps for the order, as it does for the root's own confirmation.
    if (stale && before !== null) {
      counts.O2 += 1
      if (snapshot(tree, besideCard ? outsideSupportCard : undefined) !== before && !(step === 'confirm' && showsKept(book, shown))) {
        fail('O2 a stale read changed the screen', name, at, tree)
      }
    }
    if (world.lateWrites.length > 0) {
      fail(`O2 an earlier press wrote the book after a later press: ${world.lateWrites.join(', ')}`, name, at, tree)
      world.lateWrites = []
    }
    // O3 checks that the store opens only after a press on Pay, or on Continue of the first-year form,
    // with the price on screen, and that neither is enabled while a read that gates it is out or shows
    // an order this screen keeps unsettled. Pay also waits on the price and the renewal's claim
    // (rule 7); Continue sends the claim without a price (rule 5).
    if (store) {
      const kept = keptHere(book)
      const pay = buttons(tree).find(b => b.label === LABEL.pay)
      const cont = buttons(tree).find(b => b.label === LABEL.continue)
      const unread = outstanding(latest('book'))
      const payClosed =
        unread || kept || outstanding(current('openList')) || outstanding(latest('products')) || outstanding(current('claim'))
      const continueClosed = unread || kept || outstanding(current('openList'))
      if (world.buys > buysBefore || (payClosed && pay) || (continueClosed && cont)) {
        counts.O3 += 1
        if (world.buys > buysBefore && !world.purchasePress) {
          fail('O3 the store opened without a purchase press with its price', name, at, tree)
        }
        // The gateway delivered or refused the book's order for good, so the store opening for it again
        // takes a second payment.
        if (world.buys > buysBefore && world.finished && world.boughtFor === REF) {
          fail('O3 the store opened for an order already settled', name, at, tree)
        }
        if (payClosed && pay?.enabled) {
          fail('O3 Pay enabled with a gating read out or the order kept', name, at, tree)
        }
        if (continueClosed && cont?.enabled) {
          fail('O3 Continue enabled with the book unread or the order kept', name, at, tree)
        }
      }
      // Neither is enabled while an earlier purchase press still runs, its order, the store's sheet or
      // its confirmation out, whatever took the screen meanwhile.
      if (world.reads.some(r => r.origin === 'screen' && world.buying.has(r.press) && !r.settled)) {
        counts.O3 += 1
        if (pay?.enabled || cont?.enabled) {
          fail('O3 a purchase press is enabled while an earlier one still runs', name, at, tree)
        }
      }
    }
    // O4 checks that once a year is delivered no line says the purchase failed, that a line names the
    // connection only after a read failed on it, and that the DNS steps say what the latest poll read:
    // its status, the unread line when it did not answer, or the refusal's own line.
    delivered =
      delivered || world.delivered || shown.includes(RENEWED) || shown.includes(en.useDomain.renewWaking!) || shown.includes(en.useDomain.stepsTitle!)
    const connection = shown.some(line => NAMES_CONNECTION.test(line))
    if (delivered || connection) {
      counts.O4 += 1
      if (delivered && shown.some(line => FAILURE_LINES.includes(line))) {
        fail('O4 a failure line after delivered', name, at, tree)
      }
      if (delivered && shown.includes(en.useDomain.waiting!) && !world.reads.some(r => r.route === 'claim' && r.settled && !r.failed)) {
        fail('O4 a status line no claim answered', name, at, tree)
      }
      if (connection && !world.reads.some(r => r.network)) {
        fail('O4 a line names the connection with no read failed on it', name, at, tree)
      }
      const poll = latest('claim', r => r.poll)
      const steps = shown.includes(en.useDomain.stepsTitle!)
      const statusShown = steps || (plan.frozen && delivered)
      const adopt = latest('adopt')
      if (poll?.settled && statusShown) {
        const state = poll.failed ? null : (poll.value as OnboardStatus).state
        const statusLines = STATUS_LINES.filter(line => shown.includes(line))
        // An active domain reads as done only once the wallet's reconnect onto it answered, as being set
        // up while it is out, and as not set up yet once it failed, on the first year's steps and under
        // a renewal that was off the edge alike.
        const expected =
          state === 'active'
            ? !adopt?.settled
              ? en.useDomain.adopting!
              : adopt.failed
                ? en.useDomain.adoptFailed!
                : en.useDomain.active!
            : state !== null
              ? STATE_LINE[state]!
              : null
        if (state !== null) {
          if (shown.includes(en.useDomain.statusUnread!) || !shown.includes(expected!) || statusLines.length !== 1) {
            fail('O4 the DNS steps do not say what the latest poll and the reconnect read', name, at, tree)
          }
        } else if (poll.claim === 'taken') {
          if (!shown.includes(en.useDomain.domainTaken!) || statusLines.length > 0) {
            fail('O4 a poll the gateway refused does not say its refusal', name, at, tree)
          }
        } else if (!shown.includes(en.useDomain.statusUnread!) || statusLines.length > 0) {
          fail('O4 a poll that did not answer leaves a status line or no unread line', name, at, tree)
        }
      }
      // The caption that invites a first payment shows only on an active domain the wallet took. A poll
      // still out changes nothing on screen, so the status is the latest poll that answered.
      const read = latest('claim', r => r.poll && r.settled)
      const taken = read !== undefined && !read.failed && (read.value as OnboardStatus).state === 'active' && adopt?.settled === true && !adopt.failed
      if (shown.includes(en.useDomain.proof!)) {
        counts.O4 += 1
        if (!taken) {
          fail('O4 the proof caption shows before the reconnect answered', name, at, tree)
        }
      }
      // A renewal that was off the edge says its addresses come back until its domain answers and the
      // wallet took it, and that it works only after.
      if (plan.frozen && delivered) {
        counts.O4 += 1
        if (taken ? shown.includes(en.useDomain.renewWaking!) : shown.includes(RENEWED)) {
          fail(taken ? 'O4 a renewal still says its addresses come back after they did' : 'O4 a renewal off the edge says it works before it does', name, at, tree)
        }
      }
      // The line about setting up the address holds only while the wallet's reconnect is out. Once it
      // failed, the first year's outcome stays in the book, so a reopen shows the steps again, and Try
      // again is on screen; once it answered, the outcome is dismissed.
      if (adopt?.settled && adopt.failed && shown.includes(en.useDomain.adopting!)) {
        fail('O4 the address reads as being set up after the reconnect failed', name, at, tree)
      }
      if (steps && adopt?.settled && store && plan.kept === 'delivered' && !plan.renewal) {
        const retry = buttons(tree).find(b => b.label === LABEL.retry)
        if (adopt.failed && (book.outcomes?.[REF] === undefined || !retry?.enabled)) {
          fail('O4 a failed reconnect dropped the first year from the book or offers no Try again', name, at, tree)
        }
        if (!adopt.failed && book.outcomes?.[REF] !== undefined) {
          fail('O4 the first year stays in the book after the reconnect answered', name, at, tree)
        }
      }
    }
    // O5 checks that an unsettled order of the host shows on the screens rule 3 names, opens no other
    // order for its host, keeps its record, and that the form names the host of a first year it put
    // back. A renewal's shows on the first-year form only once Continue names its host.
    if (store && inFlightLine) {
      const about = book.about?.[REF]
      const orders = world.reads.filter(r => r.route === 'order' && r.subject === HOST).length
      const claims = world.reads.filter(r => r.route === 'claim').length
      const blocking = left.includes(REF)
      if (step === 'book' || about || blocking) {
        counts.O5 += 1
      }
      if (step === 'book' && onOpen !== shown.includes(inFlightLine)) {
        fail(onOpen ? 'O5 the host order is not shown on this screen' : 'O5 a renewal order shows on the first-year form on open', name, at, tree)
      }
      if (about && (about.kind !== 'tier' || (about.renewal === true) !== plan.renewal)) {
        fail('O5 the book rewrote what the order sells', name, at, tree)
      }
      if (blockedBefore && (orders > ordersBefore || world.buys > buysBefore)) {
        fail('O5 an order or a purchase opened for the host while its order is unsettled', name, at, tree)
      }
      // Once a Continue that named the host of an unsettled order has read what it needs, the order
      // is on screen and no claim went out.
      const match = world.match
      if (match && !world.reads.some(r => r.origin === 'screen' && r.press === match.press && !r.settled)) {
        world.match = null
        if (match.blocking) {
          counts.O5 += 1
          if (!shown.includes(inFlightLine) || claims > match.claims) {
            fail('O5 Continue on the host of an unsettled order neither shows it nor holds the claim', name, at, tree)
          }
        }
      }
    }
    // The first-year form reads the store's list on open only for an order it shows there, a first
    // year's wait or support case. A renewal's order neither shows nor holds the open (rule 3).
    if (store && plan.screen === 'first year' && plan.renewal && unsettledKinds.has(plan.kept)) {
      counts.O5 += 1
      if (world.reads.some(r => r.route === 'openList' && r.origin === 'screen' && r.press === 0)) {
        fail("O5 the first-year open reads the store's list for a renewal's order", name, at, tree)
      }
    }
    const firstYearShown = (inFlightLine !== undefined && shown.includes(inFlightLine)) || shown.includes(en.useDomain.stepsTitle!)
    if (store && plan.screen === 'first year' && !plan.renewal && onOpen && firstYearShown && !world.typed) {
      world.restored = true
      world.host = HOST
    }
    world.host = formHost(tree) ?? world.host
    if (store && world.restored && !world.typed && !world.toggled && shown.includes(en.useDomain.domainLabel!)) {
      counts.O5 += 1
      if (formHost(tree) !== HOST) {
        fail('O5 the form does not name the host of the first year it put back', name, at, tree)
      }
    }
    // O6 checks liveness. Once the screen waits on nothing and nothing kept, owed or delivered blocks
    // the sale, Pay or Continue is on screen and enabled.
    if (store && quiet()) {
      const settling = shown.includes(en.useDomain.settling!)
      const dns = shown.includes(en.useDomain.stepsTitle!) || shown.includes(RENEWED) || shown.includes(en.useDomain.renewWaking!)
      const host = plan.screen === 'renewal' ? HOST : world.host
      if (!settling && !dns && !keptHere(book) && host !== null) {
        counts.O6 += 1
        const primary = buttons(tree).find(b => b.label === (plan.screen === 'renewal' ? LABEL.pay : LABEL.continue))
        if (!primary?.enabled) {
          fail(`O6 the screen waits on nothing and ${plan.screen === 'renewal' ? 'Pay' : 'Continue'} is off`, name, at, tree)
        }
        // A renewal that leaves a wait or a refusal for the price reads its line again (rule 7), which
        // starts with the identity the claim is signed with.
        const leftAt = world.left
        if (plan.screen === 'renewal' && leftAt !== null && primary) {
          counts.line += 1
          if (!world.reads.some(r => (r.route === 'claim' || r.route === 'identity') && r.origin === 'screen' && !r.poll && r.press >= leftAt)) {
            fail('O6 the renewal left a wait or a refusal and never read its line again', name, at, tree)
          }
        }
      }
    }
    // O7 checks that no line denies a charge on a store build, but a test purchase's refusal beside
    // the refusal it explains, and that on the sats build one shows only with no payment on record and
    // every send that left answered failed.
    const owed = await readJson<Record<string, { unpaid?: boolean }>>(PENDING_FILE)
    const onRecord = owed !== null && owed.w_a !== undefined && owed.w_a.unpaid !== true
    const sends = world.reads.filter(r => r.route === 'send')
    const allFailed = sends.every(r => r.settled && r.value === 'failed')
    const error = shown.some(line => FAILURE_LINES.includes(line) || DENIALS.includes(line))
    if (error || onRecord || sends.length > 0 || book.bought?.[REF] === 'purchased' || world.delivered) {
      counts.O7 += 1
    }
    const refusal = Object.values(book.outcomes ?? {}).find(o => o.kind === 'refused')?.refusal
    for (const line of DENIALS) {
      if (!shown.includes(line) || (line === en.store.refusedTest && refusal !== undefined && TEST_REFUSALS.has(refusal))) {
        continue
      }
      if (store) {
        fail(`O7 a line denies a charge on a store build: ${line}`, name, at, tree)
      } else if ((onRecord && !world.staleDenial) || !allFailed) {
        fail(`O7 a line denies a charge with a payment on record or a send out: ${line}`, name, at, tree)
      }
    }
  }

  await check('open', false, null, 0, 0, 0, false)
  for (let step = 0; step < 80; step++) {
    const settles = world.reads.filter(r => r.settle !== null && !r.settled)
    // A second press lands at every position, its first press's reads still out or answered.
    const presses =
      world.pressed >= plan.presses
        ? []
        : buttons(tree).filter((b, i, all) => b.enabled && PRESSABLE.has(b.label) && all.findIndex(o => o.label === b.label) === i)
    const poller = world.ticked || !plan.tick ? undefined : [...intervals.values()].find(i => i.ms === POLL_MS)
    const field = tree.root.findAllByType(TextInput)[0]
    const options: Option[] = [
      ...settles.map((read): Option => ({ kind: 'settle', read })),
      ...presses.map((button): Option => ({ kind: 'press', button })),
      ...(poller ? [{ kind: 'tick', tick: poller.tick } as Option] : []),
      ...(plan.sync && !world.synced ? [{ kind: 'sync' } as Option] : []),
      ...(plan.typing === 'event' && !world.typed && field ? [ROOT, OTHER_ROOT].map((root): Option => ({ kind: 'type', root })) : []),
      ...(plan.toggle && world.typed && !world.toggled && places(tree).length === 2 ? [{ kind: 'toggle' } as Option] : []),
      ...(plan.recover && !world.recovered ? [{ kind: 'recover' } as Option] : []),
    ]
    if (settles.length === 0) {
      options.push({ kind: 'end' })
    }
    const choice = step < prefix.length ? prefix[step]! : 0
    if (choice >= options.length) {
      throw new Error(`replay diverged at step ${step}: ${choice} of ${options.length}`)
    }
    trace.push([choice, options.length])
    const option = options[choice]!
    if (option.kind === 'end') {
      break
    }
    const before = snapshot(tree)
    const beforeBesideCard = snapshot(tree, outsideSupportCard)
    const buysBefore = world.buys
    const ordersBefore = world.reads.filter(r => r.route === 'order' && r.subject === HOST).length
    const claimsBefore = world.reads.filter(r => r.route === 'claim').length
    // Whether the host's order blocked this screen's purchase for the host before the step, being
    // unsettled and shown here or named by a Continue on the form.
    const bookBefore = (await readJson<BookShape>(BOOK_FILE)) ?? {}
    const blockedBefore =
      store &&
      unsettled(bookBefore).includes(REF) &&
      (keptHere(bookBefore) || (option.kind === 'press' && option.button.label === LABEL.continue && formHost(tree) === HOST))
    if (option.kind === 'press') {
      const label = option.button.label
      const shownBefore = texts(tree)
      // Send to support opens the mail, and the DNS steps' Check again and the reconnect's Try again
      // read again only what they show, so none of them supersedes a read.
      const mail = label === LABEL.support
      const own = mail || label === LABEL.retry || (label === LABEL.check && onDns())
      // A press that leaves a wait or a refusal, after which the renewal reads its line again.
      const leaving = label === LABEL.stop || label === LABEL.close || (label === LABEL.check && shownBefore.includes(en.store.waitingTitle!))
      if (!own) {
        world.presses += 1
      }
      world.pressed += 1
      world.staleDenial = false
      world.purchasePress =
        (label === LABEL.pay || (label === LABEL.continue && plan.screen === 'first year')) && shownBefore.includes(PRICE_LINE)
      if (label === LABEL.continue && formHost(tree) === HOST) {
        world.matched = true
        // Whether the order is unsettled as the store's list will answer this press's read of it.
        const next = world.sent.openList ?? 0
        const listing = world.finished ? 'empty' : next === 0 ? plan.lists[0] : plan.lists[1]
        world.match = { press: world.presses, claims: claimsBefore, blocking: store && unsettled(bookBefore, listing !== 'empty').includes(REF) }
      }
      const sentBefore = world.reads.length
      const adoptsBefore = world.reads.filter(r => r.route === 'adopt').length
      history.push(`press ${label}`)
      world.tag = mail ? 'mail' : null
      await ReactTestRenderer.act(async () => {
        try {
          option.button.press()
        } finally {
          world.tag = null
        }
      })
      await flush()
      const counted = world.reads.length !== sentBefore || snapshot(tree) !== before
      if (!own && !counted) {
        world.presses -= 1
      }
      if (!own && counted && leaving) {
        world.left = world.presses
      }
      if (!own && counted && store && (label === LABEL.pay || label === LABEL.continue)) {
        world.buying.add(world.presses)
      }
      // Try again reads the reconnect again.
      if (label === LABEL.retry) {
        counts.O4 += 1
        if (world.reads.filter(r => r.route === 'adopt').length === adoptsBefore) {
          fail('O4 Try again does not read the reconnect again', name, history.join(' > '), tree)
        }
      }
      // Send to support writes nothing, and adds nothing on screen but the support card.
      if (mail) {
        counts.O2 += 1
        if (
          snapshot(tree, outsideSupportCard) !== beforeBesideCard ||
          JSON.stringify((await readJson<BookShape>(BOOK_FILE)) ?? {}) !== JSON.stringify(bookBefore)
        ) {
          fail('O2 Send to support changed the screen or the book', name, history.join(' > '), tree)
        }
      }
      await check(`press ${label}`, false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else if (option.kind === 'tick') {
      world.ticked = true
      history.push('tick')
      await ReactTestRenderer.act(async () => {
        option.tick()
      })
      await flush()
      await check('tick', false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else if (option.kind === 'sync') {
      world.synced = true
      history.push('sync')
      await ReactTestRenderer.act(async () => {
        rootSync()
      })
      await flush()
      await check('sync', false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else if (option.kind === 'type') {
      world.typed = true
      history.push(`type ${option.root}`)
      await ReactTestRenderer.act(async () => {
        tree.root.findAllByType(TextInput)[0]!.props.onChangeText(option.root)
      })
      await flush()
      await check('type', false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else if (option.kind === 'toggle') {
      world.toggled = true
      history.push('toggle')
      await ReactTestRenderer.act(async () => {
        places(tree).find(p => !p.selected)!.press()
      })
      await flush()
      await check('toggle', false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else if (option.kind === 'recover') {
      world.recovered = true
      world.staleDenial = DENIALS.some(line => texts(tree).includes(line))
      history.push('recover')
      // The recovery files a proof of a payment the gateway says this wallet is owed.
      await RNFS.writeFile(PENDING_FILE, JSON.stringify({ w_a: { host: HOST, reference: OWED_REF, amountSats: 5000, isRoot: false } }))
      await flush()
      await check('recover', false, null, buysBefore, ordersBefore, claimsBefore, blockedBefore)
    } else {
      const stale = superseded(option.read)
      history.push(`${option.read.route}${option.read.origin === 'root' ? '(root)' : ''}${option.read.poll ? '(poll)' : ''}${stale ? '(stale)' : ''}`)
      world.stepPress = option.read.origin === 'root' ? null : option.read.press
      await ReactTestRenderer.act(async () => {
        option.read.settle!()
      })
      await flush()
      world.stepPress = null
      // The support mail's identity read lands its card under the press, and nothing else.
      const mailRead = option.read.origin === 'mail'
      await check(option.read.route, stale, mailRead ? beforeBesideCard : before, buysBefore, ordersBefore, claimsBefore, blockedBefore, mailRead)
    }
  }
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  return trace
}

async function explore(plan: Plan): Promise<void> {
  let prefix: number[] = []
  for (let runs = 0; ; runs++) {
    if (runs > 20_000) {
      throw new Error(`too many schedules for ${describePlan(plan)}`)
    }
    const trace = await play(plan, prefix)
    counts.schedules += 1
    let i = trace.length - 1
    while (i >= 0 && trace[i]![0] + 1 >= trace[i]![1]) {
      i--
    }
    if (i < 0) {
      return
    }
    prefix = [...trace.slice(0, i).map(([c]) => c), trace[i]![0] + 1]
  }
}

test('every schedule of the domain year keeps the invariants', async () => {
  const perGroup = new Map<string, number>()
  // A run can narrow the plans by group or by a piece of their name, read by a computed key, since
  // the Babel config inlines a literal process.env member at transform time and the cache keeps it.
  const option = (name: string): string | undefined => process.env[`SCHEDULE_${name}`]
  const group = option('GROUP')
  const match = option('MATCH')
  for (const plan of PLANS.filter(p => (!group || p.group === group) && (!match || describePlan(p).includes(match)))) {
    const before = counts.schedules
    const t0 = Date.now()
    await explore(plan)
    perGroup.set(plan.group, (perGroup.get(plan.group) ?? 0) + counts.schedules - before)
    if (option('DEBUG')) {
      console.log(`${describePlan(plan)} schedules=${counts.schedules - before} ms=${Date.now() - t0}`)
    }
  }
  console.log(
    `domain year plans=${PLANS.length} schedules=${counts.schedules} ${[...perGroup].map(([g, n]) => `${g}:${n}`).join(' ')} ` +
      `O1=${counts.O1} O2=${counts.O2} O3=${counts.O3} O4=${counts.O4} O5=${counts.O5} O6=${counts.O6} line=${counts.line} O7=${counts.O7} (steps whose precondition held)`,
  )
  const report = [...failures].map(([key, { first, steps }]) => `${key} (${steps} steps) first: ${first}`)
  expect(report).toEqual([])
  // An oracle whose precondition never held passed by emptiness.
  for (const oracle of ['O1', 'O2', 'O3', 'O4', 'O5', 'O6', 'line', 'O7'] as const) {
    expect(counts[oracle]).toBeGreaterThan(0)
  }
  // The cap is for a machine running other suites at the same time; at normal load the two files take
  // well under it together.
}, 1_200_000)
