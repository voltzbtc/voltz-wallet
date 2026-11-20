import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text, TextInput } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { RefundDepositScreen } from '../src/screens/RefundDepositScreen'
import {
  sparkListUnclaimedDeposits,
  sparkRecommendedFees,
  sparkRefundAddress,
  sparkRefundDeposit,
  type SparkDeposit,
} from '../src/wallet/spark'
import { depositsRereadLimitMs } from '../src/components/UnclaimedDepositsCard'
import { REFUND_VBYTES, noteRefundFee } from '../src/wallet/refund'
import { formatSats } from '../src/wallet/amount'
import { Skeleton } from '../src/components/Skeleton'

jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: 12_000,
  sparkListUnclaimedDeposits: jest.fn(),
  sparkRecommendedFees: jest.fn(),
  sparkRefundAddress: jest.fn(),
  sparkRefundDeposit: jest.fn(),
  sparkClaimDeposit: jest.fn(),
}))
jest.mock('../src/wallet/settings', () => ({
  ...jest.requireActual('../src/wallet/settings'),
  loadTxExplorers: jest.fn(async () => ({ selected: 'mempool', custom: [] })),
}))

const mockGoBack = jest.fn()
const mockPrevent: { on?: boolean } = {}
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ goBack: mockGoBack }),
  useRoute: () => ({ params: { txid: 'tx', vout: 1 } }),
  usePreventRemove: (on: boolean) => {
    mockPrevent.on = on
  },
}))

const stuck: SparkDeposit = {
  txid: 'tx',
  vout: 1,
  amountSat: 50_000,
  claimable: false,
  stage: 'stuck',
  refundable: true,
}
const rates = { fast: 10, medium: 5, slow: 1 }

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 0))
  })
}

async function mount(): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RefundDepositScreen />)
  })
  await flush()
  return tree as ReactTestRenderer.ReactTestRenderer
}

function shown(root: ReactTestRenderer.ReactTestRenderer): string {
  return root.root
    .findAllByType(Text)
    .flatMap(node => (Array.isArray(node.props.children) ? node.props.children : [node.props.children]))
    .filter(child => typeof child === 'string')
    .join(' ')
}

function button(root: ReactTestRenderer.ReactTestRenderer, label: string) {
  return root.root.findAll(
    n =>
      typeof n.props.onPress === 'function' &&
      n.findAllByType(Text).some(text => text.props.children === label),
  )[0]
}

async function press(root: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const target = button(root, label)
  if (!target) {
    throw new Error(`no button: ${label}\n${shown(root)}`)
  }
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
  })
  await flush()
}

async function type(root: ReactTestRenderer.ReactTestRenderer, text: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    root.root.findByType(TextInput).props.onChangeText(text)
  })
}

async function toReview(root: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await type(root, 'bc1qdest')
  await press(root, 'Continue')
}

beforeEach(() => {
  jest.clearAllMocks()
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  mockPrevent.on = undefined
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([stuck])
  jest.mocked(sparkRecommendedFees).mockReset()
  jest.mocked(sparkRecommendedFees).mockResolvedValue(rates)
  jest.mocked(sparkRefundAddress).mockReset()
  jest.mocked(sparkRefundAddress).mockImplementation(async input => input.trim())
  jest.mocked(sparkRefundDeposit).mockReset()
  jest.mocked(sparkRefundDeposit).mockResolvedValue('refundtx')
})

afterEach(() => {
  jest.useRealTimers()
  ReactTestRenderer.act(() => {
    tree?.unmount()
  })
  tree = null
})

test('what the review says arrives is the amount less the fixed fee sent to the SDK', async () => {
  const root = await mount()
  await toReview(root)

  const feeSat = rates.medium * REFUND_VBYTES
  expect(shown(root)).toContain(`${formatSats(50_000 - feeSat)} sats`)
  expect(shown(root)).toContain(`${formatSats(feeSat)} sats`)

  await press(root, 'Confirm send')
  expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qdest', feeSat)
})

test('the chosen speed sets the fee', async () => {
  const root = await mount()
  await press(root, 'Fast')
  await toReview(root)
  await press(root, 'Confirm send')

  expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qdest', rates.fast * REFUND_VBYTES)
})

