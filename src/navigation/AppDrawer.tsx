import React from 'react'
import { useTranslation } from 'react-i18next'
import {
  createDrawerNavigator,
  type DrawerContentComponentProps,
} from '@react-navigation/drawer'
import { HomeTabs } from './HomeTabs'
import { DrawerContent } from './DrawerContent'
import { colors } from '../theme'

const Drawer = createDrawerNavigator()

// Module scope so eslint doesn't see a new component on every render.
const renderDrawerContent = (props: DrawerContentComponentProps): React.JSX.Element => (
  <DrawerContent {...props} />
)

// The header (hamburger/logo/bell) lives in the tabs, so the drawer itself shows none.
export function AppDrawer(): React.JSX.Element {
  const { t } = useTranslation()
  return (
    <Drawer.Navigator
      drawerContent={renderDrawerContent}
      screenOptions={{
        headerShown: false,
        drawerType: 'front',
        overlayColor: colors.scrim,
        // The library's own label is an English string, so the overlay is named in the app language.
        overlayAccessibilityLabel: t('common.close'),
        drawerStyle: { backgroundColor: colors.background, width: '85%' },
      }}>
      <Drawer.Screen name="Tabs" component={HomeTabs} />
    </Drawer.Navigator>
  )
}
