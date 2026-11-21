import React from 'react'
import { GradientButton } from '../src/components/GradientButton'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Text } from 'react-native'
import QRCode from 'react-native-qrcode-svg'
import fs from 'fs'
import path from 'path'
import i18n from '../src/i18n'
import { LnAddressScreen } from '../src/screens/LnAddressScreen'
import { MenuRow } from '../src/components/MenuRow'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import { DomainNoticeCard } from '../src/components/DomainNoticeCard'
import {
  sparkAuthorizeLnAddressTransfer,
  sparkClaimLnAddressTransfer,
  sparkDeleteLnAddress,
  sparkEnsureLnAddress,
  sparkGetIdentityPubkey,
  sparkGetLnAddress,
} from '../src/wallet/spark'
import { readDomainState, type DomainState } from '../src/wallet/domainTier'
import { ReceiveHeldByExit } from '../src/wallet/errors'
import { reconnectActiveWallet } from '../src/wallet/wallet'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { clearDomainFor, setDomainFor, storedDomainFor } from '../src/wallet/lnurlDomainPref'

const mockNavigate = jest.fn()
let mockParams: { choose?: boolean } | undefined
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  useRoute: () => ({ params: mockParams }),
  // The real hook needs a navigation container; the screen only uses it to run its read on arrival.
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React_ = jest.requireActual('react')
    React_.useEffect(cb, [])
  },
}))

jest.mock('../src/wallet/spark', () => ({
  // The withdrawal section the screen draws reads and listens for the connected wallet.
  sparkConnectedWalletId: () => null,
  onSparkConnected: () => () => undefined,
  sparkEnsureLnAddress: jest.fn(async () => null),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  // Both are what the lifecycle read is signed with, and either can reject when no wallet is
  // connected, which is the case the screen has to survive without losing the address.
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkAuthorizeLnAddressTransfer: jest.fn(),
  sparkClaimLnAddressTransfer: jest.fn(),
}))

// Each leg of a move reconnects the SDK to another wallet, which only a device can do.
jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  switchWalletAndConnect: jest.fn(async () => undefined),
  reconnectActiveWallet: jest.fn(async () => undefined),
}))

// The picker lists wallets from the registry; the move only needs the id it hands back.
type PickerProps = { visible: boolean; onPick: (walletId: string) => void }
let mockPicker: PickerProps | null = null
jest.mock('../src/components/WalletPickerSheet', () => ({
  WalletPickerSheet: (props: PickerProps) => {
    mockPicker = props
    return null
  },
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))

// The shared domain comes from .env, which CI does not have, so it is pinned here.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: jest.fn(() => 'usevoltz.app'),
}))

// phaseOf stays real, so every card below is chosen from dates by the same code that runs on the
// device. A test that handed the screen a phase word would agree with any derivation.
jest.mock('../src/wallet/domainTier', () => ({
  ...jest.requireActual('../src/wallet/domainTier'),
  readDomainState: jest.fn(async () => null),
}))

const HOST = 'pay.bakery.com.br'
const PUBKEY = `02${'a'.repeat(64)}`
const NOW = 1_800_000_000
const DAY = 86_400

// The words are read from the locale file rather than from t(), so a card borrowing the
// neighbouring phase's title cannot agree with the assertion.
const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
) as { domain: Record<string, string>; receive: Record<string, string> }

function copy(key: string): string {
  return en.domain[key].replace(/\{\{domain\}\}/g, HOST)
}

function state(over: Partial<DomainState> = {}): DomainState {
  return {
    host: HOST,
    role: 'owner',
    kind: 'customer',
    expiresAt: NOW + 365 * DAY,
    frozenAt: null,
    transferSeq: 0,
    serverNow: NOW,
    ...over,
  }
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LnAddressScreen />)
  })
  // The lifecycle read is three awaits deep (active wallet, identity key, the answer itself), so a
  // single flush would assert against a screen that has not heard back yet.
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 6; tick += 1) {
      await Promise.resolve()
    }
  })
  return tree
}

