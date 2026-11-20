import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Platform, Text } from 'react-native'
import { getByGestureTestId } from 'react-native-gesture-handler/jest-utils'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import App from '../App'
import i18n from '../src/i18n'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { EditWalletScreen } from '../src/screens/EditWalletScreen'
import { PasskeyChoice } from '../src/components/PasskeyAction'
import { PasskeyCard } from '../src/components/PasskeyCard'
import { Skeleton } from '../src/components/Skeleton'
import { PassphraseScreen } from '../src/screens/PassphraseScreen'
import { addAndActivateWallet, addFirstPasskeyWallet, addFirstWallet, addPasskeyWallet } from '../src/wallet/wallet'
import { __setPasskeyLiveForTests, passkeyAttempt, passkeyAvailable, passkeyEntryFor } from '../src/wallet/passkey'
import { connectActiveSpark, connectSpark } from '../src/wallet/spark'
import { isUnconfirmed } from '../src/wallet/backupMark'
import { loadSeedFor } from '../src/wallet/seed'
import { getActiveWalletId, loadRegistry } from '../src/wallet/walletRegistry'
import { importCheckDue } from '../src/wallet/deletionMark'
import * as backup from '../src/wallet/backup'
import { answerQuiz } from './support/backupQuiz'
import { question } from './support/question'

const { __authenticator: auth } =
  require('@breeztech/breez-sdk-spark-react-native/passkey-prf-provider') as typeof import('../__mocks__/@breeztech/breez-sdk-spark-react-native/passkey-prf-provider')

// usePreventRemove stops a navigation away from the screen, so one made with back held never left.
// Counted rather than thrown, since a throw here lands in the code under test and can be swallowed.
let mockPrevented = false
let mockStopped = 0
let mockHeldBack: () => void = () => undefined
const mockNavigate = jest.fn(() => {
  if (mockPrevented) {
    mockStopped += 1
  }
})
const mockGoBack = jest.fn()
const mockSetOptions = jest.fn()
const mockSeedClear = jest.fn()

// The drawn pair is App's own state, which no screen shows past the welcome, so its clear is watched.
jest.mock('../src/hooks/useSeedPair', () => {
  const { useSeedPair } = jest.requireActual('../src/hooks/useSeedPair')
  return {
    useSeedPair: () => {
      const pair = useSeedPair()
      return {
        ...pair,
        clear: () => {
          mockSeedClear()
          pair.clear()
        },
      }
    },
  }
})
jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions }),
  // Edit wallet reads its route for a photo back from the adjust step.
  useRoute: () => ({ key: 'EditWallet', name: 'EditWallet', params: undefined }),
  usePreventRemove: (active: boolean, onPrevented: () => void) => {
    mockPrevented = active
    mockHeldBack = onPrevented
  },
}))
jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  connectActiveSpark: jest.fn(async () => undefined),
  connectSpark: jest.fn(async () => undefined),
}))
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('../__mocks__/react-native-safe-area-context'),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 390, height: 844 }),
}))

const keychain = new Map<string, string>()
const TYPED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'
const PIN_SERVICE = 'com.voltz.wallet.pin'

type Tree = ReactTestRenderer.ReactTestRenderer

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

async function mount(element: React.JSX.Element): Promise<Tree> {
  let tree!: Tree
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  await settle()
  return tree
}

const buttonOf = (tree: Tree, label: string) =>
  tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))

async function press(tree: Tree, label: string): Promise<void> {
  const button = buttonOf(tree, label)
  if (!button) {
    throw new Error(`button not found: ${label}, on ${allText(tree).join(' | ')}`)
  }
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
  })
  await settle()
}

// Android's Credential Manager path starts at API 28 and iOS's PRF at 18.
function onPlatform(os: string): void {
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => (os === 'ios' ? '18.2' : 34) })
}

// The positions the verification asks are drawn by this double, so a test can answer them.
async function proveWords(tree: Tree, words: readonly string[]): Promise<void> {
  await press(tree, i18n.t('backup.confirm'))
  await answerQuiz(tree, words)
  await settle()
}

const shownWords = (tree: Tree, words: readonly string[]): string[] =>
  allText(tree).filter(text => words.includes(text))

// Anything of the tree that still holds the phrase, in any prop of any node.
function holdsPhrase(tree: Tree, phrase: string): boolean {
  const seen = new Set<unknown>()
  const search = (value: unknown, depth: number): boolean => {
    if (typeof value === 'string') {
      return value.includes(phrase)
    }
    if (depth > 4 || typeof value !== 'object' || value === null || seen.has(value)) {
      return false
    }
    seen.add(value)
    return Object.values(value as object).some(item => search(item, depth + 1))
  }
  return tree.root.findAll(() => true).some(node => search(node.props, 0))
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
  mockPrevented = false
  mockStopped = 0
  auth.reset()
  Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' })
  Object.defineProperty(Platform, 'Version', { configurable: true, get: () => '18.2' })
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
  expect(mockStopped).toBe(0)
  auth.reset()
  __setPasskeyLiveForTests(false)
  jest.restoreAllMocks()
})

