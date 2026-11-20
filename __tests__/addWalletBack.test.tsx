import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { BackHandler, DeviceEventEmitter, Text } from 'react-native'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { wordlists } from 'bip39'
import i18n from '../src/i18n'
import { onQuiz } from './support/backupQuiz'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { addAndActivateWallet } from '../src/wallet/wallet'

// The Android BackHandler, as in onboardingBack.test: the navigator's own listener turns the press
// into a goBack, which is what the gesture does on the phone.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)
jest.mock('../src/wallet/wallet', () => ({ addAndActivateWallet: jest.fn(async () => 'w2') }))
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context')
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }
})

const ENGLISH: readonly string[] = wordlists.english

type Params = { Wallets: undefined; AddWallet: undefined; Main: undefined }
const Stack = createNativeStackNavigator<Params>()
const navRef = createNavigationContainerRef<Params>()

function WalletsStub(): React.JSX.Element {
  return <Text>WALLETS</Text>
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NavigationContainer ref={navRef}>
        <Stack.Navigator initialRouteName="Wallets">
          <Stack.Screen name="Main" component={WalletsStub} />
          <Stack.Screen name="Wallets" component={WalletsStub} />
          <Stack.Screen name="AddWallet" component={AddWalletScreen} />
        </Stack.Navigator>
      </NavigationContainer>,
    )
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    navRef.navigate('AddWallet')
  })
  await settle()
  return tree
}

function allText(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
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

async function androidBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    DeviceEventEmitter.emit('hardwareBackPress', {})
  })
  await settle()
}

// What the header's back button dispatches.
async function headerBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    navRef.goBack()
  })
  await settle()
}

function shownMnemonic(tree: ReactTestRenderer.ReactTestRenderer): string {
  return allText(tree)
    .filter(text => ENGLISH.includes(text))
    .join(' ')
}

function currentRoute(): string | undefined {
  return navRef.getCurrentRoute()?.name
}

async function rollDice(tree: ReactTestRenderer.ReactTestRenderer, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const face = String((i % 6) + 1)
    const target = tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === face,
    )
    await ReactTestRenderer.act(async () => {
      target.props.onPress()
    })
  }
}

let exitApp: jest.SpyInstance
beforeEach(async () => {
  jest.clearAllMocks()
  exitApp = jest.spyOn(BackHandler, 'exitApp').mockImplementation(() => undefined)
  await i18n.changeLanguage('en-US')
})
afterEach(() => {
  exitApp.mockRestore()
})
afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

test('Android back and the header back take one step at a time before leaving the route', async () => {
  const tree = await render()
  expect(currentRoute()).toBe('AddWallet')

  await press(tree, 'Create new wallet')
  expect(shownMnemonic(tree).split(' ')).toHaveLength(12)

  await androidBack()
  expect(currentRoute()).toBe('AddWallet')
  expect(allText(tree)).toContain('Create new wallet')

  await press(tree, 'Create new wallet')
  await headerBack()
  expect(currentRoute()).toBe('AddWallet')
  expect(allText(tree)).toContain('Create new wallet')

  // From the first step the route itself goes.
  await androidBack()
  expect(currentRoute()).toBe('Wallets')
  expect(exitApp).not.toHaveBeenCalled()
  expect(addAndActivateWallet).not.toHaveBeenCalled()
})

test('a dice phrase steps back from its confirmation and from its passphrase, keeping the words', async () => {
  const tree = await render()
  await press(tree, 'Generate with dice (advanced)')
  await rollDice(tree, 54)
  await press(tree, 'Generate wallet')
  const words = shownMnemonic(tree)
  await press(tree, 'I wrote them down safely')
  expect(onQuiz(tree)).toBe(true)

  await androidBack()
  expect(shownMnemonic(tree)).toBe(words)
  expect(addAndActivateWallet).not.toHaveBeenCalled()
})

