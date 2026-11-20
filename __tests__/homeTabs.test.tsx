import React from 'react'
import { StyleSheet, Text } from 'react-native'
import ReactTestRenderer from 'react-test-renderer'
import { DefaultTheme, NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import i18n from '../src/i18n'
import { HomeTabs, type HomeTabsParamList } from '../src/navigation/HomeTabs'
import { PriceStrip } from '../src/components/PriceStrip'
import { Touch } from '../src/components/Touch'
import { colors, space } from '../src/theme'
import type { PriceLine } from '../src/wallet/priceLine'

// The tab bar and the wordmark sit outside every screen, so they are the parts that keep the
// previous accent unless the mode change reaches them directly.
let mockDollarMode = false
// An accent no mode draws, so a case can tell the hook's answer from a colour picked beside it.
let mockAccent: string | null = null
jest.mock('../src/wallet/dollarMode', () => ({
  useDollarMode: () => mockDollarMode,
  useAccent: () => {
    const theme = require('../src/theme')
    if (mockAccent) {
      return { accent: mockAccent, gradient: theme.gradients.primary }
    }
    return mockDollarMode
      ? { accent: theme.colors.dollar, gradient: theme.gradients.dollar }
      : { accent: theme.colors.primary, gradient: theme.gradients.primary }
  },
}))
// The tabs host real screens, which pull the SDK and the whole asset pipeline. None of that is what
// this suite is about.
jest.mock('../src/screens/HomeScreen', () => ({ HomeScreen: () => null }))
jest.mock('../src/screens/HistoryScreen', () => ({ HistoryScreen: () => null }))
jest.mock('../src/screens/BuyScreen', () => ({ BuyScreen: () => null }))
// Home's price band is drawn here on its own, against the bar, in each state its read can be in.
let mockPriceLine: PriceLine = { status: 'first' }
jest.mock('../src/hooks/useBtcPrice', () => ({ useBtcPrice: () => mockPriceLine }))

const navRef = createNavigationContainerRef<HomeTabsParamList>()

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NavigationContainer ref={navRef}>
        <HomeTabs />
      </NavigationContainer>,
    )
  })
  return tree
}

// The wordmark is an svg mocked to a plain view, so the tint arrives as a prop rather than as paint.
function wordmarkColor(tree: ReactTestRenderer.ReactTestRenderer): string | undefined {
  const marks = tree.root.findAll(
    node => typeof node.props?.color === 'string' && node.props?.width === 84,
  )
  return marks[0]?.props.color
}

beforeEach(() => {
  mockDollarMode = false
  mockAccent = null
})

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

test('the wordmark carries the bitcoin accent by default', async () => {
  expect(wordmarkColor(await render())).toBe(colors.primary)
})

test('the wordmark turns green with the dollar wallet', async () => {
  mockDollarMode = true
  expect(wordmarkColor(await render())).toBe(colors.dollar)
})

// The active tab label is the other piece that can lag behind the mode, so it is asserted through
// the colour actually painted on it rather than through the option that feeds it.
function activeTabColors(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAll(node => typeof node.props?.style === 'object' && node.props?.style !== null)
    .flatMap(node => {
      const style = node.props.style
      const flat = Array.isArray(style) ? style : [style]
      return flat
        .filter((entry): entry is { color?: string } => typeof entry === 'object' && entry !== null)
        .map(entry => entry.color)
        .filter((c): c is string => typeof c === 'string')
    })
}

test('the active tab is tinted with the bitcoin accent by default', async () => {
  const painted = activeTabColors(await render())
  expect(painted).toContain(colors.primary)
  expect(painted).not.toContain(colors.dollar)
})

test('the active tab turns green with the dollar wallet', async () => {
  mockDollarMode = true
  const painted = activeTabColors(await render())
  expect(painted).toContain(colors.dollar)
})

// What Android's back does inside the tabs: the navigator either takes the press or lets it leave.
// Through History on the way, so back returning to the tab before it, History, would show.
test('back from Buy returns to Home, even past History, and back on Home is not taken by the tabs', async () => {
  await render()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(navRef.canGoBack()).toBe(false)

  await ReactTestRenderer.act(async () => {
    navRef.navigate('History')
  })
  await ReactTestRenderer.act(async () => {
    navRef.navigate('Buy')
  })
  await ReactTestRenderer.act(async () => {
    navRef.goBack()
  })
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
})

