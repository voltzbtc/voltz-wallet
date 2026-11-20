import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { ImportScreen } from '../src/screens/ImportScreen'
import { ScreenTitle } from '../src/components/ScreenTitle'
import { colors, radius, space } from '../src/theme'
import { fingerprintFromMnemonic, fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { formatFingerprint } from '../src/wallet/walletIdentity'

// Both derivations stay real and are recorded, so a call to the synchronous one shows.
jest.mock('../src/wallet/fingerprint', () => {
  const actual = jest.requireActual('../src/wallet/fingerprint')
  return {
    ...actual,
    fingerprintFromMnemonic: jest.fn(actual.fingerprintFromMnemonic),
    fingerprintFromMnemonicAsync: jest.fn(actual.fingerprintFromMnemonicAsync),
  }
})

function render(
  onImported: (mnemonic: string, passphrase?: string) => void = () => undefined,
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <ImportScreen onImported={onImported} onBack={() => undefined} />,
    )
  })
  return tree
}

const cells = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(TextInput)
// The box around a field: the first native view above it, since the app's TextInput wraps React
// Native's and adds a level.
const box = (node: ReactTestRenderer.ReactTestInstance): ReactTestRenderer.ReactTestInstance => {
  let up = node.parent
  while (up && typeof up.type !== 'string') up = up.parent
  return up!
}

// Numbers count. The cell index renders as a raw number, so a string-only filter reports a grid with
// no numbering as identical to one that has it.
const words = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).flatMap(n => {
    const c = n.props.children
    return (Array.isArray(c) ? c : [c])
      .filter((x): x is string | number => typeof x === 'string' || typeof x === 'number')
      .map(String)
  })

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

function type(tree: ReactTestRenderer.ReactTestRenderer, index: number, value: string): void {
  ReactTestRenderer.act(() => {
    cells(tree)[index]!.props.onChangeText(value)
  })
}

// Lets the async fingerprint derivation, which yields between its rounds, finish and render.
async function derivations(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

function focus(tree: ReactTestRenderer.ReactTestRenderer, index: number): void {
  ReactTestRenderer.act(() => {
    cells(tree)[index]!.props.onFocus?.({})
  })
}

// The canonical BIP39 test vector. The first twelve wordlist entries in order look like a phrase
// and fail the checksum, so a restore case built on them would pass for the wrong reason, by taking
// the invalid path.
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

it('opens with twelve empty cells, numbered', () => {
  const tree = render()
  expect(cells(tree)).toHaveLength(12)
  expect(words(tree)).toContain('1')
  expect(words(tree)).toContain('12')
})

it('numbers the cells in the digits of the language on screen', async () => {
  await i18n.changeLanguage('ar-EG')
  try {
    const tree = render()
    expect(words(tree)).toContain('١')
    expect(words(tree)).toContain('١٢')
    expect(words(tree)).not.toContain('12')
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

describe('the suggestion bar', () => {
  // How a person completes a BIP39 word without typing all of it.
  it('offers wordlist matches for what is being typed', () => {
    const tree = render()
    focus(tree, 0)
    type(tree, 0, 'aban')
    expect(words(tree)).toContain('abandon')
  })

  it('offers nothing before a cell has focus, so the bar does not sit there empty', () => {
    const tree = render()
    type(tree, 0, 'aban')
    expect(words(tree)).not.toContain('abandon')
  })

  it('does not suggest the word already typed in full', () => {
    const tree = render()
    focus(tree, 0)
    type(tree, 0, 'abandon')
    expect(words(tree).filter(w => w === 'abandon')).toHaveLength(0)
  })
})

describe('a word that is not in the wordlist', () => {
  it('is marked when the cell loses focus, and not while it is being typed', () => {
    // Turning red on the second keystroke of every word would make the screen shout at a person
    // doing nothing wrong.
    const tree = render()
    focus(tree, 0)
    type(tree, 0, 'zzz')
    // The cell is the View holding the input, found through the input rather than by counting Views.
    const fill = () => flat(box(cells(tree)[0]!).props.style).backgroundColor
    // While typing a cell is in its focus step, like every other field.
    expect(fill()).toBe(colors.surfaceRaised)
    ReactTestRenderer.act(() => cells(tree)[0]!.props.onBlur?.({}))
    expect(fill()).toBe(colors.dangerSoft)
  })
})

describe('restoring', () => {
  it('will not restore a phrase whose checksum does not hold, and says so', () => {
    const done: string[] = []
    const tree = render(m => done.push(m))
    const wrong = PHRASE.split(' ')
    wrong[11] = 'zoo'
    wrong.forEach((w, i) => type(tree, i, w))
    const button = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('import.restore')))!
    ReactTestRenderer.act(() => button.props.onPress())
    expect(done).toEqual([])
    const message = tree.root
      .findAllByType(Text)
      .find(n => n.props.children === i18n.t('import.invalid'))!
    expect(message).toBeDefined()
    // The colour is the message's whole register: in the muted grey it reads as a note about the
    // form rather than as a refusal to restore.
    expect(flat(message.props.style).color).toBe(colors.danger)
  })

  it('restores a valid phrase and shows which wallet it resolved to first', async () => {
    // The fingerprint is the only confirmation that the right seed went in, before anything is saved.
    const done: string[] = []
    const tree = render(m => done.push(m))
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    await derivations()
    expect(words(tree)).toContain(i18n.t('import.walletId'))
    const button = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('import.restore')))!
    ReactTestRenderer.act(() => button.props.onPress())
    expect(done).toEqual([PHRASE])
  })
})