// Everything the screen stacks under the hint, in the order it draws them.
// Fires whatever the screen registered for AppState, which is how a test says the app came back.
function foreground(): void {
  const add = jest.mocked(AppState.addEventListener)
  for (const call of add.mock.calls) {
    if (call[0] === 'change') {
      ;(call[1] as (s: string) => void)('active')
    }
  }
}

function rows(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestRendererJSON[] {
  const scroll = tree.toJSON() as ReactTestRenderer.ReactTestRendererJSON
  const content = scroll.children?.[0] as ReactTestRenderer.ReactTestRendererJSON
  const [top, ...below] = (content.children ?? []) as ReactTestRenderer.ReactTestRendererJSON[]
  return [...((top?.children ?? []).slice(1) as ReactTestRenderer.ReactTestRendererJSON[]), ...below]
}

function holdsTheCode(row: ReactTestRenderer.ReactTestRendererJSON | undefined): boolean {
  return JSON.stringify(row ?? null).includes('"QRCode"')
}

function pressRenew(tree: ReactTestRenderer.ReactTestRenderer): void {
  const button = tree.root.find(
    node =>
      node.props.accessibilityRole === 'button' &&
      node.props.accessibilityLabel === en.domain.renew &&
      typeof node.props.onPress === 'function',
  )
  ReactTestRenderer.act(() => button.props.onPress())
}

// What the binding throws for any answer of the LNURL server other than 2xx or 401, copied from SDK
// 0.27.2. It is SdkError's NetworkError, whose message on React Native is only the class name, and
// the status and the body travel in `inner`, in the wording of the SDK's conversion from
// LnurlServerError.
function refusedByServer(status: number, body: string): Error {
  return Object.assign(new Error('SdkError.NetworkError'), {
    tag: 'NetworkError',
    inner: Object.freeze([`network request failed with status ${status}: ${body}`]),
  })
}

// Answers yes to whatever the screen asks, while a test says so.
let mockConfirms = false
jest.mock('../src/components/ConfirmSheet', () => {
  const react = require('react')
  return {
    ConfirmSheet: ({ request }: { request: { onConfirm: () => void } | null }) => {
      react.useEffect(() => {
        if (request && mockConfirms) {
          request.onConfirm()
        }
      }, [request])
      return null
    },
  }
})

// Presses the move row and answers the picker with the wallet the address is being moved to.
async function move(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === en.receive.lnTransfer))
  await ReactTestRenderer.act(async () => {
    btn?.props.onPress()
  })
  expect(mockPicker?.visible).toBe(true)
  await ReactTestRenderer.act(async () => {
    mockPicker?.onPick('w_other')
    for (let tick = 0; tick < 10; tick += 1) {
      await Promise.resolve()
    }
  })
}

// clearAllMocks only empties the call log; an implementation swapped in by one test survives into
// every test written after it. Each one a case here replaces is restored by name.
beforeEach(() => {
  jest.clearAllMocks()
  mockParams = undefined
  mockPicker = null
  mockConfirms = false
  jest.mocked(sparkAuthorizeLnAddressTransfer).mockResolvedValue({
    username: 'alice',
    pubkey: PUBKEY,
    signature: 'sig',
    domain: HOST,
    timestamp: 0n,
  })
  jest.mocked(sparkClaimLnAddressTransfer).mockResolvedValue({
    username: 'alice',
    address: `alice@${HOST}`,
    lnurl: 'lnurl1abc',
  })
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'alice',
    address: 'alice@breez.tips',
    lnurl: 'lnurl1abc',
  })
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(PUBKEY)
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(readDomainState).mockResolvedValue(null)
})

test('shows the registered Lightning address', async () => {
  const tree = await render()

  expect(sparkEnsureLnAddress).toHaveBeenCalled()
  expect(texts(tree).join('')).toContain('alice@breez.tips')
})

