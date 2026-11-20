import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Modal, Text, TextInput } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { EditWalletScreen, SWATCH_NAMES } from '../src/screens/EditWalletScreen'
import { WalletAvatar } from '../src/components/WalletAvatar'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { pickWalletImage } from '../src/wallet/walletImage'

// The saved name points at the wallet's photo on disk, so a save that fails leaves the photo it
// points at in place, and a save that lands leaves only the photo it points at.

const mockGoBack = jest.fn()

jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: mockGoBack, setParams: jest.fn() }),
  useRoute: () => ({ params: undefined }),
}))
jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => '' }))
jest.mock('../src/wallet/wallet', () => ({
  getWalletIdentity: jest.fn(async () => ({ fingerprint: 'aaaa1111' })),
  removeWalletById: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(async () => ({ active: 'w1', wallets: [{ id: 'w1', fingerprint: 'aaaa1111' }] })),
}))
// The real save, wrapped so one case can make it fail.
jest.mock('../src/wallet/walletMeta', () => {
  const real = jest.requireActual('../src/wallet/walletMeta')
  return { ...real, saveWalletMeta: jest.fn(real.saveWalletMeta) }
})
jest.mock('../src/wallet/walletImage', () => ({
  ...jest.requireActual('../src/wallet/walletImage'),
  pickWalletImage: jest.fn(),
}))

const DIR = `${RNFS.DocumentDirectoryPath}/wallet-avatars`
const OLD = `${DIR}/aaaa1111-1000.jpg`
const PICKED = `${RNFS.DocumentDirectoryPath}/picked.jpg`

let tree: ReactTestRenderer.ReactTestRenderer

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function pressLabelled(label: string): Promise<void> {
  const target = tree.root.findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === label)[0]
  if (!target) {
    throw new Error(`no control labelled ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await settle()
}

// The avatar, then Choose photo in the sheet it opens, and the library once the sheet has left.
async function pickPhoto(): Promise<void> {
  await pressLabelled(i18n.t('editWallet.photo'))
  const sheet = tree.root.findAllByType(Modal).find(m => m.props.visible && m.props.onDismiss)!
  const leave = sheet.props.onDismiss
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('editWallet.choosePhoto')))!
  await ReactTestRenderer.act(async () => row.props.onPress())
  await ReactTestRenderer.act(async () => leave())
  await settle()
}

async function pressSave(): Promise<void> {
  const save = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('editWallet.save')))
  if (!save) {
    throw new Error('no Save')
  }
  await ReactTestRenderer.act(async () => {
    save.props.onPress()
  })
  await settle()
}

const avatars = async (): Promise<string[]> => (await RNFS.readDir(DIR)).map(file => file.path).sort()

beforeEach(async () => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.clearAllMocks()
  await RNFS.mkdir(DIR)
  await RNFS.writeFile(OLD, 'old photo', 'utf8')
  await RNFS.writeFile(PICKED, 'new photo', 'utf8')
  await saveWalletMeta('aaaa1111', { name: 'Daily', imagePath: OLD })
  jest.mocked(saveWalletMeta).mockClear()
  // A photo whose size the picker did not report is used as it comes, without the adjust step, which
  // keeps these cases on the save.
  jest.mocked(pickWalletImage).mockResolvedValue({ kind: 'image', uri: `file://${PICKED}` })
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<EditWalletScreen />)
  })
  await settle()
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('a new photo whose save fails leaves the photo the name points at, and no copy beside it', async () => {
  await pickPhoto()
  jest.mocked(saveWalletMeta).mockRejectedValueOnce(new Error('EACCES: permission denied'))
  await pressSave()
  expect(mockGoBack).not.toHaveBeenCalled()
  expect((await loadWalletMeta('aaaa1111')).imagePath).toBe(OLD)
  expect(await avatars()).toEqual([OLD])
  expect(await RNFS.readFile(OLD, 'utf8')).toBe('old photo')
})

