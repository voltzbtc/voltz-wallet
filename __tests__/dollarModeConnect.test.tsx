import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { readdirSync, readFileSync, statSync } from 'fs'
import { join, relative } from 'path'
import * as binding from '@breeztech/breez-sdk-spark-react-native'
import { DollarModeProvider, useDollarMode } from '../src/wallet/dollarMode'
import { connectSpark, disconnectSpark } from '../src/wallet/spark'
import { fingerprintFromMnemonicAsync } from '../src/wallet/fingerprint'
import { STABLE_BALANCE_LABEL, USDB } from '../src/wallet/tokens'

// Runs on the real spark.ts, which is what refuses a subscription made before connect. A stub that
// resolves it, as dollarMode.test.tsx does, cannot see a provider that mounts first.
jest.mock('../src/wallet/wallet', () => ({ onActiveWalletChanged: () => () => undefined }))
jest.mock('../src/wallet/settings', () => ({
  ...jest.requireActual('../src/wallet/settings'),
  loadDollarMode: jest.fn(async () => false),
  saveDollarMode: jest.fn(async () => undefined),
}))
jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => 'primary'),
}))

// Real words of a given wallet never enter a test, so the fingerprint is what is doubled.
jest.mock('../src/wallet/fingerprint', () => ({
  fingerprintFromMnemonicAsync: jest.fn(),
}))

const MNEMONIC = 'abandon '.repeat(11) + 'about'
const LABEL_ON = {
  sparkPrivateModeEnabled: true,
  stableBalanceActiveLabel: 'USD',
  sparkMasterIdentityPublicKey: undefined,
}

type Listener = { onEvent: (event: unknown) => Promise<void> }
const mocked = (binding as unknown as { __sdkInstance: Record<string, jest.Mock> }).__sdkInstance

let mounted: ReactTestRenderer.ReactTestRenderer | null = null

beforeEach(() => {
  jest.mocked(fingerprintFromMnemonicAsync).mockResolvedValue('73c5da0a')
})

afterEach(async () => {
  await ReactTestRenderer.act(async () => {
    mounted?.unmount()
    await disconnectSpark()
  })
  mounted = null
})

function Probe(): React.JSX.Element {
  return <Text>{String(useDollarMode())}</Text>
}

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setImmediate(resolve))
    })
  }
}

async function mountThenConnect(): Promise<{
  flag: () => unknown
  listeners: Listener[]
}> {
  const listeners: Listener[] = []
  mocked.addEventListener = jest.fn(async (listener: Listener) => {
    listeners.push(listener)
    return `listener-${listeners.length}`
  })
  mocked.getInfo = jest.fn(async () => ({
    identityPubkey: '02ab',
    balanceSats: 0n,
    tokenBalances: new Map(),
  }))
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = mounted = ReactTestRenderer.create(
      <DollarModeProvider initial={false}>
        <Probe />
      </DollarModeProvider>,
    )
  })
  await settle()
  expect(mocked.addEventListener).not.toHaveBeenCalled()
  await ReactTestRenderer.act(async () => {
    await connectSpark(MNEMONIC, 'primary')
  })
  await settle()
  return { flag: () => tree.root.findByType(Text).props.children, listeners }
}

// Past the gathering of a burst, which is what reads the mode.
async function fire(listeners: Listener[]): Promise<void> {
  await ReactTestRenderer.act(async () => {
    for (const listener of listeners) {
      await listener.onEvent({ tag: 'Synced' })
    }
    await new Promise(resolve => setTimeout(resolve, 650))
  })
  await settle()
}

test('a provider mounted before connect reads the mode at connect', async () => {
  mocked.getUserSettings = jest.fn().mockResolvedValue(LABEL_ON)

  const { flag } = await mountThenConnect()

  expect(flag()).toBe('true')
})

test('a read that fails at connect is corrected by a later SDK event', async () => {
  mocked.getUserSettings = jest
    .fn()
    .mockRejectedValueOnce(new Error('network'))
    .mockRejectedValueOnce(new Error('network'))
    .mockResolvedValue(LABEL_ON)

  const { flag, listeners } = await mountThenConnect()
  expect(mocked.getUserSettings).toHaveBeenCalledTimes(1)
  expect(flag()).toBe('false')

  await fire(listeners)
  expect(mocked.getUserSettings.mock.calls.length).toBeGreaterThanOrEqual(2)

  await fire(listeners)
  expect(flag()).toBe('true')
})

// The SDK sweeps sats only while this install's label is on, so the label off stays off unless the
// switch writes it. Reading the mode in any number of places never writes it.
test('connecting and hearing events never writes the label', async () => {
  mocked.updateUserSettings = jest.fn(async () => undefined)
  mocked.getUserSettings = jest.fn().mockResolvedValue({
    ...LABEL_ON,
    stableBalanceActiveLabel: undefined,
  })

  const { flag, listeners } = await mountThenConnect()
  await fire(listeners)

  expect(flag()).toBe('false')
  expect(mocked.updateUserSettings).not.toHaveBeenCalled()
})

function connectedConfig(): { stableBalanceConfig?: unknown } {
  const calls = jest.mocked(binding.connect).mock.calls
  return calls[calls.length - 1][0].config as { stableBalanceConfig?: unknown }
}

// One rule builds every wallet's config, so the dollar config comes with every connect and the
// person's own switch decides the mode. No fingerprint connects any other way.
describe('every wallet connects with the same config', () => {
  beforeEach(() => {
    mocked.getUserSettings = jest.fn().mockResolvedValue(LABEL_ON)
  })

  async function configAt(fingerprint: string): Promise<{ stableBalanceConfig?: unknown }> {
    jest.mocked(fingerprintFromMnemonicAsync).mockResolvedValue(fingerprint)
    await ReactTestRenderer.act(async () => {
      await disconnectSpark()
      await connectSpark(MNEMONIC, 'primary')
    })
    return connectedConfig()
  }

  test.each(['73c5da0a', '0f1e2d3c'])('the wallet %s connects with the dollar config', async fingerprint => {
    const config = await configAt(fingerprint)

    expect(config.stableBalanceConfig).toMatchObject({
      tokens: [{ label: STABLE_BALANCE_LABEL, tokenIdentifier: USDB.identifier }],
    })
  })

  // No wallet is singled out by its fingerprint: two wallets connect with configs that are equal.
  test('any two wallets connect with the same config, whatever their fingerprints', async () => {
    const other = await configAt('73c5da0a')
    const same = await configAt('0f1e2d3c')

    expect(same).toEqual(other)
  })
})

test('the one hook that writes the label is the switch', () => {
  const root = join(__dirname, '..')
  const sources = (dir: string): string[] =>
    readdirSync(dir).flatMap(name => {
      const path = join(dir, name)
      return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : []
    })
  const writers = sources(join(root, 'src'))
    .filter(path => /sparkSetStableBalance\(/.test(readFileSync(path, 'utf8')))
    .map(path => relative(root, path))
    .sort()

  expect(writers).toEqual(['src/hooks/useStableSwitch.ts', 'src/wallet/spark.ts'])
})
