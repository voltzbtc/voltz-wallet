import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Keyboard, Linking, Modal, Platform, Text } from 'react-native'
import i18n from '../src/i18n'
import { EditWalletScreen } from '../src/screens/EditWalletScreen'
import { WalletAvatar } from '../src/components/WalletAvatar'
import { Sheet } from '../src/components/Sheet'
import { ErrorBox } from '../src/components/ErrorBox'
import { GradientButton } from '../src/components/GradientButton'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { discardPickedImage, persistWalletImage, pickWalletImage, takeWalletPhoto } from '../src/wallet/walletImage'

// Tapping the avatar asks where the photo comes from, in the app's own sheet. What the sheet picks opens
// only once the sheet has left, and nothing on screen changes until a photo comes back adjusted.

const mockNavigate = jest.fn()
const mockSetParams = jest.fn()
let mockParams: { photo?: { uri: string; crop: { x: number; y: number; w: number; h: number } } } | undefined

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn(), setParams: mockSetParams }),
  useRoute: () => ({ params: mockParams }),
}))
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => '' }))
jest.mock('../src/wallet/wallet', () => ({
  getWalletIdentity: jest.fn(async () => ({ fingerprint: 'aaaa1111' })),
  removeWalletById: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({ active: 'w1', wallets: [{ id: 'w1', fingerprint: 'aaaa1111' }] })),
}))
jest.mock('../src/wallet/walletMeta', () => ({ loadWalletMeta: jest.fn(), saveWalletMeta: jest.fn() }))
jest.mock('../src/wallet/walletImage', () => ({
  deleteWalletImage: jest.fn(async () => undefined),
  discardWalletImage: jest.fn(async () => undefined),
  discardPickedImage: jest.fn(async () => undefined),
  persistWalletImage: jest.fn(async () => '/docs/wallet-avatars/aaaa1111-9.jpg'),
  pickWalletImage: jest.fn(),
  takeWalletPhoto: jest.fn(),
}))

const CROP = { x: 0.25, y: 0, w: 0.5, h: 1 }
const PICKED = 'file:///cache/picked.jpg'

let tree: ReactTestRenderer.ReactTestRenderer

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EditWalletScreen />)
  })
  await settle()
}

// The photo source sheet, the one Edit wallet draws with an onDismiss.
const sheet = () => tree.root.findAllByType(Sheet).find(s => s.props.onDismiss) ?? null
const rows = (): string[] =>
  (sheet()?.findAllByType(Text) ?? []).map(node => String(node.props.children))
const saveShown = (): boolean =>
  tree.root.findAllByType(GradientButton).some(b => b.props.label === i18n.t('editWallet.save') && !b.props.disabled)
const errors = (): string[] => tree.root.findAllByType(ErrorBox).map(box => box.props.message).filter(Boolean)

async function tapAvatar(): Promise<void> {
  const avatar = tree.root.findAll(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('editWallet.photo'),
  )[0]
  await ReactTestRenderer.act(async () => avatar.props.onPress())
}

async function pressRow(label: string): Promise<void> {
  const row = sheet()!
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))!
  await ReactTestRenderer.act(async () => row.props.onPress())
}

