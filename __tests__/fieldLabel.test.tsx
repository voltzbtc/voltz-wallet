import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { TextInput } from 'react-native'
import { Field } from '../src/components/Field'

function input(element: React.JSX.Element) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(element)
  })
  return tree.root.findByType(TextInput)
}

// The label above the box is a separate text, so the input carries it for a screen reader.
test('names the input by its label', () => {
  expect(input(<Field label="Name" value="" onChangeText={() => undefined} />).props.accessibilityLabel).toBe(
    'Name',
  )
})

test('a caller can still name the input another way', () => {
  const field = input(
    <Field label="Name" accessibilityLabel="Wallet name" value="" onChangeText={() => undefined} />,
  )
  expect(field.props.accessibilityLabel).toBe('Wallet name')
})
