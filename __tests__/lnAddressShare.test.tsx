import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Share, Text } from 'react-native'
import RNFS from 'react-native-fs'
import QRCode from 'react-native-qrcode-svg'
import i18n from '../src/i18n'
import { LnAddressScreen } from '../src/screens/LnAddressScreen'
import { AddressShareSheet } from '../src/components/AddressShareSheet'
import { GradientButton } from '../src/components/GradientButton'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import { ReceiveHeldByExit } from '../src/wallet/errors'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { sparkEnsureLnAddress, type SparkLnAddress } from '../src/wallet/spark'
import { CARD_FILE } from '../src/wallet/addressCard'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { planOf } from './support/exitFixtures'

// Share on the lightning address screen offers the address as a card with its code, and as text. It
// shows only the address the screen shows as current, only while no exit holds the wallet, and a
// failure leaves one line and a usable screen.

jest.mock('../src/wallet/spark', () => ({
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  onSparkConnected: () => () => undefined,
  sparkEnsureLnAddress: jest.fn(async () => null),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkAuthorizeLnAddressTransfer: jest.fn(),
  sparkClaimLnAddressTransfer: jest.fn(),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: jest.fn(() => 'usevoltz.app'),
}))
jest.mock('../src/wallet/domainTier', () => ({
  ...jest.requireActual('../src/wallet/domainTier'),
  readDomainState: jest.fn(async () => null),
}))
jest.mock('../src/components/WalletPickerSheet', () => ({ WalletPickerSheet: () => null }))
// Each focus effect the screen registers, newest last, so a test can focus the screen again.
const mockFocus: (() => void | (() => void))[] = []
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: jest.fn() }),
    useRoute: () => ({ params: undefined }),
    useFocusEffect: (effect: () => void | (() => void)) => {
      mockFocus.push(effect)
      react.useEffect(effect, [effect])
    },
  }
})

// The card is react-native-svg under Jest, whose toDataURL reaches a native module. This stand-in keeps
// the props it was drawn with and answers toDataURL as the test says.
type CardProps = { address: string; qrValue: string; invite: string }
const mockCards: CardProps[] = []
let mockDraw: (done: (png: string) => void) => void = done => done('iVBORw0KGgo=')
jest.mock('../src/components/AddressCard', () => {
  const react = require('react')
  return {
    AddressCard: react.forwardRef((props: CardProps, ref: unknown) => {
      react.useImperativeHandle(ref, () => ({
        toDataURL: (done: (png: string) => void) => mockDraw(done),
      }))
      mockCards.push(props)
      return null
    }),
  }
})

const ADDR: SparkLnAddress = {
  username: 'satoshi',
  address: 'satoshi@usevoltz.app',
  lnurl: 'lnurl1satoshi',
}
const OTHER: SparkLnAddress = { username: 'hal', address: 'hal@usevoltz.app', lnurl: 'lnurl1hal' }

let mounted: ReactTestRenderer.ReactTestRenderer | null = null

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < 4; tick += 1) {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LnAddressScreen />)
  })
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

const button = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
  tree.root.findAllByType(GradientButton).find(node => node.props.label === label)

const sheetCard = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findByType(AddressShareSheet).props.card

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const found = button(tree, label)
  if (!found) {
    throw new Error(`no button ${label}`)
  }
  await ReactTestRenderer.act(async () => found.props.onPress())
  await flush()
}

async function openSheet(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await press(tree, i18n.t('receive.share'))
  expect(sheetCard(tree)).toEqual({ address: ADDR.address, lnurl: ADDR.lnurl })
}

async function startExit(): Promise<void> {
  await saveExitPlan(planOf({ walletId: 'primary' }))
}

beforeEach(async () => {
  mockFocus.length = 0
  mockCards.length = 0
  mockDraw = done => done('iVBORw0KGgo=')
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  __setEmergencyExitLiveForTests(true)
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ADDR)
  jest.mocked(getActiveWalletId).mockImplementation(async () => 'primary')
  await forgetExitPlan('primary')
})

afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
  jest.restoreAllMocks()
  __setEmergencyExitLiveForTests(null)
})

