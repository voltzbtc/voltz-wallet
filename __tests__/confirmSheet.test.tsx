import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { ScrollView } from 'react-native'
import '../src/i18n'
import { ConfirmSheet, type ConfirmRequest } from '../src/components/ConfirmSheet'
import { GradientButton } from '../src/components/GradientButton'
import { Toggle } from '../src/components/Toggle'

const request = (over: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  title: 'Remove?',
  body: 'It cannot come back.',
  confirm: 'Remove',
  cancel: 'Keep',
  danger: true,
  onConfirm: jest.fn(),
  ...over,
})

async function sheet(asked: ConfirmRequest | null, onClose = jest.fn()) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ConfirmSheet request={asked} onClose={onClose} />)
  })
  return tree
}

const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByType(GradientButton).find(node => node.props.label === label)!

test('confirming closes the sheet and then acts', async () => {
  const order: string[] = []
  const tree = await sheet(
    request({
      onConfirm: () => {
        order.push('acted')
      },
    }),
    jest.fn(() => {
      order.push('closed')
    }),
  )
  await ReactTestRenderer.act(async () => button(tree, 'Remove').props.onPress())
  expect(order).toEqual(['closed', 'acted'])
})

test('the way out closes and does nothing else', async () => {
  const asked = request()
  const onClose = jest.fn()
  const tree = await sheet(asked, onClose)
  await ReactTestRenderer.act(async () => button(tree, 'Keep').props.onPress())
  expect(onClose).toHaveBeenCalledTimes(1)
  expect(asked.onConfirm).not.toHaveBeenCalled()
})

test('what cannot come back is drawn as danger, and anything else as the plain action', async () => {
  expect(button(await sheet(request()), 'Remove').props.variant).toBe('danger')
  expect(button(await sheet(request({ danger: false })), 'Remove').props.variant).toBe('primary')
})

// A system dialog scrolls by itself. At the largest text sizes a long warning passes the sheet's cap,
// and a question that did not scroll would leave its confirm out of reach.
test('the question scrolls, with both answers inside it', async () => {
  const tree = await sheet(request())
  const labels = tree.root
    .findByType(ScrollView)
    .findAllByType(GradientButton)
    .map(node => node.props.label)
  expect(labels).toEqual(['Remove', 'Keep'])
})

// A choice that goes with the confirm, such as deleting a wallet's data along with removing it.
describe('an option', () => {
  const OPTION = { label: 'Also delete my data', note: 'What that means.' }

  test('is absent from a question that has none', async () => {
    const tree = await sheet(request())
    expect(tree.root.findAllByType(Toggle)).toHaveLength(0)
  })

  test('starts off, and confirming with it off says so', async () => {
    const onConfirm = jest.fn()
    const tree = await sheet(request({ option: OPTION, onConfirm }))
    expect(tree.root.findByType(Toggle).props.value).toBe(false)
    await ReactTestRenderer.act(async () => button(tree, 'Remove').props.onPress())
    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  test('turned on goes to the confirm, with its label and its note on screen', async () => {
    const onConfirm = jest.fn()
    const tree = await sheet(request({ option: OPTION, onConfirm }))
    const texts = JSON.stringify(tree.toJSON())
    expect(texts).toContain(OPTION.label)
    expect(texts).toContain(OPTION.note)
    expect(tree.root.findByType(Toggle).props.accessibilityLabel).toBe(OPTION.label)
    await ReactTestRenderer.act(async () => tree.root.findByType(Toggle).props.onValueChange(true))
    expect(tree.root.findByType(Toggle).props.value).toBe(true)
    await ReactTestRenderer.act(async () => button(tree, 'Remove').props.onPress())
    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  test('starts off again on the next question, whatever the last one was left at', async () => {
    const first = request({ option: OPTION })
    const tree = await sheet(first)
    await ReactTestRenderer.act(async () => tree.root.findByType(Toggle).props.onValueChange(true))
    const onConfirm = jest.fn()
    await ReactTestRenderer.act(async () => {
      tree.update(<ConfirmSheet request={request({ option: OPTION, onConfirm })} onClose={jest.fn()} />)
    })
    expect(tree.root.findByType(Toggle).props.value).toBe(false)
    await ReactTestRenderer.act(async () => button(tree, 'Remove').props.onPress())
    expect(onConfirm).toHaveBeenCalledWith(false)
  })
})
