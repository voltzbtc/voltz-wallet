import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import RNFS from 'react-native-fs'
import fs from 'fs'
import path from 'path'
import '../src/i18n'
import { LnAddressScreen } from '../src/screens/LnAddressScreen'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { RootNavigator } from '../src/navigation/RootNavigator'
import { DomainNoticeCard } from '../src/components/DomainNoticeCard'
import { routePushNotification } from '../src/wallet/pushRoute'
import { setDomainFor } from '../src/wallet/lnurlDomainPref'
import {
  sparkConfirmSend,
  sparkEnsureLnAddress,
  sparkGetIdentityPubkey,
  sparkPrepareSend,
  sparkSignMessage,
} from '../src/wallet/spark'
import { formatDate } from '../src/wallet/history'
import { deviceDateTimePrefs } from '../src/wallet/deviceLocale'
import { formatSats } from '../src/wallet/amount'

// One customer, one domain, one year, walked end to end through the screens that ship. Every piece
// of this feature has a test of its own where its neighbours are mocked; none of them can see the
// seams, which is where defects live. So the gateway is faked once, at the fetch, and nothing
// above it is: the lifecycle read, the purchase module, the notice, both screens, the allowlist and
// the navigator are the real code, and what carries from step to step is the gateway's own state.

const BUILD = 'usevoltz.app'
const HOST = 'pay.bakery.com.br'
const ADDRESS = `alice@${HOST}`
const PUBKEY = `02${'a'.repeat(64)}`
const DAY = 86_400
const YEAR = 365 * DAY
const AMOUNT_SATS = 199_800
// The end of the year the customer is already paying for. Everything else is placed against it.
const FIRST_EXPIRY = 1_800_000_000

const mockNavigate = jest.fn()
const mockRootNavigate = jest.fn()
let mockParams: { renew?: string } | undefined

jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: mockParams }),
  // The real hook needs a navigation container. Each visit below is a fresh mount, which is what
  // coming back to a screen is, so running the read once per mount matches the device.
  useFocusEffect: (callback: () => void | (() => void)) => {
    const react = jest.requireActual('react') as typeof React
    react.useEffect(callback, [])
  },
  useNavigationContainerRef: () => ({
    isReady: () => true,
    navigate: mockRootNavigate,
    getCurrentRoute: () => undefined,
  }),
  // Children are never rendered, so mounting the navigator exercises the tap wiring without
  // standing the whole app tree up beside it.
  NavigationContainer: () => null,
}))

// Draws over the navigator and subscribes to the SDK; nothing in this walk depends on it.
jest.mock('../src/components/ReceivedOverlayHost', () => ({ ReceivedOverlayHost: () => null }))