describe('Share is offered only beside a current address', () => {
  test('not while the address is being read', async () => {
    jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => undefined))
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
    expect(sheetCard(tree)).toBeNull()
  })

  test('not when the read failed', async () => {
    jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new Error('offline'))
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
  })

  test('not when the wallet has no address', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(null)
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
  })

  test('beside the address, and the card it opens is that address with the code the screen draws', async () => {
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))?.props.disabled).toBe(false)
    await openSheet(tree)
    const screenCode = tree.root.findByType(QRCode).props.value
    const drawn = mockCards[mockCards.length - 1]
    expect(drawn.address).toBe(ADDR.address)
    expect(drawn.qrValue).toBe(screenCode)
    expect(drawn.invite).toBe(i18n.t('receive.lnShareInvite'))
  })

  test('a press whose hold read answers after the address moved on draws no card at all', async () => {
    const tree = await render()
    let release: ((id: string) => void) | null = null
    jest.mocked(getActiveWalletId).mockImplementation(
      () =>
        new Promise<string>(resolve => {
          release = resolve
        }),
    )
    const share = button(tree, i18n.t('receive.share'))
    await ReactTestRenderer.act(async () => share?.props.onPress())
    const sheet = tree.root.findByType(LnAddressSheet)
    await ReactTestRenderer.act(async () => sheet.props.onRegistered(OTHER))
    await ReactTestRenderer.act(async () => release?.('primary'))
    await flush()
    expect(sheetCard(tree)).toBeNull()
    expect(mockCards).toEqual([])
  })

  test('the sheet closes when the screen address moves to another name, and never shows the new one', async () => {
    const tree = await render()
    await openSheet(tree)
    const sheet = tree.root.findByType(LnAddressSheet)
    await ReactTestRenderer.act(async () => sheet.props.onRegistered(OTHER))
    await flush()
    expect(sheetCard(tree)).toBeNull()
    expect(mockCards.some(card => card.address === OTHER.address)).toBe(false)
  })
})

describe('an exit holds the card', () => {
  test('a live exit read on focus offers no share and says why', async () => {
    jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ADDR)
    await startExit()
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })

  test('the address card is not drawn either while the exit holds the wallet', async () => {
    await startExit()
    const tree = await render()
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
  })

  test('while the focus read is in flight Share stays off', async () => {
    await startExit()
    // The plan's reads wait until the test lets them go, since the file's queue holds every later one.
    const waiting: (() => void)[] = []
    const real = RNFS.readFile
    jest.spyOn(RNFS, 'readFile').mockImplementation((path: string, encoding?: string) =>
      path.includes('exit-plan-')
        ? new Promise<string>((resolve, reject) => {
            waiting.push(() => real(path, encoding).then(resolve, reject))
          })
        : real(path, encoding),
    )
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))?.props.disabled).toBe(true)
    await ReactTestRenderer.act(async () => button(tree, i18n.t('receive.share'))?.props.onPress())
    await flush()
    expect(sheetCard(tree)).toBeNull()
    await ReactTestRenderer.act(async () => waiting.splice(0).forEach(release => release()))
    await flush()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })

  test('an exit that starts after the focus read is read again at the press of Share', async () => {
    const tree = await render()
    await startExit()
    await press(tree, i18n.t('receive.share'))
    expect(sheetCard(tree)).toBeNull()
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })

  test('and again at the press that sends the card, which then sends nothing', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await openSheet(tree)
    await startExit()
    await press(tree, i18n.t('receive.lnShareCard'))
    expect(share).not.toHaveBeenCalled()
    expect(sheetCard(tree)).toBeNull()
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })

  test('and at the press that sends the text', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await openSheet(tree)
    await startExit()
    await press(tree, i18n.t('receive.lnShareText'))
    expect(share).not.toHaveBeenCalled()
  })

  // The exit's own screen opens over this one, so an exit can start while it sits in the stack.
  test('an exit started while the screen sat under another is read on the next focus', async () => {
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))?.props.disabled).toBe(false)
    await startExit()
    await ReactTestRenderer.act(async () => {
      mockFocus.slice().forEach(effect => effect())
    })
    await flush()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
    expect(tree.root.findAllByType(QRCode)).toHaveLength(0)
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })

  test('an ensure the exit refused leaves no address and no share', async () => {
    jest.mocked(sparkEnsureLnAddress).mockRejectedValue(new ReceiveHeldByExit('exit'))
    const tree = await render()
    expect(button(tree, i18n.t('receive.share'))).toBeUndefined()
    expect(shown(tree)).toContain(i18n.t('emergencyExit.receiveHeld'))
  })
})

