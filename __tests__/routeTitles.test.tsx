import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { RootNavigator } from '../src/navigation/RootNavigator'

// Each route's header title, read off the screen declarations, so no screen has to mount.
const mockTitles = new Map<string, unknown>()
// Each route's resolved options whole, for what the header draws.
const mockOptions = new Map<string, Record<string, unknown>>()
jest.mock('@react-navigation/native-stack', () => ({
  createNativeStackNavigator: () => ({
    Navigator: ({ children }: { children: React.ReactNode }) => children,
    Screen: ({ name, options }: { name: string; options?: unknown }) => {
      const resolved =
        typeof options === 'function' ? options({ route: { params: { name: 'Bitcoin' } } }) : options
      mockTitles.set(name, (resolved as { title?: unknown } | undefined)?.title)
      mockOptions.set(name, (resolved ?? {}) as Record<string, unknown>)
      return null
    },
  }),
}))
jest.mock('@react-navigation/native', () => ({
  ...jest.requireActual('@react-navigation/native'),
  NavigationContainer: ({ children }: { children: React.ReactNode }) => children,
  useNavigationContainerRef: () => ({ isReady: () => false }),
}))
jest.mock('../src/components/ReceivedOverlayHost', () => ({ ReceivedOverlayHost: () => null }))

async function titles(): Promise<Map<string, unknown>> {
  mockTitles.clear()
  mockOptions.clear()
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(<RootNavigator />)
  })
  return mockTitles
}

test('the notification settings are not titled as the notifications themselves', async () => {
  const shown = await titles()
  expect(shown.get('Notifications')).toBe(i18n.t('notifications.title'))
  expect(shown.get('NotificationSettings')).toBe(i18n.t('notifications.settingsTitle'))
  expect(shown.get('NotificationSettings')).not.toBe(shown.get('Notifications'))
})

// A screen opens under the words of the row that opened it on the domain screen.
test('the domain screens are titled as the rows that open them', async () => {
  const shown = await titles()
  expect(shown.get('DomainWallets')).toBe(i18n.t('domain.allowed'))
  expect(shown.get('DomainAccessRequest')).toBe(i18n.t('domain.request'))
})

// The native title keeps the box it was laid out in when the system text size grows, so every pushed
// screen draws its title with the app's text, which follows the size.
test('every pushed screen draws its own title in the app text, on one line, as a header', async () => {
  const shown = await titles()
  const pushed = [...mockOptions].filter(([, options]) => options.headerShown === true)
  expect(pushed.length).toBeGreaterThan(20)
  for (const [name, options] of pushed) {
    const title = shown.get(name)
    expect(typeof title).toBe('string')
    // Translated, never the raw key.
    expect([name, title]).not.toEqual([name, expect.stringMatching(/^[a-z]+\.[A-Za-z.]+$/)])
    const render = options.headerTitle as ((props: { children: string }) => React.ReactElement) | undefined
    expect(typeof render).toBe('function')
    let drawn!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      drawn = ReactTestRenderer.create(render!({ children: title as string }))
    })
    const text = drawn.root.findByType(Text)
    expect([name, text.props.children]).toEqual([name, title])
    expect(text.props.numberOfLines).toBe(1)
    expect(text.props.adjustsFontSizeToFit).toBe(true)
    expect(text.props.accessibilityRole).toBe('header')
    ReactTestRenderer.act(() => drawn.unmount())
  }
})

test("the asset screen's title is the asset's own name", async () => {
  const shown = await titles()
  expect(shown.get('AssetDetail')).toBe('Bitcoin')
  const render = mockOptions.get('AssetDetail')!.headerTitle as (props: { children: string }) => React.ReactElement
  let drawn!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    drawn = ReactTestRenderer.create(render({ children: 'Bitcoin' }))
  })
  expect(drawn.root.findByType(Text).props.children).toBe('Bitcoin')
})

test('the title follows the system text size, and keeps its words whole when it shrinks', async () => {
  await titles()
  const render = mockOptions.get('Convert')!.headerTitle as (props: { children: string }) => React.ReactElement
  let drawn!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    drawn = ReactTestRenderer.create(render({ children: i18n.t('convert.title') }))
  })
  const text = drawn.root.findByType(Text)
  // Uncapped, so it scales as far as the system asks.
  expect(text.props.maxFontSizeMultiplier).toBeUndefined()
  expect(text.props.allowFontScaling).not.toBe(false)
  expect(drawn.root.findAll(n => n.props.wholeWords === true).length).toBeGreaterThan(0)
})