test('the change button opens the registration sheet', async () => {
  const tree = await render()

  expect(tree.root.findByType(LnAddressSheet).props.visible).toBe(false)
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === 'Change address'))
  await ReactTestRenderer.act(async () => {
    btn?.props.onPress()
  })

  expect(tree.root.findByType(LnAddressSheet).props.visible).toBe(true)
})

test('sent here to choose a name, the screen opens on the sheet', async () => {
  mockParams = { choose: true }
  const tree = await render()
  expect(tree.root.findByType(LnAddressSheet).props.visible).toBe(true)
})

// A name bought through the store can be spent while the address could not be read, and the sheet
// closes on it without the address.
test('closing the sheet reads the address again', async () => {
  const tree = await render()
  expect(texts(tree).join('')).toContain('alice@breez.tips')
  jest.mocked(sparkGetLnAddress).mockResolvedValueOnce({ username: 'bob123', address: 'bob123@breez.tips', lnurl: 'lnurl1' })
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(LnAddressSheet).props.onClose()
  })
  expect(texts(tree).join('')).toContain('bob123@breez.tips')
  // A read that answers nothing leaves the address on screen.
  jest.mocked(sparkGetLnAddress).mockResolvedValueOnce(null)
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(LnAddressSheet).props.onClose()
  })
  expect(texts(tree).join('')).toContain('bob123@breez.tips')
})

const PHASES = [
  { phase: 'ending', title: 'noticeEndingTitle', over: { expiresAt: NOW + 10 * DAY } },
  { phase: 'lastDay', title: 'noticeLastDayTitle', over: { expiresAt: NOW + 3600 } },
  { phase: 'expired', title: 'noticeExpiredTitle', over: { expiresAt: NOW - 60 } },
  {
    phase: 'frozen',
    title: 'noticeFrozenTitle',
    over: { expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY },
  },
] as const

test.each(PHASES)('a domain that is $phase says so and says nothing else', async ({ title, over }) => {
  jest.mocked(readDomainState).mockResolvedValue(state(over))

  const shown = texts(await render())

  expect(shown).toContain(copy(title))
  for (const other of PHASES.filter(row => row.title !== title)) {
    expect(shown).not.toContain(copy(other.title))
  }
})

// The move back to the shared domain is its own action, so its failure names it, never the creation
// of an address.
test('a move back to the shared domain that fails says it could not go back', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW - 60 }))
  const tree = await render()
  const card = tree.root.findByType(DomainNoticeCard)
  const shared = card.props.sharedDomain as string
  expect(shared).toBeTruthy()
  jest.mocked(reconnectActiveWallet).mockRejectedValueOnce(new Error('offline'))
  mockConfirms = true
  await ReactTestRenderer.act(async () => {
    card.props.onUseShared()
    for (let tick = 0; tick < 6; tick += 1) {
      await Promise.resolve()
    }
  })

  expect(texts(tree)).toContain(i18n.t('domain.useSharedFailed', { domain: shared }))
  expect(texts(tree)).not.toContain(i18n.t('receive.lnFailed'))
})

// The line says the wallet could not go back, so a move whose reconnect fails leaves the wallet's own
// domain chosen, and the next connect does not move it unannounced. A move that lands clears it.
test.each([
  ['fails', true, 'pay.shop.com'],
  ['lands', false, undefined],
])('a move back whose reconnect %s leaves the domain chosen as the line says', async (_label, fails, after) => {
  await setDomainFor('primary', 'pay.shop.com')
  try {
    jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW - 60 }))
    const tree = await render()
    const card = tree.root.findByType(DomainNoticeCard)
    if (fails) {
      jest.mocked(reconnectActiveWallet).mockRejectedValueOnce(new Error('offline'))
    }
    mockConfirms = true
    await ReactTestRenderer.act(async () => {
      card.props.onUseShared()
      for (let tick = 0; tick < 12; tick += 1) {
        await Promise.resolve()
      }
    })
    expect(reconnectActiveWallet).toHaveBeenCalled()
    expect(await storedDomainFor('primary')).toBe(after)
  } finally {
    await clearDomainFor('primary')
  }
})