test('a photo removed by a colour whose save fails is still on disk for the name that points at it', async () => {
  await pressLabelled(i18n.t(`editWallet.swatch.${SWATCH_NAMES[0]}`))
  jest.mocked(saveWalletMeta).mockRejectedValueOnce(new Error('EACCES: permission denied'))
  await pressSave()
  expect(mockGoBack).not.toHaveBeenCalled()
  expect((await loadWalletMeta('aaaa1111')).imagePath).toBe(OLD)
  expect(await avatars()).toEqual([OLD])
})

test('a new photo whose save lands is the only one left, and the name points at it', async () => {
  await pickPhoto()
  await pressSave()
  expect(mockGoBack).toHaveBeenCalled()
  const saved = (await loadWalletMeta('aaaa1111')).imagePath
  expect(saved).not.toBe(OLD)
  expect(await avatars()).toEqual([saved])
  expect(await RNFS.readFile(saved!, 'utf8')).toBe('new photo')
})

test('a photo removed by a colour whose save lands leaves no photo behind', async () => {
  await pressLabelled(i18n.t(`editWallet.swatch.${SWATCH_NAMES[0]}`))
  await pressSave()
  expect(mockGoBack).toHaveBeenCalled()
  expect((await loadWalletMeta('aaaa1111')).imagePath).toBe('')
  expect(await avatars()).toEqual([])
})

test('two presses of Save with a new photo save once, and the photo the name points at stays', async () => {
  await pickPhoto()
  const save = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('editWallet.save')))!
  // Each copy is named by the clock, so two runs would copy two distinct files.
  let now = 2000
  jest.spyOn(Date, 'now').mockImplementation(() => (now += 100))
  await ReactTestRenderer.act(async () => {
    save.props.onPress()
    save.props.onPress()
  })
  await settle()
  expect(saveWalletMeta).toHaveBeenCalledTimes(1)
  expect(mockGoBack).toHaveBeenCalledTimes(1)
  const saved = (await loadWalletMeta('aaaa1111')).imagePath
  expect(await avatars()).toEqual([saved])
  expect(await RNFS.readFile(saved!, 'utf8')).toBe('new photo')
})

test('a save that failed lets the next press try again', async () => {
  await pickPhoto()
  jest.mocked(saveWalletMeta).mockRejectedValueOnce(new Error('EACCES: permission denied'))
  await pressSave()
  expect(mockGoBack).not.toHaveBeenCalled()
  await pressSave()
  expect(saveWalletMeta).toHaveBeenCalledTimes(2)
  expect(mockGoBack).toHaveBeenCalledTimes(1)
  const saved = (await loadWalletMeta('aaaa1111')).imagePath
  expect(saved).not.toBe(OLD)
  expect(await avatars()).toEqual([saved])
})

describe('the square of the photo', () => {
  const CROP = { x: 0.25, y: 0, w: 0.5, h: 1 }

  async function reopen(): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.unmount()
      tree = ReactTestRenderer.create(<EditWalletScreen />)
    })
    await settle()
  }

  test('is drawn on the avatar, and a save of the name alone keeps it', async () => {
    await saveWalletMeta('aaaa1111', { imageCrop: CROP })
    await reopen()
    expect(tree.root.findByType(WalletAvatar).props.crop).toEqual(CROP)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(TextInput).props.onChangeText('Spending')
    })
    await pressSave()
    expect(await loadWalletMeta('aaaa1111')).toEqual({ name: 'Spending', color: '', imagePath: OLD, imageCrop: CROP })
  })

  test('goes with the photo when a colour takes its place', async () => {
    await saveWalletMeta('aaaa1111', { imageCrop: CROP })
    await reopen()
    await pressLabelled(i18n.t(`editWallet.swatch.${SWATCH_NAMES[0]}`))
    expect(tree.root.findByType(WalletAvatar).props.crop).toBeNull()
    await pressSave()
    const meta = await loadWalletMeta('aaaa1111')
    expect(meta.imagePath).toBe('')
    expect(meta).not.toHaveProperty('imageCrop')
  })
})
