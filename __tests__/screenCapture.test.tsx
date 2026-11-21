import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, AppState, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { BackupScreen } from '../src/screens/BackupScreen'
import { ImportScreen } from '../src/screens/ImportScreen'
import { RecoveryPhraseScreen } from '../src/screens/RecoveryPhraseScreen'
import { VerifyBackupScreen } from '../src/screens/VerifyBackupScreen'
import { PassphraseScreen } from '../src/screens/PassphraseScreen'
import { askedPosition, pickWord } from './support/backupQuiz'
import { BackSlot } from '../src/components/BackHeader'
import { loadPassphraseFor, loadSeedFor } from '../src/wallet/seed'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import RNFS from 'react-native-fs'

jest.mock('../specs/NativeVoltzCapture')
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  PRIMARY_ID: 'primary',
  loadSeedFor: jest.fn(),
  loadPassphraseFor: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn() }))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), setOptions: jest.fn() }),
  usePreventRemove: () => undefined,
}))
jest.mock('../src/screens/PinScreen', () => {
  const react = require('react')
  const { Text: T } = require('react-native')
  return {
    PinScreen: ({ onDone }: { onDone: (pin: string) => void }) =>
      react.createElement(T, { onPress: () => onDone('123456') }, 'pin gate'),
  }
})

const { device } = jest.requireMock('../specs/NativeVoltzCapture') as {
  device: typeof import('../specs/__mocks__/NativeVoltzCapture').device
}

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'
const WORDS = PHRASE.split(' ')

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (c): c is string => typeof c === 'string',
    )
  })
}

// Whichever word is on screen is a word in the recording, so a test asks about all of them.
const wordsDrawn = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  texts(tree).filter(text => WORDS.includes(text))

const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.find(n => n.props.accessibilityLabel === label && typeof n.props.onPress === 'function')

async function act(run: () => void | Promise<void>): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await run()
  })
}

async function renderOf(element: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const renderBackup = (mnemonic = PHRASE) =>
  renderOf(<BackupScreen mnemonic={mnemonic} length={12} onConfirm={jest.fn()} />)

beforeEach(() => {
  device.reset()
  jest.mocked(loadSeedFor).mockResolvedValue(PHRASE)
  jest.mocked(loadPassphraseFor).mockResolvedValue('segredo')
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

describe('the backup grid', () => {
  it('draws no word until the first read answers, so a recording already running never gets one', async () => {
    const tree = await renderBackup()
    expect(device.readsInFlight()).toBe(1)
    expect(wordsDrawn(tree)).toEqual([])
    expect(button(tree, i18n.t('backup.confirm')).props.disabled).toBe(true)

    await act(() => device.answer(false))

    expect(wordsDrawn(tree)).toEqual(WORDS)
    expect(button(tree, i18n.t('backup.confirm')).props.disabled).toBe(false)
  })

  // Past the confirm the wallet exists, and nobody wrote down words they never saw.
  it('keeps the words and the confirm off, and says why, when the screen is already captured', async () => {
    const tree = await renderBackup()
    await act(() => device.answer(true))

    expect(wordsDrawn(tree)).toEqual([])
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))
    expect(button(tree, i18n.t('backup.confirm')).props.disabled).toBe(true)
  })

  it('takes the words off the moment a recording starts and draws them again when it stops', async () => {
    const tree = await renderBackup()
    await act(() => device.answer(false))

    await act(() => device.capturedChange(true))
    expect(wordsDrawn(tree)).toEqual([])
    expect(button(tree, i18n.t('backup.confirm')).props.disabled).toBe(true)

    await act(() => device.capturedChange(false))
    expect(wordsDrawn(tree)).toEqual(WORDS)
    expect(texts(tree)).not.toContain(i18n.t('backup.wordsHidden'))
  })

  it('takes a change over the older read still in flight', async () => {
    const tree = await renderBackup()

    await act(() => device.capturedChange(true))
    await act(() => device.answer(false))

    expect(wordsDrawn(tree)).toEqual([])
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))
  })

  it('keeps the words off when the read fails', async () => {
    const tree = await renderBackup()
    await act(() => device.fail())
    expect(wordsDrawn(tree)).toEqual([])
  })

  // A recording can start while the app is away.
  it('reads again on the way back to the app', async () => {
    const listen = jest.mocked(AppState.addEventListener)
    listen.mockClear()
    const tree = await renderBackup()
    await act(() => device.answer(false))
    const onChange = (state: string) =>
      listen.mock.calls.forEach(([, handler]) => (handler as (next: string) => void)(state))

    await act(() => onChange('background'))
    expect(device.readsInFlight()).toBe(0)

    await act(() => onChange('active'))
    expect(device.readsInFlight()).toBe(1)
    await act(() => device.answer(true))
    expect(wordsDrawn(tree)).toEqual([])
  })

  it('asks to delete a screenshot taken with the words on screen, and says it to a screen reader', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const tree = await renderBackup()
    await act(() => device.answer(false))
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))

    await act(() => device.screenshot())

    expect(texts(tree)).toContain(i18n.t('backup.screenshotTaken'))
    expect(announce).toHaveBeenCalledWith(i18n.t('backup.screenshotTaken'))
    announce.mockRestore()
  })

  it.each([
    ['the read is still out', async () => undefined],
    ['the words are hidden', async () => act(() => device.answer(true))],
  ])('asks nothing of a screenshot taken while %s', async (_what, arrange) => {
    const tree = await renderBackup()
    await arrange()
    await act(() => device.screenshot())
    await act(() => device.answer(false))
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))
  })

  it('asks nothing of a screenshot of a screen that holds no words yet', async () => {
    const tree = await renderBackup('')
    await act(() => device.answer(false))
    await act(() => device.screenshot())
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))
  })

  it('lets go of every signal on the way out, and a late answer lands nowhere', async () => {
    const tree = await renderBackup()
    expect(device.listeners()).toBe(2)
    await act(() => tree.unmount())
    expect(device.listeners()).toBe(0)
    await act(() => device.answer(true))
  })
})

