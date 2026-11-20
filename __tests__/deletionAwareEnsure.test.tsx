import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import RNFS from 'react-native-fs'
import '../src/i18n'
import { ReceiveSpark } from '../src/screens/ReceiveSpark'
import { DomainScreen } from '../src/screens/DomainScreen'
import { sparkEnsureLnAddress } from '../src/wallet/spark'
import { deletionMarkFor } from '../src/wallet/deletionMark'

// The receive and domain screens ask for the address through ensureLnAddressOrAdopt, so a key the
// gateway refuses as deleted while this device holds no mark gets its status read once and the mark
// written, rather than no address and no reason. Their own test files stub the ensure itself; here
// deletion.ts runs for real against a gateway double.
jest.mock('../src/config', () => ({
  ...jest.requireActual('../src/config'),
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('react-native-localize', () => ({
  ...jest.requireActual('react-native-localize/mock'),
  getCountry: () => 'BR',
}))
const PUBKEY = `02${'a'.repeat(64)}`
jest.mock('../src/wallet/spark', () => ({
  // The withdrawal section the screen draws reads and listens for the connected wallet.
  onSparkConnected: () => () => undefined,
  sparkReceive: jest.fn(),
  sparkGetFiatRates: jest.fn(async () => ({})),
  sparkEnsureLnAddress: jest.fn(),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 0, tokens: [] })),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkListFiatCurrencies: jest.fn(async () => []),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  connectActiveSpark: jest.fn(async () => undefined),
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  connectedLnurlDomain: jest.fn(() => 'usevoltz.app'),
  sparkInAddressTurn: jest.fn((work: () => Promise<unknown>) => work()),
  connectSpark: jest.fn(async () => undefined),
  disconnectSpark: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
  loadRegistry: jest.fn(async () => ({ active: 'primary', wallets: [] })),
}))
jest.mock('../src/wallet/domainTier', () => ({
  ...jest.requireActual('../src/wallet/domainTier'),
  readDomainState: jest.fn(async () => null),
}))
jest.mock('../src/components/WalletPickerSheet', () => ({ WalletPickerSheet: () => null }))
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), setOptions: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: {} }),
  // The real hook needs a navigation container; mounting stands for gaining focus.
  useFocusEffect: (cb: () => void | (() => void)) => {
    jest.requireActual('react').useEffect(cb, [])
  },
}))

// The gateway refusing the key, as SDK 0.27.2 hands an LNURL server answer back (lnRefusal.ts).
const refusedDeleted = () =>
  Object.assign(new Error('NetworkError'), {
    tag: 'NetworkError',
    inner: ['network request failed with status 409: {"error":"deleted"}'],
  })

let statusReads: Record<string, unknown>[] = []

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  statusReads = []
  global.fetch = jest.fn(async (url: string, init?: { body?: string }) => {
    const body = init?.body ? (JSON.parse(init.body) as Record<string, unknown>) : {}
    if (String(url).endsWith('/api/wallet/delete')) {
      statusReads.push(body)
      return { ok: true, status: 200, json: async () => ({ status: 'pending', requestedAt: 1_800_000_000, finishBy: 1_801_296_000 }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }) as unknown as typeof fetch
  jest.mocked(sparkEnsureLnAddress).mockReset().mockRejectedValue(refusedDeleted())
})

let mounted: ReactTestRenderer.ReactTestRenderer | null = null
afterEach(() => {
  ReactTestRenderer.act(() => {
    mounted?.unmount()
  })
  mounted = null
})

async function mount(element: React.ReactElement): Promise<void> {
  await ReactTestRenderer.act(async () => {
    mounted = ReactTestRenderer.create(element)
  })
  for (let i = 0; i < 10; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
  }
}

test.each([
  ['Receive', () => <ReceiveSpark />],
  ['Domain', () => <DomainScreen />],
])('%s reads the deletion status once when the gateway refuses the key as deleted', async (_name, screen) => {
  await mount(screen())
  expect(sparkEnsureLnAddress).toHaveBeenCalledTimes(1)
  expect(statusReads.map(b => b.action)).toEqual(['status'])
  expect(statusReads[0]?.pubkey).toBe(PUBKEY)
  expect((await deletionMarkFor('primary'))?.state).toBe('pending')
})
