import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import RNFS from 'react-native-fs'
import '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { savePending } from '../src/wallet/purchase'
import { forgetWalletLines, listLines, noteLine, scopeOn } from '../src/wallet/releasedLines'
import { recoverPurchases, type Recovery } from '../src/wallet/recover'
import { readDeletionOnFocus } from '../src/wallet/deletion'
import { sparkGetIdentityPubkey, sparkGetWalletInfo } from '../src/wallet/spark'

// A kept line leaves the list when the sweep claims it for the card, so a card Home drops before it is
// painted, a switch landing anywhere between the claim and the paint, or the screen going, puts its
// line back in the list of the wallet the sweep asked about, and the next sweep of that wallet says
// it, once. Real recover, purchase and releasedLines modules, on the in-memory file system.

jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: () => 'usevoltz.app',
  getDistribution: () => 'direct',
}))

let mockConnected = 'w_a'
jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => mockConnected,
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: () => () => undefined,
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 61264, tokens: [] })),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkSubscribeToPayments: jest.fn(async () => () => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkTakeLnAddress: jest.fn(),
}))

// The registry's active id and the wallets it lists. A read can carry a switch that lands while it is
// out: the read answers the id it started on, and the switch is announced before it returns.
let mockRegistry = 'w_a'
let mockListed = ['w_a', 'w_b']
let mockDuringRead: (() => void) | null = null
jest.mock('../src/wallet/walletRegistry', () => {
  const getActiveWalletId = jest.fn(async () => {
    const value = mockRegistry
    const during = mockDuringRead
    mockDuringRead = null
    during?.()
    return value
  })
  return {
    getActiveWalletId,
    loadRegistry: jest.fn(async () => {
      const wallets = mockListed.map(id => ({ id, fingerprint: id }))
      return { wallets, active: await getActiveWalletId() }
    }),
  }
})

const mockSwitchListeners = new Set<(id: string) => void>()
jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  onActiveWalletChanged: (cb: (id: string) => void) => {
    mockSwitchListeners.add(cb)
    return () => {
      mockSwitchListeners.delete(cb)
    }
  },
}))

// The real sweep, wrapped so a case can hold its answer or act as it reaches Home.
jest.mock('../src/wallet/recover', () => {
  const actual = jest.requireActual('../src/wallet/recover')
  return { ...actual, recoverPurchases: jest.fn(actual.recoverPurchases) }
})

// Every card that reached the screen, once per card painted, and the props of the latest render.
const mockSaid: string[] = []
let mockCardProps: { onDismiss: () => void } | null = null
jest.mock('../src/components/RecoveredPurchaseCard', () => {
  const react = require('react')
  const actual = jest.requireActual('../src/components/RecoveredPurchaseCard')
  return {
    RecoveredPurchaseCard: (props: { result: { reference: string } | null; onDismiss: () => void }) => {
      mockCardProps = props
      react.useEffect(() => {
        if (props.result) {
          mockSaid.push(props.result.reference)
        }
      }, [props.result])
      return react.createElement(actual.RecoveredPurchaseCard, props)
    },
  }
})

jest.mock('../src/wallet/deletion', () => ({ readDeletionOnFocus: jest.fn(async () => undefined) }))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadDollarInviteSeen: jest.fn(async () => 0),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/store', () => ({
  ...jest.requireActual('../src/wallet/store'),
  storeAvailable: jest.fn(() => false),
  openPurchases: jest.fn(async () => []),
}))

let mockFocusSeq = 0
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: jest.fn() }),
    useFocusEffect: (callback: () => void) => react.useEffect(callback, [callback, mockFocusSeq]),
  }
})

const actualRecover = jest.requireActual('../src/wallet/recover') as typeof import('../src/wallet/recover')

const STORE = `${RNFS.DocumentDirectoryPath}/purchases.json`
const LINES = `${RNFS.DocumentDirectoryPath}/released-lines.json`
const ASKED = `${RNFS.DocumentDirectoryPath}/purchase-asked.json`

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

// Both wallets asked a moment ago, so every sweep here asks the gateway nothing and the card can only
// come from the list.
async function askedJustNow(): Promise<void> {
  const at = Math.floor(Date.now() / 1000)
  await RNFS.writeFile(ASKED, JSON.stringify({ w_a: { at, open: false }, w_b: { at, open: false } }), 'utf8')
}

// The registry moves and the switch is announced, as wallet.ts does; the session reconnects on the
// next focus.
function announce(to: string): void {
  mockRegistry = to
  mockSwitchListeners.forEach(cb => cb(to))
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  return tree
}

