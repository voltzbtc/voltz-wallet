import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text, TextInput } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { claimDomain, confirmDomain, fetchPrices, quoteDomain, savePendingPurchase } from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkPrepareSend } from '../src/wallet/spark'
import { formatDate } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import * as storePurchase from '../src/wallet/storePurchase'
import { DEFECT_REFUSALS, FINAL_REFUSALS, keepNameCheck, liveStoreContext, onStoreSettled, syncStorePurchases } from '../src/wallet/storePurchase'
import type { NativeBuyResult, NativePurchase } from '../specs/NativeVoltzStore'
import { carriedTexts, expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'

// The domain year in a build that sells through the store, bought and renewed through the real
// screen, the real store flow, the bridge's double and a gateway answering over fetch.

const HOST = 'pay.bakery.com.br'
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const PUBKEY = `02${'a'.repeat(64)}`
const NEW_EXPIRY = 1_800_000_000

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'store' }))

let mockParams: { renew?: string } | undefined
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: mockParams }) }))

jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => 'usevoltz.app'),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
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

jest.mock('../src/wallet/wallet', () => ({ reconnectActiveWallet: jest.fn(async () => undefined) }))

jest.mock('../src/wallet/domainOnboard', () => {
  const real = jest.requireActual('../src/wallet/domainOnboard')
  return { ...real, claimDomain: jest.fn(), quoteDomain: jest.fn(), confirmDomain: jest.fn(), fetchPrices: jest.fn() }
})

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
const double = jest.requireMock('../specs/NativeVoltzStore') as Double

const RNFS = (require('react-native-fs') as {
  default: {
    DocumentDirectoryPath: string
    exists(p: string): Promise<boolean>
    unlink(p: string): Promise<void>
    writeFile(p: string, c: string, e: string): Promise<void>
  }
}).default
const FILES = ['store-orders.json', 'domain-purchase.json']
  .flatMap(f => [f, `${f}.tmp`, `${f}.unreadable`, `${f}.tmp.unreadable`])
  .map(f => `${RNFS.DocumentDirectoryPath}/${f}`)

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  withdrawal: Record<string, string>
  store: Record<string, string>
  useDomain: Record<string, string>
  receive: Record<string, string>
  recover: Record<string, string>
  common: Record<string, string>
}
const fill = (text: string, values: Record<string, string>) =>
  Object.entries(values).reduce((out, [k, v]) => out.split(`{{${k}}}`).join(v), text)

type Reply = { status: number; body: unknown }
// A reply may be a promise, which holds the route until the test settles it.
let answers: Record<string, Array<Reply | Promise<Reply>>>
let calls: string[]

function gateway(): void {
  global.fetch = jest.fn(async (url: string, init: { body: string }) => {
    const route = new URL(url).pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push([route, body.kind, body.subject ?? body.reference].filter(Boolean).join(' '))
    const reply = await (answers[route] ?? []).shift()
    if (!reply) {
      throw new Error(`no answer left for ${route}`)
    }
    return { status: reply.status, ok: reply.status < 300, text: async () => JSON.stringify(reply.body) } as unknown as Response
  }) as unknown as typeof fetch
}

const order: Reply = {
  status: 200,
  body: { reference: REF, productId: 'domain_year', state: 'held', kind: 'tier', subject: HOST, appAccountToken: REF },
}
const delivered: Reply = {
  status: 200,
  body: { state: 'delivered', reference: REF, kind: 'tier', host: HOST, days: 365, expiresAt: NEW_EXPIRY, frozen: false },
}

const bought = (): NativeBuyResult => {
  const purchase: NativePurchase = {
    productIds: ['domain_year'],
    key: 'tx-1',
    reference: REF.toUpperCase(),
    state: 'purchased',
    purchasedAt: 1,
    verified: true,
    revoked: false,
  }
  double.control.state.open.push(purchase)
  return { status: 'purchased', code: null, subCode: null, message: null, purchase }
}
const askToBuy = (): NativeBuyResult => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null })

function live() {
  return { host: HOST, provider: 'cloudflare' as const, supportsRoot: true, isRoot: false, target: 'saas.usevoltz.app', state: 'awaiting_dns' as const }
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter((c): c is string => typeof c === 'string')
  })
}

function button(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  return tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))
}

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, round === 0 ? 30 : 10))
    })
  }
}

