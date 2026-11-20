import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import i18n from '../src/i18n'
import { AuthorizeWalletScreen } from '../src/screens/AuthorizeWalletScreen'
import { MenuRow } from '../src/components/MenuRow'
import { changeDomainAccess, saveLabel, walletCode } from '../src/wallet/domainAccess'

const GUEST = `03${'b'.repeat(64)}`
const SECOND = `02${'c'.repeat(64)}`
// jest.mock hoists above the file, so the factory may only close over a name prefixed with `mock`.
let mockParams: { domain: string; scanned?: string } = { domain: 'pay.example.com' }
// setParams merges into the route's params, as the native stack does.
const mockNav = {
  goBack: jest.fn(),
  navigate: jest.fn(),
  setParams: jest.fn((next: { scanned?: string }) => {
    mockParams = { ...mockParams, ...next }
  }),
}

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => mockNav,
  useRoute: () => ({ params: mockParams }),
}))

jest.mock('../src/wallet/domainAccess', () => ({
  ...jest.requireActual('../src/wallet/domainAccess'),
  changeDomainAccess: jest.fn(async () => undefined),
  saveLabel: jest.fn(async () => undefined),
}))

jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
}))

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<AuthorizeWalletScreen />)
  })
  return tree
}

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = { domain: 'pay.example.com' }
})

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.props.label === label || n.findAllByType(Text).some(x => x.props.children === label))
  if (!target) {
    throw new Error(`control not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    await target.props.onPress()
  })
}

async function pasteKey(tree: ReactTestRenderer.ReactTestRenderer, key: string): Promise<void> {
  jest.mocked(Clipboard.getString).mockResolvedValueOnce(key)
  await press(tree, i18n.t('domain.paste'))
}

async function rerender(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.update(<AuthorizeWalletScreen />)
  })
}

describe('Use another wallet', () => {
  test('after a paste, returns to scan and paste with no key, no label and no error', async () => {
    const tree = await render()
    await pasteKey(tree, GUEST)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('Maria')
    })
    expect(texts(tree)).toContain(walletCode(GUEST))
    jest.mocked(changeDomainAccess).mockRejectedValueOnce(new Error('only_the_owner_may_authorize'))
    await press(tree, i18n.t('domain.authorize'))
    expect(texts(tree)).toContain(i18n.t('domain.errNotOwner'))

    await press(tree, i18n.t('domain.useAnotherWallet'))
    const shown = texts(tree).join(' ')
    expect(shown).toContain('Scan the code')
    expect(shown).not.toContain(walletCode(GUEST))
    expect(shown).not.toContain(i18n.t('domain.errNotOwner'))

    await pasteKey(tree, SECOND)
    expect(tree.root.findByType(TextInput).props.value).toBe('')
  })

  test('a key scanned again after it is shown again', async () => {
    mockParams = { domain: 'pay.example.com', scanned: GUEST }
    const tree = await render()
    await rerender(tree)
    expect(texts(tree)).toContain(walletCode(GUEST))

    await press(tree, i18n.t('domain.useAnotherWallet'))
    await rerender(tree)
    expect(texts(tree).join(' ')).toContain('Scan the code')

    // The scanner hands the same key back.
    mockParams = { ...mockParams, scanned: GUEST }
    await rerender(tree)
    expect(texts(tree)).toContain(walletCode(GUEST))
  })

  test('confirming after the switch sends only the new key, with the label typed for it', async () => {
    const tree = await render()
    await pasteKey(tree, GUEST)
    await press(tree, i18n.t('domain.useAnotherWallet'))
    await pasteKey(tree, SECOND)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('Joana')
    })

    await press(tree, i18n.t('domain.authorize'))

    expect(changeDomainAccess).toHaveBeenCalledTimes(1)
    expect(jest.mocked(changeDomainAccess).mock.calls[0]![2]).toBe(SECOND)
    expect(saveLabel).toHaveBeenCalledWith(SECOND, 'Joana')
  })

  test('cannot be pressed while the confirmation is under way', async () => {
    let finish!: () => void
    jest.mocked(changeDomainAccess).mockImplementationOnce(
      () => new Promise<void>(resolve => {
        finish = resolve
      }),
    )
    const tree = await render()
    await pasteKey(tree, GUEST)
    const allow = tree.root.findAll(n => n.props.label === i18n.t('domain.authorize') && typeof n.props.onPress === 'function')[0]!
    await ReactTestRenderer.act(async () => {
      allow.props.onPress()
    })
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && 'disabled' in n.props)
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('domain.useAnotherWallet')))!
    expect(link.props.disabled).toBe(true)
    await ReactTestRenderer.act(async () => {
      finish()
    })
  })
})

// The scanner returns to this screen while it is mounted, so the key arrives as a params update.
// Reading it once at mount drops it and the screen keeps offering to scan.
it('shows the code for a key that arrives after mount', async () => {
  const tree = await render()
  expect(texts(tree).join(' ')).toContain('Scan the code')

  mockParams = { domain: 'pay.example.com', scanned: GUEST }
  await ReactTestRenderer.act(async () => {
    tree.update(<AuthorizeWalletScreen />)
  })
  const all = texts(tree).join(' ')
  expect(all).toContain('Their code')
  expect(all).not.toContain('Scan the code')
})

it('refuses a scan that is not a wallet key', async () => {
  mockParams = { domain: 'pay.example.com', scanned: 'maria@pay.example.com' }
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    tree.update(<AuthorizeWalletScreen />)
  })
  expect(texts(tree).join(' ')).toContain('not a wallet')
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

it('draws the scan and paste rows as one group, each divider meeting the row under it', async () => {
  const tree = await render()
  const gaps = dividerGaps(tree)

  expect(gaps.length).toBeGreaterThan(0)
  expect(gaps.filter(entry => entry.gap !== 0)).toEqual([])
})
