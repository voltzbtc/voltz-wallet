import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { recoverPurchases, type Recovery } from '../src/wallet/recover'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { readDeletionOnFocus } from '../src/wallet/deletion'
import { sparkGetIdentityPubkey } from '../src/wallet/spark'

// A card is about the payment of the wallet whose key asked, and Home shows the wallet the registry
// names. A switch while the sweep is out, or with a card already up, leaves no card of the previous
// wallet on the one switched to, and a sweep started right after a switch, while the session still
// signs as the previous wallet, asks as that wallet.

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

// The switch announcement as wallet.ts makes it, called by the case at the moment it chooses.
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

let mockFocusSeq = 0
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: jest.fn() }),
    useFocusEffect: (callback: () => void) => react.useEffect(callback, [callback, mockFocusSeq]),
  }
})

const READY: Recovery = {
  status: 'ready',
  kind: 'name',
  subject: 'bakery@usevoltz.app',
  reference: 'ref-1',
  pubkey: `02${'a'.repeat(64)}`,
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

// The registry and then the session move to `to`, the announcement in between, as a switch and the
// next focus's reconnect do.
async function switchTo(to: string): Promise<void> {
  jest.mocked(getActiveWalletId).mockResolvedValue(to)
  await ReactTestRenderer.act(async () => {
    mockSwitchListeners.forEach(cb => cb(to))
  })
  mockConnected = to
}

async function refocus(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  mockFocusSeq += 1
  await ReactTestRenderer.act(async () => {
    tree.update(<HomeScreen />)
  })
  await settle()
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
  mockConnected = 'w_a'
  jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
  jest.mocked(recoverPurchases).mockResolvedValue(null)
})

test('a card answered after a switch is not put up on the wallet switched to', async () => {
  let answer!: (card: Recovery) => void
  jest.mocked(recoverPurchases).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
  const tree = await render()
  expect(recoverPurchases).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'w_a' }))
  await switchTo('w_b')
  await ReactTestRenderer.act(async () => {
    answer(READY)
  })
  await refocus(tree)
  expect(recoverPurchases).toHaveBeenCalledTimes(2)
  expect(texts(tree)).not.toContain('Your address is ready')
})

test('a card already up goes with the switch, and the next sweep of that wallet is not handed it', async () => {
  jest.mocked(recoverPurchases).mockResolvedValueOnce(READY)
  const tree = await render()
  expect(texts(tree)).toContain('Your address is ready')
  await switchTo('w_b')
  await refocus(tree)
  expect(texts(tree)).not.toContain('Your address is ready')
  expect(recoverPurchases).toHaveBeenLastCalledWith(expect.objectContaining({ walletId: 'w_b', showing: null }))
})

// Right after a switch the registry names the new wallet while the session still signs as the
// previous one, so the charges the gateway lists are that wallet's.
test('a sweep while the session signs as another wallet asks as that wallet', async () => {
  mockConnected = 'w_b'
  await render()
  expect(recoverPurchases).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'w_b' }))
})

// The key is read across an await. A connection that moves while it is read would pair one wallet's
// key with another wallet's id, filing that wallet's charges and marks under the wrong id, so that
// sweep asks nothing and the next focus asks as the wallet connected then.
test('a sweep whose connection moves while the key is read asks nothing, and the next focus asks', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockImplementationOnce(async () => {
    mockConnected = 'w_b'
    return `02${'a'.repeat(64)}`
  })
  const tree = await render()
  expect(sparkGetIdentityPubkey).toHaveBeenCalledTimes(1)
  expect(recoverPurchases).not.toHaveBeenCalled()
  expect(readDeletionOnFocus).not.toHaveBeenCalled()
  await refocus(tree)
  expect(recoverPurchases).toHaveBeenCalledTimes(1)
  expect(recoverPurchases).toHaveBeenCalledWith(expect.objectContaining({ walletId: 'w_b' }))
})
