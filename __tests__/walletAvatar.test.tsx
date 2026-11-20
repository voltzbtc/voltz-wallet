import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Image, StyleSheet, Text, View } from 'react-native'
import { WalletAvatar } from '../src/components/WalletAvatar'
import { radius, textScale } from '../src/theme'

// The initials are drawn to the disc, which keeps its size in a list row, so following the text size
// pushed them out of the circle at the largest sizes.
test('the initials keep to the disc at any text size', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<WalletAvatar color="#3355aa" monogram="B1" size={44} />)
  })
  const initials = tree.root.findByType(Text)
  expect(initials.props.children).toBe('B1')
  expect(textScale.badgeMax).toBe(1)
  expect(initials.props.maxFontSizeMultiplier).toBe(textScale.badgeMax)
})

describe('a photo', () => {
  const PATH = '/docs/wallet-avatars/aaaa1111-1.jpg'

  function draw(crop?: unknown): ReactTestRenderer.ReactTestRenderer {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <WalletAvatar color="#3355aa" monogram="B1" size={96} imagePath={PATH} crop={crop as never} />,
      )
    })
    return tree
  }

  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => {
    const image = tree.root.findByType(Image)
    return { uri: image.props.source.uri, style: StyleSheet.flatten(image.props.style) }
  }

  // A photo saved before crops existed, or one whose crop is not one, covers the disc from its centre.
  const today = { width: 96, height: 96, borderRadius: radius.full, overflow: 'hidden' }

  test('without a crop covers the disc from its centre, as before crops', () => {
    const { uri, style } = flat(draw())
    expect(uri).toBe(`file://${PATH}`)
    expect(style).toMatchObject(today)
    expect(style.transform).toBeUndefined()
    expect(style.position).toBeUndefined()
  })

  test.each([
    ['null', null],
    ['text', 'x'],
    ['a zero width', { x: 0, y: 0, w: 0, h: 1 }],
    ['a field outside 0 to 1', { x: -0.2, y: 0, w: 0.5, h: 1 }],
    ['past the edge', { x: 0.8, y: 0, w: 0.5, h: 1 }],
    ['a field not a number', { x: 'a', y: 0, w: 0.5, h: 1 }],
  ])('with a crop that is %s draws as without one', (_name, crop) => {
    expect(flat(draw(crop)).style).toEqual(flat(draw()).style)
  })

  test('with a crop draws that square across the disc', () => {
    const tree = draw({ x: 0.25, y: 0, w: 0.5, h: 1 })
    const { uri, style } = flat(tree)
    expect(uri).toBe(`file://${PATH}`)
    // Twice the disc wide, since the crop is half the photo's width, with its left quarter off the disc.
    expect(style).toMatchObject({ position: 'absolute', width: 192, height: 96, left: -48, top: 0 })
    expect(style.left + style.transform[0].translateX).toBe(-48)
    expect(style.top + style.transform[1].translateY).toBe(0)
    const disc = StyleSheet.flatten(tree.root.findAllByType(View).find(v => v.findAllByType(Image).length)!.props.style)
    expect(disc).toMatchObject(today)
  })
})
