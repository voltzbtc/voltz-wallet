import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import { wordlists } from 'bip39'
import App from '../App'
import i18n from '../src/i18n'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { RecoveryPhraseScreen } from '../src/screens/RecoveryPhraseScreen'
import {
  addAndActivateWallet,
  addFirstWallet,
  getWalletIdentity,
  removeWalletById,
  switchWalletWithoutReconnecting,
} from '../src/wallet/wallet'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { isUnconfirmed } from '../src/wallet/backupMark'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'
import { formatFingerprint } from '../src/wallet/walletIdentity'
import { answerQuiz, askedPosition, missQuiz, pickWord } from './support/backupQuiz'

// The words a person writes down are the only way back to the wallet, so what the recovery phrase
// screen shows has to be what that wallet was created or restored with, whichever wallet is active.
// Nothing between the two is replaced here: the screens, the PIN gate, the registry and the seed store
// are the real modules, over the in-memory fs and a Keychain that keeps each service apart. A double
// of the seed store or of the active pointer would hold whichever read the double was written for.

const mockNavigate = jest.fn()
const mockGoBack = jest.fn()
const mockSetOptions = jest.fn()

jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions }),
  usePreventRemove: () => undefined,
}))

const PIN_SERVICE = 'com.voltz.wallet.pin'
const PIN = '123456'
const ENGLISH: readonly string[] = wordlists.english

const FIRST = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const TYPED = 'zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong'

const keychain = new Map<string, string>()

type Tree = ReactTestRenderer.ReactTestRenderer

function allText(tree: Tree): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

const wordsOn = (tree: Tree): string[] => allText(tree).filter(text => ENGLISH.includes(text))

async function settle(): Promise<void> {
  // The seed pair is drawn on a macrotask, so yielding to microtasks alone leaves the skeleton up.
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

async function unmount(tree: Tree): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.unmount()
  })
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

async function confirmWords(tree: Tree, words: readonly string[]): Promise<void> {
  await answerQuiz(tree, words)
  await settle()
}

async function typePhrase(tree: Tree, phrase: string): Promise<void> {
  const words = phrase.split(' ')
  for (let i = 0; i < words.length; i++) {
    const input = tree.root.findAllByType(TextInput)[i]
    await ReactTestRenderer.act(async () => {
      input.props.onChangeText(words[i])
    })
  }
  await settle()
  await press(tree, i18n.t('import.restore'))
}

async function rollDice(tree: Tree, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    const face = String((i % 6) + 1)
    const target = tree.root.find(n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === face)
    await ReactTestRenderer.act(async () => {
      target.props.onPress()
    })
  }
  await press(tree, i18n.t('dice.generate'))
}

// The words a person would write down from each way into a wallet, through the Add wallet screens.
const ADD_WALLET: [string, (tree: Tree) => Promise<string[]>][] = [
  [
    'created with 12 words',
    async tree => {
      await press(tree, i18n.t('addWallet.create'))
      const written = wordsOn(tree)
      expect(written).toHaveLength(12)
      await press(tree, i18n.t('backup.confirm'))
      return written
    },
  ],
  [
    'created with 24 words',
    async tree => {
      await press(tree, i18n.t('addWallet.create'))
      await press(tree, i18n.t('welcome.words', { count: 24 }))
      const written = wordsOn(tree)
      expect(written).toHaveLength(24)
      await press(tree, i18n.t('backup.confirm'))
      return written
    },
  ],
  [
    'generated from dice',
    async tree => {
      await press(tree, i18n.t('welcome.dice'))
      await rollDice(tree, 54)
      const written = wordsOn(tree)
      expect(written).toHaveLength(12)
      await press(tree, i18n.t('backup.confirm'))
      await confirmWords(tree, written)
      await press(tree, i18n.t('passphrase.continue'))
      return written
    },
  ],
  [
    'restored from its words',
    async tree => {
      await press(tree, i18n.t('addWallet.import'))
      await typePhrase(tree, TYPED)
      return TYPED.split(' ')
    },
  ],
]

async function addThroughTheScreens(add: (tree: Tree) => Promise<string[]>): Promise<string[]> {
  const tree = await mount(<AddWalletScreen />)
  const written = await add(tree)
  expect(mockNavigate).toHaveBeenCalledWith('Main')
  await unmount(tree)
  return written
}

