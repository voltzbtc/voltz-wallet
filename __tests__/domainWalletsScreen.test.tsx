import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { DomainWalletsScreen } from '../src/screens/DomainWalletsScreen'
import { confirmQuestion } from './support/question'
import { Skeleton } from '../src/components/Skeleton'
import { MenuRow } from '../src/components/MenuRow'
import { changeDomainAccess, listDomainWallets, loadLabels } from '../src/wallet/domainAccess'

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: jest.fn() }),
    useRoute: () => ({ params: { domain: 'acme.com' } }),
    useFocusEffect: (cb: () => void) => react.useEffect(cb, [cb]),
  }
})
jest.mock('../src/wallet/domainAccess', () => ({
  ...jest.requireActual('../src/wallet/domainAccess'),
  changeDomainAccess: jest.fn(),
  listDomainWallets: jest.fn(),
  loadLabels: jest.fn(),
}))
jest.mock('../src/wallet/identitySigner', () => ({
  identitySigner: jest.fn(async () => ({ pubkey: '02' + 'a'.repeat(64), sign: async () => 'sig' })),
}))

const W1 = { pubkey: '02' + '1'.repeat(64), grantedAt: 1_760_000_000 }
const W2 = { pubkey: '03' + '2'.repeat(64), grantedAt: 1_760_000_100 }
type Wallets = Awaited<ReturnType<typeof listDomainWallets>>

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

let tree: ReactTestRenderer.ReactTestRenderer

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<DomainWalletsScreen />)
  })
  await settle()
}

const texts = (): string[] => tree.root.findAllByType(Text).map(node => String(node.props.children))
// The wallet names on screen. A loading row is a key row with no name yet, so it names nobody.
const labels = (): string[] =>
  tree.root
    .findAll(n => n.props.icon === 'key' && typeof n.props.label === 'string' && n.props.label !== '')
    .map(n => n.props.label)
const retry = () =>
  tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('common.retry')))

