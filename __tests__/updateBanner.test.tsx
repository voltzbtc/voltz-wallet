import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Modal, ScrollView, Text } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { HomeScreen } from '../src/screens/HomeScreen'
import { UpdateBanner } from '../src/components/UpdateBanner'
import { markUnconfirmed } from '../src/wallet/backupMark'
import { connectActiveSpark, sparkGetWalletInfo, sparkGetFiatRates } from '../src/wallet/spark'
import { saveDismissedUpdate } from '../src/wallet/settings'
import { readUpdateNotice, storeUrl, type UpdateNotice } from '../src/wallet/updateNotice'

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: () => 'primary',
  sparkSetStableBalance: jest.fn(async () => undefined),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkPrepareConvertBySpend: jest.fn(),
  sparkDiscardConvertQuote: jest.fn(),
  onSparkSynced: () => () => undefined,
  onSparkRecoverableFunds: () => () => undefined,
  sparkSyncWaitLeftMs: () => 0,
  connectActiveSpark: jest.fn(),
  onSparkConnected: (cb: () => void) => {
    cb()
    return () => undefined
  },
  sparkGetWalletInfo: jest.fn(),
  sparkGetFiatRates: jest.fn(),
  sparkSubscribeToPayments: jest.fn().mockResolvedValue(() => undefined),
  sparkListUnclaimedDeposits: jest.fn(async () => []),
  sparkClaimDeposit: jest.fn(),
  sparkListFiatCurrencies: jest.fn(async () => []),
}))

jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useDollarMode: () => false,
    useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }),
  }
})

const mockNavigate = jest.fn()
const mockNavigation = { navigate: mockNavigate }
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => mockNavigation,
    useFocusEffect: (callback: () => void | (() => void)) => react.useEffect(callback, [callback]),
  }
})

const SEVEN_HOURS = 7 * 60 * 60 * 1000
let now = Date.parse('2026-11-05T12:00:00Z')

async function homeWith(notice: UpdateNotice | null): Promise<ReactTestRenderer.ReactTestRenderer> {
  jest.mocked(readUpdateNotice).mockResolvedValue(notice)
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<HomeScreen />)
  })
  // Past the first frame, where the read starts.
  await ReactTestRenderer.act(async () => {
    await new Promise(resolve => setTimeout(resolve, 20))
  })
  return tree
}

function textsIn(root: ReactTestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

const texts = (tree: ReactTestRenderer.ReactTestRenderer): string[] => textsIn(tree.root)

function pressable(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  const control = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!control) {
    throw new Error(`not found: ${label}`)
  }
  return control
}

const critical = (): string => i18n.t('updateNotice.criticalTitle')

beforeEach(() => {
  // Each case is a read the hook's process memory still owes, six hours past the one before it.
  now += SEVEN_HOURS
  jest.spyOn(Date, 'now').mockImplementation(() => now)
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  mockNavigate.mockReset()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined as never)
  jest.mocked(sparkGetWalletInfo).mockResolvedValue({ sync: 'synced', recoverableSat: 0, balanceSat: 5_000, tokens: [] })
  jest.mocked(sparkGetFiatRates).mockResolvedValue({ currency: 'USD', rates: {} } as never)
  jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

describe('nothing blocks', () => {
  test('control: with no notice, no banner and every action of Home is there', async () => {
    const tree = await homeWith(null)
    expect(texts(tree)).not.toContain(critical())
    expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('home.send'))
  })

  test('the critical banner leaves Home whole, with no modal and no change of route', async () => {
    const quiet = await homeWith(null)
    const without = texts(quiet)
    ReactTestRenderer.act(() => quiet.unmount())
    now += SEVEN_HOURS

    const tree = await homeWith({ level: 'critical' })
    expect(texts(tree)).toContain(critical())
    expect(texts(tree)).toEqual(expect.arrayContaining(without))
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(tree.root.findAllByType(Modal).filter(modal => modal.props.visible)).toHaveLength(0)
    expect(tree.root.findByType(UpdateBanner).findAllByType(Modal)).toHaveLength(0)
  })

  test('Send still goes through with the critical banner up', async () => {
    const tree = await homeWith({ level: 'critical' })
    await ReactTestRenderer.act(async () => pressable(tree, i18n.t('home.send')).props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('Send')
  })

  test('the recovery phrase still opens with the critical banner up', async () => {
    await markUnconfirmed('primary')
    const tree = await homeWith({ level: 'critical' })
    await ReactTestRenderer.act(async () => pressable(tree, i18n.t('backup.verifyTitle')).props.onPress())
    expect(mockNavigate).toHaveBeenCalledWith('RecoveryPhrase')
  })

  test('the banner stands on a Home whose connection failed', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('connection refused'))
    const tree = await homeWith({ level: 'critical' })
    expect(texts(tree)).toContain(i18n.t('home.connectionError'))
    expect(texts(tree)).toContain(critical())
  })

  const read = (file: string): string => fs.readFileSync(path.join(__dirname, '..', file), 'utf8')
  const importers = (dir: string): string[] =>
    fs.readdirSync(path.join(__dirname, '..', dir), { recursive: true, encoding: 'utf8' })
      .filter(file => /\.tsx?$/.test(file))
      .map(file => path.join(dir, file))
      .filter(file => /from '[^']*\/(updateNotice|useUpdateNotice|UpdateBanner)'/.test(read(file)))

  // Neither the boot nor the navigator can wait on the file, so no route depends on what it says.
  test('App.tsx and RootNavigator import nothing of the notice', () => {
    const notice = /updateNotice|useUpdateNotice|UpdateBanner/
    expect(read('App.tsx')).not.toMatch(notice)
    expect(read('src/navigation/RootNavigator.tsx')).not.toMatch(notice)
  })

  test('only Home draws it, and only the hook and the banner reach the reader', () => {
    expect(importers('src').sort()).toEqual([
      'src/components/UpdateBanner.tsx',
      'src/hooks/useUpdateNotice.ts',
      'src/screens/HomeScreen.tsx',
    ])
    expect(read('src/components/UpdateBanner.tsx')).not.toMatch(/\bModal\b/)
  })
})

