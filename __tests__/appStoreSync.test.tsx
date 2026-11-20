import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import App from '../App'
import { getDistribution } from '../src/config'
import { startStoreSync } from '../src/wallet/storePurchase'
import { settleActiveWallet } from '../src/wallet/wallet'
import { hasPin, verifyPin } from '../src/wallet/pin'

// The store's listener belongs at the root, since Apple hands an unfinished transaction over once,
// and it settles purchases by signing for them, so it starts with a ready wallet and only in a build
// that sells through the store.
jest.mock('../src/config', () => ({
  getBreezLnurlDomain: () => undefined,
  getDistribution: jest.fn(),
}))
jest.mock('../src/wallet/storePurchase', () => ({ startStoreSync: jest.fn() }))
jest.mock('../src/wallet/wallet', () => ({
  settleActiveWallet: jest.fn(),
  onActiveWalletChanged: () => () => undefined,
}))
// The keypad's check, over the comparison each case decides, with no wrong-PIN wait.
jest.mock('../src/wallet/pin', () => {
  const compare = jest.fn()
  return {
    hasPin: jest.fn(), savePin: jest.fn(), verifyPin: compare,
    enterPin: jest.fn(async (pin: string) => ((await compare(pin)) ? { ok: true } : { ok: false, waitMs: 0 })),
    pinWaitLeft: jest.fn(async () => 0),
    clearPinFailures: jest.fn(async () => undefined),
  }
})
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w1') }))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayLanguage: jest.fn().mockResolvedValue(null),
  loadDollarMode: jest.fn().mockResolvedValue(false),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))

const stop = jest.fn()

// A wallet always has a PIN, so a ready one is one unlocked on the keypad, whose keys carry their
// digit as the label.
async function unlock(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  for (const digit of '123456') {
    const [key] = tree.root.findAll(
      node => node.props.label === digit && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function boot(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
  return tree
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(getDistribution).mockReturnValue('store')
  jest.mocked(startStoreSync).mockReturnValue(stop)
  jest.mocked(settleActiveWallet).mockResolvedValue(true)
  jest.mocked(hasPin).mockResolvedValue(true)
  jest.mocked(verifyPin).mockResolvedValue(true)
})

test('a store build starts the sync once the wallet is ready, and stops it when the app goes', async () => {
  const tree = await boot()
  expect(startStoreSync).not.toHaveBeenCalled()
  await unlock(tree)

  expect(startStoreSync).toHaveBeenCalledTimes(1)
  expect(stop).not.toHaveBeenCalled()

  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })

  expect(stop).toHaveBeenCalledTimes(1)
})

test('a build that sells in sats never starts it', async () => {
  jest.mocked(getDistribution).mockReturnValue('direct')

  await unlock(await boot())

  expect(startStoreSync).not.toHaveBeenCalled()
})

test('with no wallet yet, nothing is started', async () => {
  jest.mocked(settleActiveWallet).mockResolvedValue(false)

  await boot()

  expect(startStoreSync).not.toHaveBeenCalled()
})

test('a wallet behind its PIN waits for the unlock', async () => {
  await boot()

  expect(startStoreSync).not.toHaveBeenCalled()
})