// A connect a newer request cut loose is no failure of the move: the shared domain stays chosen, which
// the newer connect reads, and nothing says the wallet could not go back.
test('a move back whose reconnect a newer connect supersedes keeps the shared domain and says nothing failed', async () => {
  await setDomainFor('primary', 'pay.shop.com')
  try {
    jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW - 60 }))
    const tree = await render()
    const card = tree.root.findByType(DomainNoticeCard)
    const shared = card.props.sharedDomain as string
    const superseded = Object.assign(new Error('spark connect superseded'), { name: 'SparkConnectSuperseded' })
    jest.mocked(reconnectActiveWallet).mockRejectedValueOnce(superseded)
    mockConfirms = true
    await ReactTestRenderer.act(async () => {
      card.props.onUseShared()
      for (let tick = 0; tick < 10; tick += 1) {
        await new Promise(resolve => setImmediate(resolve))
      }
    })
    expect(reconnectActiveWallet).toHaveBeenCalled()
    expect(await storedDomainFor('primary')).toBeUndefined()
    expect(texts(tree)).not.toContain(i18n.t('domain.useSharedFailed', { domain: shared }))
    expect(tree.root.findAllByType(DomainNoticeCard)).toHaveLength(0)
  } finally {
    await clearDomainFor('primary')
  }
})

test('a domain with a year left is not mentioned, and leaves no gap where the card would be', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()

  expect(tree.root.findAllByType(DomainNoticeCard)).toHaveLength(0)
  const shown = texts(tree).join(' ')
  for (const row of PHASES) {
    expect(shown).not.toContain(copy(row.title))
  }
  expect(shown).not.toContain(en.domain.renew)
  // A slot that always drew its own container would sit here, pushing the code down by one gap on
  // every open, for every wallet, to say nothing.
  expect(holdsTheCode(rows(tree)[0])).toBe(true)
})

test('the code is offered while the domain works', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()

  expect(tree.root.findAllByType(QRCode)).toHaveLength(1)
  expect(texts(tree).join('')).toContain('alice@breez.tips')
})

// The worst outcome this feature can produce is a shop holding up a code that errors in the
// customer's wallet. The address behind it is the same dead end, one paste further away.
test('a frozen domain offers no code and no address to hand out', async () => {
  jest.mocked(readDomainState).mockResolvedValue(
    state({ expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY }),
  )

  const tree = await render()

  expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  expect(texts(tree).join('')).not.toContain('alice@breez.tips')
  expect(texts(tree)).toContain(copy('noticeFrozenTitle'))
})

// spark.ts hands out no address while the wallet's exit holds its receives; the screen says why
// instead of drawing an empty slot.
test.each([
  ['exit', 'emergencyExit.receiveHeld'],
  ['unread', 'emergencyExit.receiveHeldUnread'],
] as const)('an address held by the exit (%s) shows no code and says why', async (hold, key) => {
  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new ReceiveHeldByExit(hold))

  const tree = await render()

  expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  expect(texts(tree).join('')).not.toContain('alice@breez.tips')
  expect(texts(tree)).toContain(i18n.t(key))
})

// In the real frozen case the hostname is off the edge and the SDK can hand back no address at all,
// so a card keyed off the address would go missing exactly when it is the only thing worth reading.
test('a domain that is frozen explains itself even when no address could be loaded', async () => {
  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('no such host'))
  jest.mocked(readDomainState).mockResolvedValue(
    state({ expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY }),
  )

  const shown = texts(await render())

  expect(shown).toContain(copy('noticeFrozenTitle'))
  expect(shown.join(' ')).not.toContain('yearly fee')
})

test('renewing carries the domain to the payment, so nobody is asked to type it again', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW + 10 * DAY }))

  pressRenew(await render())

  expect(mockNavigate).toHaveBeenCalledWith('UseMyDomain', { renew: HOST })
})

