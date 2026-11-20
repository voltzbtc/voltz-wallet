import RNFS from 'react-native-fs'
import { clearUnconfirmed, countUnconfirmed, isUnconfirmed, markUnconfirmed } from '../src/wallet/backupMark'

const FILE = `${RNFS.DocumentDirectoryPath}/backup-marks.json`

const listWallets = (...ids: string[]): Promise<void> =>
  RNFS.writeFile(
    `${RNFS.DocumentDirectoryPath}/wallets.json`,
    JSON.stringify({ active: ids[0], wallets: ids.map(id => ({ id, fingerprint: `fp-${id}` })) }),
    'utf8',
  )

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

test('a wallet with no mark, on a device that never wrote the file, answers no', async () => {
  expect(await isUnconfirmed('w1')).toBe(false)
  expect(await countUnconfirmed(['w1', 'w2'])).toBe(0)
})

test('a mark stands for its own wallet until it is cleared', async () => {
  await markUnconfirmed('w1')
  await markUnconfirmed('w2')
  await markUnconfirmed('w1')
  expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual(['w1', 'w2'])

  await clearUnconfirmed('w1')
  expect(await isUnconfirmed('w1')).toBe(false)
  expect(await isUnconfirmed('w2')).toBe(true)
  expect(await countUnconfirmed(['w1', 'w2', 'w3'])).toBe(1)
})

test('clearing a wallet with no mark writes nothing', async () => {
  const write = jest.spyOn(RNFS, 'writeFile')
  await clearUnconfirmed('w1')
  expect(write).not.toHaveBeenCalled()
  write.mockRestore()
})

describe('a file that cannot be read', () => {
  test('answers yes, for every wallet: the card is the safe side', async () => {
    await RNFS.writeFile(FILE, '["w1"', 'utf8')
    expect(await isUnconfirmed('w2')).toBe(true)
    expect(await countUnconfirmed(['w1', 'w2'])).toBe(2)
  })

  test('of another shape answers the same', async () => {
    await RNFS.writeFile(FILE, '{"w1":true}', 'utf8')
    expect(await isUnconfirmed('w1')).toBe(true)
  })

  test('answers yes on a read the platform refuses', async () => {
    await markUnconfirmed('w1')
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    expect(await isUnconfirmed('w2')).toBe(true)
    expect(await countUnconfirmed(['w1', 'w2'])).toBe(2)
    read.mockRestore()
  })

  // Whatever the file held is gone, so every listed wallet keeps asking until it confirms, and the
  // wallet that just confirmed is free of it.
  test('a clear keeps every other listed wallet marked', async () => {
    await listWallets('w1', 'w2')
    await RNFS.writeFile(FILE, 'torn', 'utf8')

    await clearUnconfirmed('w1')

    expect(await isUnconfirmed('w1')).toBe(false)
    expect(await isUnconfirmed('w2')).toBe(true)
  })

  test('a clear on a read the platform refused rejects and writes nothing, since the marks may be intact', async () => {
    await markUnconfirmed('w1')
    await markUnconfirmed('w2')
    const before = await RNFS.readFile(FILE, 'utf8')
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    await expect(clearUnconfirmed('w1')).rejects.toThrow('EACCES')
    read.mockRestore()
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
  })

  test('a mark on a torn file lands and keeps the listed wallets marked', async () => {
    await listWallets('w1')
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    await markUnconfirmed('w2')
    expect(await isUnconfirmed('w1')).toBe(true)
    expect(await isUnconfirmed('w2')).toBe(true)
    expect(await isUnconfirmed('w3')).toBe(false)
  })
})

test('a first write cut mid way stands behind no wallet, so it reads as no file', async () => {
  await RNFS.writeFile(`${FILE}.tmp`, '["w', 'utf8')
  expect(await isUnconfirmed('w1')).toBe(false)
  await markUnconfirmed('w1')
  expect(await isUnconfirmed('w1')).toBe(true)
})
