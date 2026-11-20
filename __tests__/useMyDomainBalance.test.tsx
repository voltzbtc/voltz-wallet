import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import '../src/i18n'
import i18n from 'i18next'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { claimDomain, fetchPrices, quoteDomain } from '../src/wallet/domainOnboard'
import { sparkConfirmSend, sparkSyncedBalanceSat } from '../src/wallet/spark'

// The balance read before a domain is paid for. A read that throws is the same unknown as one that
// answers nothing, and the cases for the answers live in useMyDomainScreen.test.tsx.
jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(async () => ({ handle: 'h-1', amount: 199800, fee: 0 })),
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkGetBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(async () => 'complete'),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => null),
}))

jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: undefined }) }))

jest.mock('../src/wallet/domainOnboard', () => ({
  ...jest.requireActual('../src/wallet/domainOnboard'),
  claimDomain: jest.fn(),
  quoteDomain: jest.fn(),
  confirmDomain: jest.fn(),
  fetchPrices: jest.fn(),
}))

// The mock is an ES default export, so the CommonJS require hands back the module wrapper.
const RNFS = (
  require('react-native-fs') as {
    default: { DocumentDirectoryPath: string; exists(p: string): Promise<boolean>; unlink(p: string): Promise<void> }
  }
).default
const FILE = `${RNFS.DocumentDirectoryPath}/domain-purchase.json`

function texts(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => [node.props.children].flat().filter((c: unknown): c is string => typeof c === 'string'))
    .join(' ')
}

async function settle(tree?: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
      tree?.update(<UseMyDomainScreen />)
    })
  }
}

function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  const target = tree.root
    .findAll(node => typeof node.props.onPress === 'function')
    .find(node => node.findAllByType(Text).some(text => text.props.children === label))
  if (!target) {
    throw new Error(`button not found: ${label}`)
  }
  target.props.onPress()
}

beforeEach(async () => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.mocked(fetchPrices).mockResolvedValue({ domain_tier: 9990 })
  if (await RNFS.exists(FILE)) {
    await RNFS.unlink(FILE)
  }
})

afterEach(() => {
  jest.useRealTimers()
})

it('sends nothing when the synced balance read throws, and says it could not be checked', async () => {
  jest.mocked(claimDomain).mockRejectedValueOnce(new Error('domain_tier_not_paid'))
  jest.mocked(quoteDomain).mockResolvedValue({
    host: 'pay.bakery.com.br',
    priceUsdCents: 9990,
    days: 365,
    amountSats: 199800,
    invoice: 'lnbc1',
    reference: 'ref-1',
    expiresAt: Math.floor(Date.now() / 1000) + 600,
  })
  jest.mocked(sparkSyncedBalanceSat).mockRejectedValueOnce(new Error('SdkError.NetworkError'))
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
  })
  await settle()
  await ReactTestRenderer.act(async () => press(tree, 'Continue'))
  await settle(tree)
  await ReactTestRenderer.act(async () => press(tree, 'Pay'))
  await settle(tree)

  expect(sparkSyncedBalanceSat).toHaveBeenCalledTimes(1)
  expect(texts(tree)).toContain(i18n.t('useDomain.balanceUnchecked'))
  expect(sparkConfirmSend).not.toHaveBeenCalled()
  expect(await RNFS.exists(FILE)).toBe(false)
})