// In German, so the label is the locale's word and not an English one left in the markup.
test('the menu button, the only way into settings, is named for screen readers in the app language', async () => {
  await i18n.changeLanguage('de')
  const tree = await render()
  const menu = tree.root.findAll(
    node => node.props.accessibilityLabel === i18n.t('nav.menu') && typeof node.props.onPress === 'function',
  )
  expect(i18n.t('nav.menu')).not.toBe('Menu')
  expect(menu.length).toBeGreaterThan(0)
  // Inside act, so the tree is gone before the language changes back below.
  ReactTestRenderer.act(() => tree.unmount())
  await i18n.changeLanguage('en-US')
})

test('the menu and the bell stand on the page gutter and answer a finger as every target does', async () => {
  const tree = await render()
  for (const label of [i18n.t('nav.menu'), i18n.t('notifications.title')]) {
    const target = tree.root.findAllByType(Touch).find(node => node.props.label === label)
    expect(StyleSheet.flatten(target?.props.style).paddingHorizontal).toBe(space.xl)
    expect(target?.props.feedback).toBe('link')
  }
})

test('the wordmark and the active tab take the wallet accent the app decides', async () => {
  mockAccent = '#123456'
  const tree = await render()
  expect(wordmarkColor(tree)).toBe('#123456')
  expect(activeTabColors(tree)).toContain('#123456')
})

test('no line runs along the tab bar or between the tabs', async () => {
  const tree = await render()
  const styles = tree.root
    .findAll(node => typeof node.type === 'string')
    .map(node => Object.assign({}, ...[node.props.style].flat(Infinity).filter(x => x && typeof x === 'object')))
  // The library colours the hairline through borderColor, so either key can carry a visible line.
  const drawn = styles.filter(
    style =>
      style.borderTopWidth > 0 &&
      ![undefined, 'transparent'].includes(style.borderTopColor ?? style.borderColor),
  )
  expect(drawn).toEqual([])
  expect(styles.filter(style => style.backgroundColor === colors.divider)).toEqual([])
})

// At 200% on Android the labels grew past the 49pt bar and sat on the gesture bar. The bar grows by
// the labels' extra leading there and keeps the inset under it; iOS draws the labels at their own
// size, so its bar is the same at every text size.
test('no tab carries the price: the strip is part of Home, never of the tab bar', async () => {
  const tree = await render()
  for (const tab of ['History', 'Buy', 'Home'] as const) {
    await ReactTestRenderer.act(async () => {
      navRef.navigate(tab)
    })
    expect(tree.root.findAllByType(PriceStrip)).toHaveLength(0)
  }
})

describe('the tab bar at large text', () => {
  const { tabBarHeight } = jest.requireActual('../src/navigation/HomeTabs')

  it('grows on Android with the text size, above the bottom inset', () => {
    expect(tabBarHeight(24, 1, 'android')).toBe(49 + 24)
    expect(tabBarHeight(24, 2, 'android')).toBe(49 + 16 + 24)
    expect(tabBarHeight(24, 2, 'android')).toBeGreaterThan(tabBarHeight(24, 1.3, 'android'))
  })

  it('keeps its height on iOS, where the labels do not scale', () => {
    expect(tabBarHeight(34, 3.12, 'ios')).toBe(49 + 34)
  })

  it('never shrinks below the bar at the smaller text sizes', () => {
    expect(tabBarHeight(0, 0.85, 'android')).toBe(49)
  })
})

