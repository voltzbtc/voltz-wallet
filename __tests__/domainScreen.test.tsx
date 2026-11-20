import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import fs from 'fs'
import path from 'path'
import i18n from '../src/i18n'
import { DomainScreen } from '../src/screens/DomainScreen'
import { MenuRow } from '../src/components/MenuRow'
import { sparkEnsureLnAddress, sparkGetIdentityPubkey } from '../src/wallet/spark'
import { readDomainState, type DomainState } from '../src/wallet/domainTier'
import { moveDomain } from '../src/wallet/domainMove'
import { switchWalletAndConnect } from '../src/wallet/wallet'
import { getActiveWalletId, loadRegistry } from '../src/wallet/walletRegistry'
import { loadWalletMeta } from '../src/wallet/walletMeta'
import { type ConfirmRequest } from '../src/components/ConfirmSheet'
import { ErrorBox } from '../src/components/ErrorBox'

const mockNavigate = jest.fn()
// The screen's read, kept so a case can bring the screen into focus again.
let mockFocus: (() => void) | null = null

// Captured rather than rendered, since the sheet is a Modal that loads the registry of its own, and
// what this screen owes it is which wallets it may offer and what it does with the answer.
type PickerProps = {
  visible: boolean
  title: string
  excludeWalletId?: string
  asking: ConfirmRequest | null
  onClose: () => void
  onPick: (walletId: string) => void
}
let mockPicker: PickerProps | null = null

jest.mock('../src/components/WalletPickerSheet', () => ({
  WalletPickerSheet: (props: PickerProps) => {
    mockPicker = props
    return null
  },
}))

jest.mock('../src/wallet/domainMove', () => ({
  ...jest.requireActual('../src/wallet/domainMove'),
  moveDomain: jest.fn(async () => 4),
}))

jest.mock('../src/wallet/walletMeta', () => ({
  ...jest.requireActual('../src/wallet/walletMeta'),
  loadWalletMeta: jest.fn(async () => null),
}))

jest.mock('../src/wallet/spark', () => ({
  // The withdrawal section the screen draws reads and listens for the connected wallet.
  sparkConnectedWalletId: () => null,
  onSparkConnected: () => () => undefined,
  sparkEnsureLnAddress: jest.fn(),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
  loadRegistry: jest.fn(async () => ({ active: 'primary', wallets: [] })),
}))

// The read stays mocked but the role stays real data: the screen is asked to choose from a body the
// gateway could actually send, not from a boolean the test invented.
jest.mock('../src/wallet/domainTier', () => ({
  ...jest.requireActual('../src/wallet/domainTier'),
  readDomainState: jest.fn(async () => null),
}))

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate }),
  // The real hook needs a navigation container; the screen only uses it to run its reads on arrival.
  useFocusEffect: (cb: () => void | (() => void)) => {
    mockFocus = () => {
      cb()
    }
    const React_ = jest.requireActual('react')
    React_.useEffect(cb, [])
  },
}))

const HOST = 'pay.example.com'
const BUILD = 'usevoltz.app'
// Declared here rather than inherited from whatever .env the machine happens to have. `@env` is
// inlined by babel at transform time, so a test that reads it through config asserts about the
// developer's own file: it passes on a machine that has a .env and fails on a CI runner, which has
// none, against `https://undefined`. The screen takes only this one value from config, so the
// double is the whole of what it reads.
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'usevoltz.app' }))
const NOW = 1_800_000_000

// Read from the locale rather than from t(), so a row borrowing a neighbouring label cannot agree
// with the assertion.
const en = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'locales', 'en-US.json'), 'utf8'),
) as { domain: Record<string, string> }

// The fixed half of `domain.current`, cut at its placeholder. Typing the sentence out instead would
// make both absence assertions below pass for good the day the wording changes, which is the one
// failure an absence assertion cannot show.
const CURRENT_LINE = en.domain.current.split('{{')[0].trim()

