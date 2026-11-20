import { CpfpFundingStrategy } from '@breeztech/breez-sdk-spark-react-native'
import RNFS from 'react-native-fs'
import { __setEmergencyExitLiveForTests } from '../src/wallet/emergencyExit'
import {
  exitPlanWasSetAside,
  forgetExitPlan,
  isLivePlan,
  loadExitPlan,
  saveExitPlan,
  type ExitPlan,
} from '../src/wallet/exitPlan'
import { planOf, READY, recoveryOf, stepOf } from './support/exitFixtures'

const FILE = `${RNFS.DocumentDirectoryPath}/exit-plan-primary.json`

const roundTrip = async (plan: ExitPlan): Promise<ExitPlan | null> => {
  await saveExitPlan(plan)
  return loadExitPlan(plan.walletId)
}

beforeEach(async () => {
  __setEmergencyExitLiveForTests(true)
  await forgetExitPlan('primary')
  for (const leftover of [`${FILE}.unreadable`, `${FILE}.tmp.unreadable`]) {
    if (await RNFS.exists(leftover)) {
      await RNFS.unlink(leftover)
    }
  }
})

afterEach(() => __setEmergencyExitLiveForTests(null))

describe('the codec', () => {
  test('a bigint comes back a bigint, in every field that holds one', async () => {
    const plan = planOf()
    const back = await roundTrip(plan)
    expect(back).toEqual(plan)
    expect(typeof back?.recovery.feeRateSatPerVbyte).toBe('bigint')
    expect(typeof back?.recovery.leaves[0].valueSats).toBe('bigint')
    const input = back?.recovery.fundingInputs[0] as unknown as { inner: { valueSats: unknown } }
    expect(typeof input.inner.valueSats).toBe('bigint')
  })

  test.each([
    ['Confirmed with its block', { tag: 'Confirmed', inner: { blockHeight: 870_123 } }],
    ['Confirmed with no block', { tag: 'Confirmed', inner: { blockHeight: undefined } }],
    ['Ready', { tag: 'Ready' }],
    ['WaitingForDependencies', { tag: 'WaitingForDependencies' }],
    ['WaitingForTimelock', { tag: 'WaitingForTimelock', inner: { spendableAtHeight: 871_000 } }],
    ['Unverified', { tag: 'Unverified' }],
  ])('%s keeps its tag and inner', async (_name, status) => {
    const plan = planOf({ recovery: recoveryOf({ transactions: [stepOf({ status })] }) })
    const back = await roundTrip(plan)
    expect((back?.recovery.transactions[0].status as { tag: string }).tag).toBe(status.tag)
    expect((back?.recovery.transactions[0].status as { inner?: unknown }).inner).toEqual(
      (status as { inner?: unknown }).inner,
    )
  })

  test.each([
    ['PerBranch', CpfpFundingStrategy.PerBranch],
    ['PerNode', CpfpFundingStrategy.PerNode],
  ])('the funding strategy %s comes back as it went in', async (_name, fundingStrategy) => {
    expect((await roundTrip(planOf({ fundingStrategy })))?.fundingStrategy).toBe(fundingStrategy)
  })

  test('a plan saved before the strategy existed still reads, with it unset', async () => {
    await saveExitPlan(planOf({ fundingStrategy: CpfpFundingStrategy.PerNode }))
    const stored = JSON.parse(await RNFS.readFile(FILE, 'utf8'))
    delete stored.fundingStrategy
    await RNFS.writeFile(FILE, JSON.stringify(stored), 'utf8')

    const back = await loadExitPlan('primary')

    expect(back).toEqual(planOf())
    expect(back?.fundingStrategy).toBeUndefined()
    expect(await exitPlanWasSetAside('primary')).toBe(false)
  })

  test('a strategy this version does not know goes aside, since the binding could not lower it', async () => {
    await saveExitPlan(planOf({ fundingStrategy: CpfpFundingStrategy.PerNode }))
    const stored = JSON.parse(await RNFS.readFile(FILE, 'utf8'))
    await RNFS.writeFile(FILE, JSON.stringify({ ...stored, fundingStrategy: 2 }), 'utf8')

    expect(await loadExitPlan('primary')).toBeNull()
    expect(await exitPlanWasSetAside('primary')).toBe(true)
  })

  test('a class instance from the binding is written as its tag and inner', async () => {
    class Confirmed {
      readonly tag = 'Confirmed'
      readonly inner = Object.freeze({ blockHeight: 42 })
    }
    const plan = planOf({
      recovery: recoveryOf({ transactions: [stepOf({ status: new Confirmed() })] }),
    })
    const back = await roundTrip(plan)
    expect(back?.recovery.transactions[0].status).toEqual({ tag: 'Confirmed', inner: { blockHeight: 42 } })
  })

  test('a step with no child stays without one', async () => {
    const plan = planOf({ recovery: recoveryOf({ transactions: [stepOf({ status: READY })] }) })
    const back = await roundTrip(plan)
    expect(back?.recovery.transactions[0].cpfpTxHex).toBeUndefined()
  })

  test.each([
    [
      'ReplacementFeeTooLow, with its two bigints',
      { tag: 'ReplacementFeeTooLow', inner: { requiredFeeSats: 4_200n, requiredFeeRateSatPerVbyte: 12n } },
    ],
    ['OperatorsUnavailable', { tag: 'OperatorsUnavailable' }],
    ['Generic', { tag: 'Generic', inner: { message: 'refused' } }],
  ])('a failed leaf keeps %s', async (_name, error) => {
    const failed = [{ leafId: 'leaf-1', outputTxid: 'bb'.repeat(32), outputVout: 1, error }]
    const plan = planOf({ recovery: recoveryOf({ failed } as never) })
    const back = await roundTrip(plan)
    expect(back?.recovery.failed).toEqual(failed)
  })

  test('a failed leaf from the binding is written as its tag and inner, and its bigint stays one', async () => {
    class ReplacementFeeTooLow {
      readonly tag = 'ReplacementFeeTooLow'
      readonly inner = Object.freeze({ requiredFeeSats: 4_200n, requiredFeeRateSatPerVbyte: 12n })
    }
    const failed = [{ leafId: 'leaf-1', outputTxid: 'bb'.repeat(32), outputVout: 1, error: new ReplacementFeeTooLow() }]
    const back = await roundTrip(planOf({ recovery: recoveryOf({ failed } as never) }))
    const error = back?.recovery.failed[0].error as unknown as { inner: { requiredFeeSats: unknown } }
    expect(typeof error.inner.requiredFeeSats).toBe('bigint')
    expect(error).toEqual({ tag: 'ReplacementFeeTooLow', inner: { requiredFeeSats: 4_200n, requiredFeeRateSatPerVbyte: 12n } })
  })

  test('a closed plan keeps why', async () => {
    const plan = planOf({ verdict: 'closed', closure: 'fee' })
    expect(await roundTrip(plan)).toEqual(plan)
  })

  test('a failed leaf and a null fee key survive', async () => {
    const failed = [
      { leafId: 'l', outputTxid: 'ab', outputVout: 0, error: { tag: 'ReplacementFeeTooLow', inner: { requiredFeeSats: 9n } } },
    ]
    const plan = planOf({ feeKey: null, recovery: recoveryOf({ failed } as never) })
    expect(await roundTrip(plan)).toEqual(plan)
  })
})