// The control for passkeyOff.test.tsx: its snapshots would not move if the switch changed nothing.
test('the switch changes what the welcome draws, so a comparison with it off can fail', async () => {
  const on = JSON.stringify((await mount(<App />)).toJSON())
  __setPasskeyLiveForTests(false)
  const off = JSON.stringify((await mount(<App />)).toJSON())
  expect(on).toContain(i18n.t('passkey.create'))
  expect(off).not.toContain(i18n.t('passkey.create'))
  expect(on).not.toBe(off)
})

describe('the words never wait on the passkey', () => {
  test('with the check in flight the skeleton holds only the button, and the words are already there', async () => {
    auth.silent = true
    const tree = await mount(<App />)
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(1)
    expect(buttonOf(tree, i18n.t('passkey.useWords'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('welcome.import'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.create'))).toBeUndefined()
  })

  test('the words answer a tap while the check is out, and its late answer changes nothing', async () => {
    auth.silent = true
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.useWords'))
    expect(allText(tree)).toContain(i18n.t('backup.title'))
    expect(auth.calls.deriveSeeds + auth.calls.createPasskey).toBe(0)
  })

  test('Add wallet the same', async () => {
    auth.silent = true
    const tree = await mount(<AddWalletScreen />)
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(1)
    expect(buttonOf(tree, i18n.t('passkey.useWords'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('addWallet.import'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('welcome.dice'))).toBeDefined()
  })

  test('a device with no passkey keeps the button it always had', async () => {
    auth.supported = false
    const tree = await mount(<App />)
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(buttonOf(tree, i18n.t('welcome.create'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.useWords'))).toBeUndefined()
    expect(allText(tree)).not.toContain(i18n.t('passkey.explain'))
  })
})

describe('it says what a passkey is before creating one', () => {
  test.each([
    ['the first run', () => <App />],
    ['Add wallet', () => <AddWalletScreen />],
  ])('on %s, with no screen of consent in between', async (_where, screen) => {
    const tree = await mount(screen())
    expect(allText(tree)).toContain(i18n.t('passkey.explain'))
    expect(auth.calls.createPasskey).toBe(0)
  })

  // Before any test nothing is known about this passkey and this wallet, and not every device unlocks
  // with a face or a finger, so the line describes what a passkey is.
  test('the line says both things', () => {
    expect(i18n.t('passkey.explain')).toMatch(/^A passkey is a digital key/)
    expect(i18n.t('passkey.explain')).toMatch(/Deleting it without your words can lose the wallet/)
  })
})

describe('the first run', () => {
  test('the seed is in the Keychain before the PIN step, and nothing has connected', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))

    expect(allText(tree)).toContain('Create a PIN')
    expect(await loadSeedFor('primary')).not.toBeNull()
    expect(connectSpark).not.toHaveBeenCalled()
    expect(connectActiveSpark).not.toHaveBeenCalled()
    expect(keychain.has(PIN_SERVICE)).toBe(false)
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('the PIN step waits for the Keychain', async () => {
    let finish: () => void = () => undefined
    const tree = await mount(<App />)
    const store = jest.mocked(Keychain.setGenericPassword).getMockImplementation()!
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async (...args) => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return store(...args)
    })
    await press(tree, i18n.t('passkey.create'))
    expect(allText(tree)).not.toContain('Create a PIN')
    expect(keychain.has('com.voltz.wallet.seed')).toBe(false)
    await ReactTestRenderer.act(async () => {
      finish()
    })
    await settle()
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('the words leave the screen with the write', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    const phrase = (await loadSeedFor('primary'))!
    expect(holdsPhrase(tree, phrase)).toBe(false)
  })

  test('no passphrase step and no choice of length', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(tree.root.findAllByType(PassphraseScreen)).toHaveLength(0)
    expect(allText(tree)).not.toContain(i18n.t('welcome.words', { count: 24 }))
    expect(keychain.has('com.voltz.wallet.passphrase')).toBe(false)
  })

  // iOS keeps the same one call per tap and changes only what the refusal says (the describe below).
  test.each([
    ['android', 'passkey.refused'],
    ['ios', 'passkey.didNotOpen'],
  ])('I7: on %s a closed sheet stops at Try again, for one call, until the next tap', async (os, line) => {
    onPlatform(os)
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'closed' })
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    await settle()

    expect(auth.calls.deriveSeeds).toBe(1)
    expect(auth.calls.createPasskey).toBe(0)
    expect(allText(tree)).toContain(i18n.t(line))
    expect(await loadSeedFor('primary')).toBeNull()

    await press(tree, i18n.t('common.retry'))

    expect(auth.calls.deriveSeeds).toBe(2)
    expect(allText(tree)).toContain('Create a PIN')
  })

  test.each([
    ['android', 'passkey.refused'],
    ['ios', 'passkey.didNotOpen'],
  ])('I7: on %s a timed out sheet the same', async (os, line) => {
    onPlatform(os)
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_TIMED_OUT', message: 'timed out' })
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    await settle()
    expect(auth.calls.deriveSeeds).toBe(1)
    expect(allText(tree)).toContain(i18n.t(line))
  })

  test('a device that turns out unable falls back to the words, and the button goes', async () => {
    auth.failures.deriveSeeds.push({ code: 'ERR_CONFIGURATION', message: 'no entitlement' })
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(allText(tree)).toContain(i18n.t('passkey.unavailable'))
    expect(buttonOf(tree, i18n.t('passkey.create'))).toBeUndefined()
    expect(buttonOf(tree, i18n.t('welcome.create'))).toBeDefined()
  })

  test('that answer outranks the yes the check gave, so the next screen to ask hears no', async () => {
    auth.failures.deriveSeeds.push({ code: 'ERR_CONFIGURATION', message: 'no entitlement' })
    const tree = await mount(<App />)
    await expect(passkeyAvailable()).resolves.toBe(true)
    await press(tree, i18n.t('passkey.create'))
    await expect(passkeyAvailable()).resolves.toBe(false)
  })

  test('with the sheet up on the restore step, the step back waits for its answer', async () => {
    let answer: (value?: unknown) => void = () => undefined
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    expect(getByGestureTestId('onboarding-edge-back').config.enabled).toBe(true)

    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    await press(tree, i18n.t('passkey.restore'))
    expect(getByGestureTestId('onboarding-edge-back').config.enabled).toBe(false)

    auth.gate = null
    answer()
    await settle()
    expect(getByGestureTestId('onboarding-edge-back').config.enabled).toBe(true)
  })

  test('while the sheet is up the ways out are held and a second tap starts nothing', async () => {
    let answer: (value?: unknown) => void = () => undefined
    const held = new Promise(resolve => {
      answer = resolve
    })
    auth.gate = held
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(allText(tree)).toContain(i18n.t('passkey.phaseChecking'))
    await press(tree, i18n.t('passkey.create')).catch(() => undefined)
    const words = buttonOf(tree, i18n.t('passkey.useWords'))
    const restore = buttonOf(tree, i18n.t('welcome.import'))
    expect(words?.props.disabled).toBe(true)
    expect(restore?.props.disabled).toBe(true)
    expect(auth.calls.deriveSeeds).toBe(1)
    auth.gate = null
    answer()
    await settle()
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('restoring signs in, reads as an import and keeps the card', async () => {
    const made = await passkeyAttempt('register')()
    auth.calls.createPasskey = 0
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    await press(tree, i18n.t('passkey.restore'))

    expect(allText(tree)).toContain('Create a PIN')
    expect(auth.calls.createPasskey).toBe(0)
    expect(await loadSeedFor('primary')).toBe(made.mnemonic)
    expect(await importCheckDue('primary')).toBe(true)
    expect(await isUnconfirmed('primary')).toBe(true)
  })

  test('a Keychain that refuses says so at the button, and the ways out come back', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<App />)
    jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('keychain full'))
    await press(tree, i18n.t('passkey.create'))

    expect(allText(tree)).toContain(i18n.t('passkey.failed'))
    expect(buttonOf(tree, i18n.t('common.retry'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('welcome.import'))?.props.disabled).toBeFalsy()
    expect(warn).toHaveBeenCalled()
  })

  test('after that failure the ways out still step back, since the next tap derives the same words', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<App />)
    jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(new Error('keychain full'))
    await press(tree, i18n.t('passkey.create'))
    await press(tree, i18n.t('welcome.import'))

    expect(getByGestureTestId('onboarding-edge-back').config.enabled).toBe(true)
    warn.mockRestore()
  })

  test('a failed write of typed words still holds every step back', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    jest.mocked(Keychain.setGenericPassword).mockRejectedValueOnce(new Error('keychain full'))
    const field = tree.root.findAll(node => typeof node.props.onChangeText === 'function')[0]
    await ReactTestRenderer.act(async () => field.props.onChangeText(TYPED))
    await settle()
    await press(tree, i18n.t('import.restore'))

    expect(getByGestureTestId('onboarding-edge-back').config.enabled).toBe(false)
    warn.mockRestore()
  })

  test('the hold on the ways out ends with the button, for a boot that comes back to the welcome', async () => {
    const onBusy = jest.fn()
    let show!: (shown: boolean) => void
    function Stage(): React.JSX.Element | null {
      const [shown, setShown] = React.useState(true)
      show = setShown
      return shown ? (
        <PasskeyChoice
          mode="connect"
          label="go"
          wordsButton="words"
          wordsLink="words"
          onWords={() => undefined}
          onWallet={async () => {
            show(false)
            await new Promise(resolve => setTimeout(resolve, 0))
          }}
          busy={false}
          onBusy={onBusy}
          actionStyle={undefined}
          linkStyle={undefined}
        />
      ) : null
    }
    const tree = await mount(<Stage />)
    await press(tree, 'go')
    expect(onBusy.mock.calls.at(-1)).toEqual([false])
  })

  test('restoring with no passkey says so, stays, and never creates one', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    await press(tree, i18n.t('passkey.restore'))

    expect(allText(tree)).toContain(i18n.t('passkey.noCredential'))
    expect(auth.calls.createPasskey).toBe(0)
    expect(allText(tree)).toContain(i18n.t('import.title'))
  })

  test('a device with no passkey restores by words alone, with nothing above them', async () => {
    auth.supported = false
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    expect(buttonOf(tree, i18n.t('passkey.restore'))).toBeUndefined()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })
})