async function unmount(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
}

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocusSeq += 1
  await ReactTestRenderer.act(async () => {
    tree.update(<HomeScreen />)
  })
  await settle()
}

// The session on the wallet switched to, then back on the asked wallet with a sweep of each.
async function lookAtBThenA(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockConnected = 'w_b'
  await refocus(tree)
  await ReactTestRenderer.act(async () => {
    announce('w_a')
  })
  mockConnected = 'w_a'
  await refocus(tree)
}

// Runs `onWrite` at the n-th write (1-based) of the file at `path`, as the write goes out, and answers
// the undo.
function atWrite(path: string, n: number, onWrite: () => void): () => void {
  const writeFile = RNFS.writeFile
  let seen = 0
  const spy = jest.spyOn(RNFS, 'writeFile').mockImplementation(async (to: string, text: string, encoding?: string) => {
    if (to.startsWith(path)) {
      seen += 1
      if (seen === n) {
        onWrite()
      }
    }
    return writeFile(to, text, encoding)
  })
  return () => spy.mockRestore()
}

// The same for the removal of the file at `path`, which is how the last record in it is cleared.
function atRemoval(path: string, onRemove: () => void): () => void {
  const unlink = RNFS.unlink
  const spy = jest.spyOn(RNFS, 'unlink').mockImplementation(async (at: string) => {
    if (at === path) {
      spy.mockRestore()
      onRemove()
    }
    return unlink(at)
  })
  return () => spy.mockRestore()
}

const listed = async (walletId: string): Promise<string[]> => (await listLines(walletId)).map(line => line.reference)

beforeEach(async () => {
  jest.clearAllMocks()
  // A case that stops early leaves no held answer or sync state for the next one.
  jest.mocked(recoverPurchases).mockReset().mockImplementation(actualRecover.recoverPurchases)
  jest
    .mocked(sparkGetWalletInfo)
    .mockReset()
    .mockResolvedValue({ sync: 'synced', balanceSat: 61264, tokens: [] } as never)
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  mockSaid.length = 0
  mockConnected = 'w_a'
  mockRegistry = 'w_a'
  mockListed = ['w_a', 'w_b']
  mockDuringRead = null
  mockCardProps = null
  // A proof of the asked wallet whose answer gave the slot up while no view could say it.
  await savePending({ kind: 'name', subject: 'bakery', reference: 'ref-name', amountSats: 12821 })
  await noteLine({ kind: 'name', reference: 'ref-name', answer: 'repaid', subject: 'bakery@usevoltz.app' }, scopeOn('w_a'))
  await askedJustNow()
})

test('control: with no switch the line is said once and leaves the list', async () => {
  const tree = await render()
  expect(mockSaid).toEqual(['ref-name'])
  expect(await listed('w_a')).toEqual([])
  await lookAtBThenA(tree)
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(tree)
})

// Each place a switch can land once the line is claimed: the claim's own write, the look that
// follows it, the two writes that give the slot up, the answer reaching Home, and Home holding the
// answer before it paints it.
const SWITCH_POINTS: [string, () => (() => void) | void][] = [
  ['the claim is written', () => atWrite(LINES, 1, () => announce('w_b'))],
  [
    'the look after the claim is out',
    () =>
      atWrite(LINES, 1, () => {
        mockDuringRead = () => announce('w_b')
      })
  ],
  ['the slot is marked given up', () => atWrite(STORE, 1, () => announce('w_b'))],
  ['the slot is cleared', () => atRemoval(STORE, () => announce('w_b'))],
  [
    'the answer reaches Home',
    () => {
      jest.mocked(recoverPurchases).mockImplementationOnce(deps => {
        const answer = actualRecover.recoverPurchases(deps)
        answer.then(() => announce('w_b'))
        return answer
      })
    },
  ],
]

test.each(SWITCH_POINTS)('a switch as %s leaves the line listed for its wallet, said once there later', async (_, arm) => {
  const disarm = arm()
  const tree = await render()
  disarm?.()
  expect(mockRegistry).toBe('w_b')
  expect(mockSaid).toEqual([])
  expect(await listed('w_a')).toEqual(['ref-name'])
  await lookAtBThenA(tree)
  expect(mockSaid).toEqual(['ref-name'])
  expect(await listed('w_a')).toEqual([])
  await refocus(tree)
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(tree)
})