describe('the file', () => {
  test('is one per wallet', async () => {
    await saveExitPlan(planOf({ walletId: 'other/wallet' }))
    expect(await loadExitPlan('primary')).toBeNull()
    expect((await loadExitPlan('other/wallet'))?.walletId).toBe('other/wallet')
    await forgetExitPlan('other/wallet')
  })

  test('a torn file goes aside with every byte, reads as no exit, and leaves the mark', async () => {
    const torn = '{"version":1,"walletId":"primary"'
    await RNFS.writeFile(FILE, torn, 'utf8')
    expect(await exitPlanWasSetAside('primary')).toBe(false)
    expect(await loadExitPlan('primary')).toBeNull()
    expect(await RNFS.exists(FILE)).toBe(false)
    expect(await RNFS.readFile(`${FILE}.unreadable`, 'utf8')).toBe(torn)
    expect(await exitPlanWasSetAside('primary')).toBe(true)
  })

  test('a status of an unknown shape goes aside too', async () => {
    await saveExitPlan(planOf())
    const text = (await RNFS.readFile(FILE, 'utf8')).replace('"tag":"Ready"', '"tag":"Sideways"')
    await RNFS.unlink(FILE)
    await RNFS.writeFile(FILE, text, 'utf8')
    expect(await loadExitPlan('primary')).toBeNull()
    expect(await RNFS.readFile(`${FILE}.unreadable`, 'utf8')).toBe(text)
  })

  test('a version it does not know goes aside rather than holding the wallet', async () => {
    await saveExitPlan(planOf())
    const text = (await RNFS.readFile(FILE, 'utf8')).replace('"version":1', '"version":2')
    await RNFS.unlink(FILE)
    await RNFS.writeFile(FILE, text, 'utf8')
    expect(await loadExitPlan('primary')).toBeNull()
    expect(await exitPlanWasSetAside('primary')).toBe(true)
  })

  test('a new plan can be written after one went aside, and the torn one stays', async () => {
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    await loadExitPlan('primary')
    await saveExitPlan(planOf())
    expect(await loadExitPlan('primary')).toEqual(planOf())
    expect(await RNFS.readFile(`${FILE}.unreadable`, 'utf8')).toBe('torn')
  })

  test('a move aside the platform refuses holds the plan as unread', async () => {
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    const move = jest.spyOn(RNFS, 'moveFile').mockRejectedValueOnce(new Error('EACCES'))
    await expect(loadExitPlan('primary')).rejects.toMatchObject({ name: 'ExitPlanUnread' })
    move.mockRestore()
  })

  test('a read the platform refuses says so, and never reads as a torn file or as no exit', async () => {
    await saveExitPlan(planOf())
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    await expect(loadExitPlan('primary')).rejects.toMatchObject({ name: 'ExitPlanUnread' })
    read.mockRestore()
    expect(await loadExitPlan('primary')).toEqual(planOf())
  })

  test('nothing writes over a file that cannot be read', async () => {
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    await expect(saveExitPlan(planOf())).rejects.toMatchObject({ name: 'UnreadableFile' })
    expect(await RNFS.readFile(FILE, 'utf8')).toBe('torn')
  })

  test('forgetting takes a torn file too', async () => {
    await RNFS.writeFile(FILE, 'torn', 'utf8')
    await forgetExitPlan('primary')
    expect(await loadExitPlan('primary')).toBeNull()
  })
})

test('a plan the SDK called done or that a build closed is not alive, and any other is', () => {
  expect(isLivePlan(null)).toBe(false)
  expect(isLivePlan(planOf({ verdict: 'done' }))).toBe(false)
  expect(isLivePlan(planOf({ verdict: 'closed', closure: 'nothing' }))).toBe(false)
  expect(isLivePlan(planOf({ verdict: 'valid' }))).toBe(true)
  expect(isLivePlan(planOf({ verdict: 'redo' }))).toBe(true)
})

describe('with the switch off', () => {
  test('nothing reads or writes a plan', async () => {
    await saveExitPlan(planOf())
    __setEmergencyExitLiveForTests(false)
    expect(await loadExitPlan('primary')).toBeNull()
    await expect(saveExitPlan(planOf())).rejects.toThrow('emergency exit is off')
  })
})