// The wallet id line under the phrase. PBKDF2 runs 2048 rounds, so it is derived with the async
// function, and a line on screen always belongs to the phrase and passphrase on screen.
describe('the wallet id line', () => {
  const toggle = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(n => n.props.accessibilityRole === 'switch' && n.props.onPress != null)
  const passField = (tree: ReactTestRenderer.ReactTestRenderer) =>
    cells(tree).find(c => c.props.placeholder === i18n.t('import.passphrasePlaceholder'))!
  const actual = jest.requireActual('../src/wallet/fingerprint') as typeof import('../src/wallet/fingerprint')
  const line = (tree: ReactTestRenderer.ReactTestRenderer): string | undefined => {
    const all = words(tree)
    const at = all.indexOf(i18n.t('import.walletId'))
    return at < 0 ? undefined : all[at + 1]
  }

  beforeEach(() => {
    jest.mocked(fingerprintFromMnemonic).mockClear()
    jest.mocked(fingerprintFromMnemonicAsync).mockClear()
  })

  it('is derived with the async function and never the synchronous one', async () => {
    const tree = render()
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    await derivations()

    expect(fingerprintFromMnemonicAsync).toHaveBeenCalledWith(PHRASE, undefined)
    expect(fingerprintFromMnemonic).not.toHaveBeenCalled()
    expect(line(tree)).toBe(formatFingerprint(actual.fingerprintFromMnemonic(PHRASE)))
  })

  it('shows nothing while the derivation runs, and nothing when it fails', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    jest.mocked(fingerprintFromMnemonicAsync).mockImplementationOnce(async () => {
      await gate
      throw new Error('derivation failed')
    })
    const tree = render()
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    await derivations()
    expect(line(tree)).toBeUndefined()

    release()
    await derivations()
    expect(line(tree)).toBeUndefined()
  })

  it('never shows a late answer for an earlier input over the current one', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    jest.mocked(fingerprintFromMnemonicAsync).mockImplementationOnce(async () => {
      await gate
      return 'deadbeef'
    })
    const tree = render()
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    await derivations()
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    ReactTestRenderer.act(() => passField(tree).props.onChangeText('x'))
    await derivations()
    const current = formatFingerprint(actual.fingerprintFromMnemonic(PHRASE, 'x'))
    expect(line(tree)).toBe(current)

    release()
    await derivations()
    expect(line(tree)).toBe(current)
  })

  it('takes the line for the earlier input down while the new one derives', async () => {
    const tree = render()
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    await derivations()
    expect(line(tree)).toBe(formatFingerprint(actual.fingerprintFromMnemonic(PHRASE, '')))

    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    jest.mocked(fingerprintFromMnemonicAsync).mockImplementationOnce(async (mnemonic, passphrase) => {
      await gate
      return actual.fingerprintFromMnemonicAsync(mnemonic, passphrase)
    })
    ReactTestRenderer.act(() => passField(tree).props.onChangeText('x'))
    await derivations()
    expect(line(tree)).toBeUndefined()

    release()
    await derivations()
    expect(line(tree)).toBe(formatFingerprint(actual.fingerprintFromMnemonic(PHRASE, 'x')))
  })

  it('drops the line as soon as the phrase stops being valid', async () => {
    const tree = render()
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    await derivations()
    expect(line(tree)).toBeDefined()

    type(tree, 11, 'abandon')
    expect(line(tree)).toBeUndefined()
    type(tree, 11, 'about')
    expect(line(tree)).toBe(formatFingerprint(actual.fingerprintFromMnemonic(PHRASE)))
  })
})

