import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { DeviceEventEmitter } from 'react-native'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import i18n from '../src/i18n'
import { AppDrawer } from '../src/navigation/AppDrawer'
import { WalletList } from '../src/components/WalletList'
import { WalletsScreen } from '../src/screens/WalletsScreen'
import { backToHomeTab } from '../src/navigation/backToHomeTab'
import { hasPin } from '../src/wallet/pin'
import type { RootStackParamList } from '../src/navigation/RootNavigator'

// The real drawer navigator and router, so the drawer's status lives in the navigation state as it
// does on a device, instead of the passthrough jest.setup.js puts in its place.
jest.mock('@react-navigation/drawer', () => jest.requireActual('@react-navigation/drawer'))
// The drawer's view animates through reanimated and gesture-handler, which do not run here. The
// stand-in keeps its contract: its view follows `open` only when `open` changes, as the library's
// layout effect does, and its scrim closes it through onClose, as the library's overlay does.
// `mockView.drop` puts the view back to closed without touching the status, a state the real view
// reaches on Android.
const mockView = { drop: () => undefined as void }
jest.mock('react-native-drawer-layout', () => {
  const react = require('react')
  const { Pressable, View } = require('react-native')
  const progress = react.createContext(undefined)
  return {
    DrawerProgressContext: progress,
    DrawerGestureContext: react.createContext(null),
    useDrawerProgress: () => react.useContext(progress),
    Drawer: ({
      open,
      onClose,
      renderDrawerContent,
      children,
    }: {
      open: boolean
      onClose: () => void
      renderDrawerContent: () => React.ReactNode
      children: React.ReactNode
    }) => {
      const [shown, setShown] = react.useState(open)
      react.useLayoutEffect(() => setShown(open), [open])
      mockView.drop = () => setShown(false)
      return react.createElement(
        View,
        { testID: 'drawer', accessibilityState: { expanded: shown } },
        children,
        shown ? react.createElement(Pressable, { accessibilityLabel: 'scrim', onPress: onClose }) : null,
        renderDrawerContent(),
      )
    },
  }
})
// The Android BackHandler, as in onboardingBack.test, so a hardware back reaches the listeners.
jest.mock('react-native/Libraries/Utilities/BackHandler', () =>
  jest.requireActual('react-native/Libraries/Utilities/BackHandler.android'),
)
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context')
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }
})
jest.mock('../src/screens/HomeScreen', () => ({ HomeScreen: () => null }))
jest.mock('../src/screens/HistoryScreen', () => ({ HistoryScreen: () => null }))
jest.mock('../src/screens/BuyScreen', () => ({ BuyScreen: () => null }))
jest.mock('../src/wallet/pin', () => ({ hasPin: jest.fn(async () => false) }))
jest.mock('../src/wallet/settings', () => ({ loadDisplayCurrency: jest.fn(async () => null) }))
jest.mock('../src/wallet/wallet', () => ({
  getWalletIdentity: jest.fn(async () => ({ fingerprint: '' })),
  onActiveWalletChanged: () => () => undefined,
  switchWalletWithoutReconnecting: jest.fn(async () => undefined),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({
    wallets: [
      { id: 'a', fingerprint: 'aaaaaaaa' },
      { id: 'b', fingerprint: 'bbbbbbbb' },
    ],
    active: 'a',
  })),
}))
jest.mock('../src/wallet/backupMark', () => ({ isUnconfirmed: jest.fn(async () => false) }))
jest.mock('../src/wallet/walletMeta', () => ({ loadWalletMeta: jest.fn(async () => null) }))

const Stack = createNativeStackNavigator<RootStackParamList>()
const navRef = createNavigationContainerRef<RootStackParamList>()
const Blank = (): null => null

