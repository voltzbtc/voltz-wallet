import { readFileSync } from 'fs'
import { join } from 'path'

// `pod install` writes REACT_NATIVE_PATH relative to where node_modules really sits. Run from a
// worktree whose node_modules links to the main checkout, it writes a path that climbs out of the
// repository, and the main checkout then builds against whatever is five directories up.
const PBXPROJ = join(__dirname, '..', 'ios', 'VoltzWallet.xcodeproj', 'project.pbxproj')

test('the Xcode project finds React Native in the checkout it lives in', () => {
  const paths = [...readFileSync(PBXPROJ, 'utf8').matchAll(/REACT_NATIVE_PATH = "([^"]*)";/g)].map(m => m[1])
  expect(paths.length).toBeGreaterThan(0)
  for (const path of paths) {
    expect(path).toBe('${PODS_ROOT}/../../node_modules/react-native')
  }
})