describe('the recovery phrase screen', () => {
  async function reveal(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await renderOf(<RecoveryPhraseScreen />)
    await act(() => tree.root.findByProps({ children: 'pin gate' }).props.onPress())
    await act(() => undefined)
    return tree
  }

  it('hides the words and the passphrase together, since either alone is half a key', async () => {
    const tree = await reveal()
    await act(() => device.answer(false))
    expect(wordsDrawn(tree)).toEqual(WORDS)
    expect(texts(tree)).toContain('segredo')

    await act(() => device.capturedChange(true))

    expect(wordsDrawn(tree)).toEqual([])
    expect(texts(tree)).not.toContain('segredo')
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))
  })

  it('draws nothing of the phrase before the first read answers, even past the PIN', async () => {
    const tree = await reveal()
    expect(wordsDrawn(tree)).toEqual([])
    expect(texts(tree)).not.toContain('segredo')
  })

  it('asks nothing of a screenshot of the PIN pad', async () => {
    const tree = await renderOf(<RecoveryPhraseScreen />)
    await act(() => device.answer(false))
    await act(() => device.screenshot())
    await act(() => tree.root.findByProps({ children: 'pin gate' }).props.onPress())
    await act(() => undefined)
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))
  })

  it('asks to delete a screenshot of the words', async () => {
    const tree = await reveal()
    await act(() => device.answer(false))
    await act(() => device.screenshot())
    expect(texts(tree)).toContain(i18n.t('backup.screenshotTaken'))
  })
})

describe('the check, whose options are words of the phrase', () => {
  // The question names a number and no word, so it stays, and with it the way back to the words.
  it('hides the options with the grid, and keeps the question and its back', async () => {
    const onBack = jest.fn()
    const tree = await renderOf(
      <VerifyBackupScreen mnemonic={PHRASE} onVerified={jest.fn()} onBack={onBack} />,
    )
    expect(wordsDrawn(tree)).toEqual([])
    expect(askedPosition(tree)).not.toBeNull()

    await act(() => device.answer(false))
    expect(wordsDrawn(tree)).toHaveLength(4)

    await act(() => device.capturedChange(true))
    expect(wordsDrawn(tree)).toEqual([])
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))
    expect(askedPosition(tree)).not.toBeNull()
    expect(tree.root.findByType(BackSlot).props.onBack).toBe(onBack)
  })

  it('keeps the questions already answered through a recording', async () => {
    const onVerified = jest.fn()
    const tree = await renderOf(<VerifyBackupScreen mnemonic={PHRASE} onVerified={onVerified} />)
    await act(() => device.answer(false))
    const first = askedPosition(tree)!
    await pickWord(tree, WORDS[first]!)
    const second = askedPosition(tree)

    await act(() => device.capturedChange(true))
    await act(() => device.capturedChange(false))

    expect(askedPosition(tree)).toBe(second)
    await pickWord(tree, WORDS[second!]!)
    await pickWord(tree, WORDS[askedPosition(tree)!]!)
    expect(onVerified).toHaveBeenCalledTimes(1)
  })
})

describe('the restore fields, where the words are typed', () => {
  const fields = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)

  it('leave the screen with a recording and come back with what was typed', async () => {
    const tree = await renderOf(<ImportScreen onImported={jest.fn()} />)
    expect(fields(tree)).toHaveLength(0)
    await act(() => device.answer(false))
    expect(fields(tree)).toHaveLength(12)
    await act(() => fields(tree)[0].props.onChangeText('abandon'))

    await act(() => device.capturedChange(true))
    expect(fields(tree)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))

    await act(() => device.capturedChange(false))
    expect(fields(tree)[0].props.value).toBe('abandon')
  })

  it('take the suggestions along, which spell out the word being typed', async () => {
    const tree = await renderOf(<ImportScreen onImported={jest.fn()} />)
    await act(() => device.answer(false))
    await act(() => fields(tree)[0].props.onFocus())
    await act(() => fields(tree)[0].props.onChangeText('aban'))
    expect(texts(tree)).toContain('abandon')

    await act(() => device.capturedChange(true))
    expect(texts(tree)).not.toContain('abandon')

    await act(() => device.capturedChange(false))
    expect(texts(tree)).not.toContain('abandon')
  })

  it('ask to delete a screenshot only once a word is typed', async () => {
    const tree = await renderOf(<ImportScreen onImported={jest.fn()} />)
    await act(() => device.answer(false))
    await act(() => device.screenshot())
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))

    await act(() => fields(tree)[0].props.onChangeText('abandon'))
    await act(() => device.screenshot())
    expect(texts(tree)).toContain(i18n.t('backup.screenshotTaken'))
  })
})

