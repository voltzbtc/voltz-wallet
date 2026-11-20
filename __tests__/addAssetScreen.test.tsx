import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, TextInput, View } from 'react-native'
import i18n from '../src/i18n'
import { AddAssetScreen } from '../src/screens/AddAssetScreen'
import { sparkGetTokenBalances, sparkResolveToken } from '../src/wallet/spark'
import { addToken, loadHomeTokens, mergeCatalog } from '../src/wallet/tokenPrefs'
import { DEPIX, KNOWN_TOKENS } from '../src/wallet/tokens'
import { Skeleton } from '../src/components/Skeleton'
import { SectionLabel } from '../src/components/SectionLabel'
import { font, rhythm, space } from '../src/theme'

const mockGoBack = jest.fn()
let mockScanned: string | undefined

jest.mock('../src/wallet/spark', () => ({ sparkResolveToken: jest.fn(), sparkGetTokenBalances: jest.fn() }))
jest.mock('../src/wallet/tokenPrefs', () => ({
  ...jest.requireActual('../src/wallet/tokenPrefs'),
  addToken: jest.fn(),
  loadHomeTokens: jest.fn(),
}))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack, navigate: jest.fn() }),
  useRoute: () => ({ params: mockScanned ? { scanned: mockScanned } : undefined }),
}))

const USDB = KNOWN_TOKENS[0]!
const OTHER = {
  identifier: 'btkn1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq',
  name: 'Some Token',
  ticker: 'SOME',
  decimals: 6,
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(n => {
    const c = n.props.children
    return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === 'string')
  })
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AddAssetScreen />)
  })
  await settle()
  return tree
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, value: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(value)
  })
  await settle()
}

const addButton = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('addAsset.add')))!

beforeEach(() => {
  jest.clearAllMocks()
  mockScanned = undefined
  // Shaped like the real loader, which always carries the defaults, so the catalog is never empty.
  jest.mocked(loadHomeTokens).mockResolvedValue({ catalog: mergeCatalog([]), hidden: [] })
  jest.mocked(sparkResolveToken).mockResolvedValue(OTHER)
  jest.mocked(addToken).mockResolvedValue(undefined as never)
  jest.mocked(sparkGetTokenBalances).mockResolvedValue([])
})

it('will not add anything until an identifier has resolved', async () => {
  // The button is the only way out of this screen, and pressing it before a lookup lands would add
  // whatever was last in state, which is nothing.
  const tree = await render()
  expect(addButton(tree).props.disabled).toBe(true)
  await type(tree, OTHER.identifier)
  expect(addButton(tree).props.disabled).toBe(false)
})

it('shows the token it found, so the identifier is not the only thing to check against', async () => {
  // A `btkn1...` string is sixty characters of noise. The name and ticker are what a person can
  // actually recognise before committing.
  const shown = texts(
    await (async () => {
      const tree = await render()
      await type(tree, OTHER.identifier)
      return tree
    })(),
  )
  expect(shown).toContain(OTHER.name)
  expect(shown).toContain(OTHER.ticker)
})

describe('when the lookup does not produce a token', () => {
  it('says the identifier is malformed rather than searching for it', async () => {
    const tree = await render()
    await type(tree, 'not-an-identifier')
    expect(texts(tree)).toContain(i18n.t('addAsset.invalid'))
    expect(sparkResolveToken).not.toHaveBeenCalled()
  })

  it('distinguishes a token nobody knows from a lookup that failed', async () => {
    // One means the identifier is wrong and the other means try again, so the two stay apart.
    const tree = await render()
    jest.mocked(sparkResolveToken).mockResolvedValue(null)
    await type(tree, OTHER.identifier)
    expect(texts(tree)).toContain(i18n.t('addAsset.notFound'))

    jest.mocked(sparkResolveToken).mockRejectedValue(new Error('offline'))
    await type(tree, OTHER.identifier.replace(/q$/, 'p'))
    expect(texts(tree)).toContain(i18n.t('addAsset.error'))
  })

  it('leaves the button out of reach in both cases', async () => {
    const tree = await render()
    jest.mocked(sparkResolveToken).mockResolvedValue(null)
    await type(tree, OTHER.identifier)
    expect(addButton(tree).props.disabled).toBe(true)
  })
})

