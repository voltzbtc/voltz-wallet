import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { I18nManager, StyleSheet, Text, TextInput } from 'react-native'
import '../src/i18n'
import { AmountSheet } from '../src/components/AmountSheet'
import { ChunkedAddress } from '../src/components/ChunkedAddress'
import { ImportScreen } from '../src/screens/ImportScreen'
import { PinScreen } from '../src/screens/PinScreen'
import { parseAmountSat } from '../src/wallet/amount'

// iOS aligns a text that has no textAlign by the app bundle's localization, so once an RTL .lproj
// ships, an RTL phone draws an app running in English with that text on the right. Each paragraph
// therefore carries an alignment: 'left' for the leading edge, which Fabric swaps under an RTL
// layout, or the one the design chose. A TextInput gets no swap, so its leading edge is 'right'
// under RTL. scripts/design-metrics.mjs asks the same of every element in the source; these mount
// real screens, in both directions, to check what the components actually draw. Jest resolves
// react-native for iOS.

jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))
jest.mock('../src/wallet/pin', () => ({ verifyPin: jest.fn(async () => false) }))
jest.mock('../src/wallet/biometrics', () => ({
  isBiometricUnlockEnabled: jest.fn(async () => false),
  getBiometryKind: jest.fn(async () => null),
  unlockWithBiometrics: jest.fn(async () => false),
}))

type Node = ReactTestRenderer.ReactTestInstance

async function mount(element: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const align = (node: Node) => StyleSheet.flatten(node.props.style)?.textAlign

function insideText(node: Node): boolean {
  for (let up = node.parent; up; up = up.parent) {
    if (up.type === Text) return true
  }
  return false
}

// A text nested in another is a run of the outer paragraph and takes the outer one's alignment.
const paragraphs = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).filter(node => !insideText(node))
const runs = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).filter(insideText)

// Read from the host nodes only, since a composite Text and the host it renders hold the same child.
function textOf(node: Node): string {
  return node
    .findAll(n => typeof n.type === 'string')
    .flatMap(n => [n.props.children].flat())
    .filter(c => typeof c === 'string' || typeof c === 'number')
    .join('')
}

const SCREENS: [string, () => React.ReactElement][] = [
  ['the PIN pad', () => <PinScreen mode="enter" onDone={() => undefined} />],
  ['the import grid', () => <ImportScreen onImported={() => undefined} onBack={() => undefined} />],
  [
    'the amount sheet',
    () => (
      <AmountSheet
        visible
        unit="sats"
        allowDecimal={false}
        satsBtcToggle
        fiatRate={500000}
        fiatCurrency="BRL"
        min={1000}
        max={100000}
        initial="1500"
        parse={parseAmountSat}
        onConfirm={() => undefined}
        onClose={() => undefined}
      />
    ),
  ],
  ['a grouped address', () => <ChunkedAddress value="bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh" chunked />],
]

describe.each([false, true])('with the layout RTL %s', rtl => {
  beforeEach(() => {
    jest.replaceProperty(I18nManager, 'isRTL', rtl)
  })

  it.each(SCREENS)('every paragraph of %s carries an alignment', async (_name, screen) => {
    const tree = await mount(screen())
    const found = paragraphs(tree)
    expect(found.length).toBeGreaterThan(0)
    const natural = found.filter(node => align(node) === undefined).map(textOf)
    expect(natural).toEqual([])
  })

  it.each(SCREENS)('no run inside %s overrides its paragraph', async (_name, screen) => {
    const tree = await mount(screen())
    expect(runs(tree).filter(node => align(node) !== undefined).map(textOf)).toEqual([])
  })

  it('the import grid aligns each word to the leading edge of the layout', async () => {
    const tree = await mount(<ImportScreen onImported={() => undefined} onBack={() => undefined} />)
    const cells = tree.root.findAllByType(TextInput)
    expect(cells.length).toBe(12)
    for (const cell of cells) {
      expect(align(cell)).toBe(rtl ? 'right' : 'left')
    }
  })

  it('the PIN pad draws its labels from the leading edge, which Fabric swaps under RTL', async () => {
    const tree = await mount(<PinScreen mode="enter" onDone={() => undefined} />)
    const digit = paragraphs(tree).find(node => textOf(node) === '5')!
    expect(align(digit)).toBe('left')
  })

  // Centred by design, and still centred after the leading alignment came in beside it.
  it('the amount sheet keeps its centred lines centred', async () => {
    const tree = await mount(SCREENS[2]![1]())
    const centred = paragraphs(tree).filter(node => align(node) === 'center').map(textOf)
    // The fiat readout and the range hint.
    expect(centred).toEqual(
      expect.arrayContaining([expect.stringContaining('R$'), expect.stringContaining('100')]),
    )
  })

  it('a grouped address stays centred, and its groups set no alignment of their own', async () => {
    const tree = await mount(SCREENS[3]![1]())
    const [paragraph, ...rest] = paragraphs(tree)
    expect(rest).toEqual([])
    expect(align(paragraph!)).toBe('center')
    expect(runs(tree).length).toBeGreaterThan(1)
  })
})
