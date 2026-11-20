import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import RNFS from 'react-native-fs'
import { connect } from '@breeztech/breez-sdk-spark-react-native'
import '../src/i18n'
import { useStableSwitch, type StableSwitch } from '../src/hooks/useStableSwitch'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import { forgetExitPlan, saveExitPlan } from '../src/wallet/exitPlan'
import { connectActiveSpark, disconnectSpark } from '../src/wallet/spark'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { planOf } from './support/exitFixtures'

// Runs on the real spark.ts: what decides is which connection the switch lands on once an exit ended,
// and only the real connect turn replaces the held one.

jest.mock('../src/config', () => ({
  getBreezSparkApiKey: () => 'test-spark-api-key',
  getBreezLnurlDomain: () => 'usevoltz.app',
}))
jest.mock('../src/wallet/seed', () => ({
  loadSeedFor: jest.fn(async () => 'abandon '.repeat(11) + 'about'),
  loadPassphraseFor: jest.fn(async () => undefined),
  PRIMARY_ID: 'primary',
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
  ensureRegistered: jest.fn(),
}))
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonic: jest.fn(() => 'fp'),
  fingerprintFromMnemonicAsync: jest.fn(async () => 'fp'),
}))
jest.mock('../src/wallet/lnurlDomainPref', () => ({
  ...jest.requireActual('../src/wallet/lnurlDomainPref'),
  domainFor: jest.fn(async () => undefined),
}))

const PUB = `02${'b'.repeat(64)}`
const sdk = (
  jest.requireMock('@breeztech/breez-sdk-spark-react-native') as {
    __sdkInstance: Record<'getInfo' | 'updateUserSettings', jest.Mock>
  }
).__sdkInstance

const configs = () =>
  (jest.mocked(connect).mock.calls as unknown as [{ config: Record<string, unknown> }][]).map(([arg]) => arg.config)

let stable: StableSwitch | null = null

function Probe(): null {
  stable = useStableSwitch()
  return null
}

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  await disconnectSpark()
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(connect).mockResolvedValue(sdk as never)
  sdk.getInfo.mockResolvedValue({ identityPubkey: PUB, balanceSats: 0n, tokenBalances: new Map() })
  await forgetExitPlan('primary')
})

afterEach(async () => {
  await disconnectSpark()
  __setEmergencyExitLiveForTests(null)
})

// The held connection has no stable balance, and the SDK refuses to turn on what it was not built with,
// so a tap that lands on it fails until something else asks for a connection.
test('a tap right after the exit ended turns the mode on through a connection that has it', async () => {
  await saveExitPlan(planOf({ walletId: 'primary' }))
  await connectActiveSpark()
  expect(configs().at(-1)?.stableBalanceConfig).toBeUndefined()
  const held = configs().length
  await saveExitPlan(planOf({ walletId: 'primary', verdict: 'done' }))

  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  await ReactTestRenderer.act(async () => stable?.ask(true))
  await ReactTestRenderer.act(async () => {
    await stable?.confirm()
  })

  expect(stable?.error).toBeNull()
  expect(configs()).toHaveLength(held + 1)
  expect(configs().at(-1)?.stableBalanceConfig).toBeDefined()
  expect(sdk.updateUserSettings).toHaveBeenCalledTimes(1)
  const opened = jest.mocked(connect).mock.invocationCallOrder.at(-1) as number
  expect(opened).toBeLessThan(sdk.updateUserSettings.mock.invocationCallOrder[0])
  await ReactTestRenderer.act(async () => tree.unmount())
})

// With no exit behind it, the same tap keeps the connection it has.
test('a tap with no exit behind it opens no new connection', async () => {
  await connectActiveSpark()
  const before = configs().length

  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<Probe />)
  })
  await ReactTestRenderer.act(async () => stable?.ask(true))
  await ReactTestRenderer.act(async () => {
    await stable?.confirm()
  })

  expect(configs()).toHaveLength(before)
  expect(sdk.updateUserSettings).toHaveBeenCalledTimes(1)
  await ReactTestRenderer.act(async () => tree.unmount())
})