// Every screen a drawer row opens, and the two other ways off Home that this suite takes.
const DESTINATIONS = [
  'Wallets',
  'RecoveryPhrase',
  'SetPin',
  'PinSettings',
  'LnAddress',
  'Contacts',
  'StableBalance',
  'Currency',
  'Language',
  'NotificationSettings',
  'Explorers',
  'Support',
  'Legal',
  'Notifications',
  'Send',
  'Receive',
] as const

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
}

let current: ReactTestRenderer.ReactTestRenderer | null = null

async function render(
  wallets: React.ComponentType = Blank,
): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NavigationContainer ref={navRef}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Main" component={AppDrawer} />
          {DESTINATIONS.map(name => (
            <Stack.Screen key={name} name={name} component={name === 'Wallets' ? wallets : Blank} />
          ))}
        </Stack.Navigator>
      </NavigationContainer>,
    )
  })
  await settle()
  current = tree
  return tree
}

afterEach(() => {
  current?.unmount()
  current = null
})

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

// What the person sees, the view, as against the status the navigation state holds.
function drawerOpen(tree: ReactTestRenderer.ReactTestRenderer): boolean {
  return tree.root.findByProps({ testID: 'drawer' }).props.accessibilityState.expanded
}

function drawerStatus(): 'open' | 'closed' {
  // A container whose root navigator has not registered has no state; reading that as closed would
  // pass a drawer check vacuously.
  const root = navRef.getRootState()
  if (root === undefined) {
    throw new Error('navigation container is not ready')
  }
  const main = root.routes.find(route => route.name === 'Main')
  const history = (main?.state?.history ?? []) as Array<{ type: string }>
  return history.some(entry => entry.type === 'drawer') ? 'open' : 'closed'
}

// The control a person presses: the element that carries both the handler and the name.
function pressable(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  const hits = tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      (node.props.accessibilityLabel === label ||
        node.findAll(child => child.props.children === label).length > 0),
  )
  if (hits.length === 0) {
    throw new Error(`nothing to press named ${label}`)
  }
  return hits[hits.length - 1]
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = pressable(tree, label)
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

async function back(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    navRef.goBack()
  })
  await settle()
}

async function hardwareBack(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    DeviceEventEmitter.emit('hardwareBackPress')
  })
  await settle()
}

const ROWS: Array<[string, () => string]> = [
  ['Wallets', () => i18n.t('wallets.title')],
  ['RecoveryPhrase', () => i18n.t('settings.recoveryPhrase')],
  ['SetPin', () => i18n.t('settings.pin')],
  ['LnAddress', () => i18n.t('settings.lnAddress')],
  ['Contacts', () => i18n.t('contacts.title')],
  ['StableBalance', () => i18n.t('settings.stableBalance')],
  ['Currency', () => i18n.t('settings.currency')],
  ['Language', () => i18n.t('settings.language')],
  ['NotificationSettings', () => i18n.t('notifications.title')],
  ['Explorers', () => i18n.t('explorers.title')],
  ['Support', () => i18n.t('settings.support')],
  ['Legal', () => i18n.t('settings.legal')],
]

describe.each(ROWS)('the drawer row that opens %s', (screen, label) => {
  test('opens it, and back returns to the open drawer, which the scrim closes and one Menu press opens', async () => {
    const tree = await render()
    await press(tree, i18n.t('nav.menu'))
    expect(drawerOpen(tree)).toBe(true)

    // The drawer's own notifications row and the header's bell share a name; only the open drawer's
    // row is pressed, the last match in the tree.
    await press(tree, label())
    expect(navRef.getCurrentRoute()?.name).toBe(screen)
    // Closed while covered, an Android drawer can come back drawn open with its status closed.
    expect(drawerStatus()).toBe('open')

    await back()
    expect(navRef.getCurrentRoute()?.name).toBe('Home')
    expect(drawerOpen(tree)).toBe(true)
    expect(drawerStatus()).toBe('open')

    await press(tree, 'scrim')
    expect(drawerOpen(tree)).toBe(false)
    expect(drawerStatus()).toBe('closed')

    await press(tree, i18n.t('nav.menu'))
    expect(drawerOpen(tree)).toBe(true)
  })
})