const trees: ReactTestRenderer.ReactTestRenderer[] = []

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  trees.push(tree)
  await settle()
  return tree
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = button(tree, label)
  if (!target) {
    throw new Error(`button not found: ${label}; on screen: ${texts(tree).join(' | ')}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

const PRICE = 'US$ 99.99'

beforeEach(async () => {
  jest.clearAllMocks()
  double.control.reset()
  double.control.state.products = [{ id: 'domain_year', displayPrice: PRICE }]
  answers = {}
  calls = []
  gateway()
  mockParams = { renew: HOST }
  jest.mocked(claimDomain).mockReset().mockResolvedValue(live())
  jest.mocked(quoteDomain).mockReset()
  jest.mocked(confirmDomain).mockReset()
  jest.mocked(fetchPrices).mockReset().mockResolvedValue({ domain_tier: 9990 })
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  for (const file of FILES) {
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  }
})

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    trees.splice(0).forEach(tree => tree.unmount())
  })
})

// Expected apart from the screen's own map. A refund the store already made and a test purchase are
// the only refusals that say no money is at stake; every other one is Apple's way back.
const NO_MONEY_AT_STAKE: Record<string, string> = {
  '409 refunded': 'refusedRefunded',
  '403 environment_not_allowed': 'refusedTest',
  '403 xcode_environment': 'refusedTest',
}
const refusedLine = (refusal: string): string => en.store[NO_MONEY_AT_STAKE[refusal] ?? 'refusedApple']!

describe('renewing a year', () => {
  test('shows the store price and nothing in sats', async () => {
    const tree = await render()
    const shown = texts(tree)
    expect(shown).toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    expect(shown.join(' ')).not.toMatch(/sats/)
    expect(quoteDomain).not.toHaveBeenCalled()
    expect(fetchPrices).not.toHaveBeenCalled()
  })

  test('shows the price only once Pay can show beside it', async () => {
    const priceLine = fill(en.useDomain.priceLine!, { price: PRICE })
    let answerBook!: (views: never[]) => void
    jest
      .spyOn(storePurchase, 'keptOrderViews')
      .mockImplementationOnce(() => new Promise(resolve => (answerBook = resolve)))

    const tree = await render()
    expect(texts(tree)).not.toContain(priceLine)
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(true)

    await ReactTestRenderer.act(async () => answerBook([]))
    await settle()
    expect(texts(tree)).toContain(priceLine)
    expect(texts(tree)).toContain(en.withdrawal.payLineApple)
    expect(texts(tree)).not.toContain(en.withdrawal.payLineSats)
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(false)
  })

  test('a store this device cannot reach offers nothing to pay', async () => {
    double.control.state.products = []
    const tree = await render()
    expect(texts(tree)).toContain(en.store.unavailable)
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(true)
  })

  test('a year the store is still pricing offers nothing to pay', async () => {
    jest.spyOn(double.default, 'loadProducts').mockImplementationOnce(() => new Promise(() => undefined))
    const tree = await render()
    expect(texts(tree)).not.toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(true)
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.pay!)
    expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
    expect(double.control.state.calls.buy).toEqual([])
  })

  // A torn copy with no book is a first write of the book that was cut, whose last finished state is no
  // book: the price shows, the purchase writes a book over it and nothing is set aside.
  test('a torn copy with no book leaves the price, and the purchase writes the book over it', async () => {
    const book = `${RNFS.DocumentDirectoryPath}/store-orders.json`
    await RNFS.writeFile(`${book}.tmp`, '{"orders": {"ord', 'utf8')
    const tree = await render()
    expect(texts(tree)).toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(false)
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.pay!)
    expect(double.control.state.calls.buy).toEqual([{ productId: 'domain_year', reference: REF, accountId: null }])
    expect(await Promise.all([`${book}.tmp`, `${book}.unreadable`, `${book}.tmp.unreadable`].map(f => RNFS.exists(f)))).toEqual([
      false,
      false,
      false,
    ])
    expect(await RNFS.exists(book)).toBe(true)
  })

  test('pays through the store with the domain year and never sends sats', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.pay!)
    expect(double.control.state.calls.buy).toEqual([{ productId: 'domain_year', reference: REF, accountId: null }])
    expect(calls).toEqual([`/api/store/order tier ${HOST}`, `/api/store/confirm ${REF}`])
    expect(sparkPrepareSend).not.toHaveBeenCalled()
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(
      fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(NEW_EXPIRY, deviceDateTimePrefs()) }),
    )
  })

  // On a renewal the hold on the host is the owner's own purchase still settling, never a stranger.
  test('a hold on the host reads as the renewal still settling', async () => {
    const tree = await render()
    answers['/api/store/order'] = [{ status: 409, body: { error: 'held_by_another_wallet' } }]
    await press(tree, en.useDomain.pay!)
    const shown = texts(tree)
    expect(shown).toContain(en.useDomain.renewalInProgress)
    expect(shown).not.toContain(en.useDomain.domainBeingBought)
    expect(double.control.state.calls.buy).toEqual([])
  })

  // The order stops on this device when the address was given up here, before the store opens and
  // before anything is signed, and the words point at the row that lifts the stop.
  test('a wallet whose address was given up here opens no order and is pointed to the way back', async () => {
    const marks = `${RNFS.DocumentDirectoryPath}/deletion.json`
    await RNFS.writeFile(marks, JSON.stringify({ w_a: { pubkey: PUBKEY, state: 'removed', askedAt: 1 } }), 'utf8')
    try {
      const tree = await render()
      await press(tree, en.useDomain.pay!)
      expect(texts(tree)).toContain(en.receive.lnOffBuy)
      expect(calls).toEqual([])
      expect(double.control.state.calls.buy).toEqual([])
    } finally {
      await RNFS.unlink(marks)
    }
  })

  test('a domain that went to another wallet says so', async () => {
    const tree = await render()
    answers['/api/store/order'] = [{ status: 409, body: { error: 'domain_belongs_to_another_wallet' } }]
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.useDomain.domainTaken)
  })

  test('an Ask to Buy waits, after a restart too, and leaving the wait brings the price back', async () => {
    const first = await render()
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(first, en.useDomain.pay!)
    expect(texts(first)).toContain(fill(en.store.waitingBody!, { name: HOST }))
    expect(button(first, en.useDomain.pay!)).toBeUndefined()
    await ReactTestRenderer.act(async () => {
      first.unmount()
    })
    trees.splice(0)
    const tree = await render()
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    await press(tree, en.store.stopWaiting!)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  test.each([...FINAL_REFUSALS])('a renewal refused with %s says what became of the money', async refusal => {
    const [status, code] = refusal.split(' ')
    const tree = await render()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [{ status: Number(status), body: { error: code } }]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.pay!)
    const shown = texts(tree)
    const line = refusedLine(refusal)
    expect(shown).toContain(en.store.refusedTitle)
    expect(shown).toContain(line)
    for (const other of ['refusedApple', 'refusedGoogle', 'refusedRefunded', 'refusedTest'].map(key => en.store[key]!)) {
      if (other !== line) {
        expect(shown).not.toContain(other)
      }
    }
  })

  test('the support mail carries the purchase reference', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_product' } }]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.pay!)
    await press(tree, en.recover.sendToSupport!)
    const url = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0]![0])
    expect(url).toContain(REF)
    expect(url).toContain(PUBKEY)
  })
})

describe('buying a first year', () => {
  beforeEach(() => {
    mockParams = undefined
    jest.mocked(claimDomain).mockRejectedValue(new Error('domain_tier_not_paid'))
  })

  async function typed(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
    return tree
  }

  // Until the book has answered, a purchase it keeps may be what the screen shows next, so Continue
  // stays hidden, and the price waits with it rather than standing alone over the gap.
  test('shows the price only once Continue can show beside it', async () => {
    const priceLine = fill(en.useDomain.priceLine!, { price: PRICE })
    let answerBook!: (views: never[]) => void
    jest
      .spyOn(storePurchase, 'keptOrderViews')
      .mockImplementationOnce(() => new Promise(resolve => (answerBook = resolve)))

    const tree = await typed()
    expect(texts(tree)).not.toContain(priceLine)
    expect(button(tree, en.useDomain.continue!)?.props.disabled).toBe(true)

    await ReactTestRenderer.act(async () => answerBook([]))
    await settle()
    expect(texts(tree)).toContain(priceLine)
    expect(button(tree, en.useDomain.continue!)?.props.disabled).toBe(false)
  })

  test('opens the store after the claim and lands on the DNS steps', async () => {
    const tree = await typed()
    expect(texts(tree)).toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid')).mockResolvedValue(live())
    await press(tree, en.useDomain.continue!)
    expect(double.control.state.calls.buy).toEqual([{ productId: 'domain_year', reference: REF, accountId: null }])
    expect(quoteDomain).not.toHaveBeenCalled()
    expect(sparkConfirmSend).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(en.useDomain.stepsTitle)
  })

  // Only the claim's answer that the year is unpaid opens an order.
  test('a claim refused for another reason says so and opens no order', async () => {
    const tree = await typed()
    jest.mocked(claimDomain).mockRejectedValue(new Error('domain_belongs_to_another_wallet'))
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.continue!)
    expect(texts(tree)).toContain(en.useDomain.domainTaken)
    expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('somebody else holding the host is somebody else buying it', async () => {
    const tree = await typed()
    answers['/api/store/order'] = [{ status: 409, body: { error: 'held_by_another_wallet' } }]
    await press(tree, en.useDomain.continue!)
    expect(texts(tree)).toContain(en.useDomain.domainBeingBought)
  })

  // An order holds the host for ten minutes, so a year nobody can buy here opens none. Continue still
  // sends the claim, which a domain paid for elsewhere answers with its DNS steps.
  test('a store that cannot price the year sends the claim and opens no order and no store', async () => {
    double.control.state.products = []
    const tree = await typed()
    expect(texts(tree)).toContain(en.store.unavailable)
    expect(button(tree, en.useDomain.continue!)!.props.disabled).toBe(false)
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    jest.mocked(claimDomain).mockClear()
    await press(tree, en.useDomain.continue!)
    expect(jest.mocked(claimDomain).mock.calls.map(call => call[1])).toEqual([HOST])
    expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
    expect(double.control.state.calls.buy).toEqual([])
    expect(texts(tree)).toContain(en.store.unavailable)
    expect(texts(tree)).not.toContain(en.store.stillPricing)
  })

  test('a year the store is still pricing opens no order and no store', async () => {
    jest.spyOn(double.default, 'loadProducts').mockImplementationOnce(() => new Promise(() => undefined))
    const tree = await typed()
    expect(texts(tree)).not.toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.continue!)
    expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
    expect(double.control.state.calls.buy).toEqual([])
    // The press says why nothing opened, which the price's Skeleton does not.
    expect(texts(tree)).toContain(en.store.stillPricing)
  })

  test('a domain paid for elsewhere reaches its DNS steps on a store that cannot price', async () => {
    double.control.state.products = []
    jest.mocked(claimDomain).mockResolvedValue(live())
    const tree = await typed()
    expect(button(tree, en.useDomain.continue!)!.props.disabled).toBe(false)
    await press(tree, en.useDomain.continue!)
    expect(texts(tree)).toContain(en.useDomain.stepsTitle)
    expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
  })
})

// The invariant in docs/store-bridge.md, for this screen. What it shows once an order's outcome arrives
// is what it shows again after the owner leaves and comes back and after a restart, which both mount
// it anew.
// The rows come from the code's own sets, so a code added to FINAL_REFUSALS or DEFECT_REFUSALS is
// covered here unedited.
describe('what the screen shows again', () => {
  type Tree = ReactTestRenderer.ReactTestRenderer
  type Row = {
    kind: string
    label: string
    before?: () => void
    reach: (tree: Tree) => Promise<Tree>
    shows: (tree: Tree) => void
  }
  const CLASSES = ['delivered', 'refused', 'support', 'unknownOrder', 'waiting', 'unreachable', 'failed']
  // A year a year from now, so the record is the truth whenever the suite runs.
  const LATER = Math.floor(Date.now() / 1000) + 365 * 86_400
  const deliveredLater: Reply = { status: 200, body: { ...(delivered.body as object), expiresAt: LATER } }
  const renewedLine = fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(LATER, deviceDateTimePrefs()) })

  async function remount(tree: Tree): Promise<Tree> {
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    trees.splice(trees.indexOf(tree), 1)
    return render()
  }

  async function paid(tree: Tree, reply: Reply, buy: () => NativeBuyResult = bought): Promise<Tree> {
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [reply]
    double.control.scriptBuy(buy)
    await press(tree, en.useDomain.pay!)
    return tree
  }

  const noPay = (tree: Tree): void => {
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    expect(button(tree, en.useDomain.continue!)).toBeUndefined()
  }
  const waits = (tree: Tree): void => {
    expect(texts(tree)).toContain(fill(en.store.waitingBody!, { name: HOST }))
    expect(button(tree, en.store.stopWaiting!)).toBeDefined()
    noPay(tree)
  }
  const needsSupport = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.support)
    expect(texts(tree)).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    noPay(tree)
  }

  const ROWS: Row[] = [
    ...[...FINAL_REFUSALS].map((refusal): Row => {
      const [status, code] = refusal.split(' ')
      return {
        kind: 'refused',
        label: refusal,
        reach: tree => paid(tree, { status: Number(status), body: { error: code } }),
        shows: tree => {
          expect(texts(tree)).toContain(en.store.refusedTitle)
          expect(texts(tree)).toContain(refusedLine(refusal))
          expect(button(tree, en.common.close!)).toBeDefined()
          noPay(tree)
        },
      }
    }),
    ...[...DEFECT_REFUSALS].map(
      (code): Row => ({
        kind: 'support',
        label: `409 ${code}`,
        reach: tree => paid(tree, { status: 409, body: { error: code } }),
        shows: needsSupport,
      }),
    ),
    {
      kind: 'support',
      label: 'a purchase that came back without the reference',
      reach: tree =>
        paid(tree, deliveredLater, () => {
          const result = bought()
          result.purchase!.reference = null
          return result
        }),
      shows: needsSupport,
    },
    {
      kind: 'unknownOrder',
      label: '409 unknown_order',
      reach: tree => paid(tree, { status: 409, body: { error: 'unknown_order' } }),
      shows: needsSupport,
    },
    { kind: 'waiting', label: 'an Ask to Buy', reach: tree => paid(tree, deliveredLater, askToBuy), shows: waits },
    {
      kind: 'waiting',
      label: 'a paid year the gateway answers 429',
      reach: tree => paid(tree, { status: 429, body: { error: 'too many requests' } }),
      shows: waits,
    },
    {
      kind: 'unreachable',
      label: 'a paid year answered by the edge in front of the gateway',
      reach: tree => paid(tree, { status: 403, body: '<html>Attention Required</html>' }),
      shows: waits,
    },
    {
      kind: 'failed',
      label: 'a store that cannot be reached before paying',
      reach: tree =>
        paid(tree, deliveredLater, () => ({ status: 'failed', code: 'networkError', subCode: null, message: null, purchase: null })),
      shows: tree => {
        expect(texts(tree)).not.toContain(en.store.waitingTitle)
        expect(button(tree, en.useDomain.pay!)).toBeDefined()
      },
    },
    {
      kind: 'delivered',
      label: 'a renewal delivered on screen',
      reach: tree => paid(tree, deliveredLater),
      shows: tree => {
        expect(texts(tree)).toContain(renewedLine)
        noPay(tree)
      },
    },
    {
      kind: 'delivered',
      label: 'a renewal delivered while the screen is closed',
      reach: async tree => {
        await paid(tree, deliveredLater, askToBuy)
        await ReactTestRenderer.act(async () => {
          tree.unmount()
        })
        trees.splice(trees.indexOf(tree), 1)
        double.control.state.open = [bought().purchase!]
        answers['/api/store/confirm'] = [deliveredLater]
        await syncStorePurchases(liveStoreContext())
        return render()
      },
      shows: tree => {
        expect(texts(tree)).toContain(renewedLine)
        noPay(tree)
      },
    },
    {
      kind: 'delivered',
      label: 'a first year',
      before: () => {
        mockParams = undefined
        jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid')).mockResolvedValue(live())
      },
      reach: async tree => {
        await ReactTestRenderer.act(async () => {
          tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
        })
        await settle()
        answers['/api/store/order'] = [order]
        answers['/api/store/confirm'] = [deliveredLater]
        double.control.scriptBuy(bought)
        await press(tree, en.useDomain.continue!)
        return tree
      },
      shows: tree => {
        expect(texts(tree)).toContain(en.useDomain.stepsTitle)
        noPay(tree)
      },
    },
  ]

  test('the table holds a row of every class, and every code of both sets', () => {
    expect(FINAL_REFUSALS.size).toBeGreaterThan(0)
    expect(DEFECT_REFUSALS.size).toBeGreaterThan(0)
    expect(new Set(ROWS.map(row => row.kind))).toEqual(new Set(CLASSES))
    expect(ROWS.filter(row => row.kind === 'refused').map(row => row.label)).toEqual([...FINAL_REFUSALS])
    for (const code of DEFECT_REFUSALS) {
      expect(ROWS.map(row => row.label)).toContain(`409 ${code}`)
    }
  })

  test.each(ROWS.map(row => [row.kind, row.label, row] as const))('%s, %s', async (_kind, _label, row) => {
    row.before?.()
    let tree = await row.reach(await render())
    row.shows(tree)
    // Leaving and coming back, and a restart, both mount the screen anew from what is on disk.
    tree = await remount(tree)
    row.shows(tree)
    tree = await remount(tree)
    row.shows(tree)
    expect(double.control.state.calls.buy.length).toBeLessThanOrEqual(1)
  })

  // The check settles the approval itself, and shows the order as the book now keeps it.
  test('an approval refused for good on a check stays refused, with nothing to pay', async () => {
    const tree = await paid(await render(), deliveredLater, askToBuy)
    bought()
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'refused' } }]
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(texts(tree)).toContain(en.store.refusedApple)
    noPay(tree)
  })

  test('an approval that needs support on a check stays on the support line', async () => {
    const tree = await paid(await render(), deliveredLater, askToBuy)
    bought()
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_product' } }]
    await press(tree, en.receive.lnCheckAgain!)
    needsSupport(tree)
  })

  test('an approval delivered on a check states the new end date', async () => {
    const tree = await paid(await render(), deliveredLater, askToBuy)
    bought()
    answers['/api/store/confirm'] = [deliveredLater]
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(renewedLine)
  })

  test('the support mail still carries the purchase reference after a restart', async () => {
    let tree = await paid(await render(), { status: 409, body: { error: [...DEFECT_REFUSALS][0] } })
    tree = await remount(tree)
    await press(tree, en.recover.sendToSupport!)
    const url = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0]![0])
    expect(url).toContain(REF)
    expect(url).toContain(PUBKEY)
  })

  test('closing a refusal brings the price back, and it stays back', async () => {
    let tree = await paid(await render(), { status: 409, body: { error: 'refused' } })
    await press(tree, en.common.close!)
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
    tree = await remount(tree)
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  // Once the year is in its last 30 days the renewal is for sale again, so the old line would lie.
  test('a delivered year due again shows the price', async () => {
    const soon = Math.floor(Date.now() / 1000) + 10 * 86_400
    let tree = await paid(await render(), { status: 200, body: { ...(delivered.body as object), expiresAt: soon } })
    tree = await remount(tree)
    expect(texts(tree)).not.toContain(fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(soon, deviceDateTimePrefs()) }))
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  test('a first year whose domain answers is not shown again', async () => {
    mockParams = undefined
    jest
      .mocked(claimDomain)
      .mockRejectedValueOnce(new Error('domain_tier_not_paid'))
      .mockResolvedValue({ ...live(), state: 'active' as const })
    let tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [deliveredLater]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.continue!)
    expect(texts(tree)).toContain(en.useDomain.stepsTitle)
    tree = await remount(tree)
    expect(texts(tree)).not.toContain(en.useDomain.stepsTitle)
    expect(texts(tree)).toContain(en.useDomain.domainLabel)
  })

  // The DNS steps name the record and the target from the claim, which needs the host back in the form.
  test('a first year opened again before its domain answers names its record and target', async () => {
    mockParams = undefined
    jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid')).mockResolvedValue(live())
    let tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [deliveredLater]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.continue!)
    jest.mocked(claimDomain).mockClear()
    tree = await remount(tree)
    expect(texts(tree)).toContain(`${en.useDomain.stepName}: pay`)
    expect(texts(tree)).toContain(`${en.useDomain.stepTarget}: saas.usevoltz.app`)
    expect(jest.mocked(claimDomain).mock.calls.map(call => call[1])).toContain(HOST)
  })

  // A first year bought here and left before its domain answered, then opened from Renew once the
  // domain is live. Nothing was renewed, so the price is the truth.
  async function firstYearLeft(): Promise<void> {
    mockParams = undefined
    jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid')).mockResolvedValue(live())
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [deliveredLater]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.continue!)
    expect(texts(tree)).toContain(en.useDomain.stepsTitle)
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    trees.splice(trees.indexOf(tree), 1)
    mockParams = { renew: HOST }
    jest.mocked(claimDomain).mockReset().mockResolvedValue({ ...live(), state: 'active' as const })
  }

  test('a first year delivered stays out of the renewal', async () => {
    await firstYearLeft()
    const tree = await render()
    expect(texts(tree)).not.toContain(renewedLine)
    expect(texts(tree)).toContain(fill(en.useDomain.priceLine!, { price: PRICE }))
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  // A renewal wait whose purchase the store stops listing falls back to what else the book keeps for
  // the host, which on the renewal is never the first year.
  test('a renewal wait that is gone on a check shows the price, never the first year', async () => {
    const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
    await firstYearLeft()
    const tree = await render()
    answers['/api/store/order'] = [
      { status: 200, body: { reference: REF_B, productId: 'domain_year', state: 'held', kind: 'tier', subject: HOST, appAccountToken: REF_B } },
    ]
    answers['/api/store/confirm'] = [{ status: 429, body: { error: 'too many requests' } }]
    double.control.scriptBuy(() => {
      const result = bought()
      result.purchase!.reference = REF_B.toUpperCase()
      result.purchase!.key = 'tx-2'
      return result
    })
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    double.control.state.open = []
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).not.toContain(renewedLine)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  // The gateway keeps one order for a host whichever screen opened it, so a first year's outcome still
  // unsettled shows on the renewal of its host too, blocks a second order there, and the book keeps
  // which screen opened it (docs/store-bridge.md, rule 3).
  const KEPT = [
    ['wait', deliveredLater, askToBuy],
    ['support', { status: 409, body: { error: 'wrong_bundle' } }, bought],
    ['refusal', { status: 409, body: { error: 'refused' } }, bought],
  ] as const

  async function firstYear(tree: Tree, root = 'bakery.com.br'): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText(root)
    })
    await settle()
    await press(tree, en.useDomain.continue!)
  }
  const keptLine = (tree: Tree): string | undefined =>
    [en.store.waitingTitle, en.store.support, en.store.refusedTitle].find(kept => texts(tree).includes(kept!))

  describe('a first year kept shows on and blocks the renewal', () => {
    test.each(KEPT)('%s', async (_name, reply, buy) => {
      mockParams = undefined
      jest.mocked(claimDomain).mockReset().mockRejectedValue(new Error('domain_tier_not_paid'))
      let tree = await render()
      answers['/api/store/order'] = [order]
      answers['/api/store/confirm'] = [reply as Reply]
      double.control.scriptBuy(buy)
      await firstYear(tree)
      const line = keptLine(tree)
      expect(line).toBeDefined()
      mockParams = { renew: HOST }
      tree = await remount(tree)
      expect(texts(tree)).toContain(line)
      expect(button(tree, en.useDomain.pay!)).toBeUndefined()
      expect(calls.filter(c => c.startsWith('/api/store/order'))).toHaveLength(1)
      expect(double.control.state.calls.buy.map(call => call.reference)).toEqual([REF])
      // Back on its own screen it still shows.
      mockParams = undefined
      tree = await remount(tree)
      expect(texts(tree)).toContain(line)
    })
  })

  // The first-year form shows on open only what a first year left. A renewal's unsettled outcome
  // takes the form only once Continue names its host, where it holds the claim and a second order,
  // and never blocks a first year for another host.
  describe('a renewal kept shows on the first-year form only at Continue for its host', () => {
    test.each(KEPT)('%s', async (_name, reply, buy) => {
      mockParams = { renew: HOST }
      jest.mocked(claimDomain).mockReset().mockRejectedValue(new Error('domain_tier_not_paid'))
      let tree = await render()
      answers['/api/store/order'] = [order]
      answers['/api/store/confirm'] = [reply as Reply]
      double.control.scriptBuy(buy)
      await press(tree, en.useDomain.pay!)
      const line = keptLine(tree)
      expect(line).toBeDefined()
      mockParams = undefined
      tree = await remount(tree)
      expect(texts(tree)).not.toContain(line)
      expect(texts(tree)).toContain(en.useDomain.domainLabel)
      jest.mocked(claimDomain).mockClear()
      await firstYear(tree)
      expect(texts(tree)).toContain(line)
      expect(jest.mocked(claimDomain)).not.toHaveBeenCalled()
      expect(calls.filter(c => c.startsWith('/api/store/order'))).toHaveLength(1)
      expect(double.control.state.calls.buy.map(call => call.reference)).toEqual([REF])
      // Back on the renewal it still shows.
      mockParams = { renew: HOST }
      tree = await remount(tree)
      expect(texts(tree)).toContain(line)
    })

    test.each(KEPT)('%s, and a first year for another host is still for sale', async (_name, reply, buy) => {
      const REF_C = '5a1b4c0e-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
      mockParams = { renew: HOST }
      jest.mocked(claimDomain).mockReset().mockRejectedValue(new Error('domain_tier_not_paid'))
      let tree = await render()
      answers['/api/store/order'] = [order]
      answers['/api/store/confirm'] = [reply as Reply]
      double.control.scriptBuy(buy)
      await press(tree, en.useDomain.pay!)
      mockParams = undefined
      tree = await remount(tree)
      answers['/api/store/order'] = [
        {
          status: 200,
          body: { reference: REF_C, productId: 'domain_year', state: 'held', kind: 'tier', subject: 'pay.other.com.br', appAccountToken: REF_C },
        },
      ]
      double.control.scriptBuy(askToBuy)
      await firstYear(tree, 'other.com.br')
      expect(texts(tree)).toContain(fill(en.store.waitingBody!, { name: 'pay.other.com.br' }))
      expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([
        `/api/store/order tier ${HOST}`,
        '/api/store/order tier pay.other.com.br',
      ])
    })
  })

  // A renewal's delivered year belongs to the renewal; the first-year form is for buying another.
  test('a renewal delivered stays out of the first-year form', async () => {
    let tree = await paid(await render(), deliveredLater)
    expect(texts(tree)).toContain(renewedLine)
    mockParams = undefined
    tree = await remount(tree)
    expect(texts(tree)).not.toContain(en.useDomain.stepsTitle)
    expect(texts(tree)).toContain(en.useDomain.domainLabel)
  })
})

// The tables in docs/store-bridge.md, "Worked examples", for the
// first-year form and the renewal. Rows are what the book keeps for the screen, columns the state of
// the claim, and a kept outcome is driven after a reopen and after a restart, which both mount the
// screen anew.
describe('what the screen shows while the claim is out', () => {
  type Tree = ReactTestRenderer.ReactTestRenderer
  type Read = 'in flight' | 'failed' | 'answered'
  const READS: Read[] = ['in flight', 'failed', 'answered']
  const KEPT = ['nothing', 'check', 'wait', 'support', 'refusal', 'delivered']
  const LATER = Math.floor(Date.now() / 1000) + 365 * 86_400
  const deliveredLater: Reply = { status: 200, body: { ...(delivered.body as object), expiresAt: LATER } }
  const renewedLine = fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(LATER, deviceDateTimePrefs()) })
  const priceLine = fill(en.useDomain.priceLine!, { price: PRICE })

  // The claim held open, failing on the connection, or answering as `answer` says.
  function claim(read: Read, answer: () => void): void {
    if (read === 'in flight') {
      jest.mocked(claimDomain).mockReset().mockReturnValue(new Promise(() => undefined))
    } else if (read === 'failed') {
      jest.mocked(claimDomain).mockReset().mockRejectedValue(new TypeError('Network request failed'))
    } else {
      answer()
    }
  }
  const notPaid = (): void => {
    jest.mocked(claimDomain).mockReset().mockRejectedValue(new Error('domain_tier_not_paid'))
  }
  const onboarded = (): void => {
    jest.mocked(claimDomain).mockReset().mockResolvedValue(live())
  }

  async function remount(tree: Tree): Promise<Tree> {
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    trees.splice(trees.indexOf(tree), 1)
    return render()
  }
  async function typeDomain(tree: Tree): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
  }
  const orders = (): string[] => calls.filter(c => c.startsWith('/api/store/order'))
  // A button that loads is not pressable either.
  const pressable = (tree: Tree, label: string): boolean => {
    const found = button(tree, label)!
    return !found.props.disabled && !found.props.loading
  }

  const noPay = (tree: Tree): void => {
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    expect(button(tree, en.useDomain.continue!)).toBeUndefined()
  }
  const waits = (tree: Tree): void => {
    expect(texts(tree)).toContain(fill(en.store.waitingBody!, { name: HOST }))
    expect(button(tree, en.store.stopWaiting!)).toBeDefined()
    noPay(tree)
  }
  const needsSupport = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.support)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    noPay(tree)
  }
  const refused = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(button(tree, en.common.close!)).toBeDefined()
    noPay(tree)
  }
  const every = (shows: (tree: Tree) => void): Record<Read, (tree: Tree) => void> => ({
    'in flight': shows,
    failed: shows,
    answered: shows,
  })

  type Row = {
    kept: string
    // How the book comes to keep it, through the screen itself.
    reach?: (tree: Tree) => Promise<void>
    // An outcome this screen keeps, which a reopen and a restart show again.
    outcome?: boolean
    // The answer this row's claim gives once it answers.
    answer: () => void
    // What the screen shows on open, and after the press that sends the claim where the form has one.
    shows: Record<Read, (tree: Tree) => Promise<void> | void>
  }

  describe('the first-year form', () => {
    beforeEach(() => {
      mockParams = undefined
      notPaid()
    })

    async function buyFirstYear(tree: Tree, reply: Reply, buy: () => NativeBuyResult = bought): Promise<void> {
      await typeDomain(tree)
      answers['/api/store/order'] = [order]
      answers['/api/store/confirm'] = [reply]
      double.control.scriptBuy(buy)
      jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid')).mockResolvedValue(live())
      await press(tree, en.useDomain.continue!)
    }

    // Nothing is read until Continue, which sends the claim, so the cell is what that press does.
    const continued: Record<Read, (tree: Tree) => Promise<void>> = {
      'in flight': async tree => {
        await typeDomain(tree)
        answers['/api/store/order'] = [order]
        double.control.scriptBuy(askToBuy)
        await press(tree, en.useDomain.continue!)
        expect(pressable(tree, en.useDomain.continue!)).toBe(false)
        expect(orders()).toEqual([])
        expect(double.control.state.calls.buy).toEqual([])
      },
      failed: async tree => {
        await typeDomain(tree)
        answers['/api/store/order'] = [order]
        double.control.scriptBuy(askToBuy)
        await press(tree, en.useDomain.continue!)
        expect(texts(tree)).toContain(en.store.retry)
        expect(pressable(tree, en.useDomain.continue!)).toBe(true)
        expect(orders()).toEqual([])
        expect(double.control.state.calls.buy).toEqual([])
      },
      answered: async tree => {
        await typeDomain(tree)
        answers['/api/store/order'] = [order]
        double.control.scriptBuy(askToBuy)
        await press(tree, en.useDomain.continue!)
        expect(double.control.state.calls.buy).toEqual([{ productId: 'domain_year', reference: REF, accountId: null }])
        expect(texts(tree)).toContain(fill(en.store.waitingBody!, { name: HOST }))
      },
    }

    const steps = (tree: Tree): void => {
      expect(texts(tree)).toContain(en.useDomain.stepsTitle)
      noPay(tree)
    }
    const ROWS: Row[] = [
      { kept: 'nothing', answer: notPaid, shows: continued },
      {
        kept: 'check',
        // A name's check, which this screen never reads.
        reach: () => keepNameCheck({ domain: 'usevoltz.app', name: 'pay', after: 'delivered', attempt: [] }),
        answer: notPaid,
        shows: continued,
      },
      { kept: 'wait', outcome: true, reach: tree => buyFirstYear(tree, deliveredLater, askToBuy), answer: notPaid, shows: every(waits) },
      {
        kept: 'support',
        outcome: true,
        reach: tree => buyFirstYear(tree, { status: 409, body: { error: 'wrong_bundle' } }),
        answer: notPaid,
        shows: every(needsSupport),
      },
      {
        kept: 'refusal',
        outcome: true,
        reach: tree => buyFirstYear(tree, { status: 409, body: { error: 'refused' } }),
        answer: notPaid,
        shows: every(refused),
      },
      {
        kept: 'delivered',
        outcome: true,
        reach: tree => buyFirstYear(tree, deliveredLater),
        answer: onboarded,
        shows: {
          'in flight': steps,
          failed: steps,
          answered: tree => {
            steps(tree)
            expect(texts(tree)).toContain(`${en.useDomain.stepName}: pay`)
            expect(texts(tree)).toContain(`${en.useDomain.stepTarget}: saas.usevoltz.app`)
          },
        },
      },
    ]

    test('the table holds every row the book can keep', () => {
      expect(ROWS.map(row => row.kept)).toEqual(KEPT)
    })

    test.each(ROWS.flatMap(row => READS.map(read => [row.kept, read, row] as const)))('%s kept, claim %s', async (_kept, read, row) => {
      let tree = await render()
      await row.reach?.(tree)
      claim(read, row.answer)
      tree = await remount(tree)
      await row.shows[read](tree)
      if (row.outcome) {
        tree = await remount(tree)
        await row.shows[read](tree)
      }
      expect(double.control.state.calls.buy.length).toBeLessThanOrEqual(1)
    })
  })

  describe('the renewal', () => {
    async function paid(tree: Tree, reply: Reply, buy: () => NativeBuyResult = bought): Promise<void> {
      answers['/api/store/order'] = [order]
      answers['/api/store/confirm'] = [reply]
      double.control.scriptBuy(buy)
      await press(tree, en.useDomain.pay!)
    }
    const active = (): void => {
      jest.mocked(claimDomain).mockReset().mockResolvedValue({ ...live(), state: 'active' as const })
    }
    const price = (tree: Tree): void => {
      expect(texts(tree)).toContain(priceLine)
      expect(button(tree, en.useDomain.pay!)).toBeDefined()
    }
    // The claim only picks the early or the late line (rule 7), so the price and Pay stay, and Pay
    // waits on the claim while it is out.
    const offered: Record<Read, (tree: Tree) => void> = {
      'in flight': tree => {
        price(tree)
        expect(pressable(tree, en.useDomain.pay!)).toBe(false)
        expect(texts(tree)).not.toContain(en.useDomain.renewEarly)
        expect(texts(tree)).not.toContain(en.useDomain.renewLate)
      },
      failed: tree => {
        price(tree)
        expect(pressable(tree, en.useDomain.pay!)).toBe(true)
        expect(texts(tree)).not.toContain(en.useDomain.renewEarly)
        expect(texts(tree)).not.toContain(en.useDomain.renewLate)
      },
      answered: tree => {
        price(tree)
        expect(pressable(tree, en.useDomain.pay!)).toBe(true)
        expect(texts(tree)).toContain(en.useDomain.renewEarly)
      },
    }
    const renewed = (tree: Tree): void => {
      expect(texts(tree)).toContain(renewedLine)
      noPay(tree)
    }
    const ROWS: Row[] = [
      { kept: 'nothing', answer: active, shows: offered },
      {
        kept: 'check',
        reach: () => keepNameCheck({ domain: 'usevoltz.app', name: 'pay', after: 'delivered', attempt: [] }),
        answer: active,
        shows: offered,
      },
      { kept: 'wait', outcome: true, reach: tree => paid(tree, deliveredLater, askToBuy), answer: active, shows: every(waits) },
      {
        kept: 'support',
        outcome: true,
        reach: tree => paid(tree, { status: 409, body: { error: 'wrong_bundle' } }),
        answer: active,
        shows: every(needsSupport),
      },
      { kept: 'refusal', outcome: true, reach: tree => paid(tree, { status: 409, body: { error: 'refused' } }), answer: active, shows: every(refused) },
      { kept: 'delivered', outcome: true, reach: tree => paid(tree, deliveredLater), answer: active, shows: every(renewed) },
    ]

    test('the table holds every row the book can keep', () => {
      expect(ROWS.map(row => row.kept)).toEqual(KEPT)
    })

    test.each(ROWS.flatMap(row => READS.map(read => [row.kept, read, row] as const)))('%s kept, claim %s', async (_kept, read, row) => {
      let tree = await render()
      await row.reach?.(tree)
      claim(read, row.answer)
      tree = await remount(tree)
      await row.shows[read](tree)
      if (row.outcome) {
        tree = await remount(tree)
        await row.shows[read](tree)
      }
      expect(double.control.state.calls.buy.length).toBeLessThanOrEqual(1)
    })
  })
})

// An older order of the host, left with Stop waiting while the store still lists its purchase, which
// the root's sync then refuses for good.
describe('the root sync settling another order of the host', () => {
  const OLD = '5a1b4c0e-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`

  beforeEach(async () => {
    const book = { orders: { [OLD]: 'w_a' }, about: { [OLD]: { kind: 'tier', place: HOST, subject: HOST, renewal: true } } }
    await RNFS.writeFile(BOOK_FILE, JSON.stringify(book), 'utf8')
    const listed: NativePurchase = { productIds: ['domain_year'], key: 'tx-old', reference: OLD, state: 'purchased', purchasedAt: 1, verified: true, revoked: false }
    double.control.state.open = [listed]
  })

  async function refuseOld(): Promise<void> {
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'refunded' } }]
    await ReactTestRenderer.act(async () => {
      await syncStorePurchases(liveStoreContext())
    })
    await settle()
  }

  test('takes the price, and Close brings it back', async () => {
    const tree = await render()
    await refuseOld()
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    await press(tree, en.common.close!)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  test('leaves a wait on screen alone', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    await refuseOld()
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
  })

  // Heard while Pay waits on the gateway, the answer is taken once Pay is done, so neither Close nor
  // Pay shows beside a purchase still running, and Pay's own outcome is never the one that lands last.
  test('during Pay waits for Pay, and then leaves its wait alone', async () => {
    const tree = await render()
    let answer!: () => void
    answers['/api/store/order'] = [new Promise<Reply>(resolve => (answer = () => resolve(order)))]
    double.control.scriptBuy(askToBuy)
    await ReactTestRenderer.act(async () => {
      button(tree, en.useDomain.pay!)!.props.onPress()
    })
    await settle()
    await refuseOld()
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
    expect(button(tree, en.common.close!)).toBeUndefined()
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
  })

  test('during Pay is taken once Pay comes back with nothing, over its line', async () => {
    const tree = await render()
    let answer!: () => void
    answers['/api/store/order'] = [new Promise<Reply>(resolve => (answer = () => resolve({ status: 503, body: { error: 'store_unavailable' } })))]
    await ReactTestRenderer.act(async () => {
      button(tree, en.useDomain.pay!)!.props.onPress()
    })
    await settle()
    await refuseOld()
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(texts(tree)).not.toContain(en.store.retry)
  })
})

