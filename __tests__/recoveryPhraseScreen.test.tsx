import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { RecoveryPhraseScreen } from '../src/screens/RecoveryPhraseScreen'
import { loadPassphraseFor, loadSeedFor } from '../src/wallet/seed'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { fingerprintFromMnemonic } from '../src/wallet/fingerprint'
import { formatFingerprint } from '../src/wallet/walletIdentity'
import { saveWalletMeta } from '../src/wallet/walletMeta'
import RNFS from 'react-native-fs'
import { GradientButton } from '../src/components/GradientButton'
import { isUnconfirmed, markUnconfirmed } from '../src/wallet/backupMark'
import { answerQuiz, missQuiz, onQuiz } from './support/backupQuiz'

jest.mock('../src/wallet/seed', () => ({ PRIMARY_ID: 'primary', loadSeedFor: jest.fn(), loadPassphraseFor: jest.fn() }))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn() }))
const mockSetOptions = jest.fn()
const mockGoBack = jest.fn()
// What the stack does with a back: the screen's hold takes it while active, else the route goes.
const mockHold = { active: false, onPrevented: () => undefined as void }
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, setOptions: mockSetOptions }),
  usePreventRemove: (active: boolean, onPrevented: () => void) => {
    mockHold.active = active
    mockHold.onPrevented = onPrevented
  },
}))

// Stands in for the real PIN pad and exposes the one thing this screen depends on: the gate resolving.
// Kept as a button rather than firing on mount, so a screen that skipped the gate entirely would show
// the phrase here with nothing to press and the tests would say so.
jest.mock('../src/screens/PinScreen', () => {
  const react = require('react')
  const { Text: T } = require('react-native')
  return {
    PinScreen: ({ onDone }: { onDone: (pin: string) => void }) =>
      react.createElement(T, { onPress: () => onDone('123456') }, 'pin gate'),
  }
})

const PHRASE =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'
// A second wallet's words, so a screen that read the wrong wallet shows the wrong grid.
const OTHER =
  'zoo zone zero youth young yellow year yard wrong write wrist wrap'
const SEEDS: Record<string, string> = { primary: PHRASE, w_2: OTHER }

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (c): c is string => typeof c === 'string',
    )
  })
}

async function reveal(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RecoveryPhraseScreen />)
  })
  const gate = tree.root.findAll(n => n.props.children === 'pin gate')[0]!
  await ReactTestRenderer.act(async () => {
    gate.props.onPress()
  })
  return tree
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(loadSeedFor).mockImplementation(async id => SEEDS[id] ?? null)
  jest.mocked(loadPassphraseFor).mockResolvedValue(undefined)
})

async function startCheck(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  const start = tree.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('backup.confirmWords'))!
  await ReactTestRenderer.act(async () => {
    start.props.onPress()
  })
}

async function back(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    if (mockHold.active) {
      mockHold.onPrevented()
    } else {
      mockGoBack()
    }
  })
}

const WORDS = PHRASE.split(' ')
const onWords = (tree: ReactTestRenderer.ReactTestRenderer): boolean =>
  WORDS.every(word => texts(tree).includes(word))

