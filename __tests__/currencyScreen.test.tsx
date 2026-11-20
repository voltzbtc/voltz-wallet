import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { KeyboardAvoidingView, SectionList, StyleSheet, Text, TextInput } from 'react-native'
import '../src/i18n'
import i18n from '../src/i18n'
import { CurrencyScreen } from '../src/screens/CurrencyScreen'
import { MenuRow } from '../src/components/MenuRow'
import { PickerSkeleton } from '../src/components/PickerSkeleton'
import { Field } from '../src/components/Field'
import { Screen } from '../src/components/Screen'
import { space } from '../src/theme'
import { sparkListFiatCurrencies } from '../src/wallet/spark'
import { loadDisplayCurrency, saveDisplayCurrency } from '../src/wallet/settings'
import { handledRefusal } from './support/handledRefusal'

jest.mock('../src/wallet/spark', () => ({ sparkListFiatCurrencies: jest.fn() }))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayCurrency: jest.fn(async () => null),
  saveDisplayCurrency: jest.fn(async () => undefined),
}))

// The push is over unless a test says otherwise.
let mockTransitionDone = true
jest.mock('../src/hooks/useTransitionDone', () => ({ useTransitionDone: () => mockTransitionDone }))

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<CurrencyScreen />)
  })
  await settle()
  return tree
}

function rowLabels(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(MenuRow).map(r => r.props.label as string)
}

// The leading accessory is a Flag element, so the country reads off its props.
function rowCountries(tree: ReactTestRenderer.ReactTestRenderer): unknown[] {
  return tree.root
    .findAllByType(MenuRow)
    .map(r => (r.props.leading as React.ReactElement<{ country?: string }> | undefined)?.props.country)
}

async function type(tree: ReactTestRenderer.ReactTestRenderer, value: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(value)
  })
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockTransitionDone = true
  jest.mocked(loadDisplayCurrency).mockResolvedValue(null)
  jest.mocked(sparkListFiatCurrencies).mockResolvedValue([
    { id: 'USD', name: 'US Dollar', symbol: 'US$', fractionSize: 2 },
    { id: 'BRL', name: 'Brazilian Real', symbol: 'R$', fractionSize: 2 },
    { id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 },
    { id: 'JPY', name: 'Japanese Yen', symbol: '¥', fractionSize: 0 },
  ])
})

test('lists every currency the SDK reports, not just BRL/USD', async () => {
  const tree = await render()
  const labels = rowLabels(tree)
  expect(labels.some(l => l.includes('Euro (EUR)'))).toBe(true)
  expect(labels.some(l => l.includes('Japanese Yen (JPY)'))).toBe(true)
  const countries = rowCountries(tree)
  expect(countries).toContain('EU')
  expect(countries).toContain('JP')
  expect(labels.length).toBe(4)
})

test('pins the world top currencies above the rest, in relevance order', async () => {
  // The feed arrives out of relevance order, so passing requires a real re-sort by TOP_CURRENCIES.
  jest.mocked(sparkListFiatCurrencies).mockResolvedValue([
    { id: 'JPY', name: 'Japanese Yen', symbol: '¥', fractionSize: 0 },
    { id: 'BRL', name: 'Brazilian Real', symbol: 'R$', fractionSize: 2 },
    { id: 'USD', name: 'US Dollar', symbol: 'US$', fractionSize: 2 },
    { id: 'EUR', name: 'Euro', symbol: '€', fractionSize: 2 },
  ])
  const tree = await render()
  const labels = rowLabels(tree)
  expect(labels[0]).toContain('US Dollar (USD)')
  expect(labels[1]).toContain('Euro (EUR)')
  expect(labels[2]).toContain('Brazilian Real (BRL)')
  expect(labels[3]).toContain('Japanese Yen (JPY)')
})

test('renders the "Top currencies" and "All" section headers', async () => {
  const tree = await render()
  const texts = tree.root
    .findAllByType(Text)
    .flatMap(n => (typeof n.props.children === 'string' ? [n.props.children] : []))
  expect(texts).toContain(i18n.t('currency.sectionTop'))
  expect(texts).toContain(i18n.t('currency.sectionAll'))
})

// The second group starts with air above its header, so it does not read as the first group's tail.
test('every section header but the first keeps its distance from the rows above it', async () => {
  const tree = await render()
  const header = (title: string) =>
    tree.root.findAllByType(Text).find(n => n.props.children === title)!
  const marginTop = (title: string) =>
    Object.assign({}, ...[header(title).props.style].flat(Infinity).filter(x => x && typeof x === 'object'))
      .marginTop
  expect(marginTop(i18n.t('currency.sectionTop'))).toBeUndefined()
  expect(marginTop(i18n.t('currency.sectionAll'))).toBe(space.xl)
})

test('a search that finds nothing says so, on a list with no section to hide it', async () => {
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0].props.onChangeText('zzzz')
  })
  const list = tree.root.findByType(SectionList)
  expect(list.props.sections).toEqual([])
  expect(list.props.ListEmptyComponent.props.message).toBe(i18n.t('currency.noResult'))
})

