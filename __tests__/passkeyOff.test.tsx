import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { NativeModules, Platform, Text } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { ImportScreen } from '../src/screens/ImportScreen'
import { RecoveryPhraseScreen } from '../src/screens/RecoveryPhraseScreen'
import { addFirstWallet } from '../src/wallet/wallet'
import { PASSKEY_LIVE, __setPasskeyLiveForTests, passkeyAvailable, passkeyLive, passkeyOffered } from '../src/wallet/passkey'

// The snapshots were written against the screens as they stood before any passkey code existed, so
// a difference here is a screen that stopped drawing what it drew. They are never regenerated to make
// this suite pass.

// Set by the provider's module as it loads and by whoever reads the native module, since each of those
// is what a device below the minimum must never do.
const mockReached = { provider: 0, native: 0 }

jest.mock('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider', () => {
  mockReached.provider += 1
  return {}
})

// The preset's asset transform writes the path from its own package to the file, which changes with
// where the checkout sits, so the one asset on these screens is named from the repository root.
jest.mock('../src/assets/logo.png', () => ({ testUri: 'src/assets/logo.png' }))
jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn(), setOptions: jest.fn() }),
  usePreventRemove: () => undefined,
}))

const PIN_SERVICE = 'com.voltz.wallet.pin'
const PIN = '123456'
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const keychain = new Map<string, string>()

type Tree = ReactTestRenderer.ReactTestRenderer

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function mount(element: React.JSX.Element): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  await settle()
  return tree
}

async function press(tree: Tree, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  await settle()
}

beforeAll(async () => {
  await i18n.changeLanguage('en-US')
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  keychain.clear()
  jest.clearAllMocks()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
  jest.mocked(Keychain.resetGenericPassword).mockImplementation(async options => keychain.delete(options?.service ?? ''))
  jest.mocked(Keychain.getSupportedBiometryType).mockResolvedValue(null)
})

beforeAll(() => {
  Object.defineProperty(NativeModules, 'BreezSdkSparkPasskey', {
    configurable: true,
    get() {
      mockReached.native += 1
      return undefined
    },
  })
})

// The switch as it ships, on a device below the minimum: these screens are what such a device still
// draws, from its first frame.
const os = Platform.OS
const version = Platform.Version

function setPlatform(to: string, at: string | number): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => to })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => at })
}

beforeEach(() => {
  __setPasskeyLiveForTests(null)
  setPlatform('ios', '17.7')
})

afterEach(() => {
  __setPasskeyLiveForTests(null)
  setPlatform(os, version)
})

afterAll(() => {
  // Run last, over every render above.
  expect(mockReached).toEqual({ provider: 0, native: 0 })
})

test('with the switch on, a device below the minimum is offered no passkey', async () => {
  expect(passkeyLive()).toBe(PASSKEY_LIVE)
  expect(passkeyOffered()).toBe(false)
  await expect(passkeyAvailable()).resolves.toBe(false)
})

test('the same holds on Android below API 28', async () => {
  setPlatform('android', 27)
  expect(passkeyOffered()).toBe(false)
  await expect(passkeyAvailable()).resolves.toBe(false)
  const text = JSON.stringify((await mount(<App />)).toJSON())
  expect(text).toContain(i18n.t('welcome.create'))
  expect(text).not.toContain(i18n.t('passkey.create'))
})

describe('what the screens draw', () => {
  test('first run, the welcome', async () => {
    const tree = await mount(<App />)
    expect(tree.toJSON()).toMatchSnapshot()
  })

  test('first run, restoring', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    expect(tree.toJSON()).toMatchSnapshot()
  })

  test('Add wallet, the choice', async () => {
    const tree = await mount(<AddWalletScreen />)
    expect(tree.toJSON()).toMatchSnapshot()
  })

  test('Add wallet, restoring', async () => {
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('addWallet.import'))
    expect(tree.toJSON()).toMatchSnapshot()
  })

  test('the import step on its own', async () => {
    const tree = await mount(<ImportScreen onImported={() => undefined} />)
    expect(tree.toJSON()).toMatchSnapshot()
  })

  test('Recovery phrase, past its gate', async () => {
    await addFirstWallet(WORDS, undefined, 'drawn')
    keychain.set(PIN_SERVICE, PIN)
    const tree = await mount(<RecoveryPhraseScreen />)
    for (const digit of PIN) {
      const [key] = tree.root.findAll(n => n.props.label === digit && typeof n.props.onPress === 'function')
      await ReactTestRenderer.act(async () => {
        key.props.onPress()
      })
    }
    await settle()
    expect(tree.toJSON()).toMatchSnapshot()
  })
})