async function pastTheGate(): Promise<Tree> {
  keychain.set(PIN_SERVICE, PIN)
  const tree = await mount(<RecoveryPhraseScreen />)
  for (const digit of PIN) {
    const [key] = tree.root.findAll(n => n.props.label === digit && typeof n.props.onPress === 'function')
    await ReactTestRenderer.act(async () => {
      key.props.onPress()
    })
  }
  await settle()
  return tree
}

// The screen behind its PIN, as the drawer opens it.
async function recoveryPhrase(): Promise<{ words: string[]; text: string[] }> {
  const tree = await pastTheGate()
  const shown = { words: wordsOn(tree), text: allText(tree) }
  await unmount(tree)
  return shown
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

describe.each(ADD_WALLET)('a wallet %s beside the first one', (_how, add) => {
  test('shows the words it was written down with, under the id the drawer shows', async () => {
    await addFirstWallet(FIRST, undefined, 'drawn')

    const written = await addThroughTheScreens(add)
    const id = fingerprintFromMnemonic(written.join(' '))

    const shown = await recoveryPhrase()
    expect(shown.words).toEqual(written)
    expect(shown.text).toContain(formatFingerprint(id))
    expect((await getWalletIdentity()).fingerprint).toBe(id)
  })
})

test('the first wallet shows its own words again once it is the active one', async () => {
  await addFirstWallet(FIRST, undefined, 'drawn')
  const written = await addThroughTheScreens(ADD_WALLET[0][1])
  const { active, wallets } = await loadRegistry()
  const first = wallets.find(w => w.id !== active)!

  await switchWalletWithoutReconnecting(first.id)
  expect((await recoveryPhrase()).words).toEqual(FIRST.split(' '))

  await switchWalletWithoutReconnecting(active!)
  expect((await recoveryPhrase()).words).toEqual(written)
})

test('the words of a wallet restored twice stay on screen, and the list keeps one row for it', async () => {
  await addFirstWallet(FIRST, undefined, 'drawn')
  const restore = ADD_WALLET[3][1]
  await addThroughTheScreens(restore)

  const tree = await mount(<AddWalletScreen />)
  await restore(tree)
  expect(allText(tree).join(' ')).toContain(formatFingerprint(fingerprintFromMnemonic(TYPED)))
  await unmount(tree)

  expect((await loadRegistry()).wallets).toHaveLength(2)
  expect((await recoveryPhrase()).words).toEqual(TYPED.split(' '))
})

test('the words of the wallet left behind show once the first wallet is removed', async () => {
  await addFirstWallet(FIRST, undefined, 'drawn')
  const written = await addThroughTheScreens(ADD_WALLET[0][1])
  const { active, wallets } = await loadRegistry()
  const first = wallets.find(w => w.id !== active)!

  await removeWalletById(first.id, first.fingerprint)

  expect((await recoveryPhrase()).words).toEqual(written)
})

test('a passphrase wallet shows its words and its passphrase, under the id of both', async () => {
  await addFirstWallet(FIRST, undefined, 'drawn')
  await addAndActivateWallet(TYPED, 'correct horse')

  const shown = await recoveryPhrase()

  expect(shown.words).toEqual(TYPED.split(' '))
  expect(shown.text).toContain('correct horse')
  expect(shown.text).toContain(formatFingerprint(fingerprintFromMnemonic(TYPED, 'correct horse')))
})

describe('the first-run wallet', () => {
  test('created in the onboarding shows the words written down there', async () => {
    const app = await mount(<App />)
    await press(app, i18n.t('welcome.create'))
    const written = wordsOn(app)
    expect(written).toHaveLength(12)
    await press(app, i18n.t('backup.confirm'))
    await unmount(app)

    expect((await recoveryPhrase()).words).toEqual(written)
  })

  test('restored in the onboarding shows the words typed there', async () => {
    const app = await mount(<App />)
    await press(app, i18n.t('welcome.import'))
    await typePhrase(app, TYPED)
    await unmount(app)

    expect((await recoveryPhrase()).words).toEqual(TYPED.split(' '))
  })
})

describe('confirming the words of a wallet that carries the mark', () => {
  const confirm = () => i18n.t('backup.confirmWords')

  test('of the active wallet, not of the first, and only the right words clear the mark', async () => {
    const first = await addFirstWallet(FIRST, undefined, 'drawn')
    const second = await addAndActivateWallet(TYPED, undefined, 'drawn')
    expect(await isUnconfirmed(first)).toBe(true)
    expect(await isUnconfirmed(second)).toBe(true)

    const tree = await pastTheGate()
    const words = wordsOn(tree)
    expect(words).toEqual(TYPED.split(' '))
    await press(tree, confirm())

    // A wrong word leaves the mark, and the screen asks again.
    const missed = askedPosition(tree)!
    await missQuiz(tree, words)
    expect(allText(tree)).toContain(i18n.t('backup.quizWrong', { number: String(missed + 1) }))
    expect(await isUnconfirmed(second)).toBe(true)
    expect(mockGoBack).not.toHaveBeenCalled()

    await confirmWords(tree, words)
    expect(await isUnconfirmed(second)).toBe(false)
    expect(await isUnconfirmed(first)).toBe(true)
    expect(allText(tree)).toContain(i18n.t('backup.confirmedTitle'))
    await press(tree, i18n.t('backup.confirmedDone'))
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    await unmount(tree)
  })

  test('the right words but one leave the mark', async () => {
    const id = await addFirstWallet(TYPED, undefined, 'drawn')
    const tree = await pastTheGate()
    const words = wordsOn(tree)
    await press(tree, confirm())

    await pickWord(tree, words[askedPosition(tree)!]!)
    await pickWord(tree, words[askedPosition(tree)!]!)
    await missQuiz(tree, words)

    expect(await isUnconfirmed(id)).toBe(true)
    expect(mockGoBack).not.toHaveBeenCalled()
    await unmount(tree)
  })

  test('a word the phrase repeats passes, and the mark goes', async () => {
    const id = await addFirstWallet(TYPED, undefined, 'drawn')
    const tree = await pastTheGate()
    await press(tree, confirm())
    await confirmWords(tree, TYPED.split(' '))
    expect(await isUnconfirmed(id)).toBe(false)
    await unmount(tree)
  })

  test('writes the mark file and nothing else, and no position reaches the disk', async () => {
    const id = await addFirstWallet(TYPED, undefined, 'drawn')
    const tree = await pastTheGate()
    await press(tree, confirm())
    jest.mocked(Keychain.setGenericPassword).mockClear()
    const write = jest.spyOn(RNFS, 'writeFile')

    await confirmWords(tree, TYPED.split(' '))

    expect(write.mock.calls.length).toBeGreaterThan(0)
    expect(write.mock.calls.every(([path]) => /backup-marks\.json(\.tmp)?$/.test(path))).toBe(true)
    expect(write.mock.calls.every(([, content]) => content === '[]')).toBe(true)
    expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
    expect(await isUnconfirmed(id)).toBe(false)
    await unmount(tree)
    write.mockRestore()
  })

  test('a confirmation that could not be kept says so, and Try again keeps it without asking again', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const id = await addFirstWallet(TYPED, undefined, 'drawn')
    const tree = await pastTheGate()
    await press(tree, confirm())
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))

    await confirmWords(tree, TYPED.split(' '))

    expect(allText(tree)).toContain(i18n.t('backup.confirmFailed'))
    expect(await isUnconfirmed(id)).toBe(true)
    expect(mockGoBack).not.toHaveBeenCalled()

    await press(tree, i18n.t('common.retry'))
    expect(await isUnconfirmed(id)).toBe(false)
    expect(allText(tree)).toContain(i18n.t('backup.confirmedTitle'))
    await press(tree, i18n.t('backup.confirmedDone'))
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    await unmount(tree)
    write.mockRestore()
    warn.mockRestore()
  })

  test('a wallet with no mark shows the words with nothing to confirm', async () => {
    await addFirstWallet(TYPED, undefined, 'typed')
    const shown = await recoveryPhrase()
    expect(shown.words).toEqual(TYPED.split(' '))
    expect(shown.text).not.toContain(i18n.t('backup.confirmWords'))
  })
})

test('the gate of the recovery phrase offers no way out of a forgotten PIN', async () => {
  await addFirstWallet(TYPED, undefined, 'drawn')
  keychain.set(PIN_SERVICE, PIN)
  const tree = await mount(<RecoveryPhraseScreen />)
  expect(allText(tree)).toContain(i18n.t('pin.enter'))
  expect(allText(tree)).not.toContain(i18n.t('pin.forgot'))
  await unmount(tree)
})