describe('the suggested list', () => {
  // The screen's own gap plus the list's margin: a hint's distance under the intro, and a section's
  // over the field.
  it('stands apart from the text over it and the field under it by the rhythm', async () => {
    const tree = await render()
    let box = tree.root.findByType(SectionLabel).parent!
    while (typeof box.type !== 'string') {
      box = box.parent!
    }
    const style = StyleSheet.flatten(box.props.style)
    const above = Number(style.marginTop ?? style.marginVertical ?? 0)
    const below = Number(style.marginBottom ?? style.marginVertical ?? 0)
    expect(above + space.lg).toBe(rhythm.hintToContent)
    expect(below + space.lg).toBe(rhythm.section)
  })

  it('marks a token already on the list as added, with nothing to press', async () => {
    const tree = await render()
    const row = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === USDB.name))
    expect(texts(tree)).toContain(i18n.t('addAsset.added'))
    expect(row).toBeUndefined()
  })

  // A tap on "+" adds nothing for a default and then leaves the screen, so it must not be offered
  // in the moment before the list file is read.
  it('shows USDB as added before the list file is read', async () => {
    jest.mocked(loadHomeTokens).mockReturnValue(new Promise(() => undefined))
    const tree = await render()
    const row = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === USDB.name))
    expect(texts(tree)).toContain(i18n.t('addAsset.added'))
    expect(row).toBeUndefined()
  })

  it('offers a hidden one back, and adding it leaves the screen', async () => {
    jest.mocked(loadHomeTokens).mockResolvedValue({ catalog: mergeCatalog([]), hidden: [USDB.identifier] })
    const tree = await render()
    expect(texts(tree)).not.toContain(i18n.t('addAsset.added'))
    const row = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === USDB.name))!
    await ReactTestRenderer.act(async () => row.props.onPress())
    await settle()
    expect(jest.mocked(addToken).mock.calls[0]![0]).toMatchObject({
      identifier: USDB.identifier,
    })
    expect(mockGoBack).toHaveBeenCalled()
  })
})

// A refused add leaves the token off Home, so going back as if it held would leave the person
// looking for a row that never comes.
describe('an add that is refused', () => {
  it('stays on the screen and says the asset was not added', async () => {
    jest.mocked(addToken).mockRejectedValueOnce(new Error('token lists not upgraded'))
    const tree = await render()
    await type(tree, OTHER.identifier)
    await ReactTestRenderer.act(async () => addButton(tree).props.onPress())
    await settle()

    expect(mockGoBack).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('addAsset.addFailed'))
    expect(addButton(tree).props.loading).toBe(false)
    expect(addButton(tree).props.disabled).toBe(false)
  })

  it('says so for a suggestion too, and a second tap that holds goes back', async () => {
    jest.mocked(addToken).mockRejectedValueOnce(new Error('no wallet in front'))
    const tree = await render()
    const depix = () =>
      tree.root
        .findAll(n => typeof n.props.onPress === 'function')
        .find(n => n.findAllByType(Text).some(x => x.props.children === DEPIX.name))!
    await ReactTestRenderer.act(async () => depix().props.onPress())
    await settle()
    expect(texts(tree)).toContain(i18n.t('addAsset.addFailed'))
    expect(mockGoBack).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => depix().props.onPress())
    await settle()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
  })

  it('gives way to what a new identifier says', async () => {
    jest.mocked(addToken).mockRejectedValueOnce(new Error('refused'))
    const tree = await render()
    await type(tree, OTHER.identifier)
    await ReactTestRenderer.act(async () => addButton(tree).props.onPress())
    await settle()
    await type(tree, 'not-an-identifier')

    expect(texts(tree)).not.toContain(i18n.t('addAsset.addFailed'))
    expect(texts(tree)).toContain(i18n.t('addAsset.invalid'))
  })
})

