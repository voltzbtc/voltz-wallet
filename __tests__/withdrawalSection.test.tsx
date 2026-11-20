import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Platform, Share, Text, TextInput } from 'react-native'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { WithdrawalSection } from '../src/components/WithdrawalSection'
import { Sheet } from '../src/components/Sheet'
import { sparkSignMessage } from '../src/wallet/spark'
import { formatDate, formatTime } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import { withdrawMessage } from '../src/wallet/withdrawal'
import { formatSats } from '../src/wallet/amount'

// The withdrawal row, its confirmation and its receipt, driven against a gateway double that answers
// as the contract says (api-for-app.md): the credits route with { credits, purchases }, and the
// withdraw route with the receipt. A withdrawal the withdraw route answered 200 for is listed from
// then on, as the gateway lists it, unless a later list a test gives says what became of it.

const PUB = `02${'ab'.repeat(32)}`
const OTHER_PUB = `03${'cd'.repeat(32)}`
const NOW = 1_800_000_000
// The gateway's clock, a day and a few minutes away from the device's, so a receipt drawn from the
// device's time cannot pass.
const GATEWAY_TIME = NOW - 86_400 - 437
const APPLE_REF = 'apple:Production:2000000123456789'
const GOOGLE_REF = `google:${'f'.repeat(64)}`
const SATS_REF = 'a'.repeat(64)
const SPARK = 'spark1qqqsyqcyq5rqwzqfpg9scrgwpugpzysnzs23v9ccrydpk8qarc0jqqqqq'

let mockConnected: string | null = 'w1'
let mockActive: string | null = 'w1'
let mockIdentity = PUB
// As spark.ts keeps them: told of each connect, and at once on subscribing to a live connection.
const mockConnectListeners = new Set<() => void>()

jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  sparkConnectedWalletId: () => mockConnected,
  onSparkConnected: (cb: () => void) => {
    mockConnectListeners.add(cb)
    if (mockConnected !== null) {
      cb()
    }
    return () => {
      mockConnectListeners.delete(cb)
    }
  },
  connectedLnurlDomain: () => 'usevoltz.app',
  sparkGetIdentityPubkey: jest.fn(async () => mockIdentity),
  // As the real signer: it refuses when the live connection is another identity than the one sent.
  sparkSignMessage: jest.fn(async (message: string, as: string) => {
    if (as !== mockIdentity) {
      throw new Error('spark connected as another identity')
    }
    return `sig:${message.length}`
  }),
  sparkOwnSparkAddress: jest.fn(async (as: string) => {
    if (as !== mockIdentity) {
      throw new Error('spark connected as another identity')
    }
    return SPARK
  }),
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => mockActive),
}))

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: () => 'usevoltz.app',
}))

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
const double = (): Double => jest.requireMock('../specs/NativeVoltzStore')

const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  withdrawal: Record<string, string>
  common: Record<string, string>
  home: Record<string, string>
}
const w = en.withdrawal
const fill = (template: string, values: Record<string, string>) =>
  template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => values[k] ?? '')

function purchase(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentRef: APPLE_REF,
    channel: 'apple',
    kind: 'name',
    domain: 'usevoltz.app',
    subject: 'satoshi',
    purchasedAt: NOW - 2 * 86_400,
    withdrawableUntil: NOW + 12 * 86_400,
    withdrawable: true,
    transactionId: '2000000123456789',
    withdrawal: null,
    ...over,
  }
}

type Answer = { status: number; body: unknown } | Promise<{ status: number; body: unknown }>
let lists: Array<Record<string, unknown>[] | 'fail'> = []
let withdrawAnswer: () => Answer = () => ({ status: 500, body: { error: 'internal error' } })
let posts: Array<{ path: string; body: Record<string, unknown> }> = []
// What the withdraw route answered 200 for, by purchase.
let recorded = new Map<string, { state: unknown; requestedAt: unknown; outcomeAt: unknown }>()