describe('the banner', () => {
  test('in flight or with no answer, Home draws without it and without a placeholder', async () => {
    const before = await homeWith(null)
    ReactTestRenderer.act(() => before.unmount())
    now += SEVEN_HOURS
    jest.mocked(readUpdateNotice).mockClear()
    let answer!: (notice: UpdateNotice | null) => void
    jest.mocked(readUpdateNotice).mockReturnValue(new Promise(resolve => (answer = resolve)))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<HomeScreen />)
    })
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    expect(jest.mocked(readUpdateNotice)).toHaveBeenCalled()
    expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(0)
    await ReactTestRenderer.act(async () => answer(null))
    expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(0)
  })

  test('an answer landing after a finger touched Home leaves Home where it was', async () => {
    const before = await homeWith(null)
    ReactTestRenderer.act(() => before.unmount())
    now += SEVEN_HOURS
    let answer!: (notice: UpdateNotice | null) => void
    jest.mocked(readUpdateNotice).mockReturnValue(new Promise(resolve => (answer = resolve)))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<HomeScreen />)
    })
    await ReactTestRenderer.act(async () => {
      await new Promise(resolve => setTimeout(resolve, 20))
    })
    ReactTestRenderer.act(() => tree.root.findByType(ScrollView).props.onTouchStart())
    await ReactTestRenderer.act(async () => answer({ level: 'critical' }))
    expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(0)
  })

  test('one tap on either level opens the fixed store link', async () => {
    for (const notice of [{ level: 'critical' }, { level: 'normal', latest: '1.2.0' }] as UpdateNotice[]) {
      now += SEVEN_HOURS
      jest.mocked(Linking.openURL).mockClear()
      const tree = await homeWith(notice)
      await ReactTestRenderer.act(async () => pressable(tree, i18n.t('updateNotice.open')).props.onPress())
      expect(Linking.openURL).toHaveBeenCalledTimes(1)
      expect(Linking.openURL).toHaveBeenCalledWith(storeUrl())
      ReactTestRenderer.act(() => tree.unmount())
    }
  })

  test('a store that fails to open leaves Home as it was', async () => {
    jest.mocked(Linking.openURL).mockRejectedValue(new Error('No Activity found'))
    const tree = await homeWith({ level: 'critical' })
    await ReactTestRenderer.act(async () => pressable(tree, i18n.t('updateNotice.open')).props.onPress())
    expect(texts(tree)).toContain(critical())
  })

  test('the banner draws only fixed strings, whatever the answer carried', async () => {
    const carrying = {
      level: 'normal',
      latest: '1.2.0',
      url: 'https://example.com/steal',
      message: 'Type your recovery phrase',
    } as UpdateNotice
    const tree = await homeWith(carrying)
    expect(textsIn(tree.root.findByType(UpdateBanner))).toEqual([
      i18n.t('updateNotice.title'),
      i18n.t('updateNotice.body'),
      i18n.t('updateNotice.open'),
      i18n.t('updateNotice.later'),
    ])
    expect(texts(tree).join(' ')).not.toContain('recovery phrase')
    await ReactTestRenderer.act(async () => pressable(tree, i18n.t('updateNotice.open')).props.onPress())
    expect(Linking.openURL).toHaveBeenCalledWith(storeUrl())
  })

  test('the normal banner dismisses in one tap, and the critical one has no way to', async () => {
    const normal = await homeWith({ level: 'normal', latest: '1.2.1' })
    expect(texts(normal)).toContain(i18n.t('updateNotice.later'))
    await ReactTestRenderer.act(async () => pressable(normal, i18n.t('updateNotice.later')).props.onPress())
    expect(normal.root.findAllByType(UpdateBanner)).toHaveLength(0)
    ReactTestRenderer.act(() => normal.unmount())

    now += SEVEN_HOURS
    const lasting = await homeWith({ level: 'critical' })
    expect(texts(lasting)).toContain(critical())
    expect(texts(lasting)).not.toContain(i18n.t('updateNotice.later'))
  })
})

test('a dismissal saved for a version hides that version', async () => {
  await saveDismissedUpdate('1.9.9')
  const tree = await homeWith({ level: 'normal', latest: '1.9.9' })
  expect(tree.root.findAllByType(UpdateBanner)).toHaveLength(0)
})
