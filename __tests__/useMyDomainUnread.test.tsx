import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import {
  claimDomain,
  confirmDomain,
  fetchPrices,
  loadPendingPurchase,
  quoteDomain,
} from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkPrepareSend } from '../src/wallet/spark'
import { buyInStore, keptOrderViews, onStoreSettled, storeOrderViews } from '../src/wallet/storePurchase'

// A record of a domain year paid in sats that cannot be read may stand for a payment still owed. The
// screen then sends no claim, asks no quote, opens no store order and never says nothing was charged.

const PUBKEY = `02${'a'.repeat(64)}`
const HOST = 'pay.bakery.com.br'

jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 199800, fee: 0 })),
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkGetBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

const mockDistribution = { value: 'direct' as 'direct' | 'store' }
jest.mock('../src/config', () => ({
  getBreezLnurlDomain: () => 'lnurl.usevoltz.app',
  getDistribution: () => mockDistribution.value,
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'w_a'),
}))

let mockParams: { renew?: string } | undefined
jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: mockParams }) }))

jest.mock('../src/wallet/domainOnboard', () => {
  const real = jest.requireActual('../src/wallet/domainOnboard')
  return {
    ...real,
    claimDomain: jest.fn(),
    quoteDomain: jest.fn(),
    confirmDomain: jest.fn(),
    fetchPrices: jest.fn(),
    loadPendingPurchase: jest.fn(real.loadPendingPurchase),
  }
})

// Every road to a store order, wrapped so a case can say none was taken, and the real subscription to
// the root's sync, wrapped so a case can deliver what the sync would announce.
jest.mock('../src/wallet/storePurchase', () => {
  const real = jest.requireActual('../src/wallet/storePurchase')
  return {
    ...real,
    buyInStore: jest.fn(async () => ({ kind: 'unavailable' })),
    keptOrderViews: jest.fn(async () => []),
    storeOrderViews: jest.fn(async () => []),
    onStoreSettled: jest.fn(real.onStoreSettled),
  }
})

type Double = typeof import('../specs/__mocks__/NativeVoltzStore')
const double = jest.requireMock('../specs/NativeVoltzStore') as Double

