import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import '../src/i18n'
import i18n from '../src/i18n'
import { TabIcon } from '../src/components/TabIcon'
import { DrawerContent } from '../src/navigation/DrawerContent'
import { MenuRow } from '../src/components/MenuRow'
import { Skeleton } from '../src/components/Skeleton'
import { font, space } from '../src/theme'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { formatFingerprint } from '../src/wallet/walletIdentity'
import { loadDisplayCurrency } from '../src/wallet/settings'
import { getWalletIdentity } from '../src/wallet/wallet'
import { getCurrencies } from 'react-native-localize'

const mockNavigate = jest.fn()
const mockScrollStyle: { current: unknown } = { current: null }
jest.mock('@react-navigation/drawer', () => ({
  DrawerContentScrollView: ({
    children,
    contentContainerStyle,
  }: {
    children: React.ReactNode
    contentContainerStyle: unknown
  }) => {
    mockScrollStyle.current = contentContainerStyle
    return children
  },
}))
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  // DrawerContent registers more than one focus effect, so refocus() has to fire every callback.
  const holder: { cbs: Set<() => void> } = { cbs: new Set() }
  return {
    __holder: holder,
    // Main never loses focus here; drawerReturn.test covers the drawer closing when it does.
    useNavigation: () => ({ navigate: mockNavigate, isFocused: () => true, addListener: () => () => undefined }),
    useFocusEffect: (cb: () => void) => {
      holder.cbs.add(cb)
      react.useEffect(cb, [])
    },
  }
})
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}))
jest.mock('../src/wallet/pin', () => ({ hasPin: jest.fn(async () => false) }))
jest.mock('../src/wallet/settings', () => ({ loadDisplayCurrency: jest.fn(async () => null) }))
// The switch announcement, kept so a case can switch the active wallet with the drawer open.
const mockWalletChanged = new Set<(id: string) => void>()
jest.mock('../src/wallet/wallet', () => ({
  getWalletIdentity: jest.fn(async () => ({ fingerprint: '' })),
  onActiveWalletChanged: (cb: (id: string) => void) => {
    mockWalletChanged.add(cb)
    return () => mockWalletChanged.delete(cb)
  },
}))
jest.mock('../src/wallet/walletMeta', () => ({ loadWalletMeta: jest.fn(async () => null) }))
jest.mock('react-native-localize', () => ({
  getCurrencies: jest.fn(() => []),
  findBestLanguageTag: () => ({ languageTag: 'en-US', isRTL: false }),
}))

const nav = jest.requireMock('@react-navigation/native') as { __holder: { cbs: Set<() => void> } }

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

// A rendered drawer stays subscribed to i18n, and a later changeLanguage would update the stale
// tree outside act() and crash teardown, so every test unmounts.
let current: ReactTestRenderer.ReactTestRenderer | null = null

async function renderDrawer(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <DrawerContent {...({} as React.ComponentProps<typeof DrawerContent>)} />,
    )
  })
  await settle()
  current = tree
  return tree
}

async function refocus(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    nav.__holder.cbs.forEach(cb => cb())
  })
  await settle()
}

function currencyValue(tree: ReactTestRenderer.ReactTestRenderer): string | undefined {
  const row = tree.root.findAllByType(MenuRow).find(r => r.props.icon === 'banknote')
  return row?.props.value as string | undefined
}

function allText(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAll(n => typeof n.props.children === 'string')
    .map(n => n.props.children as string)
    .join(' ')
}

beforeEach(() => {
  jest.mocked(getCurrencies).mockReturnValue([])
  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: '' })
})

afterEach(async () => {
  if (current) {
    await ReactTestRenderer.act(async () => {
      current!.unmount()
    })
    current = null
  }
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

// The library's scroll sets paddingStart and paddingEnd, which win over a paddingHorizontal.
test('the rows hold the app gutter through the two sides the scroll sets itself', async () => {
  await renderDrawer()
  const style = StyleSheet.flatten(mockScrollStyle.current as object[]) as Record<string, number>
  expect(style.paddingStart).toBe(space.xl)
  expect(style.paddingEnd).toBe(space.xl)
})

test('re-derives the locale default on re-focus after the language changes', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue(null)
  await i18n.changeLanguage('pt-BR')

  const tree = await renderDrawer()
  expect(currencyValue(tree)).toBe('BRL')

  await ReactTestRenderer.act(async () => {
    await i18n.changeLanguage('en-US')
  })
  await refocus()

  // Deriving the default only on first render would leave this stuck on BRL.
  expect(currencyValue(tree)).toBe('USD')
})

test('re-reads the active wallet identity on re-focus, not just on mount', async () => {
  // Reading the fingerprint once on mount would keep a deleted wallet's identity on screen.
  jest.mocked(loadDisplayCurrency).mockResolvedValue(null)
  await i18n.changeLanguage('en-US')
  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'aaaa1111' })

  const tree = await renderDrawer()
  expect(allText(tree)).toContain('aaaa1111')

  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'bbbb2222' })
  await refocus()

  expect(allText(tree)).toContain('bbbb2222')
  expect(allText(tree)).not.toContain('aaaa1111')
})

test('with nothing saved, the drawer shows the locale default', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue(null)
  await i18n.changeLanguage('en-US')
  expect(currencyValue(await renderDrawer())).toBe('USD')
})

test('a saved currency wins over the locale default', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue('EUR')
  await i18n.changeLanguage('en-US')
  expect(currencyValue(await renderDrawer())).toBe('EUR')
})

