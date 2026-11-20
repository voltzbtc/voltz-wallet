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
