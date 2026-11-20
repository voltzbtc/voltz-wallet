import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { AssetPickerSheet, type PickerItem } from '../src/components/AssetPickerSheet'
import { EmptyState } from '../src/components/EmptyState'
import { Touch } from '../src/components/Touch'
import { FigureRow } from '../src/components/FigureRow'
import { figuresHeldOut, figuresIn, textOf } from './support/figureFit'

const items: PickerItem[] = [
  { assetId: 'a'.repeat(64), ticker: 'BTC', name: 'Bitcoin' },
  { assetId: 'b'.repeat(64), ticker: 'USDB', name: 'Spark USD' },
  { assetId: 'c'.repeat(64), ticker: 'BRLA', name: 'Spark BRL' },
]

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(n => {
      const c = n.props.children
      return (Array.isArray(c) ? c : [c]).filter((x): x is string => typeof x === 'string')
    })
    .join('\n')
}

// The FlatList schedules an async cell update that fires after the test ends unless the tree is
// unmounted inside act.
let mounted: ReactTestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
})

function render(
  onSelect: (id: string) => void,
  selectedId: string | null = null,
): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AssetPickerSheet
        visible
        title="Pick"
        items={items}
        selectedId={selectedId}
        onSelect={onSelect}
        onClose={() => {}}
      />,
    )
  })
  mounted = tree
  return tree
}

test('lists the items and filters by ticker or name', () => {
  const tree = render(jest.fn())
  expect(texts(tree)).toContain('Spark USD')
  expect(texts(tree)).toContain('Spark BRL')

  ReactTestRenderer.act(() => {
    tree.root.findByType(TextInput).props.onChangeText('usd')
  })
  const shown = texts(tree)
  expect(shown).toContain('Spark USD')
  expect(shown).not.toContain('Bitcoin') // filtered out by the search
})

// The app's one empty state, so a search that finds nothing reads as every other empty list does.
test('says through the empty state when the search finds nothing', () => {
  const tree = render(jest.fn())
  ReactTestRenderer.act(() => {
    tree.root.findByType(TextInput).props.onChangeText('zzz')
  })
  const empty = tree.root.findAllByType(EmptyState)
  expect(empty).toHaveLength(1)
  expect(empty[0]!.props.message).toBe(i18n.t('convert.noAsset'))
})

test('draws each row as a list row that lights up under the finger', () => {
  const rows = render(jest.fn()).root.findAllByType(Touch)
  expect(rows).toHaveLength(items.length)
  expect(rows.map(r => r.props.feedback)).toEqual(items.map(() => 'row'))
})

test('selecting a row calls onSelect with its assetId', () => {
  const onSelect = jest.fn()
  const tree = render(onSelect)
  const row = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === 'USDB'))
  ReactTestRenderer.act(() => {
    row?.props.onPress()
  })
  expect(onSelect).toHaveBeenCalledWith('b'.repeat(64))
})

// A list with no search has no text field, so it must not make room for a keyboard: on iOS that
// room pushes the sheet's last row out of view.
test('a list without search shows no field and does not wait for a keyboard', () => {
  const { Sheet } = require('../src/components/Sheet')
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AssetPickerSheet
        visible
        title="Pick"
        items={items}
        selectedId={null}
        searchable={false}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
  })
  mounted = tree
  expect(tree.root.findAllByType(TextInput)).toHaveLength(0)
  expect(tree.root.findByType(Sheet).props.keyboard).toBe(false)
})

// A network row carries its route id but shows the chain's mark, and a row may have one line only.
test('a row can draw another id icon and drop its second line', () => {
  const { AssetIcon } = require('../src/components/AssetIcon')
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AssetPickerSheet
        visible
        title="Pick"
        items={[{ assetId: 'receive|tron|USDT|TR7|0', iconId: 'chain:tron', ticker: 'Tron', name: '' }]}
        selectedId={null}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
  })
  mounted = tree
  expect(tree.root.findByType(AssetIcon).props.assetId).toBe('chain:tron')
  expect(texts(tree).split('\n').filter(line => line === '')).toHaveLength(0)
})

// A balance beside the names shares the rule of every label and figure, so at the largest text size
// it goes under them rather than being squeezed by them.
test('lays a row with a balance out through FigureRow', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AssetPickerSheet
        visible
        title="Pick"
        items={[{ ...items[0], subtitle: '17 920 sats' }]}
        selectedId={items[0].assetId}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
  })
  mounted = tree
  const [row] = tree.root.findAllByType(FigureRow)
  expect(figuresIn(row).map(textOf)).toEqual(['17 920 sats'])
  expect(figuresHeldOut(tree.root)).toEqual([])
})

// The tickers of the rows drawn as chosen: the accent check on screen and the selected state a screen
// reader announces, which must agree.
function markedRows(tree: ReactTestRenderer.ReactTestRenderer): { checked: string[]; selected: string[] } {
  const { TabIcon } = require('../src/components/TabIcon')
  const tickers = items.map(item => item.ticker)
  const tickerOf = (row: ReactTestRenderer.ReactTestInstance) =>
    row.findAllByType(Text).find(txt => tickers.includes(txt.props.children))?.props.children
  const rows = tree.root.findAllByType(Touch)
  return {
    checked: rows
      .filter(row => row.findAllByType(TabIcon).some(icon => icon.props.name === 'check'))
      .map(tickerOf),
    selected: rows.filter(row => row.props.state?.selected === true).map(tickerOf),
  }
}

test('marks the current choice, and only that row, with the check and the selected state', () => {
  const tree = render(jest.fn(), 'b'.repeat(64))
  expect(markedRows(tree)).toEqual({ checked: ['USDB'], selected: ['USDB'] })
  // Drawn in the accent, which outside dollar mode is the orange.
  const { TabIcon } = require('../src/components/TabIcon')
  const check = tree.root.findAllByType(TabIcon).find(icon => icon.props.name === 'check')
  expect(check?.props.color).toBe(require('../src/theme').colors.primary)
})

test('marks nothing while nothing is chosen, or when the choice is not in the list', () => {
  expect(markedRows(render(jest.fn(), null))).toEqual({ checked: [], selected: [] })
  ReactTestRenderer.act(() => mounted?.unmount())
  expect(markedRows(render(jest.fn(), 'z'.repeat(64)))).toEqual({ checked: [], selected: [] })
})

// The mark is drawn on top of the selection, never in place of it.
test('picking a marked or unmarked row only calls onSelect with its id', () => {
  const onSelect = jest.fn()
  const tree = render(onSelect, 'a'.repeat(64))
  const rows = tree.root.findAllByType(Touch)
  ReactTestRenderer.act(() => rows[0]!.props.onPress())
  ReactTestRenderer.act(() => rows[2]!.props.onPress())
  expect(onSelect.mock.calls).toEqual([['a'.repeat(64)], ['c'.repeat(64)]])
})

// The check sits beside the balance on the chosen row, and the balance still keeps its share.
test('a chosen row with a balance still lays the figure out in its share', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <AssetPickerSheet
        visible
        title="Pick"
        items={[{ ...items[1], subtitle: '12,50 USDB' }]}
        selectedId={items[1].assetId}
        onSelect={() => {}}
        onClose={() => {}}
      />,
    )
  })
  mounted = tree
  expect(markedRows(tree).checked).toEqual(['USDB'])
  expect(figuresHeldOut(tree.root)).toEqual([])
})
