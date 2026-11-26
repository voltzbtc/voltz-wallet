import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Field } from '../src/components/Field'
import i18n from '../src/i18n'
import { LanguageScreen } from '../src/screens/LanguageScreen'

jest.mock('../src/wallet/settings', () => ({
  saveDisplayLanguage: jest.fn(async () => undefined),
  loadDirectionRestart: jest.fn(async () => null),
  saveDirectionRestart: jest.fn(async () => undefined),
  clearDirectionRestart: jest.fn(async () => undefined),
}))
jest.mock('../src/hooks/useTransitionDone', () => ({ useTransitionDone: () => true }))

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
})

async function open(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LanguageScreen />)
  })
  return tree
}

// The tree as drawn: each host node's type, its children and the props that are plain data. A host
// can carry a React element or a function in its props (the list hands its whole configuration to the
// scroll view), which pretty-format cannot print, and what they render is in the children anyway.
type Drawn = string | { type: string; props: Record<string, unknown>; children: Drawn[] | null }
const isPlain = (value: unknown): boolean =>
  value === null ||
  ['string', 'number', 'boolean', 'undefined'].includes(typeof value) ||
  (Array.isArray(value) && value.every(isPlain)) ||
  (typeof value === 'object' && !('$$typeof' in value) && Object.values(value).every(isPlain))
function drawn(node: ReactTestRenderer.ReactTestRendererNode): Drawn {
  if (typeof node === 'string') {
    return node
  }
  return {
    type: node.type,
    props: Object.fromEntries(Object.entries(node.props).filter(([, value]) => isPlain(value))),
    children: node.children?.map(drawn) ?? null,
  }
}
const drawnTree = (renderer: ReactTestRenderer.ReactTestRenderer) => {
  const json = renderer.toJSON()
  return (Array.isArray(json) ? json : json ? [json] : []).map(drawn)
}

async function search(tree: ReactTestRenderer.ReactTestRenderer, query: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(Field).props.onChangeText(query)
  })
}

// Recorded from the picker as it was before any credit existed, so a list with no reviewer has to
// draw that same tree, on arrival and after a search that finds nothing.
describe('with no reviewer listed, the picker draws what it drew before credits', () => {
  test('on arrival', async () => {
    expect(drawnTree(await open())).toMatchSnapshot()
  })

  test('after a search that finds one language', async () => {
    const screen = await open()
    await search(screen, 'deutsch')
    expect(drawnTree(screen)).toMatchSnapshot()
  })

  test('after a search that finds nothing', async () => {
    const screen = await open()
    await search(screen, 'zzz')
    expect(drawnTree(screen)).toMatchSnapshot()
  })
})