// A book write that takes its time, as a slow disk does. A second Close or Stop waiting lands before
// the first one's write, and the first then applies nothing, since a later press took the screen.
describe('leaving with the book slow to write', () => {
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
  let gates: Array<() => void>
  let held: boolean
  let write: jest.SpyInstance

  beforeEach(() => {
    gates = []
    held = false
    const real = RNFS.writeFile.bind(RNFS)
    // The book is written whole to its temporary copy and then moved in (durableFile.ts), so a slow
    // write of the book is a slow write of that copy.
    write = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (file: string, contents: string, encoding: string) => {
      if (held && file === `${BOOK_FILE}.tmp`) {
        await new Promise<void>(resolve => gates.push(resolve))
      }
      return real(file, contents, encoding)
    })
  })

  afterEach(() => {
    write.mockRestore()
  })

  async function pressTwice(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
    held = true
    await press(tree, label)
    await press(tree, label)
  }
  async function writeOne(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      gates.shift()!()
    })
    await settle()
  }

  test('a first Close applies nothing once a second one came', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'refunded' } }]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.store.refusedTitle)
    await pressTwice(tree, en.common.close!)
    await writeOne()
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    held = false
    await writeOne()
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  test('a first Stop waiting applies nothing once a second one came', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    await pressTwice(tree, en.store.stopWaiting!)
    await writeOne()
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    held = false
    await writeOne()
    expect(texts(tree)).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })
})

