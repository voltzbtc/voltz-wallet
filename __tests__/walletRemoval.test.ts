import { WalletHasLiveExit } from '../src/wallet/exitPlan'
import { removeWalletById } from '../src/wallet/wallet'
import { loadRegistry } from '../src/wallet/walletRegistry'
import {
  REMOVAL_ERRORS,
  removeListedWallet,
  removeWalletAndCheck,
} from '../src/wallet/walletRemoval'

jest.mock('../src/wallet/wallet', () => ({ removeWalletById: jest.fn() }))
jest.mock('../src/wallet/walletRegistry', () => ({ loadRegistry: jest.fn() }))

const listed = (...ids: string[]) => ({ active: ids[0] ?? null, wallets: ids.map(id => ({ id, fingerprint: `fp-${id}` })) })

beforeEach(() => {
  jest.mocked(removeWalletById).mockReset().mockResolvedValue(undefined)
  jest.mocked(loadRegistry).mockReset().mockResolvedValue(listed('w1', 'w2'))
})

test('a removal that lands is gone, and removes exactly the wallet named', async () => {
  expect(await removeWalletAndCheck('w1', 'fp-w1')).toBe('gone')
  expect(removeWalletById).toHaveBeenCalledTimes(1)
  expect(removeWalletById).toHaveBeenCalledWith('w1', 'fp-w1')
})

test('a live exit refuses, whatever the registry says', async () => {
  jest.mocked(removeWalletById).mockRejectedValueOnce(new WalletHasLiveExit('w1'))
  expect(await removeWalletAndCheck('w1', 'fp-w1')).toBe('liveExit')
  expect(loadRegistry).not.toHaveBeenCalled()
})

test('a failure with the wallet still listed failed', async () => {
  jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
  expect(await removeWalletAndCheck('w1', 'fp-w1')).toBe('failed')
})

test('a failure after the wallet left the registry is gone, as a success is', async () => {
  jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
  jest.mocked(loadRegistry).mockResolvedValue(listed('w2'))
  expect(await removeWalletAndCheck('w1', 'fp-w1')).toBe('gone')
})

test('a failure with the registry unreadable counts the wallet as still here', async () => {
  jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
  jest.mocked(loadRegistry).mockRejectedValue(new Error('storage'))
  expect(await removeWalletAndCheck('w1', 'fp-w1')).toBe('failed')
})

// The deletion screen knows the wallet by id alone, and its photos are swept by the fingerprint.
describe('a wallet named by id', () => {
  test('is removed with the fingerprint the registry lists for it', async () => {
    expect(await removeListedWallet('w2')).toBe('gone')
    expect(removeWalletById).toHaveBeenCalledTimes(1)
    expect(removeWalletById).toHaveBeenCalledWith('w2', 'fp-w2')
  })

  test('with the registry unreadable, nothing is removed and it failed', async () => {
    jest.mocked(loadRegistry).mockRejectedValue(new Error('storage'))
    expect(await removeListedWallet('w1')).toBe('failed')
    expect(removeWalletById).not.toHaveBeenCalled()
  })

  test('no longer listed, it is already gone and nothing is removed', async () => {
    expect(await removeListedWallet('w3')).toBe('gone')
    expect(removeWalletById).not.toHaveBeenCalled()
  })

  test('its removal ends as the shared one does', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new WalletHasLiveExit('w1'))
    expect(await removeListedWallet('w1')).toBe('liveExit')
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    expect(await removeListedWallet('w1')).toBe('failed')
  })
})

test('each outcome that keeps the wallet has its line', () => {
  expect(REMOVAL_ERRORS).toEqual({ liveExit: 'emergencyExit.removeRefused', failed: 'editWallet.removeFailed' })
})
