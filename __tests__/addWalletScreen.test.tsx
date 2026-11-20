import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import '../src/i18n'
import i18n from '../src/i18n'
import { answerQuiz, missQuiz, onQuiz } from './support/backupQuiz'
import { AddWalletScreen } from '../src/screens/AddWalletScreen'
import { Txt } from '../src/components/Txt'
import { generateMnemonic } from '../src/wallet/seed'
import { addAndActivateWallet } from '../src/wallet/wallet'
import { WalletRowsSkeleton } from '../src/components/WalletRowsSkeleton'
import { GradientButton } from '../src/components/GradientButton'
import { touch } from '../src/theme'
import { saveWalletMeta } from '../src/wallet/walletMeta'
import { wordlists } from 'bip39'

// Back steps through the stages held in this screen's state. Popping the whole screen would drop
// the generated seed and draw a fresh one on re-entry.

const mockNavigate = jest.fn()
const mockGoBack = jest.fn()
const mockSetOptions = jest.fn()
// usePreventRemove intercepts back while active and its callback steps the internal stage.
let preventActive = false
let preventCb: (() => void) | null = null

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setOptions: mockSetOptions }),
  usePreventRemove: (active: boolean, cb: () => void) => {
    preventActive = active
    preventCb = cb
  },
}))
// DiceScreen imports several real seed helpers, so only generateMnemonic is stubbed.
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  generateMnemonic: jest.fn(),
}))
jest.mock('../src/wallet/wallet', () => ({
  addAndActivateWallet: jest.fn(async () => undefined),
  // The real check reads the error's name, which this keeps.
  isWalletAlreadyAdded: (err: unknown) => (err as Error | null)?.name === 'WalletAlreadyAdded',
}))
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))

const ENGLISH: readonly string[] = wordlists.english
const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const VALID_24 = `${'abandon '.repeat(23)}art`

async function settle(): Promise<void> {
  // The seed pair is drawn on a macrotask, so yielding to microtasks alone leaves the skeleton up.
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

let current: ReactTestRenderer.ReactTestRenderer | null = null

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(<AddWalletScreen />)
  })
  await settle()
  return current!
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

// One title per step: the header takes the step's own, and the body does not draw it again.
test('the dice and backup steps give their title to the header', async () => {
  const tree = await render()
  expect(mockSetOptions).toHaveBeenLastCalledWith({ title: i18n.t('addWallet.title') })

  await press(tree, i18n.t('welcome.dice'))
  expect(mockSetOptions).toHaveBeenLastCalledWith({ title: i18n.t('dice.title') })
  expect(allText(tree)).not.toContain(i18n.t('dice.title'))
  expect(allText(tree)).toContain(i18n.t('dice.subtitle'))

  await fireBack()
  await press(tree, i18n.t('addWallet.create'))
  expect(mockSetOptions).toHaveBeenLastCalledWith({ title: i18n.t('backup.title') })
  expect(allText(tree)).not.toContain(i18n.t('backup.title'))
})

// A wrap that leaves one word alone on the last line of a centred line reads as a mistake.
test('the subtitle rebalances its lines rather than leaving a word alone', async () => {
  const tree = await render()
  const subtitle = tree.root
    .findAllByType(Txt)
    .find(n => n.props.children === i18n.t('addWallet.subtitle'))!
  expect(subtitle.props.textBreakStrategy).toBe('balanced')
  expect(subtitle.props.lineBreakStrategyIOS).toBe('standard')
})

test('the import step gives its title to the header and keeps Paste', async () => {
  const tree = await render()
  await press(tree, i18n.t('addWallet.import'))

  expect(mockSetOptions).toHaveBeenLastCalledWith({ title: i18n.t('import.title') })
  expect(allText(tree)).not.toContain(i18n.t('import.title'))
  expect(allText(tree)).toContain(i18n.t('import.subtitle'))
  expect(allText(tree)).toContain(i18n.t('import.paste'))
})

// Header chevron, swipe and hardware back all route through usePreventRemove.
async function fireBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    preventCb?.()
  })
  await settle()
}

beforeEach(async () => {
  mockNavigate.mockClear()
  mockGoBack.mockClear()
  jest.mocked(addAndActivateWallet).mockClear()
  preventActive = false
  preventCb = null
  jest.mocked(generateMnemonic).mockReset().mockReturnValue(VALID_12)
  await i18n.changeLanguage('en-US')
})

