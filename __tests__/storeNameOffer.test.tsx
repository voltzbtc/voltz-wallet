import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Platform, Text, TextInput } from 'react-native'
import { createHash } from 'crypto'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { carriedTexts, expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import { Skeleton } from '../src/components/Skeleton'
import { StoreNameOffer } from '../src/components/StoreNameOffer'
import { sparkCheckLnAddress, sparkGetIdentityPubkey, sparkGetLnAddress, sparkRegisterLnAddress } from '../src/wallet/spark'
import { quoteName } from '../src/wallet/namePurchase'
import {
  DEFECT_REFUSALS,
  FINAL_REFUSALS,
  keepNameCheck,
  liveStoreContext,
  syncStorePurchases,
  type StoreCredit,
} from '../src/wallet/storePurchase'
import { formatDate, formatTime } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import type { NativeBuyResult, NativePurchase } from '../specs/NativeVoltzStore'
import { answerQuestion, question } from './support/question'
import { SupportMailCard } from '../src/components/SupportMail'
import { ReceiveHeldByExit } from '../src/wallet/errors'

// The address sheet in a build that sells through the store, driven end to end through the real
// sheet and the real store flow, with the bridge's double and a gateway answering over fetch.

const DOMAIN = 'usevoltz.app'
const PUBKEY = `02${'a'.repeat(64)}`
const REF = 'e621e1f8-c36c-495a-93fc-0c247a3e6e5f'
const REF_B = '7d444840-9dc0-11d1-b245-5ffdce74fad2'

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'store' }))

// The connected wallet, which a test switches to see that one wallet's sheet leaves another's alone. The
// registry names it active too, as a restart connects the active wallet.
let mockWallet = 'w_a'
jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => 'usevoltz.app'),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkConnectedWalletId: () => mockWallet,
  onSparkConnected: () => () => undefined,
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({ wallets: [{ id: 'w_a' }], activeId: 'w_a' })),
  getActiveWalletId: jest.fn(async () => mockWallet),
}))

// The gateway's retries wait 2, 4 and 8 s in the app, and none here, so a read that fails fails at once.
jest.mock('../src/wallet/namePurchase', () => {
  const real = jest.requireActual('../src/wallet/namePurchase')
  return {
    ...real,
    quoteName: jest.fn(),
    confirmName: jest.fn(),
    currentDeps: async () => ({ ...(await real.currentDeps()), sleep: async () => undefined }),
  }
})

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
const double = jest.requireMock('../specs/NativeVoltzStore') as Double

const RNFS = (require('react-native-fs') as {
  default: {
    DocumentDirectoryPath: string
    exists(p: string): Promise<boolean>
    unlink(p: string): Promise<void>
    readFile(p: string, e: string): Promise<string>
    writeFile(p: string, c: string, e: string): Promise<void>
  }
}).default
const FILES = ['store-orders.json', 'purchases.json', 'purchase-name.json', 'deletion.json'].map(f => `${RNFS.DocumentDirectoryPath}/${f}`)

// The rendered words are compared against the locale file, never against t() again.
const en = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8')) as {
  withdrawal: Record<string, string>
  store: Record<string, string>
  receive: Record<string, string>
  recover: Record<string, string>
  common: Record<string, string>
  emergencyExit: Record<string, string>
}
function copy(text: string, values: Record<string, string> = {}): string {
  return Object.entries(values).reduce((out, [k, v]) => out.split(`{{${k}}}`).join(v), text)
}

// The gateway, by route. Each credits read takes the next of `reads` while any is left, and then
// answers what `ledger` says at that moment.
type Reply = { status: number; body: unknown }
type Ledger = StoreCredit[] | 'down'
let ledger: Ledger
let reads: Ledger[]
// A reply may be a promise, which holds the route until the test settles it.
let answers: Record<string, Array<Reply | Promise<Reply>>>
let calls: string[]
// How the credits route answers, which is as `reads` and `ledger` say, never (held open until
// released), or not at all (the connection fails).
let creditsRead: 'answer' | 'hold' | 'reject'
let releases: (() => void)[]
// The id has the gateway's shape, the SHA-256 of a payment reference in hex, one per credit and the
// same through its states, so a fixture's id follows what makes it that credit and never its state.
const credit = (over: Partial<StoreCredit> = {}): StoreCredit => {
  const c = { domain: DOMAIN, tier: 'standard', state: 'available', name: null, grantedAt: 1_800_000_000, ...over }
  return { id: createHash('sha256').update(`${c.domain} ${c.tier} ${c.grantedAt}`).digest('hex'), ...c }
}

function gateway(): void {
  global.fetch = jest.fn(async (url: string, init: { body: string }) => {
    const route = new URL(url).pathname
    const body = JSON.parse(init.body) as Record<string, unknown>
    calls.push(`${route} ${String(body.subject ?? body.username ?? body.reference ?? '')}`.trim())
    let reply: Reply | undefined
    if (route === '/api/store/credits') {
      if (creditsRead === 'hold') {
        await new Promise<void>(resolve => releases.push(resolve))
      } else if (creditsRead === 'reject') {
        throw new TypeError('Network request failed')
      }
      // A 500 is no answer and is not retried, so a failed read costs no wait.
      const now = reads.shift() ?? ledger
      reply = now === 'down' ? { status: 500, body: { error: 'boom' } } : { status: 200, body: { credits: now } }
    } else if (route === '/api/store/spend') {
      // Recorded for the name asked, unless the test queued an answer of its own.
      reply = answers[route]?.length
        ? await answers[route]!.shift()
        : { status: 200, body: { recorded: true, username: body.username, expiresAt: 1_900_000_000 } }
    } else {
      reply = await (answers[route] ?? []).shift()
    }
    if (!reply) {
      throw new Error(`no answer left for ${route}`)
    }
    const { status, body: payload } = reply
    return { status, ok: status < 300, text: async () => JSON.stringify(payload) } as unknown as Response
  }) as unknown as typeof fetch
}

const order = (subject: string, productId = 'name_standard'): Reply => ({
  status: 200,
  body: { reference: REF, productId, state: 'held', kind: 'name', subject, appAccountToken: REF },
})
const delivered: Reply = {
  status: 200,
  body: { state: 'delivered', reference: REF, kind: 'name', credit: { domain: DOMAIN, tier: 'standard' } },
}

function applePurchase(over: Partial<NativePurchase> = {}): NativePurchase {
  return { productIds: ['name_standard'], key: 'tx-1', reference: REF.toUpperCase(), state: 'purchased', purchasedAt: 1, verified: true, revoked: false, ...over }
}
const bought = (): NativeBuyResult => {
  const purchase = applePurchase()
  double.control.state.open.push(purchase)
  return { status: 'purchased', code: null, subCode: null, message: null, purchase }
}
const askToBuy = (): NativeBuyResult => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null })

// SDK 0.27.2 turns a gateway refusal into a NetworkError carrying the status and the body.
function refusedWith(status: number, code: string): Error {
  return Object.assign(new Error('SdkError.NetworkError'), {
    tag: 'NetworkError',
    inner: [`network request failed with status ${status}: {"error":"${code}"}`],
  })
}
// The same error class with no answer in it, as when the connection drops mid register.
const dropped = (): Error =>
  Object.assign(new Error('SdkError.NetworkError'), { tag: 'NetworkError', inner: ['error sending request'] })

const address = (username: string) => ({ username, address: `${username}@${DOMAIN}`, lnurl: 'lnurl1' })

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

// Several rounds, since a press runs a chain of store, gateway and file steps, and a loaded machine
// can leave the tail of that chain for a later timer.
async function settle(ms = 30): Promise<void> {
  for (let round = 0; round < 4; round++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, round === 0 ? ms : 10))
    })
  }
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

function sheet(visible: boolean, onRegistered: jest.Mock, onClose: jest.Mock = jest.fn()) {
  return <LnAddressSheet visible={visible} domain={DOMAIN} onClose={onClose} onRegistered={onRegistered} />
}

async function render(onRegistered = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(sheet(true, onRegistered))
  })
  await settle()
  return tree
}

// The sheet closed and opened again, and the app killed and opened again, both read from disk.
async function reopen(tree: ReactTestRenderer.ReactTestRenderer, onRegistered = jest.fn()): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.update(sheet(false, onRegistered))
  })
  await ReactTestRenderer.act(async () => {
    tree.update(sheet(true, onRegistered))
  })
  await settle()
}

async function restart(tree: ReactTestRenderer.ReactTestRenderer, onRegistered = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  return render(onRegistered)
}

// Past the 400 ms availability debounce.
async function type(tree: ReactTestRenderer.ReactTestRenderer, value: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(value)
  })
  await settle(450)
}

let warn: jest.SpyInstance

beforeEach(async () => {
  jest.clearAllMocks()
  mockWallet = 'w_a'
  double.control.reset()
  double.control.state.products = [
    { id: 'name_standard', displayPrice: 'US$ 9.99' },
    { id: 'name_four', displayPrice: 'US$ 39.99' },
    { id: 'name_short', displayPrice: 'US$ 99.99' },
  ]
  ledger = []
  reads = []
  answers = {}
  calls = []
  creditsRead = 'answer'
  releases = []
  gateway()
  // Reset rather than cleared, so a value queued for one test and never read cannot reach the next.
  jest.mocked(sparkCheckLnAddress).mockReset().mockResolvedValue(true)
  jest.mocked(sparkGetLnAddress).mockReset().mockResolvedValue(null)
  jest.mocked(sparkRegisterLnAddress).mockReset().mockImplementation(async (name: string) => address(name))
  jest.mocked(sparkGetIdentityPubkey).mockReset().mockImplementation(async () => PUBKEY)
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  for (const file of FILES) {
    if (await RNFS.exists(file)) {
      await RNFS.unlink(file)
    }
  }
})

afterEach(() => {
  warn.mockRestore()
})

test('a name is priced by the store and never quoted or paid in sats', async () => {
  const tree = await render()
  await type(tree, 'alice1')
  const shown = texts(tree)
  expect(shown).toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
  // Above Buy, the App Store's own way to cancel, which promises no refund since Apple decides.
  expect(shown).toContain(en.withdrawal.payLineApple)
  expect(shown).not.toContain(en.withdrawal.payLineSats)
  expect(button(tree, en.store.buyName!)).toBeDefined()
  expect(button(tree, en.receive.lnSeePrice!)).toBeUndefined()
  expect(button(tree, en.receive.lnPay!)).toBeUndefined()
  expect(shown.join(' ')).not.toMatch(/sats/)
  expect(quoteName).not.toHaveBeenCalled()
})