function state(over: Partial<DomainState> = {}): DomainState {
  return {
    host: HOST,
    role: 'owner',
    kind: 'customer',
    expiresAt: NOW + 200 * 86_400,
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

// Pressable is not findable by type in RN 0.86, so a row is located by its label and its handler.
function row(
  tree: ReactTestRenderer.ReactTestRenderer,
  label: string,
): ReactTestRenderer.ReactTestInstance | null {
  const buttons = tree.root.findAll(
    node => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function',
  )
  return (
    buttons.find(button => button.findAllByType(Text).some(text => text.props.children === label)) ??
    null
  )
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<DomainScreen />)
  })
  // The status read is three awaits deep (active wallet, identity key, the answer), so one flush
  // would assert against a screen that has not heard back yet.
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 6; tick += 1) {
      await Promise.resolve()
    }
  })
  return tree
}

const TARGET_NAME = 'Bakery till'

// The one tap that defends itself, taken as a person confirming does: the picker closes, then the
// handover runs.
async function confirmHandover(): Promise<void> {
  const asked = mockPicker?.asking
  await ReactTestRenderer.act(async () => {
    mockPicker?.onClose()
    asked?.onConfirm(false)
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })
}

// Presses the move row and answers the picker with the wallet the domain is being handed to.
async function pick(
  tree: ReactTestRenderer.ReactTestRenderer,
  walletId = 'w_till',
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    row(tree, en.domain.move)?.props.onPress()
  })
  await ReactTestRenderer.act(async () => {
    mockPicker?.onPick(walletId)
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockPicker = null
  jest.mocked(loadRegistry).mockResolvedValue({
    active: 'primary',
    wallets: [
      { id: 'primary', fingerprint: 'aaaa1111' },
      { id: 'w_till', fingerprint: 'bbbb2222' },
    ],
  } as Awaited<ReturnType<typeof loadRegistry>>)
  jest.mocked(loadWalletMeta).mockResolvedValue({ name: TARGET_NAME })
  jest.mocked(moveDomain).mockResolvedValue(4)
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'alice',
    address: `alice@${BUILD}`,
    lnurl: 'lnurl1',
  })
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(`02${'a'.repeat(64)}`)
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(readDomainState).mockResolvedValue(null)
})

// This screen is where someone comes to change domains, so it names the one they are on rather than
// leaving them to read the address on another screen.
it('says which domain the address is on, even when the wallet does not own it', async () => {
  const shown = texts(await render()).join(' ')

  // Both halves of the line, so the constant the two absence assertions rely on is itself pinned to
  // something the screen really renders.
  expect(shown).toContain(CURRENT_LINE)
  expect(shown).toContain(BUILD)
})

// Almost every wallet is here. readDomainState answers them without a round trip, so the screen has
// no status at all and must look exactly like a screen that knows nothing about domain ownership.
it('offers a wallet on the shared domain neither owner row', async () => {
  const tree = await render()

  expect(row(tree, en.domain.renew)).toBeNull()
  expect(row(tree, en.domain.allowed)).toBeNull()
  expect(row(tree, en.domain.move)).toBeNull()
  expect(texts(tree).join(' ')).toContain(en.domain.request)
})

it('shows the owner their domain, the wallets on it and a way to renew', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'bakery',
    address: `bakery@${HOST}`,
    lnurl: 'l',
  })
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()

  expect(texts(tree).join(' ')).toContain(HOST)
  expect(row(tree, en.domain.allowed)).not.toBeNull()
  expect(row(tree, en.domain.renew)).not.toBeNull()
})

// The owner rows are gated on the answer about the role, not on a route that happened to succeed.
it('offers a member neither owner row, and leaves the rest of the screen alone', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'staff',
    address: `staff@${HOST}`,
    lnurl: 'l',
  })
  jest.mocked(readDomainState).mockResolvedValue(state({ role: 'member' }))

  const tree = await render()

  expect(row(tree, en.domain.renew)).toBeNull()
  expect(row(tree, en.domain.allowed)).toBeNull()
  // A wallet let into somebody else's domain must not be able to hand that domain to a third one.
  expect(row(tree, en.domain.move)).toBeNull()
  // A member keeps the domain their address is on, and both ways in. Hiding an owner's control
  // from them must not cost them the screen.
  const shown = texts(tree).join(' ')
  expect(shown).toContain(HOST)
  expect(shown).toContain(en.domain.request)
})

