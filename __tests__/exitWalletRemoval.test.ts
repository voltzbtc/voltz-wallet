import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, isWalletHasLiveExit, loadExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { eraseAllWallets, removeWalletById } from '../src/wallet/wallet'
import RNFS from 'react-native-fs'
import { deleteSeedFor } from '../src/wallet/seed'

import { planOf } from './support/exitFixtures'

jest.mock('../src/wallet/seed', () => ({
  ...jest.requireActual('../src/wallet/seed'),
  deleteSeedFor: jest.fn(async () => undefined),
  deletePassphraseFor: jest.fn(async () => undefined),
  hasSeedFor: jest.fn(async () => true),
  listSeedIds: jest.fn(async () => []),
  listPassphraseIds: jest.fn(async () => []),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'active'),
  loadRegistry: jest.fn(async () => ({
    active: 'active',
    wallets: [
      { id: 'active', fingerprint: 'aa' },
      { id: 'other', fingerprint: 'bb' },
    ],
  })),
  removeWalletEntry: jest.fn(async () => undefined),
  setActiveWallet: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/spark', () => ({
  disconnectSpark: jest.fn(async () => undefined),
  sparkEraseLocalData: jest.fn(async () => undefined),
  whileSparkErasing: jest.fn((work: () => Promise<unknown>) => work()),
}))

const planFile = (id: string): string => `${RNFS.DocumentDirectoryPath}/exit-plan-${id}.json`

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  jest.clearAllMocks()
  await forgetExitPlan('other')
  await forgetExitPlan('active')
})

afterEach(() => __setEmergencyExitLiveForTests(null))

describe('a wallet with an exit under way', () => {
  test.each(['other', 'active'])('%s stays, untouched, with the reason', async id => {
    await saveExitPlan(planOf({ walletId: id }))
    const removal = removeWalletById(id, 'aa').catch((err: unknown) => err)
    expect(isWalletHasLiveExit(await removal)).toBe(true)
    expect(deleteSeedFor).not.toHaveBeenCalled()
    expect((await loadExitPlan(id))?.walletId).toBe(id)
  })

  test('a plan the platform will not read holds the wallet too', async () => {
    await saveExitPlan(planOf({ walletId: 'other' }))
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    await expect(removeWalletById('other', 'bb')).rejects.toMatchObject({ name: 'WalletHasLiveExit' })
    read.mockRestore()
    expect(deleteSeedFor).not.toHaveBeenCalled()
  })

  test('a torn plan goes aside and the wallet is free, with the torn file kept', async () => {
    await RNFS.writeFile(planFile('other'), 'torn', 'utf8')
    await removeWalletById('other', 'bb')
    expect(deleteSeedFor).toHaveBeenCalledWith('other')
    expect(await RNFS.exists(`${planFile('other')}.unreadable`)).toBe(true)
    await RNFS.unlink(`${planFile('other')}.unreadable`)
  })

  test('a plan that ended short of done holds nothing either', async () => {
    await saveExitPlan(planOf({ walletId: 'other', verdict: 'closed', closure: 'nothing' }))
    await removeWalletById('other', 'bb')
    expect(deleteSeedFor).toHaveBeenCalledWith('other')
    expect(await RNFS.exists(planFile('other'))).toBe(false)
  })

  test('a finished plan holds nothing, and goes with the wallet', async () => {
    await saveExitPlan(planOf({ walletId: 'other', verdict: 'done' }))
    await removeWalletById('other', 'bb')
    expect(deleteSeedFor).toHaveBeenCalledWith('other')
    expect(await RNFS.exists(planFile('other'))).toBe(false)
  })

  test('no plan removes as before', async () => {
    await removeWalletById('other', 'bb')
    expect(deleteSeedFor).toHaveBeenCalledWith('other')
  })

  test('an erase takes the plan with everything else', async () => {
    await saveExitPlan(planOf({ walletId: 'active' }))
    await eraseAllWallets()
    expect(await RNFS.exists(planFile('active'))).toBe(false)
    expect(deleteSeedFor).toHaveBeenCalledWith('active')
  })
})

test('with the switch off no plan is read on a removal', async () => {
  await saveExitPlan(planOf({ walletId: 'other' }))
  __setEmergencyExitLiveForTests(false)
  await removeWalletById('other', 'bb')
  expect(deleteSeedFor).toHaveBeenCalledWith('other')
})