// The order stops on this device when the address was given up here, before the store opens and
// before anything is signed, and the words point at the row that lifts the stop.
test('a wallet whose address was given up here opens no store and is pointed to the way back', async () => {
  await RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/deletion.json`,
    JSON.stringify({ w_a: { pubkey: `02${'a'.repeat(64)}`, state: 'removed', askedAt: 1 } }),
    'utf8',
  )
  const tree = await render()
  await type(tree, 'alice1')
  await press(tree, en.store.buyName!)
  expect(double.control.state.calls.buy).toEqual([])
  expect(calls.filter(c => c.startsWith('/api/store/order'))).toEqual([])
  expect(texts(tree)).toContain(en.receive.lnOffBuy)
})

test('buying opens the store, spends the credit it delivered and registers the name', async () => {
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  await press(tree, en.store.buyName!)
  expect(double.control.state.calls.buy).toEqual([{ productId: 'name_standard', reference: REF, accountId: null }])
  expect(calls.filter(c => !c.startsWith('/api/store/credits'))).toEqual([
    '/api/store/order alice1',
    `/api/store/confirm ${REF}`,
    '/api/store/spend alice1',
  ])
  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('alice1', undefined, 'w_a')
  expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
})

describe('the warning before a change, on the rail a store build uses', () => {
  async function holding(current: string): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} currentAddress={current} onClose={jest.fn()} onRegistered={jest.fn()} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    return tree
  }

  test('Buy names the address that stops and opens nothing until the answer', async () => {
    const tree = await holding('old@usevoltz.app')
    answers['/api/store/order'] = [order('alice1')]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    await press(tree, en.store.buyName!)

    expect(question(tree)?.body).toContain('old@usevoltz.app')
    expect(double.control.state.calls.buy).toEqual([])

    await answerQuestion(tree, en.receive.lnChangeConfirm)
    await settle()
    expect(double.control.state.calls.buy).toHaveLength(1)
  })

  // A credit can come from an earlier session or version, so no warning before the store covers it.
  test('a name a credit pays for is warned about, and spent only on the answer', async () => {
    ledger = [credit()]
    const tree = await holding('old@usevoltz.app')
    await press(tree, en.receive.lnUseName!)

    expect(question(tree)?.body).toContain('old@usevoltz.app')
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()

    await answerQuestion(tree, en.receive.lnChangeConfirm)
    await settle()
    expect(sparkRegisterLnAddress).toHaveBeenCalled()
  })

  test('a name on a domain the customer pays for is warned about, and registered only on the answer', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet
          visible
          domain={DOMAIN}
          namesFree
          currentAddress="old@usevoltz.app"
          onClose={jest.fn()}
          onRegistered={jest.fn()}
        />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    await press(tree, en.receive.lnUseName!)

    expect(question(tree)).not.toBeNull()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()

    await answerQuestion(tree, en.receive.lnChangeConfirm)
    await settle()
    expect(sparkRegisterLnAddress).toHaveBeenCalled()
  })

  test('cancelling leaves the address alone', async () => {
    ledger = [credit()]
    const tree = await holding('old@usevoltz.app')
    await press(tree, en.receive.lnUseName!)

    await answerQuestion(tree, en.common.cancel)
    await settle()
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  })

  test('with no address to lose there is no warning', async () => {
    ledger = [credit()]
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} onClose={jest.fn()} onRegistered={jest.fn()} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    await press(tree, en.receive.lnUseName!)

    expect(question(tree)).toBeNull()
    expect(sparkRegisterLnAddress).toHaveBeenCalled()
  })

  // The money already went, so the resumed purchase finishes on Check again with no question.
  test('a paid purchase coming back is spent with no warning', async () => {
    const tree = await holding('old@usevoltz.app')
    answers['/api/store/order'] = [order('alice1')]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    reads = [[], 'down']
    ledger = 'down'
    await press(tree, en.store.buyName!)
    await answerQuestion(tree, en.receive.lnChangeConfirm)
    await settle()
    expect(double.control.state.calls.buy).toHaveLength(1)

    ledger = [credit()]
    await press(tree, en.receive.lnCheckAgain!)

    expect(question(tree)).toBeNull()
    expect(sparkRegisterLnAddress).toHaveBeenCalled()
  })
})

// Without the credits read first a lost register could not be told from an earlier one, so the
// delivered credit waits for the list. The store charged, so the sheet checks, and never says the
// purchase failed nor shows its price again.
test('a delivered credit the list cannot show is checked, never refused or priced, and Check again spends it', async () => {
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  // The press's read, then the read after the delivery.
  reads = [[], 'down']
  ledger = 'down'
  await press(tree, en.store.buyName!)
  const shown = texts(tree)
  expect(shown).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
  expect(shown).not.toContain(en.store.retry)
  expect(shown).not.toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
  expect(button(tree, en.store.buyName!)).toBeUndefined()
  expect(calls).not.toContain('/api/store/spend alice1')
  // Still unreadable, Check again stays on the check.
  await press(tree, en.receive.lnCheckAgain!)
  expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
  ledger = [credit()]
  await press(tree, en.receive.lnCheckAgain!)
  expect(double.control.state.calls.buy).toHaveLength(1)
  expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
})

// A credit reserved for the name by the time the list answers is a register already on its way.
test('a delivered credit reserved for the name by the time the list answers is finishing', async () => {
  const tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  reads = [[], 'down']
  ledger = [credit({ state: 'reserved', name: 'alice1' })]
  await press(tree, en.store.buyName!)
  await press(tree, en.receive.lnCheckAgain!)
  expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
})

// Nothing is sold while what the wallet already paid for is unknown, whether the list fails on open
// or on the press, and Check again reads it.
describe('credits that cannot be read', () => {
  test('on open sell nothing, and Check again reads them', async () => {
    ledger = 'down'
    const tree = await render()
    await type(tree, 'alice1')
    const shown = texts(tree)
    expect(shown).toContain(en.store.unread)
    expect(shown).not.toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    ledger = []
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
    expect(button(tree, en.store.buyName!)).toBeDefined()
  })

  test('on the press open no order and say so, never that it failed', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    ledger = 'down'
    answers['/api/store/order'] = [order('alice1')]
    double.control.scriptBuy(bought)
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(en.store.unread)
    expect(texts(tree)).not.toContain(en.store.retry)
    expect(calls).not.toContain('/api/store/order alice1')
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('when the wallet cannot sign on open, sell nothing', async () => {
    jest.mocked(sparkGetIdentityPubkey).mockRejectedValueOnce(new Error('not connected'))
    const tree = await render()
    await type(tree, 'alice1')
    expect(texts(tree)).toContain(en.store.unread)
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  })

  // A name on the customer's own domain costs nothing and spends no credit.
  test('stop nothing on a domain whose names are free', async () => {
    ledger = 'down'
    const onRegistered = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} namesFree onClose={jest.fn()} onRegistered={onRegistered} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    expect(texts(tree)).not.toContain(en.store.unread)
    expect(texts(tree)).toContain(en.receive.lnAvailable)
    await press(tree, en.receive.lnUseName!)
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
  })

  // The offer claims through the sheet's register, which reads the wallet as the claim starts and
  // registers only while the live session is that wallet's, so a session left on another wallet by a
  // switch puts the name on no other key.
  test('a free name on a session another wallet holds registers nothing', async () => {
    ledger = 'down'
    const onRegistered = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} namesFree onClose={jest.fn()} onRegistered={onRegistered} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    const active = (jest.requireMock('../src/wallet/walletRegistry') as { getActiveWalletId: jest.Mock }).getActiveWalletId
    active.mockImplementation(async () => 'w_a')
    mockWallet = 'w_b'
    try {
      await press(tree, en.receive.lnUseName!)
    } finally {
      active.mockImplementation(async () => mockWallet)
    }
    expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
    expect(onRegistered).not.toHaveBeenCalled()
  })
})

// The store charged and delivered, and only the spend intent failed, so the line names that step and
// the credit stays offered for another press.
test('a spend intent that fails after a delivery says the name was not set up, never that it failed', async () => {
  const tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  reads = [[], [credit()]]
  ledger = [credit()]
  const answering = global.fetch
  global.fetch = jest.fn(async (url: string, init: RequestInit) =>
    new URL(url).pathname === '/api/store/spend'
      ? ({ status: 503, ok: false, text: async () => JSON.stringify({ error: 'unavailable' }) } as unknown as Response)
      : answering(url, init),
  ) as unknown as typeof fetch
  await press(tree, en.store.buyName!)
  const shown = texts(tree)
  expect(shown).toContain(en.store.spendRetry)
  expect(shown).not.toContain(en.store.retry)
  expect(shown).toContain(en.store.covered)
  expect(button(tree, en.receive.lnUseName!)).toBeDefined()
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
})

// The address was given up while the store sheet was open: the spend stops on this device, and its
// words point at the way back rather than at trying again.
test('a spend intent stopped by an address given up meanwhile points to the way back', async () => {
  const tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  reads = [[], [credit()]]
  ledger = [credit()]
  const answering = global.fetch
  global.fetch = jest.fn(async (url: string, init: RequestInit) => {
    if (new URL(url).pathname === '/api/store/confirm') {
      await RNFS.writeFile(
        `${RNFS.DocumentDirectoryPath}/deletion.json`,
        JSON.stringify({ w_a: { pubkey: PUBKEY, state: 'removed', askedAt: 1 } }),
        'utf8',
      )
    }
    return answering(url, init)
  }) as unknown as typeof fetch
  await press(tree, en.store.buyName!)
  const shown = texts(tree)
  expect(shown).toContain(en.receive.lnOffBuy)
  expect(shown).not.toContain(en.store.spendRetry)
  expect(calls.filter(c => c.startsWith('/api/store/spend'))).toEqual([])
  expect(sparkRegisterLnAddress).not.toHaveBeenCalled()
})

test('a credit that covers the name is spent without opening the store', async () => {
  ledger = [credit()]
  const onRegistered = jest.fn()
  const tree = await render(onRegistered)
  await type(tree, 'alice1')
  expect(texts(tree)).toContain(en.store.covered)
  await press(tree, en.receive.lnUseName!)
  expect(double.control.state.calls.buy).toEqual([])
  expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
})

// A credit whose purchase is being withdrawn is spent on nothing at the gateway, which marks it held;
// the sheet offers it for nothing and sells the name as it would with no credit.
test('a credit a withdrawal holds is not offered for the name', async () => {
  ledger = [{ ...credit(), held: 'withdrawal' }]
  const tree = await render()
  await type(tree, 'alice1')
  expect(texts(tree)).not.toContain(en.store.covered)
  expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
  expect(button(tree, en.store.buyName!)).toBeDefined()
  expect(calls.filter(c => c.startsWith('/api/store/spend'))).toEqual([])
})

describe('a name taken between the purchase and the register', () => {
  async function lostAlice(): Promise<ReactTestRenderer.ReactTestRenderer> {
    ledger = [credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_taken'))
    await press(tree, en.receive.lnUseName!)
    return tree
  }

  test('reads as taken, keeps the credit and offers nothing for that name', async () => {
    const tree = await lostAlice()
    const shown = texts(tree)
    expect(shown).toContain(en.receive.lnTaken)
    expect(shown).toContain(copy(en.store.takenMidway!, { name: 'alice1', length: en.store.lengthStandard! }))
    expect(shown).not.toContain(en.receive.lnAvailable)
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  })

  test('the taken name is not registered again, even when the server calls it free', async () => {
    const tree = await lostAlice()
    await type(tree, 'alice')
    await type(tree, 'alice1')
    expect(texts(tree)).toContain(en.receive.lnTaken)
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
  })

  test('another name of the same length goes on with the same credit', async () => {
    const onRegistered = jest.fn()
    ledger = [credit()]
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_taken'))
    await press(tree, en.receive.lnUseName!)
    await type(tree, 'carol1')
    expect(texts(tree)).toContain(en.store.covered)
    await press(tree, en.receive.lnUseName!)
    expect(double.control.state.calls.buy).toEqual([])
    expect(onRegistered).toHaveBeenCalledWith(address('carol1'))
  })

  test('a name of another length says the credit does not cover it and sells nothing', async () => {
    const tree = await lostAlice()
    await type(tree, 'bob')
    const shown = texts(tree)
    expect(shown).toContain(copy(en.store.notCovered!, { length: en.store.lengthStandard! }))
    expect(shown).not.toContain(copy(en.store.namePrice!, { name: 'bob', price: 'US$ 99.99' }))
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
  })
})

describe('a register whose answer was lost', () => {
  async function dropAlice(): Promise<ReactTestRenderer.ReactTestRenderer> {
    ledger = [credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
    return tree
  }

  test('is done when the wallet already answers on the name', async () => {
    const onRegistered = jest.fn()
    ledger = [credit()]
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
    // The read inside the register, then the read after the lost answer.
    jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(null).mockResolvedValueOnce(address('alice1'))
    await press(tree, en.receive.lnUseName!)
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
    expect(texts(tree)).not.toContain(en.receive.lnTaken)
  })

  test('is done when the credit was spent on the name', async () => {
    const tree = await dropAlice()
    jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
    jest.mocked(sparkCheckLnAddress).mockResolvedValue(false)
    // The press reads the credit as available, and the read after the lost answer finds it spent.
    reads = [[credit()], [credit({ state: 'spent', name: 'alice1' })]]
    await press(tree, en.receive.lnUseName!)
    const shown = texts(tree)
    expect(shown).toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
    expect(shown).not.toContain(en.receive.lnTaken)
  })

  // The gateway lists every credit for ever, so a wallet that once held the name and moved off it
  // still has a credit spent on it when a later register of the same name loses its answer.
  test('is not done because an earlier credit was spent on the same name', async () => {
    const old = credit({ state: 'spent', name: 'alice1', grantedAt: 1_700_000_000 })
    ledger = [old, credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
    jest.mocked(sparkGetLnAddress).mockResolvedValue(address('bob123'))
    // The register never took, so the fresh credit is still available on the read after it.
    reads = [[old, credit()], [old, credit()]]
    await press(tree, en.receive.lnUseName!)
    const shown = texts(tree)
    expect(shown).not.toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
    expect(shown).toContain(en.store.retry)
  })

  test('is done when the credit spent on the name is the one this register could spend', async () => {
    const old = credit({ state: 'spent', name: 'alice1', grantedAt: 1_700_000_000 })
    ledger = [old, credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
    jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('offline'))
    reads = [[old, credit()], [old, credit({ state: 'spent', name: 'alice1' })]]
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
  })

  test('is still finishing while the credit is reserved for it', async () => {
    const tree = await dropAlice()
    reads = [[credit()], [credit({ state: 'reserved', name: 'alice1' })]]
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  })

  // The check stays in the book until a read of the list answers, and an answer read once is not
  // read again on the next open.
  async function droppedUnread(onRegistered = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
    ledger = [credit()]
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
    reads = [[credit()]]
    ledger = 'down'
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
    return tree
  }

  test('is done on open once the gateway spent the credit while the sheet was closed', async () => {
    const tree = await droppedUnread()
    ledger = [credit({ state: 'spent', name: 'alice1' })]
    const again = await restart(tree)
    expect(texts(again)).toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
  })

  test('settled on open is not checked again', async () => {
    const tree = await droppedUnread()
    ledger = [credit()]
    await reopen(tree)
    expect(texts(tree)).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
    ledger = 'down'
    await reopen(tree)
    expect(texts(tree)).toContain(en.store.unread)
    expect(texts(tree)).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
  })

  test('settled by Check again is not checked again', async () => {
    const tree = await droppedUnread()
    ledger = [credit()]
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
    ledger = 'down'
    await reopen(tree)
    expect(texts(tree)).toContain(en.store.unread)
    expect(texts(tree)).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
  })

  // The address already answering is the register having landed, so the next open offers names again.
  test('found registered by Check again is not done again on the next open', async () => {
    const onRegistered = jest.fn()
    const tree = await droppedUnread(onRegistered)
    jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(address('alice1'))
    await press(tree, en.receive.lnCheckAgain!)
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
    ledger = [credit({ state: 'spent', name: 'alice1' })]
    await reopen(tree, onRegistered)
    expect(texts(tree)).not.toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
  })

  // A pending name the list then shows as nobody's reservation of this wallet is somebody else's.
  test('a pending name checked once the list answers is somebody else finishing it', async () => {
    ledger = [credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
    reads = [[credit()]]
    ledger = 'down'
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
    ledger = [credit()]
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(en.store.otherPending)
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
  })

  test('says it is checking when the credits cannot be read, never taken and never a new offer', async () => {
    const tree = await dropAlice()
    jest.mocked(sparkCheckLnAddress).mockResolvedValue(false)
    reads = [[credit()], 'down']
    await press(tree, en.receive.lnUseName!)
    const shown = texts(tree)
    expect(shown).toContain(copy(en.store.checking!, { name: 'alice1' }))
    expect(shown).not.toContain(en.receive.lnTaken)
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
    // Checking again reads the truth once the list answers.
    ledger = [credit({ state: 'reserved', name: 'alice1' })]
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
  })
})

describe('a purchase the store has not finished', () => {
  async function waiting(onRegistered = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    answers['/api/store/order'] = [order('alice1')]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.store.buyName!)
    return tree
  }

  test('waits, and the wait survives closing and opening the sheet', async () => {
    const onRegistered = jest.fn()
    const tree = await waiting(onRegistered)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false, onRegistered))
    })
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true, onRegistered))
    })
    await settle()
    expect(texts(tree)).toContain(copy(en.store.waitingBody!, { name: 'alice1' }))
    await type(tree, 'alice1')
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  })

  test('waits after a restart too, from the store book', async () => {
    const first = await waiting()
    first.unmount()
    const tree = await render()
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(double.control.state.calls.buy).toHaveLength(1)
  })

  // The store still lists the purchase, so the wait is the truth whatever the credits say, and a list
  // that cannot be read never turns it into a check.
  test('a check the credits cannot answer keeps a wait the store still holds', async () => {
    const tree = await waiting()
    ledger = 'down'
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(texts(tree)).toContain(en.store.notYet)
    expect(texts(tree)).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
  })

  test('leaving the wait brings the offer back', async () => {
    const tree = await waiting()
    await press(tree, en.store.stopWaiting!)
    await type(tree, 'alice2')
    expect(button(tree, en.store.buyName!)).toBeDefined()
  })

  test('an approval that arrives is confirmed and the name goes on', async () => {
    const onRegistered = jest.fn()
    const tree = await waiting(onRegistered)
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [delivered]
    ledger = [credit()]
    await press(tree, en.receive.lnCheckAgain!)
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
  })

  // The check settles the approval itself, and the answer it hears stays on screen rather than the
  // offer the rest of the check would read once the store no longer lists the purchase.
  test('an approval refused for good on a check stays refused, with nothing to buy', async () => {
    const tree = await waiting()
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'refunded' } }]
    await press(tree, en.receive.lnCheckAgain!)
    const shown = texts(tree)
    expect(shown).toContain(en.store.refusedTitle)
    expect(shown).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(double.control.state.calls.finish).toEqual(['tx-1'])
  })

  test('an approval that needs support on a check stays on the support line', async () => {
    const tree = await waiting()
    double.control.state.open = [applePurchase()]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
    await press(tree, en.receive.lnCheckAgain!)
    const shown = texts(tree)
    expect(shown).toContain(en.store.support)
    expect(shown).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    expect(double.control.state.calls.finish).toEqual([])
  })
})

// Expected apart from the screen's own map. A refund the store already made and a test purchase are
// the only refusals that say no money is at stake; every other one says how that store gives it back.
const NO_MONEY_AT_STAKE: Record<string, string> = {
  '409 refunded': 'refusedRefunded',
  '403 environment_not_allowed': 'refusedTest',
  '403 xcode_environment': 'refusedTest',
}
const REFUSED_LINES = ['refusedApple', 'refusedGoogle', 'refusedRefunded', 'refusedTest']

function refusedLine(refusal: string, store: 'apple' | 'google'): string {
  return en.store[NO_MONEY_AT_STAKE[refusal] ?? (store === 'apple' ? 'refusedApple' : 'refusedGoogle')]!
}

const googleOrder = (subject: string): Reply => ({
  status: 200,
  body: {
    reference: REF,
    productId: 'name_standard',
    state: 'held',
    kind: 'name',
    subject,
    obfuscatedProfileId: REF,
    obfuscatedAccountId: 'h'.repeat(43),
  },
})
// store.ts subscribes to Play's updates once per JS context, and the double's reset between tests
// drops that subscription, so a Play answer goes to the listener store.ts registered first.
let playListener: Parameters<typeof double.default.onUpdate>[0] | null = null
const subscribe = double.default.onUpdate.bind(double.default)
jest.spyOn(double.default, 'onUpdate').mockImplementation(listener => {
  playListener = listener
  return subscribe(listener)
})

// Play answers a purchase through its update callback, after the sheet has launched.
const googleBought = (): NativeBuyResult => {
  const purchase = applePurchase({ key: 'gp-token-1', reference: REF, state: '1' })
  double.control.state.open.push(purchase)
  setTimeout(() => playListener?.(double.update([purchase], '0')), 5)
  return { status: 'launched', code: null, subCode: null, message: null, purchase: null }
}

describe.each(['apple', 'google'] as const)('a purchase refused for good on %s', store => {
  const os = Platform.OS
  beforeEach(() => {
    Object.defineProperty(Platform, 'OS', { value: store === 'apple' ? 'ios' : 'android', configurable: true })
  })
  afterEach(() => {
    Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  })

  test('the table covers a refund, a test purchase and the rest', () => {
    const lines = new Set([...FINAL_REFUSALS].map(refusal => refusedLine(refusal, store)))
    expect(lines).toEqual(new Set([en.store.refusedRefunded, en.store.refusedTest, refusedLine('', store)]))
  })

  test.each([...FINAL_REFUSALS])('%s says what became of the money', async refusal => {
    const [status, code] = refusal.split(' ')
    const tree = await render()
    await type(tree, 'alice1')
    answers['/api/store/order'] = [store === 'apple' ? order('alice1') : googleOrder('alice1')]
    answers['/api/store/confirm'] = [{ status: Number(status), body: { error: code } }]
    double.control.scriptBuy(store === 'apple' ? bought : googleBought)
    await press(tree, en.store.buyName!)
    const shown = texts(tree)
    const line = refusedLine(refusal, store)
    expect(shown).toContain(en.store.refusedTitle)
    expect(shown).toContain(line)
    for (const other of REFUSED_LINES.map(key => en.store[key]!).filter(text => text !== line)) {
      expect(shown).not.toContain(other)
    }
  })
})

// Each of these views already says to check again about a purchase that may be paid, so a check the
// wallet cannot sign for leaves it as it was and never says the purchase failed.
describe('a Check again the wallet cannot sign for', () => {
  const unsigned = (): void => {
    jest.mocked(sparkGetIdentityPubkey).mockRejectedValueOnce(new Error('not connected'))
  }

  test('keeps the wait', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    answers['/api/store/order'] = [order('alice1')]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.store.buyName!)
    unsigned()
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(texts(tree)).not.toContain(en.store.retry)
  })

  test('keeps the finishing name', async () => {
    ledger = [credit()]
    const tree = await render()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
    reads = [[credit()], [credit({ state: 'reserved', name: 'alice1' })]]
    await press(tree, en.receive.lnUseName!)
    unsigned()
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
    expect(texts(tree)).not.toContain(en.store.retry)
  })

  test('keeps the check', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    answers['/api/store/order'] = [order('alice1')]
    answers['/api/store/confirm'] = [delivered]
    double.control.scriptBuy(bought)
    reads = [[], 'down']
    await press(tree, en.store.buyName!)
    unsigned()
    await press(tree, en.receive.lnCheckAgain!)
    expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
    expect(texts(tree)).not.toContain(en.store.retry)
  })
})

// A list that answers ends the checks of the wallet that read it, and only that wallet's, since each
// wallet's credits are its own.
test('a check of one wallet survives another wallet reading its credits on the same domain', async () => {
  let tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [delivered]
  double.control.scriptBuy(bought)
  reads = [[], 'down']
  ledger = 'down'
  await press(tree, en.store.buyName!)
  expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
  mockWallet = 'w_b'
  ledger = [credit()]
  tree = await restart(tree)
  await type(tree, 'bobbby')
  await press(tree, en.receive.lnUseName!)
  expect(sparkRegisterLnAddress).toHaveBeenCalledWith('bobbby', undefined, 'w_b')
  mockWallet = 'w_a'
  ledger = 'down'
  tree = await restart(tree)
  expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
})

// A purchase that needs support blocks new charges, never a credit already paid. The recovery card's
// Choose a name opens this sheet for such a credit, so the credit is reachable here.
test('a purchase that needs support still offers the credit the wallet holds, and sells nothing new', async () => {
  ledger = [credit()]
  const onRegistered = jest.fn()
  let tree = await render(onRegistered)
  await type(tree, 'abcd')
  answers['/api/store/order'] = [order('abcd', 'name_four')]
  answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
  double.control.scriptBuy(() => {
    const purchase = applePurchase({ productIds: ['name_four'] })
    double.control.state.open.push(purchase)
    return { status: 'purchased', code: null, subCode: null, message: null, purchase }
  })
  await press(tree, en.store.buyName!)
  tree = await restart(tree, onRegistered)
  expect(texts(tree)).toContain(en.store.support)
  expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
  await type(tree, 'bob')
  expect(texts(tree)).toContain(copy(en.store.notCovered!, { length: en.store.lengthStandard! }))
  expect(texts(tree)).not.toContain(copy(en.store.namePrice!, { name: 'bob', price: 'US$ 99.99' }))
  expect(button(tree, en.store.buyName!)).toBeUndefined()
  expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
  await type(tree, 'alice1')
  expect(texts(tree)).toContain(en.store.covered)
  expect(texts(tree)).toContain(en.receive.lnAvailable)
  await press(tree, en.receive.lnUseName!)
  expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
  expect(double.control.state.calls.buy).toHaveLength(1)
})

test('the support mail carries the purchase reference', async () => {
  const tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
  double.control.scriptBuy(bought)
  await press(tree, en.store.buyName!)
  expect(texts(tree)).toContain(en.store.support)
  await press(tree, en.recover.sendToSupport!)
  const url = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0]![0])
  expect(url).toContain(REF)
  expect(url).toContain(PUBKEY)
  // A mail app can open and still send nothing, as a Gmail signed in to no account does.
  expectMailFallback(tree, mailBody(jest.mocked(Linking.openURL).mock.calls[0]![0]), 'opened')
})

test('a support mail that does not open leaves the address, the mail text and Copy', async () => {
  const open = jest.mocked(Linking.openURL).mockClear().mockRejectedValue(new Error('no mail app'))
  const tree = await render()
  await type(tree, 'alice1')
  answers['/api/store/order'] = [order('alice1')]
  answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
  double.control.scriptBuy(bought)
  await press(tree, en.store.buyName!)
  expectNoMailFallback(tree)
  await press(tree, en.recover.sendToSupport!)
  const body = mailBody(open.mock.calls[0]?.[0])
  expect(body).toContain(REF)
  expectMailFallback(tree, body)
  expect(await pressCopy(tree)).toBe(body)
})

test('a finishing name is done once the gateway spends the credit reserved for it', async () => {
  ledger = [credit()]
  const tree = await render()
  await type(tree, 'alice1')
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
  reads = [[credit()], [credit({ state: 'reserved', name: 'alice1' })]]
  await press(tree, en.receive.lnUseName!)
  expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
  jest.mocked(sparkGetLnAddress).mockRejectedValue(new Error('offline'))
  ledger = [credit({ state: 'spent', name: 'alice1' })]
  await press(tree, en.receive.lnCheckAgain!)
  expect(texts(tree)).toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
})

// The finishing view an open reads from the list carries the credits that register could spend, so a
// check after a restart still knows the register landed.
test('a finishing name read again on open is done once the gateway spends the credit', async () => {
  ledger = [credit()]
  let tree = await render()
  await type(tree, 'alice1')
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
  reads = [[credit()], [credit({ state: 'reserved', name: 'alice1' })]]
  ledger = [credit({ state: 'reserved', name: 'alice1' })]
  await press(tree, en.receive.lnUseName!)
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  tree = await render()
  expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
  jest.mocked(sparkGetLnAddress).mockRejectedValue(new Error('offline'))
  ledger = [credit({ state: 'spent', name: 'alice1' })]
  await press(tree, en.receive.lnCheckAgain!)
  expect(texts(tree)).toContain(copy(en.store.done!, { address: `alice1@${DOMAIN}` }))
})

test('a name pending on this wallet own credit reads as finishing, not as somebody else', async () => {
  ledger = [credit()]
  const tree = await render()
  await type(tree, 'alice1')
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
  reads = [[credit()], [credit({ state: 'reserved', name: 'alice1' })]]
  await press(tree, en.receive.lnUseName!)
  const shown = texts(tree)
  expect(shown).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
  expect(shown).not.toContain(en.store.otherPending)
})

// The invariant in docs/store-bridge.md, for the sheet. What it shows once an order's outcome arrives
// is what it shows again after the sheet closes and opens and after a restart. The rows come from the
// code's own sets, so a code added to FINAL_REFUSALS or DEFECT_REFUSALS is covered here unedited.
describe('what the sheet shows again', () => {
  type Tree = ReactTestRenderer.ReactTestRenderer
  type Row = { kind: string; label: string; reach: (tree: Tree) => Promise<void>; shows: (tree: Tree) => void }
  const CLASSES = [
    'delivered',
    'refused',
    'support',
    'unknownOrder',
    'finishing',
    'waiting',
    'unreachable',
    'failed',
    'checking',
    'unread',
  ]

  // Nothing on screen opens the store or spends a credit.
  function noBuy(tree: Tree): void {
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
  }

  async function buyAlice(tree: Tree, reply: Reply, buy: () => NativeBuyResult = boughtOnApple): Promise<void> {
    await type(tree, 'alice1')
    answers['/api/store/order'] = [order('alice1')]
    answers['/api/store/confirm'] = [reply]
    double.control.scriptBuy(buy)
    await press(tree, en.store.buyName!)
  }
  function boughtOnApple(): NativeBuyResult {
    const purchase = applePurchase()
    double.control.state.open.push(purchase)
    return { status: 'purchased', code: null, subCode: null, message: null, purchase }
  }
  const asked = (): NativeBuyResult => ({ status: 'pending', code: null, subCode: null, message: null, purchase: null })

  const waits = (tree: Tree): void => {
    const shown = texts(tree)
    expect(shown).toContain(en.store.waitingTitle)
    expect(shown).toContain(copy(en.store.waitingBody!, { name: 'alice1' }))
    expect(button(tree, en.store.stopWaiting!)).toBeDefined()
    noBuy(tree)
  }
  const needsSupport = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.support)
    expect(texts(tree)).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    noBuy(tree)
  }

  const ROWS: Row[] = [
    ...[...FINAL_REFUSALS].map((refusal): Row => {
      const [status, code] = refusal.split(' ')
      return {
        kind: 'refused',
        label: refusal,
        reach: tree => buyAlice(tree, { status: Number(status), body: { error: code } }),
        shows: tree => {
          expect(texts(tree)).toContain(en.store.refusedTitle)
          expect(texts(tree)).toContain(refusedLine(refusal, 'apple'))
          noBuy(tree)
        },
      }
    }),
    ...[...DEFECT_REFUSALS].map(
      (code): Row => ({
        kind: 'support',
        label: `409 ${code}`,
        reach: tree => buyAlice(tree, { status: 409, body: { error: code } }),
        shows: needsSupport,
      }),
    ),
    {
      kind: 'support',
      label: 'a purchase that came back without the reference',
      reach: tree =>
        buyAlice(tree, delivered, () => {
          const purchase = applePurchase({ reference: null })
          double.control.state.open.push(purchase)
          return { status: 'purchased', code: null, subCode: null, message: null, purchase }
        }),
      shows: needsSupport,
    },
    {
      kind: 'unknownOrder',
      label: '409 unknown_order',
      reach: tree => buyAlice(tree, { status: 409, body: { error: 'unknown_order' } }),
      shows: needsSupport,
    },
    { kind: 'waiting', label: 'an Ask to Buy', reach: tree => buyAlice(tree, delivered, asked), shows: waits },
    {
      kind: 'waiting',
      label: 'a paid purchase the gateway answers 429',
      reach: tree => buyAlice(tree, { status: 429, body: { error: 'too many requests' } }),
      shows: waits,
    },
    {
      kind: 'unreachable',
      label: 'a paid purchase answered by the edge in front of the gateway',
      reach: tree => buyAlice(tree, { status: 403, body: '<html>Attention Required</html>' }),
      shows: waits,
    },
    {
      kind: 'failed',
      label: 'a store that cannot be reached before paying',
      reach: tree =>
        buyAlice(tree, delivered, () => ({ status: 'failed', code: 'networkError', subCode: null, message: null, purchase: null })),
      shows: tree => {
        expect(texts(tree)).not.toContain(en.store.waitingTitle)
        expect(texts(tree)).not.toContain(en.store.support)
        expect(button(tree, en.store.buyName!)).toBeDefined()
      },
    },
    {
      kind: 'finishing',
      label: 'a register whose credit is reserved for the name',
      reach: async tree => {
        await type(tree, 'alice1')
        jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
        // The sheet opened with no credit, so the press reads the one just bought and spends it.
        reads = [[credit()]]
        ledger = [credit({ state: 'reserved', name: 'alice1' })]
        await press(tree, en.store.buyName!)
      },
      shows: tree => {
        expect(texts(tree)).toContain(copy(en.store.ownPending!, { name: 'alice1' }))
        noBuy(tree)
      },
    },
    // The rows below leave the list unreadable through the reopen and the restart, which is when a
    // check has to come back from the book.
    {
      kind: 'checking',
      label: 'a register whose answer was lost',
      reach: async tree => {
        await type(tree, 'alice1')
        jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(dropped())
        reads = [[credit()]]
        ledger = 'down'
        await press(tree, en.store.buyName!)
      },
      shows: tree => {
        expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
        noBuy(tree)
      },
    },
    {
      kind: 'checking',
      label: 'a name the gateway calls pending',
      reach: async tree => {
        await type(tree, 'alice1')
        jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
        reads = [[credit()]]
        ledger = 'down'
        await press(tree, en.store.buyName!)
      },
      shows: tree => {
        expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
        noBuy(tree)
      },
    },
    {
      kind: 'checking',
      label: 'a credit delivered while the list cannot be read',
      reach: async tree => {
        reads = [[], 'down']
        ledger = 'down'
        await buyAlice(tree, delivered)
      },
      shows: tree => {
        expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
        expect(texts(tree)).not.toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
        noBuy(tree)
      },
    },
    {
      kind: 'checking',
      label: 'a wait the store lets go while the list cannot be read',
      reach: async tree => {
        await buyAlice(tree, { status: 429, body: { error: 'too many requests' } })
        double.control.state.open = []
        ledger = 'down'
        await press(tree, en.receive.lnCheckAgain!)
      },
      shows: tree => {
        expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
        expect(texts(tree)).not.toContain(en.store.waitingTitle)
        noBuy(tree)
      },
    },
    {
      kind: 'unread',
      label: 'a list that cannot be read when Buy is pressed',
      reach: async tree => {
        await type(tree, 'alice1')
        ledger = 'down'
        await press(tree, en.store.buyName!)
      },
      shows: tree => {
        expect(texts(tree)).toContain(en.store.unread)
        noBuy(tree)
      },
    },
    {
      kind: 'delivered',
      label: 'an approval delivered while the sheet is closed',
      reach: async tree => {
        await buyAlice(tree, delivered, asked)
        await ReactTestRenderer.act(async () => {
          tree.update(sheet(false, jest.fn()))
        })
        double.control.state.open = [applePurchase()]
        answers['/api/store/confirm'] = [delivered]
        ledger = [credit()]
        await ReactTestRenderer.act(async () => {
          await syncStorePurchases(liveStoreContext())
        })
        await ReactTestRenderer.act(async () => {
          tree.update(sheet(true, jest.fn()))
        })
        await settle()
      },
      // The credit is offered, for the name still typed or for any name of its length.
      shows: tree => {
        const shown = texts(tree)
        const offered = [en.store.covered, copy(en.store.creditReady!, { length: en.store.lengthStandard! })]
        expect(offered.some(line => shown.includes(line!))).toBe(true)
        expect(shown).not.toContain(en.store.waitingTitle)
        expect(button(tree, en.store.buyName!)).toBeUndefined()
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
    const onRegistered = jest.fn()
    let tree = await render(onRegistered)
    await row.reach(tree)
    row.shows(tree)
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false, onRegistered))
    })
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true, onRegistered))
    })
    await settle()
    row.shows(tree)
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    tree = await render(onRegistered)
    row.shows(tree)
    // A paid order still out of the person's hands opens the store for no other name either.
    if (row.kind !== 'failed' && row.kind !== 'delivered') {
      await type(tree, 'carol1')
      noBuy(tree)
    }
    expect(double.control.state.calls.buy.length).toBeLessThanOrEqual(1)
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
  })

  test('the support mail still carries the purchase reference after a restart', async () => {
    let tree = await render()
    await buyAlice(tree, { status: 409, body: { error: [...DEFECT_REFUSALS][0] } })
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    tree = await render()
    await press(tree, en.recover.sendToSupport!)
    const url = decodeURIComponent(jest.mocked(Linking.openURL).mock.calls[0]![0])
    expect(url).toContain(REF)
    expect(url).toContain(PUBKEY)
  })

  test('closing a refusal is the end of it, and the offer comes back', async () => {
    const onClose = jest.fn()
    const tree = await render()
    await buyAlice(tree, { status: 409, body: { error: 'refused' } })
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true, jest.fn(), onClose))
    })
    await press(tree, en.common.close!)
    expect(onClose).toHaveBeenCalled()
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(false, jest.fn(), onClose))
    })
    await ReactTestRenderer.act(async () => {
      tree.update(sheet(true, jest.fn(), onClose))
    })
    await settle()
    expect(texts(tree)).not.toContain(en.store.refusedTitle)
    await type(tree, 'carol1')
    expect(button(tree, en.store.buyName!)).toBeDefined()
  })

  // An answer the sync writes while the offer is up takes the offer's place at once, so a support case
  // stops a second charge before any press.
  test('a purchase the sync settles as support while the offer is up takes the offer at once', async () => {
    const tree = await render()
    await buyAlice(tree, { status: 429, body: { error: 'too many requests' } })
    await press(tree, en.store.stopWaiting!)
    await type(tree, 'carol1')
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
    await ReactTestRenderer.act(async () => {
      await syncStorePurchases({ ...liveStoreContext(), now: () => Date.now() + 10 * 3600_000 })
    })
    await settle()
    needsSupport(tree)
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(calls).not.toContain('/api/store/order carol1')
    expect(double.control.state.calls.buy).toHaveLength(1)
  })

  // A wait whose purchase the store no longer lists gives way to what else the book keeps, never to
  // the offer while another order needs support.
  test('a wait that is gone on a check shows the next kept order', async () => {
    const tree = await render()
    await type(tree, 'bob123')
    answers['/api/store/order'] = [
      {
        status: 200,
        body: { reference: REF_B, productId: 'name_standard', state: 'held', kind: 'name', subject: 'bob123', appAccountToken: REF_B },
      },
    ]
    answers['/api/store/confirm'] = [{ status: 429, body: { error: 'too many requests' } }]
    const other = applePurchase({ reference: REF_B.toUpperCase(), key: 'tx-2' })
    double.control.scriptBuy(() => {
      double.control.state.open.push(other)
      return { status: 'purchased', code: null, subCode: null, message: null, purchase: other }
    })
    await press(tree, en.store.buyName!)
    await press(tree, en.store.stopWaiting!)
    await buyAlice(tree, { status: 429, body: { error: 'too many requests' } })
    waits(tree)
    // The store stops listing alice1's purchase, and a later sync hears that bob123's needs support.
    double.control.state.open = [other]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
    await ReactTestRenderer.act(async () => {
      await syncStorePurchases({ ...liveStoreContext(), now: () => Date.now() + 10 * 3600_000 })
    })
    await press(tree, en.receive.lnCheckAgain!)
    needsSupport(tree)
  })

  // Stop waiting on a paid purchase the gateway has not confirmed leaves nothing that sends the next
  // Buy back to that wait.
  test('after Stop waiting another name opens the store once', async () => {
    const tree = await render()
    await buyAlice(tree, { status: 429, body: { error: 'too many requests' } })
    waits(tree)
    await press(tree, en.store.stopWaiting!)
    await type(tree, 'carol1')
    answers['/api/store/order'] = [
      {
        status: 200,
        body: { reference: REF_B, productId: 'name_standard', state: 'held', kind: 'name', subject: 'carol1', appAccountToken: REF_B },
      },
    ]
    double.control.scriptBuy(asked)
    await press(tree, en.store.buyName!)
    expect(double.control.state.calls.buy).toEqual([
      { productId: 'name_standard', reference: REF, accountId: null },
      { productId: 'name_standard', reference: REF_B, accountId: null },
    ])
    expect(texts(tree)).toContain(copy(en.store.waitingBody!, { name: 'carol1' }))
  })
})

// The table in docs/store-bridge.md, "Worked examples", for this sheet.
// Rows are what the book keeps, columns the state of the credits read, and each cell is driven after
// a reopen and after a restart.
describe('what the sheet shows while the credits read is out', () => {
  type Tree = ReactTestRenderer.ReactTestRenderer
  type Read = 'in flight' | 'failed' | 'answered'
  const READS: Read[] = ['in flight', 'failed', 'answered']
  const MODE = { 'in flight': 'hold', failed: 'reject', answered: 'answer' } as const
  const KEPT = ['nothing', 'check', 'wait', 'support', 'refusal', 'delivered']
  type Row = { kept: string; reach: (tree: Tree) => Promise<void>; list: StoreCredit[]; shows: Record<Read, (tree: Tree) => void> }

  const alicePrice = copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' })
  function noBuy(tree: Tree): void {
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
    expect(texts(tree)).not.toContain(alicePrice)
    expect(texts(tree)).not.toContain(en.receive.lnAvailable)
  }
  const skeleton = (tree: Tree): void => {
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(texts(tree)).not.toContain(en.store.unread)
    noBuy(tree)
  }
  const unread = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.unread)
    expect(button(tree, en.receive.lnCheckAgain!)).toBeDefined()
    noBuy(tree)
  }
  const offer = (tree: Tree): void => {
    expect(texts(tree)).toContain(alicePrice)
    expect(button(tree, en.store.buyName!)!.props.disabled).toBe(false)
  }
  const checking = (tree: Tree): void => {
    expect(texts(tree)).toContain(copy(en.store.checkingPaid!, { name: 'alice1' }))
    expect(button(tree, en.receive.lnCheckAgain!)).toBeDefined()
    noBuy(tree)
  }
  const creditOffered = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.covered)
    expect(button(tree, en.receive.lnUseName!)).toBeDefined()
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  }
  const waits = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.waitingTitle)
    expect(button(tree, en.store.stopWaiting!)).toBeDefined()
    noBuy(tree)
  }
  const needsSupport = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.support)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    noBuy(tree)
  }
  const refused = (tree: Tree): void => {
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(button(tree, en.common.close!)).toBeDefined()
    noBuy(tree)
  }
  const every = (shows: (tree: Tree) => void): Record<Read, (tree: Tree) => void> => ({
    'in flight': shows,
    failed: shows,
    answered: shows,
  })

  async function buyAlice(tree: Tree, reply: Reply, buy: () => NativeBuyResult = bought): Promise<void> {
    await type(tree, 'alice1')
    answers['/api/store/order'] = [order('alice1')]
    answers['/api/store/confirm'] = [reply]
    double.control.scriptBuy(buy)
    await press(tree, en.store.buyName!)
  }

  const ROWS: Row[] = [
    { kept: 'nothing', reach: tree => type(tree, 'alice1'), list: [], shows: { 'in flight': skeleton, failed: unread, answered: offer } },
    {
      kept: 'check',
      reach: async tree => {
        reads = [[], 'down']
        ledger = 'down'
        await buyAlice(tree, delivered)
      },
      list: [credit()],
      // The list's answer ends the check, and the credit it shows goes on to the name.
      shows: { 'in flight': checking, failed: checking, answered: creditOffered },
    },
    { kept: 'wait', reach: tree => buyAlice(tree, delivered, askToBuy), list: [], shows: every(waits) },
    { kept: 'support', reach: tree => buyAlice(tree, { status: 409, body: { error: 'wrong_bundle' } }), list: [], shows: every(needsSupport) },
    { kept: 'refusal', reach: tree => buyAlice(tree, { status: 409, body: { error: 'refused' } }), list: [], shows: every(refused) },
    {
      kept: 'delivered',
      // A name's delivery is its credit, which the gateway's list keeps and the book does not.
      reach: async tree => {
        await buyAlice(tree, delivered, askToBuy)
        await ReactTestRenderer.act(async () => {
          tree.update(sheet(false, jest.fn()))
        })
        double.control.state.open = [applePurchase()]
        answers['/api/store/confirm'] = [delivered]
        ledger = [credit()]
        await ReactTestRenderer.act(async () => {
          await syncStorePurchases(liveStoreContext())
        })
      },
      list: [credit()],
      shows: { 'in flight': skeleton, failed: unread, answered: creditOffered },
    },
  ]

  test('the table holds every row the book can keep', () => {
    expect(ROWS.map(row => row.kept)).toEqual(KEPT)
  })

  test.each(ROWS.flatMap(row => READS.map(read => [row.kept, read, row] as const)))('%s kept, read %s', async (_kept, read, row) => {
    let tree = await render()
    await row.reach(tree)
    ledger = row.list
    creditsRead = MODE[read]
    await reopen(tree)
    row.shows[read](tree)
    tree = await restart(tree)
    await type(tree, 'alice1')
    row.shows[read](tree)
    expect(double.control.state.calls.buy.length).toBeLessThanOrEqual(1)
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
  })

  // A press changes the view while the open's read is out, and the read's late answer leaves it.
  test('a late answer never takes the place of what a press put on screen', async () => {
    const tree = await render()
    await buyAlice(tree, delivered, askToBuy)
    creditsRead = 'hold'
    await reopen(tree)
    waits(tree)
    creditsRead = 'answer'
    await press(tree, en.store.stopWaiting!)
    expect(button(tree, en.store.buyName!)).toBeDefined()
    await ReactTestRenderer.act(async () => {
      releases.splice(0).forEach(release => release())
    })
    await settle()
    expect(texts(tree)).not.toContain(en.store.waitingTitle)
    expect(button(tree, en.store.buyName!)).toBeDefined()
  })

  // A list read on an earlier open says nothing of what the wallet holds now.
  test('a support case reopened while the credits fail offers no credit from an earlier read', async () => {
    ledger = [credit()]
    const tree = await render()
    await type(tree, 'abcd')
    answers['/api/store/order'] = [order('abcd', 'name_four')]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
    double.control.scriptBuy(() => {
      const purchase = applePurchase({ productIds: ['name_four'] })
      double.control.state.open.push(purchase)
      return { status: 'purchased', code: null, subCode: null, message: null, purchase }
    })
    await press(tree, en.store.buyName!)
    await type(tree, 'alice1')
    expect(button(tree, en.receive.lnUseName!)).toBeDefined()
    creditsRead = 'reject'
    await reopen(tree)
    needsSupport(tree)
  })

  // A name a failed read left open comes before a kept order, since the check is what says whether
  // the name is already paid for.
  test('a check comes before an order of another name the book keeps', async () => {
    const tree = await render()
    await type(tree, 'bob123')
    answers['/api/store/order'] = [order('bob123')]
    double.control.scriptBuy(askToBuy)
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(copy(en.store.waitingBody!, { name: 'bob123' }))
    await keepNameCheck({ domain: DOMAIN, name: 'alice1', after: 'delivered', attempt: [] })
    creditsRead = 'hold'
    await reopen(tree)
    checking(tree)
    expect(texts(tree)).not.toContain(en.store.waitingTitle)
  })

  // A name on the customer's own domain costs nothing, so a read still out stops nothing there.
  test('a domain whose names are free offers the name while the credits are still out', async () => {
    creditsRead = 'hold'
    let tree!: Tree
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} namesFree onClose={jest.fn()} onRegistered={jest.fn()} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(texts(tree)).toContain(en.receive.lnAvailable)
    expect(button(tree, en.receive.lnUseName!)).toBeDefined()
  })
})

// The root's sync can settle an order the gateway is handing back to a Buy, after which the store no
// longer lists its purchase and opening it again would take a second payment. The store stays shut,
// and the sheet reads what the sync settled.
describe('an order the sync settles while Buy waits on the gateway', () => {
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`

  beforeEach(async () => {
    // Left with Stop waiting while the store still lists its purchase.
    const book = { orders: { [REF]: 'w_a' }, about: { [REF]: { kind: 'name', place: DOMAIN, subject: 'alice1' } } }
    await RNFS.writeFile(BOOK_FILE, JSON.stringify(book), 'utf8')
    double.control.state.open = [applePurchase()]
  })

  async function buyWhileSyncDelivers(tree: ReactTestRenderer.ReactTestRenderer, after: Ledger): Promise<void> {
    let answer!: () => void
    answers['/api/store/order'] = [new Promise<Reply>(resolve => (answer = () => resolve(order('alice1'))))]
    answers['/api/store/confirm'] = [delivered]
    await ReactTestRenderer.act(async () => {
      button(tree, en.store.buyName!)!.props.onPress()
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      await syncStorePurchases(liveStoreContext())
    })
    ledger = after
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
  }

  test('spends the credit the sync delivered, and the store never opens', async () => {
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    await buyWhileSyncDelivers(tree, [credit()])
    expect(double.control.state.calls.buy).toEqual([])
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
  })

  test('checks when the credits cannot be read, and Check again spends it', async () => {
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    await buyWhileSyncDelivers(tree, 'down')
    expect(double.control.state.calls.buy).toEqual([])
    expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    ledger = [credit()]
    await press(tree, en.receive.lnCheckAgain!)
    expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
    expect(double.control.state.calls.buy).toEqual([])
  })
})