// iOS answers a closed sheet and a sign-in that found nothing with one code, and the package tells them
// apart by a 300 ms clock a cold first tap can pass with no sheet shown. A refused connect there asks
// rather than claims, and registers only on the SDK's own fall-through or on an explicit tap.
describe('Welcome on iOS, a refused connect asks instead of naming what the person did', () => {
  const refusedOnce = () => auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'closed' })

  // Welcome's button signs in first, finds nothing, registers, and the derive after it is refused.
  const refusedAfterCreate = () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push(
      { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' },
      { code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' },
    )
  }

  const refusedWelcome = async (): Promise<Tree> => {
    refusedOnce()
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    return tree
  }

  test('the refusal says the passkey did not open, offers both ways on, and starts nothing by itself', async () => {
    const tree = await refusedWelcome()
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50))
    })

    expect(allText(tree)).toContain(i18n.t('passkey.didNotOpen'))
    expect(allText(tree)).not.toContain(i18n.t('passkey.refused'))
    expect(buttonOf(tree, i18n.t('common.retry'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.createNew'))).toBeDefined()
    expect(auth.calls.deriveSeeds).toBe(1)
    expect(auth.calls.createPasskey).toBe(0)
    expect(await loadSeedFor('primary')).toBeNull()
  })

  test('Create a new passkey registers on its tap, with no sign-in before it', async () => {
    const tree = await refusedWelcome()
    await press(tree, i18n.t('passkey.createNew'))

    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.calls.deriveSeeds).toBe(1)
    expect(allText(tree)).toContain('Create a PIN')
    expect(await loadSeedFor('primary')).toBeTruthy()
    expect((await passkeyEntryFor('primary'))?.created).toBe(true)
  })

  test('Try again runs the same connect, which registers only through its own fall-through', async () => {
    const tree = await refusedWelcome()
    await press(tree, i18n.t('common.retry'))

    expect(auth.calls.deriveSeeds).toBe(2)
    expect(auth.lastPrefer).toBe(true)
    expect(auth.calls.createPasskey).toBe(1)
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('with a credential no wallet has claimed, Create a new passkey signs in pinned to it', async () => {
    refusedAfterCreate()
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(auth.calls.createPasskey).toBe(1)
    expect(allText(tree)).toContain(i18n.t('passkey.didNotOpen'))

    await press(tree, i18n.t('passkey.createNew'))

    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toHaveLength(1)
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('Android keeps its line and its one action', async () => {
    onPlatform('android')
    const tree = await refusedWelcome()

    expect(allText(tree)).toContain(i18n.t('passkey.refused'))
    expect(allText(tree)).not.toContain(i18n.t('passkey.didNotOpen'))
    expect(buttonOf(tree, i18n.t('common.retry'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.createNew'))).toBeUndefined()
  })

  test('Add wallet on iOS keeps its line and its one action', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    auth.failures.createPasskey.push({ code: 'ERR_USER_CANCELLED', message: 'closed' })
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))

    expect(allText(tree)).toContain(i18n.t('passkey.refused'))
    expect(buttonOf(tree, i18n.t('common.retry'))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.createNew'))).toBeUndefined()
  })

  test('the restore step on iOS keeps its line and its one action', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('welcome.import'))
    refusedOnce()
    await press(tree, i18n.t('passkey.restore'))

    expect(allText(tree)).toContain(i18n.t('passkey.refused'))
    expect(buttonOf(tree, i18n.t('passkey.createNew'))).toBeUndefined()
    expect(auth.calls.createPasskey).toBe(0)
  })

  test.each([
    [
      'failed',
      () => auth.failures.deriveSeeds.push({ code: 'ERR_PASSKEY', message: 'broken' }),
      'passkey.failed',
      'common.retry',
    ],
    [
      'noCredential',
      () => {
        auth.prfAtCreate = false
        auth.failures.deriveSeeds.push(
          { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' },
          { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' },
        )
      },
      'passkey.noCredential',
      'passkey.create',
    ],
    [
      'unavailable',
      () => auth.failures.deriveSeeds.push({ code: 'ERR_CONFIGURATION', message: 'no entitlement' }),
      'passkey.unavailable',
      'welcome.create',
    ],
  ])('I5: on iOS the %s state is unchanged and offers no new passkey', async (_kind, script, line, action) => {
    script()
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))

    expect(allText(tree)).toContain(i18n.t(line))
    expect(buttonOf(tree, i18n.t(action))).toBeDefined()
    expect(buttonOf(tree, i18n.t('passkey.createNew'))).toBeUndefined()
    expect(allText(tree)).not.toContain(i18n.t('passkey.didNotOpen'))
  })

  test.each([
    ['Try again', 'common.retry', 'passkey.createNew'],
    ['Create a new passkey', 'passkey.createNew', 'common.retry'],
  ])('I6: while %s runs, neither button starts another ceremony and both stay', async (_first, first, other) => {
    const tree = await refusedWelcome()
    let answer: (value?: unknown) => void = () => undefined
    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    await press(tree, i18n.t(first))
    const calls = { ...auth.calls }

    expect(buttonOf(tree, i18n.t('common.retry'))?.props.loading).toBe(true)
    expect(buttonOf(tree, i18n.t('passkey.createNew'))?.props.disabled).toBe(true)
    expect(buttonOf(tree, i18n.t('welcome.import'))?.props.disabled).toBe(true)
    await press(tree, i18n.t(other))
    await press(tree, i18n.t(first))
    expect(auth.calls).toEqual(calls)

    auth.gate = null
    answer()
    await settle()
    expect(allText(tree)).toContain('Create a PIN')
    expect(auth.calls.createPasskey).toBe(1)
  })

  test('an answer landing after the screen left stores nothing, and the next tap signs in pinned', async () => {
    const tree = await refusedWelcome()
    let answer: (value?: unknown) => void = () => undefined
    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    await press(tree, i18n.t('passkey.createNew'))
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    auth.gate = null
    answer()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(await loadSeedFor('primary')).toBeNull()
    expect(auth.calls.createPasskey).toBe(1)

    const again = await mount(<App />)
    await press(again, i18n.t('passkey.create'))

    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toHaveLength(1)
    expect(allText(again)).toContain('Create a PIN')
  })

  test('the line says only that the passkey did not open, and asks', () => {
    expect(i18n.t('passkey.didNotOpen')).toBe(
      'The passkey did not open. If you already have one, try again. If not, create a new one.',
    )
    expect(i18n.t('passkey.createNew')).toBe('Create a new passkey')
  })
})

describe('without sync the words are not optional', () => {
  test.each([
    ['false', false],
    ['absent', null],
  ])('backupEligible %s: the PIN comes only after the confirmation', async (_name, eligible) => {
    auth.backupEligible = eligible
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))

    expect(allText(tree)).not.toContain('Create a PIN')
    expect(allText(tree)).toContain(i18n.t('passkey.wordsOwed'))
    expect(mockSeedClear).toHaveBeenCalled()
    const words = (await loadSeedFor('primary'))!.split(' ')
    expect(await isUnconfirmed('primary')).toBe(true)
    expect(shownWords(tree, words).length).toBeGreaterThanOrEqual(11)

    await proveWords(tree, words)

    expect(allText(tree)).toContain('Create a PIN')
    expect(await isUnconfirmed('primary')).toBe(false)
  })

  test('killed before the confirmation, the next boot comes back to the words', async () => {
    auth.backupEligible = false
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    const words = (await loadSeedFor('primary'))!.split(' ')
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })

    const again = await mount(<App />)
    expect(allText(again)).toContain(i18n.t('passkey.wordsOwed'))
    await proveWords(again, words)
    expect(allText(again)).toContain('Create a PIN')
  })

  test('a tap on Create that lands on a sign-in comes to the words too', async () => {
    await passkeyAttempt('connect')()
    __setPasskeyLiveForTests(true)
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))

    expect(auth.calls.createPasskey).toBe(1)
    expect(allText(tree)).toContain(i18n.t('passkey.wordsOwed'))
    expect(allText(tree)).not.toContain('Create a PIN')
    await proveWords(tree, (await loadSeedFor('primary'))!.split(' '))
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('a passkey the device says syncs goes straight on', async () => {
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(allText(tree)).not.toContain(i18n.t('passkey.wordsOwed'))
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('in Add wallet the flow ends only after the confirmation, and back is held', async () => {
    auth.backupEligible = false
    await addFirstWallet(TYPED, undefined, 'typed')
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))

    expect(mockNavigate).not.toHaveBeenCalled()
    expect(mockPrevented).toBe(true)
    const id = (await getActiveWalletId())!
    await proveWords(tree, (await loadSeedFor(id))!.split(' '))

    expect(mockNavigate).toHaveBeenCalledWith('Main')
    expect(await isUnconfirmed(id)).toBe(false)
  })

  test('a wallet added and cut before its confirmation comes back past the PIN', async () => {
    auth.backupEligible = false
    await addFirstWallet(TYPED, undefined, 'typed')
    const id = await addPasskeyWallet(await passkeyAttempt('register')())
    keychain.set(PIN_SERVICE, '123456')
    const tree = await mount(<App />)
    for (const digit of '123456') {
      const [key] = tree.root.findAll(n => n.props.label === digit && typeof n.props.onPress === 'function')
      await ReactTestRenderer.act(async () => {
        key.props.onPress()
      })
    }
    await settle()
    expect(allText(tree)).toContain(i18n.t('passkey.wordsOwed'))
    expect(await getActiveWalletId()).toBe(id)
  })
})