afterEach(async () => {
  if (current) {
    await ReactTestRenderer.act(async () => {
      current!.unmount()
    })
    current = null
  }
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

async function rollDice(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
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
}

describe('a drawn phrase', () => {
  test('is added at I wrote them down, with no confirmation or passphrase step between', async () => {
    const tree = await render()

    await press(tree, 'Create new wallet')
    await press(tree, 'I wrote them down safely')

    expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
    expect(addAndActivateWallet).toHaveBeenCalledWith(VALID_12, '', 'drawn')
    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })

  test('keeps 24 words and a redraw on the phrase step', async () => {
    jest.mocked(generateMnemonic).mockImplementation(length => (length === 24 ? VALID_24 : VALID_12))
    const tree = await render()

    await press(tree, 'Create new wallet')
    expect(generateMnemonic).toHaveBeenCalledTimes(2)
    await press(tree, 'Generate new')
    expect(generateMnemonic).toHaveBeenCalledTimes(4)
    await press(tree, '24 words')
    await press(tree, 'I wrote them down safely')

    expect(addAndActivateWallet).toHaveBeenCalledWith(VALID_24, '', 'drawn')
  })

  test('takes a passphrase from a closed link, and an empty open field cannot be confirmed', async () => {
    const tree = await render()
    await press(tree, 'Create new wallet')
    expect(allText(tree)).not.toContain('Passphrase')
    expect(tree.root.findAllByType(TextInput)).toHaveLength(0)

    await press(tree, 'Add a passphrase')
    const button = tree.root.findAllByType(GradientButton).find(b => b.props.label === 'I wrote them down safely')!
    expect(button.props.disabled).toBe(true)

    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('twenty-fifth')
    })
    await press(tree, 'I wrote them down safely')
    expect(addAndActivateWallet).toHaveBeenCalledWith(VALID_12, 'twenty-fifth', 'drawn')
  })

  test('a passphrase closed again is not used', async () => {
    const tree = await render()
    await press(tree, 'Create new wallet')
    await press(tree, 'Add a passphrase')
    await ReactTestRenderer.act(async () => {
      tree.root.findAllByType(TextInput)[0]!.props.onChangeText('twenty-fifth')
    })
    await press(tree, 'Do not use a passphrase')
    await press(tree, 'I wrote them down safely')
    expect(addAndActivateWallet).toHaveBeenCalledWith(VALID_12, '', 'drawn')
  })

  test('two taps in one moment add once', async () => {
    const tree = await render()
    await press(tree, 'Create new wallet')
    const button = tree.root.findAllByType(GradientButton).find(b => b.props.label === 'I wrote them down safely')!
    await ReactTestRenderer.act(async () => {
      button.props.onPress()
      button.props.onPress()
    })
    await settle()
    expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
  })

  test('refused as already here steps back to the phrase', async () => {
    jest.mocked(addAndActivateWallet).mockRejectedValueOnce(
      Object.assign(new Error('already added'), { name: 'WalletAlreadyAdded', walletId: 'w_ok', fingerprint: 'a1b2c3d4' }),
    )
    const tree = await render()
    await press(tree, 'Create new wallet')
    await press(tree, 'I wrote them down safely')
    await press(tree, 'Back')
    expect(allText(tree)).toContain('I wrote them down safely')
    expect(allText(tree)).toContain('abandon')
  })
})

