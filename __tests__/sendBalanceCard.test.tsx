import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text } from 'react-native'
import { formatSats } from '../src/wallet/amount'
import i18n from '../src/i18n'
import { SendBalance } from '../src/components/SendBalance'
import { SectionLabel } from '../src/components/SectionLabel'
import { Card } from '../src/components/Card'
import { FigureRow } from '../src/components/FigureRow'
import { AssetIcon } from '../src/components/AssetIcon'
import { USDB } from '../src/wallet/tokens'

function render(element: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const texts = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  tree.root
    .findAllByType(Text)
    .flatMap(n => (Array.isArray(n.props.children) ? n.props.children : [n.props.children]))
    .filter((c): c is string => typeof c === 'string')
    .join(' ')

// Drawn with the shared pieces, so the balance reads like every other titled card of rows.
test('titles the balance with SectionLabel over an inset Card of rows', () => {
  const tree = render(<SendBalance balanceSat={12_000} sync="synced" />)

  expect(tree.root.findByType(SectionLabel).props.children).toBe(i18n.t('send.balanceTitle'))
  expect(tree.root.findByType(Card).props.padding).toBe('inset')
  expect(tree.root.findAllByType(AssetIcon).map(n => n.props.size)).toEqual([28])
})

test('a single row draws no divider under itself', () => {
  const tree = render(<SendBalance balanceSat={12_000} sync="synced" />)
  const lines = tree.root.findAllByType(FigureRow)
  expect(lines).toHaveLength(1)
  expect(StyleSheet.flatten(lines[0].props.style).borderBottomWidth).toBeUndefined()
})

// The unit word is the locale's, never a literal beside the figure.
test('writes the sats word from the locale, and a token by its ticker', () => {
  const original = i18n.t('common.sats')
  i18n.addResource(i18n.language, 'translation', 'common.sats', 'satoshis')
  try {
    expect(texts(render(<SendBalance balanceSat={12_000} sync="synced" />))).toContain('satoshis')
  } finally {
    i18n.addResource(i18n.language, 'translation', 'common.sats', original)
  }
  const token = { assetId: USDB.identifier, name: USDB.name, ticker: 'USDB', amount: '10' }
  expect(texts(render(<SendBalance balanceSat={0} sync="synced" token={token} />))).toContain('USDB')
})

test('draws each balance on one line that shrinks to fit', () => {
  const tree = render(<SendBalance balanceSat={12_000} sync="synced" />)
  const figure = tree.root
    .findAllByType(Text)
    .find(n => [n.props.children].flat().join('').includes(formatSats(12_000)))!
  expect([figure.props.numberOfLines, figure.props.adjustsFontSizeToFit]).toEqual([1, true])
})
