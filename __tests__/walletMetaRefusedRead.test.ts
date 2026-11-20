import RNFS from 'react-native-fs'
import { loadWalletMeta, saveWalletMeta } from '../src/wallet/walletMeta'

// The meta file holds every wallet's name and colour and is written whole, so a save built on a read
// the platform refused would write one wallet's entry over all the others.
const META_FILE = `${RNFS.DocumentDirectoryPath}/wallet-meta.json`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('a save whose read is refused rejects and leaves every other entry on disk', async () => {
  const before = JSON.stringify({
    'fp-daily': { name: 'Daily', color: '#30a46c' },
    'fp-savings': { name: 'Savings', color: '#3e63dd' },
  })
  await RNFS.writeFile(META_FILE, before, 'utf8')
  // The platform refuses the text read and the bytes read that follows it, as an I/O error does.
  jest
    .spyOn(RNFS, 'readFile')
    .mockRejectedValueOnce(new Error('EACCES: permission denied'))
    .mockRejectedValueOnce(new Error('EACCES: permission denied'))

  await expect(saveWalletMeta('fp-daily', { name: 'Spending' })).rejects.toThrow('EACCES')

  expect(await RNFS.readFile(META_FILE, 'utf8')).toBe(before)
})

test('a save on a readable file keeps the other wallets and patches its own entry', async () => {
  await RNFS.writeFile(META_FILE, JSON.stringify({ 'fp-savings': { name: 'Savings' } }), 'utf8')

  await saveWalletMeta('fp-daily', { name: 'Daily' })

  expect(JSON.parse(await RNFS.readFile(META_FILE, 'utf8'))).toEqual({
    'fp-daily': { name: 'Daily' },
    'fp-savings': { name: 'Savings' },
  })
})

// A torn file holds nothing readable: the screens show every wallet's default name, and a save starts
// from an empty store and replaces the file, so a name can still be set.
test('a torn file reads as no names, and a save replaces it', async () => {
  await RNFS.writeFile(META_FILE, '{"fp-daily":{"name":"Da', 'utf8')

  expect(await loadWalletMeta('fp-daily')).toEqual({})
  await saveWalletMeta('fp-daily', { name: 'Daily' })

  expect(JSON.parse(await RNFS.readFile(META_FILE, 'utf8'))).toEqual({ 'fp-daily': { name: 'Daily' } })
})
