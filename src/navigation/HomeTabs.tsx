import React from 'react'
import { Platform, StyleSheet, useWindowDimensions } from 'react-native'
import { createBottomTabNavigator, type BottomTabNavigationProp } from '@react-navigation/bottom-tabs'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { DrawerActions, useNavigation } from '@react-navigation/native'
import { useDrawerStatus } from '@react-navigation/drawer'
import type { NativeStackNavigationProp } from '@react-navigation/native-stack'
import { useTranslation } from 'react-i18next'
import { HomeScreen } from '../screens/HomeScreen'
import { HistoryScreen } from '../screens/HistoryScreen'
import { BuyScreen } from '../screens/BuyScreen'
import { TabIcon } from '../components/TabIcon'
import { Touch } from '../components/Touch'
import VoltzWordmark from '../assets/voltz-text.svg'
import type { RootStackParamList } from './RootNavigator'
import { useAccent } from '../wallet/dollarMode'
import { colors, font, noTopEdge, space } from '../theme'

export type HomeTabsParamList = { History: undefined; Home: undefined; Buy: undefined }

const Tab = createBottomTabNavigator<HomeTabsParamList>()

function Logo(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<BottomTabNavigationProp<HomeTabsParamList>>()
  const { accent } = useAccent()
  return (
    <Touch onPress={() => navigation.navigate('Home')} feedback="link" hitSlop={space.md} label={t('nav.home')}>
      <VoltzWordmark width={84} height={28} color={accent} />
    </Touch>
  )
}

// DrawerActions bubbles from the tab up to the enclosing drawer. The label is what a screen reader
// says for the only way into settings, since the glyph says nothing to it.
function MenuButton(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation()
  const status = useDrawerStatus()
  const open = () => navigation.dispatch(DrawerActions.openDrawer())
  return (
    <Touch
      onPress={() => {
        // The scrim covers this button whenever the drawer shows, so a press that finds the status
        // open means the drawer's view went back to closed while its status stayed open. The view
        // moves only when `open` changes, so a second open would do nothing: close, then open a
        // frame later.
        if (status === 'open') {
          navigation.dispatch(DrawerActions.closeDrawer())
          requestAnimationFrame(open)
          return
        }
        open()
      }}
      feedback="link"
      hitSlop={space.md}
      label={t('nav.menu')}
      style={styles.headerButton}>
      <TabIcon name="menu" color={colors.text} />
    </Touch>
  )
}

function BellButton(): React.JSX.Element {
  const { t } = useTranslation()
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>()
  return (
    <Touch
      onPress={() => navigation.navigate('Notifications')}
      feedback="link"
      hitSlop={space.md}
      label={t('notifications.title')}
      style={styles.headerButton}>
      <TabIcon name="bell" color={colors.text} />
    </Touch>
  )
}

type TabIconArgs = { focused: boolean; color: string; size: number }
const renderLogo = (): React.JSX.Element => <Logo />
const renderMenuButton = (): React.JSX.Element => <MenuButton />
const renderBellButton = (): React.JSX.Element => <BellButton />
const renderHistoryIcon = ({ color }: TabIconArgs): React.JSX.Element => (
  <TabIcon name="history" color={color} />
)
const renderHomeIcon = ({ color }: TabIconArgs): React.JSX.Element => (
  <TabIcon name="home" color={color} />
)
const renderBuyIcon = ({ color }: TabIconArgs): React.JSX.Element => (
  <TabIcon name="cart" color={color} />
)

// The library's tab bar is UIKit's 49pt above the bottom inset, sized for labels at their own size.
const TAB_BAR = 49

// The tab bar's height for the text size. Android scales the labels with it, so the bar grows by the
// labels' extra leading and they never reach the gesture bar; iOS draws them at their own size and
// shows them large on a long press, as UIKit does, so the bar keeps its height there.
export function tabBarHeight(bottomInset: number, fontScale: number, os: string): number {
  const growth = os === 'ios' ? 0 : Math.ceil(font.leading.xs * Math.max(0, fontScale - 1))
  return TAB_BAR + growth + bottomInset
}

export function HomeTabs(): React.JSX.Element {
  const { t } = useTranslation()
  // The wallet's accent, from the one place that decides it, so the chrome outside every screen
  // follows the same colour the screens do.
  const { accent } = useAccent()
  const insets = useSafeAreaInsets()
  const { fontScale } = useWindowDimensions()
  const height = tabBarHeight(insets.bottom, fontScale, Platform.OS)

  return (
    <Tab.Navigator
      initialRouteName="Home"
      // Back from Buy or History returns to Home, and back on Home leaves. The default goes to the
      // first declared tab, which is History, so back on Home would open History.
      backBehavior="initialRoute"
      screenOptions={{
        headerStyle: styles.header,
        headerShadowVisible: false,
        headerTitleAlign: 'center',
        headerTitle: renderLogo,
        headerLeft: renderMenuButton,
        headerRight: renderBellButton,
        tabBarStyle: [styles.tabBar, { height }],
        tabBarActiveTintColor: accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarLabelStyle: styles.tabLabel,
      }}>
      <Tab.Screen
        name="History"
        component={HistoryScreen}
        options={{ title: t('nav.history'), tabBarIcon: renderHistoryIcon }}
      />
      <Tab.Screen
        name="Home"
        component={HomeScreen}
        options={{ title: t('nav.home'), tabBarIcon: renderHomeIcon }}
      />
      <Tab.Screen
        name="Buy"
        component={BuyScreen}
        options={{ title: t('nav.buy'), tabBarIcon: renderBuyIcon }}
      />
    </Tab.Navigator>
  )
}

const styles = StyleSheet.create({
  header: {
    backgroundColor: colors.background,
  },
  // On the content's gutter, so the two header marks line up with what sits under them.
  headerButton: {
    paddingHorizontal: space.xl,
  },
  // On the plain ground, never over content, where the glass fallback nearly vanishes, so the bar
  // takes the cards' fill. Home's price band sits on it with the same fill (PriceStrip), so the two
  // read as one block; the library's Android elevation would cast its shadow across that seam, and
  // its top hairline would draw a line there in any navigation theme whose border is not transparent.
  tabBar: {
    backgroundColor: colors.surface,
    elevation: 0,
    ...noTopEdge,
  },
  tabLabel: {
    ...font.family.medium,
    fontSize: font.size.xs,
  },
})