// The first-year form takes any host's kept outcome back on open with the form hidden behind it, so
// a refusal or a support case says which host it is about, as a wait does.
describe('an outcome on screen names its host', () => {
  beforeEach(() => {
    mockParams = undefined
    jest.mocked(claimDomain).mockRejectedValue(new Error('domain_tier_not_paid'))
  })

  async function confirmedAs(reply: Reply): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
    })
    await settle()
    answers['/api/store/order'] = [order]
    answers['/api/store/confirm'] = [reply]
    double.control.scriptBuy(bought)
    await press(tree, en.useDomain.continue!)
    return tree
  }

  test('a refusal, on the press and after a reopen', async () => {
    const tree = await confirmedAs({ status: 409, body: { error: 'refused' } })
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(texts(tree)).toContain(HOST)
    const again = await render()
    expect(texts(again)).toContain(en.store.refusedTitle)
    expect(texts(again)).toContain(HOST)
  })

  test('a support case, on the press and after a reopen', async () => {
    const tree = await confirmedAs({ status: 409, body: { error: 'wrong_product' } })
    expect(texts(tree)).toContain(en.store.support)
    expect(texts(tree)).toContain(HOST)
    const again = await render()
    expect(texts(again)).toContain(en.store.support)
    expect(texts(again)).toContain(HOST)
  })

  // A card left by a refused support mail names the purchase it was about. The book puts its support
  // case on screen at once and Send to support is pressable then, so a mail refused before the store's
  // list answers leaves a card about that case; once the list lets it go and another case takes the
  // screen, no card naming the first stays beside the second.
  test('a mail refused after the store list moved the screen leaves no card about the first case', async () => {
    const A = 'ref-aaaa-1111'
    const B = 'ref-bbbb-2222'
    const support = (reference: string, subject: string): storePurchase.StoreOrderView => ({
      reference,
      subject,
      renewal: false,
      outcome: { kind: 'support', code: 'wrong_product' },
    })
    jest
      .spyOn(storePurchase, 'keptOrderViews')
      .mockResolvedValueOnce([support(A, 'a.example.com'), support(B, 'b.example.com')])
    let answerList!: (views: storePurchase.StoreOrderView[]) => void
    jest
      .spyOn(storePurchase, 'storeOrderViews')
      .mockImplementationOnce(() => new Promise(resolve => (answerList = resolve)))
    let refuse!: (e: Error) => void
    jest.mocked(Linking.openURL).mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
    const tree = await render()
    const carried = (): string[] =>
      carriedTexts(tree)

    expect(texts(tree)).toContain('a.example.com')
    await press(tree, en.recover.sendToSupport!)
    expect(carried()).toEqual([])
    await ReactTestRenderer.act(async () => answerList([support(B, 'b.example.com')]))
    await settle()
    expect(texts(tree)).toContain('b.example.com')
    await ReactTestRenderer.act(async () => refuse(new Error('no mail app')))
    await settle()
    expect(texts(tree)).toContain('b.example.com')
    expect(carried().filter(text => text.includes(A))).toEqual([])
  })

  // A mail app can open and still send nothing, as a Gmail signed in to no account does.
  test('a mail that opens beside a support case leaves the address, the mail text and Copy', async () => {
    const tree = await confirmedAs({ status: 409, body: { error: 'wrong_product' } })
    expect(texts(tree)).toContain(en.store.support)
    expectNoMailFallback(tree)
    await press(tree, en.recover.sendToSupport!)
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    const body = mailBody(jest.mocked(Linking.openURL).mock.calls[0]?.[0])
    expect(body).toContain(REF)
    expectMailFallback(tree, body, 'opened')
    expect(await pressCopy(tree)).toBe(body)
  })

  test('a mail that opens beside a paid year the gateway will not grant leaves the address, the mail text and Copy', async () => {
    await savePendingPurchase({ host: HOST, reference: REF, amountSats: 199800 })
    jest.mocked(confirmDomain).mockRejectedValue(new Error('paid_but_not_granted'))
    const tree = await render()
    expect(texts(tree)).toContain(en.recover.blockedBody)
    expectNoMailFallback(tree)
    await press(tree, en.recover.sendToSupport!)
    expect(Linking.openURL).toHaveBeenCalledTimes(1)
    const body = mailBody(jest.mocked(Linking.openURL).mock.calls[0]?.[0])
    expect(body).toContain(REF)
    expectMailFallback(tree, body, 'opened')
    expect(await pressCopy(tree)).toBe(body)
  })

  test('a support card never names a case the store list took off the screen', async () => {
    const A = 'ref-aaaa-1111'
    const B = 'ref-bbbb-2222'
    const support = (reference: string, subject: string): storePurchase.StoreOrderView => ({
      reference,
      subject,
      renewal: false,
      outcome: { kind: 'support', code: 'wrong_product' },
    })
    jest
      .spyOn(storePurchase, 'keptOrderViews')
      .mockResolvedValueOnce([support(A, 'a.example.com'), support(B, 'b.example.com')])
    let answerList!: (views: storePurchase.StoreOrderView[]) => void
    jest
      .spyOn(storePurchase, 'storeOrderViews')
      .mockImplementationOnce(() => new Promise(resolve => (answerList = resolve)))
    jest.mocked(Linking.openURL).mockRejectedValue(new Error('no mail app'))
    const tree = await render()
    const carried = (): string[] =>
      carriedTexts(tree)

    expect(texts(tree)).toContain('a.example.com')
    await press(tree, en.recover.sendToSupport!)
    expect(carried()).toEqual([expect.stringContaining(A)])

    await ReactTestRenderer.act(async () => answerList([support(B, 'b.example.com')]))
    await settle()
    expect(texts(tree)).toContain('b.example.com')
    expect(texts(tree)).not.toContain('a.example.com')
    expect(carried().filter(text => text.includes(A))).toEqual([])

    await press(tree, en.recover.sendToSupport!)
    expect(carried()).toEqual([expect.stringContaining(B)])
  })
})

