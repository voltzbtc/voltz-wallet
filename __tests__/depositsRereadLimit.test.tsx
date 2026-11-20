import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import { UnclaimedDepositsCard, depositsRereadLimitMs } from '../src/components/UnclaimedDepositsCard'
import { sparkListUnclaimedDeposits, sparkClaimDeposit, type SparkDeposit } from '../src/wallet/spark'
import { formatSats } from '../src/wallet/amount'
import i18n from '../src/i18n'

// A stand-in for spark.ts without SYNC_WAIT_MS, as most screen suites write it. The card's read
// limit must still be a real wait there, or every read after a claim run is cut the moment it starts.
jest.mock('../src/wallet/spark', () => ({
  sparkListUnclaimedDeposits: jest.fn(),
  sparkClaimDeposit: jest.fn(),
}))

const a = { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving' as const, refundable: false }
const b = { txid: 'b', vout: 1, amountSat: 30_000, claimable: true, stage: 'arriving' as const, refundable: false }

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node =>
    [node.props.children].flat().filter((child): child is string => typeof child === 'string'),
  )
}

beforeEach(() => {
  jest.useFakeTimers()
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
  jest.mocked(sparkClaimDeposit).mockReset()
  jest.mocked(sparkClaimDeposit).mockResolvedValue('complete')
})

afterEach(() => {
  jest.useRealTimers()
})

test('keeps the sync wait as the limit when the stand-in leaves it out', () => {
  expect(depositsRereadLimitMs()).toBe(jest.requireActual('../src/wallet/spark').SYNC_WAIT_MS)
})

test('a read after a claim run that answers within the wait lands rather than being cut', async () => {
  let answer: ((list: SparkDeposit[]) => void) | undefined
  // The card's first read, then the read claim-all makes before it signs, then the one after the
  // claims, which is the read this case holds open.
  jest
    .mocked(sparkListUnclaimedDeposits)
    .mockResolvedValueOnce([a, b])
    .mockResolvedValueOnce([a, b])
    .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UnclaimedDepositsCard />)
  })
  await settle()
  const claim = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === 'Receive'))!
  await ReactTestRenderer.act(async () => {
    claim.props.onPress()
  })
  await settle()

  expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
  expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(3)

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1_000)
  })
  await settle()
  expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))

  await ReactTestRenderer.act(async () => {
    answer?.([b])
  })
  await settle()
  expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
  expect(texts(tree).join('').replace(/\s/g, '')).toContain(formatSats(30_000).replace(/\s/g, ''))
})