test('the fee confirmed is the fee shown, with no second read of the rates', async () => {
  const root = await mount()
  await toReview(root)
  jest.mocked(sparkRecommendedFees).mockResolvedValue({ fast: 99, medium: 99, slow: 99 })
  await press(root, 'Confirm send')

  expect(sparkRecommendedFees).toHaveBeenCalledTimes(1)
  expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qdest', rates.medium * REFUND_VBYTES)
})

test('the destination is what the check resolved, not the text typed', async () => {
  jest.mocked(sparkRefundAddress).mockResolvedValue('bc1qresolved')
  const root = await mount()
  await type(root, 'bitcoin:bc1qresolved?amount=1')
  await press(root, 'Continue')
  await press(root, 'Confirm send')

  expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qresolved', expect.any(Number))
})

test('anything but a Bitcoin address stops before the review', async () => {
  jest.mocked(sparkRefundAddress).mockResolvedValue(null)
  const root = await mount()
  await toReview(root)

  expect(shown(root)).toContain(i18n.t('deposits.refundBadAddress'))
  expect(button(root, 'Confirm send')).toBeUndefined()
  expect(sparkRefundDeposit).not.toHaveBeenCalled()
})

test('Paste fills the address, and an empty read does nothing', async () => {
  jest.mocked(Clipboard.getString).mockResolvedValueOnce('').mockResolvedValueOnce(' bc1qpasted ')
  const root = await mount()
  await press(root, 'Paste')
  expect(root.root.findByType(TextInput).props.value).toBe('')

  await press(root, 'Paste')
  expect(root.root.findByType(TextInput).props.value).toBe('bc1qpasted')
})

test('two taps on Confirm send once', async () => {
  const held = deferred<string>()
  jest.mocked(sparkRefundDeposit).mockReturnValue(held.promise)
  const root = await mount()
  await toReview(root)

  const target = button(root, 'Confirm send')
  await ReactTestRenderer.act(async () => {
    target.props.onPress()
    target.props.onPress()
  })
  await flush()

  expect(sparkRefundDeposit).toHaveBeenCalledTimes(1)
  await ReactTestRenderer.act(async () => held.resolve('refundtx'))
})

test('Back does nothing while the refund runs', async () => {
  const held = deferred<string>()
  jest.mocked(sparkRefundDeposit).mockReturnValue(held.promise)
  const root = await mount()
  await toReview(root)
  expect(mockPrevent.on).toBe(false)

  await ReactTestRenderer.act(async () => {
    button(root, 'Confirm send').props.onPress()
  })
  await flush()
  expect(mockPrevent.on).toBe(true)

  await ReactTestRenderer.act(async () => held.resolve('refundtx'))
  await flush()
  expect(mockPrevent.on).toBe(false)
})

