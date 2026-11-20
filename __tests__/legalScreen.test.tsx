import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking } from 'react-native'
import i18n from '../src/i18n'
import { LegalScreen } from '../src/screens/LegalScreen'
import { MenuRow } from '../src/components/MenuRow'
import { siteUrl } from './support/sitePages'

const DIR = path.join(__dirname, '..', 'src', 'i18n', 'locales')
const CODES = fs
  .readdirSync(DIR)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''))

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LegalScreen />)
  })
  return tree
}

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<string[][]> {
  const row = tree.root.findAllByType(MenuRow).find(node => node.props.label === label)
  if (!row) {
    throw new Error(`no row labelled ${label}`)
  }
  jest.mocked(Linking.openURL).mockClear()
  await ReactTestRenderer.act(async () => {
    row.props.onPress()
  })
  return jest.mocked(Linking.openURL).mock.calls
}

beforeEach(() => {
  jest.restoreAllMocks()
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

afterAll(async () => {
  await i18n.changeLanguage('en-US')
})

test('the screen lists the terms of use, then the privacy policy', async () => {
  await i18n.changeLanguage('en-US')
  const tree = await render()
  expect(tree.root.findAllByType(MenuRow).map(row => row.props.label)).toEqual([
    'Terms of use',
    'Privacy policy',
  ])
})

test.each(CODES)('%s opens the terms and the privacy policy in its own language', async code => {
  await i18n.changeLanguage(code)
  const tree = await render()
  expect(await press(tree, i18n.t('legal.terms'))).toEqual([[siteUrl(code, 'terms')]])
  expect(await press(tree, i18n.t('legal.privacy'))).toEqual([[siteUrl(code, 'privacy')]])
  ReactTestRenderer.act(() => tree.unmount())
})
