import React, { Profiler, useEffect, useState } from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { StoreNameOffer } from '../src/components/StoreNameOffer'
import { GradientButton } from '../src/components/GradientButton'
import { Skeleton } from '../src/components/Skeleton'
import { SupportMailCard } from '../src/components/SupportMail'
import { sparkCheckLnAddress, sparkGetIdentityPubkey, sparkGetLnAddress, type SparkLnAddress } from '../src/wallet/spark'
import { currentDeps } from '../src/wallet/namePurchase'
import { creditFor, nameProduct } from '../src/wallet/nameCredit'
import { liveStoreContext, syncStorePurchases, type StoreContext, type StoreCredit } from '../src/wallet/storePurchase'
import type { NativeBuyResult, NativeProduct, NativePurchase } from '../specs/NativeVoltzStore'

// The schedule harness of the name sheet (docs/store-bridge.md, "Reads and invariants"). The real
// StoreNameOffer runs against the real store flow, with the identity read, every gateway route, every
// store call, the address and the register held as a deferred this file settles. For each plan it
// plays every order of the settles, with the plan's presses and events inserted at every position,
// and after every step it checks one oracle per invariant, O6 liveness and O7 no false denial. A
// second press lands at every position too, between the first press and each of its settles as well
// as after them.
//
// The book (store-orders.json) is read from the in-memory file system and answers at once, the way
// the device's disk answers ahead of any network read, and every write to it lands. Its value is the
// starting book. One group holds the read the sheet's listener makes of it after the root's sync
// settled an order, which is what a press can land in front of.
//
// Events beside the settles and the presses:
// - The root's sync, as the app's root runs it on a foreground or a connect, with no press. Its list
//   read, its identity read and its confirmation are held like the others, and it settles whatever
//   verdict the plan gives.
// - Typing another name, once, between the name the book is about and a name the credit does not cover.
// - Close, which closes the sheet and opens it again at once, within the sheet's closing animation,
//   when the same StoreNameOffer is still mounted; and Send to support, which opens the mail, adds
//   only the support card on screen and supersedes no read.
// - The sheet's own back control, once, at any step, which closes the sheet and opens it again the
//   same way, so a press is left running behind an opening of its own.
//
// Outcome values pruned, and why:
// - The price always answers with a price. One that fails or never answers keeps Buy disabled by the
//   price check itself, which storeNameOffer.test.tsx covers. Its order against the other reads is
//   still enumerated.
// - The credits read fails with a 500 and never on the connection. storeCredits maps both to null,
//   so the sheet cannot tell them apart, and the 500 is the one a line about the connection misnames.
// - The store's open list answers or never answers, and never fails. storeOrderViews holds every
//   purchase on a list it cannot read, which shows what `listed` shows, and syncStorePurchases reads a
//   list it cannot read as empty, which shows what `empty` shows. A list read after the open always
//   answers, so the root's sync always settles.
// - A press's own store reads answer one value each. The order is handed out (REF while the book's is
//   open, another once it settled), and the store answers Ask to Buy. Their refusals each set one error
//   line and open nothing, which the hand-written tests drive.
// - The spend intent is recorded, the register lands, the address reads as none and the name as free.
//   Their failures each run through spendFailed and verify, which storeNameOffer.test.tsx drives one
//   by one; here they would each end on one line and change no gating read.
// - A confirmation's `retry` verdict is a 503 whose three retries inside sendSigned answer at once.
//   The verdict is what the screens read; how many sequential 503s produced it they cannot tell.
// - A check is kept after a delivery (`checkingPaid`). The other kinds pick another line and run the
//   same reads through verify, which the hand-written tests drive.
// - A purchase that carries no reference (`noReference`) never reaches a screen through a sync:
//   settleStorePurchase answers it before notifying any listener and writes nothing.
// - The wallet is always w_a and opened every order, so the sync's `otherWallet` and `noWallet`
//   waits never arise; the screens ignore every `waiting` result, and storePurchase.test.ts covers them.
// - A book write never fails. dropStoreWait, keepNameCheck, endNameChecks and dismissStoreOutcome
//   failing each leave the book as it was, and the sheet catches all but dropStoreWait's, which says
//   `store.retry` under the wait it could not leave.
// - Plans come in groups. Each group holds the reads and inserts the events that decide what it
//   checks, and every other read answers at once, so the schedules grow by group and not by product
//   (see PLANS).

const DOMAIN = 'usevoltz.app'
const NAME = 'alice1'
// A name of the short tier, which the standard credit does not cover.
const OTHER_NAME = 'bob'
const PRICE = 'US$ 9.99'
const SHORT_PRICE = 'US$ 49.99'
const PUBKEY = `02${'a'.repeat(64)}`
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'store' }))

jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => 'usevoltz.app'),
  sparkGetLnAddress: jest.fn(),
  sparkCheckLnAddress: jest.fn(),
  sparkRegisterLnAddress: jest.fn(),
  sparkGetIdentityPubkey: jest.fn(),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkConnectedWalletId: () => 'w_a',
  onSparkConnected: () => () => undefined,
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({ wallets: [{ id: 'w_a' }], activeId: 'w_a' })),
  getActiveWalletId: jest.fn(async () => 'w_a'),
}))

// The button keeps its props, which the harness reads (label, disabled, loading, onPress), and drops
// the gradient and the spinner, which cost a render on every step and decide nothing here.
jest.mock('../src/components/GradientButton', () => ({ GradientButton: () => null }))

// The gateway's retries wait in the app and not here.
jest.mock('../src/wallet/namePurchase', () => {
  const real = jest.requireActual('../src/wallet/namePurchase')
  return { ...real, currentDeps: async () => ({ ...(await real.currentDeps()), sleep: async () => undefined }) }
})

