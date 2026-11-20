import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'

// iOS offers to save the text of a secure field it takes for a password once the field leaves the
// screen, and one tap on Save moves a BIP39 passphrase into Passwords and from there to iCloud
// Keychain. A field typed as a one-time code is not offered, which was measured on iOS 26.5, where
// `textContentType="none"`, `autoComplete="off"` and `importantForAutofill="no"` still were. The
// sources are read here so that a secure field added anywhere in src meets the rule too.

const ROOT = join(__dirname, '..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) {
      return sources(path)
    }
    return /\.(ts|tsx)$/.test(name) ? [path] : []
  })
}

const count = (text: string, needle: string): number => text.split(needle).length - 1

const secure = sources(join(ROOT, 'src'))
  .filter(path => readFileSync(path, 'utf8').includes('secureTextEntry'))
  .map(path => relative(ROOT, path))
  .sort()

test('the secure fields in src are the two passphrase fields', () => {
  expect(secure).toEqual(['src/components/PassphraseField.tsx', 'src/screens/ImportScreen.tsx'])
})

test.each(secure)('every secure field in %s is typed as a one-time code', file => {
  const text = readFileSync(join(ROOT, file), 'utf8')
  const fields = count(text, 'secureTextEntry=')
  expect(fields).toBeGreaterThan(0)
  expect(count(text, 'textContentType="oneTimeCode"')).toBe(fields)
})

// A revealed field is no longer a password field, and an Android IME learns from what is typed in
// it unless the field is the visible-password variation. Gboard and SwiftKey keep learned words and
// offer them in other apps, and SwiftKey syncs them to its cloud.
test.each(secure)('every secure field in %s takes the visible-password keyboard when revealed', file => {
  const text = readFileSync(join(ROOT, file), 'utf8')
  expect(count(text, 'keyboardType={revealedKeyboard(reveal)}')).toBe(count(text, 'secureTextEntry='))
})

describe('the keyboard a passphrase field takes', () => {
  const { Platform } = require('react-native')
  const { revealedKeyboard } = require('../src/components/PassphraseField')
  const original = Platform.OS
  afterEach(() => {
    Platform.OS = original
  })

  test('on Android, revealed, is the visible-password variation', () => {
    Platform.OS = 'android'
    expect(revealedKeyboard(true)).toBe('visible-password')
    expect(revealedKeyboard(false)).toBe('default')
  })

  test('on iOS is the default, where the variation does not exist', () => {
    Platform.OS = 'ios'
    expect(revealedKeyboard(true)).toBe('default')
  })
})

test('the passphrase field passes the revealed keyboard to its input when the eye is pressed', () => {
  const React = require('react')
  const ReactTestRenderer = require('react-test-renderer')
  const { Platform, TextInput } = require('react-native')
  const { PassphraseField } = require('../src/components/PassphraseField')
  require('../src/i18n')
  const original = Platform.OS
  Platform.OS = 'android'
  try {
    let tree: any
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(React.createElement(PassphraseField, { value: '', onChangeText: () => undefined }))
    })
    const input = () => tree.root.findAllByType(TextInput)[0]
    expect(input().props.keyboardType).toBe('default')
    expect(input().props.secureTextEntry).toBe(true)
    const eye = tree.root.findAll((n: any) => typeof n.props.onPress === 'function')[0]
    ReactTestRenderer.act(() => eye.props.onPress())
    expect(input().props.secureTextEntry).toBe(false)
    expect(input().props.keyboardType).toBe('visible-password')
  } finally {
    Platform.OS = original
  }
})