describe('an error from the refund', () => {
  const refused = () => jest.mocked(sparkRefundDeposit).mockRejectedValue(new Error('broadcast refused'))

  const signedOut: SparkDeposit = {
    ...stuck,
    stage: 'returning',
    refundable: false,
    refundTxId: 'r1',
    refundState: 'pending',
  }

  test('after signing, with no refusal on record, says in progress and offers nothing, never failed', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValue([signedOut])
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.returning'))
    expect(shown(root)).not.toContain(i18n.t('deposits.refundFailed'))
    expect(button(root, 'Confirm send')).toBeUndefined()
  })

  // The same words as Home and History, and the way out Home offers, since a rebroadcast at this fee
  // will not cure a refusal.
  test('after signing, a refusal on record says so and goes back to pick a higher fee', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockResolvedValue([{ ...signedOut, refundError: 'min relay fee not met' }])
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundStalled'))
    expect(shown(root)).not.toContain(i18n.t('deposits.returning'))
    expect(shown(root)).not.toContain(i18n.t('deposits.refundFailed'))
    expect(button(root, i18n.t('deposits.refundContinue'))).toBeDefined()

    jest.mocked(sparkRefundDeposit).mockResolvedValue('refundtx')
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValue([{ ...signedOut, refundError: 'min relay fee not met' }])
    await press(root, 'Fast')
    await toReview(root)
    await press(root, 'Confirm send')

    expect(sparkRefundDeposit).toHaveBeenLastCalledWith('tx', 1, 'bc1qdest', rates.fast * REFUND_VBYTES)
    expect(shown(root)).toContain('refundtx')
  })

  // The SDK keeps only the refusal's text, so the fee refused is the app's own record, read again after
  // a restart.
  test('after a refusal only a speed above the refused fee is offered, also after a restart', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    const stalled = { ...signedOut, refundError: 'min relay fee not met' }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValue([stalled])
    await press(root, 'Confirm send')

    expect(sparkRefundDeposit).toHaveBeenLastCalledWith('tx', 1, 'bc1qdest', rates.medium * REFUND_VBYTES)
    expect(button(root, 'Medium')).toBeUndefined()
    expect(button(root, 'Economy')).toBeUndefined()
    expect(button(root, 'Fast')).toBeDefined()

    await ReactTestRenderer.act(async () => {
      root.unmount()
    })
    const again = await mount()
    expect(shown(again)).toContain(i18n.t('deposits.refundStalled'))
    expect(button(again, 'Medium')).toBeUndefined()
    expect(button(again, 'Fast')).toBeDefined()
  })

  test('a fee that cannot be put on record signs nothing', async () => {
    const root = await mount()
    await toReview(root)
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('disk full'))
    await press(root, 'Confirm send')
    write.mockRestore()

    expect(sparkRefundDeposit).not.toHaveBeenCalled()
    expect(shown(root)).toContain(i18n.t('deposits.refundFailed'))
    expect(button(root, 'Confirm send')).toBeDefined()
  })

  // The refused one's id stays compared against the new read, or this would read as a fresh refusal.
  test('a second attempt the SDK turns down before signing stays on review and says to go faster', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    const stalled = { ...signedOut, refundError: 'min relay fee not met' }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValue([stalled])
    await press(root, 'Confirm send')
    await toReview(root)
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundFeeRefused'))
    expect(button(root, 'Confirm send')).toBeDefined()
  })

  test('before anything was signed says so, and Confirm stays', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundFailed'))
    expect(button(root, 'Confirm send')).toBeDefined()
  })

  test('with no list to read afterwards, says it could not confirm and offers nothing', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockRejectedValue(new Error('offline'))
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundUnconfirmed'))
    expect(button(root, 'Confirm send')).toBeUndefined()
  })

  test('with the deposit gone afterwards, says it is resolved', async () => {
    refused()
    const root = await mount()
    await toReview(root)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValue([])
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundGone'))
  })
})

describe('a refund already out', () => {
  const signed: SparkDeposit = {
    ...stuck,
    stage: 'returning',
    refundable: false,
    refundTxId: 'r1',
    refundState: 'pending',
  }

  test('one the network accepted opens to in progress, with no new refund', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...signed, refundState: 'broadcast' }])
    const root = await mount()

    expect(shown(root)).toContain(i18n.t('deposits.returning'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(0)
  })

  test('one still pending with no refusal is left to run', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([signed])
    const root = await mount()

    expect(shown(root)).toContain(i18n.t('deposits.returning'))
    expect(root.root.findAllByType(TextInput)).toHaveLength(0)
  })

  test('one the network refused says so and can go again at a higher fee', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...signed, refundError: 'min relay' }])
    const root = await mount()
    expect(shown(root)).toContain(i18n.t('deposits.refundStalled'))
    await press(root, 'Fast')
    await toReview(root)
    await press(root, 'Confirm send')

    expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qdest', rates.fast * REFUND_VBYTES)
    expect(shown(root)).toContain('refundtx')
  })

  test('with every rate today under the floor, the floor is offered as fast and is what is sent', async () => {
    await noteRefundFee('tx', 1, rates.fast * REFUND_VBYTES)
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...signed, refundError: 'min relay' }])
    const root = await mount()
    expect(button(root, 'Medium')).toBeUndefined()
    expect(button(root, 'Economy')).toBeUndefined()
    await toReview(root)
    await press(root, 'Confirm send')

    expect(sparkRefundDeposit).toHaveBeenCalledWith('tx', 1, 'bc1qdest', (rates.fast + 1) * REFUND_VBYTES)
  })

  test('a fee too low to replace it says to pick a faster speed, since nothing new was signed', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...signed, refundError: 'min relay' }])
    jest.mocked(sparkRefundDeposit).mockRejectedValue(new Error('fee too low'))
    const root = await mount()
    await toReview(root)
    await press(root, 'Confirm send')

    expect(shown(root)).toContain(i18n.t('deposits.refundFeeRefused'))
  })
})