// The sheet's own writes to the book, and the purchase that opens an order, are reported to O2, which
// tells an earlier press's write after a later press from what the store flow writes for a verdict. A
// verdict is a fact about the order, written whichever press asked. The sheet's listener is marked
// while it runs, so the book read it makes can be held.
let mockWrote: (fn: string) => void = () => undefined
let mockListening = (_on: boolean): void => undefined
jest.mock('../src/wallet/storePurchase', () => {
  const real = jest.requireActual('../src/wallet/storePurchase') as Record<string, (...args: never[]) => unknown>
  const reported =
    (fn: string) =>
    (...args: never[]) => {
      mockWrote(fn)
      return real[fn]!(...args)
    }
  return {
    ...real,
    onStoreSettled: (cb: (reference: string, result: unknown) => void) =>
      real.onStoreSettled!(((reference: string, result: unknown) => {
        mockListening(true)
        try {
          cb(reference, result)
        } finally {
          mockListening(false)
        }
      }) as never),
    keepNameCheck: reported('keepNameCheck'),
    endNameChecks: reported('endNameChecks'),
    dismissStoreOutcome: reported('dismissStoreOutcome'),
    dropStoreWait: reported('dropStoreWait'),
    buyInStore: reported('buyInStore'),
  }
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

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as Record<
  string,
  Record<string, string>
>
const fill = (text: string, values: Record<string, string>): string =>
  Object.entries(values).reduce((out, [k, v]) => out.split(`{{${k}}}`).join(v), text)

const LABEL = {
  buy: en.store.buyName!,
  use: en.receive.lnUseName!,
  check: en.receive.lnCheckAgain!,
  stop: en.store.stopWaiting!,
  close: en.common.close!,
  support: en.recover.sendToSupport!,
}
// The buttons a press may land on in every plan, and the two a plan with `closing` or a second press
// adds.
const PRESSABLE = new Set([LABEL.buy, LABEL.use, LABEL.check, LABEL.stop])
const CLOSING = new Set([LABEL.close, LABEL.support])
const PRICES: Record<string, string> = { name_standard: PRICE, name_short: SHORT_PRICE }
const priceLine = (name: string): string => fill(en.store.namePrice!, { name, price: PRICES[nameProduct(name)]! })

// What each starting book keeps on screen, and the line that says so.
type Kept = 'nothing' | 'check' | 'wait' | 'askToBuy' | 'support' | 'refusal' | 'delivered' | 'dropped'
const KEPT_LINE: Partial<Record<Kept, string>> = {
  check: fill(en.store.checkingPaid!, { name: NAME }),
  wait: en.store.waitingTitle!,
  askToBuy: en.store.waitingTitle!,
  support: en.store.support!,
  refusal: en.store.refusedTitle!,
}
// Lines that say a purchase failed or may not have gone through.
const FAILURE_LINES = [en.store.retry!, en.receive.lnFailed!]
// The name's availability line, which the address sheet shows while the offer is up.
const AVAILABLE = en.receive.lnAvailable!
// The lines O7 looks for, every one whose text says nothing was charged or the payment did not go
// through. A test purchase's refusal is the gateway's verified answer that the store charged
// nothing, so it may show beside that refusal and nowhere else.
const DENIALS = [en.receive.lnPayFailed!, en.useDomain.payFailed!, en.store.refusedTest!]
const TEST_REFUSALS = new Set(['403 environment_not_allowed', '403 xcode_environment'])
// A line that names the connection as a cause. None of this harness's failures is on the connection.
const NAMES_CONNECTION = /connection/i

// The gateway's id shape, the SHA-256 of a payment reference in hex.
const credit: StoreCredit = { id: 'c1d2'.repeat(16), domain: DOMAIN, tier: 'standard', state: 'available', name: null, grantedAt: 1_800_000_000 }
const purchase: NativePurchase = {
  productIds: ['name_standard'],
  key: 'tx-1',
  reference: REF.toUpperCase(),
  state: 'purchased',
  purchasedAt: 1,
  verified: true,
  revoked: false,
}
const opened = { orders: { [REF]: 'w_a' }, about: { [REF]: { kind: 'name', place: DOMAIN, subject: NAME } } }
const BOOKS: Record<Kept, object> = {
  nothing: {},
  check: { checks: { [`w_a ${DOMAIN} ${NAME}`]: { domain: DOMAIN, name: NAME, after: 'delivered', attempt: [], wallet: 'w_a' } } },
  // A paid purchase the gateway has not confirmed, which the store's list holds.
  wait: { ...opened, bought: { [REF]: 'purchased' } },
  // An Ask to Buy on Apple, which has no transaction until it is approved.
  askToBuy: { ...opened, bought: { [REF]: 'pending' } },
  support: { ...opened, outcomes: { [REF]: { kind: 'support', code: 'wrong_bundle' } } },
  refusal: { ...opened, outcomes: { [REF]: { kind: 'refused', refusal: '409 refused' } } },
  // A name's delivery is its credit, which only the gateway's list keeps.
  delivered: {},
  // An order whose wait was left with Stop waiting while the store still lists its purchase, which the
  // root's sync then confirms.
  dropped: opened,
}

// The credits as one read answers them.
type Credits = 'credit' | 'none' | 'fails' | 'never'
type Listing = 'listed' | 'empty' | 'never'
// What the gateway answers a confirmation, as confirmVerdict reads it.
type Verdict = 'delivered' | 'refunded' | 'support' | 'unknownOrder' | 'pending' | 'notVerified' | 'later' | 'retry'
const VERDICTS: Verdict[] = ['delivered', 'refunded', 'support', 'unknownOrder', 'pending', 'notVerified', 'later', 'retry']
// Whether the identity read (currentDeps, the SDK's getInfo) answers, fails on every read before the
// first press, or fails on every read from the first press on.
type Identity = 'answers' | 'failsOpen' | 'failsPress'

// `book` is the read of the book the sheet's listener makes, the only one ever held.
type Route = 'products' | 'identity' | 'credits' | 'openList' | 'order' | 'buy' | 'confirm' | 'spend' | 'register' | 'address' | 'free' | 'book'
// The routes the base group holds; the identity read answers at once there.
const BASE_HELD: Route[] = ['products', 'credits', 'openList', 'order', 'buy', 'confirm', 'spend', 'register', 'address', 'free']

type Plan = {
  group: string
  kept: Kept
  // The open's credits read, and every later one until a delivery adds the credit.
  credits: Credits
  later: Credits
  // The open's list read, and every later one until a final verdict takes the purchase off the list.
  lists: [Listing, Exclude<Listing, 'never'>]
  verdict: Verdict
  identity: Identity
  // The routes whose reads are held and settled in every order; every other read answers at once,
  // which is the order a read that interacts with nothing the group checks takes on a device.
  held: Route[]
  sync: boolean
  presses: number
  typing: boolean
  closing: boolean
  back: boolean
}

const planOf = (over: Partial<Plan> & Pick<Plan, 'group' | 'kept'>): Plan => ({
  credits: 'none',
  later: 'none',
  lists: ['empty', 'empty'],
  verdict: 'later',
  identity: 'answers',
  held: BASE_HELD,
  sync: false,
  presses: 1,
  typing: false,
  closing: false,
  back: false,
  ...over,
})

// The plans, by group. Each group holds the reads and carries the events that decide what it
// checks, and answers every other read at once, so a group's schedules grow with its own alphabet.
type Lists = [Listing, Exclude<Listing, 'never'>]
const PLANS: Plan[] = [
  // Every kept outcome, and an Ask to Buy, which Apple keeps as a wait whatever the list says.
  ...(['nothing', 'refusal'] as const).flatMap(kept =>
    (['none', 'fails', 'never'] as Credits[]).map(credits => planOf({ group: 'base', kept, credits })),
  ),
  ...(['credit', 'none', 'fails', 'never'] as Credits[]).map(credits => planOf({ group: 'base', kept: 'check', credits, later: 'credit' })),
  ...(['wait', 'support'] as const).flatMap(kept =>
    ([
      ['listed', 'listed'],
      ['empty', 'empty'],
      ['never', 'listed'],
    ] as Lists[]).flatMap(lists =>
      ((kept === 'wait' ? ['fails', 'never'] : ['credit', 'fails', 'never']) as Credits[]).map(credits =>
        planOf({ group: 'base', kept, lists, credits, later: 'credit' }),
      ),
    ),
  ),
  ...([
    ['empty', 'empty'],
    ['empty', 'listed'],
  ] as Lists[]).flatMap(lists => (['none', 'never'] as Credits[]).map(credits => planOf({ group: 'base', kept: 'askToBuy', lists, credits }))),
  ...(['none', 'credit'] as Credits[]).flatMap(later =>
    (['credit', 'fails', 'never'] as Credits[]).map(credits => planOf({ group: 'base', kept: 'delivered', credits, later })),
  ),
  // Every confirmation verdict inside Check again, for a paid wait the store still lists, with the
  // open's credits read held across the press.
  ...VERDICTS.flatMap(verdict =>
    ([['credit', 'credit'], ['never', 'none']] as Array<[Credits, Credits]>).map(([credits, later]) =>
      planOf({ group: 'check verdict', kept: 'wait', lists: ['listed', 'listed'], credits, later, verdict, held: ['credits', 'confirm'] }),
    ),
  ),
  // The root's sync with no press, settling every verdict, under a paid wait and an approved Ask to Buy.
  ...VERDICTS.flatMap(verdict =>
    ([['credit', 'credit'], ['never', 'none']] as Array<[Credits, Credits]>).map(([credits, later]) =>
      planOf({ group: 'sync', kept: 'wait', lists: ['listed', 'listed'], credits, later, verdict, sync: true, held: ['credits', 'confirm'] }),
    ),
  ),
  ...(['delivered', 'support', 'refunded'] as Verdict[]).map(verdict =>
    planOf({ group: 'sync', kept: 'askToBuy', lists: ['empty', 'listed'], verdict, sync: true, held: ['credits', 'confirm'] }),
  ),
  // The root's sync confirming the waited purchase while a Check again runs, with the store's list
  // held too, so its answer lands before, inside and after every read of the check.
  ...(['refunded', 'support', 'unknownOrder', 'delivered'] as Verdict[]).map(verdict =>
    planOf({ group: 'sync in check', kept: 'wait', lists: ['listed', 'listed'], credits: 'never', later: 'none', verdict, sync: true, held: ['openList', 'credits', 'confirm'] }),
  ),
  // The identity read held, so the book shows before it answers (I1), and failing on the open and
  // from the first press on.
  ...(['check', 'wait', 'askToBuy', 'support', 'refusal'] as Kept[]).map(kept =>
    planOf({ group: 'identity', kept, lists: ['listed', 'listed'], credits: 'credit', later: 'credit', held: ['identity', 'credits'] }),
  ),
  ...(['failsOpen', 'failsPress'] as Identity[]).flatMap(identity =>
    ([
      ['nothing', ['empty', 'empty']],
      ['wait', ['listed', 'listed']],
      ['support', ['listed', 'listed']],
    ] as Array<[Kept, Lists]>).map(([kept, lists]) =>
      planOf({ group: 'identity', kept, lists, credits: 'credit', later: 'credit', identity, held: ['identity', 'credits'] }),
    ),
  ),
  // A second press at every point after the first, its reads still out or answered, Close and Send
  // to support included. A paid wait the store still lists is checked under a verdict that leaves it
  // waiting, one that ends it in a refusal and one that ends it in a support case, whose Close lands
  // while the check reads the credits again.
  ...([
    ['nothing', ['empty', 'empty'], 'none', 'later'],
    ['wait', ['listed', 'listed'], 'never', 'later'],
    ['wait', ['listed', 'listed'], 'never', 'refunded'],
    ['wait', ['listed', 'listed'], 'never', 'support'],
    ['support', ['listed', 'empty'], 'credit', 'later'],
    ['askToBuy', ['empty', 'empty'], 'none', 'later'],
  ] as Array<[Kept, Lists, Credits, Verdict]>).map(([kept, lists, credits, verdict]) =>
    planOf({
      group: 'second press',
      kept,
      lists,
      credits,
      later: credits === 'never' ? (verdict === 'later' ? 'none' : 'credit') : credits,
      verdict,
      presses: 2,
      closing: true,
      held: ['credits', 'confirm'],
    }),
  ),
  // A paid wait the store lets go while a Check again reads it, with no credit delivered, which gives
  // the offer back.
  ...([
    ['listed', 'empty'],
    ['never', 'empty'],
  ] as Lists[]).map(lists => planOf({ group: 'wait gone', kept: 'wait', lists, credits: 'none', later: 'none', held: ['openList', 'credits'] })),
  // The root's sync settles another order of the domain while the offer is up, and Buy lands before
  // and after the sheet's listener has read what it wrote, for the name of that order and for another.
  ...(['support', 'refunded', 'unknownOrder'] as Verdict[]).map(verdict =>
    planOf({ group: 'sync another', kept: 'dropped', lists: ['listed', 'listed'], verdict, sync: true, typing: true, held: ['confirm', 'book'] }),
  ),
  // The root's sync settling that order while the gateway hands it back to a Buy.
  ...(['delivered', 'refunded'] as Verdict[]).map(verdict =>
    planOf({ group: 'sync another', kept: 'dropped', lists: ['listed', 'listed'], verdict, sync: true, held: ['confirm', 'order'] }),
  ),
  // Typing another name.
  planOf({ group: 'typing', kept: 'nothing', typing: true, held: ['credits', 'products'] }),
  planOf({ group: 'typing', kept: 'delivered', credits: 'credit', later: 'credit', typing: true, held: ['credits', 'products'] }),
  // Close, which reopens the sheet, and Send to support.
  planOf({ group: 'closing', kept: 'support', lists: ['listed', 'listed'], credits: 'fails', later: 'credit', closing: true, held: ['credits', 'identity'] }),
  planOf({ group: 'closing', kept: 'refusal', closing: true, held: ['credits', 'identity'] }),
  // The sheet closed behind a press reading the credits, which is Buy, Use this name on a credit still
  // there and on one gone by the press, and a Check again on a wait the store let go whose credits
  // then fail.
  planOf({ group: 'closing', kept: 'nothing', back: true, held: ['credits'] }),
  ...(['credit', 'none'] as Credits[]).map(later => planOf({ group: 'closing', kept: 'delivered', credits: 'credit', later, back: true, held: ['credits'] })),
  planOf({ group: 'closing', kept: 'wait', lists: ['listed', 'empty'], credits: 'never', later: 'fails', back: true, held: ['credits'] }),
  // The sheet closed behind a Buy waiting on its order or on the store's list.
  planOf({ group: 'closing', kept: 'nothing', back: true, held: ['order', 'openList'] }),
]

type Outcome = { value: unknown } | { error: unknown } | 'never'
type Read = {
  route: Route
  // The press the read was sent under, and whether the root's sync or the support mail sent it rather
  // than the sheet.
  press: number
  origin: 'sheet' | 'root' | 'mail'
  settle: (() => void) | null
  settled: boolean
  failed: boolean
  value?: unknown
}

// One run's world, rebuilt from nothing before every schedule.
const world = {
  plan: PLANS[0]!,
  reads: [] as Read[],
  // How many presses changed something, which is what supersedes a read sent before them.
  presses: 0,
  // How many presses were made, effective or not.
  pressed: 0,
  buys: 0,
  commits: 0,
  sent: {} as Partial<Record<Route, number>>,
  // Whether the one press landed on Buy with the price of the typed name on screen.
  purchasePress: false,
  // A confirmation answered delivered, and the store let the purchase go.
  delivered: false,
  finished: false,
  // The confirmation fetches a 503 left to answer at once.
  retries: 0,
  tag: null as 'root' | 'mail' | null,
  // A read sent while a settle is played belongs to the settled read's press, since the read is its
  // continuation. Null outside a settle, where a read belongs to the latest press.
  stepPress: null as number | null,
  synced: false,
  typed: false,
  name: NAME,
  error: null as string | null,
  taken: new Set<string>(),
  refusal: null as string | null,
  retype: (_name: string): void => undefined,
  listening: false,
  // The sheet's writes an earlier press made after a later one.
  lateWrites: [] as string[],
  backed: false,
  close: (): void => undefined,
  // The press during which the screen last showed a refusal or a support case.
  outcomeAt: null as number | null,
  // The order the store last opened for.
  boughtFor: null as string | null,
}

mockWrote = fn => {
  if (world.stepPress !== null && world.stepPress < world.presses) {
    world.lateWrites.push(fn)
  }
}
mockListening = on => {
  world.listening = on
}

const reply = (status: number, body: unknown): { status: number; body: unknown } => ({ status, body })

function creditsReply(value: Credits): Outcome {
  if (value === 'never') {
    return 'never'
  }
  return { value: value === 'fails' ? reply(500, { error: 'boom' }) : reply(200, { credits: value === 'credit' ? [credit] : [] }) }
}

const VERDICT_REPLY: Record<Verdict, { status: number; body: unknown }> = {
  delivered: reply(200, { state: 'delivered', reference: REF, kind: 'name' }),
  refunded: reply(409, { error: 'refunded' }),
  support: reply(409, { error: 'wrong_bundle' }),
  unknownOrder: reply(409, { error: 'unknown_order' }),
  pending: reply(402, { error: 'purchase_pending' }),
  notVerified: reply(402, { error: 'not_paid' }),
  later: reply(429, { error: 'too many requests' }),
  retry: reply(503, { error: 'unavailable' }),
}

function outcomeOf(route: Route, n: number, body: Record<string, unknown>): Outcome {
  const { plan } = world
  switch (route) {
    case 'products':
      return {
        value: [
          { id: 'name_standard', displayPrice: PRICE },
          { id: 'name_short', displayPrice: SHORT_PRICE },
        ] satisfies NativeProduct[],
      }
    case 'identity': {
      const fails = (plan.identity === 'failsOpen' && world.pressed === 0) || (plan.identity === 'failsPress' && world.pressed > 0)
      return fails ? { error: new Error('not connected') } : { value: PUBKEY }
    }
    case 'credits':
      return creditsReply(world.delivered ? 'credit' : n === 0 ? plan.credits : plan.later)
    case 'openList': {
      const listing = world.finished ? 'empty' : n === 0 ? plan.lists[0] : plan.lists[1]
      return listing === 'never' ? 'never' : { value: listing === 'listed' ? [purchase] : [] }
    }
    case 'order': {
      // The gateway hands back the order it holds for the name while it is open, and opens another
      // for another name or once the book's has settled.
      const subject = String(body.subject)
      const reference = subject === NAME && !world.finished ? REF : REF_B
      return {
        value: reply(200, { reference, productId: nameProduct(subject), state: 'held', kind: 'name', subject, appAccountToken: reference }),
      }
    }
    case 'buy':
      return { value: { status: 'pending', code: null, subCode: null, message: null, purchase: null } satisfies NativeBuyResult }
    case 'confirm':
      return { value: VERDICT_REPLY[plan.verdict] }
    case 'spend':
      return { value: reply(200, { recorded: true, username: body.username, expiresAt: 1_900_000_000 }) }
    case 'register':
      return { value: { username: String(body.username), address: `${String(body.username)}@${DOMAIN}`, lnurl: 'lnurl1' } satisfies SparkLnAddress }
    case 'address':
      return { value: null }
    case 'free':
      return { value: true }
    case 'book':
      return { value: undefined }
  }
}

function issue<T>(route: Route, body: Record<string, unknown> = {}): Promise<T> {
  const n = world.sent[route] ?? 0
  world.sent[route] = n + 1
  const outcome = outcomeOf(route, n, body)
  return new Promise<T>((resolve, reject) => {
    const read: Read = { route, press: world.stepPress ?? world.presses, origin: world.tag ?? 'sheet', settle: null, settled: false, failed: false }
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

const ROUTES: Record<string, Route> = {
  '/api/store/credits': 'credits',
  '/api/store/order': 'order',
  '/api/store/confirm': 'confirm',
  '/api/store/spend': 'spend',
}

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
    return respond(await issue<{ status: number; body: unknown }>(route, body))
  }) as unknown as typeof fetch
  jest.spyOn(double.default, 'loadProducts').mockImplementation(() => issue('products'))
  jest.spyOn(double.default, 'openPurchases').mockImplementation(() => issue('openList'))
  jest.spyOn(double.default, 'buy').mockImplementation((_productId: string, reference: string) => {
    world.buys += 1
    world.boughtFor = reference.toLowerCase()
    return issue('buy')
  })
  jest.mocked(sparkGetIdentityPubkey).mockImplementation(() => issue('identity'))
  jest.mocked(sparkGetLnAddress).mockImplementation(() => issue('address'))
  jest.mocked(sparkCheckLnAddress).mockImplementation(() => issue('free'))
  jest.spyOn(RNFS, 'exists').mockImplementation(async (file: string) => {
    if (file === BOOK_FILE && world.listening && world.plan.held.includes('book')) {
      await issue('book')
    }
    return fileExists(file)
  })
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
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

// The address sheet's part, reduced to what the offer reports back, which is its error line, a
// registered name, the names refused as taken, and whether a view took the offer over, which hides
// the name's availability line as LnAddressSheet does. A close is followed at once by the person
// opening the sheet again, which runs a new open.
function Sheet(): React.JSX.Element {
  const [error, setError] = useState<string | null>(null)
  const [takeover, setTakeover] = useState(false)
  const [taken, setTaken] = useState<ReadonlySet<string>>(() => new Set())
  const [registered, setRegistered] = useState<string | null>(null)
  const [visible, setVisible] = useState(true)
  const [name, setName] = useState(NAME)
  world.retype = setName
  world.close = () => {
    setError(null)
    setVisible(false)
  }
  world.name = name
  world.error = error
  world.taken = taken as Set<string>
  useEffect(() => {
    if (!visible) {
      setVisible(true)
    }
  }, [visible])
  // A name registered finishes the sheet, as LnAddressSheet does.
  if (registered !== null) {
    return <Text>{`registered ${registered}`}</Text>
  }
  return (
    <>
      {error !== null ? <Text>{error}</Text> : null}
      {takeover ? null : <Text>{AVAILABLE}</Text>}
      <StoreNameOffer
        visible={visible}
        name={name}
        available
        namesFree={false}
        taken={taken}
        warnBeforeChange={go => go()}
        claim={async target => {
          const held = await issue<SparkLnAddress>('register', { username: target })
          setRegistered(held.username)
        }}
        onRegistered={held => setRegistered(held.username)}
        onTaken={target => setTaken(prev => new Set(prev).add(target))}
        onError={setError}
        onTakeover={setTakeover}
        onClose={() => world.close()}
      />
    </>
  )
}

type Tree = ReactTestRenderer.ReactTestRenderer
type Instance = ReactTestRenderer.ReactTestInstance

function texts(tree: Tree, keep: (node: Instance) => boolean = () => true): string[] {
  return tree.root.findAllByType(Text).filter(keep).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter((c): c is string => typeof c === 'string')
  })
}

type Button = { label: string; enabled: boolean; loading: boolean; press: () => void }
function buttons(tree: Tree, keep: (node: Instance) => boolean = () => true): Button[] {
  return tree.root.findAllByType(GradientButton).filter(keep).map(node => ({
    label: node.props.label as string,
    enabled: !node.props.disabled && !node.props.loading,
    loading: node.props.loading === true,
    press: node.props.onPress as () => void,
  }))
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
  checks?: Record<string, unknown>
  about?: Record<string, { subject: string }>
}
async function readBook(): Promise<BookShape> {
  try {
    return JSON.parse(await RNFS.readFile(BOOK_FILE)) as BookShape
  } catch {
    return {}
  }
}

function latest(route: Route, where: (read: Read) => boolean = () => true): Read | undefined {
  return [...world.reads].reverse().find(r => r.route === route && where(r))
}
// The latest read of a route the sheet sent since the last press, which is the one it may act on. A
// read sent before the press is superseded, and a press that needs the route reads it again.
function current(route: Route): Read | undefined {
  return latest(route, r => r.origin === 'sheet' && r.press === world.presses)
}
// Whether the store's list holds the purchase, as its latest answer says. A list that has not answered
// holds it.
function listed(): boolean {
  const list = latest('openList', r => r.settled) ?? latest('openList')
  return list === undefined || !list.settled || (list.value as NativePurchase[]).some(p => p.key === purchase.key)
}

// Whether the book still holds an order or a check as unsettled, given what the store's list last
// answered (docs/store-bridge.md, rules 1 and 4).
function keptOpen(book: BookShape): boolean {
  if (Object.keys(book.checks ?? {}).length > 0) {
    return true
  }
  return Object.keys(book.about ?? {}).some(reference => {
    const outcome = book.outcomes?.[reference]
    const held = reference === REF && listed()
    if (outcome) {
      return outcome.kind === 'refused' || (outcome.kind === 'support' && held)
    }
    const bought = book.bought?.[reference]
    return bought === 'pending' || (bought === 'purchased' && held)
  })
}

// The credits as the sheet's latest attempt to read them left them, looked for in the latest press's
// reads first and in each earlier press's after. They are the list its latest answered read gave, or
// null when that read gave no list or the identity read the attempt needed failed.
function lastCredits(): StoreCredit[] | null {
  for (let press = world.presses; press >= 0; press--) {
    const attempt = latest(
      'credits',
      r => r.origin === 'sheet' && r.press === press && r.settled,
    )
    const failed = latest('identity', r => r.origin === 'sheet' && r.press === press && r.failed)
    if (failed && (!attempt || world.reads.indexOf(failed) > world.reads.indexOf(attempt))) {
      return null
    }
    if (attempt) {
      const body = attempt.value as { status: number; body: { credits?: StoreCredit[] } }
      return body.status === 200 && Array.isArray(body.body.credits) ? body.body.credits : null
    }
  }
  return null
}

function covering(): boolean {
  const list = current('credits')
  if (!list?.settled) {
    return false
  }
  const body = (list.value as { status: number; body: { credits?: StoreCredit[] } }).body
  return Array.isArray(body.credits) && creditFor(body.credits, DOMAIN, world.name) !== null
}

// A gating read is out when the sheet has not read it since the last press with an answer. That
// holds for the credits always, for the store's list when the sheet asked it, and for the price.
function gateOut(): boolean {
  const list = current('credits')
  const credits = list === undefined || !list.settled || (list.value as { status: number }).status !== 200
  const pending = (read: Read | undefined): boolean => read !== undefined && !read.settled
  return credits || pending(current('openList')) || pending(latest('products'))
}

// Whether the sheet no longer waits on a read, which it does not once a later press followed the press
// that sent it. The price applies whenever it answers, so no press supersedes it, and the support
// mail's identity read is not the sheet's.
function superseded(read: Read): boolean {
  return read.origin === 'mail' || (read.origin === 'sheet' && read.route !== 'products' && read.press < world.presses)
}
// Whether the sheet waits on nothing, every read having answered or been superseded.
const quiet = (): boolean => world.reads.every(r => r.settled || superseded(r))

type Counts = { schedules: number; O1: number; O2: number; O3: number; O4: number; O6: number; O7: number; rule4: number }
const counts: Counts = { schedules: 0, O1: 0, O2: 0, O3: 0, O4: 0, O6: 0, O7: 0, rule4: 0 }
// The first failing schedule of each oracle and plan, and how many steps failed in all.
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
  | { kind: 'sync' }
  | { kind: 'type' }
  | { kind: 'back' }
  | { kind: 'end' }

const describePlan = (plan: Plan): string =>
  `[${plan.group}: ${plan.kept} credits=${plan.credits}/${plan.later} lists=${plan.lists.join('/')} verdict=${plan.verdict} identity=${plan.identity}${plan.back ? ' back' : ''} held=${plan.held.length === BASE_HELD.length ? 'base' : plan.held.join(',')}]`

// One schedule, replaying `prefix` and taking the first option past it. Answers the choice made and
// the number of options at each step.
async function play(plan: Plan, prefix: number[]): Promise<Array<[number, number]>> {
  RNFS.__reset()
  double.control.reset()
  Object.assign(world, {
    plan,
    reads: [],
    presses: 0,
    pressed: 0,
    buys: 0,
    commits: 0,
    sent: {},
    purchasePress: false,
    delivered: false,
    finished: false,
    retries: 0,
    tag: null,
    stepPress: null,
    synced: false,
    typed: false,
    refusal: null,
    listening: false,
    lateWrites: [],
    backed: false,
    outcomeAt: null,
    boughtFor: null,
  })
  await RNFS.writeFile(BOOK_FILE, JSON.stringify(BOOKS[plan.kept]))
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <Profiler id="sheet" onRender={() => (world.commits += 1)}>
        <Sheet />
      </Profiler>,
    )
  })
  await flush()
  const trace: Array<[number, number]> = []
  let paid = false
  const name = describePlan(plan)
  const history: string[] = []

  async function check(
    step: string,
    stale: boolean,
    before: string | null,
    buysBefore: number,
    bookBefore: BookShape,
    besideCard = false,
  ): Promise<void> {
    const shown = texts(tree)
    const at = `${history.join(' > ')} @${step}`
    const book = await readBook()
    // O1 checks that what the book keeps is on screen from the first render after the book read,
    // before the identity read, the credits or the store's list answer.
    if (step === 'open' && KEPT_LINE[plan.kept]) {
      counts.O1 += 1
      if (!shown.includes(KEPT_LINE[plan.kept]!)) {
        fail('O1 the kept outcome is not on the first render', name, at, tree)
      }
    }
    // O2 checks that a read an earlier press sent changes neither the view nor the credits once a later
    // press came, the credits being read through what they put on screen, and that the earlier press
    // makes none of the sheet's own writes to the book (a check kept or ended, a wait dropped, an
    // outcome dismissed, an order opened) after it.
    if (stale && before !== null) {
      counts.O2 += 1
      if (snapshot(tree, besideCard ? outsideSupportCard : undefined) !== before) {
        fail('O2 a stale read changed the screen', name, at, tree)
      }
    }
    if (world.lateWrites.length > 0) {
      fail(`O2 an earlier press wrote the book after a later press: ${world.lateWrites.join(', ')}`, name, at, tree)
      world.lateWrites = []
    }
    // O2 also checks that a refusal or a support case on screen, which the root's sync may have brought
    // while a press ran, is never taken back by the wait within the same press, since the sync's
    // answer is the later outcome.
    if (shown.includes(en.store.refusedTitle!) || shown.includes(en.store.support!)) {
      world.outcomeAt = world.presses
    } else if (world.outcomeAt === world.presses) {
      counts.O2 += 1
      if (shown.includes(en.store.waitingTitle!)) {
        fail('O2 the wait came back over a refusal or a support case within one press', name, at, tree)
      }
    }
    // O3 checks that the store opens only after a press on Buy with the price on screen and never
    // beside an order the book keeps open, and that Buy is never enabled while a read that gates it is
    // out or shows something kept or covering. While the listener reads what the root's sync wrote the
    // sheet cannot know it yet, and Buy reads the book itself before it opens the store.
    const listening = world.reads.some(r => r.route === 'book' && !r.settled)
    const closed = gateOut() || (keptOpen(book) && !listening) || covering()
    const buy = buttons(tree).find(b => b.label === LABEL.buy)
    if (world.buys > buysBefore || (closed && buy)) {
      counts.O3 += 1
      if (world.buys > buysBefore && !world.purchasePress) {
        fail('O3 the store opened without a Buy press with its price', name, at, tree)
      }
      if (world.buys > buysBefore && keptOpen(bookBefore)) {
        fail('O3 the store opened beside an order the book keeps open', name, at, tree)
      }
      // The gateway delivered or refused the book's order for good, so the store opening for it again
      // takes a second payment.
      if (world.buys > buysBefore && world.finished && world.boughtFor === REF) {
        fail('O3 the store opened for an order already settled', name, at, tree)
      }
      if (closed && buy?.enabled) {
        fail('O3 Buy enabled with a gating read out or something kept or covering', name, at, tree)
      }
    }
    // O4 checks that once the name is done or paid for no line says the purchase failed, and that no
    // line names the connection, since nothing here failed on it.
    paid =
      paid ||
      world.delivered ||
      shown.includes(`registered ${NAME}`) ||
      shown.includes(fill(en.store.done!, { address: `${NAME}@${DOMAIN}` })) ||
      shown.includes(KEPT_LINE.check!)
    const connection = shown.some(line => NAMES_CONNECTION.test(line))
    if (paid || connection) {
      counts.O4 += 1
      if (paid && shown.some(line => FAILURE_LINES.includes(line))) {
        fail('O4 a failure line after delivered', name, at, tree)
      }
      if (connection) {
        fail('O4 a line names the connection', name, at, tree)
      }
    }
    // O6 checks liveness. Once the sheet waits on nothing and nothing kept, taken or unknown blocks the
    // sale, Buy or Use this name is on screen and enabled. A purchase that needs support blocks Buy
    // and never a credit the latest credits answer shows covering the name (rule 4).
    const done = shown.some(line => line.startsWith('registered '))
    if (quiet() && !done) {
      const credits = lastCredits()
      const primary = buttons(tree).find(b => b.label === LABEL.buy || b.label === LABEL.use)
      const blocked = keptOpen(book) || world.taken.has(world.name) || credits === null
      if (!blocked) {
        counts.O6 += 1
        if (!primary?.enabled) {
          fail('O6 the sheet waits on nothing and offers no Buy or Use this name', name, at, tree)
        }
      }
      if (shown.includes(en.store.support!) && credits !== null && creditFor(credits, DOMAIN, world.name) !== null) {
        counts.rule4 += 1
        const use = buttons(tree).find(b => b.label === LABEL.use)
        if (!use?.enabled) {
          fail('O6 rule 4: support hides a credit the wallet holds', name, at, tree)
        }
        // The credit is on offer, so the sheet still shows the name's availability around it.
        if (!shown.includes(AVAILABLE)) {
          fail('O6 rule 4: support takes the sheet over beside a credit the wallet holds', name, at, tree)
        }
      }
    }
    // O7 checks that no line denies a charge on a store build, but a test purchase's refusal beside
    // the refusal it explains.
    const refusal = Object.values(book.outcomes ?? {}).find(o => o.kind === 'refused')?.refusal
    if (world.error !== null || book.bought?.[REF] === 'purchased' || world.delivered) {
      counts.O7 += 1
    }
    for (const line of DENIALS) {
      if (shown.includes(line) && !(line === en.store.refusedTest && refusal !== undefined && TEST_REFUSALS.has(refusal))) {
        fail(`O7 a line denies a charge: ${line}`, name, at, tree)
      }
    }
  }

  await check('open', false, null, 0, await readBook())
  for (let step = 0; step < 80; step++) {
    const settles = world.reads.filter(r => r.settle !== null && !r.settled)
    // A second press lands at every position, its first press's reads still out or answered.
    const pressable = plan.closing ? new Set([...PRESSABLE, ...CLOSING]) : PRESSABLE
    const presses =
      world.pressed >= plan.presses
        ? []
        : buttons(tree).filter((b, i, all) => b.enabled && pressable.has(b.label) && all.findIndex(o => o.label === b.label) === i)
    const options: Option[] = [
      ...settles.map((read): Option => ({ kind: 'settle', read })),
      ...presses.map((button): Option => ({ kind: 'press', button })),
      ...(plan.sync && !world.synced ? [{ kind: 'sync' } as Option] : []),
      ...(plan.typing && !world.typed ? [{ kind: 'type' } as Option] : []),
      ...(plan.back && !world.backed ? [{ kind: 'back' } as Option] : []),
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
    const bookBefore = await readBook()
    if (option.kind === 'press') {
      // A press supersedes the reads sent before it only if it did something; one that a press still
      // in flight turns away changes nothing and sends nothing. Send to support supersedes nothing.
      const mail = option.button.label === LABEL.support
      if (!mail) {
        world.presses += 1
      }
      world.pressed += 1
      world.purchasePress = option.button.label === LABEL.buy && texts(tree).includes(priceLine(world.name))
      const sentBefore = world.reads.length
      history.push(`press ${option.button.label}`)
      world.tag = mail ? 'mail' : null
      await ReactTestRenderer.act(async () => {
        try {
          option.button.press()
        } finally {
          world.tag = null
        }
      })
      await flush()
      if (!mail && world.reads.length === sentBefore && snapshot(tree) === before) {
        world.presses -= 1
      }
      // Send to support writes nothing, and adds nothing on screen but the support card.
      if (mail) {
        counts.O2 += 1
        if (snapshot(tree, outsideSupportCard) !== beforeBesideCard || JSON.stringify(await readBook()) !== JSON.stringify(bookBefore)) {
          fail('O2 Send to support changed the screen or the book', name, history.join(' > '), tree)
        }
      }
      await check(`press ${option.button.label}`, false, null, buysBefore, bookBefore)
    } else if (option.kind === 'sync') {
      world.synced = true
      history.push('sync')
      await ReactTestRenderer.act(async () => {
        rootSync()
      })
      await flush()
      await check('sync', false, null, buysBefore, bookBefore)
    } else if (option.kind === 'back') {
      // Closing and opening again supersedes every read sent before, as a press does, and is no press
      // on Buy.
      world.backed = true
      world.presses += 1
      world.purchasePress = false
      history.push('back')
      await ReactTestRenderer.act(async () => {
        world.close()
      })
      await flush()
      await check('back', false, null, buysBefore, bookBefore)
    } else if (option.kind === 'type') {
      world.typed = true
      history.push('type')
      await ReactTestRenderer.act(async () => {
        world.retype(OTHER_NAME)
      })
      await flush()
      await check('type', false, null, buysBefore, bookBefore)
    } else {
      const stale = superseded(option.read)
      history.push(`${option.read.route}${option.read.origin === 'root' ? '(root)' : ''}${stale ? '(stale)' : ''}`)
      world.stepPress = option.read.origin === 'root' ? null : option.read.press
      await ReactTestRenderer.act(async () => {
        option.read.settle!()
      })
      await flush()
      world.stepPress = null
      // The support mail's identity read lands its card under the press, and nothing else.
      const mailRead = option.read.origin === 'mail'
      await check(option.read.route, stale, mailRead ? beforeBesideCard : before, buysBefore, bookBefore, mailRead)
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

test('every schedule of the name sheet keeps the invariants', async () => {
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
    if (option('DEBUG')) {
      console.log(`${describePlan(plan)} schedules=${counts.schedules - before} ms=${Date.now() - t0}`)
    }
    perGroup.set(plan.group, (perGroup.get(plan.group) ?? 0) + counts.schedules - before)
  }
  console.log(
    `name sheet plans=${PLANS.length} schedules=${counts.schedules} ${[...perGroup].map(([g, n]) => `${g}:${n}`).join(' ')} ` +
      `O1=${counts.O1} O2=${counts.O2} O3=${counts.O3} O4=${counts.O4} O6=${counts.O6} rule4=${counts.rule4} O7=${counts.O7} (steps whose precondition held)`,
  )
  const report = [...failures].map(([key, { first, steps }]) => `${key} (${steps} steps) first: ${first}`)
  expect(report).toEqual([])
  // An oracle whose precondition never held passed by emptiness.
  for (const oracle of ['O1', 'O2', 'O3', 'O4', 'O6', 'rule4', 'O7'] as const) {
    expect(counts[oracle]).toBeGreaterThan(0)
  }
  // The cap is for a machine running other suites at the same time; at normal load the two files take
  // well under it together.
}, 1_200_000)