it('marks a bad word in the last cell too, which needs the field to report losing focus', () => {
  // The deferral ends when the cell itself loses focus, not only when another cell takes it.
  // Otherwise the twelfth word never turns red, and a person gets "phrase is invalid" with nothing
  // saying which of the twelve to look at.
  const tree = render()
  focus(tree, 11)
  type(tree, 11, 'zzz')
  ReactTestRenderer.act(() => cells(tree)[11]!.props.onBlur?.({}))
  expect(flat(box(cells(tree)[11]!).props.style).backgroundColor).toBe(colors.dangerSoft)
})

describe('the passphrase switch', () => {
  const toggle = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(n => n.props.accessibilityRole === 'switch' && n.props.onPress != null)

  it('reports whether it is on, which is the only way a reader can tell', () => {
    // The checkbox is a bare square: it carries its state in colour and in nothing else, so the
    // accessibility state is the whole of what a screen reader has to go on.
    const tree = render()
    expect(toggle(tree).props.accessibilityState).toMatchObject({ checked: false })
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    expect(toggle(tree).props.accessibilityState).toMatchObject({ checked: true })
  })

  it('keeps its contents at the left edge, being full width with nothing flexible inside', () => {
    // Touch centres what it holds, so this row needs to say otherwise or the checkbox and its label
    // drift into the middle. It is one of the two places in the app where the floor moves content.
    const style = flat(toggle(render()).props.style({ pressed: false }))
    expect(style.justifyContent).toBe('flex-start')
  })

  it('opens a masked field when switched on, and nothing before', () => {
    const tree = render()
    expect(cells(tree)).toHaveLength(12)
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    const added = cells(tree).filter(c => c.props.secureTextEntry === true)
    expect(added).toHaveLength(1)
  })

  // The field opens below the words, under the fixed footer, and the focus is what scrolls it into
  // view. A field restored with the passphrase from an earlier visit is not one the person just asked
  // for, so it waits to be tapped.
  it('focuses the field it opens, and not a field restored from an earlier visit', () => {
    const tree = render()
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    expect(cells(tree).filter(c => c.props.secureTextEntry === true).map(c => c.props.autoFocus)).toEqual([true])

    let restored!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      restored = ReactTestRenderer.create(
        <ImportScreen onImported={() => undefined} onBack={() => undefined} initial={{ phrase: PHRASE, passphrase: 'kept' }} />,
      )
    })
    expect(cells(restored).filter(c => c.props.secureTextEntry === true).map(c => c.props.autoFocus)).toEqual([false])
  })
})

describe('the passphrase field', () => {
  const toggle = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(n => n.props.accessibilityRole === 'switch' && n.props.onPress != null)
  const passField = (tree: ReactTestRenderer.ReactTestRenderer) =>
    cells(tree).find(c => c.props.placeholder === i18n.t('import.passphrasePlaceholder'))!
  const eye = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.find(
      n =>
        typeof n.props.onPress === 'function' &&
        [i18n.t('passphrase.reveal'), i18n.t('passphrase.hide')].includes(n.props.accessibilityLabel),
    )

  it('hands the passphrase to the restore exactly as typed, spaces and case included', () => {
    const done: Array<[string, string | undefined]> = []
    const tree = render((m, p) => done.push([m, p]))
    PHRASE.split(' ').forEach((w, i) => type(tree, i, w))
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    ReactTestRenderer.act(() => passField(tree).props.onChangeText(' Correct horse '))
    const button = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('import.restore')))!
    ReactTestRenderer.act(() => button.props.onPress())
    expect(done).toEqual([[PHRASE, ' Correct horse ']])
  })

  it('is the app field, masked and kept out of autofill and the dictionary, with an eye to check it', () => {
    const tree = render()
    ReactTestRenderer.act(() => toggle(tree).props.onPress())
    const field = passField(tree)
    expect(field.props).toMatchObject({
      secureTextEntry: true,
      autoCorrect: false,
      spellCheck: false,
      autoComplete: 'off',
      // Not 'none': iOS still offers to save a secure field typed that way once Restore leaves the
      // screen, and iOS 26.5 does not offer a one-time code field to Passwords.
      textContentType: 'oneTimeCode',
      importantForAutofill: 'no',
    })
    // The box Field draws around the input, which a bare TextInput has none of.
    expect(flat(box(field).props.style)).toMatchObject({
      backgroundColor: colors.surfaceVariant,
      borderRadius: radius.lg,
    })

    ReactTestRenderer.act(() => eye(tree).props.onPress())
    expect(passField(tree).props.secureTextEntry).toBe(false)
    ReactTestRenderer.act(() => eye(tree).props.onPress())
    expect(passField(tree).props.secureTextEntry).toBe(true)
  })
})