// Picks a row and lets the sheet finish leaving, as iOS reports it.
async function choose(label: string): Promise<void> {
  const leave = sheet()!.props.onDismiss
  await pressRow(label)
  await ReactTestRenderer.act(async () => leave())
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  mockParams = undefined
  jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', color: '#FF7A00' })
  jest.mocked(saveWalletMeta).mockResolvedValue(undefined)
  jest.mocked(pickWalletImage).mockResolvedValue({ kind: 'image', uri: PICKED, width: 1024, height: 768 })
  jest.mocked(takeWalletPhoto).mockResolvedValue({ kind: 'image', uri: PICKED, width: 768, height: 1024 })
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('the source sheet', () => {
  test('opens on the avatar with Take photo and Choose photo, and no Remove without a photo', async () => {
    await render()
    expect(sheet()?.props.visible).toBe(false)
    await tapAvatar()
    expect(sheet()?.props.visible).toBe(true)
    expect(rows()).toEqual([i18n.t('editWallet.takePhoto'), i18n.t('editWallet.choosePhoto')])
  })

  test('drops the keyboard of the name field before the sheet draws over it', async () => {
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined)
    await render()
    expect(dismiss).not.toHaveBeenCalled()
    await tapAvatar()
    expect(dismiss).toHaveBeenCalled()
  })

  test('offers Remove photo once there is a photo, and it takes the photo and its crop away', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', imagePath: '/p.jpg', imageCrop: CROP })
    await render()
    await tapAvatar()
    expect(rows()).toEqual([
      i18n.t('editWallet.takePhoto'),
      i18n.t('editWallet.choosePhoto'),
      i18n.t('editWallet.removePhoto'),
    ])
    const leave = sheet()!.findByType(Modal).props.onDismiss
    await pressRow(i18n.t('editWallet.removePhoto'))
    await settle()
    // Still sliding out with the photo set, so the panel keeps its Remove row on the way down.
    expect(sheet()?.props.visible).toBe(false)
    expect(tree.root.findByType(WalletAvatar).props).toMatchObject({
      imagePath: '/p.jpg',
      crop: CROP,
    })
    await ReactTestRenderer.act(async () => leave())
    await settle()
    expect(tree.root.findByType(WalletAvatar).props).toMatchObject({ imagePath: null, crop: null })
    expect(saveShown()).toBe(true)
    expect(pickWalletImage).not.toHaveBeenCalled()
    expect(takeWalletPhoto).not.toHaveBeenCalled()
  })

  test('on iOS the library opens only once the sheet has finished leaving', async () => {
    await render()
    await tapAvatar()
    // What UIKit calls when the Modal's dismissal completes.
    const leave = sheet()!.findByType(Modal).props.onDismiss
    await pressRow(i18n.t('editWallet.choosePhoto'))
    await settle()
    expect(sheet()?.props.visible).toBe(false)
    expect(pickWalletImage).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => leave())
    await settle()
    expect(pickWalletImage).toHaveBeenCalledTimes(1)
    expect(takeWalletPhoto).not.toHaveBeenCalled()
  })

  test('on Android, whose Modal reports no dismissal, the camera opens as the sheet hides', async () => {
    const os = Platform.OS
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'android' })
    try {
      await render()
      await tapAvatar()
      await pressRow(i18n.t('editWallet.takePhoto'))
      await settle()
      expect(takeWalletPhoto).toHaveBeenCalledTimes(1)
      expect(pickWalletImage).not.toHaveBeenCalled()
    } finally {
      Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os })
    }
  })

  test('closing the sheet without a choice opens nothing', async () => {
    await render()
    await tapAvatar()
    const leave = sheet()!.props.onDismiss
    await ReactTestRenderer.act(async () => sheet()!.props.onClose())
    await ReactTestRenderer.act(async () => leave())
    await settle()
    expect(pickWalletImage).not.toHaveBeenCalled()
    expect(takeWalletPhoto).not.toHaveBeenCalled()
  })
})

