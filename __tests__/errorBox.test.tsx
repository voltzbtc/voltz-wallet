import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet, Text, View, type ViewStyle } from 'react-native'
import { ErrorBox } from '../src/components/ErrorBox'
import { Txt } from '../src/components/Txt'
import { colors, font, space } from '../src/theme'

function render(message: string | null, style?: ViewStyle): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<ErrorBox message={message} style={style} />)
  })
  return tree
}

const boxStyle = (tree: ReactTestRenderer.ReactTestRenderer): ViewStyle =>
  StyleSheet.flatten(tree.root.findByType(View).props.style)

// The message takes the text roles every other line uses, so a change to the caption reaches it too.
test('sets the message in the caption role, in the danger tone, beside its icon', () => {
  const tree = render('Could not load the wallets.')
  const txt = tree.root.findByType(Txt)
  expect(txt.props.role).toBe('caption')
  expect(txt.props.tone).toBe('danger')
  const style = StyleSheet.flatten(tree.root.findByType(Text).props.style)
  expect(style.color).toBe(colors.danger)
  expect(style.fontSize).toBe(font.size.sm)
  expect(style.lineHeight).toBe(font.leading.sm)
  expect(style.textAlign).not.toBe('center')
})

// The space around a primitive belongs to the screen that places it, so a box above a button and a
// box last on a screen each take what their screen gives.
test('owns no space around it, and takes what the caller passes', () => {
  const margins = (style: ViewStyle) => Object.keys(style).filter(key => key.startsWith('margin'))
  expect(margins(boxStyle(render('Could not load the wallets.')))).toEqual([])
  expect(boxStyle(render('Could not load the wallets.', { marginBottom: space.md }))).toMatchObject({
    marginBottom: space.md,
    padding: space.md,
  })
})

test('draws nothing without a message', () => {
  expect(render(null).toJSON()).toBeNull()
})

// The alert role names the box and says nothing by itself on React Native 0.86, so a screen reader
// hears the message only through an announcement.
describe('read aloud', () => {
  let heard: jest.SpyInstance
  beforeEach(() => {
    heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
  })
  afterEach(() => {
    heard.mockRestore()
  })

  const show = (tree: ReactTestRenderer.ReactTestRenderer, message: string | null) =>
    ReactTestRenderer.act(() => {
      tree.update(<ErrorBox message={message} />)
    })

  test('keeps the alert role and says the message as the box appears', () => {
    const tree = render(null)
    expect(heard).not.toHaveBeenCalled()

    show(tree, 'Could not load the wallets.')
    expect(tree.root.findByType(View).props.accessibilityRole).toBe('alert')
    expect(heard.mock.calls).toEqual([['Could not load the wallets.']])
  })

  test('says a changed message, and nothing on a render that keeps it', () => {
    const tree = render('Could not load the wallets.')
    show(tree, 'Could not load the wallets.')
    show(tree, 'No connection.')
    show(tree, 'No connection.')
    expect(heard.mock.calls).toEqual([['Could not load the wallets.'], ['No connection.']])
  })
})