// A domain that was handed over leaves the outgoing wallet authorised, so its address keeps working
// on a host it no longer owns. Offering it a renewal it cannot make is worse than one plain line.
test('a domain owned by another wallet is named, and offered no renewal', async () => {
  jest.mocked(readDomainState).mockResolvedValue(
    state({ role: 'member', expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY }),
  )

  const tree = await render()
  const shown = texts(tree)

  expect(shown).toContain(copy('onAnotherWallet'))
  expect(shown).not.toContain(en.domain.renew)
  expect(tree.root.findAllByType(DomainNoticeCard)).toHaveLength(0)
  // The host is off the edge for everyone on it, not only for whoever pays to bring it back.
  expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
})

test('a wallet on the shared domain hears nothing about domains at all', async () => {
  const tree = await render()

  expect(texts(tree).join(' ')).not.toContain(copy('onAnotherWallet'))
  expect(tree.root.findAllByType(DomainNoticeCard)).toHaveLength(0)
  expect(tree.root.findAllByType(QRCode)).toHaveLength(1)
})

// The status read is signed, and signing needs a connected wallet. A screen that lost its address
// because a notice could not be fetched would give up the thing it owes for the thing it offers.
test('a lifecycle read that cannot even be signed leaves the screen exactly as it was', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockRejectedValue(new Error('not connected'))

  const tree = await render()

  expect(readDomainState).not.toHaveBeenCalled()
  expect(tree.root.findAllByType(QRCode)).toHaveLength(1)
  expect(texts(tree).join('')).toContain('alice@breez.tips')
  expect(tree.root.findAllByType(DomainNoticeCard)).toHaveLength(0)
})

// The read is per wallet: the host it asks about comes from the active wallet's own preference, and
// the answer is cached under that id. A read wired to a fixed id would show one wallet another
// wallet's domain, and offer it a renewal it cannot make.
test('asks about the wallet that is actually open', async () => {
  jest.mocked(getActiveWalletId).mockResolvedValue('segunda')
  jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW + 10 * DAY }))

  await render()

  expect(readDomainState).toHaveBeenCalledWith(
    expect.objectContaining({ walletId: 'segunda', pubkey: PUBKEY }),
  )
})

// Skeleton renders null under the global mock, so the shimmer itself cannot be asserted. Its
// container can: while the domain is off the edge no address is coming, and a placeholder promising
// one contradicts the notice directly above it.
test('picks the notice back up when the app returns, without waiting for a navigation', async () => {
  // The one state on this screen that changes without the owner doing anything. A domain comes back
  // minutes after the renewal, and focus does not fire again for somebody already standing here, so
  // without this the card goes on saying the addresses are off. Returning to the foreground is when
  // they are looking and when the notification about it lands.
  jest.mocked(readDomainState).mockResolvedValue(
    state({ expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY }),
  )
  const tree = await render()
  expect(texts(tree)).toContain(copy('noticeFrozenTitle'))

  jest.mocked(readDomainState).mockResolvedValue(state({ expiresAt: NOW + 300 * DAY, frozenAt: null }))
  await ReactTestRenderer.act(async () => {
    foreground()
    await Promise.resolve()
  })

  expect(texts(tree)).not.toContain(copy('noticeFrozenTitle'))
})

test('a frozen domain waits on no address, so nothing is held open for one', async () => {
  jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => {}) as never)
  jest.mocked(readDomainState).mockResolvedValue(
    state({ expiresAt: NOW - 3 * DAY, frozenAt: NOW - 2 * DAY }),
  )

  const tree = await render()

  expect(texts(tree)).toContain(copy('noticeFrozenTitle'))
  // Asserted by what is drawn rather than by how many things are, because the notice and its button
  // are both legitimate and a count would tie this case to where the button sits. What must not be
  // here is anything that waits, since the address it would wait for cannot exist.
  expect(rows(tree).some(holdsTheCode)).toBe(false)
  expect(JSON.stringify(rows(tree))).not.toContain('Skeleton')
})

