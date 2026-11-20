import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import { LiquidGlassView } from '@callstack/liquid-glass'
import { Card } from '../src/components/Card'
import { GlassCard } from '../src/components/GlassCard'
import { colors, space } from '../src/theme'

// Reported as supported, as on iOS 26, where the material would show if the card took it.
jest.mock('@callstack/liquid-glass', () => ({
  ...jest.requireActual('../__mocks__/@callstack/liquid-glass'),
  isLiquidGlassSupported: true,
}))

test('a card is the solid surface even where Liquid Glass is supported', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <GlassCard style={{ padding: 0 }}>
        <Text>inside</Text>
      </GlassCard>,
    )
  })
  expect(tree.root.findAllByType(LiquidGlassView)).toHaveLength(0)
  const [surface] = tree.root.findAllByType(View)
  const style = StyleSheet.flatten(surface!.props.style)
  // The one card fill, with no outline, so nothing but space tells two cards apart.
  expect(style.backgroundColor).toBe(colors.surface)
  expect(style.borderWidth).toBeUndefined()
  expect(style.borderColor).toBeUndefined()
  // The caller's style still wins over the card's own.
  expect(style.padding).toBe(0)
})

// Two cards on one screen hold their text on the same line only when both pad alike, so the card
// padding is one number, Card's own.
test('a card pads its sides as Card does', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <>
        <GlassCard>
          <Text>glass</Text>
        </GlassCard>
        <Card>
          <Text>card</Text>
        </Card>
        <Card padding="inset">
          <Text>inset</Text>
        </Card>
      </>,
    )
  })
  const sides = (text: string) => {
    const box = tree.root.findAll(n => n.type === View && n.findAllByType(Text).some(t => t.props.children === text))
    const style = StyleSheet.flatten(box[box.length - 1]!.props.style)
    return style.paddingHorizontal ?? style.padding
  }
  expect(sides('glass')).toBe(space.lg)
  expect(sides('card')).toBe(space.lg)
  expect(sides('inset')).toBe(space.lg)
})