// The root's sync can deliver the renewal's order between the gateway handing it back to Pay and the
// store opening, and Apple can drop the transaction from its unfinished list before the bridge answers
// finish. The store then lists nothing for the order, and Pay holds the screen until it shows the
// delivered year, so a Pay pressed in between never opens a second order for the year just bought.
describe('a renewal the sync delivers while Pay waits on the gateway', () => {
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
  const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'
  const LATER = Math.floor(Date.now() / 1000) + 365 * 86_400
  const deliveredLater: Reply = { status: 200, body: { ...(delivered.body as object), expiresAt: LATER } }
  const renewedLine = fill(en.useDomain.renewDone!, { domain: HOST, date: formatDate(LATER, deviceDateTimePrefs()) })
  const native = double.default as unknown as { finish(id: string): Promise<boolean> }
  const files = RNFS as unknown as { readFile(p: string, e: string): Promise<string> }
  let finish: jest.SpyInstance | undefined
  let read: jest.SpyInstance | undefined
  let unsubscribe: (() => void) | undefined
  // Whatever a test leaves held is let go after it, so a sync it left running never holds the next
  // test's purchase in flight.
  let held: Array<() => void> = []
  let running: Promise<unknown> | undefined

  beforeEach(async () => {
    // Left with Stop waiting while the store still lists its purchase.
    const book = { orders: { [REF]: 'w_a' }, about: { [REF]: { kind: 'tier', place: HOST, subject: HOST, renewal: true } } }
    await RNFS.writeFile(BOOK_FILE, JSON.stringify(book), 'utf8')
    double.control.state.open = [{ productIds: ['domain_year'], key: 'tx-1', reference: REF, state: 'purchased', purchasedAt: 1, verified: true, revoked: false }]
  })

  afterEach(async () => {
    finish?.mockRestore()
    read?.mockRestore()
    unsubscribe?.()
    finish = read = unsubscribe = undefined
    await ReactTestRenderer.act(async () => {
      held.splice(0).forEach(open => open())
      await running?.catch(() => undefined)
    })
    running = undefined
  })

  const orders = (): string[] => calls.filter(c => c.startsWith('/api/store/order'))

  // Pay, with the sync delivering the order while the gateway hands it back, and the bridge's answer to
  // finish held. Answers what lets finish answer, and the sync.
  async function payWhileSyncDelivers(tree: ReactTestRenderer.ReactTestRenderer, confirm: Reply): Promise<{ finished: () => void; syncing: Promise<unknown> }> {
    let finished!: () => void
    finish = jest.spyOn(native, 'finish').mockImplementationOnce(async (id: string) => {
      double.control.state.open = double.control.state.open.filter(p => p.key !== id)
      await new Promise<void>(resolve => {
        finished = resolve
        held.push(resolve)
      })
      return true
    })
    let answer!: () => void
    const again: Reply = { status: 200, body: { ...(order.body as object), reference: REF_B, appAccountToken: REF_B } }
    answers['/api/store/order'] = [new Promise<Reply>(resolve => (answer = () => resolve(order))), again]
    answers['/api/store/confirm'] = [confirm]
    double.control.scriptBuy(bought)
    await ReactTestRenderer.act(async () => {
      button(tree, en.useDomain.pay!)!.props.onPress()
    })
    await settle()
    let syncing!: Promise<unknown>
    await ReactTestRenderer.act(async () => {
      syncing = syncStorePurchases(liveStoreContext())
      running = syncing
    })
    await settle()
    expect(finish).toHaveBeenCalled()
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    return { finished, syncing }
  }

  test('a second Pay before the year is in the book opens nothing, and the year shows', async () => {
    const tree = await render()
    const { finished, syncing } = await payWhileSyncDelivers(tree, deliveredLater)
    await press(tree, en.useDomain.pay!)
    expect(orders()).toHaveLength(1)
    expect(double.control.state.calls.buy).toEqual([])
    await ReactTestRenderer.act(async () => {
      finished()
      await syncing
    })
    await settle()
    expect(texts(tree)).toContain(renewedLine)
    expect(button(tree, en.useDomain.pay!)).toBeUndefined()
    expect(orders()).toHaveLength(1)
    expect(double.control.state.calls.buy).toEqual([])
  })

  // Once the sync told the screens, the book is read again for the year. Each read is held open in
  // turn, and Pay pressed whenever it is on screen.
  test('a second Pay while the book is read for the year opens nothing', async () => {
    const tree = await render()
    const { finished, syncing } = await payWhileSyncDelivers(tree, deliveredLater)
    const gates: Array<() => void> = []
    let holding = false
    const real = files.readFile.bind(RNFS)
    read = jest.spyOn(files, 'readFile').mockImplementation(async (file: string, encoding: string) => {
      if (holding && file === BOOK_FILE) {
        await new Promise<void>(resolve => {
          gates.push(resolve)
          held.push(resolve)
        })
      }
      return real(file, encoding)
    })
    unsubscribe = onStoreSettled(() => {
      holding = true
    })
    await ReactTestRenderer.act(async () => {
      finished()
      await syncing
    })
    await settle()
    expect(gates.length).toBeGreaterThan(0)
    for (let turn = 0; turn < 10 && gates.length > 0; turn++) {
      if (button(tree, en.useDomain.pay!)) {
        await press(tree, en.useDomain.pay!)
      }
      expect(orders()).toHaveLength(1)
      await ReactTestRenderer.act(async () => {
        gates.shift()!()
      })
      await settle()
    }
    holding = false
    await ReactTestRenderer.act(async () => {
      gates.splice(0).forEach(open => open())
    })
    await settle()
    expect(texts(tree)).toContain(renewedLine)
    expect(orders()).toHaveLength(1)
    expect(double.control.state.calls.buy).toEqual([])
  })

  // A year delivered without its end date, which the gateway never sends, is not kept, so the press
  // finds nothing in the book. It still never says the purchase did not go through (I4).
  test('a delivered year the book does not keep says nothing failed', async () => {
    const tree = await render()
    const undated: Reply = { status: 200, body: { ...(delivered.body as object), expiresAt: undefined } }
    const { finished, syncing } = await payWhileSyncDelivers(tree, undated)
    await ReactTestRenderer.act(async () => {
      finished()
      await syncing
    })
    await settle()
    expect(texts(tree)).not.toContain(en.store.retry)
    expect(orders()).toHaveLength(1)
    expect(double.control.state.calls.buy).toEqual([])
  })
})