describe('the check', () => {
  beforeEach(async () => {
    await markUnconfirmed('primary')
  })

  // A long title shrinks to fit the header on a narrow phone, so the check asks on screen instead.
  it('keeps the short name in the header and asks its question on screen', async () => {
    const tree = await reveal()
    await startCheck(tree)
    expect(onQuiz(tree)).toBe(true)
    expect(mockSetOptions).toHaveBeenCalled()
    const titles = mockSetOptions.mock.calls.map(([options]) => options.title)
    expect(titles.every(title => title === i18n.t('settings.recoveryPhrase'))).toBe(true)
  })

  it('steps back to the words, and from the words leaves', async () => {
    const tree = await reveal()
    await startCheck(tree)

    await back()
    expect(onQuiz(tree)).toBe(false)
    expect(onWords(tree)).toBe(true)
    expect(mockGoBack).not.toHaveBeenCalled()
    expect(await isUnconfirmed('primary')).toBe(true)

    await back()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  it('a wrong pick offers the words again, which returns to them with nothing kept', async () => {
    const tree = await reveal()
    await startCheck(tree)
    await missQuiz(tree, WORDS)
    const [link] = tree.root.findAll(
      node =>
        typeof node.props.onPress === 'function' &&
        node.findAllByType(Text).some(text => text.props.children === i18n.t('backup.showWords')),
      { deep: false },
    )
    await ReactTestRenderer.act(async () => link!.props.onPress())

    expect(onWords(tree)).toBe(true)
    expect(await isUnconfirmed('primary')).toBe(true)
    expect(mockGoBack).not.toHaveBeenCalled()
  })

  // Said only once the mark is off the disk, with no word on screen, and left by its button.
  it('the right words keep the confirmation, say so, and Done leaves', async () => {
    const tree = await reveal()
    await startCheck(tree)
    await answerQuiz(tree, WORDS)

    expect(await isUnconfirmed('primary')).toBe(false)
    expect(texts(tree)).toContain(i18n.t('backup.confirmedTitle'))
    expect(texts(tree)).toContain(i18n.t('backup.confirmedBody'))
    expect(WORDS.filter(word => texts(tree).includes(word))).toEqual([])
    expect(onQuiz(tree)).toBe(false)
    expect(mockHold.active).toBe(false)
    expect(mockGoBack).not.toHaveBeenCalled()

    const done = tree.root
      .findAllByType(GradientButton)
      .find(b => b.props.label === i18n.t('backup.confirmedDone'))!
    await ReactTestRenderer.act(async () => done.props.onPress())
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  it('a confirmation the disk refused never says confirmed', async () => {
    const tree = await reveal()
    await startCheck(tree)
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await answerQuiz(tree, WORDS)

    expect(texts(tree)).not.toContain(i18n.t('backup.confirmedTitle'))
    expect(texts(tree)).toContain(i18n.t('backup.confirmFailed'))
    expect(await isUnconfirmed('primary')).toBe(true)
    write.mockRestore()
    warn.mockRestore()
  })
})

it('shows nothing but the PIN gate until it is passed', async () => {
  // The Keychain read happens after the gate resolves, so revealing the phrase always costs a
  // re-authentication. A screen that read first would have the words in memory before anyone asked.
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RecoveryPhraseScreen />)
  })
  expect(texts(tree)).toEqual(['pin gate'])
  expect(loadSeedFor).not.toHaveBeenCalled()
  expect(loadPassphraseFor).not.toHaveBeenCalled()
})

it('shows every word of the phrase, in order', async () => {
  // The only job this screen has.
  const shown = texts(await reveal())
  for (const word of PHRASE.split(' ')) {
    expect(shown).toContain(word)
  }
  const positions = PHRASE.split(' ').map(w => shown.indexOf(w))
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
})

it('numbers the words, since a phrase is copied out in order', async () => {
  const shown = texts(await reveal())
  expect(shown).toContain('1')
  expect(shown).toContain('12')
})

it('warns before the words, not after them', async () => {
  // The warning exists to be read before anyone photographs the screen.
  const shown = texts(await reveal())
  expect(shown.indexOf(i18n.t('recovery.warning'))).toBeLessThan(shown.indexOf('abandon'))
})

it('treats no words in the Keychain as a failed read, never a grid of blanks or a passphrase alone', async () => {
  jest.mocked(loadSeedFor).mockResolvedValue(null)
  for (const secret of [undefined, 'correct horse']) {
    jest.mocked(loadPassphraseFor).mockResolvedValue(secret)
    const shown = texts(await reveal())
    expect(shown).toContain(i18n.t('recovery.readFailed'))
    expect(shown).not.toContain(i18n.t('recovery.warning'))
    expect(shown).not.toContain(i18n.t('passphrase.field'))
    expect(shown).not.toContain('correct horse')
  }
})

it("shows the active wallet's words, never the first wallet's", async () => {
  // The drawer opens this screen under the active wallet's name, and the words written down from it
  // are the only way back to that wallet's funds.
  jest.mocked(getActiveWalletId).mockResolvedValue('w_2')
  const shown = texts(await reveal())
  expect(loadSeedFor).toHaveBeenCalledWith('w_2')
  expect(shown).toContain('zoo')
  expect(shown).not.toContain('abandon')
})

it('falls back to the first wallet when no active wallet is recorded', async () => {
  jest.mocked(getActiveWalletId).mockResolvedValue(null)
  expect(texts(await reveal())).toContain('abandon')
  expect(loadSeedFor).toHaveBeenCalledWith('primary')
})

it("shows the active wallet's passphrase after the words, and nothing when it has none", async () => {
  // A passphrase is part of what restores the wallet: the words alone open a different, empty one.
  jest.mocked(getActiveWalletId).mockResolvedValue('w_2')
  jest.mocked(loadPassphraseFor).mockImplementation(async id => (id === 'w_2' ? 'correct horse' : undefined))
  const shown = texts(await reveal())
  expect(shown).toContain(i18n.t('passphrase.field'))
  expect(shown.indexOf('correct horse')).toBeGreaterThan(shown.indexOf('wrap'))

  jest.mocked(loadPassphraseFor).mockResolvedValue(undefined)
  expect(texts(await reveal())).not.toContain(i18n.t('passphrase.field'))
})

it('names the wallet whose words it shows, as the drawer names it', async () => {
  // The words stand next to the wallet they restore, so a switch that lands mid-read cannot pass one
  // wallet's words off as another's.
  jest.mocked(getActiveWalletId).mockResolvedValue('w_2')
  const shown = texts(await reveal())
  expect(shown).toContain(formatFingerprint(fingerprintFromMnemonic(OTHER)))
  expect(shown).not.toContain(formatFingerprint(fingerprintFromMnemonic(PHRASE)))
  expect(shown).toContain(i18n.t('drawer.walletName'))
  expect(shown.indexOf(i18n.t('drawer.walletName'))).toBeLessThan(shown.indexOf('zoo'))
})

it('names a passphrase wallet by its words and passphrase, under the name the wallets list shows', async () => {
  // The words alone fingerprint another wallet, whose id and name are not the ones this backup restores.
  jest.mocked(getActiveWalletId).mockResolvedValue('w_2')
  jest.mocked(loadPassphraseFor).mockImplementation(async id => (id === 'w_2' ? 'correct horse' : undefined))
  await saveWalletMeta(fingerprintFromMnemonic(OTHER, 'correct horse'), { name: 'Vault' })
  const shown = texts(await reveal())
  expect(shown).toContain(formatFingerprint(fingerprintFromMnemonic(OTHER, 'correct horse')))
  expect(shown).not.toContain(formatFingerprint(fingerprintFromMnemonic(OTHER)))
  expect(shown).toContain('Vault')
  expect(shown).not.toContain(i18n.t('drawer.walletName'))
})

// RP-7. An edge space is invisible on screen, so the warning says at which end and how many.
describe('the edge space warning', () => {
  const language = i18n.language
  afterEach(async () => {
    await i18n.changeLanguage(language)
  })
  const warning = (tree: ReactTestRenderer.ReactTestRenderer): string | undefined => {
    const node = tree.root.findAll(n => n.props.testID === 'recovery-passphrase-spaces' && n.type === Text)[0]
    return node ? [node.props.children].flat().join('') : undefined
  }

  it.each([
    [' a', i18n.t('recovery.passphraseSpacesStart', { count: 1, lng: 'en-US' })],
    ['   a', i18n.t('recovery.passphraseSpacesStart', { count: 3, lng: 'en-US' })],
    ['a  ', i18n.t('recovery.passphraseSpacesEnd', { count: 2, lng: 'en-US' })],
    ['a ', i18n.t('recovery.passphraseSpacesEnd', { count: 1, lng: 'en-US' })],
    [' a  ', i18n.t('recovery.passphraseSpacesBoth', { start: 1, end: 2, lng: 'en-US' })],
    // Spaces alone are counted once, at the start, never twice across the two ends.
    ['  ', i18n.t('recovery.passphraseSpacesStart', { count: 2, lng: 'en-US' })],
  ])('%j says %s, with the passphrase shown as stored', async (secret, said) => {
    await i18n.changeLanguage('en-US')
    jest.mocked(loadPassphraseFor).mockResolvedValue(secret)
    const tree = await reveal()
    expect(warning(tree)).toBe(said)
    expect(texts(tree)).toContain(secret)
  })

  it('reads in English as the counts say, so a wrong key would show', async () => {
    await i18n.changeLanguage('en-US')
    jest.mocked(loadPassphraseFor).mockResolvedValue(' a  ')
    expect(warning(await reveal())).toBe(
      'This passphrase starts and ends with spaces (1 at the start, 2 at the end). Write them down too, or it opens a different wallet.',
    )
    jest.mocked(loadPassphraseFor).mockResolvedValue('a  ')
    expect(warning(await reveal())).toBe(
      'This passphrase ends with 2 spaces. Write them down too, or it opens a different wallet.',
    )
    jest.mocked(loadPassphraseFor).mockResolvedValue(' a')
    expect(warning(await reveal())).toBe(
      'This passphrase starts with 1 space. Write it down too, or it opens a different wallet.',
    )
  })

  it.each(['a b', 'foo bar', 'a'])('%j warns of nothing', async secret => {
    jest.mocked(loadPassphraseFor).mockResolvedValue(secret)
    const tree = await reveal()
    expect(texts(tree)).toContain(i18n.t('passphrase.field'))
    expect(warning(tree)).toBeUndefined()
  })

  it('carries the count in Portuguese', async () => {
    await i18n.changeLanguage('pt-BR')
    jest.mocked(loadPassphraseFor).mockResolvedValue('a   ')
    expect(warning(await reveal())).toBe(
      'Esta passphrase termina com 3 espaços. Anote os espaços também, ou ela abre outra carteira.',
    )
    jest.mocked(loadPassphraseFor).mockResolvedValue('  a ')
    expect(warning(await reveal())).toContain('(2 no início, 1 no fim)')
  })
})

it('never shows the words alone when the passphrase cannot be read, and says so', async () => {
  // Words without their passphrase open a different, empty wallet, so a failed read shows nothing.
  for (const fail of ['seed', 'passphrase'] as const) {
    jest.mocked(loadSeedFor).mockImplementation(async id => {
      if (fail === 'seed') throw new Error('keychain')
      return SEEDS[id] ?? null
    })
    jest.mocked(loadPassphraseFor).mockImplementation(async () => {
      if (fail === 'passphrase') throw new Error('keychain')
      return 'correct horse'
    })
    const tree = await reveal()
    const shown = texts(tree)
    expect(shown).toContain(i18n.t('recovery.readFailed'))
    expect(shown).not.toContain('abandon')
    expect(shown).not.toContain('correct horse')
    // Trying again goes back through the PIN gate.
    const retry = tree.root.findAll(n => n.props.label === i18n.t('common.retry') && typeof n.props.onPress === 'function')[0]!
    await ReactTestRenderer.act(async () => {
      retry.props.onPress()
    })
    expect(texts(tree)).toEqual(['pin gate'])
  }
})

// The first 24 wordlist entries, a fixture and not a phrase anyone holds.
const WORDS_24 =
  'abandon ability able about above absent absorb abstract absurd abuse access accident ' +
  'account accuse achieve acid acoustic acquire across act action actor actress actual'

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))