test('a refused return too small for any speed leaves only the too small line', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
    { ...stuck, amountSat: 600, stage: 'returning', refundable: false, refundTxId: 'r1', refundState: 'pending', refundError: 'x' },
  ])
  const root = await mount()

  expect(shown(root)).toContain(i18n.t('deposits.refundTooSmall'))
  expect(shown(root)).not.toContain(i18n.t('deposits.refundStalled'))
})

test('a speed that leaves dust is not offered', async () => {
  // Fast costs 1,110 and leaves 390, medium costs 555 and leaves 945.
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...stuck, amountSat: 1_500 }])
  const root = await mount()

  expect(button(root, 'Fast')).toBeUndefined()
  expect(button(root, 'Medium')).toBeDefined()
  expect(button(root, 'Economy')).toBeDefined()
})

test('with every speed under dust it says so and signs nothing', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...stuck, amountSat: 600 }])
  const root = await mount()

  expect(shown(root)).toContain(i18n.t('deposits.refundTooSmall'))
  expect(button(root, 'Continue')).toBeUndefined()
  expect(root.root.findAllByType(TextInput)).toHaveLength(0)
})

test('a rate read that fails offers Try again and never a fallback rate', async () => {
  jest.mocked(sparkRecommendedFees).mockRejectedValueOnce(new Error('offline'))
  const root = await mount()

  expect(shown(root)).toContain(i18n.t('deposits.refundLoadFailed'))
  expect(button(root, 'Continue')).toBeUndefined()

  await press(root, 'Try again')
  expect(button(root, 'Continue')).toBeDefined()
})

test('a read that never answers ends in Try again rather than a skeleton', async () => {
  jest.mocked(sparkRecommendedFees).mockReturnValue(new Promise(() => undefined))
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<RefundDepositScreen />)
  })
  const root = tree as ReactTestRenderer.ReactTestRenderer
  expect(root.root.findAllByType(Skeleton).length).toBeGreaterThan(0)

  jest.useFakeTimers()
  jest.mocked(sparkRecommendedFees).mockReturnValue(new Promise(() => undefined))
  await ReactTestRenderer.act(async () => {
    tree?.unmount()
    tree = ReactTestRenderer.create(<RefundDepositScreen />)
  })
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(depositsRereadLimitMs())
  })
  expect((tree as ReactTestRenderer.ReactTestRenderer).root.findAllByType(Skeleton)).toHaveLength(0)
  expect(shown(tree as ReactTestRenderer.ReactTestRenderer)).toContain(i18n.t('common.retry'))
})

test('a deposit gone on open says it is resolved, and Back leaves', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  const root = await mount()

  expect(shown(root)).toContain(i18n.t('deposits.refundGone'))
  await press(root, 'Back')
  expect(mockGoBack).toHaveBeenCalled()
})

test('a deposit claimed with the screen open signs nothing', async () => {
  const root = await mount()
  await toReview(root)
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  await press(root, 'Confirm send')

  expect(sparkRefundDeposit).not.toHaveBeenCalled()
  expect(shown(root)).toContain(i18n.t('deposits.refundGone'))
})

test('a list that cannot be read at Confirm signs nothing and offers Confirm again', async () => {
  const root = await mount()
  await toReview(root)
  jest.mocked(sparkListUnclaimedDeposits).mockRejectedValueOnce(new Error('offline'))
  await press(root, 'Confirm send')

  expect(sparkRefundDeposit).not.toHaveBeenCalled()
  expect(shown(root)).toContain(i18n.t('deposits.refundLoadFailed'))
  expect(button(root, 'Confirm send')).toBeDefined()
})

test('the result holds the transaction id, which is the only record left', async () => {
  const openURL = jest.spyOn(Linking, 'openURL').mockResolvedValue(undefined)
  const root = await mount()
  await toReview(root)
  await press(root, 'Confirm send')

  expect(shown(root)).toContain('refundtx')
  expect(shown(root)).toContain(i18n.t('deposits.refundDoneTitle'))

  await press(root, i18n.t('history.detail.txid'))
  expect(Clipboard.setString).toHaveBeenCalledWith('refundtx')

  await press(root, i18n.t('history.detail.viewExplorer'))
  expect(openURL).toHaveBeenCalledWith(expect.stringContaining('/tx/refundtx'))
})
