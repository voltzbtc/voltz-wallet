import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import { connectActiveSpark, disconnectSpark } from '../src/wallet/spark'

// The SDK's folder holds every payment, the contacts and the lightning address in the clear. On iOS
// Documents goes into iCloud backups, which Apple can read without Advanced Data Protection, and into
// unencrypted computer backups, so the folder is flagged out of backups before the SDK writes in it.
// The network gives all of it back, so nothing is lost on a new phone.

jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'wallet-a'),
  ensureRegistered: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  loadSeedFor: jest.fn(async () => 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'),
  loadPassphraseFor: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/lnurlDomainPref', () => ({ domainFor: jest.fn(async () => 'example.com') }))

const FOLDER = `${RNFS.DocumentDirectoryPath}/spark`

beforeEach(() => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(connect).mockImplementation(
    async () =>
      ({
        getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })),
        addEventListener: jest.fn(async () => 'listener'),
        disconnect: jest.fn(async () => undefined),
      }) as never,
  )
})

afterEach(async () => {
  await disconnectSpark()
})

test('flags the SDK folder out of backups before the SDK opens it', async () => {
  const order: string[] = []
  const mkdir = jest.spyOn(RNFS, 'mkdir').mockImplementation(async (dir, options) => {
    order.push(`mkdir ${dir} ${JSON.stringify(options)}`)
  })
  jest.mocked(connect).mockImplementationOnce(async ({ storageDir }) => {
    order.push(`connect ${storageDir}`)
    return {
      getInfo: jest.fn(async () => ({ identityPubkey: '02aa', balanceSats: 0n, tokenBalances: new Map() })),
      addEventListener: jest.fn(async () => 'listener'),
      disconnect: jest.fn(async () => undefined),
    } as never
  })

  await connectActiveSpark()

  expect(order).toEqual([`mkdir ${FOLDER} {"NSURLIsExcludedFromBackupKey":true}`, `connect ${FOLDER}`])
  mkdir.mockRestore()
})

test('still connects when the flag cannot be set, and says so', async () => {
  const mkdir = jest.spyOn(RNFS, 'mkdir').mockRejectedValue(new Error('EPERM'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  await connectActiveSpark()

  expect(connect).toHaveBeenCalled()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('SDK folder not kept out of backups'))
  mkdir.mockRestore()
  warn.mockRestore()
})