describe('Add wallet', () => {
  beforeEach(async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
  })

  test('registers directly, with no passphrase step, and leaves the connection to Home', async () => {
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))

    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.calls.deriveSeeds).toBe(0)
    expect(tree.root.findAllByType(PassphraseScreen)).toHaveLength(0)
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    expect((await loadRegistry()).wallets).toHaveLength(2)
    expect(connectActiveSpark).not.toHaveBeenCalled()
  })

  test('a restore that lands on a wallet already here switches to it', async () => {
    const wallet = await passkeyAttempt('register')()
    const id = await addPasskeyWallet(wallet)
    await addAndActivateWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('addWallet.import'))
    await press(tree, i18n.t('passkey.restore'))

    expect((await loadRegistry()).wallets).toHaveLength(3)
    expect(await getActiveWalletId()).toBe(id)
    expect(connectActiveSpark).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })

  test('back is held while the sheet is up', async () => {
    let answer: (value?: unknown) => void = () => undefined
    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    const tree = await mount(<AddWalletScreen />)
    expect(mockPrevented).toBe(false)
    await press(tree, i18n.t('passkey.addNew'))
    expect(mockPrevented).toBe(true)
    auth.gate = null
    answer()
    await settle()
  })

  test('an answer landing after the screen left stores nothing', async () => {
    let answer: (value?: unknown) => void = () => undefined
    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    auth.gate = null
    answer()
    await new Promise(resolve => setTimeout(resolve, 5))

    expect((await loadRegistry()).wallets).toHaveLength(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('a Keychain that refuses takes the same way out as any add', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<AddWalletScreen />)
    jest.mocked(Keychain.setGenericPassword).mockRejectedValue(new Error('keychain full'))
    await press(tree, i18n.t('passkey.addNew'))

    expect(allText(tree)).toContain(i18n.t('addWallet.failed'))
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(warn.mock.calls.flat().join(' ')).not.toMatch(/\b(zoo|abandon)\b/)
  })
})

