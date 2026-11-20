import RNFS from 'react-native-fs'
import { sparkEraseLocalData } from '../src/wallet/spark'

const FOLDER = `${RNFS.DocumentDirectoryPath}/spark`

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

test('erases the folder the SDK keeps its records in', async () => {
  await RNFS.mkdir(FOLDER)
  await RNFS.writeFile(`${FOLDER}/storage.sql`, 'history', 'utf8')

  await sparkEraseLocalData()

  expect(await RNFS.exists(`${FOLDER}/storage.sql`)).toBe(false)
  expect(await RNFS.exists(FOLDER)).toBe(false)
})

test('a device with no folder has nothing to erase and no failure to report', async () => {
  await expect(sparkEraseLocalData()).resolves.toBeUndefined()
})
