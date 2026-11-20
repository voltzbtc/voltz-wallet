import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AppState, Text } from 'react-native'
import '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { connectActiveSpark, sparkGetWalletInfo } from '../src/wallet/spark'
import { recoverPurchases, type Recovery } from '../src/wallet/recover'
import { readDeletionOnFocus } from '../src/wallet/deletion'

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
}))

// Home reads the active id with the list of wallets, both listed here; the active id is the double's.
jest.mock('../src/wallet/walletRegistry', () => {
  const readActive = jest.fn(async () => 'w_a')
  return {
    getActiveWalletId: readActive,
    loadRegistry: jest.fn(async () => ({
      wallets: [{ id: 'w_a', fingerprint: 'fa' }, { id: 'w_b', fingerprint: 'fb' }],
      active: await readActive(),
    })),
  }
})

jest.mock('../src/wallet/recover', () => ({
  recoverPurchases: jest.fn(async () => null),
  putBackCard: jest.fn(async () => undefined),
}))

jest.mock('../src/wallet/deletion', () => ({ readDeletionOnFocus: jest.fn(async () => undefined) }))

jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  loadDollarInviteSeen: jest.fn(async () => 0),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))

// The real hook runs its callback again every time the screen regains focus. `load` keeps a stable
// identity across renders, so a second focus has to be driven explicitly.
let mockFocusSeq = 0
const mockNavigate = jest.fn()
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: mockNavigate }),
    useFocusEffect: (callback: () => void) =>
      react.useEffect(callback, [callback, mockFocusSeq]),
  }
})

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocusSeq += 1
  await ReactTestRenderer.act(async () => {
    tree.update(<HomeScreen />)
  })
  await settle()
}

const PUBKEY = `02${'a'.repeat(64)}`

// Every listener the app registered for AppState changes, called as the platform calls them.
function appMovesTo(state: 'active' | 'background' | 'inactive'): void {
  for (const [event, listener] of jest.mocked(AppState.addEventListener).mock.calls) {
    if (event === 'change') {
      ;(listener as (next: string) => void)(state)
    }
  }
}

const READY = {
  status: 'ready' as const,
  kind: 'name' as const,
  subject: 'bakery@usevoltz.app',
  reference: 'ref-1',
  pubkey: PUBKEY,
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  await settle()
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 61264, tokens: [] })
  jest.mocked(recoverPurchases).mockResolvedValue(null)
})

test('a wallet owed nothing sees the screen it always saw', async () => {
  const tree = await render()
  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('Your address is ready')
  expect(shown).not.toContain('A payment is still landing')
  expect(shown).not.toMatch(/paid/i)
})

test('the ask waits for a load that worked, since it is signed by the wallet key', async () => {
  jest.mocked(connectActiveSpark).mockRejectedValueOnce(new Error('offline'))
  await render()
  expect(recoverPurchases).not.toHaveBeenCalled()
})

test("an imported seed's deletion status is read before anything is recovered for it", async () => {
  await render()
  expect(readDeletionOnFocus).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'w_a', pubkey: `02${'a'.repeat(64)}` }))
  expect(jest.mocked(readDeletionOnFocus).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(recoverPurchases).mock.invocationCallOrder[0],
  )
})

// A deletion asked from this device can finish while the app is closed or on another screen, and
// its local cleanup and the done mark wait on a status read, so the read is made on every focus, the
// first open included, not only on the deletion screen.
test('the deletion status is read again on every focus', async () => {
  const tree = await render()
  expect(readDeletionOnFocus).toHaveBeenCalledTimes(1)
  await refocus(tree)
  expect(readDeletionOnFocus).toHaveBeenCalledTimes(2)
})

// Right after a switch the registry is on the new wallet while the session still signs as the
// previous one, and an answer for that key would be written as this wallet's mark.
test('no deletion read is made while the session signs as another wallet', async () => {
  mockConnected = 'w_b'
  await render()
  expect(readDeletionOnFocus).not.toHaveBeenCalled()
  expect(recoverPurchases).toHaveBeenCalled()
  mockConnected = 'w_a'
})

test('a deletion read that fails still lets the purchases be asked', async () => {
  jest.mocked(readDeletionOnFocus).mockRejectedValueOnce(new Error('offline'))
  await render()
  expect(recoverPurchases).toHaveBeenCalled()
})

test('a purchase picked back up says so on the first screen, with no tap', async () => {
  jest.mocked(recoverPurchases).mockResolvedValue(READY)
  const tree = await render()
  expect(texts(tree)).toContain('Your address is ready')
})

