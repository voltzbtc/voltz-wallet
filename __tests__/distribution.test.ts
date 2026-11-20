import { distributionFor, getDistribution } from '../src/config'

declare const global: { __DEV__: boolean }

const dev = global.__DEV__

afterEach(() => {
  global.__DEV__ = dev
})

test('a development build set to direct sells in sats', () => {
  expect(distributionFor('direct', true)).toBe('direct')
})

test('a release build sells through the store whatever its .env says', () => {
  expect(distributionFor('direct', false)).toBe('store')
  global.__DEV__ = false
  expect(getDistribution()).toBe('store')
})

test.each([undefined, '', 'store', 'Direct', ' direct', 'direct ', 'sats'])(
  'a development build with %p sells through the store',
  value => {
    expect(distributionFor(value, true)).toBe('store')
  },
)
