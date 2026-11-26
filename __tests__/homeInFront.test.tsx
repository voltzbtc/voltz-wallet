import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { View } from 'react-native'
import {
  DrawerActions,
  DrawerRouter,
  NavigationContainer,
  createNavigationContainerRef,
  createNavigatorFactory,
  useNavigationBuilder,
  type ParamListBase,
} from '@react-navigation/native'
import { createNativeStackNavigator } from '@react-navigation/native-stack'
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs'
import { backToHomeTab } from '../src/navigation/backToHomeTab'
import { homeInFront } from '../src/navigation/homeInFront'

// The drawer package is replaced under Jest (jest.setup.js), since its views run worklets. This
// navigator keeps the drawer's real router, and so its real state and status, and draws only the
// focused screen.
function RouterOnlyDrawer(props: Parameters<typeof useNavigationBuilder>[1]): React.JSX.Element {
  const { state, descriptors, NavigationContent } = useNavigationBuilder(DrawerRouter, props)
  return <NavigationContent>{descriptors[state.routes[state.index].key].render()}</NavigationContent>
}

// The app's shape: a root stack whose Main holds a drawer, whose Tabs hold History and Home, with
// Receive and Send pushed over Main.
const Stack = createNativeStackNavigator()
const Drawer = createNavigatorFactory(RouterOnlyDrawer)()
const Tab = createBottomTabNavigator()

const Blank = (): React.JSX.Element => <View />

function Tabs(): React.JSX.Element {
  return (
    <Tab.Navigator initialRouteName="Home">
      <Tab.Screen name="History" component={Blank} />
      <Tab.Screen name="Home" component={Blank} />
    </Tab.Navigator>
  )
}

function Main(): React.JSX.Element {
  return (
    <Drawer.Navigator>
      <Drawer.Screen name="Tabs" component={Tabs} />
    </Drawer.Navigator>
  )
}

type Ref = ReturnType<typeof createNavigationContainerRef<ParamListBase>>

async function mount(): Promise<Ref> {
  const ref = createNavigationContainerRef<ParamListBase>()
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(
      <NavigationContainer ref={ref}>
        <Stack.Navigator>
          <Stack.Screen name="Main" component={Main} />
          <Stack.Screen name="Receive" component={Blank} />
          <Stack.Screen name="Send" component={Blank} />
        </Stack.Navigator>
      </NavigationContainer>,
    )
  })
  return ref
}

const front = (ref: Ref): boolean => homeInFront(ref.getRootState() as Parameters<typeof homeInFront>[0])

test('Home on top of Main counts as in front', async () => {
  const ref = await mount()
  expect(front(ref)).toBe(true)
})

test('a pushed screen, another tab or an open drawer does not', async () => {
  const ref = await mount()

  await ReactTestRenderer.act(async () => {
    ref.navigate('Send')
  })
  expect(front(ref)).toBe(false)

  await ReactTestRenderer.act(async () => {
    ref.dispatch(backToHomeTab())
    ref.navigate('Main', { screen: 'Tabs', params: { screen: 'History' } })
  })
  expect(front(ref)).toBe(false)

  await ReactTestRenderer.act(async () => {
    ref.navigate('Main', { screen: 'Tabs', params: { screen: 'Home' } })
  })
  expect(front(ref)).toBe(true)

  await ReactTestRenderer.act(async () => {
    ref.dispatch(DrawerActions.openDrawer())
  })
  expect(front(ref)).toBe(false)

  await ReactTestRenderer.act(async () => {
    ref.dispatch(DrawerActions.closeDrawer())
  })
  expect(front(ref)).toBe(true)
})

// The overlay's close leaves Receive for Home and is decided in the commit after it, which reads the
// state the leave dispatched before any render.
test('the leave from Receive puts Home in front as soon as it is dispatched', async () => {
  const ref = await mount()
  await ReactTestRenderer.act(async () => {
    ref.navigate('Receive')
  })
  expect(front(ref)).toBe(false)

  let rightAfter: boolean | null = null
  await ReactTestRenderer.act(async () => {
    ref.dispatch(backToHomeTab())
    rightAfter = front(ref)
  })
  expect(rightAfter).toBe(true)
})

test('a state not yet built is not Home in front', () => {
  expect(homeInFront(undefined)).toBe(false)
  expect(homeInFront({ index: 0, routes: [{ name: 'Main' }] })).toBe(false)
  expect(homeInFront({ index: 0, routes: [{ name: 'Receive' }] })).toBe(false)
})