// Keys, signatures and the send itself make up the device side, which is the other boundary and not
// the one under test. Implementations are installed in beforeAll, where the gateway exists to be
// paid.
jest.mock('../src/wallet/spark', () => ({
  // The withdrawal section the screen draws reads and listens for the connected wallet.
  sparkConnectedWalletId: () => null,
  sparkEnsureLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkAuthorizeLnAddressTransfer: jest.fn(),
  sparkClaimLnAddressTransfer: jest.fn(),
  sparkGetIdentityPubkey: jest.fn(),
  sparkSignMessage: jest.fn(),
  sparkPrepareSend: jest.fn(),
  // The purchase measures the balance before it dispatches, so a wallet that answers nothing
  // cannot pay. High enough that every case here is about the domain and not about funds.
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(),
  onSparkConnected: jest.fn(() => () => undefined),
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))

jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  switchWalletAndConnect: jest.fn(async () => undefined),
  reconnectActiveWallet: jest.fn(async () => undefined),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app', getDistribution: () => 'direct' }))

type GatewayCall = { path: string; body: Record<string, unknown> }

// The gateway. It holds the year, the freeze and the invoices it minted, and a payment moves all
// three, which is what the steps after a payment read.
const gateway = {
  serverNow: FIRST_EXPIRY - 31 * DAY,
  expiresAt: FIRST_EXPIRY,
  frozenAt: null as number | null,
  // Set by a payment that landed on a domain that was off the edge, where the hostname is back and
  // its certificate is not.
  thawing: false,
  minted: new Map<string, string>(),
  settled: new Set<string>(),
  granted: [] as { frozen: boolean }[],
  calls: [] as GatewayCall[],
}

function ok(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

function refused(status: number, error: string): Response {
  return { ok: false, status, json: async () => ({ error }) } as unknown as Response
}

async function gatewayFetch(url: string, init: RequestInit): Promise<Response> {
  const body = JSON.parse(String(init.body)) as Record<string, unknown>
  const route = url.replace(`https://${BUILD}`, '')
  gateway.calls.push({ path: route, body })

  if (route === '/api/domain/state') {
    return ok({
      host: HOST,
      role: 'owner',
      kind: 'customer',
      expiresAt: gateway.expiresAt,
      frozenAt: gateway.frozenAt,
      transferSeq: 0,
      serverNow: gateway.serverNow,
    })
  }

  if (route === '/api/domain/claim') {
    // The gateway grants a claim only while the paid year has not ended, so a lapsed year is
    // refused before the request can reach a hostname.
    if (gateway.expiresAt <= gateway.serverNow) {
      return refused(402, 'domain_tier_not_paid')
    }
    return ok({
      host: HOST,
      provider: 'cloudflare',
      supportsRoot: true,
      isRoot: false,
      target: 'saas.usevoltz.app',
      state: gateway.thawing ? 'awaiting_certificate' : 'active',
    })
  }

  if (route === '/api/domain/quote') {
    const reference = `ref-${gateway.minted.size + 1}`
    gateway.minted.set(reference, `lnbc-${reference}`)
    return ok({
      host: body.host,
      priceUsdCents: 9990,
      days: 365,
      amountSats: AMOUNT_SATS,
      invoice: `lnbc-${reference}`,
      reference,
      // A real ten minute hold, counted down on screen against the device clock.
      expiresAt: Math.floor(Date.now() / 1000) + 600,
    })
  }

  if (route === '/api/domain/quote/confirm') {
    const invoice = gateway.minted.get(String(body.reference))
    if (!invoice || !gateway.settled.has(invoice)) {
      // The payment has not been seen yet, which the module reads as "keep waiting".
      return refused(402, 'not_settled')
    }
    // The gateway reads it before the hostname is put back, so it says the domain was off the edge
    // when the money landed.
    const frozen = gateway.frozenAt !== null
    // A year on top of the days still owed, and from today once the old year has run out.
    gateway.expiresAt = Math.max(gateway.expiresAt, gateway.serverNow) + YEAR
    gateway.frozenAt = null
    gateway.thawing = frozen
    gateway.granted.push({ frozen })
    return ok({ expiresAt: gateway.expiresAt, frozen })
  }

  return refused(404, 'not_found')
}

function calls(route: string): GatewayCall[] {
  return gateway.calls.filter(call => call.path === route)
}

// The words are read out of the locale file rather than typed here, so a line reworded in the app
// takes the assertion with it instead of leaving it green against copy nobody ships.
const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
) as { domain: Record<string, string>; useDomain: Record<string, string> }

function fill(bag: Record<string, string>, key: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce(
    (line, [name, value]) => line.split(`{{${name}}}`).join(String(value)),
    bag[key]!,
  )
}

const domainCopy = (key: string, values: Record<string, string | number> = {}): string =>
  fill(en.domain, key, values)
const renewCopy = (key: string, values: Record<string, string | number> = {}): string =>
  fill(en.useDomain, key, values)

const prefs = deviceDateTimePrefs()

type Visit = { tree: ReactTestRenderer.ReactTestRenderer; element: React.JSX.Element }

async function settle(visit: Visit): Promise<void> {
  for (let tick = 0; tick < 25; tick += 1) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
      visit.tree.update(visit.element)
    })
  }
}

async function open(element: React.JSX.Element): Promise<Visit> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  const visit = { tree, element }
  await settle(visit)
  return visit
}

async function close(visit: Visit): Promise<void> {
  await ReactTestRenderer.act(async () => {
    visit.tree.unmount()
  })
}

function texts(visit: Visit): string[] {
  return visit.tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

function count(visit: Visit, type: React.ElementType): number {
  return visit.tree.root.findAllByType(type).length
}

// Pressable is not findable by type in RN 0.86, it becomes an inner View, so a control is located
// by the pair of an onPress prop and the label the customer reads on it.
async function tap(visit: Visit, label: string): Promise<void> {
  const target = visit.tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!target) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle(visit)
}