// A name another wallet's credit blocks, or another wallet holds while it pays, clears on its own,
// and the gateway answers when (`retry_at`). The sheet says when, keeps the offer, and the next press
// is the person's, however soon the name clears.
describe('a refusal that clears on its own', () => {
  const nowSecs = (): number => Math.floor(Date.now() / 1000)
  const heldOrder = (at: number): Reply => ({ status: 409, body: { error: 'name_held_for_credit', retry_at: at } })
  const heldRegister = (at: number, code = 'held_by_another_wallet'): Error =>
    Object.assign(new Error('SdkError.NetworkError'), {
      tag: 'NetworkError',
      inner: [`network request failed with status 409: {"error":"${code}","retry_at":${at}}`],
    })
  // The time the line names, with the date when it is not today.
  const at = (seconds: number): string => {
    const prefs = deviceDateTimePrefs()
    const today = new Date(seconds * 1000).toDateString() === new Date().toDateString()
    return today ? formatTime(seconds, prefs) : `${formatDate(seconds, prefs)} ${formatTime(seconds, prefs)}`
  }
  const orders = (): string[] => calls.filter(c => c.startsWith('/api/store/order'))
  // Two seconds on, past a second the gateway named between one and two seconds away. Each test waits
  // that long in real time, so each takes a timeout of its own.
  const soon = (): number => nowSecs() + 2
  const pastIt = (): Promise<void> => settle(2_300)

  test('further away, says when to try again and keeps the offer, with no retry', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    const clears = nowSecs() + 2 * 60 * 60
    answers['/api/store/order'] = [heldOrder(clears)]
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
    expect(button(tree, en.store.buyName!)).toBeDefined()
    expect(orders()).toHaveLength(1)
    // A day away the line names the date too.
    const tomorrow = nowSecs() + 26 * 60 * 60
    answers['/api/store/order'] = [heldOrder(tomorrow)]
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(copy(en.store.heldTryLater!, { name: 'alice1', time: at(tomorrow) }))
    expect(at(tomorrow)).toContain(formatDate(tomorrow, deviceDateTimePrefs()))
    await pastIt()
    expect(orders()).toHaveLength(2)
  }, 15_000)

  // The line names a time that passes, and a closed sheet waits on nothing. Opened again, the sheet
  // reads the name afresh rather than repeating a line about an earlier press.
  test('a line about a hold does not survive closing and opening the sheet', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    const clears = nowSecs() + 2 * 60 * 60
    answers['/api/store/order'] = [heldOrder(clears)]
    await press(tree, en.store.buyName!)
    const line = copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) })
    expect(texts(tree)).toContain(line)

    await reopen(tree)
    expect(texts(tree)).not.toContain(line)
    expect(button(tree, en.store.buyName!)).toBeDefined()
  })

  // A name that costs nothing is registered directly, and a register refused while another wallet
  // holds the name says when, as a spend's refusal does, rather than the general failure.
  test('a free name whose register is held says when', async () => {
    const onRegistered = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} namesFree onClose={jest.fn()} onRegistered={onRegistered} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    const clears = nowSecs() + 2 * 60 * 60
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(heldRegister(clears))
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
    expect(texts(tree)).not.toContain(en.receive.lnFailed)
    expect(onRegistered).not.toHaveBeenCalled()
  })

  // An exit's hold refuses the register in spark.ts before the SDK is asked, on the wallet in front, and
  // says so with the Receive lines rather than the address failing.
  test.each([
    ['exit', 'receiveHeld'],
    ['unread', 'receiveHeldUnread'],
  ] as const)('a free name whose register an exit holds (%s) says why', async (hold, key) => {
    const onRegistered = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <LnAddressSheet visible domain={DOMAIN} namesFree onClose={jest.fn()} onRegistered={onRegistered} />,
      )
    })
    await settle()
    await type(tree, 'alice1')
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(new ReceiveHeldByExit(hold))
    await press(tree, en.receive.lnUseName!)
    expect(texts(tree)).toContain(en.emergencyExit[key])
    expect(texts(tree)).not.toContain(en.receive.lnFailed)
    expect(onRegistered).not.toHaveBeenCalled()
  })

  test('a name the order calls free whose register an exit holds says why', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    answers['/api/store/order'] = [{ status: 409, body: { error: 'free_name' } }]
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(new ReceiveHeldByExit('exit'))
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(en.emergencyExit.receiveHeld)
    expect(texts(tree)).not.toContain(en.receive.lnFailed)
    expect(double.control.state.calls.buy).toEqual([])
  })

  test('a name the order calls free whose register is held says when', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    const clears = nowSecs() + 2 * 60 * 60
    answers['/api/store/order'] = [{ status: 409, body: { error: 'free_name' } }]
    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(heldRegister(clears, 'reservation_barred'))
    await press(tree, en.store.buyName!)
    expect(texts(tree)).toContain(copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
    expect(texts(tree)).not.toContain(en.receive.lnFailed)
    expect(double.control.state.calls.buy).toEqual([])
  })

  // The refusal answers a press made for the name typed then, and lands after another was typed.
  test('a refusal that lands after another name was typed says when, and waits for nothing', async () => {
    const tree = await render()
    await type(tree, 'alice1')
    const clears = soon()
    let answer!: () => void
    answers['/api/store/order'] = [new Promise<Reply>(resolve => (answer = () => resolve(heldOrder(clears)))), order('alice1')]
    double.control.scriptBuy(askToBuy)
    await ReactTestRenderer.act(async () => {
      button(tree, en.store.buyName!)!.props.onPress()
    })
    await settle()
    await type(tree, 'bobby1')
    await ReactTestRenderer.act(async () => {
      answer()
    })
    await settle()
    expect(texts(tree)).toContain(copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
    await pastIt()
    expect(orders()).toEqual(['/api/store/order alice1'])
    expect(double.control.state.calls.buy).toEqual([])
  }, 15_000)

  // A hold lasts 10 to 30 minutes. Time runs on fake timers here, which also move with the real clock,
  // so a request the sheet scheduled for itself would leave as the clock passes the second it named.
  describe("and the next press is the person's", () => {
    let loadSpy: jest.SpyInstance
    const traced: jest.SpyInstance[] = []

    beforeEach(() => {
      jest.useFakeTimers({ advanceTimers: true, doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] })
      loadSpy = jest.spyOn(double.default, 'loadProducts')
    })

    afterEach(() => {
      loadSpy.mockRestore()
      traced.splice(0).forEach(spy => spy.mockRestore())
      jest.useRealTimers()
    })

    type Press = 'buy' | 'use'
    const label = (kind: Press): string => (kind === 'buy' ? en.store.buyName! : en.receive.lnUseName!)
    const credits = (): number => calls.filter(c => c.startsWith('/api/store/credits')).length

    async function wait(ms: number): Promise<void> {
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(ms)
      })
      await settle()
    }

    // Every mock the sheet can reach, as a count of its calls: the gateway, the store, the SDK, the
    // wallet registry, the sats routes and the support mail.
    function sent(): Record<string, number> {
      const counts: Record<string, number> = {
        fetch: jest.mocked(global.fetch).mock.calls.length,
        loadProducts: loadSpy.mock.calls.length,
        buy: double.control.state.calls.buy.length,
        openPurchases: double.control.state.calls.openPurchases,
        finish: double.control.state.calls.finish.length,
        takeQueued: double.control.state.calls.takeQueued,
        openURL: jest.mocked(Linking.openURL).mock.calls.length,
      }
      for (const name of ['../src/wallet/spark', '../src/wallet/namePurchase', '../src/wallet/walletRegistry']) {
        for (const [key, value] of Object.entries(jest.requireMock(name) as Record<string, unknown>)) {
          if (jest.isMockFunction(value)) {
            counts[`${name} ${key}`] = value.mock.calls.length
          }
        }
      }
      return counts
    }

    // A press on alice1 refused with `code` until `clears`. A Buy meets it at the order, and a Use this
    // name, with a credit that covers the name, at the register.
    async function heldPress(kind: Press, code: string, clears: number, onRegistered = jest.fn()) {
      if (kind === 'use') {
        ledger = [credit()]
      }
      const tree = await render(onRegistered)
      await type(tree, 'alice1')
      if (kind === 'buy') {
        answers['/api/store/order'] = [{ status: 409, body: { error: code, retry_at: clears } }]
      } else {
        jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(heldRegister(clears, code))
      }
      await press(tree, label(kind))
      return tree
    }

    function offered(tree: ReactTestRenderer.ReactTestRenderer, kind: Press, line: string): void {
      expect(texts(tree)).toContain(line)
      expect(button(tree, label(kind))?.props.disabled).toBe(false)
      expect(button(tree, label(kind))?.props.loading).toBe(false)
    }

    test.each([
      ['an order held for a credit', 'buy', 'name_held_for_credit'],
      ['a register held by another wallet', 'use', 'held_by_another_wallet'],
      ['a register barred from reserving', 'use', 'reservation_barred'],
    ] as const)('%s a minute away says when, keeps the offer and sends nothing until a press', async (_, kind, code) => {
      const onRegistered = jest.fn()
      const clears = nowSecs() + 60
      const tree = await heldPress(kind, code, clears, onRegistered)
      const line = copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) })
      offered(tree, kind, line)
      const before = sent()
      // Past the second the gateway named, then past the longest hold.
      await wait(61_000)
      expect(sent()).toEqual(before)
      offered(tree, kind, line)
      await wait(31 * 60_000)
      expect(sent()).toEqual(before)
      offered(tree, kind, line)
      expect(onRegistered).not.toHaveBeenCalled()
    })

    test('a hold a minute away that ends tomorrow names the date', async () => {
      jest.setSystemTime(new Date(2026, 9, 19, 23, 59, 30))
      const clears = nowSecs() + 60
      const tree = await heldPress('buy', 'name_held_for_credit', clears)
      expect(at(clears)).toContain(formatDate(clears, deviceDateTimePrefs()))
      offered(tree, 'buy', copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
    })

    // One log in the order things left: the gateway's routes, the store's calls and the SDK's.
    function trace(): void {
      jest.mocked(sparkGetIdentityPubkey).mockImplementation(async () => {
        calls.push('sdk identity')
        return PUBKEY
      })
      jest.mocked(sparkGetLnAddress).mockImplementation(async () => {
        calls.push('sdk address')
        return null
      })
      jest.mocked(sparkCheckLnAddress).mockImplementation(async (name: string) => {
        calls.push(`sdk check ${name}`)
        return true
      })
      jest.mocked(sparkRegisterLnAddress).mockImplementation(async (name: string) => {
        calls.push(`sdk register ${name}`)
        return address(name)
      })
      for (const method of ['buy', 'openPurchases'] as const) {
        const real = (double.default[method] as (...args: unknown[]) => Promise<unknown>).bind(double.default)
        traced.push(
          jest.spyOn(double.default, method).mockImplementation((async (...args: unknown[]) => {
            calls.push(`store ${method}`)
            return real(...args)
          }) as never),
        )
      }
    }

    // What one press on alice1 sends, read from the log, with the order answered and the store's sheet
    // left pending, or the register landing.
    async function pressOnce(tree: ReactTestRenderer.ReactTestRenderer, kind: Press): Promise<string[]> {
      const from = calls.length
      answers['/api/store/order'] = [order('alice1')]
      double.control.scriptBuy(askToBuy)
      await press(tree, label(kind))
      return calls.slice(from)
    }

    test.each(['buy', 'use'] as const)('a %s pressed once the name clears sends what a first press sends', async kind => {
      trace()
      const onRegistered = jest.fn()
      const clears = nowSecs() + 60
      const code = kind === 'buy' ? 'name_held_for_credit' : 'held_by_another_wallet'
      const held = await heldPress(kind, code, clears, onRegistered)
      const quiet = calls.length
      await wait(61_000)
      expect(calls.length).toBe(quiet)
      const after = await pressOnce(held, kind)
      expect(after).toContain('/api/store/credits')
      // A fresh sheet on a fresh book, the same credits, and the same press.
      await ReactTestRenderer.act(async () => {
        held.unmount()
      })
      for (const file of FILES) {
        if (await RNFS.exists(file)) {
          await RNFS.unlink(file)
        }
      }
      const fresh = await render(jest.fn())
      await type(fresh, 'alice1')
      const first = await pressOnce(fresh, kind)
      expect(after).toEqual(first)
      if (kind === 'buy') {
        expect(after).toContain('store buy')
      } else {
        expect(onRegistered).toHaveBeenCalledWith(address('alice1'))
      }
    })

    // The order or the register a press waits on, held until the test answers it with a refusal that
    // clears on its own or a failure.
    function hold(kind: Press) {
      let settleWith!: (outcome: { clears: number } | 'fail') => void
      if (kind === 'buy') {
        answers['/api/store/order'] = [
          new Promise<Reply>(resolve => {
            settleWith = outcome =>
              resolve(outcome === 'fail' ? { status: 500, body: { error: 'boom' } } : heldOrder(outcome.clears))
          }),
        ]
      } else {
        jest.mocked(sparkRegisterLnAddress).mockImplementationOnce(
          () =>
            new Promise((_, reject) => {
              settleWith = outcome => reject(outcome === 'fail' ? dropped() : heldRegister(outcome.clears))
            }),
        )
      }
      return async (outcome: { clears: number } | 'fail'): Promise<void> => {
        await ReactTestRenderer.act(async () => {
          settleWith(outcome)
        })
        await settle()
      }
    }

    async function tap(tree: ReactTestRenderer.ReactTestRenderer, kind: Press): Promise<void> {
      await ReactTestRenderer.act(async () => {
        button(tree, label(kind))!.props.onPress()
      })
      await settle()
    }

    test.each(['buy', 'use'] as const)('around a hold, a %s is busy while its request is out and a failure says to try again', async kind => {
      if (kind === 'use') {
        ledger = [credit()]
      }
      const tree = await render()
      await type(tree, 'alice1')
      const clears = nowSecs() + 60
      const line = copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) })
      const refused = hold(kind)
      await tap(tree, kind)
      expect(button(tree, label(kind))?.props.loading).toBe(true)
      await refused({ clears })
      offered(tree, kind, line)
      await wait(61_000)
      const failed = hold(kind)
      await tap(tree, kind)
      expect(button(tree, label(kind))?.props.loading).toBe(true)
      expect(texts(tree)).not.toContain(line)
      await failed('fail')
      offered(tree, kind, en.store.retry!)
      expect(texts(tree)).not.toContain(line)
    })

    test('a close and a reopen offer the name from a fresh credits read, and nothing waits', async () => {
      const tree = await heldPress('buy', 'name_held_for_credit', nowSecs() + 60)
      const read = credits()
      await reopen(tree)
      expect(credits()).toBe(read + 1)
      expect(texts(tree)).toContain(copy(en.store.namePrice!, { name: 'alice1', price: 'US$ 9.99' }))
      expect(button(tree, en.store.buyName!)?.props.disabled).toBe(false)
      const before = sent()
      await wait(31 * 60_000)
      expect(sent()).toEqual(before)
    })

    // Rendered without the modal, which under Jest drops its content on close, since on iOS the
    // content stays mounted while the modal slides away.
    test('a sheet closed with its content still mounted sends nothing, and opens again on a fresh read', async () => {
      const onError = jest.fn()
      const offer = (visible: boolean) => (
        <StoreNameOffer
          visible={visible}
          name="alice1"
          available
          namesFree={false}
          taken={new Set()}
          warnBeforeChange={go => go()}
          claim={async () => undefined}
          onRegistered={jest.fn()}
          onTaken={jest.fn()}
          onError={onError}
          onTakeover={jest.fn()}
          onClose={jest.fn()}
        />
      )
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(offer(true))
      })
      await settle()
      const clears = nowSecs() + 60
      answers['/api/store/order'] = [heldOrder(clears)]
      await press(tree, en.store.buyName!)
      expect(onError).toHaveBeenLastCalledWith(copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) }))
      await ReactTestRenderer.act(async () => {
        tree.update(offer(false))
      })
      const before = sent()
      const read = credits()
      await wait(31 * 60_000)
      expect(sent()).toEqual(before)
      await ReactTestRenderer.act(async () => {
        tree.update(offer(true))
      })
      await settle()
      expect(credits()).toBe(read + 1)
      expect(button(tree, en.store.buyName!)?.props.disabled).toBe(false)
    })
  })
})

