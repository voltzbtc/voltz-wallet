import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, TextInput, View } from 'react-native'
import i18n from '../src/i18n'
import { SearchField } from '../src/components/SearchField'
import { FieldClear } from '../src/components/FieldClear'
import { Touch } from '../src/components/Touch'
import { rhythm, space } from '../src/theme'

function render(element: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree
}

const search = (props: Partial<React.ComponentProps<typeof SearchField>> = {}) =>
  render(<SearchField value="" onChangeText={() => undefined} label="Search" {...props} />)

const group = (tree: ReactTestRenderer.ReactTestRenderer) =>
  StyleSheet.flatten(tree.root.findAllByType(View)[0]!.props.style)

it('names itself to a screen reader and takes a query as it is typed', () => {
  expect(search().root.findByType(TextInput).props).toMatchObject({
    placeholder: 'Search',
    accessibilityLabel: 'Search',
    autoCapitalize: 'none',
    autoCorrect: false,
  })
})

it('keeps the gutter and the space to the list on a screen, and leaves both to a sheet', () => {
  expect(group(search())).toMatchObject({
    paddingHorizontal: space.xl,
    marginBottom: rhythm.searchToList,
  })
  expect(group(search({ inSheet: true })).paddingHorizontal).toBeUndefined()
  expect(group(search({ inSheet: true })).marginBottom).toBeUndefined()
})

it('offers a clear only once there is something to clear, and clearing empties the query', () => {
  expect(search().root.findAllByType(Touch)).toHaveLength(0)
  const typed: string[] = []
  const tree = search({ value: 'real', onChangeText: text => typed.push(text) })
  ReactTestRenderer.act(() => tree.root.findByType(Touch).props.onPress())
  expect(typed).toEqual([''])
})

// One clear for every field that offers one, so a search and the wallet's name look and answer alike.
it('draws its clear with the shared field clear, named for a screen reader', () => {
  const tree = search({ value: 'real' })
  expect(tree.root.findAllByType(FieldClear)).toHaveLength(1)
  expect(tree.root.findByType(Touch).props.label).toBe(i18n.t('send.clear'))
})
