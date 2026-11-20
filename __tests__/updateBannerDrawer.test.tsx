import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import RNFS from 'react-native-fs'
import { NavigationContainer, createNavigationContainerRef } from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import i18n from '../src/i18n'
import { AppDrawer } from '../src/navigation/AppDrawer'
import { UpdateBanner } from '../src/components/UpdateBanner'
import { WalletsScreen } from '../src/screens/WalletsScreen'
import { connectActiveSpark, sparkGetFiatRates, sparkGetWalletInfo } from '../src/wallet/spark'
import { readUpdateNotice } from '../src/wallet/updateNotice'
import type { RootStackParamList } from '../src/navigation/RootNavigator'

// The drawer sits outside Home and Add wallet sits past the drawer, so whether the banner leaves Add
// wallet reachable is walked here through the real drawer and the real Home, with the critical banner
// drawn.
jest.mock('@react-navigation/drawer', () => jest.requireActual('@react-navigation/drawer'))
jest.mock('react-native-drawer-layout', () => {
  const react = require('react')
  const { View } = require('react-native')
  const progress = react.createContext(undefined)
  return {
    DrawerProgressContext: progress,
    DrawerGestureContext: react.createContext(null),
    useDrawerProgress: () => react.useContext(progress),
    Drawer: ({
      renderDrawerContent,
      children,
    }: {
      renderDrawerContent: () => React.ReactNode
      children: React.ReactNode
    }) => react.createElement(View, null, children, renderDrawerContent()),
  }
})
jest.mock('react-native-safe-area-context', () => {
  const actual = jest.requireActual('react-native-safe-area-context')
  return { ...actual, useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }) }
})
jest.mock('../src/screens/HistoryScreen', () => ({ HistoryScreen: () => null }))
jest.mock('../src/screens/BuyScreen', () => ({ BuyScreen: () => null }))
jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'primary',
  sparkSetStableBalance: jest.fn(async () => undefined),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkPrepareConvertBySpend: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

const Stack = createNativeStackNavigator<RootStackParamList>()
const navRef = createNavigationContainerRef<RootStackParamList>()
const Blank = (): null => null

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 5))
    })
  }
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const hits = tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      (node.props.accessibilityLabel === label ||
        node.findAllByType(Text).some(text => text.props.children === label)),
  )
  if (hits.length === 0) {
    throw new Error(`nothing to press named ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    hits[hits.length - 1].props.onPress()
  })
  await settle()
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined as never)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 5_000, tokens: [] } as never)
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ currency: 'USD', rates: {} } as never)
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
})

test('Add wallet stays reachable with the critical banner up', async () => {
  jest.mocked(readUpdateNotice).mockResolvedValue({ level: 'critical' })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <NavigationContainer ref={navRef}>
        <Stack.Navigator screenOptions={{ headerShown: false }}>
          <Stack.Screen name="Main" component={AppDrawer} />
          <Stack.Screen name="Wallets" component={WalletsScreen} />
          <Stack.Screen name="AddWallet" component={Blank} />
        </Stack.Navigator>
      </NavigationContainer>,
    )
  })
  await settle()
  expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(1)

  await press(tree, i18n.t('nav.menu'))
  await press(tree, i18n.t('wallets.title'))
  expect(navRef.getCurrentRoute()?.name).toBe('Wallets')
  await press(tree, i18n.t('wallets.add'))
  expect(navRef.getCurrentRoute()?.name).toBe('AddWallet')
})
