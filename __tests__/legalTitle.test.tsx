import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import i18n from '../src/i18n'
import { LegalScreen } from '../src/screens/LegalScreen'
import { MenuRow } from '../src/components/MenuRow'

// The Legal screen and its drawer row are both named by settings.legal, and the screen lists the
// terms of use and the privacy policy. A name that leaves one out sends somebody looking for it
// somewhere else.

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const LOCALES = fs.readdirSync(DIR).filter(f => f.endsWith('.json'))

type Locale = { settings: { legal: string }; legal: { privacy: string; terms: string } }
const read = (file: string): Locale => JSON.parse(fs.readFileSync(path.join(DIR, file), 'utf8'))

// Whether two names share a stretch of letters, so an inflected or shortened form ("Terms",
// "Términos", "規約") still matches the row it names. Scripts written without spaces carry a word in
// two characters, the others need four.
const DENSE = /[\p{Script=Han}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}]/u
function shares(name: string, row: string): boolean {
  const a = name.toLocaleLowerCase()
  const b = row.toLocaleLowerCase()
  const size = DENSE.test(a) ? 2 : 4
  for (let i = 0; i + size <= a.length; i++) {
    const piece = a.slice(i, i + size)
    if (/^[\p{L}\p{M}]+$/u.test(piece) && b.includes(piece)) {
      return true
    }
  }
  return false
}

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

test('the screen lists the terms and the privacy policy', async () => {
  await i18n.changeLanguage('en-US')
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<LegalScreen />)
  })
  expect(tree.root.findAllByType(MenuRow).map(row => row.props.label)).toEqual([
    i18n.t('legal.terms'),
    i18n.t('legal.privacy'),
  ])
  ReactTestRenderer.act(() => tree.unmount())
})

test.each(LOCALES)('%s names the screen for both the terms and privacy', file => {
  const { settings, legal } = read(file)
  expect(shares(settings.legal, legal.terms)).toBe(true)
  expect(shares(settings.legal, legal.privacy)).toBe(true)
})

// The check above has to be able to fail: a name for privacy alone shares nothing with the terms.
test('a name for one page alone does not pass for both', () => {
  expect(shares('Privacy', 'Terms of use')).toBe(false)
  expect(shares('プライバシー', '利用規約')).toBe(false)
  expect(shares('개인정보 보호', '이용약관')).toBe(false)
  expect(shares('Datenschutz', 'Nutzungsbedingungen')).toBe(false)
})
