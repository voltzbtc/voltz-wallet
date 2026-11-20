import RNFS from 'react-native-fs'
import {
  forgetPendingSends,
  notePendingSend,
  readPendingSends,
  rebuildPendingSends,
  settlePendingSend,
} from '../src/wallet/pendingSends'

const PATH = '/mock/Documents/pending-sends-primary.json'

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
})

test('a noted send is read back and kept per wallet', async () => {
  await notePendingSend('primary', 'pay-1')
  await notePendingSend('other', 'pay-2')

  expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: ['pay-1'] })
  expect(await readPendingSends('other')).toEqual({ kind: 'ok', ids: ['pay-2'] })
})

// Only the call that removed the send may tell, and once written the file is all a restart
// has, so the removal is read back from the bytes.
test('a send is given up once, and the file no longer holds it', async () => {
  await notePendingSend('primary', 'pay-1')
  await notePendingSend('primary', 'pay-2')
  expect(JSON.parse(await RNFS.readFile(PATH, 'utf8')).sends).toEqual(['pay-1', 'pay-2'])

  expect(await settlePendingSend('primary', 'pay-1')).toBe(true)
  expect(await settlePendingSend('primary', 'pay-1')).toBe(false)
  expect(JSON.parse(await RNFS.readFile(PATH, 'utf8')).sends).toEqual(['pay-2'])
})

// A torn file is never read as empty and never yields a send to tell.
test('a torn record reads as torn and gives nothing up', async () => {
  await RNFS.writeFile(PATH, '{"version":1,"walletId":"primary","sends":["pay-', 'utf8')

  expect(await readPendingSends('primary')).toEqual({ kind: 'torn' })
  expect(await settlePendingSend('primary', 'pay-1')).toBe(false)
  expect(await RNFS.readFile(PATH, 'utf8')).toContain('pay-')
})

test('a torn record is rebuilt from what the SDK still holds, its bytes kept aside', async () => {
  const torn = '{"version":1,"walletId":"primary","sends":["pay-'
  await RNFS.writeFile(PATH, torn, 'utf8')

  await rebuildPendingSends('primary', ['pay-2'])

  expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: ['pay-2'] })
  expect(await RNFS.readFile(`${PATH}.unreadable`, 'utf8')).toBe(torn)
})

// A write the disk refuses keeps the send in memory, followed and given up once.
test('a send whose write failed is still followed and given up once', async () => {
  const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('ENOSPC'))

  await notePendingSend('primary', 'pay-1')
  expect(write).toHaveBeenCalled()
  expect(await RNFS.exists(PATH)).toBe(false)

  expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: ['pay-1'] })
  expect(await RNFS.exists(PATH)).toBe(true)
  expect(await settlePendingSend('primary', 'pay-1')).toBe(true)
  expect(await settlePendingSend('primary', 'pay-1')).toBe(false)
})

test('a read the platform refuses rejects and touches nothing', async () => {
  await notePendingSend('primary', 'pay-1')
  const before = await RNFS.readFile(PATH, 'utf8')
  jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))

  await expect(readPendingSends('primary')).rejects.toThrow('EACCES')
  expect(await settlePendingSend('primary', 'pay-1')).toBe(false)

  jest.restoreAllMocks()
  expect(await RNFS.readFile(PATH, 'utf8')).toBe(before)
})

test('a removed wallet drops its record and nothing else', async () => {
  await notePendingSend('primary', 'pay-1')
  await notePendingSend('other', 'pay-2')

  await forgetPendingSends('primary')

  expect(await readPendingSends('primary')).toEqual({ kind: 'ok', ids: [] })
  expect(await RNFS.exists(PATH)).toBe(false)
  expect(await readPendingSends('other')).toEqual({ kind: 'ok', ids: ['pay-2'] })
})
