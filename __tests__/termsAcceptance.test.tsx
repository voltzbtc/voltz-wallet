import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { I18nManager, Linking, Text } from 'react-native'
import RNFS from 'react-native-fs'
import App from '../App'
import i18n from '../src/i18n'
import { GradientButton } from '../src/components/GradientButton'
import { isRTL } from '../src/i18n/languages'
import { siteUrl } from './support/sitePages'

jest.mock('../src/navigation/RootNavigator', () => {
  const react = require('react')
  const { Text: RNText } = require('react-native')
  return { RootNavigator: () => react.createElement(RNText, null, 'NAVIGATOR') }
})

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const CODES = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''))

// The words a locale marks as each page's link, read from the file rather than through the parser
// under test.
const tagged = (code: string, page: 'terms' | 'privacy'): string => {
  const sentence: string = JSON.parse(fs.readFileSync(path.join(DIR, `${code}.json`), 'utf8')).welcome
    .terms
  const match = sentence.match(new RegExp(`<${page}>(.*?)</${page}>`))
  if (!match) {
    throw new Error(`${code} has no ${page} link`)
  }
  return match[1]
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

async function welcome(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0))
    })
  }
  return tree
}

const links = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAll(node => node.type === Text && node.props.accessibilityRole === 'link')

// The text a node draws, its nested runs included.
const drawn = (node: ReactTestRenderer.ReactTestInstance | string): string =>
  typeof node === 'string' ? node : node.children.map(drawn).join('')

test('the welcome, before any wallet, says continuing accepts the terms, with each page a link', async () => {
  await i18n.changeLanguage('en-US')
  const tree = await welcome()
  expect(tree.root.findByType(GradientButton).props.label).toBe('Create wallet')
  const line = tree.root
    .findAllByType(Text)
    .find(node => drawn(node).startsWith('By continuing'))
  expect(line && drawn(line)).toBe(
    'By continuing, you accept the Terms of use and acknowledge the Privacy policy.',
  )
  expect(links(tree).map(drawn)).toEqual(['Terms of use', 'Privacy policy'])
  expect(jest.mocked(Linking.openURL)).not.toHaveBeenCalled()
})

// An RTL language boots with the layout already mirrored, as after the restart that sets it, so the
// boot does not restart again before the welcome.
test.each(CODES)('%s opens each legal page in its own language from the welcome', async code => {
  jest.replaceProperty(I18nManager, 'isRTL', isRTL(code))
  await i18n.changeLanguage(code)
  const tree = await welcome()
  const shown = links(tree)
  expect(shown).toHaveLength(2)
  for (const page of ['terms', 'privacy'] as const) {
    const link = shown.find(node => drawn(node) === tagged(code, page))
    if (!link) {
      throw new Error(`${code}: no link drawn for ${page}`)
    }
    jest.mocked(Linking.openURL).mockClear()
    await ReactTestRenderer.act(async () => {
      link.props.onPress()
    })
    expect(jest.mocked(Linking.openURL).mock.calls).toEqual([[siteUrl(code, page)]])
  }
  ReactTestRenderer.act(() => tree.unmount())
})