// The answer is in Home's state and the switch lands before React paints it, so the card is never on
// screen.
test('a switch after Home took the answer and before it painted it puts the line back', async () => {
  let open!: () => void
  jest.mocked(recoverPurchases).mockImplementationOnce(async deps => {
    const card = await actualRecover.recoverPurchases(deps)
    await new Promise<void>(resolve => (open = resolve))
    return card
  })
  const tree = await render()
  expect(await listed('w_a')).toEqual([])
  await ReactTestRenderer.act(async () => {
    open()
    for (let i = 0; i < 20; i++) {
      await Promise.resolve()
    }
    announce('w_b')
  })
  await settle()
  expect(mockSaid).toEqual([])
  expect(await listed('w_a')).toEqual(['ref-name'])
  await lookAtBThenA(tree)
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(tree)
})

test('a screen that goes before the answer lands puts the line back', async () => {
  let open!: () => void
  jest.mocked(recoverPurchases).mockImplementationOnce(async deps => {
    const card = await actualRecover.recoverPurchases(deps)
    await new Promise<void>(resolve => (open = resolve))
    return card
  })
  const tree = await render()
  expect(await listed('w_a')).toEqual([])
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
  await ReactTestRenderer.act(async () => {
    open()
  })
  await settle()
  expect(mockSaid).toEqual([])
  expect(await listed('w_a')).toEqual(['ref-name'])
  const next = await render()
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(next)
})

// Holds the next real sweep's answer until the case opens it.
function holdNextAnswer(): () => void {
  let open: (() => void) | undefined
  jest.mocked(recoverPurchases).mockImplementationOnce(async deps => {
    const card = await actualRecover.recoverPurchases(deps)
    await new Promise<void>(resolve => (open = resolve))
    return card
  })
  return () => open!()
}

async function ticks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve()
  }
}

test('a screen that goes after Home took the answer and before it painted it puts the line back', async () => {
  const open = holdNextAnswer()
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    open()
    await ticks()
    tree.unmount()
  })
  await settle()
  expect(mockSaid).toEqual([])
  expect(await listed('w_a')).toEqual(['ref-name'])
})

// The card is drawn only beside a balance, so an answer that lands while the figure waits for its sync
// is not painted, and a switch then takes it off unseen.
test('an answer that lands while the balance waits for its sync and a switch before it shows puts the line back', async () => {
  jest.mocked(sparkGetWalletInfo).mockResolvedValueOnce({ sync: 'stale', balanceSat: 61264, tokens: [] } as never)
  const open = holdNextAnswer()
  const tree = await render()
  jest.mocked(sparkGetWalletInfo).mockResolvedValueOnce({ sync: 'waiting', balanceSat: 61264, tokens: [] } as never)
  jest.mocked(recoverPurchases).mockResolvedValueOnce(null)
  await refocus(tree)
  await ReactTestRenderer.act(async () => {
    open()
  })
  await settle()
  expect(mockSaid).toEqual([])
  await ReactTestRenderer.act(async () => {
    announce('w_b')
  })
  expect(await listed('w_a')).toEqual(['ref-name'])
  await lookAtBThenA(tree)
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(tree)
})

// A newer answer replaces one not painted yet, and the line behind the older one goes back.
test('a newer card that replaces the answer before it is painted puts the line back', async () => {
  const open = holdNextAnswer()
  const tree = await render()
  const newer: Recovery = { status: 'stuck', kind: 'tier', subject: 'bakery.com.br', reference: 'ref-tier', pubkey: 'k' }
  let openNewer!: () => void
  jest.mocked(recoverPurchases).mockImplementationOnce(() => new Promise(resolve => (openNewer = () => resolve(newer))))
  await refocus(tree)
  await ReactTestRenderer.act(async () => {
    open()
    await ticks()
    openNewer()
    await ticks()
  })
  await settle()
  expect(mockSaid).toEqual(['ref-tier'])
  expect(await listed('w_a')).toEqual(['ref-name'])
  await ReactTestRenderer.act(async () => {
    mockCardProps!.onDismiss()
  })
  await refocus(tree)
  expect(mockSaid).toEqual(['ref-tier', 'ref-name'])
  await unmount(tree)
})

