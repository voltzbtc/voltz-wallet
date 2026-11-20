import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Keyboard, Modal, ScrollView, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { EditWalletScreen, SWATCH_NAMES, swatchColumns } from '../src/screens/EditWalletScreen'
import { markUnconfirmed } from '../src/wallet/backupMark'
import { avatarColor } from '../src/wallet/walletIdentity'
import { TabIcon } from '../src/components/TabIcon'
import { Field } from '../src/components/Field'
import { FieldClear } from '../src/components/FieldClear'
import { Touch } from '../src/components/Touch'
import { GradientButton } from '../src/components/GradientButton'
import { Skeleton } from '../src/components/Skeleton'
import { WalletRowsSkeleton } from '../src/components/WalletRowsSkeleton'
import { getWalletIdentity, holdsLiveExit, removeWalletById } from '../src/wallet/wallet'
import { WalletHasLiveExit } from '../src/wallet/exitPlan'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { pickWalletImage } from '../src/wallet/walletImage'
import { space, touch, walletColors } from '../src/theme'
import { answerQuestion, confirmQuestion, question } from './support/question'
import { getBreezLnurlDomain } from '../src/config'
import { Toggle } from '../src/components/Toggle'
import { ConfirmBody } from '../src/components/ConfirmSheet'

const mockNavigate = jest.fn()
const mockGoBack = jest.fn()

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: mockGoBack, setParams: jest.fn() }),
  useRoute: () => ({ params: undefined }),
}))
jest.mock('../src/config', () => ({ getBreezLnurlDomain: jest.fn(() => '') }))
jest.mock('../src/wallet/wallet', () => ({
  getWalletIdentity: jest.fn(),
  holdsLiveExit: jest.fn(),
  removeWalletById: jest.fn(),
}))
jest.mock('../src/wallet/walletMeta', () => ({
  ...jest.requireActual('../src/wallet/walletMeta'),
  loadWalletMeta: jest.fn(),
  saveWalletMeta: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({ loadRegistry: jest.fn() }))
// A phone with a home indicator, so the bottom inset is something the screen has to add.
jest.mock('react-native-safe-area-context', () => ({
  ...jest.requireActual('../__mocks__/react-native-safe-area-context'),
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 34, left: 0 }),
}))
jest.mock('../src/wallet/walletImage', () => ({
  deleteWalletImage: jest.fn(async () => undefined),
  persistWalletImage: jest.fn(async () => '/img'),
  pickWalletImage: jest.fn(async () => ({ kind: 'cancelled' })),
}))

type Registry = Awaited<ReturnType<typeof loadRegistry>>
const registry = (active: string, ids: string[]): Registry => ({
  active,
  wallets: ids.map(id => ({ id, fingerprint: id === 'w1' ? 'aaaa1111' : 'bbbb2222' })),
}) as Registry

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
    tree = ReactTestRenderer.create(<EditWalletScreen />)
  })
  await settle()
}

const texts = (): string[] => tree.root.findAllByType(Text).map(node => String(node.props.children))
const skeletons = () => tree.root.findAllByType(WalletRowsSkeleton)

async function typeName(text: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(text)
  })
}

async function pickSwatch(name: string): Promise<void> {
  const swatch = tree.root.findAll(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t(`editWallet.swatch.${name}`),
  )[0]
  await ReactTestRenderer.act(async () => swatch.props.onPress())
}

// A primary button that cannot act is drawn absent and keeps its box (GradientButton).
const saveShown = (): boolean =>
  tree.root
    .findAllByType(GradientButton)
    .some(button => button.props.label === i18n.t('editWallet.save') && !button.props.disabled)

// The avatar, then Choose photo in the sheet it opens, and the library once the sheet has left.
async function choosePhoto(): Promise<void> {
  const label = i18n.t('editWallet.photo')
  const avatar = tree.root.findAll(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label,
  )[0]
  await ReactTestRenderer.act(async () => avatar.props.onPress())
  const sheet = tree.root.findAllByType(Modal).find(m => m.props.visible && m.props.onDismiss)!
  const leave = sheet.props.onDismiss
  await press(i18n.t('editWallet.choosePhoto'))
  await ReactTestRenderer.act(async () => leave())
  await settle()
}