// The throttle answers null on the very next focus. Reading that as a card being withdrawn would
// take the only place in the app that says this off the screen a tab switch after it arrived.
test('a later ask that was throttled does not take the card away', async () => {
  jest.mocked(recoverPurchases).mockResolvedValueOnce(READY).mockResolvedValue(null)
  const tree = await render()
  expect(texts(tree)).toContain('Your address is ready')
  await refocus(tree)
  expect(recoverPurchases).toHaveBeenCalledTimes(2)
  expect(texts(tree)).toContain('Your address is ready')
})

// The sweep weighs the card on screen against a kept line, so it is handed the card each focus shows.
test('each later ask is handed the card on screen, and none before one arrived', async () => {
  const STUCK = { ...READY, status: 'stuck' as const }
  jest.mocked(recoverPurchases).mockResolvedValueOnce(STUCK).mockResolvedValue(null)
  const tree = await render()
  expect(texts(tree)).toContain('Your payment needs a hand')
  await refocus(tree)
  expect(jest.mocked(recoverPurchases).mock.calls.map(([deps]) => deps.showing)).toEqual([null, STUCK])
})

// A card painted while the app is away is seen by nobody, so the sweep is told a card would be seen
// only while the app is in the foreground.
test('the sweep is told a card would be seen only while the app is in the foreground', async () => {
  await render()
  const [deps] = jest.mocked(recoverPurchases).mock.calls[0]!
  expect(deps.onScreen?.()).toBe(true)
  appMovesTo('background')
  expect(deps.onScreen?.()).toBe(false)
  appMovesTo('active')
  expect(deps.onScreen?.()).toBe(true)
  // What the app switcher or a call covers is not being read either.
  appMovesTo('inactive')
  expect(deps.onScreen?.()).toBe(false)
})

// A charge another wallet's reservation holds up reads as landing, and the next ask can find it
// refused for good. Whichever sweep answers last says what is true now, in either order.
describe('a payment whose answer changes between asks', () => {
  const LANDING = { ...READY, status: 'settling' as const }
  const STUCK = { ...READY, status: 'stuck' as const }

  test('a later ask that finds it refused for good replaces the landing card', async () => {
    jest.mocked(recoverPurchases).mockResolvedValueOnce(LANDING).mockResolvedValueOnce(STUCK)
    const tree = await render()
    expect(texts(tree)).toContain('A payment is still landing')
    await refocus(tree)
    expect(texts(tree)).toContain('Your payment needs a hand')
    expect(texts(tree)).not.toContain('A payment is still landing')
  })

  for (const [first, last, line] of [
    [LANDING, STUCK, 'Your payment needs a hand'],
    [STUCK, LANDING, 'A payment is still landing'],
  ] as const) {
    test(`two sweeps out at once show the one that answers last, ${last.status}`, async () => {
      const answers: Array<(found: typeof READY | typeof LANDING | typeof STUCK) => void> = []
      jest.mocked(recoverPurchases).mockImplementation(() => new Promise(resolve => answers.push(resolve)))
      const tree = await render()
      await refocus(tree)
      expect(answers).toHaveLength(2)
      await ReactTestRenderer.act(async () => {
        answers[1]!(first)
      })
      await settle()
      await ReactTestRenderer.act(async () => {
        answers[0]!(last)
      })
      await settle()
      expect(texts(tree)).toContain(line)
    })
  }
})

test('a sweep that threw costs the screen nothing', async () => {
  jest.mocked(recoverPurchases).mockRejectedValue(new Error('Network request failed'))
  const tree = await render()
  // Whatever digit grouping the locale uses, the balance is still the thing on screen.
  expect(texts(tree).join(' ')).toMatch(/61.264/)
})

test('a name paid for in the store and not chosen opens the address screen on choosing it', async () => {
  jest.mocked(recoverPurchases).mockResolvedValue({ ...READY, status: 'credit', subject: 'usevoltz.app', reference: '' })
  const tree = await render()
  expect(texts(tree)).toContain('A name is waiting for you')
  const choose = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === 'Choose a name'))!
  await ReactTestRenderer.act(async () => {
    choose.props.onPress()
  })
  expect(mockNavigate).toHaveBeenCalledWith('LnAddress', { choose: true })
  expect(texts(tree)).not.toContain('A name is waiting for you')
})