describe('what comes back', () => {
  test('a photo with its size goes to the adjust step, and nothing changes here yet', async () => {
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.choosePhoto'))
    expect(mockNavigate).toHaveBeenCalledWith('AdjustWalletPhoto', { uri: PICKED, width: 1024, height: 768 })
    expect(tree.root.findByType(WalletAvatar).props.imagePath).toBeNull()
    expect(saveShown()).toBe(false)
  })

  test('a photo taken goes to the adjust step the same way', async () => {
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.takePhoto'))
    expect(mockNavigate).toHaveBeenCalledWith('AdjustWalletPhoto', { uri: PICKED, width: 768, height: 1024 })
  })

  test.each([
    ['a refused camera', 'takePhoto', { kind: 'denied' }, 'editWallet.cameraDenied'],
    ['a device with no camera', 'takePhoto', { kind: 'unavailable' }, 'scan.noCamera'],
    ['a camera that failed', 'takePhoto', { kind: 'failed' }, 'editWallet.photoFailed'],
    ['a library that failed', 'choosePhoto', { kind: 'failed' }, 'editWallet.photoFailed'],
  ] as const)('%s changes nothing and says so', async (_name, row, answer, line) => {
    jest.mocked(takeWalletPhoto).mockResolvedValue(answer)
    jest.mocked(pickWalletImage).mockResolvedValue(answer)
    await render()
    await tapAvatar()
    await choose(i18n.t(`editWallet.${row}`))
    expect(errors()).toEqual([i18n.t(line)])
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(tree.root.findByType(WalletAvatar).props).toMatchObject({ imagePath: null, color: '#FF7A00' })
    expect(saveShown()).toBe(false)
  })

  test('a refused camera points to the settings where it is allowed', async () => {
    const settings = jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined)
    jest.mocked(takeWalletPhoto).mockResolvedValue({ kind: 'denied' })
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.takePhoto'))
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('scan.openSettings')))!
    await ReactTestRenderer.act(async () => link.props.onPress())
    expect(settings).toHaveBeenCalledTimes(1)
  })

  test('settings that refuse to open leave no rejection behind, and the line stays', async () => {
    jest.spyOn(Linking, 'openSettings').mockRejectedValue(new Error('no settings activity'))
    jest.mocked(takeWalletPhoto).mockResolvedValue({ kind: 'denied' })
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.takePhoto'))
    const label = i18n.t('scan.openSettings')
    const link = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))!
    await ReactTestRenderer.act(async () => {
      await expect(link.props.onPress()).resolves.toBeUndefined()
    })
    expect(errors()).toEqual([i18n.t('editWallet.cameraDenied')])
  })

  test('the next tap on the avatar clears the line', async () => {
    jest.mocked(takeWalletPhoto).mockResolvedValue({ kind: 'denied' })
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.takePhoto'))
    expect(errors()).toHaveLength(1)
    await tapAvatar()
    expect(errors()).toEqual([])
  })

  test.each([
    ['camera', 'takePhoto'],
    ['library', 'choosePhoto'],
  ] as const)('a cancelled %s changes nothing and says nothing', async (_name, row) => {
    jest.mocked(takeWalletPhoto).mockResolvedValue({ kind: 'cancelled' })
    jest.mocked(pickWalletImage).mockResolvedValue({ kind: 'cancelled' })
    await render()
    await tapAvatar()
    await choose(i18n.t(`editWallet.${row}`))
    expect(errors()).toEqual([])
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(saveShown()).toBe(false)
  })

  test('a photo that answers after the screen is gone is discarded', async () => {
    let answer!: (photo: { kind: 'image'; uri: string; width: number; height: number }) => void
    jest.mocked(pickWalletImage).mockImplementation(() => new Promise(resolve => (answer = resolve)))
    await render()
    await tapAvatar()
    const leave = sheet()!.props.onDismiss
    await pressRow(i18n.t('editWallet.choosePhoto'))
    // The library stays up, so its answer is not awaited here.
    await ReactTestRenderer.act(async () => {
      leave()
    })
    expect(pickWalletImage).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => tree.unmount())
    await ReactTestRenderer.act(async () => answer({ kind: 'image', uri: PICKED, width: 10, height: 10 }))
    expect(discardPickedImage).toHaveBeenCalledWith(PICKED)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('a photo with no size is used as it comes, drawn centred', async () => {
    jest.mocked(pickWalletImage).mockResolvedValue({ kind: 'image', uri: PICKED })
    await render()
    await tapAvatar()
    await choose(i18n.t('editWallet.choosePhoto'))
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(tree.root.findByType(WalletAvatar).props).toMatchObject({ imagePath: PICKED, crop: null })
  })
})

describe('back from the adjust step', () => {
  test('shows the photo and its crop, takes the param once, and saves both', async () => {
    jest.mocked(loadWalletMeta).mockResolvedValue({ name: 'Daily', imagePath: '/old.jpg' })
    await render()
    mockParams = { photo: { uri: PICKED, crop: CROP } }
    await ReactTestRenderer.act(async () => tree.update(<EditWalletScreen />))
    await settle()
    expect(tree.root.findByType(WalletAvatar).props).toMatchObject({ imagePath: PICKED, crop: CROP })
    expect(mockSetParams).toHaveBeenCalledWith({ photo: undefined })
    expect(saveShown()).toBe(true)
    const save = tree.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('editWallet.save'))!
    await ReactTestRenderer.act(async () => save.props.onPress())
    await settle()
    expect(persistWalletImage).toHaveBeenCalledWith('aaaa1111', PICKED)
    expect(saveWalletMeta).toHaveBeenCalledWith('aaaa1111', {
      name: 'Daily',
      color: '',
      imagePath: '/docs/wallet-avatars/aaaa1111-9.jpg',
      imageCrop: CROP,
    })
  })
})
