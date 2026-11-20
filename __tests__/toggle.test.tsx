import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Switch } from 'react-native'
import { Toggle } from '../src/components/Toggle'
import { colors } from '../src/theme'

let mockAccent: string = colors.primary
jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: mockAccent }) }))

function drawn(value: boolean): ReactTestRenderer.ReactTestInstance {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Toggle value={value} onValueChange={() => undefined} />)
  })
  return tree.root.findByType(Switch)
}

// Without thumbColor Android paints the thumb the theme's teal when on, which is what this holds.
it.each([true, false])('draws a white thumb with the switch at %s', value => {
  expect(drawn(value).props.thumbColor).toBe('#ffffff')
})

it('takes the accent of the wallet on screen for the track when on', () => {
  mockAccent = colors.dollar
  expect(drawn(true).props.trackColor.true).toBe(colors.dollar)
  mockAccent = colors.primary
})

it('keeps the track off a card when off, on both platforms', () => {
  const props = drawn(false).props
  expect(props.trackColor.false).toBe(colors.surfaceRaised)
  expect(props.ios_backgroundColor).toBe(colors.surfaceRaised)
})

it('answers a change with the new value', () => {
  const seen: boolean[] = []
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<Toggle value={false} onValueChange={next => seen.push(next)} />)
  })
  ReactTestRenderer.act(() => tree.root.findByType(Switch).props.onValueChange(true))
  expect(seen).toEqual([true])
})
