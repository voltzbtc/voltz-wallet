import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Dimensions, StyleSheet, Text } from 'react-native'
import i18n from '../src/i18n'
import { DomainAccessRequestScreen } from '../src/screens/DomainAccessRequestScreen'
import { GradientButton } from '../src/components/GradientButton'
import { Skeleton } from '../src/components/Skeleton'
import { sparkGetIdentityPubkey } from '../src/wallet/spark'
import { walletCode } from '../src/wallet/domainAccess'
import { TabIcon } from '../src/components/TabIcon'
import { colors } from '../src/theme'

jest.mock('../src/wallet/spark', () => ({ sparkGetIdentityPubkey: jest.fn() }))

const KEY_A = '02' + 'a'.repeat(64)
const KEY_B = '03' + 'b'.repeat(64)

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

let tree: ReactTestRenderer.ReactTestRenderer

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<DomainAccessRequestScreen />)
  })
  await settle()
}

const texts = (): string[] => tree.root.findAllByType(Text).map(node => String(node.props.children))
const retry = () =>
  tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('common.retry')))

beforeEach(() => {
  jest.mocked(sparkGetIdentityPubkey).mockReset()
})

// The screen exists to show this wallet's key, so a key that cannot be read says so and offers the
// read again, instead of a placeholder that never resolves.
test('a key that cannot be read shows the error and Try again, not the skeleton', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockRejectedValue(new Error('Spark SDK not connected'))
  await render()

  expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  expect(texts()).toContain(i18n.t('domain.errFailed'))
  expect(retry()).toBeDefined()
  // Nothing to copy or share without a key.
  expect(texts()).not.toContain(i18n.t('domain.copyKey'))
})

test('Try again reads the key and shows its code', async () => {
  jest
    .mocked(sparkGetIdentityPubkey)
    .mockRejectedValueOnce(new Error('Spark SDK not connected'))
    .mockResolvedValueOnce(KEY_A)
  await render()

  await ReactTestRenderer.act(async () => {
    retry()!.props.onPress()
  })
  await settle()

  expect(texts()).toContain(walletCode(KEY_A))
  expect(texts()).not.toContain(i18n.t('domain.errFailed'))
})

test('the skeleton stands while the key is read, with the bars of the label and the code', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockImplementation(() => new Promise(() => undefined))
  await render()

  expect(tree.root.findAllByType(Skeleton)).toHaveLength(3)
  expect(retry()).toBeUndefined()
})

test('after two taps, the answer to the last one is the one shown', async () => {
  let first: ((key: string) => void) | undefined
  let second: ((key: string) => void) | undefined
  jest
    .mocked(sparkGetIdentityPubkey)
    .mockRejectedValueOnce(new Error('Spark SDK not connected'))
    .mockImplementationOnce(() => new Promise(resolve => (first = resolve)))
    .mockImplementationOnce(() => new Promise(resolve => (second = resolve)))
  await render()
  const onPress = retry()!.props.onPress

  await ReactTestRenderer.act(async () => {
    onPress()
    onPress()
  })
  await ReactTestRenderer.act(async () => {
    second?.(KEY_B)
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    first?.(KEY_A)
  })
  await settle()

  expect(texts()).toContain(walletCode(KEY_B))
  expect(texts()).not.toContain(walletCode(KEY_A))
})

// The check replaces the copy mark only on screen, so a screen reader is told, and the check takes
// the accent the other copy confirmations use.
test('copying the key announces it and draws the check in the accent', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(KEY_A)
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
  jest.useFakeTimers()
  try {
    await render()
    const copy = tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('domain.copyKey'),
    )
    await ReactTestRenderer.act(async () => {
      copy.props.onPress()
    })

    expect(announce).toHaveBeenCalledWith(i18n.t('receive.copied'))
    const check = tree.root.findAllByType(TabIcon).find(n => n.props.name === 'check')!
    expect(check.props.color).toBe(colors.primary)
  } finally {
    await ReactTestRenderer.act(async () => {
      jest.runOnlyPendingTimers()
    })
    jest.useRealTimers()
    announce.mockRestore()
  }
})

// Two halves of the row break "Schlüssel kopieren" and "Teilen" inside a word at the largest text
// sizes, so below the width that fits both they stack, each across the screen, as Home's actions do.
describe('the copy and share buttons', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, width: 402, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => {
    ReactTestRenderer.act(() => Dimensions.set({ window: start, screen: start }))
  })

  const button = (label: string) =>
    tree.root.findAllByType(GradientButton).find(n => (n.props.accessibilityLabel ?? n.props.label) === label)!

  // The nearest host view above a node.
  const hostAbove = (node: ReactTestRenderer.ReactTestInstance) => {
    let above = node.parent!
    while (typeof above.type !== 'string') {
      above = above.parent!
    }
    return above
  }

  // Each button sits in a view that takes its share, and those two in the view that lays them out.
  function pair() {
    const copy = hostAbove(button(i18n.t('domain.copyKey')))
    const share = hostAbove(button(i18n.t('domain.share')))
    return { copy, share, box: StyleSheet.flatten(hostAbove(copy).props.style) }
  }

  test('stack across the screen when the text is large', async () => {
    jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(KEY_A)
    setScale(1.353)
    await render()
    const { copy, share, box } = pair()
    expect(box.flexDirection).toBe('column')
    for (const each of [copy, share]) {
      const style = StyleSheet.flatten(each.props.style)
      expect(style.flex).toBeUndefined()
      expect(style.alignSelf ?? box.alignItems ?? 'stretch').toBe('stretch')
    }
  })

  test('sit side by side, each half the row, at the standard size', async () => {
    jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(KEY_A)
    setScale(1)
    await render()
    const { copy, share, box } = pair()
    expect(box.flexDirection).toBe('row')
    expect(StyleSheet.flatten(copy.props.style).flex).toBe(1)
    expect(StyleSheet.flatten(share.props.style).flex).toBe(1)
  })
})
