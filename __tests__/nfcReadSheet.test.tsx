import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, StyleSheet } from 'react-native'
import i18n from '../src/i18n'
import { NfcReadSheet } from '../src/components/NfcReadSheet'
import { Sheet } from '../src/components/Sheet'
import type { NfcSheetPhase } from '../src/hooks/useNfcRead'

let tree: ReactTestRenderer.ReactTestRenderer | null = null

async function render(phase: NfcSheetPhase): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<NfcReadSheet phase={phase} onCancel={() => undefined} />)
  })
  return tree as ReactTestRenderer.ReactTestRenderer
}

let timing: jest.SpyInstance

beforeEach(() => {
  timing = jest.spyOn(Animated, 'timing')
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})

afterEach(() => {
  ReactTestRenderer.act(() => tree?.unmount())
  tree = null
  jest.restoreAllMocks()
})

const ringStyles = (root: ReactTestRenderer.ReactTestRenderer) =>
  root.root
    .findAllByProps({ testID: 'nfc-ring' })
    .filter(node => typeof node.type === 'string')
    .map(node => StyleSheet.flatten(node.props.style))

test('while waiting the rings pulse out from the icon', async () => {
  const root = await render('waiting')

  expect(timing).toHaveBeenCalled()
  expect(ringStyles(root).length).toBeGreaterThan(0)
  expect(ringStyles(root).every(style => style.transform !== undefined)).toBe(true)
})

test('under reduced motion the rings stand still', async () => {
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)

  const root = await render('waiting')

  expect(ringStyles(root).length).toBeGreaterThan(0)
  expect(ringStyles(root).every(style => style.transform === undefined)).toBe(true)
})

test('a ring takes the same time on every turn, or the head start would close up', async () => {
  const delays = jest.spyOn(Animated, 'delay')

  await render('waiting')

  const taken = delays.mock.calls.map(([ms]) => ms)
  expect(taken).toHaveLength(4)
  expect(taken[0] + taken[1]).toBe(taken[2] + taken[3])
  expect(taken[0]).not.toBe(taken[2])
})

// Read off the sheet's own children, since a sheet on its way out is not rendered here at all.
const sheetLines = (root: ReactTestRenderer.ReactTestRenderer): unknown[] =>
  React.Children.toArray(root.root.findByType(Sheet).props.children).map(
    child => (child as React.ReactElement<{ children?: unknown; label?: unknown }>).props,
  ).flatMap(props => [props.children, props.label])

test('the line and the button stay on the way out, with nothing rewriting a sheet that is leaving', async () => {
  const root = await render('noAddress')
  expect(sheetLines(root)).toContain(i18n.t('send.nfcNoAddress'))

  await ReactTestRenderer.act(async () => {
    root.update(<NfcReadSheet phase="closed" onCancel={() => undefined} />)
  })

  expect(sheetLines(root)).toContain(i18n.t('send.nfcNoAddress'))
  expect(sheetLines(root)).toContain(i18n.t('common.close'))
})

test('a screen reader hears the line each time it changes, and nothing as the sheet closes', async () => {
  const heard = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
  heard.mockClear()
  const root = await render('waiting')
  expect(heard).toHaveBeenLastCalledWith(i18n.t('send.nfcPrompt'))

  await ReactTestRenderer.act(async () => {
    root.update(<NfcReadSheet phase="noAddress" onCancel={() => undefined} />)
  })
  expect(heard).toHaveBeenLastCalledWith(i18n.t('send.nfcNoAddress'))

  await ReactTestRenderer.act(async () => {
    root.update(<NfcReadSheet phase="closed" onCancel={() => undefined} />)
  })
  expect(heard.mock.calls.map(([said]) => said)).toEqual([i18n.t('send.nfcPrompt'), i18n.t('send.nfcNoAddress')])
})

test('a tag with no address ends the wait, so the rings stop', async () => {
  const root = await render('noAddress')

  expect(timing).not.toHaveBeenCalled()
  expect(ringStyles(root).every(style => style.transform === undefined)).toBe(true)
})