// A move is judged as the receiving wallet taking the name, so the gateway can refuse it for a
// reason that has nothing to do with moving. Read from the locale file, like the cards above, so a
// refusal borrowing the neighbouring reason's words cannot agree with the assertion.
const REFUSALS = [
  { code: 'change_limit_reached', says: () => en.receive.lnChangeLimit },
  { code: 'reserved', says: () => en.receive.lnReserved },
  { code: 'domain_not_yours', says: () => en.receive.lnMoveNotAllowed },
  { code: 'domain_expired', says: () => en.domain.noticeExpiredTitle?.replace('{{domain}}', HOST) },
] as const

test.each(REFUSALS)('a move the gateway refuses with $code says why', async ({ code, says }) => {
  const expected = says()
  expect(expected).toEqual(expect.stringMatching(/\S/))
  expect(expected).not.toContain('{{')
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'alice',
    address: `alice@${HOST}`,
    lnurl: 'lnurl1abc',
  })
  jest
    .mocked(sparkClaimLnAddressTransfer)
    .mockRejectedValue(refusedByServer(403, JSON.stringify({ error: code })))

  const tree = await render()
  await move(tree)

  expect(sparkClaimLnAddressTransfer).toHaveBeenCalled()
  expect(texts(tree)).toContain(`${en.receive.lnMoveFailed} ${expected}`)
})

// Anything else the server answers is somebody else's wording, or none at all, and the person is told
// only that the move failed. The log, which a release build keeps, says the refusal's kind alone.
test.each([
  { what: 'a code the app does not know', body: JSON.stringify({ error: 'something_new' }) },
  { what: 'a body that is not the gateway reply', body: '<html>502 Bad Gateway</html>' },
])('a refusal with $what says only that the move failed', async ({ body }) => {
  jest.mocked(sparkClaimLnAddressTransfer).mockRejectedValue(refusedByServer(502, body))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  try {
    const tree = await render()
    await move(tree)

    expect(sparkClaimLnAddressTransfer).toHaveBeenCalled()
    expect(texts(tree)).toContain(en.receive.lnMoveFailed)
    const logged = warn.mock.calls.map(args => args.map(String).join(' ')).join('\n')
    expect(logged).toContain('lightning address move refused: Error NetworkError')
    expect(logged).not.toContain(body)
  } finally {
    warn.mockRestore()
  }
})

test('a move that goes through raises no alert and shows the address on its new wallet', async () => {
  const tree = await render()

  await move(tree)

  expect(texts(tree).join(' ')).not.toContain(en.receive.lnMoveFailed)
  expect(texts(tree).join('')).toContain(`alice@${HOST}`)
})

// Ensure can wait seconds on the gateway, and the sheet can register a name while it does. Whatever
// ensure then says without an address is older than that name and must not clear it.
test.each([
  { what: 'an empty answer', settle: (done: Settle) => done.resolve(null) },
  { what: 'a failure', settle: (done: Settle) => done.reject(new Error('no such host')) },
])('$what from ensure that lands late keeps a name registered meanwhile', async ({ settle }) => {
  let done!: Settle
  jest.mocked(sparkEnsureLnAddress).mockReturnValue(
    new Promise((resolve, reject) => {
      done = { resolve, reject }
    }),
  )
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    tree.root
      .findByType(LnAddressSheet)
      .props.onRegistered({ username: 'carol', address: 'carol@breez.tips', lnurl: 'lnurl1c' })
  })
  await ReactTestRenderer.act(async () => {
    settle(done)
    for (let tick = 0; tick < 4; tick += 1) {
      await Promise.resolve()
    }
  })

  expect(texts(tree).join('')).toContain('carol@breez.tips')
})

type Settle = { resolve: (value: null) => void; reject: (err: Error) => void }

