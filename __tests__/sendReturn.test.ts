import { StackActions, StackRouter } from '@react-navigation/routers'

// The real router, because this is where a finished send lands, and a double of popTo would only
// repeat what the test assumes about it.
const routeNames = ['Main', 'AssetDetail', 'Send', 'Contacts', 'Scan', 'Redeem']

function stack(...names: string[]) {
  return {
    stale: false as const,
    type: 'stack' as const,
    key: 'root',
    index: names.length - 1,
    routeNames,
    preloadedRoutes: [],
    routes: names.map(name => ({ key: `${name}-key`, name, params: undefined })),
  }
}

function popToSend(names: string[]): string[] {
  const router = StackRouter({})
  const next = router.getStateForAction(
    stack(...names),
    StackActions.popTo('Send', { destination: 'alice@breez.tips', picked: 1 }),
    { routeNames, routeParamList: {}, routeGetIdList: {} },
  )
  if (!next || next.stale) {
    throw new Error('router refused')
  }
  return next.routes.map(route => route.name)
}

describe('a destination chosen on the way to a send', () => {
  test('from Contacts goes back to the Send that opened it', () => {
    expect(popToSend(['Main', 'Send', 'Contacts'])).toEqual(['Main', 'Send'])
  })

  test('from the camera over Send leaves one Send', () => {
    expect(popToSend(['Main', 'Send', 'Scan'])).toEqual(['Main', 'Send'])
  })

  test('from the camera over Home takes its place', () => {
    expect(popToSend(['Main', 'Scan'])).toEqual(['Main', 'Send'])
  })

  test('from the camera over an asset takes its place, so back lands on the asset', () => {
    expect(popToSend(['Main', 'AssetDetail', 'Scan'])).toEqual(['Main', 'AssetDetail', 'Send'])
  })
})