describe('sending', () => {
  test('the card goes out with the address drawn and a text that carries it', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await openSheet(tree)
    await press(tree, i18n.t('receive.lnShareCard'))
    expect(share).toHaveBeenCalledWith(
      {
        url: `file://${CARD_FILE}`,
        message: i18n.t('receive.lnShareMessage', { address: ADDR.address }),
      },
      { subject: i18n.t('receive.lnShareTitle') },
    )
    expect(i18n.t('receive.lnShareMessage', { address: ADDR.address })).toContain(ADDR.address)
    expect(shown(tree)).not.toContain(i18n.t('receive.lnShareFailed'))
  })

  test('the text goes out alone', async () => {
    const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' } as never)
    const tree = await render()
    await openSheet(tree)
    await press(tree, i18n.t('receive.lnShareText'))
    expect(share).toHaveBeenCalledWith({
      message: i18n.t('receive.lnShareMessage', { address: ADDR.address }),
    })
  })

  test('a share that fails says so in one line and leaves both buttons ready', async () => {
    jest.spyOn(Share, 'share').mockRejectedValue(new Error('no presenter'))
    jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    const tree = await render()
    await openSheet(tree)
    await press(tree, i18n.t('receive.lnShareCard'))
    expect(shown(tree)).toContain(i18n.t('receive.lnShareFailed'))
    expect(button(tree, i18n.t('receive.lnShareCard'))?.props.loading).toBe(false)
    expect(button(tree, i18n.t('receive.lnShareCard'))?.props.disabled).toBe(false)
    expect(button(tree, i18n.t('receive.lnShareText'))?.props.disabled).toBe(false)
  })

  test('a card that never finishes drawing fails after a wait rather than spinning on', async () => {
    jest.useFakeTimers({ doNotFake: ['setImmediate', 'nextTick', 'queueMicrotask'] })
    try {
      mockDraw = () => undefined
      const share = jest
        .spyOn(Share, 'share')
        .mockResolvedValue({ action: 'sharedAction' } as never)
      jest.spyOn(console, 'warn').mockImplementation(() => undefined)
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(<LnAddressScreen />)
      })
      mounted = tree
      for (let i = 0; i < 6; i += 1) {
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(1)
          await Promise.resolve()
        })
      }
      const open = button(tree, i18n.t('receive.share'))
      await ReactTestRenderer.act(async () => open?.props.onPress())
      for (let i = 0; i < 6; i += 1) {
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(1)
          await Promise.resolve()
        })
      }
      const send = button(tree, i18n.t('receive.lnShareCard'))
      await ReactTestRenderer.act(async () => send?.props.onPress())
      for (let i = 0; i < 6; i += 1) {
        await ReactTestRenderer.act(async () => {
          jest.advanceTimersByTime(1)
          await Promise.resolve()
        })
      }
      expect(button(tree, i18n.t('receive.lnShareCard'))?.props.loading).toBe(true)
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(5_000)
        await Promise.resolve()
      })
      for (let i = 0; i < 6; i += 1) {
        await ReactTestRenderer.act(async () => {
          await Promise.resolve()
        })
      }
      expect(shown(tree)).toContain(i18n.t('receive.lnShareFailed'))
      expect(button(tree, i18n.t('receive.lnShareCard'))?.props.loading).toBe(false)
      expect(share).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('a share sends the address the sheet drew, even when the screen read a newer one meanwhile', async () => {
    let answerShare: (() => void) | null = null
    const share = jest.spyOn(Share, 'share').mockImplementation(
      () =>
        new Promise(resolve => {
          answerShare = () => resolve({ action: 'sharedAction' } as never)
        }),
    )
    const tree = await render()
    await openSheet(tree)
    const send = button(tree, i18n.t('receive.lnShareCard'))
    await ReactTestRenderer.act(async () => send?.props.onPress())
    await flush()
    const sheet = tree.root.findByType(LnAddressSheet)
    await ReactTestRenderer.act(async () => sheet.props.onRegistered(OTHER))
    await flush()
    expect(share).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(share.mock.calls[0])).toContain(ADDR.address)
    expect(JSON.stringify(share.mock.calls[0])).not.toContain(OTHER.address)
    await ReactTestRenderer.act(async () => answerShare?.())
  })
})
