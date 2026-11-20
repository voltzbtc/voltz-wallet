// react-freeze suspends every hidden screen on one shared thenable, and React 19 retries three or more
// such boundaries in a loop (react/react#37556), about 150 commits a second with no update
// scheduled, which starves every JS timer and holds the success overlay up for tens of seconds.
jest.mock('react-native-screens', () => ({ enableFreeze: jest.fn() }))
jest.mock('../App', () => () => null)

test('the entry leaves screen freezing off', () => {
  const { AppRegistry } = require('react-native')
  const register = jest.spyOn(AppRegistry, 'registerComponent').mockImplementation(() => 'VoltzWallet')
  require('../index')
  // The entry ran, or a freeze call it never reached would pass unseen.
  expect(register).toHaveBeenCalledTimes(1)
  // enableFreeze() with no argument turns freezing on.
  const { enableFreeze } = require('react-native-screens')
  for (const call of enableFreeze.mock.calls) {
    expect(call[0]).toBe(false)
  }
})