describe('a credential outlives the screen that created it', () => {
  const derivationFails = () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' })
  }

  // Welcome's button signs in first, and that finds nothing before the create runs.
  const derivationFailsFromWelcome = () => {
    auth.prfAtCreate = false
    auth.failures.deriveSeeds.push(
      { code: 'ERR_NO_CREDENTIAL', message: 'no credential available' },
      { code: 'ERR_USER_CANCELLED', message: 'User cancelled authentication' },
    )
  }

  // Refuses one write, the seed's when the mark and the note are already in.
  const seedRefusedOnce = () => {
    const stores = jest.mocked(Keychain.setGenericPassword).getMockImplementation()!
    jest.mocked(Keychain.setGenericPassword).mockImplementation(async () => {
      jest.mocked(Keychain.setGenericPassword).mockImplementation(stores)
      throw new Error('keychain full')
    })
  }

  const leave = async (tree: Tree) => {
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
  }

  const signedInPinned = () => {
    expect(auth.calls.createPasskey).toBe(1)
    expect(auth.lastAllow).toHaveLength(1)
  }

  test('the first run, left and opened again, signs in pinned instead of registering', async () => {
    derivationFailsFromWelcome()
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(auth.calls.createPasskey).toBe(1)
    await leave(tree)

    const again = await mount(<App />)
    await press(again, i18n.t('passkey.create'))

    signedInPinned()
    expect(await loadSeedFor('primary')).toBeTruthy()
    expect(allText(again)).toContain('Create a PIN')
  })

  test('Add wallet, left and opened again, the same', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    derivationFails()
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))
    await leave(tree)

    const again = await mount(<AddWalletScreen />)
    await press(again, i18n.t('passkey.addNew'))

    signedInPinned()
    expect((await loadRegistry()).wallets).toHaveLength(2)
  })

  test('the first run, through Import and back', async () => {
    derivationFailsFromWelcome()
    const tree = await mount(<App />)
    await press(tree, i18n.t('passkey.create'))
    expect(auth.calls.createPasskey).toBe(1)
    await press(tree, i18n.t('welcome.import'))
    const [chevron] = tree.root.findAll(
      node => node.props.label === i18n.t('common.back') && typeof node.props.onPress === 'function',
    )
    await ReactTestRenderer.act(async () => {
      chevron.props.onPress()
    })
    await settle()
    await press(tree, i18n.t('passkey.create'))

    signedInPinned()
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('Add wallet, through Import and back', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    derivationFails()
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))
    expect(auth.calls.createPasskey).toBe(1)
    await press(tree, i18n.t('addWallet.import'))
    await ReactTestRenderer.act(async () => {
      mockHeldBack()
    })
    await settle()
    await press(tree, i18n.t('passkey.addNew'))

    signedInPinned()
    expect((await loadRegistry()).wallets).toHaveLength(2)
  })

  test('Add wallet, after a Keychain failure with the register done', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<AddWalletScreen />)
    seedRefusedOnce()
    await press(tree, i18n.t('passkey.addNew'))
    expect(allText(tree)).toContain(i18n.t('addWallet.failed'))
    expect(auth.calls.createPasskey).toBe(1)
    await leave(tree)
    warn.mockRestore()

    const again = await mount(<AddWalletScreen />)
    await press(again, i18n.t('passkey.addNew'))

    signedInPinned()
    expect((await loadRegistry()).wallets).toHaveLength(2)
    expect((await passkeyEntryFor((await getActiveWalletId())!))?.created).toBe(true)
  })

  test('the first run, after a Keychain failure, on the same button', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await mount(<App />)
    seedRefusedOnce()
    await press(tree, i18n.t('passkey.create'))
    expect(allText(tree)).toContain(i18n.t('passkey.failed'))
    warn.mockRestore()

    await press(tree, i18n.t('common.retry'))

    signedInPinned()
    expect(allText(tree)).toContain('Create a PIN')
  })

  test('an answer landing after the screen left still counts', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    let answer: (value?: unknown) => void = () => undefined
    auth.gate = new Promise(resolve => {
      answer = resolve
    })
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))
    await leave(tree)
    auth.gate = null
    answer()
    await new Promise(resolve => setTimeout(resolve, 5))

    const again = await mount(<AddWalletScreen />)
    await press(again, i18n.t('passkey.addNew'))

    signedInPinned()
  })

  test('once a wallet took it, the next new wallet registers its own', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    const tree = await mount(<AddWalletScreen />)
    await press(tree, i18n.t('passkey.addNew'))
    await leave(tree)

    const again = await mount(<AddWalletScreen />)
    await press(again, i18n.t('passkey.addNew'))

    expect(auth.calls.createPasskey).toBe(2)
    expect((await loadRegistry()).wallets).toHaveLength(3)
  })
})