// A frozen domain takes the hostname off the edge, so sparkEnsureLnAddress can answer nothing at
// all. Ownership is read from the status, so the owner keeps the row that renews the thing.
it('still offers the owner the renewal when there is no address to read', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  jest.mocked(readDomainState).mockResolvedValue(state({ frozenAt: NOW - 60, expiresAt: NOW - 600 }))

  const tree = await render()

  expect(row(tree, en.domain.renew)).not.toBeNull()
  // The domain is still named, by the row that carries it, so the button is never unlabelled work.
  expect(texts(tree).join(' ')).toContain(HOST)
  expect(texts(tree).join(' ')).not.toContain(CURRENT_LINE)
})

it('sends the renewal to the domain the gateway named, not the one the address ends in', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({
    username: 'bakery',
    address: `bakery@${BUILD}`,
    lnurl: 'l',
  })
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()
  ReactTestRenderer.act(() => row(tree, en.domain.renew)?.props.onPress())

  expect(mockNavigate).toHaveBeenCalledWith('UseMyDomain', { renew: HOST })
})

// Focus reads the address again, and a read that fails says nothing about where it sits.
it('keeps naming the domain when a later read of the address fails', async () => {
  const tree = await render()
  expect(texts(tree).join(' ')).toContain(CURRENT_LINE)

  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('spark not connected'))
  await ReactTestRenderer.act(async () => {
    mockFocus?.()
    for (let tick = 0; tick < 6; tick += 1) {
      await Promise.resolve()
    }
  })

  expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(2)
  const shown = texts(tree).join(' ')
  expect(shown).toContain(CURRENT_LINE)
  expect(shown).toContain(BUILD)
})

it('says nothing about a domain when there is no address yet', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)

  const shown = texts(await render()).join(' ')

  expect(shown).not.toContain(CURRENT_LINE)
})

// The move takes three taps and no typing, on the row, the wallet and the confirmation. A key typed
// by hand into this flow would lose a domain for good on one wrong character.
it('offers the owner the move, and asks which wallet from the list of this device', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()
  expect(row(tree, en.domain.move)).not.toBeNull()

  await ReactTestRenderer.act(async () => {
    row(tree, en.domain.move)?.props.onPress()
  })

  expect(mockPicker?.visible).toBe(true)
  expect(mockPicker?.title).toBe(en.domain.movePick)
  // The wallet handing it over is not one of the answers, and it is read from the registry rather
  // than assumed, so the list cannot offer a handover to the wallet already holding the domain.
  expect(mockPicker?.excludeWalletId).toBe('primary')
})

// The handover ends on the wallet that now owns the domain. Its address read can fail, and a failed
// read keeps whatever domain is named, which was the previous wallet's.
it('after a handover that ended on another wallet, a failed address read names no domain', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({ username: 'bakery', address: `bakery@${HOST}`, lnurl: 'l' })
  jest.mocked(readDomainState).mockResolvedValue(state())
  const tree = await render()
  expect(texts(tree).join(' ')).toContain(CURRENT_LINE)

  await pick(tree)
  jest.mocked(getActiveWalletId).mockResolvedValue('w_till')
  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))
  await confirmHandover()
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })

  expect(moveDomain).toHaveBeenCalledTimes(1)
  expect(texts(tree).join(' ')).not.toContain(CURRENT_LINE)
})

// A refusal leaves the walk on the wallet it started from, whose domain is still the one named.
it('after a handover refused on the same wallet, the domain named stays named', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({ username: 'bakery', address: `bakery@${HOST}`, lnurl: 'l' })
  jest.mocked(readDomainState).mockResolvedValue(state())
  jest.mocked(moveDomain).mockRejectedValue(new Error('stale_transfer_seq'))
  const tree = await render()

  await pick(tree)
  jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))
  await confirmHandover()
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })

  expect(texts(tree).join(' ')).toContain(CURRENT_LINE)
  expect(texts(tree).join(' ')).toContain(HOST)
})

it('a handover refused after the screen closed tells its reason on the next open', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue({ username: 'bakery', address: `bakery@${HOST}`, lnurl: '' } as never)
  jest.mocked(readDomainState).mockResolvedValue(state())
  let refuse!: (err: Error) => void
  jest.mocked(moveDomain).mockReturnValue(new Promise((_, reject) => (refuse = reject)))
  const tree = await render()

  await pick(tree)
  await confirmHandover()
  await ReactTestRenderer.act(async () => tree.unmount())
  await ReactTestRenderer.act(async () => {
    refuse(new Error('stale_transfer_seq'))
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })

  jest.mocked(moveDomain).mockReset()
  const next = await render()
  const lines = texts(next).join(' ')
  expect(lines).toContain(i18n.t('domain.moveStale'))
  await ReactTestRenderer.act(async () => next.unmount())

  const after = await render()
  expect(texts(after).join(' ')).not.toContain(i18n.t('domain.moveStale'))
})

