import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Jest cannot run the activity, but it can read it. Comments name what the code must not do, so
// only code is searched, and the check first finds the onCreate it is about, so a moved file or a
// renamed method fails instead of passing on an empty match.
const source = readFileSync(
  join(__dirname, '..', 'android/app/src/main/java/app/usevoltz/MainActivity.kt'),
  'utf8',
)
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

// react-native-screens throws when the system restores its fragments, which a per-app language
// change and a return to an app killed in the background both do. The activity hands its parent no
// saved state, so the screens are drawn again from JS.
test('the activity never hands its saved state to the fragments', () => {
  const onCreate = /override fun onCreate\(savedInstanceState: Bundle\?\) \{([\s\S]*?)\n {2}\}/.exec(code)?.[1]
  expect(onCreate).toBeDefined()
  expect(onCreate).toMatch(/super\.onCreate\(null\)/)
  expect(onCreate).not.toMatch(/super\.onCreate\(savedInstanceState\)/)
  expect(onCreate).toMatch(/FLAG_SECURE/)
})