it('sizes the number column as the word grid does, growing with the text size', () => {
  const dims = jest.spyOn(Dimensions, 'get').mockReturnValue({ width: 402, height: 800, scale: 3, fontScale: 1.5 })
  try {
    const tree = render()
    const numbers = cells(tree).map(cell => flat(box(cell).findAllByType(Text)[0]!.props.style))
    for (const style of numbers) {
      expect(style.width).toBeUndefined()
      expect(style.minWidth).toBeCloseTo(space.xl * 1.5)
    }
  } finally {
    dims.mockRestore()
  }
})

it('lays the word cells two to a row that grow to both gutters, as the control above does', () => {
  for (const cell of cells(render())) {
    // The group around the field's box, which is what sits in the grid.
    const style = flat(box(box(cell)).props.style)
    expect(style.width).toBeUndefined()
    expect(style.flexGrow).toBe(1)
  }
})

// Back goes once a restore starts writing. The title beside it stays where it was, and the place the
// chevron held is nothing a screen reader can reach.
it('keeps the chevron\'s place once Back goes, so the title does not move', () => {
  const tree = render()
  const header = () => tree.root.findByProps({ testID: 'back-slot' })
  expect(tree.root.findAllByProps({ testID: 'back-slot' })).toHaveLength(0)
  const live = tree.root.find(n => typeof n.type === 'string' && n.props.accessibilityLabel === i18n.t('common.back'))
  const liveBox = flat(live.props.style)

  ReactTestRenderer.act(() => {
    tree.update(<ImportScreen onImported={() => undefined} />)
  })
  expect(tree.root.findAll(n => n.props.accessibilityLabel === i18n.t('common.back'))).toHaveLength(0)
  const slot = flat(header().props.style)
  expect(slot.minWidth).toBe(liveBox.minWidth)
  expect(slot.minHeight).toBe(liveBox.minHeight)
  expect(slot.marginLeft).toBe(liveBox.marginLeft)
  expect(slot.opacity).toBe(0)
  expect(header().props.importantForAccessibility).toBe('no-hide-descendants')
  expect(header().props.accessibilityElementsHidden).toBe(true)
})

it('leaves no gap where it never had a Back, as inside the navigator', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<ImportScreen onImported={() => undefined} />)
  })
  expect(tree.root.findAllByProps({ testID: 'back-slot' })).toHaveLength(0)
})

// Above the text it was alone on a row of its own, and it pushed the opening down by that row.
test('Paste stands over the grid it fills, not with the title', () => {
  const tree = render()
  const paste = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(text => text.props.children === i18n.t('import.paste')))!
  expect(paste).toBeDefined()
  expect(tree.root.findByType(ScreenTitle).findAllByType(Text).map(n => n.props.children)).not.toContain(
    i18n.t('import.paste'),
  )

  const drawn = JSON.stringify(tree.toJSON())
  const pasteAt = drawn.indexOf(i18n.t('import.paste'))
  expect(pasteAt).toBeGreaterThan(drawn.indexOf(i18n.t('import.subtitle')))
  expect(pasteAt).toBeLessThan(drawn.indexOf(i18n.t('import.wordLabel', { number: '1' })))
})