it('moves nothing when the question is left, and the next open starts on the list', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()
  await pick(tree)
  await ReactTestRenderer.act(async () => mockPicker?.onClose())

  expect(moveDomain).not.toHaveBeenCalled()
  expect(mockPicker?.visible).toBe(false)
  expect(mockPicker?.asking).toBeNull()

  await ReactTestRenderer.act(async () => {
    row(tree, en.domain.move)?.props.onPress()
  })
  expect(mockPicker?.visible).toBe(true)
  expect(mockPicker?.asking).toBeNull()
})

it('names both the domain and the wallet before anything is signed', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()
  await pick(tree)

  expect(mockPicker?.asking?.title).toContain(HOST)
  // The title names the wallet, never its id or its key, because the person is being asked to
  // recognise a wallet and 66 characters of hex is not something anybody checks by eye.
  expect(mockPicker?.asking?.title).toContain(TARGET_NAME)
  expect(mockPicker?.asking?.body).toBe(en.domain.moveBody)
  expect(mockPicker?.asking?.danger).toBe(true)
  expect(moveDomain).not.toHaveBeenCalled()
})

it('hands the domain over on the connecting switch, with the sequence the gateway answered', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state({ transferSeq: 5 }))

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  expect(moveDomain).toHaveBeenCalledTimes(1)
  const [deps, move] = jest.mocked(moveDomain).mock.calls[0]!
  expect(move).toEqual({
    host: HOST,
    fromWalletId: 'primary',
    toWalletId: 'w_till',
    // From the state read, and refused as stale when the domain moved since. A number invented here
    // would either be refused or, worse, sign away a domain in a state nobody saw.
    transferSeq: 5,
    frozen: false,
  })
  // The switch that reconnects. The one that only repoints the registry leaves the SDK on the
  // wallet the walk started from, which then signs both halves of the handover.
  expect(deps.switchTo).toBe(switchWalletAndConnect)
  // Addressed at the shared build domain, because a frozen domain is off the edge.
  expect(deps.gatewayUrl).toBe(`https://${BUILD}`)
})

it('hands over a frozen domain without pointing the new owner at a hostname that is gone', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  jest.mocked(readDomainState).mockResolvedValue(state({ frozenAt: NOW - 60, expiresAt: NOW - 600 }))

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  // The phase is derived from the gateway's clock, and it is what stops the new owner being pointed
  // at a host that answers nothing, which would leave that wallet with no address at all.
  expect(jest.mocked(moveDomain).mock.calls[0]![1]).toMatchObject({ frozen: true })
})

// The freeze is the state a handover is most likely to happen in, and the one where the new owner
// has nothing on the device tying them to the domain: the preference is deliberately not written,
// and readDomainState reads the host from exactly that preference. Without the answer being carried
// across, the owner rows vanish the instant the move succeeds, and with them the only route to the
// renewal. Retyping the domain is not a way back: the gateway refuses to claim a lapsed year
// (`domain_tier_not_paid`), so the purchase path cannot reach it either.
it('leaves the renewal in front of the wallet that has just been handed a frozen domain', async () => {
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  jest
    .mocked(readDomainState)
    .mockResolvedValueOnce(state({ frozenAt: NOW - 60, expiresAt: NOW - 600 }))
    // What the real read answers for a wallet with no domain of its own, which is what the wallet
    // receiving a frozen domain is.
    .mockResolvedValue(null)

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  expect(row(tree, en.domain.renew)).not.toBeNull()
  ReactTestRenderer.act(() => row(tree, en.domain.renew)?.props.onPress())
  expect(mockNavigate).toHaveBeenCalledWith('UseMyDomain', { renew: HOST })
})

// The wallet receiving the domain may already own one of its own, and then the read does have a
// host to ask about and answers for that one. What the gateway says outranks anything carried
// across: the carried answer exists only for the case where there is nothing to ask.
it('prefers what the gateway says about the new owner to the answer carried across', async () => {
  const OTHER = 'pay.shop.com.br'
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
  jest
    .mocked(readDomainState)
    .mockResolvedValueOnce(state({ frozenAt: NOW - 60, expiresAt: NOW - 600 }))
    .mockResolvedValue(state({ host: OTHER }))

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  const shown = texts(tree).join(' ')
  expect(shown).toContain(OTHER)
  expect(shown).not.toContain(HOST)
})