// A token the wallet holds shows on Home whether or not it was added, so the list says so too.
describe('a token the wallet holds', () => {
  const holding = (balanceBaseUnits: number) =>
    jest.mocked(sparkGetTokenBalances).mockResolvedValue([
      { identifier: DEPIX.identifier, ticker: DEPIX.ticker, name: DEPIX.name, decimals: DEPIX.decimals, balanceBaseUnits },
    ])
  const depixRow = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === DEPIX.name))

  it('reads as added when it was never added, with nothing to press', async () => {
    holding(100_000_000)
    const tree = await render()
    expect(texts(tree).filter(text => text === i18n.t('addAsset.added'))).toHaveLength(2)
    expect(depixRow(tree)).toBeUndefined()
  })

  it('is still offered at a zero balance', async () => {
    holding(0)
    const tree = await render()
    expect(texts(tree).filter(text => text === i18n.t('addAsset.added'))).toHaveLength(1)
    expect(depixRow(tree)).toBeDefined()
  })

  it('leaves the lists to decide when the balances cannot be read', async () => {
    jest.mocked(sparkGetTokenBalances).mockRejectedValue(new Error('spark not connected'))
    const tree = await render()
    expect(depixRow(tree)).toBeDefined()
  })
})

describe('DePix', () => {
  const DEPIX_META = { identifier: DEPIX.identifier, name: DEPIX.name, ticker: DEPIX.ticker, decimals: DEPIX.decimals }
  // Anyone can issue a token under this name on Spark; only the identifier differs.
  const FAKE = { ...DEPIX_META, identifier: `btkn1${'p'.repeat(58)}` }
  const lookalikeText = () => i18n.t('addAsset.lookalike', { ticker: 'DePix' })
  const svgMarks = (node: ReactTestRenderer.ReactTestInstance) => node.findAll(n => (n.type as unknown) === 'SvgMock')

  it('is suggested with its mark, and one tap adds it', async () => {
    const tree = await render()
    const row = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === DEPIX.name))!
    expect(svgMarks(row).length).toBeGreaterThan(0)
    await ReactTestRenderer.act(async () => row.props.onPress())
    await settle()
    expect(jest.mocked(addToken).mock.calls[0]![0]).toMatchObject({ identifier: DEPIX.identifier })
  })

  it('a pasted token under its name warns that it is not the official one, and keeps a letter', async () => {
    jest.mocked(sparkResolveToken).mockResolvedValue(FAKE)
    const tree = await render()
    await type(tree, FAKE.identifier)
    expect(texts(tree)).toContain(lookalikeText())
    // The suggested DePix draws the official mark, so the one letter badge is the preview's.
    expect(texts(tree).filter(text => text === 'D')).toHaveLength(1)
  })

  it('the official identifier resolves with no warning', async () => {
    jest.mocked(sparkResolveToken).mockResolvedValue(DEPIX_META)
    const tree = await render()
    await type(tree, DEPIX.identifier)
    expect(texts(tree).filter(text => text === DEPIX.name)).toHaveLength(2)
    expect(texts(tree)).not.toContain(lookalikeText())
  })
})

it('resolves an identifier arriving from the scanner without anyone typing', async () => {
  mockScanned = OTHER.identifier
  expect(texts(await render())).toContain(OTHER.name)
})

// The lookup's placeholder has the preview's lines, the name on the body line and the ticker on the
// label line under it, so the card does not grow when the token arrives.
it('the lookup draws the preview at its line heights while it runs', async () => {
  jest.mocked(sparkResolveToken).mockImplementationOnce(() => new Promise(() => undefined))
  const tree = await render()
  await type(tree, OTHER.identifier)

  const bars = tree.root.findAllByType(Skeleton).map(bar => bar.props.height)
  expect(bars).toEqual([40, font.leading.base, font.leading.sm])
})

const flatStyle = (raw: unknown): Record<string, unknown> =>
  Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))

// A long name truncates inside the card rather than running past it, which needs the text column to
// take the row's width beside the mark, in the placeholder and in the preview alike.
it('the preview text takes the width beside the mark, so a long name stays inside the card', async () => {
  jest.mocked(sparkResolveToken).mockResolvedValue({ ...OTHER, name: 'A token with a very long name indeed' })
  const tree = await render()
  await type(tree, OTHER.identifier)

  const name = tree.root.findAllByType(Text).find(n => n.props.children === 'A token with a very long name indeed')!
  // The first view above the text, past the components that draw it, is the column that holds the
  // name and the ticker.
  let column = name.parent
  while (column && column.type !== View) {
    column = column.parent
  }
  expect(flatStyle(column?.props.style).flex).toBe(1)
})