beforeAll(async () => {
  // The poll behind the DNS step and the countdown under the price both run on intervals.
  jest.useFakeTimers()
  ;(RNFS as unknown as { __reset: () => void }).__reset()

  ;(sparkEnsureLnAddress as jest.Mock).mockResolvedValue({
    username: 'alice',
    address: ADDRESS,
    lnurl: 'lnurl1abc',
  })
  ;(sparkGetIdentityPubkey as jest.Mock).mockResolvedValue(PUBKEY)
  ;(sparkSignMessage as jest.Mock).mockResolvedValue('deadbeef')
  ;(sparkPrepareSend as jest.Mock).mockImplementation(async (destination: string) => ({
    handle: destination,
    amount: AMOUNT_SATS,
    fee: 0,
  }))
  // The money leaving the wallet is what the gateway later sees, so the send settles the invoice it
  // was prepared for and nothing else does.
  ;(sparkConfirmSend as jest.Mock).mockImplementation(async (handle: string) => {
    gateway.settled.add(handle)
    return 'complete'
  })

  global.fetch = gatewayFetch as unknown as typeof fetch

  // The wallet was pointed at the domain when it was bought, which is what lets the lifecycle read
  // name a host instead of asking the gateway what this key holds.
  await setDomainFor('primary', HOST)
})

afterAll(() => {
  jest.useRealTimers()
})

