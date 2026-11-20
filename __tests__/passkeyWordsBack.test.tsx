import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { DeviceEventEmitter, Platform, Text } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import App from '../App'
import i18n from '../src/i18n'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { __setPasskeyLiveForTests } from '../src/wallet/passkey'
import { addFirstWallet } from '../src/wallet/wallet'
import { isUnconfirmed } from '../src/wallet/backupMark'
import { loadSeedFor } from '../src/wallet/seed'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import * as backup from '../src/wallet/backup'
import { answerQuiz, missQuiz, onQuiz } from './support/backupQuiz'

const { __authenticator: auth } =
  require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider') as typeof import('../__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')

// The Android BackHandler, as in onboardingBack.test: the navigator's own listener turns the press
// into a goBack, which is what the header and the gesture do on the phone.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)
jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))
jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
}))

const TYPED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const keychain = new Map<string, string>()

type Tree = ReactTestRenderer.ReactTestRenderer
type Params = { Wallets: undefined; AddWallet: undefined; Main: undefined }
const Stack = createNativeStackNavigator<Params>()
const navRef = createNavigationContainerRef<Params>()

function WalletsStub(): React.JSX.Element {
  return <Text>WALLETS</Text>
}

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

async function mountAddWallet(): Promise<Tree> {
  const tree = await mount(
    <NavigationContainer ref={navRef}>
      <Stack.Navigator initialRouteName="Wallets">
        <Stack.Screen name="Main" component={WalletsStub} />
        <Stack.Screen name="Wallets" component={WalletsStub} />
        <Stack.Screen name="AddWallet" component={AddWalletScreen} />
      </Stack.Navigator>
    </NavigationContainer>,
  )
  await ReactTestRenderer.act(async () => {
    navRef.navigate('AddWallet')
  })
  await settle()
  return tree
}

function allText(tree: Tree): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function press(tree: Tree, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`button not found: ${label}, on ${allText(tree).join(' | ')}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  await settle()
}

async function pressBackChevron(tree: Tree): Promise<void> {
  const [chevron] = tree.root.findAll(
    node => node.props.label === i18n.t('common.back') && typeof node.props.onPress === 'function',
  )
  await ReactTestRenderer.act(async () => {
    chevron.props.onPress()
  })
  await settle()
}

// What the system sends on the back gesture or the back key.
async function androidBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    DeviceEventEmitter.emit('hardwareBackPress', {})
  })
  await settle()
}

const onWords = (tree: Tree): boolean => allText(tree).includes(i18n.t('passkey.wordsOwed'))
const onCheck = onQuiz

async function prove(tree: Tree, words: readonly string[]): Promise<void> {
  await answerQuiz(tree, words)
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
  auth.reset()
  auth.backupEligible = false
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => 34 })
  __setPasskeyLiveForTests(true)
  jest.spyOn(backup, 'pickPositions').mockReturnValue([0, 1, 2])
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

afterEach(() => {
  __setPasskeyLiveForTests(false)
  jest.restoreAllMocks()
})

describe('the first run', () => {
  async function atTheCheck(): Promise<Tree> {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    await press(tree, i18n.t('backup.confirm'))
    expect(onCheck(tree)).toBe(true)
    return tree
  }

  test('the chevron on the check goes back to the words', async () => {
    const tree = await atTheCheck()
    await pressBackChevron(tree)
    expect(onWords(tree)).toBe(true)
    expect(onCheck(tree)).toBe(false)
  })

  test('Android back goes the same way, and no further', async () => {
    const tree = await atTheCheck()
    await androidBack()
    expect(onWords(tree)).toBe(true)
    await androidBack()
    expect(onWords(tree)).toBe(true)
    expect(allText(tree)).not.toContain('Create a PIN')
  })

  test('the words shown again are the same, and the check still ends the step', async () => {
    const tree = await atTheCheck()
    const words = (await loadSeedFor('primary'))!.split(' ')
    await pressBackChevron(tree)
    expect(allText(tree).filter(text => words.includes(text)).length).toBeGreaterThanOrEqual(11)

    await press(tree, i18n.t('backup.confirm'))
    await prove(tree, words)

    expect(allText(tree)).toContain('Create a PIN')
    expect(await isUnconfirmed('primary')).toBe(false)
  })

  test('a wrong pick offers the words again, and the step ends only at the check', async () => {
    const tree = await atTheCheck()
    const words = (await loadSeedFor('primary'))!.split(' ')
    await missQuiz(tree, words)
    await press(tree, i18n.t('backup.showWords'))
    expect(onWords(tree)).toBe(true)
    expect(await isUnconfirmed('primary')).toBe(true)
  })

  test('the words themselves draw no way back', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(onWords(tree)).toBe(true)
    expect(tree.root.findAll(node => node.props.label === i18n.t('common.back'))).toEqual([])
  })
})

describe('Add wallet', () => {
  async function atTheCheck(): Promise<Tree> {
    await addFirstWallet(TYPED, undefined, 'typed')
    const tree = await mountAddWallet()
    await press(tree, i18n.t('passkey.addNew'))
    await press(tree, i18n.t('backup.confirm'))
    expect(onCheck(tree)).toBe(true)
    return tree
  }

  test('back from the check returns to the words, and the screen stays', async () => {
    const tree = await atTheCheck()
    await ReactTestRenderer.act(async () => {
      navRef.goBack()
    })
    await settle()
    expect(onWords(tree)).toBe(true)
    expect(navRef.getCurrentRoute()?.name).toBe('AddWallet')
  })

  test('Android back goes the same way, and leaving the words stays held', async () => {
    const tree = await atTheCheck()
    await androidBack()
    expect(onWords(tree)).toBe(true)
    await androidBack()
    expect(onWords(tree)).toBe(true)
    expect(navRef.getCurrentRoute()?.name).toBe('AddWallet')
  })

  test('the check draws no second back beside the header', async () => {
    const tree = await atTheCheck()
    expect(tree.root.findAll(node => node.props.label === i18n.t('common.back'))).toEqual([])
  })

  test('back and on again ends the flow at the same place', async () => {
    const tree = await atTheCheck()
    await androidBack()
    const words = (await loadSeedFor((await getActiveWalletId())!))!.split(' ')
    await press(tree, i18n.t('backup.confirm'))
    await prove(tree, words)
    expect(navRef.getCurrentRoute()?.name).toBe('Main')
  })
})
