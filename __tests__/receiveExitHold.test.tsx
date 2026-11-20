import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Share, Text } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { ReceiveScreen } from '../src/screens/ReceiveScreen'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { sparkConnectedWalletId, sparkReceive } from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { planOf } from './support/exitFixtures'
import { ReceiveHeldByExit } from '../src/wallet/errors'

// While a plan is alive the SDK's optimizer is off for the wallet, and Receive is shut as Send is, so a
// payment in never meets a connection that could swap a leaf the exit is spending.

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  sparkListReceiveRoutes: jest.fn(() => new Promise(() => undefined)),
  sparkReceive: jest.fn(),
  sparkConversionLimits: jest.fn(),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkEnsureLnAddress: jest.fn(async () => null),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', recoverableSat: 0, balanceSat: 0, tokens: [] })),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))
jest.mock('../src/wallet/dollarMode', () => ({
  ...jest.requireActual('../src/wallet/dollarMode'),
  useDollarMode: jest.fn(() => false),
}))
const mockNavigate = jest.fn()
// The newest focus effect of each caller, so a test can focus the screen again.
const mockFocus = new Map<string, () => void | (() => void)>()
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ setOptions: jest.fn(), navigate: mockNavigate }),
    useRoute: () => ({ params: {} }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      const id = react.useId()
      mockFocus.set(id, effect)
      react.useEffect(effect, [effect])
    },
  }
})

let mounted: ReactTestRenderer.ReactTestRenderer | null = null

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ReceiveScreen />)
  })
  await flush()
  await flush()
  mounted = tree
  return tree
}

const shown = (tree: ReactTestRenderer.ReactTestRenderer): string =>
  tree.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children
      return (Array.isArray(children) ? children : [children]).filter(
        (child): child is string => typeof child === 'string',
      )
    })
    .join(' ')

const pressable = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAll(
    node =>
      typeof node.props.onPress === 'function' &&
      (node.props.accessibilityLabel === label ||
        node.findAllByType(Text).some(text => text.props.children === label)),
  )

// The platform refuses the plan's read, and only that read.
function planUnread(): void {
  const real = RNFS.readFile
  jest
    .spyOn(RNFS, 'readFile')
    .mockImplementation((path: string, encoding?: string) =>
      path.includes('exit-plan-') ? Promise.reject(new Error('EACCES')) : real(path, encoding),
    )
}

beforeEach(async () => {
  mockFocus.clear()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __setEmergencyExitLiveForTests(true)
  jest.mocked(sparkConnectedWalletId).mockReturnValue('primary')
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(sparkReceive).mockResolvedValue({ destination: 'lnbc1default', feeSat: 0 } as never)
  await forgetExitPlan('primary')
  await forgetExitPlan('other')
})

afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
  jest.restoreAllMocks()
  __setEmergencyExitLiveForTests(null)
})

test('with no plan the wallet receives as usual', async () => {
  const tree = await render()
  expect(sparkReceive).toHaveBeenCalled()
  expect(shown(tree)).not.toContain(i18n.t('emergencyExit.receiveHeld'))
})

test('a live plan holds Receive, asks for no code, and leads to the follow-up', async () => {
  await saveExitPlan(planOf({ walletId: 'primary' }))
  const tree = await render()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  expect(sparkReceive).not.toHaveBeenCalled()
  const [open] = pressable(tree, i18n.t('emergencyExit.sendHeldOpen'))
  await ReactTestRenderer.act(async () => open.props.onPress())
  expect(mockNavigate).toHaveBeenCalledWith('EmergencyExit', { selection: 'all' })
})

test('a plan the platform will not read holds it too, with its own line', async () => {
  await saveExitPlan(planOf({ walletId: 'primary' }))
  planUnread()
  const tree = await render()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeldUnread'))
  expect(sparkReceive).not.toHaveBeenCalled()
})

// A switch without reconnecting leaves the active wallet apart from the connected one.
test('the active wallet is asked as well as the connected one', async () => {
  jest.mocked(getActiveWalletId).mockResolvedValue('other')
  await saveExitPlan(planOf({ walletId: 'other' }))
  const tree = await render()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  expect(sparkReceive).not.toHaveBeenCalled()
})

test('a plan that ended holds nothing', async () => {
  await saveExitPlan(planOf({ walletId: 'primary', verdict: 'done' }))
  await render()
  expect(sparkReceive).toHaveBeenCalled()
})

test('an exit that starts while the code is on screen is read again at the press of Copy', async () => {
  const tree = await render()
  expect(sparkReceive).toHaveBeenCalled()
  await saveExitPlan(planOf({ walletId: 'primary' }))

  const [copy] = pressable(tree, i18n.t('receive.copy'))
  await ReactTestRenderer.act(async () => copy.props.onPress())
  await flush()
  expect(Clipboard.setString).not.toHaveBeenCalled()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
})

test('and at the press of Share', async () => {
  const shared = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
  const tree = await render()
  await saveExitPlan(planOf({ walletId: 'primary' }))

  const [share] = pressable(tree, i18n.t('receive.share'))
  await ReactTestRenderer.act(async () => share.props.onPress())
  await flush()
  expect(shared).not.toHaveBeenCalled()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
})

test('with no exit the press copies at once', async () => {
  const tree = await render()
  const [copy] = pressable(tree, i18n.t('receive.copy'))
  await ReactTestRenderer.act(async () => copy.props.onPress())
  await flush()
  expect(Clipboard.setString).toHaveBeenCalledWith('lnbc1default')
})

test('with the exit switched off nothing is held', async () => {
  await saveExitPlan(planOf({ walletId: 'primary' }))
  __setEmergencyExitLiveForTests(false)
  await render()
  expect(sparkReceive).toHaveBeenCalled()
})

// A code minted before the exit started never shows while the read of a new focus is in flight.
test('a refocus draws no code until its read answers', async () => {
  const tree = await render()
  const minted = jest.mocked(sparkReceive).mock.calls.length
  expect(pressable(tree, i18n.t('receive.copy')).length).toBeGreaterThan(0)

  await saveExitPlan(planOf({ walletId: 'primary' }))
  const waiting: (() => void)[] = []
  const answer = () => waiting.splice(0).forEach(resolve => resolve())
  const real = RNFS.readFile
  jest.spyOn(RNFS, 'readFile').mockImplementation((path: string, encoding?: string) =>
    path.includes('exit-plan-')
      ? new Promise<string>((resolve, reject) => {
          waiting.push(() => real(path, encoding).then(resolve, reject))
        })
      : real(path, encoding),
  )
  // ReceiveScreen's own, the first to render.
  await ReactTestRenderer.act(async () => {
    ;[...mockFocus.values()][0]()
  })
  await flush()
  expect(pressable(tree, i18n.t('receive.copy'))).toHaveLength(0)
  expect(shown(tree)).not.toContain('lnbc1default')

  await ReactTestRenderer.act(async () => {
    answer()
    await new Promise<void>(resolve => setTimeout(resolve, 50))
  })
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  expect(sparkReceive).toHaveBeenCalledTimes(minted)
})

// spark.ts holds the receive itself, for an exit that starts between the screen's read and the SDK call.
test('a receive spark.ts refuses for an exit says so', async () => {
  jest.mocked(sparkReceive).mockRejectedValue(new ReceiveHeldByExit('exit'))
  const tree = await render()
  await flush()
  expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
})
