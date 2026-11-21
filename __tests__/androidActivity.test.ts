import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const ROOT = join(__dirname, '..')
const strip = (text: string): string => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')

// Jest cannot run the activity, but it can read it. Comments name what the code must not do, so
// only code is searched, and the check first finds the onCreate it is about, so a moved file or a
// renamed method fails instead of passing on an empty match.
const code = strip(readFileSync(join(ROOT, 'android/app/src/main/java/app/usevoltz/MainActivity.kt'), 'utf8'))
const onCreate = /override fun onCreate\(savedInstanceState: Bundle\?\) \{([\s\S]*?)\n {2}\}/.exec(code)?.[1]

// react-native-screens throws when the system restores its fragments, which a per-app language
// change and a return to an app killed in the background both do. The activity hands its parent no
// saved state, so the screens are drawn again from JS.
test('the activity never hands its saved state to the fragments', () => {
  expect(onCreate).toBeDefined()
  expect(onCreate).toMatch(/super\.onCreate\(null\)/)
  expect(onCreate).not.toMatch(/super\.onCreate\(savedInstanceState\)/)
  expect(onCreate).toMatch(/FLAG_SECURE/)
})

// FLAG_SECURE stops a capture, not an accessibility service reading the text. From Android 14 the
// decor's mark, which every view of the window inherits, leaves the words and the passphrase to the
// services declared as accessibility tools.
test('the window is accessibility data sensitive from Android 14', () => {
  expect(onCreate).toMatch(
    /if \(Build\.VERSION\.SDK_INT >= Build\.VERSION_CODES\.UPSIDE_DOWN_CAKE\) \{\s*window\.decorView\.setAccessibilityDataSensitive\(View\.ACCESSIBILITY_DATA_SENSITIVE_YES\)\s*\}/,
  )
})

// The mark is the activity window's, and a React Native Modal is a window of its own, so the modules
// that draw the recovery words or a passphrase open none, and the modules that open one import none of
// them and draw no secure field. Imports are read one level deep.
const SRC = join(ROOT, 'src')
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory()
      ? sources(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  )
const files = new Map(sources(SRC).map(file => [file, strip(readFileSync(file, 'utf8'))]))
const imports = (file: string): string[] =>
  [...files.get(file)!.matchAll(/from '(\.{1,2}\/[^']+)'/g)]
    .map(match => resolve(dirname(file), match[1]))
    .flatMap(base => [`${base}.tsx`, `${base}.ts`].filter(candidate => files.has(candidate)))
const name = (file: string): string => relative(SRC, file).replace(/\.tsx?$/, '')
const drawsModal = (file: string): boolean => files.get(file)!.includes('<Modal')
const opensModal = (file: string): boolean => drawsModal(file) || imports(file).some(drawsModal)
const WORDS = [
  'components/SeedWordGrid',
  'components/PassphraseField',
  'screens/AddWalletScreen',
  'screens/BackupScreen',
  'screens/VerifyBackupScreen',
  'screens/RecoveryPhraseScreen',
  'screens/PassphraseScreen',
  'screens/ImportScreen',
  'screens/PasskeyWordsScreen',
]

test('no Modal window draws the recovery words or a passphrase', () => {
  const words = [...files.keys()].filter(file => WORDS.includes(name(file)))
  expect(words.map(name).sort()).toEqual([...WORDS].sort())
  const openers = [...files.keys()].filter(opensModal)
  expect(openers.map(name)).toContain('components/Sheet')
  for (const file of words) {
    expect([name(file), opensModal(file)]).toEqual([name(file), false])
    expect([name(file), imports(file).filter(opensModal).map(name)]).toEqual([name(file), []])
  }
  for (const file of openers) {
    expect([name(file), imports(file).filter(dep => WORDS.includes(name(dep))).map(name)]).toEqual([name(file), []])
    expect([name(file), files.get(file)!.includes('secureTextEntry')]).toEqual([name(file), false])
  }
})

// An empty affinity leaves the task nothing another app's activity can match, and singleTask still
// finds the one activity by its component, so a lightning: link reaches the running app.
test('the one activity has no task affinity and keeps singleTask and its lightning: filter', () => {
  // A comment ends at its first `-->`; splitting on the markers drops each one whole, so a commented
  // activity neither counts nor hides the real one.
  const manifest = readFileSync(join(ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8')
    .split('<!--')
    .map((part, index) => {
      if (index === 0) return part
      const end = part.indexOf('-->')
      return end < 0 ? '' : part.slice(end + 3)
    })
    .join('')
  const activities = [...manifest.matchAll(/<activity\b([\s\S]*?)<\/activity>/g)].map(match => match[1])
  expect(activities).toHaveLength(1)
  const [main] = activities
  expect(main).toMatch(/android:name="\.MainActivity"/)
  expect(main).toMatch(/android:launchMode="singleTask"/)
  expect(main).toMatch(/android:taskAffinity=""/)
  expect(main).toMatch(/<data android:scheme="lightning" \/>/)
})