// Rule 4 in docs/store-bridge.md. A press answered by a hold, a taken name, a name pending for somebody
// else or a register that never took leaves a support case or a refusal on screen, whether the press
// was made beside the support case or the root's sync put either up while the press ran, and the
// press's line shows beside it. The next press is the person's.
describe('a press answered beside a support case or a refusal', () => {
  type Tree = ReactTestRenderer.ReactTestRenderer
  type Answer = 'held' | 'taken' | 'pending' | 'never took'
  const ANSWERS: Answer[] = ['held', 'taken', 'pending', 'never took']
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
  const clears = Math.floor(Date.now() / 1000) + 2 * 60 * 60

  // The time the hold's line names, with the date when it is not today.
  function at(seconds: number): string {
    const prefs = deviceDateTimePrefs()
    const today = new Date(seconds * 1000).toDateString() === new Date().toDateString()
    return today ? formatTime(seconds, prefs) : `${formatDate(seconds, prefs)} ${formatTime(seconds, prefs)}`
  }

  // What the register of alice1 answers. A register that never took drops its answer, and the address
  // and the credits read after it show nothing landed.
  function refusal(answer: Answer): Error {
    switch (answer) {
      case 'held':
        return Object.assign(new Error('SdkError.NetworkError'), {
          tag: 'NetworkError',
          inner: [`network request failed with status 409: {"error":"held_by_another_wallet","retry_at":${clears}}`],
        })
      case 'taken':
        return refusedWith(409, 'name_taken')
      case 'pending':
        return refusedWith(409, 'name_pending')
      case 'never took':
        return dropped()
    }
  }

  function line(answer: Answer): string {
    switch (answer) {
      case 'held':
        return copy(en.store.heldTryLater!, { name: 'alice1', time: at(clears) })
      case 'taken':
        return en.receive.lnTaken!
      case 'pending':
        return en.store.otherPending!
      case 'never took':
        return en.store.retry!
    }
  }

  function supportShown(tree: Tree): void {
    expect(texts(tree)).toContain(en.store.support)
    expect(button(tree, en.recover.sendToSupport!)).toBeDefined()
    expect(button(tree, en.store.buyName!)).toBeUndefined()
  }

  function refusalShown(tree: Tree): void {
    expect(texts(tree)).toContain(en.store.refusedTitle)
    expect(texts(tree)).toContain(refusedLine('409 refunded', 'apple'))
    expect(button(tree, en.store.buyName!)).toBeUndefined()
    expect(button(tree, en.receive.lnUseName!)).toBeUndefined()
  }

  // A name the credit covers, offered with Use this name and enabled. alice1 is taken after a taken
  // answer, so carol1, of the same length, is the name the credit still pays for.
  async function offersCredit(tree: Tree, answer: Answer): Promise<string> {
    const next = answer === 'taken' ? 'carol1' : 'alice1'
    if (next !== 'alice1') {
      await type(tree, next)
    }
    expect(texts(tree)).toContain(en.store.covered)
    expect(button(tree, en.receive.lnUseName!)?.props.disabled).toBe(false)
    expect(button(tree, en.receive.lnUseName!)?.props.loading).toBe(false)
    return next
  }

  // Nothing leaves until the person presses, and the press then spends the credit on the name without
  // opening the store again. `buys` is how many times the store opened before.
  async function nextPressIsThePersons(tree: Tree, onRegistered: jest.Mock, next: string, buys: number): Promise<void> {
    const before = calls.length
    await settle(300)
    expect(calls.length).toBe(before)
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
    expect(onRegistered).not.toHaveBeenCalled()
    await press(tree, en.receive.lnUseName!)
    expect(onRegistered).toHaveBeenCalledWith(address(next))
    expect(double.control.state.calls.buy).toHaveLength(buys)
  }

  test.each(ANSWERS)('a press from a support case answered %s keeps the support case beside the line', async answer => {
    ledger = [credit()]
    const onRegistered = jest.fn()
    const tree = await render(onRegistered)
    await type(tree, 'abcd')
    answers['/api/store/order'] = [order('abcd', 'name_four')]
    answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
    double.control.scriptBuy(() => {
      const purchase = applePurchase({ productIds: ['name_four'] })
      double.control.state.open.push(purchase)
      return { status: 'purchased', code: null, subCode: null, message: null, purchase }
    })
    await press(tree, en.store.buyName!)
    await type(tree, 'alice1')
    supportShown(tree)
    expect(texts(tree)).toContain(en.store.covered)

    jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusal(answer))
    await press(tree, en.receive.lnUseName!)
    supportShown(tree)
    expect(texts(tree)).toContain(line(answer))
    if (answer === 'taken') {
      expect(texts(tree)).toContain(copy(en.store.takenMidway!, { name: 'alice1', length: en.store.lengthStandard! }))
    }

    const next = await offersCredit(tree, answer)
    supportShown(tree)
    await nextPressIsThePersons(tree, onRegistered, next, 1)
  })

  // An order of another name the store still lists, left with Stop waiting, which the root's sync
  // settles with `verdict` while the register of alice1 is out. `shown` holds what the sync put up.
  async function syncDuringPress(
    answer: Answer,
    verdict: Reply,
    shown: (tree: Tree) => void,
    onRegistered: jest.Mock,
  ): Promise<Tree> {
    const book = { orders: { [REF]: 'w_a' }, about: { [REF]: { kind: 'name', place: DOMAIN, subject: 'carol1' } } }
    await RNFS.writeFile(BOOK_FILE, JSON.stringify(book), 'utf8')
    double.control.state.open = [applePurchase()]
    ledger = [credit()]
    const tree = await render(onRegistered)
    await type(tree, 'alice1')
    expect(texts(tree)).toContain(en.store.covered)
    let answerRegister!: () => void
    jest.mocked(sparkRegisterLnAddress).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          answerRegister = () => reject(refusal(answer))
        }),
    )
    await ReactTestRenderer.act(async () => {
      button(tree, en.receive.lnUseName!)!.props.onPress()
    })
    await settle()
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
    answers['/api/store/confirm'] = [verdict]
    await ReactTestRenderer.act(async () => {
      await syncStorePurchases(liveStoreContext())
    })
    await settle()
    shown(tree)
    await ReactTestRenderer.act(async () => {
      answerRegister()
    })
    await settle()
    return tree
  }

  test.each(ANSWERS)('a support case the sync put up while the register was out stays after it answers %s', async answer => {
    const onRegistered = jest.fn()
    const tree = await syncDuringPress(answer, { status: 409, body: { error: 'wrong_bundle' } }, supportShown, onRegistered)
    supportShown(tree)
    expect(texts(tree)).toContain(line(answer))
    const next = await offersCredit(tree, answer)
    supportShown(tree)
    await nextPressIsThePersons(tree, onRegistered, next, 0)
  })

  // The refusal takes the sheet over, and the sheet shows its error line during a takeover. The taken
  // answer's line is the sheet's availability line instead, which a takeover hides.
  test.each(ANSWERS)('a refusal the sync put up while the register was out stays after it answers %s', async answer => {
    const onRegistered = jest.fn()
    const tree = await syncDuringPress(answer, { status: 409, body: { error: 'refunded' } }, refusalShown, onRegistered)
    refusalShown(tree)
    if (answer !== 'taken') {
      expect(texts(tree)).toContain(line(answer))
    }
    const before = calls.length
    await settle(300)
    expect(calls.length).toBe(before)
    expect(sparkRegisterLnAddress).toHaveBeenCalledTimes(1)
    refusalShown(tree)
    expect(onRegistered).not.toHaveBeenCalled()
  })
})

