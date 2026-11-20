import RNFS from 'react-native-fs'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'
import { resolveWalletDisplay } from '../src/wallet/walletIdentity'

// The square of the photo an avatar shows is kept beside the photo's path. A read that holds no crop,
// or something that is not one, gives the photo alone, which every screen draws centred as before.
const META_FILE = `${RNFS.DocumentDirectoryPath}/wallet-meta.json`
const PHOTO = '/docs/wallet-avatars/fp-1.jpg'
const CROP = { x: 0.25, y: 0, w: 0.5, h: 1 }

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

async function stored(entry: unknown): Promise<void> {
  await RNFS.writeFile(META_FILE, JSON.stringify({ fp: entry }), 'utf8')
}

test('a photo saved before crops reads as the photo alone', async () => {
  await stored({ name: 'Daily', imagePath: PHOTO })
  expect(await loadWalletMeta('fp')).toEqual({ name: 'Daily', imagePath: PHOTO })
})

test('a crop saved beside the photo reads back', async () => {
  await saveWalletMeta('fp', { imagePath: PHOTO, imageCrop: CROP })
  expect(await loadWalletMeta('fp')).toEqual({ imagePath: PHOTO, imageCrop: CROP })
})

test.each([
  ['text', 'x'],
  ['null', null],
  ['fields as text', { x: '0', y: '0', w: '1', h: '1' }],
  ['a field outside 0 to 1', { x: 0, y: 0, w: 2, h: 1 }],
  ['a zero width', { x: 0, y: 0, w: 0, h: 1 }],
  ['a zero height', { x: 0, y: 0, w: 1, h: 0 }],
  ['x and w past the edge', { x: 0.75, y: 0, w: 0.5, h: 1 }],
  ['y and h past the edge', { x: 0, y: 0.75, w: 1, h: 0.5 }],
])('a crop stored as %s reads as no crop, and the photo stays', async (_name, crop) => {
  await stored({ name: 'Daily', imagePath: PHOTO, imageCrop: crop })
  const meta = await loadWalletMeta('fp')
  expect(meta).toEqual({ name: 'Daily', imagePath: PHOTO })
  expect(resolveWalletDisplay('fp', meta, 'Wallet').imageCrop).toBeNull()
})

test('a cleared crop is gone from the file', async () => {
  await saveWalletMeta('fp', { imagePath: PHOTO, imageCrop: CROP })
  await saveWalletMeta('fp', { imagePath: '', imageCrop: undefined })
  expect(JSON.parse(await RNFS.readFile(META_FILE, 'utf8'))).toEqual({ fp: { imagePath: '' } })
})

test('the display carries a crop only beside a photo', () => {
  expect(resolveWalletDisplay('fp', { imagePath: PHOTO, imageCrop: CROP }, 'Wallet').imageCrop).toEqual(CROP)
  expect(resolveWalletDisplay('fp', { imagePath: '', imageCrop: CROP }, 'Wallet').imageCrop).toBeNull()
  expect(resolveWalletDisplay('fp', { imagePath: PHOTO }, 'Wallet').imageCrop).toBeNull()
  expect(resolveWalletDisplay('fp', null, 'Wallet').imageCrop).toBeNull()
})