describe('the text says only what was measured', () => {
  const card = async (eligible: boolean | null) => {
    auth.backupEligible = eligible
    const id = await addFirstPasskeyWallet(await passkeyAttempt('register')())
    return { id, tree: await mount(<PasskeyCard walletId={id} />) }
  }

  test('syncing is said only for true, and as the device saying it', async () => {
    expect(i18n.t('passkey.synced')).toMatch(/^Your device says/)
    const { tree } = await card(true)
    expect(allText(tree)).toContain(i18n.t('passkey.synced'))
  })

  test.each([
    ['false', false],
    ['absent', null],
  ])('backupEligible %s says nothing of syncing', async (_name, eligible) => {
    const { tree } = await card(eligible)
    expect(allText(tree)).not.toContain(i18n.t('passkey.synced'))
  })

  test('nothing says the passkey opens the wallet until a test with the same fingerprint', async () => {
    const { tree } = await card(true)
    expect(allText(tree)).not.toContain(i18n.t('passkey.testSame'))
    await press(tree, i18n.t('passkey.test'))
    expect(allText(tree)).toContain(i18n.t('passkey.testSame'))
  })

  test('a passkey that opens another wallet says so', async () => {
    const { tree, id } = await card(true)
    const entries = JSON.parse(await RNFS.readFile(`${RNFS.DocumentDirectoryPath}/passkey-wallets.json`, 'utf8'))
    const other = auth.credentials[0]
    other.secret = 'another secret'
    expect(entries[id]).toBeDefined()
    await press(tree, i18n.t('passkey.test'))
    expect(allText(tree)).toContain(i18n.t('passkey.testOther'))
    expect(allText(tree)).not.toContain(i18n.t('passkey.testSame'))
  })

  test.each(['ERR_USER_CANCELLED', 'ERR_NO_CREDENTIAL', 'ERR_PASSKEY'])(
    '%s is could not check, and never a lost passkey',
    async code => {
      const { tree } = await card(true)
      auth.failures.deriveSeeds.push({ code, message: 'closed' })
      await press(tree, i18n.t('passkey.test'))
      expect(allText(tree)).toContain(i18n.t('passkey.testUnknown'))
      expect(allText(tree)).not.toContain(i18n.t('passkey.testSame'))
      expect(allText(tree)).not.toContain(i18n.t('passkey.testOther'))
    },
  )

  test('the test is one ceremony and does not repeat', async () => {
    const { tree } = await card(true)
    auth.failures.deriveSeeds.push({ code: 'ERR_USER_CANCELLED', message: 'closed' })
    await press(tree, i18n.t('passkey.test'))
    await settle()
    expect(auth.calls.deriveSeeds).toBe(1)
  })

  test('a wallet of typed words has no card', async () => {
    const id = await addFirstWallet(TYPED, undefined, 'typed')
    const tree = await mount(<PasskeyCard walletId={id} />)
    expect(tree.toJSON()).toBeNull()
    expect(await passkeyEntryFor(id)).toBeNull()
  })
})