// A press that finds the status open means the drawer's view went back to closed while its status
// stayed open. A second open would not move the view, so the press closes first and opens a frame
// later; with the status closed, the press only opens.
describe('the menu button', () => {
  const drawer = jest.requireMock('@react-navigation/drawer')

  async function renderRecording(dispatched: string[]): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    // No drawer encloses the tabs here, so both drawer actions reach the container unhandled, in
    // the order they were dispatched.
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <NavigationContainer ref={navRef} onUnhandledAction={action => dispatched.push(action.type)}>
          <HomeTabs />
        </NavigationContainer>,
      )
    })
    return tree
  }

  function pressMenu(tree: ReactTestRenderer.ReactTestRenderer): void {
    const menu = tree.root.find(
      node => node.props.accessibilityLabel === i18n.t('nav.menu') && typeof node.props.onPress === 'function',
    )
    ReactTestRenderer.act(() => {
      menu.props.onPress()
    })
  }

  let frames: Array<(time: number) => void>

  beforeEach(() => {
    frames = []
    jest.spyOn(global, 'requestAnimationFrame').mockImplementation(callback => {
      frames.push(callback)
      return frames.length
    })
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('closes the drawer and opens it again on the next frame when the status is open', async () => {
    jest.spyOn(drawer, 'useDrawerStatus').mockReturnValue('open')
    const dispatched: string[] = []
    const tree = await renderRecording(dispatched)

    pressMenu(tree)
    expect(dispatched).toEqual(['CLOSE_DRAWER'])
    expect(frames).toHaveLength(1)

    ReactTestRenderer.act(() => {
      frames[0](0)
    })
    expect(dispatched).toEqual(['CLOSE_DRAWER', 'OPEN_DRAWER'])
  })

  it('only opens the drawer when the status is closed', async () => {
    jest.spyOn(drawer, 'useDrawerStatus').mockReturnValue('closed')
    const dispatched: string[] = []
    const tree = await renderRecording(dispatched)

    pressMenu(tree)
    expect(dispatched).toEqual(['OPEN_DRAWER'])
    expect(frames).toHaveLength(0)
  })
})

// The bar's own box, the first fill under a tab's label, past the tab button's transparent one.
function barStyle(tree: ReactTestRenderer.ReactTestRenderer) {
  const label = tree.root
    .findAllByType(Text)
    .find(node => node.props.children === i18n.t('nav.history'))
  expect(label).toBeDefined()
  for (let node = label!.parent; node; node = node.parent) {
    const style = StyleSheet.flatten(node.props.style)
    if (style?.backgroundColor !== undefined && style.backgroundColor !== 'transparent') {
      return style
    }
  }
  return undefined
}

// The bar sits on the plain ground, where the glass fallback reads darker than every card on the
// screen, so it takes the cards' fill.
test("the tab bar takes the cards' fill", async () => {
  expect(barStyle(await render())?.backgroundColor).toBe(colors.surface)
})

// The library draws a hairline along the bar's top in the navigation theme's border colour, which
// the app's theme leaves transparent. The bar takes the hairline off itself, so a theme with a
// visible border, as the default one here, still draws no line on the seam with the price band.
test('the tab bar draws no top edge of its own, whatever border the navigation theme gives', async () => {
  const bar = barStyle(await render())
  expect(bar?.borderColor).toBe(DefaultTheme.colors.border)
  expect(bar?.borderTopWidth).toBe(0)
})

// Home's price band sits on the bar as one block: the bar's own fill, square, flush and full width,
// with its text on the page gutter, in every state the band draws. The library lifts the bar with an
// Android elevation, whose shadow would draw a line across the joint.
test("Home's price band takes the tab bar's fill and joins it with no corner, gap or shadow", async () => {
  const bar = barStyle(await render())
  expect(bar?.elevation ?? 0).toBe(0)
  const lines: PriceLine[] = [
    { status: 'first' },
    { status: 'none' },
    { status: 'price', rate: 600_000, currency: 'BRL', current: true, readAt: 0 },
    { status: 'price', rate: 600_000, currency: 'BRL', current: false, readAt: 0 },
  ]
  for (const line of lines) {
    mockPriceLine = line
    let band!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      band = ReactTestRenderer.create(<PriceStrip onOpen={jest.fn()} focused beat={0} stale={false} />)
    })
    const style = StyleSheet.flatten((band.toJSON() as ReactTestRenderer.ReactTestRendererJSON).props.style)
    expect([line.status, style.backgroundColor]).toEqual([line.status, bar?.backgroundColor])
    expect(Object.entries(style).filter(([key, value]) => /^margin|Radius$/.test(key) && value !== 0)).toEqual([])
    expect([style.width, style.maxWidth, style.alignSelf]).toEqual([undefined, undefined, undefined])
    expect(style.paddingHorizontal).toBe(space.xl)
    ReactTestRenderer.act(() => band.unmount())
  }
})