const claim = jest.mocked(claimDomain)
const quote = jest.mocked(quoteDomain)
const confirm = jest.mocked(confirmDomain)
const DOMAIN = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`
const TORN = '{"w_a": {"reference'

const realWrite = RNFS.writeFile.bind(RNFS)
const put = (path: string, text: string): Promise<void> => realWrite(path, text, 'utf8')
const raw = async (path: string): Promise<string | null> =>
  (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 5))
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  await settle()
  return tree
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!target) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

async function typeDomain(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
  })
  await settle()
}

const UNREAD = i18n.t('recover.recordUnread')
const SUPPORT = i18n.t('recover.sendToSupport')

// Nothing below the line can be pressed into a claim, a quote or an order, and no line says that
// nothing was charged or that the app finishes the payment.
function expectUnread(tree: ReactTestRenderer.ReactTestRenderer): void {
  const shown = texts(tree)
  expect(shown).toContain(UNREAD)
  expect(shown).toContain(SUPPORT)
  for (const key of [
    'useDomain.payFailed',
    'useDomain.confirmFailed',
    'useDomain.continue',
    'useDomain.pay',
    'useDomain.requote',
    'useDomain.settling',
    'receive.lnCheckAgain',
  ]) {
    expect({ key, shown: shown.includes(i18n.t(key)) }).toEqual({ key, shown: false })
  }
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  double.control.reset()
  mockParams = undefined
  mockDistribution.value = 'direct'
  jest.mocked(fetchPrices).mockResolvedValue({ domain_tier: 9990 })
  claim.mockRejectedValue(new Error('domain_tier_not_paid'))
  quote.mockResolvedValue({
    host: HOST,
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-q',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  confirm.mockResolvedValue(null)
  jest.mocked(sparkConfirmSend).mockResolvedValue('complete' as never)
})

function expectNothingSold(): void {
  expect(claim).not.toHaveBeenCalled()
  expect(quote).not.toHaveBeenCalled()
  expect(buyInStore).not.toHaveBeenCalled()
}

describe('a record that cannot be read on mount', () => {
  test.each(['direct', 'store'] as const)('takes the first-year screen on a %s build', async build => {
    mockDistribution.value = build
    await put(DOMAIN, TORN)
    const tree = await render()
    expectUnread(tree)
    expectNothingSold()
    expect(keptOrderViews).not.toHaveBeenCalled()
    expect(storeOrderViews).not.toHaveBeenCalled()
    expect(await raw(DOMAIN)).toBe(TORN)
  })

  test.each(['direct', 'store'] as const)('takes the renewal on a %s build before its claim or quote', async build => {
    mockDistribution.value = build
    mockParams = { renew: HOST }
    await put(DOMAIN, TORN)
    const tree = await render()
    expectUnread(tree)
    expectNothingSold()
  })

  test('the support press mails the wallet key and says the record could not be read', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    await put(DOMAIN, TORN)
    const tree = await render()
    await press(tree, SUPPORT)
    const url = decodeURIComponent(String(open.mock.calls[0]?.[0]))
    expect(url).toContain('mailto:support@usevoltz.app')
    expect(url).toContain(`Wallet: ${PUBKEY}`)
    expect(url).toContain(`Payment: ${i18n.t('recover.mailRecordUnread')}`)
    // A mail app can open and still send nothing, as a Gmail signed in to no account does.
    expectMailFallback(tree, mailBody(open.mock.calls[0]?.[0]), 'opened')
    open.mockRestore()
  })

  test('a mail that does not open leaves the address, the mail text and Copy', async () => {
    const open = jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no mail app'))
    await put(DOMAIN, TORN)
    const tree = await render()
    expectNoMailFallback(tree)
    await press(tree, SUPPORT)
    const body = mailBody(open.mock.calls[0]?.[0])
    expect(body).toContain(`Wallet: ${PUBKEY}`)
    expectMailFallback(tree, body)
    expect(await pressCopy(tree)).toBe(body)
    open.mockRestore()
  })
})

// A torn copy with no file is a first write that was cut, whose last finished state is no record, so
// the screen offers the price and the payment goes out over it.
test('a torn copy with no record leaves the price, and the payment goes out over it', async () => {
  await put(`${DOMAIN}.tmp`, TORN)
  const tree = await render()
  expect(texts(tree)).not.toContain(UNREAD)
  await typeDomain(tree)
  await press(tree, i18n.t('useDomain.continue'))
  expect(texts(tree)).toContain(i18n.t('useDomain.pay'))
  await press(tree, i18n.t('useDomain.pay'))
  expect(sparkConfirmSend).toHaveBeenCalledTimes(1)
  expect([await raw(`${DOMAIN}.tmp`), await raw(`${DOMAIN}.unreadable`)]).toEqual([null, null])
})

test('a torn copy with no record leaves a store renewal its price and its order', async () => {
  mockDistribution.value = 'store'
  mockParams = { renew: HOST }
  double.control.state.products = [{ id: 'domain_year', displayPrice: 'US$ 99.99' }]
  await put(`${DOMAIN}.tmp`, TORN)
  const tree = await render()
  expect(texts(tree)).not.toContain(UNREAD)
  await press(tree, i18n.t('useDomain.pay'))
  expect(buyInStore).toHaveBeenCalledTimes(1)
})

// The record answered on mount and stops answering before a press, which reads it again before it
// mints anything.
describe('a record that stops reading before a press', () => {
  test('Continue takes the screen and sends no claim and no quote', async () => {
    const tree = await render()
    await typeDomain(tree)
    expect(texts(tree)).toContain(i18n.t('useDomain.continue'))
    await put(DOMAIN, TORN)
    await press(tree, i18n.t('useDomain.continue'))
    expectUnread(tree)
    expectNothingSold()
  })

  test('Continue on a store build opens no order', async () => {
    mockDistribution.value = 'store'
    const tree = await render()
    await typeDomain(tree)
    await put(DOMAIN, TORN)
    const button = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('useDomain.continue')))!
    await ReactTestRenderer.act(async () => {
      button.props.onPress()
    })
    await settle()
    expectUnread(tree)
    expectNothingSold()
  })

  test('a renewal whose record stops reading after the open asks no quote', async () => {
    mockParams = { renew: HOST }
    // The open's read answers and the record tears behind it, so the renewal's own read is the one
    // that cannot.
    jest.mocked(loadPendingPurchase).mockImplementationOnce(async () => {
      await put(DOMAIN, TORN)
      return null
    })
    const tree = await render()
    expectUnread(tree)
    expect(quote).not.toHaveBeenCalled()
  })

  // The store build's renewal reads the record again on Pay, since the press is what opens an order.
  test('Pay on a store renewal over a record that tore after the open opens no order', async () => {
    mockDistribution.value = 'store'
    mockParams = { renew: HOST }
    double.control.state.products = [{ id: 'domain_year', displayPrice: 'US$ 99.99' }]
    const tree = await render()
    const pay = tree.root.findAll(node => node.props.label === i18n.t('useDomain.pay'))[0]
    expect(pay?.props.disabled).toBe(false)
    expect(texts(tree)).not.toContain(UNREAD)
    await put(DOMAIN, TORN)
    await press(tree, i18n.t('useDomain.pay'))
    expect(texts(tree)).toContain(UNREAD)
    expect(buyInStore).not.toHaveBeenCalled()
    expect(await raw(DOMAIN)).toBe(TORN)
  })

  // A failure before any payment says so only while no payment is on record, and a record that
  // cannot be read is not the absence of one.
  test('a quote that fails over a record that tore never says nothing was charged', async () => {
    const tree = await render()
    await typeDomain(tree)
    quote.mockImplementationOnce(async () => {
      await put(DOMAIN, TORN)
      throw new Error('some_unknown_refusal')
    })
    await press(tree, i18n.t('useDomain.continue'))
    expectUnread(tree)
  })

  // A read the platform refuses reads nothing either, and the record it could not read may be a payment.
  test('a quote that fails while the record read is refused never says nothing was charged', async () => {
    const tree = await render()
    await typeDomain(tree)
    quote.mockImplementationOnce(async () => {
      jest.mocked(loadPendingPurchase).mockRejectedValueOnce(new Error('disk busy'))
      throw new Error('some_unknown_refusal')
    })
    await press(tree, i18n.t('useDomain.continue'))
    expectUnread(tree)
  })

  // The same failure with nothing torn still says it plainly, so the case above is the record's doing.
  test('the same failure over no record says nothing was charged', async () => {
    const tree = await render()
    await typeDomain(tree)
    quote.mockRejectedValueOnce(new Error('some_unknown_refusal'))
    await press(tree, i18n.t('useDomain.continue'))
    expect(texts(tree)).toContain(i18n.t('useDomain.payFailed'))
    expect(texts(tree)).not.toContain(UNREAD)
  })
})

// A read the platform refuses reads nothing, as a torn record does, and the record it could not read
// may be a payment owed: every read of it takes the screen the same way, with no price and no line.
describe('a record whose read the platform refuses', () => {
  const refuseNext = (): void => {
    jest.mocked(loadPendingPurchase).mockRejectedValueOnce(new Error('disk busy'))
  }

  test.each(['direct', 'store'] as const)('on mount takes the first-year screen on a %s build', async build => {
    mockDistribution.value = build
    refuseNext()
    const tree = await render()
    expectUnread(tree)
    expectNothingSold()
  })

  test.each(['direct', 'store'] as const)('on mount takes the renewal on a %s build', async build => {
    mockDistribution.value = build
    mockParams = { renew: HOST }
    refuseNext()
    const tree = await render()
    expectUnread(tree)
    expectNothingSold()
  })

  test.each(['direct', 'store'] as const)('on Continue takes the screen on a %s build and sells nothing', async build => {
    mockDistribution.value = build
    const tree = await render()
    await typeDomain(tree)
    refuseNext()
    const button = tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === i18n.t('useDomain.continue')))!
    await ReactTestRenderer.act(async () => {
      button.props.onPress()
    })
    await settle()
    expectUnread(tree)
    expectNothingSold()
  })

  test('on a renewal after the open asks no quote', async () => {
    mockParams = { renew: HOST }
    jest
      .mocked(loadPendingPurchase)
      .mockImplementationOnce(async () => null)
      .mockRejectedValueOnce(new Error('disk busy'))
    const tree = await render()
    expectUnread(tree)
    expect(quote).not.toHaveBeenCalled()
  })

  test('on Pay of a store renewal opens no order', async () => {
    mockDistribution.value = 'store'
    mockParams = { renew: HOST }
    double.control.state.products = [{ id: 'domain_year', displayPrice: 'US$ 99.99' }]
    const tree = await render()
    expect(texts(tree)).not.toContain(UNREAD)
    refuseNext()
    await press(tree, i18n.t('useDomain.pay'))
    expect(texts(tree)).toContain(UNREAD)
    expect(buyInStore).not.toHaveBeenCalled()
  })
})

test('a pay whose catch finds the record unreadable takes the screen and drops nothing', async () => {
  const tree = await render()
  await typeDomain(tree)
  await press(tree, i18n.t('useDomain.continue'))
  expect(texts(tree)).toContain(i18n.t('useDomain.pay'))
  jest.mocked(sparkConfirmSend).mockImplementationOnce(async () => {
    await put(DOMAIN, TORN)
    throw new Error('network')
  })
  await press(tree, i18n.t('useDomain.pay'))
  expectUnread(tree)
  expect(await raw(DOMAIN)).toBe(TORN)
  expect(confirm).not.toHaveBeenCalled()
})

// A refusal decided before any send drops this purchase's record and says nothing was charged, but only
// over a record that was read. One the platform refused to read may be another purchase's payment. An
// insufficient funds refusal raised at confirm meets this purchase's own record in the slot, so it is
// the case where dropping on the refusal alone would remove a record the catch never read.
test.each([
  ['a send that failed', 'confirm', 'network'],
  ['a refusal decided before any send', 'prepare', 'insufficient balance'],
  ['an insufficient funds refusal raised at confirm', 'confirm', 'insufficient balance'],
] as const)('a pay whose catch read is refused after %s takes the screen and drops nothing', async (_case, stage, message) => {
  const tree = await render()
  await typeDomain(tree)
  await press(tree, i18n.t('useDomain.continue'))
  expect(texts(tree)).toContain(i18n.t('useDomain.pay'))
  const fail = async (): Promise<never> => {
    jest.mocked(loadPendingPurchase).mockRejectedValueOnce(new Error('disk busy'))
    throw new Error(message)
  }
  if (stage === 'confirm') {
    jest.mocked(sparkConfirmSend).mockImplementationOnce(fail)
  } else {
    jest.mocked(sparkPrepareSend).mockImplementationOnce(fail)
  }
  await press(tree, i18n.t('useDomain.pay'))
  expectUnread(tree)
  expect(texts(tree)).not.toContain(i18n.t('errors.insufficientFunds'))
  // A send that may have gone keeps the record the press wrote. A refusal before any send has already
  // dropped this purchase's own unpaid record, and the catch drops nothing more.
  if (stage === 'confirm') {
    expect(await raw(DOMAIN)).toContain('"reference":"ref-q"')
  } else {
    expect(await raw(DOMAIN)).toBeNull()
  }
  expect(confirm).not.toHaveBeenCalled()
})

// The DNS steps of a first year poll the claim. A record that could not be read on mount holds that
// poll as well, even once the root's sync delivers a store year to this screen and its host is filled
// back in from the order.
test('a store year the sync delivers after a torn record at mount sends no claim', async () => {
  mockDistribution.value = 'store'
  await put(DOMAIN, TORN)
  const tree = await render()
  expectUnread(tree)

  const expiresAt = Math.floor(Date.now() / 1000) + 365 * 24 * 60 * 60
  jest.mocked(keptOrderViews).mockResolvedValue([
    { reference: 'ref-y', subject: HOST, renewal: false, outcome: { kind: 'delivered', host: HOST, expiresAt, frozen: false } },
  ])
  const heard = jest.mocked(onStoreSettled).mock.calls.at(-1)?.[0]
  expect(heard).toBeDefined()
  await ReactTestRenderer.act(async () => {
    heard!('ref-y', { kind: 'delivered', body: { host: HOST, expiresAt } })
  })
  await settle()

  expect(keptOrderViews).toHaveBeenCalled()
  expect(claim).not.toHaveBeenCalled()
  expectUnread(tree)
  expect(await raw(DOMAIN)).toBe(TORN)
})
