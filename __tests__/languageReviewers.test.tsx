import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking } from 'react-native'
import { Field } from '../src/components/Field'
import { MenuRow } from '../src/components/MenuRow'
import { Touch } from '../src/components/Touch'
import i18n from '../src/i18n'
import type { Reviewer } from '../src/i18n/reviewers'
import { LanguageScreen } from '../src/screens/LanguageScreen'
import { handledRefusal } from './support/handledRefusal'

jest.mock('../src/wallet/settings', () => ({
  saveDisplayLanguage: jest.fn(async () => undefined),
  loadDirectionRestart: jest.fn(async () => null),
  saveDirectionRestart: jest.fn(async () => undefined),
  clearDirectionRestart: jest.fn(async () => undefined),
}))
jest.mock('../src/hooks/useTransitionDone', () => ({ useTransitionDone: () => true }))

// Only the list is replaced, so the screen reads it through the real `credits` and `reviewerLink`.
let mockReviewers: Record<string, Reviewer[]> = {}
jest.mock('../src/i18n/reviewers', () => {
  const actual = jest.requireActual('../src/i18n/reviewers')
  return {
    ...actual,
    get REVIEWERS() {
      return mockReviewers
    },
  }
})

beforeEach(async () => {
  // The preset's Linking.openURL is a jest.fn, which spyOn hands back as it is, calls included.
  jest.clearAllMocks()
  mockReviewers = {}
  await i18n.changeLanguage('en-US')
})

afterEach(() => {
  jest.restoreAllMocks()
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

// The credits section, or null when the list draws none.
function creditSection(screen: ReactTestRenderer.ReactTestRenderer) {
  const found = screen.root.findAll(n => n.props.testID === 'reviewer-credits' && typeof n.type !== 'string')
  return found[0] ?? null
}
const creditRows = (screen: ReactTestRenderer.ReactTestRenderer) =>
  creditSection(screen)?.findAllByType(MenuRow).map(row => row.props) ?? null

const ANA: Reviewer = { name: 'Ana Weber' }
const SOMCHAI: Reviewer = { name: 'somchai', link: 'https://github.com/somchai' }
const LAYLA: Reviewer = { name: 'Layla', link: 'https://x.com/layla' }

describe('who the credits name', () => {
  test('exactly the people listed, each beside the language they reviewed, in the order of the list', async () => {
    mockReviewers = { th: [SOMCHAI], de: [ANA], ar: [LAYLA] }
    const rows = creditRows(await open())
    // The picker sorts by endonym, which puts Deutsch before العربية and ไทย.
    expect(rows?.map(row => [row.label, row.value])).toEqual([
      ['Ana Weber', 'Deutsch'],
      ['Layla', 'العربية'],
      ['somchai', 'ไทย'],
    ])
    expect(rows?.map(row => row.divider)).toEqual([true, true, false])
  })

  test('under the section title, in the language shown', async () => {
    mockReviewers = { de: [ANA] }
    await i18n.changeLanguage('pt-BR')
    const texts = creditSection(await open())
      ?.findAll(n => typeof n.type === 'string')
      .flatMap(n => (typeof n.props.children === 'string' ? [n.props.children] : []))
    expect(texts).toEqual(['Revisores das traduções', 'Ana Weber', 'Deutsch'])
  })

  test('nobody for a code the picker does not list, and no section with nobody to name', async () => {
    mockReviewers = { xx: [ANA], de: [] }
    expect(creditRows(await open())).toBeNull()
  })

  test('the reviewers of the languages a search leaves, and none when it leaves none of theirs', async () => {
    mockReviewers = { de: [ANA], th: [SOMCHAI] }
    const screen = await open()
    await search(screen, 'deutsch')
    expect(creditRows(screen)?.map(row => row.label)).toEqual(['Ana Weber'])
    await search(screen, 'english')
    expect(creditRows(screen)).toBeNull()
  })

  // The list is the record of who agreed to be named, so the rule sits on it, where the next entry
  // is written.
  test("the list says that an entry needs the person's consent in writing", () => {
    const lines = fs.readFileSync(path.join(__dirname, '..', 'src', 'i18n', 'reviewers.ts'), 'utf8').split('\n')
    const at = lines.findIndex(line => line.startsWith('export const REVIEWERS'))
    expect(at).toBeGreaterThan(0)
    let start = at
    while (start > 0 && lines[start - 1].startsWith('//')) {
      start -= 1
    }
    const comment = lines
      .slice(start, at)
      .map(line => line.replace(/^\/\/\s?/, ''))
      .join(' ')
    expect(comment).toMatch(/needs the person's consent in writing/)
  })
})

describe('what a name opens', () => {
  test('its profile on an allowed host, on a tap', async () => {
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    mockReviewers = { th: [SOMCHAI] }
    const rows = creditRows(await open()) ?? []
    expect(rows).toHaveLength(1)
    expect(opened).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => {
      rows[0].onPress()
    })
    expect(opened).toHaveBeenCalledTimes(1)
    expect(opened).toHaveBeenCalledWith('https://github.com/somchai')
  })

  test('a refused open is handled', async () => {
    const refusal = handledRefusal()
    jest.spyOn(Linking, 'openURL').mockReturnValue(refusal.answer as unknown as Promise<true>)
    mockReviewers = { th: [SOMCHAI] }
    const rows = creditRows(await open()) ?? []
    await ReactTestRenderer.act(async () => {
      rows[0].onPress()
    })
    expect(refusal.handled()).toBe(true)
  })

  test.each([
    ['http, not https', 'http://github.com/ana'],
    ['a host off the list', 'https://example.com/ana'],
    ['a host that only starts like one on the list', 'https://github.com.example.com/ana'],
    ['credentials ahead of another host', 'https://github.com@example.com/ana'],
    // eslint-disable-next-line no-script-url -- the point of the case is that this is refused
    ['another scheme', 'javascript:alert(1)'],
    ['no profile', 'https://github.com/'],
  ])('nothing to tap for %s', async (_, link) => {
    const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
    mockReviewers = { de: [{ name: 'Ana Weber', link }] }
    const screen = await open()
    const rows = creditRows(screen) ?? []
    expect(rows.map(row => row.label)).toEqual(['Ana Weber'])
    expect(rows[0].onPress).toBeUndefined()
    expect(creditSection(screen)?.findAllByType(Touch)).toEqual([])
    expect(opened).not.toHaveBeenCalled()
  })
})