describe('the passphrase step of a new wallet, where the field can be revealed', () => {
  const fields = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)

  async function adding(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await renderOf(<PassphraseScreen onDone={jest.fn()} />)
    const add = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(text => text.props.children === i18n.t('passphrase.add')))!
    await act(() => add.props.onPress())
    return tree
  }

  it('draws no field until the first read answers', async () => {
    const tree = await adding()
    expect(fields(tree)).toHaveLength(0)
    await act(() => device.answer(false))
    expect(fields(tree)).toHaveLength(1)
  })

  it('takes the field off with a recording, says why, and brings back what was typed', async () => {
    const tree = await adding()
    await act(() => device.answer(false))
    await act(() => fields(tree)[0].props.onChangeText('segredo'))

    await act(() => device.capturedChange(true))
    expect(fields(tree)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))

    await act(() => device.capturedChange(false))
    expect(fields(tree)[0].props.value).toBe('segredo')
    expect(texts(tree)).not.toContain(i18n.t('backup.wordsHidden'))
  })

  it('asks to delete a screenshot only once something is typed', async () => {
    const tree = await adding()
    await act(() => device.answer(false))
    await act(() => device.screenshot())
    expect(texts(tree)).not.toContain(i18n.t('backup.screenshotTaken'))

    await act(() => fields(tree)[0].props.onChangeText('segredo'))
    await act(() => device.screenshot())
    expect(texts(tree)).toContain(i18n.t('backup.screenshotTaken'))
  })
})

// A passphrase field can be revealed, so on every screen that has one it leaves with the words.
describe('the passphrase fields beside the words', () => {
  const fields = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)
  const pressText = async (tree: ReactTestRenderer.ReactTestRenderer, label: string) => {
    const target = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(text => text.props.children === label))!
    await act(() => target.props.onPress())
  }

  it('on the backup screen, leave with a recording and come back with what was typed', async () => {
    const tree = await renderOf(
      <BackupScreen mnemonic={PHRASE} length={12} passphrase onConfirm={jest.fn()} />,
    )
    await act(() => device.answer(false))
    await pressText(tree, i18n.t('passphrase.add'))
    expect(fields(tree)).toHaveLength(1)
    await act(() => fields(tree)[0].props.onChangeText('segredo'))

    await act(() => device.capturedChange(true))
    expect(fields(tree)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('backup.wordsHidden'))

    await act(() => device.capturedChange(false))
    expect(fields(tree)[0].props.value).toBe('segredo')
  })

  it('on the backup screen, wait for the first read', async () => {
    const tree = await renderOf(
      <BackupScreen mnemonic={PHRASE} length={12} passphrase onConfirm={jest.fn()} />,
    )
    await pressText(tree, i18n.t('passphrase.add'))
    expect(fields(tree)).toHaveLength(0)
  })

  it('on the restore screen, leave with a recording and come back with what was typed', async () => {
    const tree = await renderOf(<ImportScreen onImported={jest.fn()} initial={{ phrase: PHRASE, passphrase: '' }} />)
    expect(fields(tree)).toHaveLength(0)
    await act(() => device.answer(false))
    const passField = () =>
      fields(tree).find(c => c.props.placeholder === i18n.t('import.passphrasePlaceholder'))
    await act(() => passField()!.props.onChangeText('segredo'))

    await act(() => device.capturedChange(true))
    expect(passField()).toBeUndefined()
    expect(fields(tree)).toHaveLength(0)

    await act(() => device.capturedChange(false))
    expect(passField()!.props.value).toBe('segredo')
  })

  // The keyboard would otherwise come back on its own the moment a recording stops.
  it('on the restore screen, come back waiting to be tapped', async () => {
    const tree = await renderOf(<ImportScreen onImported={jest.fn()} />)
    await act(() => device.answer(false))
    const toggle = tree.root.find(n => n.props.accessibilityRole === 'switch' && n.props.onPress != null)
    await act(() => toggle.props.onPress())
    const passField = () =>
      fields(tree).find(c => c.props.placeholder === i18n.t('import.passphrasePlaceholder'))
    expect(passField()!.props.autoFocus).toBe(true)

    await act(() => device.capturedChange(true))
    await act(() => device.capturedChange(false))
    expect(passField()!.props.autoFocus).toBe(false)
  })
})