async function press(label: string): Promise<void> {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!target) {
    throw new Error(`no control labelled ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  for (const fn of [
    getWalletIdentity,
    holdsLiveExit,
    removeWalletById,
    loadWalletMeta,
    saveWalletMeta,
    loadRegistry,
  ]) {
    jest.mocked(fn).mockReset()
  }
  jest.mocked(getWalletIdentity).mockResolvedValue({ fingerprint: 'aaaa1111' })
  jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily' })
  jest.mocked(saveWalletMeta).mockResolvedValue(undefined)
  jest.mocked(removeWalletById).mockResolvedValue(undefined)
  jest.mocked(holdsLiveExit).mockResolvedValue(false)
  jest.mocked(loadRegistry).mockResolvedValue(registry('w1', ['w1', 'w2']))
  jest.mocked(getBreezLnurlDomain).mockReturnValue('')
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('save', () => {
  test('a save that fails says so, stays, and keeps what was typed', async () => {
    jest.mocked(saveWalletMeta).mockRejectedValueOnce(new Error('storage'))
    await render()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('Savings')
    })

    await press(i18n.t('editWallet.save'))

    expect(texts()).toContain(i18n.t('editWallet.saveFailed'))
    expect(mockGoBack).not.toHaveBeenCalled()
    expect(tree.root.findByType(TextInput).props.value).toBe('Savings')
  })

  test('a save that passes goes back', async () => {
    await render()
    await pickSwatch('orange')
    await press(i18n.t('editWallet.save'))

    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', expect.objectContaining({ name: 'Daily' }))
    expect(mockGoBack).toHaveBeenCalled()
    expect(texts()).not.toContain(i18n.t('editWallet.saveFailed'))
  })
})

// Save is there only while what the screen holds differs from what it read.
describe('Save', () => {
  test('is hidden on open, for a named, a coloured, an unnamed and a photo wallet', async () => {
    for (const meta of [{ name: 'Daily' }, { name: 'Daily', color: walletColors[2] }, {}, { imagePath: '/p.jpg' }]) {
      jest.mocked(loadWalletMeta).mockResolvedValue(meta)
      await render()
      expect(saveShown()).toBe(false)
    }
  })

  test('is hidden while the wallet reads and when the read failed', async () => {
    let answer!: (identity: { fingerprint: string }) => void
    jest.mocked(getWalletIdentity).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await render()
    expect(saveShown()).toBe(false)
    await ReactTestRenderer.act(async () => answer({ fingerprint: 'aaaa1111' }))
    await settle()
    expect(saveShown()).toBe(false)

    jest.mocked(loadWalletMeta).mockRejectedValueOnce(new Error('storage'))
    await render()
    expect(saveShown()).toBe(false)
  })

  test('shows for a new name and hides when the name is put back, spaces aside', async () => {
    await render()
    await typeName('Savings')
    expect(saveShown()).toBe(true)
    await typeName('Daily ')
    expect(saveShown()).toBe(false)
  })

  test('shows for a cleared name, and stays hidden clearing a name that was the default', async () => {
    await render()
    await typeName('')
    expect(saveShown()).toBe(true)

    jest.mocked(loadWalletMeta).mockResolvedValue({})
    await render()
    await typeName('')
    expect(saveShown()).toBe(false)
  })

  test('shows for another colour and hides when the colour is put back', async () => {
    await render()
    await pickSwatch('orange')
    expect(saveShown()).toBe(true)
    await pickSwatch('automatic')
    expect(saveShown()).toBe(false)
  })

  test('shows for a photo picked', async () => {
    jest.mocked(pickWalletImage).mockResolvedValueOnce({ kind: 'image', uri: 'file:///picked.jpg' })
    await render()
    await choosePhoto()
    expect(saveShown()).toBe(true)
  })

  test('shows for a photo taken off by a colour', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', imagePath: '/p.jpg' })
    await render()
    await pickSwatch('automatic')
    expect(saveShown()).toBe(true)
  })

  // Every save without a photo writes the path empty, which is the read of most wallets.
  test('hides for a photo picked and taken off again on a wallet saved with no photo', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', color: '', imagePath: '' })
    jest.mocked(pickWalletImage).mockResolvedValueOnce({ kind: 'image', uri: 'file:///picked.jpg' })
    await render()
    expect(saveShown()).toBe(false)
    await choosePhoto()
    expect(saveShown()).toBe(true)
    await pickSwatch('automatic')
    expect(saveShown()).toBe(false)
  })
})

// Presses Remove and takes the confirm of the question it raises.
async function removeConfirmed(): Promise<void> {
  await press(i18n.t('editWallet.remove'))
  await confirmQuestion(tree)
  await settle()
}

describe('remove', () => {
  test('a removal confirmed while a save runs does nothing, and the save leaves the screen', async () => {
    let land: () => void = () => {}
    jest.mocked(saveWalletMeta).mockImplementationOnce(() => new Promise<void>(resolve => (land = resolve)))
    await render()
    await typeName('Savings')
    await press(i18n.t('editWallet.save'))
    await removeConfirmed()
    expect(removeWalletById).not.toHaveBeenCalled()
    expect(skeletons()).toHaveLength(0)
    await ReactTestRenderer.act(async () => {
      land()
    })
    await settle()
    expect(mockGoBack).toHaveBeenCalledTimes(1)
    expect(removeWalletById).not.toHaveBeenCalled()
  })

  test('a removal confirmed after a save failed goes ahead', async () => {
    jest.mocked(saveWalletMeta).mockRejectedValueOnce(new Error('storage'))
    await render()
    await typeName('Savings')
    await press(i18n.t('editWallet.save'))
    await removeConfirmed()
    expect(removeWalletById).toHaveBeenCalledWith('w1', 'aaaa1111')
  })

  test('a removal that fails with the wallet still listed takes the skeleton down and says so', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()

    await removeConfirmed()

    expect(removeWalletById).toHaveBeenCalledWith('w1', 'aaaa1111')
    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('editWallet.removeFailed'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('a removal that fails after the wallet left the registry goes Home, as a success does', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    jest.mocked(loadRegistry).mockResolvedValue(registry('w2', ['w2']))

    await removeConfirmed()

    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })

  test('a removal that fails with the registry unreadable keeps the error up', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    jest.mocked(loadRegistry).mockRejectedValue(new Error('storage'))

    await removeConfirmed()

    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('editWallet.removeFailed'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // A removal that failed after switching away leaves another wallet active, and a retry aimed at
  // whatever is active would delete that wallet's seed instead.
  test('a second try removes the wallet on screen, not the one made active meanwhile', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    jest.mocked(loadRegistry).mockResolvedValue(registry('w2', ['w1', 'w2']))

    await removeConfirmed()
    await removeConfirmed()

    expect(removeWalletById).toHaveBeenCalledTimes(2)
    expect(jest.mocked(removeWalletById).mock.calls.map(call => call[0])).toEqual(['w1', 'w1'])
    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })

  test('a removal that passes goes Home', async () => {
    await render()
    await removeConfirmed()

    expect(mockNavigate).toHaveBeenCalledWith('Main')
    expect(texts()).not.toContain(i18n.t('editWallet.removeFailed'))
  })
})

const flat = (raw: unknown): Record<string, unknown> =>
  Object.assign(
    {},
    ...[typeof raw === 'function' ? raw({ pressed: false }) : raw]
      .flat(Infinity)
      .filter(x => x && typeof x === 'object'),
  )

describe('while the wallet reads', () => {
  test('a skeleton stands for the avatar and the field, which land with the answer', async () => {
    let answer!: (identity: { fingerprint: string }) => void
    jest.mocked(getWalletIdentity).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await render()
    expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    expect(tree.root.findAllByType(Field)).toHaveLength(0)

    await ReactTestRenderer.act(async () => {
      answer({ fingerprint: 'aaaa1111' })
    })
    await settle()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(tree.root.findAllByType(Field)).toHaveLength(1)
  })

  test('a read that fails ends the skeleton', async () => {
    jest.mocked(getWalletIdentity).mockRejectedValueOnce(new Error('no answer'))
    await render()
    await settle()
    expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
  })
})

describe('the name', () => {
  const field = () => tree.root.findAllByType(TextInput)[0]

  test('a wallet with no name of its own shows its name as a value, not a placeholder', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({})
    await render()
    expect(field().props.value).toBe(i18n.t('drawer.walletName'))
  })

  test('saving the default name keeps it no name of its own', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({})
    await render()
    await pickSwatch('orange')
    await press(i18n.t('editWallet.save'))
    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', expect.objectContaining({ name: '' }))
  })

  test('a name typed over it saves as typed', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({})
    await render()
    await ReactTestRenderer.act(async () => field().props.onChangeText('Savings'))
    await press(i18n.t('editWallet.save'))
    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', expect.objectContaining({ name: 'Savings' }))
  })

  test('a name of its own stays as it is', async () => {
    await render()
    expect(field().props.value).toBe('Daily')
  })

  const clears = () => tree.root.findAllByType(FieldClear).filter(n => n.findAllByType(Touch).length > 0)

  test('a clear inside the field, named for a screen reader, empties the name in one tap', async () => {
    await render()
    expect(clears()).toHaveLength(1)
    const target = clears()[0].findByType(Touch)
    expect(target.props.label).toBe(i18n.t('editWallet.clearName'))
    await ReactTestRenderer.act(async () => target.props.onPress())
    expect(field().props.value).toBe('')
    // Nothing left to clear, so the clear leaves with the text.
    expect(clears()).toHaveLength(0)
    await ReactTestRenderer.act(async () => field().props.onChangeText('S'))
    expect(clears()).toHaveLength(1)
  })

  // A ScrollView at 'never' hands the first tap to the keyboard while the field is focused, so the
  // clear would take two. Jest does not model that capture, so the prop that turns it off is read.
  test('a clear reached with the keyboard up acts on the first tap', async () => {
    await render()
    const holding = tree.root
      .findAllByType(ScrollView)
      .filter(n => n.findAllByType(TextInput).length > 0)
    expect(holding.length).toBeGreaterThan(0)
    const taps = holding.map(n => n.props.keyboardShouldPersistTaps)
    expect(taps).toEqual(holding.map(() => 'handled'))
  })

  test('a cleared name saves as no name of its own, the default name', async () => {
    await render()
    await ReactTestRenderer.act(async () => clears()[0].findByType(Touch).props.onPress())
    await press(i18n.t('editWallet.save'))
    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', expect.objectContaining({ name: '' }))
  })
})

describe('the colour section', () => {
  test('stands a block apart from the name field above it', async () => {
    await render()
    const label = tree.root.findAllByType(Text).find(n => n.props.children === i18n.t('editWallet.color'))!
    // The nearest ancestor that carries the section's own spacing.
    let node = label.parent
    while (node && flat(node.props.style).marginTop === undefined) {
      node = node.parent
    }
    expect(node).toBeTruthy()
    expect(flat(node!.props.style).marginTop).toBe(space.xl)
  })

  // Fixed-size swatches leave the rows short of the right gutter; sharing the row width does not.
  test('lays the swatches in full rows that share the width, gutter to gutter', async () => {
    await render()
    const swatches = tree.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityState?.selected !== undefined &&
        walletColors.includes(flat(n.props.style).backgroundColor as (typeof walletColors)[number]),
    )
    const outermost = swatches.filter(n => !swatches.includes(n.parent!))
    expect(outermost).toHaveLength(walletColors.length)
    for (const swatch of outermost) {
      // Past the Touch that wraps the press target, to the row.
      let holder = swatch.parent!
      while (flat(holder.props.style).flexDirection === undefined) {
        holder = holder.parent!
      }
      const row = flat(holder.props.style)
      expect(row.flexDirection).toBe('row')
      expect(row.flexWrap).toBeUndefined()
    }
  })

  // A lone swatch on a short row drew larger than the rest while the swatch itself held the share
  // of the width, so every place in every row is one cell style, and the swatch only fills it.
  test('draws every swatch, the automatic one alone on a short row included, in one size', async () => {
    await render()
    const columns = swatchColumns(320)
    const swatchCount = walletColors.length + 1
    const rows = Math.ceil(swatchCount / columns)
    // A short last row, so the case of a swatch beside empty places is the one on screen.
    expect(swatchCount % columns).not.toBe(0)

    const host = (n: ReactTestRenderer.ReactTestInstance) => typeof n.type === 'string'
    const swatches = tree.root.findAll(
      n => host(n) && n.props.accessibilityRole === 'button' && n.props.accessibilityState?.selected !== undefined,
    )
    expect(swatches).toHaveLength(swatchCount)
    for (const swatch of swatches) {
      const style = flat(swatch.props.style)
      expect(style.flex).toBeUndefined()
      expect(style.flexGrow).toBeUndefined()
      expect(style.width).toBe('100%')
      expect(style.aspectRatio).toBe(1)
    }

    const hostAbove = (n: ReactTestRenderer.ReactTestInstance) => {
      let up = n.parent!
      while (!host(up)) {
        up = up.parent!
      }
      return up
    }
    const cells = swatches.map(hostAbove)
    const places = tree.root.findAll(n => host(n) && cells.some(cell => cell.props.style === n.props.style))
    // Every place of every row, swatch or empty, carries the same style object.
    expect(places).toHaveLength(rows * columns)
    expect(new Set(places.map(place => place.props.style)).size).toBe(1)
    expect(flat(places[0].props.style)).toEqual({ flex: 1 })
  })
})

describe('the swatches', () => {
  const swatches = () =>
    tree.root.findAll(
      n =>
        typeof n.props.onPress === 'function' &&
        n.props.accessibilityRole === 'button' &&
        n.props.accessibilityState?.selected !== undefined,
    )

  // The colour is all a swatch shows, so a screen reader needs its name.
  test('each swatch is named by its colour', async () => {
    await render()
    const labels = swatches().map(n => n.props.accessibilityLabel as string)
    expect(SWATCH_NAMES).toHaveLength(walletColors.length)
    expect(new Set(labels).size).toBe(walletColors.length + 1)
    expect(labels).toEqual([
      ...SWATCH_NAMES.map(name => i18n.t(`editWallet.swatch.${name}`)),
      i18n.t('editWallet.swatch.automatic'),
    ])
  })

  const chosen = () =>
    swatches()
      .filter(n => n.props.accessibilityState.selected)
      .map(n => n.props.accessibilityLabel)
  const swatch = (name: string) =>
    swatches().find(n => n.props.accessibilityLabel === i18n.t(`editWallet.swatch.${name}`))!
  const checks = (name: string) =>
    swatch(name).findAllByType(TabIcon).filter(n => n.props.name === 'check')

  test('a wallet with no colour chosen shows the one it has as chosen, in that colour', async () => {
    await render()
    expect(chosen()).toEqual([i18n.t('editWallet.swatch.automatic')])
    expect(checks('automatic')).toHaveLength(1)
    expect(flat(swatch('automatic').props.style({ pressed: false })).backgroundColor).toBe(
      avatarColor('aaaa1111'),
    )
  })

  test('a colour saved empty is the same as none', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', color: '' })
    await render()
    expect(chosen()).toEqual([i18n.t('editWallet.swatch.automatic')])
  })

  test('a chosen colour holds the check alone', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', color: walletColors[0] })
    await render()
    expect(chosen()).toEqual([i18n.t('editWallet.swatch.orange')])
    expect(checks('automatic')).toHaveLength(0)
  })

  test('the automatic swatch takes the wallet back to no colour of its own', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', color: walletColors[0] })
    await render()
    await ReactTestRenderer.act(async () => swatch('automatic').props.onPress())
    await press(i18n.t('editWallet.save'))
    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', expect.objectContaining({ color: '' }))
  })

  test('a photo leaves no swatch chosen', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', imagePath: '/photo.jpg' })
    await render()
    expect(chosen()).toEqual([])
  })

  // Six columns on a narrow phone would draw each swatch under the touch floor.
  test('take as many columns as keep each at 44pt or more, never more than six', () => {
    expect(swatchColumns(390)).toBe(6)
    expect(swatchColumns(352)).toBe(6)
    expect(swatchColumns(351)).toBe(5)
    expect(swatchColumns(320)).toBe(5)
    for (let width = 280; width <= 500; width += 1) {
      const n = swatchColumns(width)
      const cell = (width - space.xl * 2 - space.sm * (n - 1)) / n
      expect(cell).toBeGreaterThanOrEqual(touch.min)
    }
  })
})

// Remove is the last thing on the screen, so scrolled to the end it must clear the home indicator.
test('the scroll ends above the home indicator', async () => {
  await render()
  const scroll = tree.root.find(n => n.props.contentContainerStyle !== undefined)
  expect(flat(scroll.props.contentContainerStyle).paddingBottom).toBe(space.xl + 34)
})

test('removing a wallet is the danger variant', async () => {
  await render()
  const remove = tree.root
    .findAllByType(GradientButton)
    .find(button => button.props.label === i18n.t('editWallet.remove'))
  expect(remove?.props.variant).toBe('danger')
})

// Removing the only copy of words nobody confirmed is the one removal that can take the funds with it.
describe('the warning before a removal', () => {
  test('says the words were not confirmed for a wallet with the mark', async () => {
    await markUnconfirmed('w1')
    await render()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)?.body).toBe(i18n.t('backup.removeUnconfirmed'))
  })

  test('stays the usual one for a wallet without it', async () => {
    await render()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)?.body).toBe(i18n.t('editWallet.removeWarning'))
  })
})

// Deleting a wallet's data at Voltz is part of removing it, and the only wallet, which cannot be
// removed, still reaches it from the same button.
describe('data deletion in the remove flow', () => {
  const removeButton = () =>
    tree.root.findAllByType(GradientButton).find(button => button.props.label === i18n.t('editWallet.remove'))
  const optionToggle = () => tree.root.findAllByType(ConfirmBody)[0]?.findAllByType(Toggle)[0]

  test('the row of its own is gone from Edit wallet, with or without a domain', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    await render()
    expect(texts()).not.toContain(i18n.t('deleteData.row'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('drops the keyboard of the name field before the question draws over it', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined)
    await render()
    expect(dismiss).not.toHaveBeenCalled()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)).toBeTruthy()
    expect(dismiss).toHaveBeenCalled()
    dismiss.mockRestore()
  })

  test('the only wallet, in a build with a domain, reaches DeleteData through Remove', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    jest.mocked(loadRegistry).mockResolvedValue(registry('w1', ['w1']))
    await render()
    expect(removeButton()).toBeTruthy()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)?.title).toBe(i18n.t('editWallet.onlyWalletTitle'))
    expect(question(tree)?.body).toBe(i18n.t('editWallet.onlyWalletBody'))
    expect(question(tree)?.option).toBeUndefined()
    // It only opens DeleteData, whose own confirm is the danger one.
    const confirm = tree.root
      .findAllByType(ConfirmBody)[0]
      .findAllByType(GradientButton)
      .find(button => button.props.label === i18n.t('deleteData.row'))
    expect(confirm?.props.variant).toBe('primary')
    await answerQuestion(tree, i18n.t('deleteData.row'))
    await settle()
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('DeleteData')
    expect(removeWalletById).not.toHaveBeenCalled()
  })

  test('the only wallet, in a build without a domain, has no Remove at all', async () => {
    jest.mocked(loadRegistry).mockResolvedValue(registry('w1', ['w1']))
    await render()
    expect(removeButton()).toBeUndefined()
  })

  test('a wallet that can be removed is asked about its data only in a build with a domain', async () => {
    await render()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)?.option).toBeUndefined()
    expect(optionToggle()).toBeUndefined()

    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    await render()
    await press(i18n.t('editWallet.remove'))
    expect(question(tree)?.title).toBe(i18n.t('editWallet.removeTitle'))
    expect(question(tree)?.body).toBe(i18n.t('editWallet.removeWarning'))
    expect(question(tree)?.option).toEqual({
      label: i18n.t('editWallet.alsoDelete'),
      note: i18n.t('editWallet.alsoDeleteNote'),
    })
    expect(optionToggle()?.props.value).toBe(false)
  })

  test('confirming with the option off removes as before, and opens nothing', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    await render()
    await removeConfirmed()
    expect(removeWalletById).toHaveBeenCalledWith('w1', 'aaaa1111')
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    expect(mockNavigate).not.toHaveBeenCalledWith('DeleteData', expect.anything())
  })

  test('confirming with the option on opens DeleteData naming the wallet, and removes nothing here', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    await render()
    await press(i18n.t('editWallet.remove'))
    await ReactTestRenderer.act(async () => optionToggle()!.props.onValueChange(true))
    await confirmQuestion(tree)
    await settle()
    expect(holdsLiveExit).toHaveBeenCalledWith('w1')
    expect(mockNavigate).toHaveBeenCalledTimes(1)
    expect(mockNavigate).toHaveBeenCalledWith('DeleteData', { thenRemove: 'w1' })
    expect(removeWalletById).not.toHaveBeenCalled()
  })

  // DeleteData would refuse the removal only after the request had reached Voltz.
  test('with the option on, a live exit opens nothing and says so here', async () => {
    jest.mocked(getBreezLnurlDomain).mockReturnValue('usevoltz.app')
    jest.mocked(holdsLiveExit).mockResolvedValue(true)
    await render()
    await press(i18n.t('editWallet.remove'))
    await ReactTestRenderer.act(async () => optionToggle()!.props.onValueChange(true))
    await confirmQuestion(tree)
    await settle()
    expect(holdsLiveExit).toHaveBeenCalledWith('w1')
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(removeWalletById).not.toHaveBeenCalled()
    expect(texts()).toContain(i18n.t('emergencyExit.removeRefused'))
  })

  test('a removal refused for a live exit says so on Edit wallet', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new WalletHasLiveExit('w1'))
    await render()
    await removeConfirmed()
    expect(texts()).toContain(i18n.t('emergencyExit.removeRefused'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
