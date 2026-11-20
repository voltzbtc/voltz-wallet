import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Text } from 'react-native'
import i18n from '../src/i18n'
import { LnAddressScreen } from '../src/screens/LnAddressScreen'
import { Skeleton } from '../src/components/Skeleton'
import { Spinner } from '../src/components/GradientButton'
import {
  sparkAuthorizeLnAddressTransfer,
  sparkEnsureLnAddress,
  sparkGetIdentityPubkey,
} from '../src/wallet/spark'
import { returnActiveWallet } from '../src/wallet/deletion'
import { font, space } from '../src/theme'

// How the address screen loads, copies and waits. The address lifecycle and the move itself are
// covered by lnAddressScreen.test.tsx; these cases read what the screen shows meanwhile.
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    const React_ = jest.requireActual('react')
    React_.useEffect(cb, [])
  },
}))

jest.mock('../src/wallet/spark', () => ({
  // The withdrawal section the screen draws reads and listens for the connected wallet.
  sparkConnectedWalletId: () => null,
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

jest.mock('../src/wallet/wallet', () => ({
  ...jest.requireActual('../src/wallet/wallet'),
  switchWalletAndConnect: jest.fn(async () => undefined),
  reconnectActiveWallet: jest.fn(async () => undefined),
}))

type PickerProps = { visible: boolean; onPick: (walletId: string) => void }
let mockPicker: PickerProps | null = null
jest.mock('../src/components/WalletPickerSheet', () => ({
  WalletPickerSheet: (props: PickerProps) => {
    mockPicker = props
    return null
  },
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))

jest.mock('../src/wallet/domainTier', () => ({
  ...jest.requireActual('../src/wallet/domainTier'),
  readDomainState: jest.fn(async () => null),
}))

jest.mock('../src/wallet/deletion', () => ({
  ...jest.requireActual('../src/wallet/deletion'),
  returnActiveWallet: jest.fn(),
}))

// Answers yes to whatever the screen asks, while a test says so.
let mockConfirms = false
jest.mock('../src/components/ConfirmSheet', () => {
  const react = require('react')
  return {
    ConfirmSheet: ({ request }: { request: { onConfirm: () => void } | null }) => {
      react.useEffect(() => {
        if (request && mockConfirms) {
          request.onConfirm()
        }
      }, [request])
      return null
    },
  }
})

const QR_SIZE = 180
const ADDRESS = { username: 'alice', address: 'alice@breez.tips', lnurl: 'lnurl1abc' }

async function flush(ticks = 6): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (let tick = 0; tick < ticks; tick += 1) {
      await Promise.resolve()
    }
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LnAddressScreen />)
  })
  await flush()
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

const row = (tree: ReactTestRenderer.ReactTestRenderer, key: string) =>
  tree.root.findAll(n => n.props.label === i18n.t(key) && typeof n.props.onPress === 'function')[0]

beforeEach(() => {
  jest.clearAllMocks()
  mockPicker = null
  mockConfirms = false
  jest.mocked(sparkEnsureLnAddress).mockResolvedValue(ADDRESS)
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue(`02${'a'.repeat(64)}`)
})

afterEach(() => jest.restoreAllMocks())

it('loads in the shape of the framed code and the address under it', async () => {
  jest.mocked(sparkEnsureLnAddress).mockReturnValue(new Promise(() => undefined))
  const tree = await render()
  const bars = tree.root.findAllByType(Skeleton).map(n => [n.props.width, n.props.height])
  expect(bars).toEqual([
    [QR_SIZE + space.md * 2, QR_SIZE + space.md * 2],
    [QR_SIZE, font.leading.sm],
    [QR_SIZE * 0.55, font.leading.xs],
  ])
})

it('says Copied to a screen reader when the address is copied', async () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
  const tree = await render()
  const target = tree.root.find(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('receive.copy'),
  )
  await ReactTestRenderer.act(async () => target.props.onPress())
  expect(announce).toHaveBeenCalledWith(i18n.t('receive.copied'))
})

// The row keeps naming what it does while the move runs, with a spinner beside it, rather than
// turning into a step word that names no action.
it('keeps the move row\'s label with a spinner beside it while the move runs', async () => {
  jest.mocked(sparkAuthorizeLnAddressTransfer).mockReturnValue(new Promise(() => undefined))
  const tree = await render()
  expect(row(tree, 'receive.lnTransfer')!.props.right).toBeUndefined()
  await ReactTestRenderer.act(async () => row(tree, 'receive.lnTransfer')!.props.onPress())
  // The move never answers here, so its promise is left running rather than awaited.
  await ReactTestRenderer.act(async () => {
    mockPicker?.onPick('w_other')
  })
  await flush(10)

  const moving = row(tree, 'receive.lnTransfer')
  expect(moving).toBeDefined()
  expect(moving!.findAllByType(Spinner)).toHaveLength(1)
  expect(texts(tree)).not.toContain(i18n.t('receive.lnTransferring'))
})

it('keeps the create-again row\'s label with a spinner beside it while it runs', async () => {
  jest.mocked(returnActiveWallet).mockReturnValue(new Promise(() => undefined))
  mockConfirms = true
  const tree = await render()
  await ReactTestRenderer.act(async () => row(tree, 'receive.lnRemove')!.props.onPress())
  await flush()
  await ReactTestRenderer.act(async () => row(tree, 'receive.lnRecreate')!.props.onPress())
  await flush()

  const creating = row(tree, 'receive.lnRecreate')
  expect(creating).toBeDefined()
  expect(creating!.findAllByType(Spinner)).toHaveLength(1)
  expect(texts(tree)).not.toContain(i18n.t('receive.lnRecreating'))
})
