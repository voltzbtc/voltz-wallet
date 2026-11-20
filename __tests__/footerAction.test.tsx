import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Keyboard, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { FooterAction, Screen } from '../src/components/Screen'
import { ImportScreen } from '../src/screens/ImportScreen'
import { AddAssetScreen } from '../src/screens/AddAssetScreen'
import { sparkResolveToken } from '../src/wallet/spark'
import { loadHomeTokens, mergeCatalog } from '../src/wallet/tokenPrefs'

// A concealed call to action keeps its box with the keyboard down, so nothing moves when it turns
// on, and gives the box back while the keyboard is up, where the empty band would cover the content
// above the keyboard.

jest.mock('../src/wallet/spark', () => ({ sparkResolveToken: jest.fn(), sparkGetTokenBalances: jest.fn(async () => []) }))
jest.mock('../src/wallet/tokenPrefs', () => ({
  ...jest.requireActual('../src/wallet/tokenPrefs'),
  addToken: jest.fn(),
  loadHomeTokens: jest.fn(),
}))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: jest.fn(), navigate: jest.fn() }),
  useRoute: () => ({ params: undefined }),
}))

// Every listener, per event, since the screen itself listens for the keyboard as well.
let handlers: Map<string, Set<() => void>>
let visible = false

beforeEach(async () => {
  handlers = new Map()
  visible = false
  jest.spyOn(Keyboard, 'isVisible').mockImplementation(() => visible)
  jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, handler: () => void) => {
    const set = handlers.get(event) ?? new Set()
    set.add(handler)
    handlers.set(event, set)
    return { remove: () => set.delete(handler) }
  }) as unknown as typeof Keyboard.addListener)
  jest.mocked(loadHomeTokens).mockResolvedValue({ catalog: mergeCatalog([]), hidden: [] })
  jest.mocked(sparkResolveToken).mockRejectedValue(new Error('not found'))
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  await i18n.changeLanguage('pt-BR')
})

function keyboard(event: 'keyboardDidShow' | 'keyboardDidHide'): void {
  ReactTestRenderer.act(() => {
    visible = event === 'keyboardDidShow'
    handlers.get(event)?.forEach(handler => handler())
  })
}

const texts = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
  tree.root.findAllByType(Text).flatMap(n => [n.props.children].flat().filter(x => typeof x === 'string'))

async function mount(element: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
  return tree
}

describe('a footer action', () => {
  const screen = (concealed: boolean) => (
    <Screen
      keyboard
      footer={
        <FooterAction concealed={concealed}>
          <Text>ACTION</Text>
        </FooterAction>
      }>
      <Text>BODY</Text>
    </Screen>
  )

  it('keeps a concealed action with the keyboard down, drops it while it is up, and brings it back', async () => {
    const tree = await mount(screen(true))
    expect(texts(tree)).toContain('ACTION')
    keyboard('keyboardDidShow')
    expect(texts(tree)).not.toContain('ACTION')
    keyboard('keyboardDidHide')
    expect(texts(tree)).toContain('ACTION')
  })

  it('starts without it when the keyboard is already up as the screen opens', async () => {
    visible = true
    const tree = await mount(screen(true))
    expect(texts(tree)).not.toContain('ACTION')
  })

  it('never drops an action that can act', async () => {
    const tree = await mount(screen(false))
    keyboard('keyboardDidShow')
    expect(texts(tree)).toContain('ACTION')
  })
})

it('Import has no restore until the words are in, keyboard up or down, and keeps the suggestions', async () => {
  const tree = await mount(<ImportScreen onImported={() => undefined} />)
  const cell = tree.root.findAllByType(TextInput)[0]!
  ReactTestRenderer.act(() => cell.props.onFocus?.({}))
  keyboard('keyboardDidShow')
  ReactTestRenderer.act(() => cell.props.onChangeText('aban'))

  expect(texts(tree)).toContain('abandon')
  expect(texts(tree)).not.toContain(i18n.t('import.restore'))
  keyboard('keyboardDidHide')
  expect(texts(tree)).not.toContain(i18n.t('import.restore'))
})

it('Add asset drops the hidden add button while the keyboard is up', async () => {
  const tree = await mount(<AddAssetScreen />)
  expect(texts(tree)).toContain(i18n.t('addAsset.add'))
  keyboard('keyboardDidShow')
  expect(texts(tree)).not.toContain(i18n.t('addAsset.add'))
  // Paste and Scan, which sit right above the keyboard, stay in sight.
  expect(texts(tree).join(' ')).toContain(i18n.t('addAsset.paste'))
})