// A purchase as the gateway lists it once a withdrawal of it is recorded.
function listedAsTheGateway(p: Record<string, unknown>): Record<string, unknown> {
  const withdrawal = recorded.get(String(p.paymentRef))
  return withdrawal && p.withdrawal === null ? { ...p, withdrawable: false, withdrawal } : p
}

beforeEach(() => {
  mockConnected = 'w1'
  mockActive = 'w1'
  mockIdentity = PUB
  lists = []
  posts = []
  recorded = new Map()
  mockConnectListeners.clear()
  double().control.reset()
  jest.mocked(sparkSignMessage).mockClear()
  global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    const p = new URL(url).pathname
    const body = JSON.parse(init?.body ?? '{}') as Record<string, unknown>
    posts.push({ path: p, body })
    let answer: { status: number; body: unknown }
    if (p === '/api/store/credits') {
      const next = lists.length > 1 ? lists.shift()! : lists[0]
      if (next === undefined || next === 'fail') {
        throw new Error('offline')
      }
      answer = { status: 200, body: { credits: [], purchases: next.map(listedAsTheGateway) } }
    } else if (p === '/api/purchase/withdraw') {
      answer = await withdrawAnswer()
      const r = answer.body as Record<string, unknown>
      if (answer.status === 200 && typeof r.paymentRef === 'string') {
        recorded.set(r.paymentRef, { state: r.state, requestedAt: r.requestedAt, outcomeAt: r.outcomeAt ?? null })
      }
    } else {
      answer = { status: 404, body: {} }
    }
    return { status: answer.status, text: async () => JSON.stringify(answer.body) }
  }) as unknown as typeof fetch
})

let mounted: ReactTestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  ReactTestRenderer.act(() => mounted?.unmount())
  mounted = null
})

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

async function render(kind: 'name' | 'tier' = 'name', readKey = 0): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    mounted = ReactTestRenderer.create(<WithdrawalSection kind={kind} readKey={readKey} />)
  })
  await flush()
  return mounted!
}

type Scope = ReactTestRenderer.ReactTestRenderer | ReactTestRenderer.ReactTestInstance
const rootOf = (scope: Scope): ReactTestRenderer.ReactTestInstance => ('root' in scope ? scope.root : scope)

function texts(scope: Scope): string[] {
  return rootOf(scope).findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter((c): c is string => typeof c === 'string')
  })
}

function pressable(scope: Scope, label: string) {
  return rootOf(scope).findAll(
    n => typeof n.props.onPress === 'function' && n.findAll(x => x.type === Text && x.props.children === label).length > 0,
  )[0]
}