// The gateway bumps the sequence on every handover, so the number carried across has to be the one
// it answered. Signing the old one would have the second move refused as stale, which reads to the
// owner as the domain having been taken by somebody else.
it('carries the sequence the gateway answered, so the domain can be moved on again', async () => {
  jest
    .mocked(readDomainState)
    .mockResolvedValueOnce(state({ frozenAt: NOW - 60, expiresAt: NOW - 600, transferSeq: 3 }))
    .mockResolvedValue(null)
  jest.mocked(moveDomain).mockResolvedValue(4)

  const tree = await render()
  await pick(tree)
  await confirmHandover()
  await pick(tree)
  await confirmHandover()

  expect(jest.mocked(moveDomain).mock.calls[1]![1]).toMatchObject({ transferSeq: 4 })
})

it('reads the state again once the domain has moved, since the wallet holding it has changed', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  // The walk ends connected to the wallet that now owns the domain, so every answer on screen was
  // read for a wallet that no longer does.
  expect(readDomainState).toHaveBeenCalledTimes(2)
})

it('says the domain was not moved when it was not, and asks the gateway who owns it now', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())
  jest.mocked(moveDomain).mockRejectedValue(new Error('stale_transfer_seq'))

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  // The specific refusal is asserted, not the generic one, because a stale sequence is worth
  // retrying and the generic message does not say so, while a renewal in progress must NOT be
  // retried. Asserting the generic one here would pass against a screen that had stopped telling
  // them apart.
  expect(tree.root.findByType(ErrorBox).props.message).toBe(en.domain.moveStale)
  // A stale sequence means somebody moved this domain while the screen was open, and only the
  // gateway can say who holds it now. Without the second read the owner rows would still be there.
  expect(readDomainState).toHaveBeenCalledTimes(2)
})

it('takes a refusal off the screen when the next handover starts', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())
  jest.mocked(moveDomain).mockRejectedValueOnce(new Error('stale_transfer_seq'))

  const tree = await render()
  await pick(tree)
  await confirmHandover()
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 8; tick += 1) {
      await Promise.resolve()
    }
  })
  expect(texts(tree).join(' ')).toContain(en.domain.moveStale)

  await pick(tree)
  await confirmHandover()
  expect(texts(tree).join(' ')).not.toContain(en.domain.moveStale)
})

it('cannot be started twice while the wallets are still reconnecting', async () => {
  jest.mocked(readDomainState).mockResolvedValue(state())
  let finish: (seq: number) => void = () => undefined
  jest.mocked(moveDomain).mockReturnValue(new Promise(resolve => (finish = resolve)))

  const tree = await render()
  await pick(tree)
  await confirmHandover()

  // The row carries the leg that is running, so three reconnects do not read as a hang, and it
  // stops being the row that opens the picker.
  expect(row(tree, en.domain.move)).toBeNull()
  const running = row(tree, en.domain.moveStepReading)
  expect(running).not.toBeNull()
  // The row is still on screen and still pressable, so the guard has to be on the press itself. A
  // second walk started under the first reconnects the SDK beneath it, and whichever leg is in the
  // air then signs with a wallet that is not the one the gateway will check.
  await ReactTestRenderer.act(async () => {
    running?.props.onPress()
  })
  expect(mockPicker?.visible).toBe(false)
  await ReactTestRenderer.act(async () => {
    finish(4)
  })
})

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

describe('the rows form one group', () => {
  it('for a wallet on the shared domain', async () => {
    const gaps = dividerGaps(await render())

    expect(gaps.length).toBeGreaterThan(0)
    expect(gaps.filter(entry => entry.gap !== 0)).toEqual([])
  })

  it('for the owner, whose rows come first', async () => {
    jest.mocked(readDomainState).mockResolvedValue(state())
    const gaps = dividerGaps(await render())

    expect(gaps.map(entry => entry.label)).toContain(en.domain.renew)
    expect(gaps.filter(entry => entry.gap !== 0)).toEqual([])
  })
})