// A card about a payment still in its slot stands on that proof, and the address sheet, the domain
// screen and the sweep share the slot. Once another reader gives the proof up or delivers its charge,
// the card goes, whichever way it left; a card about another payment, or about a final answer, stays.
describe('a card whose proof another reader took out of its slot', () => {
  const purchase = jest.requireActual('../src/wallet/purchase') as typeof import('../src/wallet/purchase')
  const onboard = jest.requireActual('../src/wallet/domainOnboard') as typeof import('../src/wallet/domainOnboard')
  const RNFS = (
    require('react-native-fs') as {
      default: { DocumentDirectoryPath: string; exists(p: string): Promise<boolean>; unlink(p: string): Promise<void> }
    }
  ).default
  const LANDING_LINE = 'A payment is still landing'
  const NAME = { kind: 'name' as const, subject: 'bakery', reference: 'ref-1', amountSats: 19800 }
  const YEAR = { host: 'pay.bakery.com.br', reference: 'ref-1', amountSats: 199800 }

  beforeEach(async () => {
    for (const file of ['purchases.json', 'domain-purchase.json']) {
      const path = `${RNFS.DocumentDirectoryPath}/${file}`
      if (await RNFS.exists(path)) {
        await RNFS.unlink(path)
      }
    }
  })

  // The card a sweep put up, and a later sweep that has nothing new, as the throttle answers.
  async function showing(card: Recovery): Promise<ReactTestRenderer.ReactTestRenderer> {
    jest.mocked(recoverPurchases).mockResolvedValueOnce(card)
    const tree = await render()
    jest.mocked(recoverPurchases).mockResolvedValue(null)
    return tree
  }

  async function meanwhile(tree: ReactTestRenderer.ReactTestRenderer, work: () => Promise<unknown>): Promise<string> {
    await ReactTestRenderer.act(async () => {
      await work()
    })
    await refocus(tree)
    return texts(tree).join(' ')
  }

  test('a landing card goes once another reader gives its proof up', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, status: 'settling' })
    expect(texts(tree).join(' ')).toContain(LANDING_LINE)
    const shown = await meanwhile(tree, () => purchase.releasePending('name', 'ref-1', 'repaid'))
    expect(shown).not.toContain(LANDING_LINE)
  })

  test('a landing card goes once another reader delivers its name', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, status: 'settling' })
    const shown = await meanwhile(tree, () => purchase.clearGranted('name', 'ref-1'))
    expect(shown).not.toContain(LANDING_LINE)
  })

  test('a landing card for a year goes once another reader delivers the year', async () => {
    await onboard.savePendingPurchase(YEAR)
    const tree = await showing({ ...READY, kind: 'tier', subject: YEAR.host, status: 'settling' })
    expect(texts(tree).join(' ')).toContain(LANDING_LINE)
    const shown = await meanwhile(tree, () => onboard.clearGrantedPurchase('ref-1', { expiresAt: 1_800_000_000, frozen: false }))
    expect(shown).not.toContain(LANDING_LINE)
  })

  test('a name that waits on the address screen goes once the address sheet takes it', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, status: 'waiting' })
    expect(texts(tree).join(' ')).toContain('bakery@usevoltz.app is yours to take')
    const shown = await meanwhile(tree, () => purchase.clearGranted('name', 'ref-1'))
    expect(shown).not.toContain('is yours to take')
  })

  test('a landing card about another payment stays', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, reference: 'ref-2', status: 'settling' })
    const shown = await meanwhile(tree, async () => {
      await purchase.releasePending('name', 'ref-1', 'repaid')
      await onboard.savePendingPurchase(YEAR)
      await onboard.clearGrantedPurchase('ref-1', { expiresAt: 1_800_000_000, frozen: false })
    })
    expect(shown).toContain(LANDING_LINE)
  })

  test('a landing card for a year stays once a name proof leaves', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, kind: 'tier', subject: YEAR.host, status: 'settling' })
    const shown = await meanwhile(tree, () => purchase.releasePending('name', 'ref-1', 'repaid'))
    expect(shown).toContain(LANDING_LINE)
  })

  // A final answer's card is the line a reader claimed and said, which a later write never takes back.
  test('a card about a final answer stays once its proof leaves', async () => {
    await purchase.savePending(NAME)
    const tree = await showing({ ...READY, status: 'repaid' })
    const shown = await meanwhile(tree, () => purchase.releasePending('name', 'ref-1', 'repaid'))
    expect(shown).toContain('Your payment for bakery@usevoltz.app was given back')
  })
})
