import { StackActions } from '@react-navigation/native'

// The Main already in the stack, on its Home tab, with whatever covers it gone.
export const backToHomeTab = () =>
  StackActions.popTo('Main', { screen: 'Tabs', params: { screen: 'Home' } })
