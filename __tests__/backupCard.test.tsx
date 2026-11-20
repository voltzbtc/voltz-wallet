import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { BackupCard } from '../src/components/BackupCard'
import { TabIcon } from '../src/components/TabIcon'
import { Touch } from '../src/components/Touch'
import { isUnconfirmed } from '../src/wallet/backupMark'
import { colors, font, radius, touch } from '../src/theme'

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
  }
})
jest.mock('../src/wallet/backupMark', () => ({ isUnconfirmed: jest.fn() }))
let mockAccent: string = colors.primary
jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: mockAccent }) }))

function shown(tree: ReactTestRenderer.ReactTestRenderer): boolean {
  return tree.root.findAllByType(Text).some(node => node.props.children === i18n.t('backup.verifyTitle'))
}

const props = { walletId: 'w1', funded: true, onPress: () => undefined }

async function render(over: Partial<React.ComponentProps<typeof BackupCard>> = {}) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<BackupCard {...props} {...over} />)
  })
  return tree
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(isUnconfirmed).mockReset()
  jest.mocked(isUnconfirmed).mockResolvedValue(true)
  mockAccent = colors.primary
})

const fills = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root
    .findAllByType(View)
    .map(node => StyleSheet.flatten(node.props.style) ?? {})
    .filter(style => style.backgroundColor != null)

// A reminder on Home is a neutral row: the card's fill and corners, the accent on its icon alone.
describe('the reminder is a neutral row', () => {
  test("on the card's fill and radius, never a warning's soft fill", async () => {
    const tree = await render()
    expect(fills(tree).map(style => style.backgroundColor)).toEqual([colors.surface])
    expect(fills(tree)[0]).toMatchObject({ borderRadius: radius.lg, borderCurve: 'continuous' })
    expect(JSON.stringify(tree.toJSON())).not.toContain(colors.primarySoft)
    expect(JSON.stringify(tree.toJSON())).not.toMatch(/"border(Top|Bottom|Left|Right)?Width":[1-9]/)
  })

  test('leads with the key in the accent, says the title on one body line, and ends on a muted chevron', async () => {
    const tree = await render()
    const icons = tree.root.findAllByType(TabIcon)
    expect(icons.map(icon => [icon.props.name, icon.props.color])).toEqual([
      ['key', colors.primary],
      ['chevron', colors.textSecondary],
    ])
    const title = tree.root.findAllByType(Text).find(node => node.props.children === i18n.t('backup.verifyTitle'))!
    expect(StyleSheet.flatten(title.props.style)).toMatchObject({ color: colors.text, fontSize: font.size.base, fontWeight: font.weight.regular })
    // The key, the title and the chevron sit across one row, in that order.
    const row = tree.root.findAllByType(View).find(node => StyleSheet.flatten(node.props.style)?.flexDirection === 'row')!
    expect(row.findAllByType(TabIcon)).toHaveLength(2)
    expect(row.findAllByType(Text).map(node => node.props.children)).toEqual([i18n.t('backup.verifyTitle')])
  })

  test("the key follows the wallet's accent, green with the dollar wallet", async () => {
    mockAccent = colors.dollar
    const tree = await render()
    expect(tree.root.findAllByType(TabIcon)[0]!.props.color).toBe(colors.dollar)
  })

  test('draws the title alone, and a screen reader hears the reason as the hint', async () => {
    const tree = await render()
    expect(tree.root.findAllByType(Text).map(node => node.props.children)).toEqual([i18n.t('backup.verifyTitle')])
    const target = tree.root.find(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button')
    expect(target.props.accessibilityHint).toBe(i18n.t('backup.cardBody'))
    expect(target.props.accessibilityLabel).toBeUndefined()
    expect(i18n.t('backup.cardBody')).not.toBe('backup.cardBody')
  })

  test('the whole row is one target at the touch floor or above', async () => {
    const tree = await render()
    const target = tree.root.find(node => typeof node.type === 'string' && node.props.accessibilityRole === 'button')
    expect(StyleSheet.flatten(target.props.style).minHeight).toBeGreaterThanOrEqual(touch.min)
    expect(tree.root.findAllByType(Touch)).toHaveLength(1)
  })
})

test('shows nothing for a wallet that holds nothing, with the mark unconfirmed', async () => {
  expect(shown(await render({ funded: false }))).toBe(false)
  expect(shown(await render())).toBe(true)
})

test('shows nothing once the words are confirmed', async () => {
  jest.mocked(isUnconfirmed).mockResolvedValue(false)
  expect(shown(await render())).toBe(false)
})

test('shows nothing while the mark is read, so it never flashes', async () => {
  jest.mocked(isUnconfirmed).mockReturnValue(new Promise<boolean>(() => undefined))
  expect(shown(await render())).toBe(false)
})

test('the whole card is one control, with nothing that dismisses it', async () => {
  const onPress = jest.fn()
  const tree = await render({ onPress })
  const controls = tree.root.findAllByType(Touch)
  expect(controls).toHaveLength(1)
  await ReactTestRenderer.act(async () => {
    controls[0]!.props.onPress()
  })
  expect(onPress).toHaveBeenCalledTimes(1)
})

test('an answer that lands after a wallet switch shows nothing on the new wallet', async () => {
  let answerForFirst!: (marked: boolean) => void
  jest.mocked(isUnconfirmed).mockImplementation(id =>
    id === 'w1' ? new Promise<boolean>(resolve => (answerForFirst = resolve)) : Promise.resolve(false),
  )
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.update(<BackupCard {...props} walletId="w2" />)
  })
  await ReactTestRenderer.act(async () => {
    answerForFirst(true)
  })
  expect(shown(tree)).toBe(false)
})

test("the card of one wallet goes at once when the wallet changes, before the next wallet's answer", async () => {
  const tree = await render()
  expect(shown(tree)).toBe(true)
  jest.mocked(isUnconfirmed).mockReturnValue(new Promise<boolean>(() => undefined))
  await ReactTestRenderer.act(async () => {
    tree.update(<BackupCard {...props} walletId="w2" />)
  })
  expect(shown(tree)).toBe(false)
})

test('a new read after the confirmation takes the card away', async () => {
  const tree = await render({ refreshKey: 1 })
  expect(shown(tree)).toBe(true)
  jest.mocked(isUnconfirmed).mockResolvedValue(false)
  await ReactTestRenderer.act(async () => {
    tree.update(<BackupCard {...props} refreshKey={2} />)
  })
  expect(shown(tree)).toBe(false)
})
