import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import Clipboard from '@react-native-clipboard/clipboard'
import App from '../App'
import { importCheckDue } from '../src/wallet/deletionMark'
import { wordlists } from 'bip39'

// Lowercase letters alone admit the wallet fingerprint: hex spelled only with a to f (`fecffdba`)
// reads as a thirteenth word, roughly one run in 2500. Membership in the wordlist is the test.
const ENGLISH: readonly string[] = wordlists.english

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
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

// Pressable renders as an inner View on RN 0.86 and cannot be found by type, so a button is
// located by the onPress and label pair it renders.
async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const button = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!button) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(() => {
    button.props.onPress()
  })
  // The seed pair is drawn on a macrotask, so every press yields to the timer phase before the
  // words can be asserted on.
  await ReactTestRenderer.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0))
  })
}

// Each mnemonic word renders as its own lowercase Text node on the backup screen.
function shownMnemonic(tree: ReactTestRenderer.ReactTestRenderer): string {
  return allText(tree)
    .filter(text => ENGLISH.includes(text))
    .join(' ')
}

async function setInput(
  tree: ReactTestRenderer.ReactTestRenderer,
  index: number,
  value: string,
): Promise<void> {
  const input = tree.root.findAllByType(TextInput)[index]
  await ReactTestRenderer.act(() => {
    input.props.onChangeText(value)
  })
}

const VALID_12 =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

// A Keychain that keeps what it is given, since the first run reads its seed's presence back before
// making the wallet active. Each test starts from an empty device: the first run records its wallet in
// the registry, and a wallet left listed by the test before would send this run's seed to an id of its
// own instead of the primary slot these tests watch.
const keychain = new Map<string, string>()

beforeEach(() => {
  jest.clearAllMocks()
  keychain.clear()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
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
})

test('creating stores the words on screen at I wrote them down, and nothing before it', async () => {
  const tree = await render()

  await press(tree, 'Create wallet')
  const mnemonic = shownMnemonic(tree)
  expect(mnemonic.split(' ')).toHaveLength(12)
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled()

  await press(tree, 'I wrote them down safely')

  expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1)
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'seed',
    mnemonic,
    expect.objectContaining({ service: 'com.voltz.wallet.seed' }),
  )
  expect(allText(tree)).toContain('Create a PIN')
})

test('leaving the phrase without I wrote them down stores nothing', async () => {
  const tree = await render()

  await press(tree, 'Create wallet')
  expect(shownMnemonic(tree).split(' ')).toHaveLength(12)
  const back = tree.root.find(
    node => node.props.accessibilityLabel === 'Back' && typeof node.props.onPress === 'function',
  )
  await ReactTestRenderer.act(() => {
    back.props.onPress()
  })

  expect(allText(tree)).toContain('Create wallet')
  expect(keychain.size).toBe(0)
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
})

test('the first run offers one way in: no dice, no length, no redraw and no wallet id', async () => {
  const tree = await render()
  expect(allText(tree)).not.toContain('Generate with dice (advanced)')

  await press(tree, 'Create wallet')
  const shown = allText(tree)
  expect(shown).not.toContain('24 words')
  expect(shown).not.toContain('12 words')
  expect(shown).not.toContain('Generate new')
  expect(shown).not.toContain('Wallet ID')
  expect(shown).not.toContain('Add a passphrase')
})

test('importing a valid phrase saves the seed without going through the challenge', async () => {
  const tree = await render()

  await press(tree, 'I already have a wallet')
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    await setInput(tree, i, words[i])
  }
  await press(tree, 'Restore')

  expect(Keychain.setGenericPassword).toHaveBeenCalledTimes(1)
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'seed',
    VALID_12,
    expect.objectContaining({ service: 'com.voltz.wallet.seed' }),
  )
  // A seed deleted at Voltz from another device has its status read once Home can sign for it.
  expect(await importCheckDue('primary')).toBe(true)
})

test('the Paste button spreads the clipboard phrase across all inputs and restores', async () => {
  // A paste into a controlled TextInput never reaches onChangeText on the New Architecture, so the
  // phrase has to arrive through the explicit Paste button.
  jest.mocked(Clipboard.getString).mockResolvedValue(VALID_12)
  const tree = await render()

  await press(tree, 'I already have a wallet')
  const pasteButton = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === 'Paste'))
  await ReactTestRenderer.act(async () => {
    await pasteButton?.props.onPress()
  })

  const values = tree.root.findAllByType(TextInput).map(node => node.props.value)
  expect(values).toEqual(VALID_12.split(' '))

  await press(tree, 'Restore')
  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'seed',
    VALID_12,
    expect.objectContaining({ service: 'com.voltz.wallet.seed' }),
  )
})

test('importing a phrase with an invalid checksum does not save and warns', async () => {
  const tree = await render()

  await press(tree, 'I already have a wallet')
  // Every word is in the wordlist, so only the checksum rejects this phrase.
  for (let i = 0; i < 12; i++) {
    await setInput(tree, i, 'abandon')
  }
  await press(tree, 'Restore')

  expect(allText(tree)).toContain('Invalid phrase. Check the words and their order.')
  expect(Keychain.setGenericPassword).not.toHaveBeenCalled()
})

// The seed is what makes a wallet exist at boot. Written before the passphrase, a kill between the
// two would leave a wallet that opens without its passphrase, which is a different, empty wallet. A
// write that never returns is that kill as the app sees it.
const SEED_WRITE = expect.objectContaining({ service: 'com.voltz.wallet.seed' })

test('restoring with a passphrase writes no seed until the passphrase is stored', async () => {
  // The first Keychain write of the flow never returns.
  jest.mocked(Keychain.setGenericPassword).mockImplementationOnce(() => new Promise<false>(() => undefined))
  const tree = await render()

  await press(tree, 'I already have a wallet')
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    await setInput(tree, i, words[i])
  }
  await press(tree, 'I use a passphrase (advanced)')
  await setInput(tree, 12, 'twenty-fifth')
  await press(tree, 'Restore')

  expect(Keychain.setGenericPassword).toHaveBeenCalledWith(
    'passphrase',
    'twenty-fifth',
    expect.objectContaining({ service: 'com.voltz.wallet.passphrase' }),
  )
  expect(Keychain.setGenericPassword).not.toHaveBeenCalledWith('seed', expect.anything(), SEED_WRITE)
})

test('importing writes no seed until the passphrase entry is cleared', async () => {
  // No passphrase clears any entry a cut-off run left, and that clear comes first as well.
  jest.mocked(Keychain.resetGenericPassword).mockImplementationOnce(() => new Promise<boolean>(() => undefined))
  const tree = await render()

  await press(tree, 'I already have a wallet')
  const words = VALID_12.split(' ')
  for (let i = 0; i < words.length; i++) {
    await setInput(tree, i, words[i])
  }
  await press(tree, 'Restore')

  expect(Keychain.resetGenericPassword).toHaveBeenCalledWith({ service: 'com.voltz.wallet.passphrase' })
  expect(Keychain.setGenericPassword).not.toHaveBeenCalledWith('seed', expect.anything(), SEED_WRITE)
})