describe('a dice phrase', () => {
  test('keeps its confirmation and its passphrase step, and is added after both', async () => {
    const tree = await render()
    await rollDice(tree)
    const words = allText(tree).filter(text => ENGLISH.includes(text))
    expect(words).toHaveLength(12)
    expect(allText(tree)).not.toContain('Add a passphrase')

    await press(tree, 'I wrote them down safely')
    expect(onQuiz(tree)).toBe(true)
    // The question is asked on screen, so the header keeps the short name.
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Recovery phrase' })
    expect(addAndActivateWallet).not.toHaveBeenCalled()

    await confirmDice(tree, words)
    expect(allText(tree)).toContain(i18n.t('passphrase.subtitle'))
    expect(allText(tree)).not.toContain('Passphrase (optional)')
    expect(mockSetOptions).toHaveBeenLastCalledWith({ title: 'Passphrase (optional)' })
    expect(addAndActivateWallet).not.toHaveBeenCalled()

    await press(tree, 'Continue')
    expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
    // Confirmed, so the wallet starts with no mark.
    expect(addAndActivateWallet).toHaveBeenCalledWith(words.join(' '), '', 'confirmed')
  })

  test('a wrong pick offers the same words again, and nothing is added', async () => {
    const tree = await render()
    await rollDice(tree)
    const words = allText(tree).filter(text => ENGLISH.includes(text))
    await press(tree, 'I wrote them down safely')
    await missQuiz(tree, words)
    await press(tree, i18n.t('backup.showWords'))
    expect(allText(tree).filter(text => ENGLISH.includes(text))).toEqual(words)
    expect(addAndActivateWallet).not.toHaveBeenCalled()
  })

  test('a step back from the confirmation keeps the same words', async () => {
    const tree = await render()
    await rollDice(tree)
    const words = allText(tree).filter(text => ENGLISH.includes(text))
    await press(tree, 'I wrote them down safely')
    expect(preventActive).toBe(true)
    await fireBack()
    expect(allText(tree).filter(text => ENGLISH.includes(text))).toEqual(words)
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})

async function confirmDice(tree: ReactTestRenderer.ReactTestRenderer, words: readonly string[]): Promise<void> {
  await answerQuiz(tree, words)
}

test('the choose stage offers generating a wallet from dice', async () => {
  const tree = await render()
  expect(allText(tree)).toContain('Generate with dice (advanced)')
})

describe('a wallet that fails to be added', () => {
  async function importPhrase(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    await press(tree, 'Import wallet')
    const cells = tree.root.findAllByType(TextInput)
    await ReactTestRenderer.act(async () => {
      VALID_12.split(' ').forEach((word, i) => cells[i]!.props.onChangeText(word))
    })
    await press(tree, 'Restore')
  }

  test('leaves the skeleton for an error, and never reaches Home', async () => {
    jest.mocked(addAndActivateWallet).mockRejectedValueOnce(new Error('keychain unavailable'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await render()

    await importPhrase(tree)

    expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
    expect(tree.root.findAllByType(WalletRowsSkeleton)).toHaveLength(0)
    expect(allText(tree)).toContain(
      'The wallet could not be added. Check your wallet list before trying again.',
    )
    expect(mockNavigate).not.toHaveBeenCalled()
    // The registry may already list the wallet, so the screen offers the list rather than the phrase.
    expect(allText(tree)).not.toContain('Restore')
    await press(tree, 'Back')
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    expect(addAndActivateWallet).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  // The refusal comes before anything is written, so the screen names the wallet already here
  // and steps back to the phrase, kept, instead of sending the person to the list.
  function alreadyAdded(walletId: string, fingerprint: string): Error {
    return Object.assign(new Error('already added'), { name: 'WalletAlreadyAdded', walletId, fingerprint })
  }

  test('the same wallet again is named, and Back returns to the phrase with it kept', async () => {
    await saveWalletMeta('fp-savings', { name: 'Savings' })
    jest.mocked(addAndActivateWallet).mockRejectedValueOnce(alreadyAdded('w_ok', 'fp-savings'))
    const tree = await render()

    await importPhrase(tree)

    expect(allText(tree)).toContain('This wallet is already in the app as Savings, Wallet ID fp-savings.')
    expect(allText(tree)).not.toContain(
      'The wallet could not be added. Check your wallet list before trying again.',
    )
    expect(mockNavigate).not.toHaveBeenCalled()
    await press(tree, 'Back')
    expect(mockGoBack).not.toHaveBeenCalled()
    expect(tree.root.findAllByType(TextInput).slice(0, 12).map(cell => cell.props.value)).toEqual(VALID_12.split(' '))
    await press(tree, 'Restore')
    expect(addAndActivateWallet).toHaveBeenNthCalledWith(2, VALID_12, undefined, 'typed')
  })

  test('the native back from the refusal returns to the phrase too, and a wallet with no name reads as the list does', async () => {
    // The default name says nothing about which wallet this is, so the id the list shows under it
    // follows, written as the list writes it.
    jest.mocked(addAndActivateWallet).mockRejectedValueOnce(alreadyAdded('w_ok', ' A1B2C3D4'))
    const tree = await render()

    await importPhrase(tree)
    expect(allText(tree)).toContain('This wallet is already in the app as Wallet, Wallet ID a1b2c3d4.')
    expect(preventActive).toBe(true)
    await fireBack()

    expect(allText(tree)).toContain('Restore')
    expect(tree.root.findAllByType(TextInput)[0]!.props.value).toBe('abandon')
  })

  test('a wallet that is added still lands on Home', async () => {
    const tree = await render()
    await importPhrase(tree)
    expect(addAndActivateWallet).toHaveBeenCalledWith(VALID_12, undefined, 'typed')
    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })
})

test("the choice follows Welcome's: one full-width button to create, then import and dice as links", async () => {
  const tree = await render()
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign(
      {},
      ...[typeof style === 'function' ? style({ pressed: false }) : style]
        .flat(Infinity)
        .filter(x => x && typeof x === 'object'),
    )

  const buttons = tree.root.findAllByType(GradientButton)
  expect(buttons.map(b => b.props.label)).toEqual(['Create new wallet'])
  // The button takes the row, so its width does not follow the length of the label.
  expect(flat(buttons[0]!.parent!.props.style).alignSelf).toBe('stretch')

  const shown = allText(tree)
  const order = ['Create new wallet', 'Import wallet', 'Generate with dice (advanced)'].map(label =>
    shown.indexOf(label),
  )
  expect(order.every(i => i >= 0)).toBe(true)
  expect(order).toEqual([...order].sort((a, b) => a - b))

  for (const label of ['Import wallet', 'Generate with dice (advanced)']) {
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === label))!
    expect(flat(link.props.style).minHeight).toBe(touch.min)
  }
})