// The open confirmation or receipt, apart from the section drawn behind it.
function openSheet(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance {
  const [sheet] = tree.root.findAll(n => n.type === Sheet && n.props.visible === true)
  if (!sheet) {
    throw new Error(`no sheet open; on screen: ${texts(tree).join(' | ')}`)
  }
  return sheet
}

async function press(scope: Scope, label: string): Promise<void> {
  const target = pressable(scope, label)
  if (!target) {
    throw new Error(`nothing to press labelled ${label}; on screen: ${texts(scope).join(' | ')}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await flush()
}

const withdrawPosts = () => posts.filter(p => p.path === '/api/purchase/withdraw')
const prefs = deviceDateTimePrefs()
const receiptText = (at: number) => fill(w.receipt!, { date: formatDate(at, prefs), time: formatTime(at, prefs) })
const receipt = (over: Record<string, unknown> = {}) => ({
  status: 200,
  body: {
    paymentRef: APPLE_REF,
    channel: 'apple',
    state: 'requested',
    requestedAt: GATEWAY_TIME,
    withdrawableUntil: NOW + 12 * 86_400,
    transactionId: '2000000123456789',
    ...over,
  },
})

describe('the row', () => {
  test('shows for a name purchase the list says withdrawable, with the item and its date', async () => {
    lists = [[purchase()]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeDefined()
    expect(texts(tree)).toContain(
      fill(w.purchase!, { item: fill(w.itemName!, { name: 'satoshi@usevoltz.app' }), date: formatDate(NOW - 2 * 86_400, prefs) }),
    )
  })

  test.each<[string, Record<string, unknown>[] | 'fail', 'name' | 'tier']>([
    ['a purchase the list says is not withdrawable', [purchase({ withdrawable: false })], 'name'],
    ['a year purchase on the address screen', [purchase({ kind: 'tier', subject: 'pay.example.com' })], 'name'],
    ['a name purchase on the domain screen', [purchase()], 'tier'],
    ['a list that cannot be read', 'fail', 'name'],
  ])('shows nothing for %s', async (_name, list, kind) => {
    lists = [list]
    const tree = await render(kind)
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(texts(tree)).toEqual([])
  })

  test('shows a year purchase on the domain screen', async () => {
    lists = [[purchase({ kind: 'tier', domain: 'pay.example.com', subject: 'pay.example.com' })]]
    const tree = await render('tier')
    expect(pressable(tree, w.row!)).toBeDefined()
    expect(texts(tree).join(' ')).toContain(fill(w.itemYear!, { host: 'pay.example.com' }))
  })

  test('is not read for a wallet that is active but not the one connected', async () => {
    lists = [[purchase()]]
    mockActive = 'w2'
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(posts).toEqual([])
  })

  // A focus right after a switch can come before the SDK reconnects, when the connection is still on
  // the wallet switched from and nothing is read; the connection reaching the active wallet reads it.
  test('is read when the connection reaches the active wallet, and signed by that wallet', async () => {
    lists = [[purchase()]]
    mockActive = 'w2'
    const tree = await render()
    expect(posts).toEqual([])
    mockConnected = 'w2'
    mockIdentity = OTHER_PUB
    await ReactTestRenderer.act(async () => mockConnectListeners.forEach(cb => cb()))
    await flush()
    expect(pressable(tree, w.row!)).toBeDefined()
    expect(posts.map(p => [p.path, p.body.pubkey])).toEqual([['/api/store/credits', OTHER_PUB]])
  })

  test('is read once on opening, and not again for a connect to the wallet it was read for', async () => {
    lists = [[purchase()]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeDefined()
    await ReactTestRenderer.act(async () => mockConnectListeners.forEach(cb => cb()))
    await flush()
    expect(posts.map(p => p.path)).toEqual(['/api/store/credits'])
  })

  test('drops a wallet\'s rows as soon as the connection moves to another wallet, before its own list answers', async () => {
    lists = [[purchase()]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeDefined()
    const fetchMock = jest.mocked(global.fetch)
    fetchMock.mockImplementation(async () => new Promise<never>(() => undefined))
    mockConnected = 'w2'
    mockActive = 'w2'
    mockIdentity = OTHER_PUB
    await ReactTestRenderer.act(async () => mockConnectListeners.forEach(cb => cb()))
    await flush()
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(texts(tree)).toEqual([])
  })

  test('a purchase with a withdrawal shows its state and no row', async () => {
    lists = [[purchase({ withdrawable: false, withdrawal: { state: 'requested', requestedAt: GATEWAY_TIME, outcomeAt: null } })]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(texts(tree)).toContain(w.waitingApple)
    expect(pressable(tree, w.appleOpen!)).toBeDefined()
  })

  test('an answer that lands after a newer read changes nothing', async () => {
    let answerFirst!: () => void
    const first = new Promise<void>(resolve => (answerFirst = resolve))
    const fetchMock = jest.mocked(global.fetch)
    const real = fetchMock.getMockImplementation()!
    let calls = 0
    fetchMock.mockImplementation(async (url, init) => {
      calls += 1
      if (calls === 1) {
        await first
        lists = [[purchase()]]
      } else {
        lists = [[purchase({ withdrawable: false })]]
      }
      return real(url, init)
    })
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<WithdrawalSection kind="name" readKey={0} />)
    })
    mounted = tree
    await flush()
    await ReactTestRenderer.act(async () => tree.update(<WithdrawalSection kind="name" readKey={1} />))
    await flush()
    await ReactTestRenderer.act(async () => answerFirst())
    await flush()
    expect(pressable(tree, w.row!)).toBeUndefined()
  })
})

describe('the confirmation and the receipt', () => {
  test('Apple: the box starts unticked and sends 0, the receipt is the gateway\'s time, and Apple\'s sheet opens only after the answer, for its transaction', async () => {
    lists = [[purchase()]]
    let answer!: (value: { status: number; body: unknown }) => void
    withdrawAnswer = () => new Promise(resolve => (answer = resolve))
    double().control.scriptRefund(() => ({ status: 'userCancelled', code: null, message: null }))
    const tree = await render()
    await press(tree, w.row!)

    const box = tree.root.findByProps({ testID: 'withdrawal-consent' })
    expect(box.props.state).toEqual({ checked: false })
    expect(texts(tree)).toContain(w.consent)

    await press(tree, w.confirm!)
    // Nothing opens on Apple while the gateway has not answered.
    expect(withdrawPosts()).toHaveLength(1)
    expect(withdrawPosts()[0]!.body.consent).toBe(0)
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
    expect(texts(tree)).not.toContain(receiptText(GATEWAY_TIME))

    await ReactTestRenderer.act(async () => answer(receipt({ transactionId: '2000000999999999' })))
    await flush()
    // The receipt's date and time are the gateway's, never the device's.
    expect(texts(tree)).toContain(receiptText(GATEWAY_TIME))
    expect(texts(tree)).toContain(w.receiptApple)
    expect(texts(tree).join(' ')).not.toContain('3 business days')
    // The transaction the gateway named, not the one the list carried.
    expect(double().control.state.calls.beginRefundRequest).toEqual(['2000000999999999'])
    expect(texts(tree)).toContain(w.appleClosed)

    await press(openSheet(tree), w.appleOpen!)
    expect(double().control.state.calls.beginRefundRequest).toEqual(['2000000999999999', '2000000999999999'])
  })

  // The section behind the receipt says what Apple's sheet answered once the receipt is closed, with
  // the way back to the sheet, as the receipt did.
  test.each([
    ['closed', { status: 'userCancelled', code: null, message: null }, 'appleClosed'],
    ['sent', { status: 'success', code: null, message: null }, 'appleSent'],
  ])('Apple: a %s sheet still says so after the receipt is closed', async (_name, answer, key) => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    double().control.scriptRefund(() => answer)
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    expect(texts(openSheet(tree))).toContain(w[key])
    await press(tree, en.common.close!)
    expect(tree.root.findAll(n => n.type === Sheet && n.props.visible === true)).toEqual([])
    const state = tree.root.findByProps({ testID: 'withdrawal-state' })
    expect(texts(state)).toEqual([w.waitingApple, w[key], w.appleOpen])
    expect(pressable(state, w.appleOpen!)).toBeDefined()
  })

  test('Apple: a ticked box sends 1, and a sent sheet says Apple has it', async () => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    double().control.scriptRefund(() => ({ status: 'success', code: null, message: null }))
    const tree = await render()
    await press(tree, w.row!)
    await ReactTestRenderer.act(async () => tree.root.findByProps({ testID: 'withdrawal-consent' }).props.onPress())
    expect(tree.root.findByProps({ testID: 'withdrawal-consent' }).props.state).toEqual({ checked: true })
    await press(tree, w.confirm!)
    expect(withdrawPosts()[0]!.body.consent).toBe(1)
    expect(withdrawPosts()[0]!.body.refundTo).toBe('')
    expect(sparkSignMessage).toHaveBeenCalledWith(withdrawMessage(PUB, APPLE_REF, '', 1, withdrawPosts()[0]!.body.timestamp as number), PUB)
    expect(texts(tree)).toContain(w.appleSent)
    expect(pressable(openSheet(tree), w.appleOpen!)).toBeUndefined()
  })

  test.each([
    ['duplicate', { status: 'failed', code: 'duplicateRequest', message: null }, 'appleDuplicate', false],
    ['failed', { status: 'failed', code: 'failed', message: null }, 'appleFailed', true],
  ])('Apple: a %s sheet says so', async (_name, answer, key, reopen) => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    double().control.scriptRefund(() => answer)
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    expect(texts(tree)).toContain(w[key])
    expect(pressable(openSheet(tree), w.appleOpen!) !== undefined).toBe(reopen)
  })

  test('Google: no box, consent 0, the receipt says Voltz asked Google Play, and nothing opens on Apple', async () => {
    lists = [[purchase({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined })]]
    withdrawAnswer = () => receipt({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, state: 'requested' })
    const tree = await render()
    await press(tree, w.row!)
    expect(tree.root.findAllByProps({ testID: 'withdrawal-consent' }).length).toBe(0)
    expect(texts(tree)).not.toContain(w.consent)
    await press(tree, w.confirm!)
    expect(withdrawPosts()[0]!.body.consent).toBe(0)
    expect(texts(tree)).toContain(receiptText(GATEWAY_TIME))
    expect(texts(tree)).toContain(w.receiptGoogle)
    // A reply still requested says nothing of a refund.
    expect(texts(tree).join(' ')).not.toMatch(/Refunded/)
    expect(texts(tree).join(' ')).not.toContain('3 business days')
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
  })

  test('sats: the wallet\'s own Spark address is signed and sent, and only here are 3 business days promised', async () => {
    lists = [[purchase({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })]]
    withdrawAnswer = () => receipt({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })
    const tree = await render()
    await press(tree, w.row!)
    expect(tree.root.findAllByProps({ testID: 'withdrawal-consent' }).length).toBe(0)
    await press(tree, w.confirm!)
    expect(withdrawPosts()[0]!.body.refundTo).toBe(SPARK)
    expect(texts(tree)).toContain(w.receiptSats)
    expect(w.receiptSats).toContain('3 business days')
  })

  // The privacy policy and the store labels say the app asks for no name, so the confirmation has
  // nothing to type and the request carries no name.
  test('the confirmation asks for no name, and the request carries none', async () => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    double().control.scriptRefund(() => ({ status: 'success', code: null, message: null }))
    const tree = await render()
    await press(tree, w.row!)
    expect(tree.root.findAllByType(TextInput).length).toBe(0)
    await press(tree, w.confirm!)
    expect(Object.keys(withdrawPosts()[0]!.body).sort()).toEqual(
      ['consent', 'paymentRef', 'pubkey', 'refundTo', 'signature', 'timestamp'],
    )
  })

  test.each([
    [409, 'window_closed', 'windowClosed'],
    [409, 'not_withdrawable', 'notWithdrawable'],
    [409, 'credit_reserved', 'creditReserved'],
    [409, 'unknown_purchase', 'unknownPurchase'],
    [429, 'too many requests', 'tooMany'],
  ])('a %s %s says its line and shows no receipt', async (status, error, key) => {
    lists = [[purchase()]]
    withdrawAnswer = () => ({ status, body: { error } })
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    expect(texts(tree)).toContain(w[key])
    expect(tree.root.findAllByProps({ testID: 'withdrawal-receipt' }).length).toBe(0)
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
  })

  test('the row gives way to the requested state as soon as the gateway answers', async () => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    double().control.scriptRefund(() => ({ status: 'success', code: null, message: null }))
    const tree = await render()
    await press(tree, w.row!)
    // The read after the answer never answers, and the row does not come back meanwhile.
    const fetchMock = jest.mocked(global.fetch)
    const real = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url, init) =>
      new URL(String(url)).pathname === '/api/store/credits' ? new Promise<never>(() => undefined) : real(url, init),
    )
    await press(tree, w.confirm!)
    await press(tree, en.common.close!)
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(texts(tree)).toContain(w.waitingApple)
  })

  test('the list read after the answer lists the withdrawal, so the row stays gone', async () => {
    lists = [[googlePurchase()]]
    withdrawAnswer = () => googleReceipt()
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    await press(tree, en.common.close!)
    expect(posts.filter(p => p.path === '/api/store/credits').length).toBeGreaterThanOrEqual(2)
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(texts(tree)).toContain(fill(w.waitingGoogle!, { date: formatDate(GATEWAY_TIME, prefs) }))
  })

  test('the list read after the request shows what the list says', async () => {
    withdrawAnswer = () => receipt({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined })
    lists = [[purchase({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined })]]
    const tree = await render()
    await press(tree, w.row!)
    lists = [[purchase({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, withdrawable: false, withdrawal: { state: 'refunded', requestedAt: GATEWAY_TIME, outcomeAt: NOW } })]]
    await press(tree, w.confirm!)
    await press(tree, en.common.close!)
    expect(texts(tree)).toContain(
      fill(w.refunded!, { date: formatDate(NOW, prefs), item: fill(w.itemName!, { name: 'satoshi@usevoltz.app' }) }),
    )
  })

  test('Save receipt shares the receipt with the purchase reference', async () => {
    lists = [[purchase({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })]]
    withdrawAnswer = () => receipt({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    await press(tree, w.saveReceipt!)
    const message = (share.mock.calls[0]![0] as { message: string }).message
    expect(message).toContain(receiptText(GATEWAY_TIME))
    expect(message).toContain(fill(w.receiptRef!, { ref: SATS_REF }))
    expect(message).toContain(w.receiptSats)
    share.mockRestore()
  })
})

// Only the wallet that paid signs.
describe('a switch while the confirmation is open', () => {
  test.each([
    ['the active wallet moved', () => {
      mockActive = 'w2'
    }],
    ['the connection moved to another wallet', () => {
      mockConnected = 'w2'
      mockActive = 'w2'
      mockIdentity = OTHER_PUB
    }],
    ['the connection is another identity under the same id', () => {
      mockIdentity = OTHER_PUB
    }],
  ])('%s: nothing is signed or sent, and the screen says why', async (_name, switchWallet) => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    const tree = await render()
    await press(tree, w.row!)
    switchWallet()
    await press(tree, w.confirm!)
    expect(withdrawPosts()).toEqual([])
    expect(jest.mocked(sparkSignMessage).mock.calls.filter(([message]) => String(message).startsWith('voltz-withdraw:'))).toEqual(
      _name === 'the connection is another identity under the same id'
        ? [[expect.stringContaining(PUB), PUB]]
        : [],
    )
    expect(texts(tree)).toContain(w.otherWallet)
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
  })

  test('sats: a refund address asked of another identity sends nothing', async () => {
    lists = [[purchase({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })]]
    withdrawAnswer = () => receipt({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined })
    const tree = await render()
    await press(tree, w.row!)
    mockIdentity = OTHER_PUB
    await press(tree, w.confirm!)
    expect(withdrawPosts()).toEqual([])
    expect(texts(tree)).toContain(w.otherWallet)
  })
})

const GOOGLE_ITEM = fill(w.itemName!, { name: 'satoshi@usevoltz.app' })
const googlePurchase = (over: Record<string, unknown> = {}) => purchase({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, ...over })
const googleReceipt = (over: Record<string, unknown> = {}) => receipt({ paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, ...over })

// The list read after the answer never answers, so what shows is the receipt and the row's patch.
function holdTheReread(): void {
  const fetchMock = jest.mocked(global.fetch)
  const real = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation(async (url, init) =>
    new URL(String(url)).pathname === '/api/store/credits' && withdrawPosts().length > 0 ? new Promise<never>(() => undefined) : real(url, init),
  )
}

// The receipt and the row after it follow the state the gateway's answer carries: Google's 200 can
// already be refunded or failed, and a repeat answers the state the withdrawal is in now.
describe('the receipt follows the state the answer carries', () => {
  test('Google failed in the 200: the receipt says Google Play did not complete it and Voltz was alerted, never 1 to 10 business days', async () => {
    lists = [[googlePurchase()]]
    withdrawAnswer = () => googleReceipt({ state: 'failed', outcomeAt: NOW - 60 })
    const tree = await render()
    await press(tree, w.row!)
    holdTheReread()
    await press(tree, w.confirm!)
    expect(texts(tree)).toContain(receiptText(GATEWAY_TIME))
    expect(tree.root.findByProps({ testID: 'withdrawal-next' }).props.children).toBe(w.failedGoogle)
    expect(texts(tree)).not.toContain(w.receiptGoogle)
    expect(texts(tree).join(' ')).not.toMatch(/1 to 10|business days|Refunded/)
    await press(tree, en.common.close!)
    // The row's patch is the answer's state, before any list says it.
    expect(texts(tree)).toContain(w.failedGoogle)
    expect(texts(tree).join(' ')).not.toMatch(/Refunded|asked Google Play for the refund/)
  })

  test('Google refunded in the 200: the receipt and the row say refunded on the refund\'s date', async () => {
    lists = [[googlePurchase()]]
    withdrawAnswer = () => googleReceipt({ state: 'refunded', outcomeAt: NOW - 60 })
    const tree = await render()
    await press(tree, w.row!)
    holdTheReread()
    await press(tree, w.confirm!)
    const refunded = fill(w.refunded!, { date: formatDate(NOW - 60, prefs), item: GOOGLE_ITEM })
    expect(tree.root.findByProps({ testID: 'withdrawal-next' }).props.children).toBe(refunded)
    expect(texts(tree)).not.toContain(w.receiptGoogle)
    await press(tree, en.common.close!)
    expect(texts(tree)).toContain(refunded)
  })

  test('Google requested in the 200: the receipt says Voltz asked, and the row says requested, not refunded', async () => {
    lists = [[googlePurchase()]]
    withdrawAnswer = () => googleReceipt()
    const tree = await render()
    await press(tree, w.row!)
    holdTheReread()
    await press(tree, w.confirm!)
    expect(tree.root.findByProps({ testID: 'withdrawal-next' }).props.children).toBe(w.receiptGoogle)
    await press(tree, en.common.close!)
    expect(texts(tree)).toContain(fill(w.waitingGoogle!, { date: formatDate(GATEWAY_TIME, prefs) }))
    expect(texts(tree).join(' ')).not.toMatch(/Refunded/)
  })

  test.each<[string, Record<string, unknown>, string]>([
    ['lapsed', { state: 'lapsed', outcomeAt: NOW - 60 }, w.lapsedApple!],
    ['declined', { state: 'declined', outcomeAt: NOW - 60 }, w.declinedApple!],
    ['refunded', { state: 'refunded', outcomeAt: NOW - 60 }, fill(w.refunded!, { date: formatDate(NOW - 60, prefs), item: GOOGLE_ITEM })],
  ])('an Apple repeat answering %s says so and opens nothing on Apple', async (_name, over, line) => {
    lists = [[purchase()]]
    withdrawAnswer = () => receipt(over)
    const tree = await render()
    await press(tree, w.row!)
    holdTheReread()
    await press(tree, w.confirm!)
    expect(tree.root.findByProps({ testID: 'withdrawal-next' }).props.children).toBe(line)
    expect(texts(tree)).not.toContain(w.receiptApple)
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
    expect(pressable(tree, w.appleOpen!)).toBeUndefined()
    await press(tree, en.common.close!)
    expect(texts(tree)).toContain(line)
    expect(pressable(tree, w.appleOpen!)).toBeUndefined()
  })

  test('the saved receipt carries the line the answer\'s state calls for', async () => {
    lists = [[googlePurchase()]]
    withdrawAnswer = () => googleReceipt({ state: 'failed', outcomeAt: NOW - 60 })
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await press(tree, w.row!)
    await press(tree, w.confirm!)
    await press(tree, w.saveReceipt!)
    const message = (share.mock.calls[0]![0] as { message: string }).message
    expect(message).toContain(w.failedGoogle)
    expect(message).not.toContain(w.receiptGoogle)
    share.mockRestore()
  })
})

// Apple's sheet is the only way an Apple purchase reaches Apple, so where it cannot open nothing is
// sent, and the screen points to an iPhone with this wallet or to Apple's own refund page.
describe('an Apple purchase where Apple\'s sheet cannot open', () => {
  const originalOs = Platform.OS
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: originalOs, configurable: true })
  })
  const onAndroid = () => Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true })

  test('on Android the row gives way to the App Store line, nothing is posted, and the link opens Apple\'s page', async () => {
    onAndroid()
    lists = [[purchase()]]
    withdrawAnswer = () => receipt()
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeUndefined()
    expect(tree.root.findByProps({ testID: 'withdrawal-apple-elsewhere' }).props.children).toBe(w.appleElsewhere)
    await press(tree, w.applePage!)
    expect(open).toHaveBeenCalledWith('https://support.apple.com/118223')
    expect(withdrawPosts()).toEqual([])
    expect(double().control.state.calls.beginRefundRequest).toEqual([])
    open.mockRestore()
  })

  test('on Android a Google purchase is still offered', async () => {
    onAndroid()
    lists = [[googlePurchase()]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeDefined()
    expect(texts(tree)).not.toContain(w.appleElsewhere)
  })

  test('on Android an Apple withdrawal waiting on Apple offers no sheet, only the App Store line', async () => {
    onAndroid()
    lists = [[purchase({ withdrawable: false, withdrawal: { state: 'requested', requestedAt: GATEWAY_TIME, outcomeAt: null } })]]
    const tree = await render()
    expect(texts(tree)).toContain(w.waitingApple)
    expect(pressable(tree, w.appleOpen!)).toBeUndefined()
    expect(tree.root.findByProps({ testID: 'withdrawal-apple-elsewhere' }).props.children).toBe(w.appleElsewhere)
  })

  test('on an iPhone with the bridge the row is offered and no App Store line shows', async () => {
    lists = [[purchase()]]
    const tree = await render()
    expect(pressable(tree, w.row!)).toBeDefined()
    expect(texts(tree)).not.toContain(w.appleElsewhere)
    expect(tree.root.findAllByProps({ testID: 'withdrawal-apple-elsewhere' })).toEqual([])
  })
})

describe('the confirmation\'s amount', () => {
  const sentence = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByProps({ testID: 'withdrawal-purchase' }).props.children as string

  test('a sats charge the list gives an amount for says it, in sats', async () => {
    lists = [[purchase({ paymentRef: SATS_REF, channel: 'sats', transactionId: undefined, amountSats: 21_000 })]]
    const tree = await render()
    await press(tree, w.row!)
    expect(sentence(tree)).toBe(
      fill(w.purchaseAmount!, {
        item: GOOGLE_ITEM,
        date: formatDate(NOW - 2 * 86_400, prefs),
        amount: fill(en.home.sats!, { amount: formatSats(21_000) }),
      }),
    )
    expect(sentence(tree)).toContain('21\u00a0000 sats')
  })

  test.each<[string, Record<string, unknown>]>([
    ['an Apple purchase', {}],
    ['a Google purchase', { paymentRef: GOOGLE_REF, channel: 'google', transactionId: undefined, amountSats: 21_000 }],
    ['a sats charge with no amount', { paymentRef: SATS_REF, channel: 'sats', transactionId: undefined }],
  ])('%s says no amount', async (_name, over) => {
    lists = [[purchase(over)]]
    const tree = await render()
    await press(tree, w.row!)
    expect(sentence(tree)).toBe(fill(w.purchase!, { item: GOOGLE_ITEM, date: formatDate(NOW - 2 * 86_400, prefs) }))
  })
})

describe('a lapsed withdrawal in the list', () => {
  test('says Apple sent no word in 14 days, with no way back to Apple\'s sheet and no row', async () => {
    lists = [[purchase({ withdrawable: false, withdrawal: { state: 'lapsed', requestedAt: GATEWAY_TIME, outcomeAt: NOW - 60 } })]]
    const tree = await render()
    expect(texts(tree)).toContain(w.lapsedApple)
    expect(pressable(tree, w.appleOpen!)).toBeUndefined()
    expect(pressable(tree, w.row!)).toBeUndefined()
  })
})