test('the device region currency drives the default, even in another language', async () => {
  jest.mocked(loadDisplayCurrency).mockResolvedValue(null)
  jest.mocked(getCurrencies).mockReturnValue(['BRL'])
  await i18n.changeLanguage('en-US')

  expect(currencyValue(await renderDrawer())).toBe('BRL')
})

test('the wallet header is a comfortable target that says it navigates', async () => {
  // The header is only as tall as the avatar, so without hitSlop a near-miss tap does nothing.
  await i18n.changeLanguage('en-US')
  const tree = await renderDrawer()

  const header = tree.root
    .findAll(node => node.props.accessibilityLabel === 'Wallets' && typeof node.props.onPress === 'function')
    .at(0)
  expect(header).toBeDefined()
  expect(header?.props.hitSlop).toBeGreaterThan(0)
  expect(tree.root.findAllByType(TabIcon).some(icon => icon.props.name === 'chevron')).toBe(true)
})

// The row leads to the wallets, and a label replaces what a screen reader reads inside it, so the
// label names the wallet too.
test('the identity row names the wallet and its fingerprint to a screen reader', async () => {
  await i18n.changeLanguage('en-US')
  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'aaaa1111' })
  const tree = await renderDrawer()

  // The pressable that holds the fingerprint, which is the identity row.
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole === 'button')
    .find(n => n.findAll(c => c.props.children === formatFingerprint('aaaa1111')).length > 0)!
  expect(row.props.accessibilityLabel).toBe(
    i18n.t('drawer.identity', { name: i18n.t('drawer.walletName'), fingerprint: formatFingerprint('aaaa1111') }),
  )
})

// A switch made while the drawer is open: the previous wallet never stands for the new one.
test('a wallet switch shows the placeholder until the new wallet is read, then the new wallet', async () => {
  await i18n.changeLanguage('en-US')
  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'aaaa1111' })
  const tree = await renderDrawer()
  expect(allText(tree)).toContain(formatFingerprint('aaaa1111'))

  let answer!: (id: { fingerprint: string }) => void
  jest.mocked(getWalletIdentity).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)) as never)
  await ReactTestRenderer.act(async () => {
    mockWalletChanged.forEach(cb => cb('w_b'))
  })
  await settle()
  expect(allText(tree)).not.toContain(formatFingerprint('aaaa1111'))
  expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)

  await ReactTestRenderer.act(async () => answer({ fingerprint: 'bbbb2222' }))
  await settle()
  expect(allText(tree)).toContain(formatFingerprint('bbbb2222'))
  expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
})

test('the identity loads at the line heights it is drawn at', async () => {
  jest.mocked(getWalletIdentity).mockImplementationOnce(() => new Promise(() => undefined) as never)
  const tree = await renderDrawer()
  const bars = tree.root.findAllByType(Skeleton).map(bar => bar.props.height)
  expect(bars).toEqual([44, font.size.lg, font.leading.sm])
})

test('a read of the previous wallet answering after the switch never replaces the new one', async () => {
  await i18n.changeLanguage('en-US')
  let late!: (id: { fingerprint: string }) => void
  jest.mocked(getWalletIdentity).mockImplementationOnce(() => new Promise(resolve => (late = resolve)) as never)
  const tree = await renderDrawer()

  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'bbbb2222' })
  await ReactTestRenderer.act(async () => {
    mockWalletChanged.forEach(cb => cb('w_b'))
  })
  await settle()
  await ReactTestRenderer.act(async () => late({ fingerprint: 'aaaa1111' }))
  await settle()

  expect(allText(tree)).toContain(formatFingerprint('bbbb2222'))
  expect(allText(tree)).not.toContain(formatFingerprint('aaaa1111'))
})

// At the largest text size a menu label broke inside a word ("recuperaç / ão"). Every label in the
// menu keeps its words whole, wrapping between them or shrinking until the longest fits.
test('the menu labels keep their words whole', async () => {
  const tree = await renderDrawer()
  const rows = tree.root.findAllByType(MenuRow)
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const label = row.findAll(n => n.props.wholeWords !== undefined && n.props.children === row.props.label)
    expect(label.length).toBeGreaterThan(0)
    expect(label.every(n => n.props.wholeWords === true)).toBe(true)
  }
})

// At the largest text size "Português" took the language row and left "Idioma" no width at all.
test('a menu value gives way to its label, which keeps a share of the row', async () => {
  const tree = await renderDrawer()
  const row = tree.root.findAllByType(MenuRow).find(node => node.props.value !== undefined && node.props.value !== null)
  expect(row).toBeDefined()
  const value = row!.findAll(n => n.props.wholeWords !== undefined && n.props.children === row!.props.value)[0]
  expect(StyleSheet.flatten(value.props.style).maxWidth).toBe('50%')
})

describe('the emergency exit row', () => {
  afterEach(() => __setEmergencyExitLiveForTests(null))

  const row = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(MenuRow).find(r => r.props.label === i18n.t('emergencyExit.title'))

  test('is absent with the switch off', async () => {
    __setEmergencyExitLiveForTests(false)
    expect(row(await renderDrawer())).toBeUndefined()
  })

  test('as shipped, sits before Support and opens the exit of the whole balance', async () => {
    const tree = await renderDrawer()
    const labels = tree.root.findAllByType(MenuRow).map(r => r.props.label)
    expect(labels.indexOf(i18n.t('emergencyExit.title'))).toBe(labels.indexOf(i18n.t('settings.support')) - 1)
    await ReactTestRenderer.act(async () => row(tree)?.props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'all' })
  })
})