// A year of screens in one test, which on a loaded machine runs past Jest's 5 s default.
test('a customer domain from its last month, through a renewal, a lapse, a freeze and the tap that brings the owner back', async () => {
  // 1. Thirty-one days out. The year is running, nothing is owed, and the screen says nothing at
  //    all about domains.
  const early = await open(<LnAddressScreen />)
  const signedRead = calls('/api/domain/state').at(-1)
  expect(signedRead?.body).toMatchObject({ host: HOST, pubkey: PUBKEY, signature: 'deadbeef' })
  expect(count(early, DomainNoticeCard)).toBe(0)
  expect(count(early, QRCode)).toBe(1)
  expect(texts(early)).toContain(ADDRESS)
  expect(texts(early)).not.toContain(en.domain.renew)
  await close(early)

  // 2. Thirty days out, which is the first rung of the ladder. The card names the day the year ends
  //    and repeats what the fee buys, since an owner who reads it as a second bill for a domain
  //    they already own stops trusting the renewal.
  gateway.serverNow = FIRST_EXPIRY - 30 * DAY
  const ending = await open(<LnAddressScreen />)
  expect(texts(ending)).toContain(domainCopy('noticeEndingTitle'))
  expect(texts(ending)).toContain(
    domainCopy('noticeEndingBody', { domain: HOST, date: formatDate(gateway.expiresAt, prefs) }),
  )
  expect(texts(ending).join(' ')).not.toContain('yearly fee')
  // Nothing has stopped receiving, so the code is still there to hand out.
  expect(count(ending, QRCode)).toBe(1)

  // 3. The renewal is opened knowing the domain, and the press that opens it mints nothing: an
  //    invoice taken here would charge the treasury for every owner who only looked at their own
  //    address.
  await tap(ending, en.domain.renew)
  expect(mockNavigate.mock.calls).toEqual([['UseMyDomain', { renew: HOST }]])
  expect(calls('/api/domain/quote')).toHaveLength(0)
  await close(ending)

  // The params come from the notice, never from a domain typed into the test, which is the seam.
  mockParams = mockNavigate.mock.calls[0]![1] as { renew?: string }
  const renewal = await open(<UseMyDomainScreen />)
  expect(count(renewal, TextInput)).toBe(0)
  expect(texts(renewal)).toContain(HOST)
  expect(texts(renewal)).toContain(renewCopy('amountSats', { amount: formatSats(AMOUNT_SATS) }))
  // The year is still running, so the days already paid for are not lost by renewing today.
  expect(texts(renewal)).toContain(en.useDomain.renewEarly)
  expect(calls('/api/domain/quote')).toHaveLength(1)

  // 4. The payment. The gateway saw the money, the domain was never off the edge, and the sentence
  //    says the renewal is done rather than promising a return.
  await tap(renewal, en.useDomain.pay)
  expect(gateway.granted).toEqual([{ frozen: false }])
  expect(texts(renewal)).toContain(
    renewCopy('renewDone', { domain: HOST, date: formatDate(gateway.expiresAt, prefs) }),
  )
  expect(texts(renewal)).not.toContain(en.useDomain.renewWaking)
  // The record was made a year ago and still points where it should.
  expect(texts(renewal)).not.toContain(`${en.useDomain.stepType}: CNAME`)
  await close(renewal)

  // 5. The day after the year the customer started with. It ends nothing from here on, and the only
  //    reason is the payment above: this is the same gateway, answering with what that payment
  //    moved.
  gateway.serverNow = FIRST_EXPIRY + DAY
  const renewed = await open(<LnAddressScreen />)
  expect(count(renewed, DomainNoticeCard)).toBe(0)
  expect(count(renewed, QRCode)).toBe(1)
  await close(renewed)

  // A year on, with nothing paid this time.
  gateway.serverNow = gateway.expiresAt + DAY
  const lapsed = await open(<LnAddressScreen />)
  expect(texts(lapsed)).toContain(domainCopy('noticeExpiredTitle', { domain: HOST }))
  expect(texts(lapsed)).not.toContain(domainCopy('noticeEndingTitle'))
  // Expiry on its own takes nothing off the edge, so the code still resolves for a payer.
  expect(count(lapsed, QRCode)).toBe(1)
  await close(lapsed)

  // The gateway removes the certificate and the hostname goes with it. A code that makes the
  // payer's wallet error is worse than no code, and the address behind it is the same dead end one
  // paste further away.
  gateway.frozenAt = gateway.expiresAt + 2 * DAY
  gateway.serverNow = gateway.frozenAt + 3600
  const frozen = await open(<LnAddressScreen />)
  expect(texts(frozen)).toContain(domainCopy('noticeFrozenTitle', { domain: HOST }))
  expect(texts(frozen)).toContain(
    domainCopy('noticeFrozenBody', { domain: HOST, date: formatDate(gateway.frozenAt, prefs) }),
  )
  expect(count(frozen, QRCode)).toBe(0)
  expect(texts(frozen)).not.toContain(ADDRESS)

  // 6. Renewing a domain that has already stopped. The renewal is still one press away from the
  //    card, and the year that lapsed changes the line above the price.
  await tap(frozen, en.domain.renew)
  expect(mockNavigate.mock.calls).toHaveLength(2)
  mockParams = mockNavigate.mock.calls[1]![1] as { renew?: string }
  expect(mockParams).toEqual({ renew: HOST })
  await close(frozen)

  const thaw = await open(<UseMyDomainScreen />)
  expect(texts(thaw)).toContain(en.useDomain.renewLate)
  expect(texts(thaw)).not.toContain(en.useDomain.renewEarly)
  expect(texts(thaw)).toContain(renewCopy('amountSats', { amount: formatSats(AMOUNT_SATS) }))

  await tap(thaw, en.useDomain.pay)
  expect(gateway.granted).toEqual([{ frozen: false }, { frozen: true }])
  expect(texts(thaw)).toContain(en.useDomain.renewWaking)
  expect(texts(thaw)).not.toContain(
    renewCopy('renewDone', { domain: HOST, date: formatDate(gateway.expiresAt, prefs) }),
  )
  // The claim that follows the payment is what puts the hostname back, and it reports the
  // certificate still being reissued rather than an address that already works.
  expect(texts(thaw)).toContain(en.useDomain.certificate)
  expect(texts(thaw)).not.toContain(en.useDomain.active)
  await close(thaw)

  // 7. The notification about all of this, tapped. The payload is handed over the way App.tsx hands
  //    it over, `message.data` and nothing else off the message, and it names a screen and params of
  //    its own to see whether either is read.
  const navigator = await open(<RootNavigator />)
  const message = {
    data: { type: 'domain', host: HOST, screen: 'Send', params: { destination: 'lnbc1' } },
  }
  ReactTestRenderer.act(() => routePushNotification(message.data))
  expect(mockRootNavigate.mock.calls).toEqual([['LnAddress']])
  await close(navigator)

  // And the screen it lands on reads the domain the last payment brought back.
  const back = await open(<LnAddressScreen />)
  expect(count(back, DomainNoticeCard)).toBe(0)
  expect(count(back, QRCode)).toBe(1)
  expect(texts(back)).toContain(ADDRESS)
  await close(back)

  // One invoice per renewal, both of them paid, and nothing minted in between.
  expect(calls('/api/domain/quote')).toHaveLength(2)
  expect(gateway.settled.size).toBe(2)
}, 15_000)