beforeEach(() => {
  jest.clearAllMocks()
  for (const fn of [changeDomainAccess, listDomainWallets, loadLabels]) {
    jest.mocked(fn).mockReset()
  }
  jest.mocked(loadLabels).mockResolvedValue({ [W1.pubkey]: 'Ana', [W2.pubkey]: 'Bruno' })
  jest.mocked(changeDomainAccess).mockResolvedValue(undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

// The list says who can create addresses on the owner's domain, so a list that could not be read is
// never drawn as one with nobody on it.
describe('a list that cannot be read', () => {
  test('says so in words, never as the gateway code or as "no wallets"', async () => {
    jest.mocked(listDomainWallets).mockRejectedValue(new Error('only_the_owner_may_list'))
    await render()

    expect(texts()).toContain(i18n.t('domain.errFailed'))
    expect(texts().join(' ')).not.toContain('only_the_owner_may_list')
    expect(texts()).not.toContain(i18n.t('domain.noWallets'))
    expect(retry()).toBeDefined()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  test('Try again shows the skeleton while it reads, then the list', async () => {
    let answer: ((list: Wallets) => void) | undefined
    jest
      .mocked(listDomainWallets)
      .mockRejectedValueOnce(new Error('timeout'))
      .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await render()

    await ReactTestRenderer.act(async () => {
      retry()!.props.onPress()
    })
    await settle()
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(texts()).not.toContain(i18n.t('domain.errFailed'))

    await ReactTestRenderer.act(async () => {
      answer?.([W1])
    })
    await settle()
    expect(labels()).toEqual(['Ana'])
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })

  // The list read before a revoke still holds the revoked wallet, so it is not what a retry shows.
  test('a retry after a failed read never shows the list read before it', async () => {
    let answer: ((list: Wallets) => void) | undefined
    jest
      .mocked(listDomainWallets)
      .mockResolvedValueOnce([W1, W2])
      .mockRejectedValueOnce(new Error('timeout'))
      .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await render()
    const [first] = tree.root.findAll(n => n.props.icon === 'key' && typeof n.props.onPress === 'function')
    await ReactTestRenderer.act(async () => {
      first.props.onPress()
    })
    await confirmQuestion(tree)
    await settle()
    expect(texts()).toContain(i18n.t('domain.errFailed'))
    expect(labels()).toEqual([])

    await ReactTestRenderer.act(async () => {
      retry()!.props.onPress()
    })
    await settle()
    expect(labels()).toEqual([])
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)

    await ReactTestRenderer.act(async () => {
      answer?.([W2])
    })
    await settle()
    expect(labels()).toEqual(['Bruno'])
  })

  test('an empty answer is the one that says only this wallet uses the domain', async () => {
    jest.mocked(listDomainWallets).mockResolvedValue([])
    await render()

    expect(texts()).toContain(i18n.t('domain.noWallets'))
    expect(texts()).not.toContain(i18n.t('domain.errFailed'))
  })
})

test('only the last read started lands, so an earlier answer cannot bring back a revoked wallet', async () => {
  let afterFirst: ((list: Wallets) => void) | undefined
  let afterSecond: ((list: Wallets) => void) | undefined
  jest
    .mocked(listDomainWallets)
    .mockResolvedValueOnce([W1, W2])
    .mockImplementationOnce(() => new Promise(resolve => (afterFirst = resolve)))
    .mockImplementationOnce(() => new Promise(resolve => (afterSecond = resolve)))
  await render()
  const rows = tree.root.findAll(n => n.props.icon === 'key' && typeof n.props.onPress === 'function')

  await ReactTestRenderer.act(async () => {
    rows[0].props.onPress()
  })
  await confirmQuestion(tree)
  await settle()
  await ReactTestRenderer.act(async () => {
    rows[1].props.onPress()
  })
  await confirmQuestion(tree)
  await settle()
  await ReactTestRenderer.act(async () => {
    afterSecond?.([])
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    afterFirst?.([W2])
  })
  await settle()

  expect(changeDomainAccess).toHaveBeenCalledTimes(2)
  expect(labels()).toEqual([])
  expect(texts()).toContain(i18n.t('domain.noWallets'))
})

// Each row that draws its divider, with the gap of the native view that lays it out. A gap there
// floats the hairline above the next row instead of letting it meet it. The first host View above a
// row is that view, unless it is a scroll view's content, whose style arrives as the scroll view's
// contentContainerStyle (the Jest scroll view does not pass it down).
function dividerGaps(rendered: ReactTestRenderer.ReactTestRenderer): { label: string; gap: number }[] {
  type Node = ReactTestRenderer.ReactTestInstance
  const hostAbove = (node: Node): Node | null => {
    let up = node.parent
    while (up && typeof up.type !== 'string') {
      up = up.parent
    }
    return up
  }
  const flat = (raw: unknown): Record<string, unknown> =>
    Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))
  return rendered.root
    .findAllByType(MenuRow)
    .filter(menuRow => menuRow.props.divider !== false)
    .map(menuRow => {
      const view = hostAbove(menuRow)
      const scroll = view && hostAbove(view)
      const style =
        scroll && (scroll.type as unknown) === 'RCTScrollView'
          ? flat(scroll.props.contentContainerStyle)
          : flat(view?.props.style)
      return { label: String(menuRow.props.label), gap: Number(style.gap ?? style.rowGap ?? 0) }
    })
}

// A loading row is a wallet row itself, flat and divided like the list, so the list does not jump
// when the wallets arrive.
test('the list loads as flat wallet rows, not as rounded cards', async () => {
  jest.mocked(listDomainWallets).mockImplementationOnce(() => new Promise(() => undefined))
  await render()

  const loading = tree.root.findAllByType(MenuRow).filter(row => row.findAllByType(Skeleton).length > 0)
  expect(loading).toHaveLength(2)
  expect(loading.map(row => [row.props.bleed, row.props.divider, row.props.icon])).toEqual([
    [true, true, 'key'],
    [true, false, 'key'],
  ])
  expect(tree.root.findAllByType(Skeleton).every(bar => bar.props.borderRadius === undefined)).toBe(true)
})

test('the allowed wallets are one group, each divider meeting the row under it', async () => {
  jest.mocked(listDomainWallets).mockResolvedValue([W1, W2])
  await render()
  const gaps = dividerGaps(tree)

  expect(gaps.map(entry => entry.label)).toEqual(['Ana'])
  expect(gaps.filter(entry => entry.gap !== 0)).toEqual([])
})
