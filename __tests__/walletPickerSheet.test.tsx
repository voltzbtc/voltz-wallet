import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { ScrollView, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { WalletPickerSheet } from '../src/components/WalletPickerSheet'
import { WalletAvatar } from '../src/components/WalletAvatar'
import { Touch } from '../src/components/Touch'
import { EmptyState } from '../src/components/EmptyState'
import { ErrorBox } from '../src/components/ErrorBox'
import { GradientButton } from '../src/components/GradientButton'
import { WalletRowsSkeleton } from '../src/components/WalletRowsSkeleton'
import { Sheet } from '../src/components/Sheet'
import { Skeleton } from '../src/components/Skeleton'
import { loadRegistry, type Registry } from '../src/wallet/walletRegistry'
import { colors, radius, space } from '../src/theme'
import { answerQuestion, question } from './support/question'

jest.mock('../src/wallet/walletRegistry', () => ({ loadRegistry: jest.fn() }))
jest.mock('../src/wallet/walletMeta', () => ({ loadWalletMeta: jest.fn(async () => ({})) }))

function registry(count: number): Registry {
  return {
    wallets: Array.from({ length: count }, (_, i) => ({ id: `w${i}`, fingerprint: `fp${i}` })),
    active: 'w0',
  }
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <WalletPickerSheet visible title="Move to" onClose={() => undefined} onPick={() => undefined} />,
    )
  })
  return tree
}

beforeEach(() => {
  jest.mocked(loadRegistry).mockReset()
})

// From about eight wallets the list runs past the screen, and only a capped sheet lets the list
// scroll to the last one instead of growing under the top of the window.
describe('a question about the wallet picked', () => {
  const asking = {
    title: 'Move it?',
    confirm: 'Move',
    cancel: 'Keep',
    danger: true,
    onConfirm: jest.fn(),
  }

  test('stands in the list\'s place, in the same sheet, and its way out is the close', async () => {
    jest.mocked(loadRegistry).mockResolvedValue(registry(2))
    const onClose = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <WalletPickerSheet visible title="Pick" asking={asking} onClose={onClose} onPick={jest.fn()} />,
      )
    })
    expect(question(tree)).toEqual(asking)
    expect(tree.root.findAllByType(WalletAvatar)).toHaveLength(0)
    expect(tree.root.findAllByType(Sheet)).toHaveLength(1)

    await answerQuestion(tree, 'Keep')
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(asking.onConfirm).not.toHaveBeenCalled()
  })
})

describe('a long list of wallets', () => {
  it('keeps every wallet inside the scroll, under the sheet cap', async () => {
    jest.mocked(loadRegistry).mockResolvedValue(registry(12))
    const tree = await render()

    const rows = tree.root.findByType(ScrollView).findAllByType(Touch)
    expect(rows).toHaveLength(12)
    const capped = tree.root
      .findAllByType(View)
      .map(n => flat(n.props.style))
      .find(style => style.maxHeight !== undefined)
    expect(capped?.maxHeight).toBe('90%')
  })
})

it('names the wallets it offers', async () => {
  jest.mocked(loadRegistry).mockResolvedValue(registry(2))
  const tree = await render()
  const labels = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.accessibilityLabel === 'string')
    .map(n => n.props.accessibilityLabel)
  expect(labels.length).toBeGreaterThanOrEqual(2)
  expect(tree.root.findAllByType(Text).some(n => n.props.children === 'Move to')).toBe(true)
})

// The Wallets screen's skeleton fills its screen with flex 1, the black background and 24pt of padding
// around 68pt cards, which inside the sheet would paint a black box and change the sheet's shape when
// the rows arrive.
describe('while the wallets load', () => {
  const loading = async () => {
    jest.mocked(loadRegistry).mockReturnValue(new Promise(() => undefined))
    return render()
  }

  it('draws rows shaped like its own, not the Wallets screen cards', async () => {
    const tree = await loading()
    expect(tree.root.findAllByType(WalletRowsSkeleton)).toHaveLength(0)
    const circles = tree.root.findAllByType(Skeleton).filter(n => n.props.borderRadius === radius.full)
    expect(circles).toHaveLength(2)
    // The avatar's size, so the rows do not change height when the wallets arrive.
    expect(circles.every(n => n.props.width === 44 && n.props.height === 44)).toBe(true)
  })

  it('paints no background of its own and pads rows as the real rows are padded', async () => {
    const tree = await loading()
    const styles = tree.root.findAllByType(View).map(n => flat(n.props.style))
    expect(styles.some(st => st.backgroundColor === colors.background)).toBe(false)
    const rows = styles.filter(st => st.flexDirection === 'row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every(st => st.paddingVertical === space.md && st.padding === undefined)).toBe(true)
  })
})

// The same avatar as the Wallets list, and the same row and empty state as every other list.
describe('the rows', () => {
  it('draw the Wallets list avatar and light up as list rows', async () => {
    jest.mocked(loadRegistry).mockResolvedValue(registry(2))
    const tree = await render()
    expect(tree.root.findAllByType(WalletAvatar).map(n => n.props.size)).toEqual([44, 44])
    expect(tree.root.findAllByType(Touch).map(n => n.props.feedback)).toEqual(['row', 'row'])
  })

  it('say through the empty state that there is no other wallet', async () => {
    jest.mocked(loadRegistry).mockResolvedValue(registry(1))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <WalletPickerSheet visible title="Move to" excludeWalletId="w0" onClose={() => undefined} onPick={() => undefined} />,
      )
    })
    const empty = tree.root.findAllByType(EmptyState)
    expect(empty).toHaveLength(1)
    expect(empty[0]!.props.message).toBe(i18n.t('receive.lnTransferNoWallets'))
  })
})

// A registry that cannot be read says nothing about how many wallets there are, so the line about
// having only this wallet would be a claim nobody checked.
describe('a registry that cannot be read', () => {
  it('says the wallets could not be loaded, never that there is no other wallet', async () => {
    jest.mocked(loadRegistry).mockRejectedValue(new Error('disk busy'))
    const tree = await render()
    expect(tree.root.findAllByType(ErrorBox).map(n => n.props.message)).toEqual([i18n.t('wallets.loadFailed')])
    expect(tree.root.findAllByType(EmptyState)).toHaveLength(0)
    const said = tree.root.findAllByType(Text).map(n => n.props.children)
    expect(said).not.toContain(i18n.t('receive.lnTransferNoWallets'))
    expect(tree.root.findAllByType(Touch).filter(n => n.props.feedback === 'row')).toHaveLength(0)
  })

  it('lists the wallets once a retry reads them', async () => {
    jest.mocked(loadRegistry).mockRejectedValueOnce(new Error('disk busy')).mockResolvedValue(registry(2))
    const tree = await render()
    const retry = tree.root.findAllByType(GradientButton).find(n => n.props.label === i18n.t('common.retry'))!
    await ReactTestRenderer.act(async () => {
      retry.props.onPress()
    })
    expect(loadRegistry).toHaveBeenCalledTimes(2)
    expect(tree.root.findAllByType(ErrorBox)).toHaveLength(0)
    expect(tree.root.findByType(ScrollView).findAllByType(Touch)).toHaveLength(2)
  })
})

// Sheet's gap is the space under the title in every sheet, and a margin of its own would double it.
it('leaves the space under the title to the sheet', async () => {
  jest.mocked(loadRegistry).mockResolvedValue(registry(2))
  const tree = await render()
  const title = tree.root.findAllByType(Text).find(n => n.props.children === 'Move to')!
  expect(flat(title.props.style).marginBottom).toBeUndefined()
})