// Screen's bottom on top of the list's own stopped the list short of the edge.
test('the list alone owns the bottom of the screen', async () => {
  const tree = await render()
  const content = StyleSheet.flatten(tree.root.findByType(Screen).props.contentStyle)
  expect(content.paddingBottom).toBe(0)
  expect(tree.root.findByType(SectionList).props.contentContainerStyle.paddingBottom).toBeGreaterThan(0)
})

test('a search collapses the sections into one flat list (no headers)', async () => {
  const tree = await render()
  await type(tree, 'jp')
  const texts = tree.root
    .findAllByType(Text)
    .flatMap(n => (typeof n.props.children === 'string' ? [n.props.children] : []))
  expect(texts).not.toContain(i18n.t('currency.sectionTop'))
  expect(rowLabels(tree)).toEqual(['Japanese Yen (JPY)'])
  expect(rowCountries(tree)).toEqual(['JP'])
})

test('the search filters by code or name', async () => {
  const tree = await render()

  // "yen" appears only in the name and "jpy" only in the code, so the pair covers both branches.
  await type(tree, 'yen')
  expect(rowLabels(tree)).toEqual(['Japanese Yen (JPY)'])

  await type(tree, 'jpy')
  expect(rowLabels(tree)).toEqual(['Japanese Yen (JPY)'])

  await type(tree, 'eur')
  expect(rowLabels(tree)).toEqual(['Euro (EUR)'])
})

test('selecting a currency persists it', async () => {
  const tree = await render()

  const eur = tree.root.findAllByType(MenuRow).find(r => (r.props.label as string).includes('Euro (EUR)'))
  await ReactTestRenderer.act(async () => {
    eur?.props.onPress()
  })

  expect(saveDisplayCurrency).toHaveBeenCalledWith('EUR')
})

test('a write the platform refuses is handled', async () => {
  const tree = await render()
  const refusal = handledRefusal()
  jest.mocked(saveDisplayCurrency).mockReturnValueOnce(refusal.answer)

  const eur = tree.root.findAllByType(MenuRow).find(r => (r.props.label as string).includes('Euro (EUR)'))
  await ReactTestRenderer.act(async () => {
    eur?.props.onPress()
  })

  expect(saveDisplayCurrency).toHaveBeenCalledWith('EUR')
  expect(refusal.handled()).toBe(true)
})

// The rows drawn as chosen, which every figure in the app follows only once the choice is saved.
function checked(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(MenuRow)
    .filter(r => r.props.selected === true && r.props.right != null)
    .map(r => r.props.label as string)
}

async function pick(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const row = tree.root.findAllByType(MenuRow).find(r => (r.props.label as string).includes(label))
  await ReactTestRenderer.act(async () => {
    row?.props.onPress()
  })
  await settle()
}

test('a saved choice moves the check', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
  const tree = await render()
  expect(checked(tree)).toEqual(['Brazilian Real (BRL)'])

  await pick(tree, 'Euro (EUR)')

  expect(checked(tree)).toEqual(['Euro (EUR)'])
})

test('a refused write leaves the check on the saved currency, which every figure keeps', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue('BRL')
  const tree = await render()
  jest.mocked(saveDisplayCurrency).mockRejectedValueOnce(new Error('EACCES'))

  await pick(tree, 'Euro (EUR)')

  expect(saveDisplayCurrency).toHaveBeenCalledWith('EUR')
  expect(checked(tree)).toEqual(['Brazilian Real (BRL)'])
})

test('falls back to a non-empty list when the SDK feed is unavailable', async () => {
  jest.mocked(sparkListFiatCurrencies).mockRejectedValue(new Error('offline'))
  const tree = await render()

  const labels = rowLabels(tree).join(' ')
  expect(labels).toContain('Dollar')
  expect(labels).toContain('Real')
})

test('the search field keeps the content margin while the rows reach the edges', async () => {
  const tree = await render()
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))
  expect(flat(tree.root.findByType(Field).props.style).paddingHorizontal).toBe(space.xl)
})

test('the list gives way to the keyboard, so its last rows stay reachable while searching', async () => {
  const tree = await render()
  const avoiders = tree.root.findAllByType(KeyboardAvoidingView)
  expect(avoiders).toHaveLength(1)
  expect(avoiders[0]!.findAllByType(MenuRow).length).toBeGreaterThan(0)
})

describe('during the push that opens the screen', () => {
  const listShown = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findAllByType(SectionList).length > 0

  test('the list waits with the skeleton even when the currencies have landed', async () => {
    mockTransitionDone = false
    const tree = await render()

    expect(sparkListFiatCurrencies).toHaveBeenCalled()
    expect(listShown(tree)).toBe(false)
    expect(tree.root.findAllByType(PickerSkeleton)).toHaveLength(1)
  })

  test('the list follows when the push ends', async () => {
    mockTransitionDone = false
    const tree = await render()

    mockTransitionDone = true
    await ReactTestRenderer.act(async () => tree.update(<CurrencyScreen />))

    expect(listShown(tree)).toBe(true)
    expect(tree.root.findAllByType(PickerSkeleton)).toHaveLength(0)
  })

  test('with the push over and the feed still out, the skeleton stays', async () => {
    jest.mocked(sparkListFiatCurrencies).mockReturnValue(new Promise(() => undefined))
    const tree = await render()

    expect(listShown(tree)).toBe(false)
    expect(tree.root.findAllByType(PickerSkeleton)).toHaveLength(1)
  })
})