// The card on screen ranks below the line, so the sweep claims the line; the buyer dismisses the
// card on screen before the answer is painted, and the answer goes with it unseen.
test('a dismiss before the answer is painted puts the line back', async () => {
  const shown: Recovery = { status: 'boughtBefore', kind: 'tier', subject: 'bakery.com.br', reference: 'ref-tier', pubkey: 'k' }
  jest.mocked(recoverPurchases).mockResolvedValueOnce(shown)
  const tree = await render()
  expect(mockSaid).toEqual(['ref-tier'])
  const open = holdNextAnswer()
  await refocus(tree)
  expect(await listed('w_a')).toEqual([])
  await ReactTestRenderer.act(async () => {
    open()
    await ticks()
    mockCardProps!.onDismiss()
  })
  await settle()
  expect(mockSaid).toEqual(['ref-tier'])
  expect(await listed('w_a')).toEqual(['ref-name'])
  await refocus(tree)
  expect(mockSaid).toEqual(['ref-tier', 'ref-name'])
  await unmount(tree)
})

// Home picks the wallet the sweep asks about, then reads its key and its deletion mark before the sweep
// starts. A wallet whose lines are forgotten in that window, its data deleted or the wallet removed,
// gets nothing from the sweep: the answer it hears is kept for nobody, and no card is claimed or marked.
describe('a wallet forgotten between Home picking it and the sweep', () => {
  const reply = (status: number, body: unknown): Response =>
    ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response
  let confirms = 0
  const gateway = (async (url: string) => {
    if (url.includes('/api/charges/pending')) {
      return reply(200, { charges: [{ reference: 'ref-name', kind: 'name', domain: 'usevoltz.app', subject: 'bakery', amountSats: 12821 }] })
    }
    if (url.includes('/api/quote/confirm')) {
      confirms += 1
      return reply(409, { paid: true, entitled: false, error: 'paid_but_not_granted', final: true, repaid: true })
    }
    throw new Error(`unrouted ${url}`)
  }) as unknown as typeof fetch

  // The sweep is due and asks the gateway, which answers the kept proof as given back.
  beforeEach(async () => {
    confirms = 0
    await RNFS.unlink(ASKED)
    jest.mocked(recoverPurchases).mockImplementationOnce(deps => actualRecover.recoverPurchases({ ...deps, request: gateway }))
  })

  test('control: with no forget the answer heard is the card, and its reference is marked shown', async () => {
    const tree = await render()
    expect(confirms).toBe(1)
    expect(mockSaid).toEqual(['ref-name'])
    expect(JSON.parse(await RNFS.readFile(LINES, 'utf8'))).toEqual({ w_a: [{ reference: 'ref-name', shown: true }] })
    await unmount(tree)
  })

  test('data deleted while the deletion read is out leaves no line, no mark and no card', async () => {
    jest.mocked(readDeletionOnFocus).mockImplementationOnce(async () => {
      await forgetWalletLines('w_a')
    })
    const tree = await render()
    expect(readDeletionOnFocus).toHaveBeenCalledTimes(1)
    expect(confirms).toBe(1)
    expect(mockSaid).toEqual([])
    expect(await RNFS.exists(LINES)).toBe(false)
    await unmount(tree)
  })

  // A removal unlists the wallet before it forgets its lines (wallet.ts, removeWallet). One that finished
  // before Home read the list, with the session still on the removed wallet, leaves it unlisted there,
  // and Home asks nothing for it.
  test('a wallet removed before Home reads the list gets no sweep and no line under its id', async () => {
    mockRegistry = 'w_b'
    mockListed = ['w_b']
    await forgetWalletLines('w_a')
    expect(await RNFS.exists(LINES)).toBe(false)
    const tree = await render()
    expect(await RNFS.exists(LINES)).toBe(false)
    expect(recoverPurchases).not.toHaveBeenCalled()
    expect(confirms).toBe(0)
    await unmount(tree)
  })

  // A removal switches away first (wallet.ts, removeActiveWallet), then forgets.
  test('a wallet removed while its key is read gets no line kept under its id', async () => {
    jest.mocked(sparkGetIdentityPubkey).mockImplementationOnce(async () => {
      announce('w_b')
      await forgetWalletLines('w_a')
      return `02${'a'.repeat(64)}`
    })
    const tree = await render()
    expect(confirms).toBe(1)
    expect(mockSaid).toEqual([])
    expect(await RNFS.exists(LINES)).toBe(false)
    await unmount(tree)
  })
})

// A card already painted is said, and a switch that takes it off the screen gives nothing back.
test('a switch after the card was painted puts nothing back', async () => {
  const tree = await render()
  expect(mockSaid).toEqual(['ref-name'])
  await ReactTestRenderer.act(async () => {
    announce('w_b')
  })
  expect(await listed('w_a')).toEqual([])
  await lookAtBThenA(tree)
  expect(mockSaid).toEqual(['ref-name'])
  await unmount(tree)
})

