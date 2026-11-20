import RNFS from 'react-native-fs'
import { deleteWalletImage, persistWalletImage } from '../src/wallet/walletImage'

const DIR = `${RNFS.DocumentDirectoryPath}/wallet-avatars`
const PICKED = `${RNFS.DocumentDirectoryPath}/picked.jpg`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

// The double answers a directory that was never made as both native modules do, by rejecting, so the
// sweep's own catch is what keeps a wallet with no avatar from failing its removal.
test('a sweep with no avatar directory deletes nothing and does not fail', async () => {
  await expect(RNFS.readDir(DIR)).rejects.toThrow('ENOENT')
  await expect(deleteWalletImage('aaaa1111')).resolves.toBeUndefined()
})

test('a sweep removes the wallet\'s avatars and keeps the directory and the one spared', async () => {
  await RNFS.writeFile(PICKED, 'photo', 'utf8')
  const first = await persistWalletImage('aaaa1111', `file://${PICKED}`)
  const other = `${DIR}/bbbb2222-1.jpg`
  await RNFS.writeFile(other, 'other photo', 'utf8')
  await deleteWalletImage('aaaa1111')
  expect((await RNFS.readDir(DIR)).map(file => file.path)).toEqual([other])
  await deleteWalletImage('bbbb2222', first)
  expect(await RNFS.readDir(DIR)).toEqual([])
})

// The native writes reject a directory nobody made, so a double that made one on write would pass code
// that never calls mkdir and fails on a device.
test('a write into a directory nobody made rejects, and the same write after mkdir lands', async () => {
  await expect(RNFS.writeFile(`${DIR}/aaaa1111-1.jpg`, 'photo', 'utf8')).rejects.toThrow('ENOENT')
  await RNFS.writeFile(PICKED, 'photo', 'utf8')
  await expect(RNFS.copyFile(PICKED, `${DIR}/aaaa1111-1.jpg`)).rejects.toThrow('ENOENT')
  await RNFS.mkdir(DIR)
  await RNFS.writeFile(`${DIR}/aaaa1111-1.jpg`, 'photo', 'utf8')
  expect((await RNFS.readDir(DIR)).map(file => file.name)).toEqual(['aaaa1111-1.jpg'])
})