// Each grid cell as the number and word it draws, with the share of the row it takes.
function gridCells(tree: ReactTestRenderer.ReactTestRenderer): { width: unknown; texts: string[] }[] {
  return tree.root
    .findAll(n => n.type === View && ['100%', '50%', '33.33%'].includes(flat(n.props.style).width as string))
    .map(cell => ({
      width: flat(cell.props.style).width,
      texts: cell.findAllByType(Text).map(text => [text.props.children].flat().join('')),
    }))
}

it('shows every word of a 24-word phrase beside its own number, in the backup screen grid', async () => {
  jest.mocked(loadSeedFor).mockResolvedValue(WORDS_24)
  const tree = await reveal()
  expect(gridCells(tree).map(c => c.texts)).toEqual(WORDS_24.split(' ').map((word, i) => [String(i + 1), word]))
})

it('draws the phrase in one column at the largest iOS and Android text sizes, every word beside its number', async () => {
  // Half the width at these sizes is narrower than "mushroom" at the least the word may shrink to,
  // and a cut word is a word written down wrong.
  for (const [width, fontScale] of [[402, 3.571], [360, 2]] as const) {
    const dims = jest.spyOn(Dimensions, 'get').mockReturnValue({ width, height: 800, scale: 3, fontScale })
    jest.mocked(loadSeedFor).mockResolvedValue(WORDS_24)
    const cells = gridCells(await reveal())
    expect(new Set(cells.map(c => c.width))).toEqual(new Set(['100%']))
    expect(cells.map(c => c.texts)).toEqual(WORDS_24.split(' ').map((word, i) => [String(i + 1), word]))
    dims.mockRestore()
  }
})