test('one Menu press shows the drawer again after its view went back to closed with the status open', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  expect(drawerOpen(tree)).toBe(true)

  await ReactTestRenderer.act(async () => {
    mockView.drop()
  })
  expect(drawerOpen(tree)).toBe(false)
  expect(drawerStatus()).toBe('open')

  await press(tree, i18n.t('nav.menu'))
  expect(drawerOpen(tree)).toBe(true)
  expect(drawerStatus()).toBe('open')
})

test('a screen opened from the drawer and left with the hardware back finds it open, and the next back closes it', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  await press(tree, i18n.t('settings.lnAddress'))
  expect(navRef.getCurrentRoute()?.name).toBe('LnAddress')

  await hardwareBack()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(true)

  await hardwareBack()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(false)
})

// A deeplink or a tapped notification navigates from the container while the drawer may be open.
test('a screen opened from outside the drawer while it is open finds it closed on return', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  expect(drawerOpen(tree)).toBe(true)

  await ReactTestRenderer.act(async () => {
    navRef.navigate('Send', { destination: 'lnbc1' })
  })
  await settle()
  expect(navRef.getCurrentRoute()?.name).toBe('Send')

  await back()
  expect(drawerOpen(tree)).toBe(false)
  await press(tree, i18n.t('nav.menu'))
  expect(drawerOpen(tree)).toBe(true)
})

// A row keeps the drawer open for its own return alone.
test('a screen opened from outside after a row closes the drawer it finds open on return', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  await press(tree, i18n.t('settings.support'))
  await back()
  expect(drawerOpen(tree)).toBe(true)

  await ReactTestRenderer.act(async () => {
    navRef.navigate('Send', { destination: 'lnbc1' })
  })
  await settle()
  await back()
  expect(drawerOpen(tree)).toBe(false)
})

// A tap can land in the moment a deeplink is covering Main, and that row does not make the deeplink's
// return its own.
test('a row pressed while a deeplink covers Main does not keep the drawer open for the way back', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  const row = pressable(tree, i18n.t('settings.support'))

  await ReactTestRenderer.act(async () => {
    navRef.navigate('Send', { destination: 'lnbc1' })
    row.props.onPress()
  })
  await settle()
  expect(navRef.getCurrentRoute()?.name).toBe('Support')

  await back()
  await back()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(false)
})

// Switching, adding or removing a wallet ends with navigate('Main'), which pushes a new Main, so the
// flow lands on Home with nothing covering it. The Main beneath keeps the drawer the flow started from.
describe('a flow that ends on Home, driven from the wallet list', () => {
  async function switchWallet(): Promise<ReactTestRenderer.ReactTestRenderer> {
    const tree = await render(WalletsScreen)
    await press(tree, i18n.t('nav.menu'))
    await press(tree, i18n.t('wallets.title'))
    expect(navRef.getCurrentRoute()?.name).toBe('Wallets')

    const list = tree.root.findByType(WalletList)
    await ReactTestRenderer.act(async () => {
      await list.props.onPressRow(list.props.rows[1])
    })
    await settle()
    return tree
  }

  const drawers = (tree: ReactTestRenderer.ReactTestRenderer): boolean[] =>
    tree.root
      .findAllByProps({ testID: 'drawer' }, { deep: false })
      .map(view => view.props.accessibilityState.expanded)

  test('lands there with the drawer closed', async () => {
    const tree = await switchWallet()

    expect(navRef.getCurrentRoute()?.name).toBe('Home')
    expect(drawers(tree)).toEqual([true, false])
  })

  test('back walks the stack to the Main beneath, on the drawer it opened from, which the scrim closes', async () => {
    const tree = await switchWallet()

    await back()
    expect(navRef.getCurrentRoute()?.name).toBe('Wallets')
    await back()

    expect(navRef.getCurrentRoute()?.name).toBe('Home')
    expect(drawers(tree)).toEqual([true])
    await press(tree, 'scrim')
    expect(drawers(tree)).toEqual([false])
  })
})