// A book this build cannot read in shape, as one a later build wrote, fails the views read itself.
describe('a Check again that fails after Stop waiting', () => {
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
  const OTHER = '5a1b4c0e-2f3d-4e5f-8a9b-0c1d2e3f4a5b'
  const native = double.default as unknown as { openPurchases(): Promise<NativePurchase[]> }
  let list: jest.SpyInstance

  afterEach(() => {
    list?.mockRestore()
  })

  test('says nothing on the screen Stop waiting left', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.pay!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    let answer!: () => void
    list = jest.spyOn(native, 'openPurchases').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => (answer = resolve))
      return []
    })
    await ReactTestRenderer.act(async () => {
      button(tree, en.receive.lnCheckAgain!)!.props.onPress()
    })
    await settle()
    await press(tree, en.store.stopWaiting!)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
    await RNFS.writeFile(BOOK_FILE, JSON.stringify({ orders: { [OTHER]: 'w_a' }, about: { [OTHER]: null } }), 'utf8')
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    expect(texts(tree)).not.toContain(en.store.retry)
    expect(button(tree, en.useDomain.pay!)).toBeDefined()
  })

  // The control, with the check still the latest thing on screen when it fails.
  test('says to try again on the wait it was checking', async () => {
    const tree = await render()
    answers['/api/store/order'] = [order]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.useDomain.pay!)
    let answer!: () => void
    list = jest.spyOn(native, 'openPurchases').mockImplementationOnce(async () => {
      await new Promise<void>(resolve => (answer = resolve))
      return []
    })
    await ReactTestRenderer.act(async () => {
      button(tree, en.receive.lnCheckAgain!)!.props.onPress()
    })
    await settle()
    await RNFS.writeFile(BOOK_FILE, JSON.stringify({ orders: { [OTHER]: 'w_a' }, about: { [OTHER]: null } }), 'utf8')
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    expect(texts(tree)).toContain(en.store.retry)
  })
})

// A store build still finishes a year paid in sats, and the recovery sweep shares that payment's record.
// Once another reader gives the proof up, the wait goes, and the screen reads the store's book as an
// open with no proof does, so Pay comes back rather than staying off under the price.
describe('a sats wait whose proof another reader gave up', () => {
  test('gives Pay back once the wait is dropped', async () => {
    const real = jest.requireActual('../src/wallet/domainOnboard') as typeof import('../src/wallet/domainOnboard')
    await savePendingPurchase({ host: HOST, reference: REF, amountSats: 199800 })
    jest.mocked(confirmDomain).mockRejectedValue(new Error('Network request failed'))
    const tree = await render()
    expect(texts(tree)).toContain(en.useDomain.settling)
    await ReactTestRenderer.act(async () => {
      await real.releasePendingPurchase(REF, 'repaid')
    })
    await settle()
    expect(texts(tree)).not.toContain(en.useDomain.settling)
    expect(button(tree, en.useDomain.pay!)!.props.disabled).toBe(false)
    expect(confirmDomain).toHaveBeenCalledTimes(1)
  })
})