// In each language, the words the three lines must not carry: that the passkey stays in an account or
// restores the wallet, the Settings path iOS 18 no longer has, and a face or a finger as the way in.
const OFF_LIMITS: Record<string, RegExp> = {
  ar: /حساب|استعادة|الإعدادات|بوجهك/,
  de: /Konto|wiederherstell|Einstellungen|Gesicht/,
  'en-GB': /account|restore|Settings|face|fingerprint/i,
  'en-US': /account|restore|Settings|face|fingerprint/i,
  'es-MX': /cuenta|restaur|Configuración|cara|huella/,
  es: /cuenta|restaur|Ajustes|cara|huella/,
  'fr-CA': /compte|restaur|Réglages|visage/,
  fr: /compte|restaur|Réglages|visage/,
  he: /חשבון|לשחזר|הגדרות|הפנים/,
  hi: /खाते|वापस ला|सेटिंग्स|चेहरे/,
  id: /akun|memulihkan|Pengaturan|wajah/,
  it: /account|ripristin|Impostazioni|volto/,
  ja: /アカウント|復元|設定|顔/,
  ko: /계정|복원|설정|얼굴/,
  pl: /koncie|przywróc|Ustawienia|twarz/,
  'pt-BR': /conta|restaur|Ajustes|rosto/,
  'pt-PT': /conta|restaur|Definições|rosto/,
  ru: /аккаунт|восстанов|Настройки|лицу/,
  th: /บัญชี|กู้คืน|การตั้งค่า|ใบหน้า/,
  tr: /hesab|geri yükle|Ayarlar|yüz/,
  ur: /اکاؤنٹ|بحال|سیٹنگز|چہرے/,
  vi: /tài khoản|khôi phục|Cài đặt|khuôn mặt/,
  'zh-TW': /帳號|還原|設定|臉部/,
  zh: /账户|恢复|设置|面容/,
}