// From any view other than a support case or a refusal the four answers bring the offer back. The
// pending one is reachable from a check, whose Check again reads the list and finds somebody else's.
test('a pending check that turns out to be somebody else gives the offer back on Check again', async () => {
  ledger = [credit()]
  const tree = await render()
  await type(tree, 'alice1')
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
  reads = [[credit()]]
  ledger = 'down'
  await press(tree, en.receive.lnUseName!)
  expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
  ledger = [credit()]
  await press(tree, en.receive.lnCheckAgain!)
  const shown = texts(tree)
  expect(shown).toContain(en.store.otherPending)
  expect(shown).not.toContain(copy(en.store.checking!, { name: 'alice1' }))
  expect(button(tree, en.receive.lnCheckAgain!)).toBeUndefined()
  expect(shown).toContain(en.store.covered)
  expect(button(tree, en.receive.lnUseName!)?.props.disabled).toBe(false)
})

// A card left by a refused support mail names the purchase it was about. Once the sheet moves on,
// here through a credit spent beside the case and an offer that a later order's support case then
// replaces, no card naming the first purchase stays beside the second.
test('a support card never names an earlier purchase beside a later one', async () => {
  const BOOK_FILE = `${RNFS.DocumentDirectoryPath}/store-orders.json`
  const about = (subject: string) => ({ kind: 'name', place: DOMAIN, subject })
  await RNFS.writeFile(BOOK_FILE, JSON.stringify({ orders: { [REF]: 'w_a' }, about: { [REF]: about('carol1') } }), 'utf8')
  double.control.state.open = [applePurchase()]
  ledger = [credit()]
  const open = jest.mocked(Linking.openURL).mockClear().mockRejectedValue(new Error('no mail app'))
  const tree = await render()
  const carried = (): string[] =>
    carriedTexts(tree)

  answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
  await ReactTestRenderer.act(async () => {
    await syncStorePurchases(liveStoreContext())
  })
  await settle()
  expect(texts(tree)).toContain(en.store.support)
  await press(tree, en.recover.sendToSupport!)
  expect(mailBody(open.mock.calls[0]?.[0])).toContain(REF)
  expect(carried()).toEqual([expect.stringContaining(REF)])
  expect(tree.root.findByType(SupportMailCard).props.raised).toBe(true)

  // The credit beside the case is spent on alice1, whose register leaves a check, and the check
  // gives the offer back.
  await type(tree, 'alice1')
  jest.mocked(sparkRegisterLnAddress).mockRejectedValueOnce(refusedWith(409, 'name_pending'))
  reads = [[credit()]]
  ledger = 'down'
  await press(tree, en.receive.lnUseName!)
  expect(texts(tree)).toContain(copy(en.store.checking!, { name: 'alice1' }))
  ledger = [credit()]
  await press(tree, en.receive.lnCheckAgain!)
  expect(texts(tree)).not.toContain(en.store.support)

  // The sync then hears that another order of this domain needs support.
  const book = JSON.parse(await RNFS.readFile(BOOK_FILE, 'utf8')) as {
    orders: Record<string, string>
    about: Record<string, unknown>
  }
  book.orders[REF_B] = 'w_a'
  book.about[REF_B] = about('bob123')
  await RNFS.writeFile(BOOK_FILE, JSON.stringify(book), 'utf8')
  double.control.state.open = [applePurchase({ reference: REF_B.toUpperCase(), key: 'tx-2' })]
  answers['/api/store/confirm'] = [{ status: 409, body: { error: 'wrong_bundle' } }]
  await ReactTestRenderer.act(async () => {
    await syncStorePurchases(liveStoreContext())
  })
  await settle()
  expect(texts(tree)).toContain(en.store.support)
  expect(carried().filter(text => text.includes(REF))).toEqual([])

  await press(tree, en.recover.sendToSupport!)
  expect(mailBody(open.mock.calls[1]?.[0])).toContain(REF_B)
  expect(carried()).toEqual([expect.stringContaining(REF_B)])
})