describe('leaving Receive once its invoice is paid', () => {
  const stack = (): string[] => navRef.getRootState()?.routes.map(route => route.name) ?? []

  test('goes back to the one Main, on Home, however many payments come', async () => {
    await render()
    for (let paid = 0; paid < 3; paid++) {
      await ReactTestRenderer.act(async () => {
        navRef.navigate('Receive')
      })
      await settle()
      await ReactTestRenderer.act(async () => {
        navRef.dispatch(backToHomeTab())
      })
      await settle()
    }

    expect(stack()).toEqual(['Main'])
    expect(navRef.getCurrentRoute()?.name).toBe('Home')
  })

  test('from the History tab lands on Home', async () => {
    const tree = await render()
    await press(tree, i18n.t('nav.history'))
    await ReactTestRenderer.act(async () => {
      navRef.navigate('Receive')
    })
    await settle()

    await ReactTestRenderer.act(async () => {
      navRef.dispatch(backToHomeTab())
    })
    await settle()

    expect(navRef.getCurrentRoute()?.name).toBe('Home')
  })
})

test('the hardware back with the drawer open closes it and stays on Home', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  await hardwareBack()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(false)
})

test('the scrim closes the drawer, and the bell opens Notifications with the drawer left closed', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.menu'))
  await press(tree, 'scrim')
  expect(drawerOpen(tree)).toBe(false)

  const bell = tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === i18n.t('notifications.title'),
  )
  await ReactTestRenderer.act(async () => {
    bell[0].props.onPress()
  })
  await settle()
  expect(navRef.getCurrentRoute()?.name).toBe('Notifications')
  await back()
  expect(drawerOpen(tree)).toBe(false)
})

test('the tabs and the wordmark move between tabs without touching the drawer', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.history'))
  expect(navRef.getCurrentRoute()?.name).toBe('History')
  expect(drawerOpen(tree)).toBe(false)
  await press(tree, i18n.t('nav.home'))
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(false)
  await press(tree, i18n.t('nav.menu'))
  expect(drawerOpen(tree)).toBe(true)
})

// The wordmark shares its accessible name with the Home tab, so it is found by what it draws, the
// 84pt wide svg, and pressed on its own.
test('the wordmark alone takes History back to Home without touching the drawer', async () => {
  const tree = await render()
  await press(tree, i18n.t('nav.history'))
  expect(navRef.getCurrentRoute()?.name).toBe('History')

  const wordmark = tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      node.props.accessibilityLabel === i18n.t('nav.home') &&
      node.findAll(child => (child.type as unknown) === 'SvgMock' && child.props.width === 84).length > 0,
  )
  expect(wordmark.length).toBeGreaterThan(0)
  await ReactTestRenderer.act(async () => {
    wordmark[0].props.onPress()
  })
  await settle()
  expect(navRef.getCurrentRoute()?.name).toBe('Home')
  expect(drawerOpen(tree)).toBe(false)
  expect(drawerStatus()).toBe('closed')
})

// With a PIN already set the same row opens the PIN's settings rather than the screen that sets one.
test('the PIN row opens its settings once a PIN is set, and back returns to the open drawer', async () => {
  jest.mocked(hasPin).mockImplementation(async () => true)
  try {
    const tree = await render()
    await press(tree, i18n.t('nav.menu'))
    expect(drawerOpen(tree)).toBe(true)

    await press(tree, i18n.t('settings.pin'))
    expect(navRef.getCurrentRoute()?.name).toBe('PinSettings')

    await back()
    expect(navRef.getCurrentRoute()?.name).toBe('Home')
    expect(drawerOpen(tree)).toBe(true)
    expect(drawerStatus()).toBe('open')
  } finally {
    jest.mocked(hasPin).mockImplementation(async () => false)
  }
})