// The add is held open: a step back from here must leave the route, never reach the phrase again.
test('once the add starts no step leads back to the phrase, so it cannot be written twice', async () => {
  let release!: (id: string) => void
  jest.mocked(addAndActivateWallet).mockImplementationOnce(
    () => new Promise<string>(resolve => (release = resolve)),
  )
  const tree = await render()
  await press(tree, 'Create new wallet')
  await press(tree, 'I wrote them down safely')
  expect(addAndActivateWallet).toHaveBeenCalledTimes(1)

  await androidBack()
  expect(currentRoute()).toBe('Wallets')
  expect(allText(tree)).not.toContain('I wrote them down safely')
  await ReactTestRenderer.act(async () => {
    release('w2')
  })
  await settle()
  expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
})

test('a dice phrase steps back to its rolls, and generating again gives the same words', async () => {
  const tree = await render()

  await press(tree, 'Generate with dice (advanced)')
  for (let i = 0; i < 54; i++) {
    const face = String((i % 6) + 1)
    const target = tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === face,
    )
    await ReactTestRenderer.act(async () => {
      target.props.onPress()
    })
  }
  await press(tree, 'Generate wallet')
  const words = shownMnemonic(tree)
  expect(words.split(' ')).toHaveLength(12)

  await androidBack()
  expect(currentRoute()).toBe('AddWallet')
  expect(allText(tree)).toContain('Generate wallet')
  await press(tree, 'Generate wallet')
  expect(shownMnemonic(tree)).toBe(words)

  await headerBack()
  await headerBack()
  expect(allText(tree)).toContain('Create new wallet')
  expect(currentRoute()).toBe('AddWallet')
  expect(addAndActivateWallet).not.toHaveBeenCalled()
})

// The rolls are secret, so once cleared, or once the dice step is left for the choice, opening it
// again starts from no rolls and Generate has nothing to make a phrase from.
test('cleared or abandoned dice rolls never come back when the dice step opens again', async () => {
  const tree = await render()

  await press(tree, 'Generate with dice (advanced)')
  await rollDice(tree, 54)
  await press(tree, 'Generate wallet')
  expect(shownMnemonic(tree).split(' ')).toHaveLength(12)

  await androidBack()
  expect(allText(tree)).toContain('54 of 50 rolls')
  await press(tree, 'Clear')
  expect(allText(tree)).toContain('0 of 50 rolls')
  await androidBack()
  expect(allText(tree)).toContain('Create new wallet')

  await press(tree, 'Generate with dice (advanced)')
  expect(allText(tree)).toContain('0 of 50 rolls')
  await press(tree, 'Generate wallet')
  expect(allText(tree)).toContain('0 of 50 rolls')
  expect(shownMnemonic(tree)).toBe('')

  // Left without Clear, by the header back this time.
  await rollDice(tree, 54)
  await press(tree, 'Generate wallet')
  expect(shownMnemonic(tree).split(' ')).toHaveLength(12)
  await headerBack()
  expect(allText(tree)).toContain('54 of 50 rolls')
  await headerBack()
  expect(allText(tree)).toContain('Create new wallet')

  await press(tree, 'Generate with dice (advanced)')
  expect(allText(tree)).toContain('0 of 50 rolls')
  await press(tree, 'Generate wallet')
  expect(shownMnemonic(tree)).toBe('')
  expect(currentRoute()).toBe('AddWallet')
  expect(addAndActivateWallet).not.toHaveBeenCalled()
})

test('import draws one back control, the header, which steps back to the choice', async () => {
  const tree = await render()
  await press(tree, 'Import wallet')
  expect(allText(tree)).toContain(i18n.t('import.subtitle'))

  // The native header is the back control here, so the screen draws none of its own.
  const inScreenBack = tree.root.findAll(
    node => node.props.accessibilityLabel === 'Back' && typeof node.props.onPress === 'function',
  )
  expect(inScreenBack).toHaveLength(0)

  await headerBack()
  expect(currentRoute()).toBe('AddWallet')
  expect(allText(tree)).toContain('Create new wallet')
})