// In each language, what the iOS refusal must not say: that the person cancelled, that the passkey was
// or was not used, or anything about a wallet.
const NOT_CLAIMED: Record<string, RegExp> = {
  ar: /ألغ|إلغاء|يُستخدم|استخدام|محفظة/,
  de: /abgebrochen|abbrech|verwendet|benutzt|Wallet/i,
  'en-GB': /cancel|used|wallet/i,
  'en-US': /cancel|used|wallet/i,
  'es-MX': /cancel|usó|usad|cartera|billetera/i,
  es: /cancel|usó|usad|cartera|billetera/i,
  'fr-CA': /annul|utilis|portefeuille/i,
  fr: /annul|utilis|portefeuille/i,
  he: /ביטל|ביטול|שימוש|ארנק/,
  hi: /रद्द|उपयोग|वॉलेट/,
  id: /batal|digunakan|dompet/i,
  it: /annull|usat|portafoglio/i,
  ja: /キャンセル|使用|ウォレット/,
  ko: /취소|사용|지갑/,
  pl: /anulow|użyt|portfel/i,
  'pt-BR': /cancel|usad|carteira/i,
  'pt-PT': /cancel|usad|carteira/i,
  ru: /отмен|использ|кошел/i,
  th: /ยกเลิก|ใช้|กระเป๋า/,
  tr: /iptal|kullanıl|cüzdan/i,
  ur: /منسوخ|استعمال|والٹ/,
  vi: /hủy|dùng|ví/i,
  'zh-TW': /取消|使用|錢包/,
  zh: /取消|使用|钱包/,
}

const passkeyLines = (code: string): Record<string, string> =>
  JSON.parse(readFileSync(join(__dirname, `../src/i18n/locales/${code}.json`), 'utf8')).passkey

describe('the lines a person reads with no test behind them', () => {
  test('the table covers every locale', () => {
    const codes = readdirSync(join(__dirname, '../src/i18n/locales')).map(file => file.replace('.json', ''))
    expect(Object.keys(OFF_LIMITS).sort()).toEqual(codes.sort())
    expect(Object.keys(NOT_CLAIMED).sort()).toEqual(codes.sort())
  })

  test.each(Object.entries(OFF_LIMITS))('%s promises nothing about what a passkey restores', (code, words) => {
    const { deleteIos, deleteAndroid, explain } = passkeyLines(code)
    expect(deleteIos).not.toMatch(words)
    expect(deleteAndroid).not.toMatch(words)
    expect(explain).not.toMatch(words)
  })

  test.each(Object.entries(NOT_CLAIMED))(
    'in %s the line names no cancel, no use and no wallet, and is not the line Android shows',
    (code, words) => {
      const { didNotOpen, refused } = passkeyLines(code)
      expect(didNotOpen).not.toMatch(words)
      expect(didNotOpen).not.toContain(refused.replace(/[.。।۔]$/u, ''))
      if (!code.startsWith('en-')) {
        expect(didNotOpen).not.toBe(passkeyLines('en-US').didNotOpen)
      }
    },
  )

  test('removing says what stays and where it is deleted, and nothing else', () => {
    expect(i18n.t('passkey.deleteIos')).toBe(
      'Removing this wallet does not delete its passkey. To delete it, open the Passwords app.',
    )
    expect(i18n.t('passkey.deleteAndroid')).toBe(
      "Removing this wallet does not delete its passkey. To delete it, open your phone's password manager.",
    )
  })

  test('only the answers of a test say what a passkey opens', () => {
    const lines = passkeyLines('en-US')
    expect(Object.keys(lines).filter(key => /\bopens\b/.test(lines[key])).sort()).toEqual(['testOther', 'testSame'])
  })

  test('only the card, on what the device reports, says a passkey syncs', () => {
    const lines = passkeyLines('en-US')
    expect(Object.keys(lines).filter(key => /\bsyncs\b/.test(lines[key])).sort()).toEqual(['synced', 'wordsOwed'])
    expect(lines.synced).toBe('Your device says this passkey syncs to your account.')
    expect(lines.wordsOwed).toMatch(/^Your device did not say this passkey syncs/)
  })
})

describe('the remove warning says where the passkey is', () => {
  test('Edit wallet carries the line for a passkey wallet', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    await addPasskeyWallet(await passkeyAttempt('register')())
    const tree = await mount(<EditWalletScreen />)
    await press(tree, i18n.t('editWallet.remove'))
    expect(question(tree)?.body).toContain(i18n.t('passkey.deleteIos'))
  })

  test('with the switch off Edit wallet draws no card, even for a wallet with a note', async () => {
    await addFirstPasskeyWallet(await passkeyAttempt('register')())
    const on = await mount(<EditWalletScreen />)
    expect(on.root.findAllByType(PasskeyCard)).toHaveLength(1)
    ReactTestRenderer.act(() => on.unmount())

    __setPasskeyLiveForTests(false)
    const off = await mount(<EditWalletScreen />)
    expect(off.root.findAllByType(PasskeyCard)).toHaveLength(0)
  })

  test('a wallet of words draws the same Edit wallet with the switch on as off', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    const on = await mount(<EditWalletScreen />)
    const drawn = JSON.stringify(on.toJSON())
    ReactTestRenderer.act(() => on.unmount())

    __setPasskeyLiveForTests(false)
    const off = await mount(<EditWalletScreen />)
    expect(drawn).toBe(JSON.stringify(off.toJSON()))
  })

  test('and not for a wallet of words', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    await addAndActivateWallet('abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about')
    const tree = await mount(<EditWalletScreen />)
    await press(tree, i18n.t('editWallet.remove'))
    expect(question(tree)?.body).not.toContain(i18n.t('passkey.deleteIos'))
  })
})
