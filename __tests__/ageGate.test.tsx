import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { __resetAgeSignalForTests } from '../src/wallet/ageSignal'

// What the app shows when the store's age signal says the person is under 18: the ways to a new wallet
// give way to the adults-only screen, and a wallet already on the device opens as ever.

jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

type AgeStore = typeof import('../specs/__mocks__/NativeVoltzAge').ageStore
const store: AgeStore = jest.requireMock('../specs/NativeVoltzAge').ageStore

type Tree = ReactTestRenderer.ReactTestRenderer

const PIN = 'com.voltz.wallet.pin'
const SEED = 'com.voltz.wallet.seed'
const WORDS = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const keychain = new Map<string, string>()

function allText(tree: Tree): string[] {
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
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function boot(): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
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

async function typePin(tree: Tree, pin: string): Promise<void> {
  for (const digit of pin) {
    const [key] = tree.root.findAll(node => node.props.label === digit && typeof node.props.onPress === 'function')
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await settle()
}

const adultsOnly = (tree: Tree) => tree.root.findAll(node => node.props.testID === 'adultsOnly')

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __resetAgeSignalForTests()
  keychain.clear()
  jest.mocked(Keychain.setGenericPassword).mockImplementation(async (_user, password, options) => {
    keychain.set(options?.service ?? '', password)
    return false
  })
  jest.mocked(Keychain.getGenericPassword).mockImplementation(async options => {
    const password = keychain.get(options?.service ?? '')
    return password === undefined ? false : ({ username: 'u', password } as never)
  })
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async options => keychain.has(options?.service ?? ''))
})

describe('the first run', () => {
  test('a minor sees what the app is for and no way to a wallet', async () => {
    store.shares(13, 15)
    const tree = await boot()
    const text = allText(tree)
    expect(adultsOnly(tree).length).toBeGreaterThan(0)
    expect(text).toContain(i18n.t('ageGate.title'))
    expect(text).toContain(i18n.t('ageGate.contest'))
    expect(text).toContain(i18n.t('welcome.contactSupport'))
    expect(text).not.toContain(i18n.t('welcome.create'))
    expect(text).not.toContain(i18n.t('welcome.import'))
  })

  // Anything short of a range under 18 leaves the welcome as it is.
  test.each([
    ['nobody regulated', () => store.regulated(false)],
    ['an adult', () => store.shares(18, -1)],
    ['a failed request', () => {
      store.regulated(true)
      store.requestFails('play-3')
    }],
    ['a failed regulated check', () => store.regulatedFails('play-1')],
  ])('%s sees the welcome', async (_name, wire) => {
    wire()
    const tree = await boot()
    expect(adultsOnly(tree)).toEqual([])
    expect(allText(tree)).toContain(i18n.t('welcome.create'))
  })

  test('the app asks the store once at launch', async () => {
    store.regulated(false)
    await boot()
    expect(store.calls).toEqual({ regulated: 1, request: 0 })
  })

  // The answer can land after the person has gone on to type their words.
  test('a minor answer that lands on the import step takes its place', async () => {
    store.shares(13, 15)
    store.holds()
    const tree = await boot()
    await press(tree, i18n.t('welcome.import'))
    expect(adultsOnly(tree)).toEqual([])
    store.release()
    await settle()
    expect(adultsOnly(tree).length).toBeGreaterThan(0)
    expect(allText(tree)).not.toContain(i18n.t('import.title'))
  })
})

// A wallet already on the device opens past the PIN whatever the signal says, so Send, Receive,
// the words and the emergency exit, all behind the navigator, stay where they are.
test('a wallet already here opens for a minor', async () => {
  keychain.set(SEED, WORDS)
  keychain.set(PIN, '123456')
  await RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active: 'primary', wallets: [{ id: 'primary', fingerprint: 'fp' }] }),
    'utf8',
  )
  store.shares(13, 15)
  const tree = await boot()
  await typePin(tree, '123456')
  expect(allText(tree)).toContain('NAVIGATOR')
  expect(adultsOnly(tree)).toEqual([])
  expect(store.calls.request).toBe(1)
})
