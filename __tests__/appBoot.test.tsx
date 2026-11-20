import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import App from '../App'
import { settleActiveWallet } from '../src/wallet/wallet'
import { hasPin } from '../src/wallet/pin'
import { I18nManager, Settings } from 'react-native'
import RNRestart from 'react-native-restart'
import i18n from '../src/i18n'
import { loadDirectionRestart, loadDisplayLanguage, loadDollarMode } from '../src/wallet/settings'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { disconnectSpark } from '../src/wallet/spark'

// The read happens during boot and carries the active wallet's own id, so a dollar-mode wallet
// never opens orange and corrects itself a second later.
jest.mock('../src/wallet/wallet', () => ({
  settleActiveWallet: jest.fn(),
  onActiveWalletChanged: () => () => undefined,
}))
jest.mock('../src/wallet/pin', () => ({ hasPin: jest.fn(), savePin: jest.fn() }))
jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn() }))
jest.mock('../src/wallet/settings', () => ({
  loadDisplayLanguage: jest.fn().mockResolvedValue(null),
  loadDollarMode: jest.fn().mockResolvedValue(false),
  loadDirectionRestart: jest.fn().mockResolvedValue(null),
  saveDirectionRestart: jest.fn().mockResolvedValue(undefined),
  clearDirectionRestart: jest.fn().mockResolvedValue(undefined),
  loadHeroUnit: jest.fn(async () => 'sats'),
  saveHeroUnit: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  disconnectSpark: jest.fn().mockResolvedValue(undefined),
}))
// RootNavigator would drag in the whole navigator tree.
jest.mock('../src/navigation/RootNavigator', () => ({ RootNavigator: () => null }))

async function boot(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<App />)
  })
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
  return tree
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(settleActiveWallet).mockResolvedValue(true)
  jest.mocked(hasPin).mockResolvedValue(false)
  jest.mocked(getActiveWalletId).mockResolvedValue('w7')
  jest.mocked(loadDollarMode).mockResolvedValue(false)
  jest.mocked(loadDisplayLanguage).mockResolvedValue(null)
  jest.mocked(loadDirectionRestart).mockResolvedValue(null)
})

afterEach(async () => {
  await i18n.changeLanguage('en-US')
})

test('boot reads the cached mode for the active wallet, so the accent opens correct', async () => {
  await boot()
  expect(loadDollarMode).toHaveBeenCalledWith('w7')
})

test('boot pins the iOS bundle to the language saved in the app', async () => {
  const write = jest.spyOn(Settings, 'set').mockImplementation(() => undefined)
  jest.mocked(loadDisplayLanguage).mockResolvedValue('pt-PT')

  await boot()

  expect(write).toHaveBeenCalledWith({ AppleLanguages: ['pt-PT'] })
  write.mockRestore()
})

// Detection reads the same preferred languages, so a pin here would hold the app on the language the
// phone had when it was installed.
test('with no language saved, boot leaves the bundle to follow the phone', async () => {
  const write = jest.spyOn(Settings, 'set').mockImplementation(() => undefined)

  await boot()

  expect(write).not.toHaveBeenCalled()
  write.mockRestore()
})

test('with no wallet stored, boot skips the read and goes to welcome', async () => {
  jest.mocked(settleActiveWallet).mockResolvedValue(false)

  await boot()

  expect(loadDollarMode).not.toHaveBeenCalled()
})

// The running layout is LTR under Jest, so Arabic disagrees with it. With the marker of a restart
// already made for RTL, the boot renders as it is instead of restarting into a loop.
test('a direction still wrong after its restart settles and the boot goes on to welcome', async () => {
  jest.mocked(loadDisplayLanguage).mockResolvedValue('ar')
  jest.mocked(loadDirectionRestart).mockResolvedValue('rtl')
  jest.mocked(settleActiveWallet).mockResolvedValue(false)
  expect(I18nManager.isRTL).toBe(false)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  const tree = await boot()

  expect(RNRestart.restart).not.toHaveBeenCalled()
  const create = i18n.t('welcome.create')
  expect(tree.root.findAll(node => node.props.label === create).length).toBeGreaterThan(0)
})

test('a direction still wrong after its restart settles and the boot goes on to the wallet', async () => {
  jest.mocked(loadDisplayLanguage).mockResolvedValue('ar')
  jest.mocked(loadDirectionRestart).mockResolvedValue('rtl')
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)

  await boot()

  expect(RNRestart.restart).not.toHaveBeenCalled()
  expect(loadDollarMode).toHaveBeenCalledWith('w7')
})

test('a direction that disagrees with no marker restarts once and stops the boot there', async () => {
  jest.mocked(loadDisplayLanguage).mockResolvedValue('ar')

  await boot()

  expect(RNRestart.restart).toHaveBeenCalledTimes(1)
  expect(settleActiveWallet).not.toHaveBeenCalled()
  // The boot's restart closes the SDK first as the picker's does, a no-op before Home connects it.
  expect(disconnectSpark).toHaveBeenCalledTimes(1)
  expect(jest.mocked(disconnectSpark).mock.invocationCallOrder[0]).toBeLessThan(
    jest.mocked(RNRestart.restart).mock.invocationCallOrder[0],
  )
})

// The boot's way out. A throw anywhere in it lands on a stage that opens no wallet and creates no
// PIN, and Try again runs the whole boot once more.
test('a boot that throws offers Try again, which runs the boot once more however often it is pressed', async () => {
  jest.mocked(settleActiveWallet).mockRejectedValueOnce(new Error('keychain unavailable'))
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  let finish: (open: boolean) => void = () => undefined

  const tree = await boot()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('boot did not finish'))
  expect(settleActiveWallet).toHaveBeenCalledTimes(1)
  expect(loadDollarMode).not.toHaveBeenCalled()
  const retry = i18n.t('common.retry')
  const failed = i18n.t('welcome.bootFailed')
  expect(tree.root.findAll(node => node.props.children === failed).length).toBeGreaterThan(0)
  const [button] = tree.root.findAll(node => node.props.label === retry && typeof node.props.onPress === 'function')

  jest.mocked(settleActiveWallet).mockImplementationOnce(
    () =>
      new Promise<boolean>(resolve => {
        finish = resolve
      }),
  )
  await ReactTestRenderer.act(async () => {
    button.props.onPress()
    button.props.onPress()
  })
  // The failure stays on its page, under the button's spinner, while the boot runs again.
  expect(tree.root.findAll(node => node.props.label === retry).length).toBeGreaterThan(0)
  await ReactTestRenderer.act(async () => {
    finish(true)
  })
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }

  expect(settleActiveWallet).toHaveBeenCalledTimes(2)
  expect(loadDollarMode).toHaveBeenCalledWith('w7')
  expect(tree.root.findAll(node => node.props.label === retry)).toHaveLength(0)
  warn.mockRestore()
})