// Each row that draws its divider, with the gap of the native view that lays it out. A gap there
// floats the hairline above the next row instead of letting it meet it. The first host View above a
// row is that view, unless it is a scroll view's content, whose style arrives as the scroll view's
// contentContainerStyle (the Jest scroll view does not pass it down).
function dividerGaps(rendered: ReactTestRenderer.ReactTestRenderer): { label: string; gap: number }[] {
  type Node = ReactTestRenderer.ReactTestInstance
  const hostAbove = (node: Node): Node | null => {
    let up = node.parent
    while (up && typeof up.type !== 'string') {
      up = up.parent
    }
    return up
  }
  const flat = (raw: unknown): Record<string, unknown> =>
    Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))
  return rendered.root
    .findAllByType(MenuRow)
    .filter(menuRow => menuRow.props.divider !== false)
    .map(menuRow => {
      const view = hostAbove(menuRow)
      const scroll = view && hostAbove(view)
      const style =
        scroll && (scroll.type as unknown) === 'RCTScrollView'
          ? flat(scroll.props.contentContainerStyle)
          : flat(view?.props.style)
      return { label: String(menuRow.props.label), gap: Number(style.gap ?? style.rowGap ?? 0) }
    })
}

describe('the address rows form one group', () => {
  test('with an address, each divider meets the row under it', async () => {
    const gaps = dividerGaps(await render())

    expect(gaps.length).toBeGreaterThanOrEqual(2)
    expect(gaps.filter(entry => entry.gap !== 0)).toEqual([])
  })

  // After a removal the one row left is a group of one, so it draws no hairline over the gap.
  test('after a removal, the row that brings the address back draws no divider', async () => {
    const tree = await render()
    mockConfirms = true
    const remove = tree.root.findAllByType(GradientButton).find(row => row.props.label === i18n.t('receive.lnRemove'))!
    await ReactTestRenderer.act(async () => {
      remove.props.onPress()
      for (let tick = 0; tick < 6; tick += 1) {
        await Promise.resolve()
      }
    })

    const recreate = tree.root
      .findAllByType(MenuRow)
      .find(row => row.props.label === i18n.t('receive.lnRecreate'))
    expect(recreate).toBeDefined()
    expect(recreate!.props.divider).toBe(false)
  })

  // A removal that fails, or is refused while the wallet's deletion state is not known, says the
  // address could not be removed, never that it could not be created.
  test('a removal that fails says the address could not be removed', async () => {
    const tree = await render()
    jest.mocked(sparkDeleteLnAddress).mockRejectedValueOnce(new Error('deletion state not known yet'))
    mockConfirms = true
    const remove = tree.root.findAllByType(GradientButton).find(row => row.props.label === i18n.t('receive.lnRemove'))!
    await ReactTestRenderer.act(async () => {
      remove.props.onPress()
      for (let tick = 0; tick < 6; tick += 1) {
        await Promise.resolve()
      }
    })

    expect(texts(tree)).toContain(i18n.t('receive.lnRemoveFailed'))
    expect(texts(tree)).not.toContain(i18n.t('receive.lnFailed'))
  })
})

describe('what the sheet is told about the address it replaces', () => {
  const sheetProps = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(LnAddressSheet).props

  test('the address on screen', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValueOnce({ username: 'bob', address: 'bob@usevoltz.app', lnurl: 'l' })
    const tree = await render()
    expect(sheetProps(tree).currentAddress).toBe('bob@usevoltz.app')
    expect(sheetProps(tree).addressUnread).toBe(false)
  })

  test('a read that failed', async () => {
    jest.mocked(sparkEnsureLnAddress).mockRejectedValueOnce(new Error('offline'))
    const tree = await render()
    expect(sheetProps(tree).currentAddress).toBeUndefined()
    expect(sheetProps(tree).addressUnread).toBe(true)
  })

  test('sent here to choose, the sheet waits for the read, since it would not know what it replaces', async () => {
    mockParams = { choose: true }
    let answer!: (addr: null) => void
    jest.mocked(sparkEnsureLnAddress).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<LnAddressScreen />)
    })
    expect(sheetProps(tree).visible).toBe(false)

    await ReactTestRenderer.act(async () => answer(null))
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
    expect(sheetProps(tree).visible).toBe(true)
  })
})
