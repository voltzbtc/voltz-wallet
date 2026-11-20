import { readFileSync } from 'fs'
import { join } from 'path'

// Reanimated returns an animated view's resting value to React from a JS timer, and until it does
// React keeps the view's first-render style. Releases before 4.5.3 discard that value two seconds
// after the last frame whether or not React has it, so a JS thread busy through that window, as at a
// cold start, leaves the drawer drawn closed at the next commit while its status stays open. Back
// then does nothing and TalkBack cannot reach Home (software-mansion/react-native-reanimated#9527).
// The fix is native, so the suite holds the version the lockfile installs.

const FIXED_IN = '4.5.3'

function atLeast(version: string, floor: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    return false
  }
  const a = version.split('.').map(Number)
  const b = floor.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) {
      return a[i] > b[i]
    }
  }
  return true
}

test(`the lockfile pins react-native-reanimated ${FIXED_IN} or later`, () => {
  const lock = JSON.parse(readFileSync(join(__dirname, '..', 'package-lock.json'), 'utf8'))
  const version: string = lock.packages['node_modules/react-native-reanimated'].version
  expect(atLeast(version, FIXED_IN)).toBe(true)
})

// The comparison is numeric per part, and a prerelease or malformed version is refused rather than
// waved through.
test('the version check refuses the releases without the fix', () => {
  expect(atLeast('4.5.2', FIXED_IN)).toBe(false)
  expect(atLeast('4.4.9', FIXED_IN)).toBe(false)
  expect(atLeast('3.19.0', FIXED_IN)).toBe(false)
  expect(atLeast('4.6.0-rc.1', FIXED_IN)).toBe(false)
  expect(atLeast('4.5', FIXED_IN)).toBe(false)
  expect(atLeast('4.5.3', FIXED_IN)).toBe(true)
  expect(atLeast('4.5.10', FIXED_IN)).toBe(true)
  expect(atLeast('4.10.0', FIXED_IN)).toBe(true)
  expect(atLeast('5.0.0', FIXED_IN)).toBe(true)
})
