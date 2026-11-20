import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Linking, Text } from 'react-native'
import { SdkError } from '@breeztech/breez-sdk-spark-react-native'
import { UnclaimedDepositsCard, depositsRereadLimitMs } from '../src/components/UnclaimedDepositsCard'
import {
  sparkListUnclaimedDeposits,
  sparkClaimDeposit,
  type SparkDeposit,
} from '../src/wallet/spark'
import { formatSats } from '../src/wallet/amount'
import { GradientButton } from '../src/components/GradientButton'
import { DepositDetailSheet } from '../src/components/TransactionDetailSheet'
import i18n from '../src/i18n'
import * as settings from '../src/wallet/settings'

jest.mock('../src/wallet/spark', () => ({
  SYNC_WAIT_MS: jest.requireActual('../src/wallet/spark').SYNC_WAIT_MS,
  sparkListUnclaimedDeposits: jest.fn(),
  sparkClaimDeposit: jest.fn(),
}))


async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(onClaimed = jest.fn(), hidden = false): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UnclaimedDepositsCard onClaimed={onClaimed} hidden={hidden} />)
  })
  await settle()
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

async function pressBtn(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await settle()
}

beforeEach(() => {
  jest.clearAllMocks()
  // Reset rather than cleared, since a queued once-answer a test left unread would reach the next test.
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
  jest.mocked(sparkClaimDeposit).mockReset()
  jest.mocked(sparkClaimDeposit).mockResolvedValue('complete')
})

test('renders nothing when there are no unclaimed deposits', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([])
  const tree = await render()
  expect(tree.toJSON()).toBeNull()
})

describe('what the card offers by stage', () => {
  const base = { vout: 0, amountSat: 50_000 }
  const mature: SparkDeposit = { ...base, txid: 'ok', claimable: true, stage: 'arriving', refundable: false }
  const priced: SparkDeposit = {
    ...base,
    txid: 'priced',
    claimable: true,
    stage: 'needsFee',
    quotedFeeSat: 1_000,
    refundable: true,
  }
  const costly: SparkDeposit = { ...priced, txid: 'costly', vout: 1, quotedFeeSat: 50_000 }
  const stuck: SparkDeposit = { ...base, txid: 'stuck', claimable: false, stage: 'stuck', refundable: true }
  const small: SparkDeposit = { ...base, txid: 'small', claimable: false, stage: 'tooSmall', refundable: true }
  const returning: SparkDeposit = {
    ...base,
    txid: 'back',
    claimable: false,
    stage: 'returning',
    refundable: false,
    refundTxId: 'r1',
  }

  const mountWith = async (list: SparkDeposit[], onRefund = jest.fn()) => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue(list)
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard onRefund={onRefund} />)
    })
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
    return tree
  }

  // No answer the SDK gives says a deposit is beyond claiming, so the card never offers to send one back.
  test('a priced deposit offers accepting, and nothing to send it back', async () => {
    const tree = await mountWith([priced])
    expect(texts(tree)).toContain('Accept the fee and receive')
    expect(texts(tree)).not.toContain(i18n.t('deposits.refundRetry'))
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(1)
  })

  test('at or above the amount the fee is not offered, and the deposit reads as too small', async () => {
    const tree = await mountWith([costly])
    expect(texts(tree)).not.toContain('Accept the fee and receive')
    expect(texts(tree).join(' ')).not.toContain('at least')
    expect(texts(tree)).toContain(i18n.t('deposits.tooSmall', { amount: formatSats(50_000) }))
    // Nothing to act on: the one pressable left is the summary, which only opens the detail.
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(0)
    expect(
      tree.root
        .findAll(n => n.props.accessibilityRole === 'button')
        .every(n => n.props.accessibilityHint === i18n.t('history.detail.depositHint')),
    ).toBe(true)
  })

  // A sum over both would read as money to receive, and accepting would claim the losing one too.
  test('a losing deposit is not hidden behind a good one in the sum', async () => {
    const tree = await mountWith([priced, costly])
    expect(texts(tree).join(' ')).toContain(`You receive at least ${formatSats(49_000)} sats`)
    expect(texts(tree).join(' ')).toContain(`Network fee to receive now: ${formatSats(1_000)} sats`)

    await pressBtn(tree, 'Accept the fee and receive')
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledWith('priced', 0, 1_000)
  })

  test('"at least" counts only what carries a quote', async () => {
    const tree = await mountWith([mature, priced])
    expect(texts(tree).join(' ')).toContain(`${formatSats(50_000)} sats ready to receive`)
    expect(texts(tree).join(' ')).toContain(`You receive at least ${formatSats(49_000)} sats`)
  })

  test('a deposit too small to claim says how much and why, offering only its detail', async () => {
    const tree = await mountWith([small])

    expect(texts(tree)).toContain(i18n.t('deposits.tooSmall', { amount: formatSats(50_000) }))
    expect(texts(tree).join(' ')).not.toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
    // Nothing to act on: the one pressable left is the summary, which only opens the detail.
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(0)
    expect(
      tree.root
        .findAll(n => n.props.accessibilityRole === 'button')
        .every(n => n.props.accessibilityHint === i18n.t('history.detail.depositHint')),
    ).toBe(true)
  })

  // The claim can pass the list's check and still be refused when fees rose, and the SDK records that
  // on the deposit before it throws, so the read after the run carries the outcome.
  test('a claim refused as too small is not a failed run and leaves the next deposit claimed', async () => {
    const first: SparkDeposit = { ...mature, txid: 'first' }
    const second: SparkDeposit = { ...mature, txid: 'second' }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([first, second])
    jest
      .mocked(sparkClaimDeposit)
      .mockRejectedValueOnce(new SdkError.DepositTooSmall({ tx: 'first', vout: 0, docsUrl: 'https://doc' }))
    const tree = await render()
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([first, second]).mockResolvedValue([{ ...small, txid: 'first' }])

    await pressBtn(tree, i18n.t('deposits.claim'))

    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['first', 'second'])
    expect(texts(tree)).toContain(i18n.t('deposits.tooSmall', { amount: formatSats(50_000) }))
    expect(texts(tree)).not.toContain(i18n.t('deposits.claimFailed'))
  })

  // The SDK claims it again on every sync, and the first failure is often a read that failed on the
  // network, so sending back is not what the card offers first.
  test('a failed claim says the wallet keeps trying and offers Try again alone', async () => {
    const tree = await mountWith([stuck])
    expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
    expect(texts(tree)).not.toContain('Receive')
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(1)
  })

  // One action at a time: with money to receive the claim is the button, and Try again waits until
  // nothing is left to receive.
  test('a deposit to receive beside a failed one offers the claim alone', async () => {
    const tree = await mountWith([mature, stuck])
    expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
    expect(texts(tree)).toContain(i18n.t('deposits.claim'))
    expect(texts(tree)).not.toContain(i18n.t('common.retry'))
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(1)
  })

  test('with several refused returns, the retry opens the first and leaves the next on the card', async () => {
    const onRefund = jest.fn()
    const refusedReturn = { ...returning, refundState: 'pending' as const, refundError: 'min relay' }
    const tree = await mountWith([refusedReturn, { ...refusedReturn, txid: 'second' }], onRefund)
    await pressBtn(tree, i18n.t('deposits.refundRetry'))
    expect(onRefund).toHaveBeenCalledTimes(1)
    expect(onRefund).toHaveBeenCalledWith(refusedReturn)
  })

  test('a return in progress offers no action, only its detail', async () => {
    const tree = await mountWith([returning])
    expect(texts(tree)).toContain(i18n.t('deposits.returning'))
    // Nothing to act on: the one pressable left is the summary, which only opens the detail.
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(0)
    expect(
      tree.root
        .findAll(n => n.props.accessibilityRole === 'button')
        .every(n => n.props.accessibilityHint === i18n.t('history.detail.depositHint')),
    ).toBe(true)
  })

  test('an accepted return offers nothing, and a refused one offers a higher fee', async () => {
    const accepted = await mountWith([{ ...returning, refundState: 'broadcast' }])
    expect(texts(accepted)).not.toContain(i18n.t('deposits.refundRetry'))

    const refused = await mountWith([{ ...returning, refundState: 'pending', refundError: 'min relay' }])
    expect(texts(refused)).toContain(i18n.t('deposits.refundStalled'))
    expect(texts(refused)).toContain(i18n.t('deposits.refundRetry'))
  })
})

describe('money on its way', () => {
  const arriving: SparkDeposit = { txid: 'a', vout: 0, amountSat: 42_000, claimable: false, stage: 'arriving' as const, refundable: false }

  test('reads approximate and arriving, with nothing to do but open its detail', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    const tree = await render()

    const shown = texts(tree).join(' ')
    expect(shown).toContain(`≈ ${formatSats(42_000)} sats arriving`)
    expect(shown).not.toMatch(/received|deposit/i)
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(0)
    // The one pressable, found once per layer it passes its role through, is the summary.
    const pressable = tree.root.findAll(n => n.props.accessibilityRole === 'button')
    expect(pressable.length).toBeGreaterThan(0)
    const hint = i18n.t('history.detail.depositHint')
    expect(pressable.every(n => n.props.accessibilityHint === hint)).toBe(true)
    // A screen reader hears what the summary shows, title and figure, not the title alone.
    expect(pressable[0].props.accessibilityLabel).toContain(i18n.t('deposits.title'))
    expect(pressable[0].props.accessibilityLabel).toContain(`≈ ${formatSats(42_000)} sats arriving`)
  })

  describe('its detail', () => {
    const txid = 'c3'.repeat(32)
    const onChain: SparkDeposit = { ...arriving, txid }
    const detail = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findByType(DepositDetailSheet)
    const openDetail = async (tree: ReactTestRenderer.ReactTestRenderer) => {
      const summary = tree.root.find(
        n =>
          typeof n.props.onPress === 'function' &&
          n.props.hint === i18n.t('history.detail.depositHint'),
      )
      await ReactTestRenderer.act(async () => summary.props.onPress())
      await settle()
    }

    test('a tap on the summary shows each deposit with its transaction', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render()
      expect(detail(tree).props.deposits).toEqual([])

      await openDetail(tree)
      expect(detail(tree).props.deposits).toEqual([onChain])
      const shown = detail(tree).findAllByType(Text).map(n => String(n.props.children))
      expect(shown).toContain(i18n.t('history.detail.txid'))
      expect(shown).toContain(`≈ ${formatSats(42_000)} sats`)
    })

    test('a hidden balance hides the figure in the detail too', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render(undefined, true)
      await openDetail(tree)

      const shown = detail(tree).findAllByType(Text).map(n => String(n.props.children)).join(' ')
      expect(shown).not.toContain(formatSats(42_000))
      expect(shown).toContain('••••')
    })

    test('a hidden balance keeps the figure out of the summary a screen reader hears', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      const tree = await render(undefined, true)

      const labels = tree.root
        .findAll(n => n.props.accessibilityRole === 'button')
        .map(n => String(n.props.accessibilityLabel))
      expect(labels.length).toBeGreaterThan(0)
      for (const label of labels) {
        expect(label).toContain(i18n.t('deposits.title'))
        expect(label).toContain('••••')
        expect(label).not.toContain(formatSats(42_000))
      }
    })

    // A button inside the summary would be a press inside a press, and the summary's label would
    // speak for it.
    test('the claim stands outside the summary that opens the detail', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([{ ...onChain, claimable: true }])
      const tree = await render()

      const summary = tree.root.find(
        n =>
          typeof n.props.onPress === 'function' &&
          n.props.hint === i18n.t('history.detail.depositHint'),
      )
      expect(tree.root.findAllByType(GradientButton).map(b => b.props.label)).toEqual([
        i18n.t('deposits.claim'),
      ])
      expect(summary.findAllByType(GradientButton)).toHaveLength(0)
    })

    test('an empty read closes the detail, and a later listing keeps it shut', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
      })
      await settle()
      await openDetail(tree)
      expect(detail(tree).props.deposits).toEqual([onChain])

      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([])
      await ReactTestRenderer.act(async () => tree.update(<UnclaimedDepositsCard refreshKey={1} />))
      await settle()
      expect(tree.toJSON()).toBeNull()

      await ReactTestRenderer.act(async () => tree.update(<UnclaimedDepositsCard refreshKey={2} />))
      await settle()
      expect(texts(tree).join(' ')).toContain(`≈ ${formatSats(42_000)} sats arriving`)
      expect(detail(tree).props.deposits).toEqual([])
    })

    test('each opening reads the chosen explorer again', async () => {
      const chosen = jest.spyOn(settings, 'loadTxExplorers').mockResolvedValue({
        custom: [{ id: 'mine', url: 'http://node.local:3006/' }],
        selectedId: 'mine',
      })
      try {
        jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
        const tree = await render()
        await openDetail(tree)
        expect(chosen).toHaveBeenCalledTimes(1)

        await ReactTestRenderer.act(async () => detail(tree).props.onClose())
        await settle()
        expect(detail(tree).props.deposits).toEqual([])
        await openDetail(tree)

        expect(detail(tree).props.deposits).toEqual([onChain])
        expect(chosen).toHaveBeenCalledTimes(2)
      } finally {
        chosen.mockRestore()
      }
    })

    // The explorer is read as the sheet opens, and a press can come before that read answers.
    test('a press before the chosen explorer is read opens that explorer', async () => {
      let answer: ((config: settings.TxExplorerConfig) => void) | undefined
      const chosen = jest
        .spyOn(settings, 'loadTxExplorers')
        .mockImplementation(() => new Promise(resolve => (answer = resolve)))
      const opened = jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
      try {
        jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([onChain])
        const tree = await render()
        expect(chosen).not.toHaveBeenCalled()
        await openDetail(tree)
        expect(chosen).toHaveBeenCalledTimes(1)

        const view = detail(tree)
          .findAllByType(GradientButton)
          .find(b => b.props.label === i18n.t('history.detail.viewExplorer'))
        await ReactTestRenderer.act(async () => {
          view?.props.onPress()
        })
        expect(opened).not.toHaveBeenCalled()

        await ReactTestRenderer.act(async () => {
          answer?.({ custom: [{ id: 'mine', url: 'http://node.local:3006/' }], selectedId: 'mine' })
        })
        await settle()
        expect(opened).toHaveBeenCalledTimes(1)
        expect(opened).toHaveBeenCalledWith(`http://node.local:3006/tx/${txid}`)
      } finally {
        chosen.mockRestore()
        opened.mockRestore()
      }
    })

    test('a read that could not check closes the detail for good', async () => {
      const quoted: SparkDeposit = {
        ...onChain,
        claimable: true,
        quotedFeeSat: 500,
        stage: 'needsFee',
        refundable: true,
      }
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([quoted])
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
      })
      await settle()
      await openDetail(tree)
      expect(detail(tree).props.deposits).toEqual([quoted])

      jest.mocked(sparkListUnclaimedDeposits).mockRejectedValueOnce(new Error('offline'))
      await ReactTestRenderer.act(async () => tree.update(<UnclaimedDepositsCard refreshKey={1} />))
      await settle()
      expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
      expect(detail(tree).props.deposits).toEqual([])

      await ReactTestRenderer.act(async () => tree.update(<UnclaimedDepositsCard refreshKey={2} />))
      await settle()
      expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
      expect(detail(tree).props.deposits).toEqual([])
    })
  })

  test('the figure goes with a hidden balance', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    const tree = await render(undefined, true)

    expect(texts(tree).join(' ')).not.toContain(formatSats(42_000))
    expect(texts(tree).join(' ')).toContain('••••')
  })

  test('says it is not updated when the connection is stale', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([arriving])
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard stale />)
    })
    await ReactTestRenderer.act(async () => {
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    })
    expect(texts(tree).join(' ')).toContain(i18n.t('home.notUpdated'))
  })
})

describe('Try again on a failed claim', () => {
  const stuck: SparkDeposit = {
    txid: 'stuck',
    vout: 0,
    amountSat: 50_000,
    claimable: false,
    stage: 'stuck',
    refundable: true,
  }

  const mount = async (onRefund = jest.fn(), onClaimed = jest.fn(), refreshKey = 0) => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <UnclaimedDepositsCard onRefund={onRefund} onClaimed={onClaimed} refreshKey={refreshKey} />,
      )
    })
    await settle()
    return tree
  }

  test('reads, claims each failed deposit under the automatic ceiling, and reads again', async () => {
    const onClaimed = jest.fn()
    const order: string[] = []
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck])
    const tree = await mount(jest.fn(), onClaimed)
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockImplementationOnce(async () => {
        order.push('read')
        return [stuck]
      })
      .mockImplementation(async () => {
        order.push('read')
        return []
      })
    jest.mocked(sparkClaimDeposit).mockImplementation(async () => {
      order.push('claim')
      return 'complete'
    })

    await pressBtn(tree, i18n.t('common.retry'))

    expect(order).toEqual(['read', 'claim', 'read'])
    // No ceiling of its own, so never a fee the person did not see.
    expect(jest.mocked(sparkClaimDeposit).mock.calls).toEqual([['stuck', 0]])
    expect(onClaimed).toHaveBeenCalled()
    expect(tree.toJSON()).toBeNull()
  })

  // A refusal can come on the network, or after the provider took the claim and the operators had not
  // listed it yet, so the card says nothing of it and draws the read after.
  test('a refused claim is said as nothing, and offers nothing else', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([stuck])
    jest.mocked(sparkClaimDeposit).mockRejectedValue(new SdkError.Generic('transfer not found after claim'))
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(texts(tree)).not.toContain(i18n.t('deposits.claimFailed'))
    expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
    expect(tree.root.findAllByType(GradientButton)).toHaveLength(1)
  })

  test('a read before the claims that answers late never lands over a newer Home refresh', async () => {
    jest.useFakeTimers()
    try {
      let answer: ((list: SparkDeposit[]) => void) | undefined
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([stuck])
        .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
        .mockResolvedValue([])
      const tree = await mount(jest.fn(), jest.fn(), 0)

      await pressBtn(tree, i18n.t('common.retry'))
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(depositsRereadLimitMs())
      })
      await settle()
      await ReactTestRenderer.act(async () => {
        tree.update(<UnclaimedDepositsCard onRefund={jest.fn()} onClaimed={jest.fn()} refreshKey={1} />)
      })
      await settle()
      expect(tree.toJSON()).toBeNull()

      await ReactTestRenderer.act(async () => {
        answer?.([stuck])
      })
      await settle()

      expect(tree.toJSON()).toBeNull()
      expect(sparkClaimDeposit).not.toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('a deposit the read before found being sent back is not claimed', async () => {
    const back: SparkDeposit = { ...stuck, stage: 'returning', refundable: false, refundTxId: 'r1' }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValue([back])
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('deposits.returning'))
  })

  test('a read before the claims that fails claims nothing and says it could not check', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockRejectedValue(new Error('storage'))
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree).join(' ')).not.toContain(formatSats(50_000))
  })

  test('a read after the claims that fails hides the figure and says it could not check', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockResolvedValueOnce([stuck])
      .mockRejectedValue(new Error('storage'))
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree).join(' ')).not.toContain(formatSats(50_000))
  })

  test('a read after the claims past its limit says it could not check, and its late answer lands', async () => {
    jest.useFakeTimers()
    try {
      let answer: ((list: SparkDeposit[]) => void) | undefined
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([stuck])
        .mockResolvedValueOnce([stuck])
        .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
      const tree = await mount()

      await pressBtn(tree, i18n.t('common.retry'))
      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(depositsRereadLimitMs())
      })
      await settle()
      expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))

      await ReactTestRenderer.act(async () => {
        answer?.([stuck])
      })
      await settle()

      expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
      expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
    } finally {
      jest.useRealTimers()
    }
  })

  test('a Home refresh that lands during the read after the claims keeps its newer list', async () => {
    let answer: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockResolvedValueOnce([stuck])
      .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
      .mockResolvedValue([])
    const onClaimed = jest.fn()
    const tree = await mount(jest.fn(), onClaimed, 0)

    await pressBtn(tree, i18n.t('common.retry'))
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard onRefund={jest.fn()} onClaimed={onClaimed} refreshKey={1} />)
    })
    await settle()
    expect(tree.toJSON()).toBeNull()

    await ReactTestRenderer.act(async () => {
      answer?.([stuck])
    })
    await settle()

    expect(tree.toJSON()).toBeNull()
  })

  test('clears the line a failed claim run left, which the read after it does not', async () => {
    const ready: SparkDeposit = { ...stuck, claimable: true, stage: 'arriving', refundable: false }
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([ready])
      .mockResolvedValueOnce([ready])
      .mockResolvedValue([stuck])
    jest.mocked(sparkClaimDeposit).mockRejectedValueOnce(new SdkError.Generic('claim failed'))
    const tree = await mount()
    await pressBtn(tree, i18n.t('deposits.claim'))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkClaimDeposit).toHaveBeenLastCalledWith('stuck', 0)
    expect(texts(tree)).not.toContain(i18n.t('deposits.claimFailed'))
    expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
  })

  test('a read before the claims that fails keeps a newer refresh that answered', async () => {
    let refuse: ((error: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockImplementationOnce(() => new Promise((_, reject) => (refuse = reject)))
      .mockResolvedValue([stuck])
    const tree = await mount(jest.fn(), jest.fn(), 0)

    await pressBtn(tree, i18n.t('common.retry'))
    await ReactTestRenderer.act(async () => {
      tree.update(
        <UnclaimedDepositsCard onRefund={jest.fn()} onClaimed={jest.fn()} refreshKey={1} />,
      )
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      refuse?.(new Error('storage'))
    })
    await settle()

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(50_000) }))
  })

  test('unmounting while the read before the claims waits claims nothing', async () => {
    let answer: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([stuck])
      .mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))
    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    await ReactTestRenderer.act(async () => {
      answer?.([stuck])
    })
    await settle()

    expect(answer).toBeDefined()
    expect(sparkClaimDeposit).not.toHaveBeenCalled()
  })

  test('a deposit the try found too small says how much', async () => {
    const small: SparkDeposit = { ...stuck, stage: 'tooSmall' }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([stuck]).mockResolvedValueOnce([stuck]).mockResolvedValue([small])
    const tree = await mount()

    await pressBtn(tree, i18n.t('common.retry'))

    expect(texts(tree)).toContain(i18n.t('deposits.tooSmall', { amount: formatSats(50_000) }))
    expect(texts(tree)).not.toContain(i18n.t('common.retry'))
  })

  test('a hidden balance hides the failed and the too small figures', async () => {
    const small: SparkDeposit = { ...stuck, txid: 'small', stage: 'tooSmall', amountSat: 600 }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([stuck, small])
    const tree = await render(jest.fn(), true)

    const shown = texts(tree).join(' ')
    expect(shown).toContain(i18n.t('deposits.retrying', { amount: '••••' }))
    expect(shown).toContain(i18n.t('deposits.tooSmall', { amount: '••••' }))
    expect(shown).not.toContain(formatSats(50_000))
    expect(shown).not.toContain('600')
  })
})

test('shows the claimable total (excluding unclaimable) and claims each on tap, then notifies', async () => {
  const onClaimed = jest.fn()
  const unclaimable = { txid: 'c', vout: 0, amountSat: 99999, claimable: false, stage: 'stuck' as const, refundable: false }
  const listed: SparkDeposit[] = [
    { txid: 'a', vout: 0, amountSat: 50000, claimable: true, stage: 'arriving', refundable: false },
    { txid: 'b', vout: 1, amountSat: 30000, claimable: true, stage: 'arriving', refundable: false },
    unclaimable, // must not count toward the total
  ]
  // The tap reads the list again before it signs. A claimed deposit leaves the SDK's list, so the
  // read after the claims holds only what is left.
  jest
    .mocked(sparkListUnclaimedDeposits)
    .mockResolvedValueOnce(listed)
    .mockResolvedValueOnce(listed)
    .mockResolvedValue([unclaimable])

  const tree = await render(onClaimed)

  // Total is the claimable sum only (80000), never the unclaimable deposit, which its own line names.
  expect(texts(tree)).toContain(i18n.t('deposits.amount', { amount: formatSats(80_000) }))
  expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(99_999) }))

  await pressBtn(tree, 'Receive')

  expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
  expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, undefined)
  expect(sparkClaimDeposit).toHaveBeenCalledWith('b', 1, undefined)
  expect(onClaimed).toHaveBeenCalled()
  // Nothing claimable is left, so the claim goes with it and what cannot be received stays explained.
  expect(texts(tree)).not.toContain('Receive')
  expect(texts(tree)).toContain(i18n.t('deposits.retrying', { amount: formatSats(99_999) }))
})

// The card has to name the fee before the tap, then send it so the claim is not refused again.
test('a deposit refused on price shows the quoted fee and claims with it', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
    { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'needsFee', refundable: false, quotedFeeSat: 1800 },
  ])
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain(`Network fee to receive now: ${formatSats(1800)} sats`)
  expect(shown).toContain(`You receive at least ${formatSats(48_200)} sats`)

  await pressBtn(tree, 'Accept the fee and receive')

  expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, 1800)
})

// The deposit is part of the balance, so hiding the balance hides it too, fee included, while the
// card stays so the claim can still be made.
test('with the balance hidden, shows no amount and still offers the claim', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
    { txid: 'a', vout: 0, amountSat: 50000, claimable: true, stage: 'needsFee', refundable: false, quotedFeeSat: 312 },
  ])
  const shown = texts(await render(jest.fn(), true))

  expect(shown.some(text => text.includes(formatSats(50000)))).toBe(false)
  expect(shown.some(text => text.includes(formatSats(312)))).toBe(false)
  expect(shown).toContain('Accept the fee and receive')
})

test('with the balance shown, the amount and fee read as before', async () => {
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
    { txid: 'a', vout: 0, amountSat: 50000, claimable: true, stage: 'needsFee', refundable: false, quotedFeeSat: 312 },
  ])
  const shown = texts(await render())

  expect(shown.some(text => text.includes(formatSats(49_688)))).toBe(true)
  expect(shown.some(text => text.includes(formatSats(312)))).toBe(true)
})

// After any claim run the card shows what the SDK says is still there, never the total it had before,
// which after a partial failure counts deposits already claimed and would claim them again.
describe('after a claim run', () => {
  const a = { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const b = { txid: 'b', vout: 1, amountSat: 30_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, '')
  const sats = (n: number) => formatSats(n).replace(/\s/g, '')

  test('a later claim that fails shows the re-read list and the error, without notifying', async () => {
    const onClaimed = jest.fn()
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b]).mockResolvedValueOnce([b])
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    const tree = await render(onClaimed)
    expect(flat(tree)).toContain(sats(80_000))

    await pressBtn(tree, 'Receive')

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(3)
    expect(flat(tree)).toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
    expect(onClaimed).not.toHaveBeenCalled()

    // The next tap claims only what is still there.
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([b]).mockResolvedValueOnce([])
    await pressBtn(tree, 'Receive')
    expect(sparkClaimDeposit).toHaveBeenLastCalledWith('b', 1, undefined)
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(3)
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  // The figure from before the run counts a, which is already claimed, so it is hidden rather than
  // kept, and the only way on is a read.
  test('a claim that passed, one that failed and a failed re-read hide the figure', async () => {
    const onClaimed = jest.fn()
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    const tree = await render(onClaimed)

    await pressBtn(tree, 'Receive')

    expect(flat(tree)).not.toContain(sats(80_000))
    expect(flat(tree)).not.toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(50_000))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
    expect(texts(tree)).not.toContain('Receive')
    expect(onClaimed).not.toHaveBeenCalled()

    // Try again reads, and the claim that follows takes only what the read says is left.
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([b]).mockResolvedValueOnce([b]).mockResolvedValueOnce([])
    await pressBtn(tree, i18n.t('common.retry'))
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(onClaimed).not.toHaveBeenCalled()

    await pressBtn(tree, 'Receive')
    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['a', 'b', 'b'])
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  test('claims that passed and a re-read that failed say the rest could not be checked', async () => {
    const onClaimed = jest.fn()
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await render(onClaimed)

    await pressBtn(tree, 'Receive')

    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).not.toContain(i18n.t('deposits.claimFailed'))
    expect(texts(tree)).not.toContain('Receive')
    expect(onClaimed).not.toHaveBeenCalled()

    // The read that answers is the one the run could not make, so it notifies.
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([])
    await pressBtn(tree, i18n.t('common.retry'))
    expect(tree.toJSON()).toBeNull()
    expect(onClaimed).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
  })

  test('a Try again that fails keeps the figure and the fee hidden, and Try again offered', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([{ ...a, quotedFeeSat: 1_800 }, b]).mockResolvedValueOnce([{ ...a, quotedFeeSat: 1_800 }, b])
      .mockRejectedValue(new Error('offline'))
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    const tree = await render()
    await pressBtn(tree, 'Accept the fee and receive')

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(flat(tree)).not.toContain(sats(1_800))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(tree.root.findByType(GradientButton).props.loading).toBe(false)
    expect(texts(tree)).toContain(i18n.t('common.retry'))
  })

  test('a second Try again tap while the read is in flight starts nothing', async () => {
    let land: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => (land = resolve)))
    const tree = await render()
    await pressBtn(tree, 'Receive')
    const again = tree.root.findByType(GradientButton).props.onPress

    await ReactTestRenderer.act(async () => {
      again()
      again()
    })
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(tree.root.findByType(GradientButton).props.loading).toBe(true)

    await ReactTestRenderer.act(async () => {
      land?.([])
    })
    await settle()
    expect(tree.toJSON()).toBeNull()
  })

  // Home reloads the card on its own refresh, and a read that answers is the check the line asked for.
  test('the unchecked line clears on the next refresh that answers', async () => {
    const c = { txid: 'c', vout: 0, amountSat: 7_000, claimable: true, stage: 'arriving' as const, refundable: false }
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([c])
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await pressBtn(tree, 'Receive')
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))

    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await settle()

    expect(flat(tree)).toContain(sats(7_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
  })

  test('a refresh that fails while unchecked keeps the card and its Try again', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValue(new Error('offline'))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await pressBtn(tree, 'Receive')

    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await settle()

    expect(tree.toJSON()).not.toBeNull()
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
  })

  // Home can refresh while Try again is in flight. The refresh started later, so its list is the one
  // kept, and the older answer landing after it never takes a deposit that is still there off the card.
  test('a Try again that answers after a newer refresh never lands over it', async () => {
    let retry: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => (retry = resolve)))
      .mockResolvedValueOnce([b])
      .mockResolvedValueOnce([b]).mockResolvedValueOnce([])
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await pressBtn(tree, 'Receive')
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))

    await pressBtn(tree, i18n.t('common.retry'))
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await settle()
    expect(flat(tree)).toContain(sats(30_000))

    await ReactTestRenderer.act(async () => {
      retry?.([])
    })
    await settle()

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(5)
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
    expect(tree.root.findByType(GradientButton).props.loading).toBe(false)

    await pressBtn(tree, 'Receive')
    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['a', 'b', 'b'])
  })

  test('the spinner stays and a tap is ignored until the re-read lands', async () => {
    let land: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockImplementationOnce(() => new Promise(resolve => (land = resolve)))
    const tree = await render()
    const claim = tree.root.findByType(GradientButton).props.onPress

    await ReactTestRenderer.act(async () => {
      claim()
    })
    await settle()
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(3)
    expect(tree.root.findByType(GradientButton).props.loading).toBe(true)

    await ReactTestRenderer.act(async () => {
      claim()
    })
    await settle()
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)

    await ReactTestRenderer.act(async () => {
      land?.([])
    })
    await settle()
    expect(tree.toJSON()).toBeNull()
  })

  // Home reloads after a claim run too, and its read can start while the card's own is in flight.
  test('a failed claim is still said when a newer refresh sets the list', async () => {
    let own: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (own = resolve)))
      .mockResolvedValueOnce([b])
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()

    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()
    // The card's read is in flight when Home's refresh starts and answers first.
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      own?.([a, b])
    })
    await settle()

    expect(flat(tree)).toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
  })

  // The claim's own payment event makes Home refresh, so a newer read is often in flight when the
  // card's read answers. The list from before the run is never left on screen meanwhile.
  test('a failed re-read hides the figure even with a newer refresh in flight', async () => {
    let own: ((cause: Error) => void) | undefined
    let refresh: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise((_, reject) => (own = reject)))
      .mockImplementationOnce(() => new Promise(resolve => (refresh = resolve)))
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await ReactTestRenderer.act(async () => {
      own?.(new Error('offline'))
    })
    await settle()

    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).not.toContain('Receive')

    await ReactTestRenderer.act(async () => {
      refresh?.([b])
    })
    await settle()
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
  })

  test('a re-read that fails after a newer refresh answered leaves that answer shown', async () => {
    let own: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise((_, reject) => (own = reject)))
      .mockResolvedValueOnce([b])
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      own?.(new Error('offline'))
    })
    await settle()

    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
  })

  test('a re-read that a newer refresh superseded still replaces the list from before', async () => {
    let own: ((list: typeof a[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (own = resolve)))
      .mockImplementationOnce(() => new Promise(() => undefined))
      .mockResolvedValueOnce([b]).mockResolvedValueOnce([])
    jest
      .mocked(sparkClaimDeposit)
      .mockResolvedValueOnce('complete')
      .mockRejectedValueOnce(new Error('fee'))
      .mockResolvedValueOnce('complete')
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} />)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} />)
    })
    await ReactTestRenderer.act(async () => {
      own?.([b])
    })
    await settle()

    expect(flat(tree)).toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))

    await pressBtn(tree, 'Receive')
    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['a', 'b', 'b'])
  })

  test('a refresh that began before the re-read never lands over it', async () => {
    const onClaimed = jest.fn()
    let stale: ((list: typeof a[]) => void) | undefined
    let fresh: ((list: typeof a[]) => void) | undefined
    let claimed: ((s: 'complete') => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockImplementationOnce(() => new Promise(resolve => (stale = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (fresh = resolve)))
    jest.mocked(sparkClaimDeposit).mockImplementationOnce(() => new Promise(resolve => (claimed = resolve)))
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} onClaimed={onClaimed} />)
    })
    await settle()

    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    // Home reloads while the claim is in flight, and that read answers last, with the old list.
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={1} onClaimed={onClaimed} />)
    })
    await ReactTestRenderer.act(async () => {
      claimed?.('complete')
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      fresh?.([])
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      stale?.([a])
    })
    await settle()

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(onClaimed).toHaveBeenCalledTimes(1)
    expect(tree.toJSON()).toBeNull()
  })
})

// The list on screen can be old when the tap comes: the automatic claim, or a refund started from the
// refund screen, which claim_deposit does not refuse, may have taken a deposit since. A claim run signs
// only what a read made after the tap lists as claimable, at the quote the person saw.
describe('the read before a claim run', () => {
  const a = { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const b = { txid: 'b', vout: 1, amountSat: 30_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const priced = { ...a, stage: 'needsFee' as const, quotedFeeSat: 1_000 }
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, '')
  const sats = (n: number) => formatSats(n).replace(/\s/g, '')

  test('a deposit on its way back since the list was drawn is not signed', async () => {
    const back = { ...a, claimable: false, stage: 'returning' as const, refundTxId: 'r1' }
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([back, b])
      .mockResolvedValueOnce([back])
    const tree = await render()

    await pressBtn(tree, 'Receive')

    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['b'])
  })

  test('a read before the run that fails signs nothing, and the card says it is not checked', async () => {
    const onClaimed = jest.fn()
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await render(onClaimed)

    await pressBtn(tree, 'Receive')

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(2)
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
    expect(tree.root.findByType(GradientButton).props.loading).toBe(false)
    expect(onClaimed).not.toHaveBeenCalled()
  })

  // Accepting a fee is agreeing to the figure on screen, so a quote that moved is drawn, not signed,
  // and the next tap is the one that agrees to it.
  test('a quote that moved since the list was drawn is redrawn with it, not signed', async () => {
    const repriced = { ...priced, quotedFeeSat: 4_000 }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([priced]).mockResolvedValueOnce([repriced])
    const tree = await render()
    expect(flat(tree)).toContain(sats(49_000))

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(flat(tree)).toContain(sats(46_000))
    expect(flat(tree)).toContain(sats(4_000))
    expect(flat(tree)).not.toContain(sats(49_000))
    expect(tree.root.findByType(GradientButton).props.loading).toBe(false)
  })

  // A fee at or above the amount leaves nothing to receive, so accepting it is never offered.
  test('a quote that rose past the amount is not signed, and accepting it is not offered', async () => {
    const backable = { ...priced, refundable: true }
    const costly = { ...backable, quotedFeeSat: 60_000 }
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([backable]).mockResolvedValue([costly])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('deposits.tooSmall', { amount: formatSats(50_000) }))
    expect(texts(tree)).not.toContain(i18n.t('deposits.acceptFee'))
  })

  // The person agreed to a fee, so a deposit whose quote went away is not received at a fee they did
  // not see; it is drawn at its plain amount for the next tap.
  test('a quote that went away is not signed, and the deposit is redrawn at its plain amount', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([priced]).mockResolvedValueOnce([a])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(flat(tree)).toContain(sats(50_000))
    expect(flat(tree)).not.toContain(sats(1_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claim'))
    expect(texts(tree)).not.toContain(i18n.t('deposits.acceptFee'))
  })

  test('a deposit drawn without a quote that gains one is redrawn with the fee, not signed', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([a]).mockResolvedValueOnce([priced])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.claim'))

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(flat(tree)).toContain(sats(1_000))
    expect(texts(tree)).toContain(i18n.t('deposits.acceptFee'))
  })

  // The list the card redrew is what the next tap agrees to.
  test('a deposit redrawn without its quote is signed at its plain amount on the next tap', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([priced]).mockResolvedValueOnce([a])
    const tree = await render()
    await pressBtn(tree, i18n.t('deposits.acceptFee'))
    expect(sparkClaimDeposit).not.toHaveBeenCalled()

    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([a]).mockResolvedValueOnce([])
    await pressBtn(tree, i18n.t('deposits.claim'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, undefined)
  })

  // Each deposit is matched to its own quote on screen, so one whose quote held is signed at it,
  // whatever the quote of the deposit beside it did.
  test('a held quote is signed beside a moved one, which the next tap signs at its new quote', async () => {
    const repriced = { ...priced, quotedFeeSat: 4_000 }
    const held = { ...b, stage: 'needsFee' as const, quotedFeeSat: 500 }
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([priced, held])
      .mockResolvedValueOnce([repriced, held])
      .mockResolvedValueOnce([repriced])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledWith('b', 1, 500)
    expect(flat(tree)).toContain(sats(4_000))

    // The quote holds this time, and the claim has not landed yet when the card reads again.
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([repriced])
      .mockResolvedValueOnce([repriced])
    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
    expect(sparkClaimDeposit).toHaveBeenLastCalledWith('a', 0, 4_000)
  })

  test('a quote that held is signed beside one whose quote went away, which is not', async () => {
    const other = { ...b, stage: 'needsFee' as const, quotedFeeSat: 500 }
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([priced, other])
      .mockResolvedValueOnce([priced, b])
      .mockResolvedValueOnce([b])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, 1_000)
    expect(flat(tree)).toContain(sats(30_000))
  })

  test('a quote that held is signed at it', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([priced])
      .mockResolvedValueOnce([priced])
      .mockResolvedValueOnce([])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, 1_000)
  })

  test('a deposit with no quote on screen and none in the read is signed at its plain amount', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([a])
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.claim'))

    expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, undefined)
  })

  test('a read before the run that finds nothing left to claim signs nothing and notifies', async () => {
    const onClaimed = jest.fn()
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([a, b]).mockResolvedValueOnce([])
    const tree = await render(onClaimed)

    await pressBtn(tree, 'Receive')

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(tree.toJSON()).toBeNull()
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  // The redraw adds no line, so a screen reader would not hear that the tap signed nothing and the
  // fee moved; it is told the fee line as drawn.
  describe('a screen reader', () => {
    let spoken: jest.SpyInstance
    beforeEach(() => {
      spoken = jest
        .spyOn(AccessibilityInfo, 'announceForAccessibility')
        .mockImplementation(() => {})
    })
    afterEach(() => spoken.mockRestore())
    const feeLine = (n: number) => i18n.t('deposits.fee', { amount: formatSats(n) })

    test('hears the new fee when a moved quote is redrawn', async () => {
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockResolvedValueOnce([{ ...priced, quotedFeeSat: 4_000 }])
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(spoken.mock.calls).toEqual([[feeLine(4_000)]])
    })

    test('hears the fee left after a held quote was signed beside a moved one', async () => {
      const repriced = { ...priced, quotedFeeSat: 4_000 }
      const held = { ...b, stage: 'needsFee' as const, quotedFeeSat: 500 }
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced, held])
        .mockResolvedValueOnce([repriced, held])
        .mockResolvedValueOnce([repriced])
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(sparkClaimDeposit).toHaveBeenCalledWith('b', 1, 500)
      expect(spoken.mock.calls).toEqual([[feeLine(4_000)]])
    })

    test('hears nothing when the quote held and was signed', async () => {
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockResolvedValueOnce([priced])
        .mockResolvedValueOnce([])
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, 1_000)
      expect(spoken).not.toHaveBeenCalled()
    })

    // The claim has not landed when the card reads again, so the deposit is drawn at the quote
    // agreed to.
    test('hears nothing when a signed quote is still listed after the run', async () => {
      jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([priced])
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(sparkClaimDeposit).toHaveBeenCalledWith('a', 0, 1_000)
      expect(spoken).not.toHaveBeenCalled()
    })

    test('hears nothing when the quote went away, since no fee line is drawn', async () => {
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockResolvedValueOnce([a])
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(spoken).not.toHaveBeenCalled()
    })

    // The balance is hidden while the read before signing is out, so the redrawn line shows no
    // figure.
    test('hears nothing when the balance is hidden during the run', async () => {
      let answer: (list: SparkDeposit[]) => void = () => undefined
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
      const tree = await render()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))
      await ReactTestRenderer.act(async () => {
        tree.update(<UnclaimedDepositsCard onClaimed={jest.fn()} hidden />)
      })
      await ReactTestRenderer.act(async () => answer([{ ...priced, quotedFeeSat: 4_000 }]))
      await settle()

      expect(sparkClaimDeposit).not.toHaveBeenCalled()
      expect(spoken).not.toHaveBeenCalled()
    })

    // A refresh whose read failed during the run leaves the card unchecked, which draws no fee
    // line; what is heard is the unchecked line itself.
    test('hears no fee when a refresh failed during the run, leaving it unchecked', async () => {
      const onClaimed = jest.fn()
      let answer: (list: SparkDeposit[]) => void = () => undefined
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
        .mockRejectedValueOnce(new Error('offline'))
      let tree!: ReactTestRenderer.ReactTestRenderer
      await ReactTestRenderer.act(async () => {
        tree = ReactTestRenderer.create(
          <UnclaimedDepositsCard onClaimed={onClaimed} refreshKey={0} />,
        )
      })
      await settle()

      await pressBtn(tree, i18n.t('deposits.acceptFee'))
      await ReactTestRenderer.act(async () => {
        tree.update(<UnclaimedDepositsCard onClaimed={onClaimed} refreshKey={1} />)
      })
      await settle()
      expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
      await ReactTestRenderer.act(async () => answer([{ ...priced, quotedFeeSat: 4_000 }]))
      await settle()

      expect(sparkClaimDeposit).not.toHaveBeenCalled()
      expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
      expect(spoken.mock.calls).toEqual([[i18n.t('deposits.unchecked')]])
    })

    test('hears nothing with the balance hidden, where the line shows no figure', async () => {
      jest
        .mocked(sparkListUnclaimedDeposits)
        .mockResolvedValueOnce([priced])
        .mockResolvedValueOnce([{ ...priced, quotedFeeSat: 4_000 }])
      const tree = await render(jest.fn(), true)

      await pressBtn(tree, i18n.t('deposits.acceptFee'))

      expect(sparkClaimDeposit).not.toHaveBeenCalled()
      expect(spoken).not.toHaveBeenCalled()
    })
  })
})

// Home refreshes the card on its own reloads. A refresh that fails is not an empty list: the card that
// was up stays, with no figure stated until a read answers, and a card that was not up is never drawn.
describe('a refresh that fails', () => {
  const a = { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'needsFee' as const, refundable: false, quotedFeeSat: 1_800 }
  const b = { txid: 'b', vout: 1, amountSat: 30_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, '')
  const sats = (n: number) => formatSats(n).replace(/\s/g, '')

  async function mount(onClaimed = jest.fn()): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<UnclaimedDepositsCard refreshKey={0} onClaimed={onClaimed} />)
    })
    await settle()
    return tree
  }

  async function refresh(
    tree: ReactTestRenderer.ReactTestRenderer,
    key: number,
    onClaimed = jest.fn(),
  ): Promise<void> {
    await ReactTestRenderer.act(async () => {
      tree.update(<UnclaimedDepositsCard refreshKey={key} onClaimed={onClaimed} />)
    })
    await settle()
  }

  function expectUnchecked(tree: ReactTestRenderer.ReactTestRenderer): void {
    expect(tree.toJSON()).not.toBeNull()
    expect(texts(tree)).toContain(i18n.t('deposits.title'))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
    expect(texts(tree)).not.toContain('Accept the fee and receive')
    expect(flat(tree)).not.toContain(sats(48_200))
    expect(flat(tree)).not.toContain(sats(1_800))
  }

  test('keeps the card up, marked as not checked, with no figure or fee', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await mount()
    expect(flat(tree)).toContain(sats(48_200))

    await refresh(tree, 1)

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(2)
    expectUnchecked(tree)
    expect(sparkClaimDeposit).not.toHaveBeenCalled()
  })

  test('while a refresh is in flight the card stays as the last read left it', async () => {
    let fail: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    const tree = await mount()

    await refresh(tree, 1)

    expect(flat(tree)).toContain(sats(48_200))
    expect(texts(tree)).toContain('Accept the fee and receive')
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))

    await ReactTestRenderer.act(async () => {
      fail?.(new Error('offline'))
    })
    await settle()
    expectUnchecked(tree)
  })

  test('a good read after the failed one brings the figure back and clears the line', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([b])
    const tree = await mount()
    await refresh(tree, 1)
    expectUnchecked(tree)

    await refresh(tree, 2)

    expect(flat(tree)).toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(48_200))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
  })

  test('a good read with nothing left to claim after the failed one takes the card away', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    const tree = await mount()
    await refresh(tree, 1)
    expectUnchecked(tree)

    await refresh(tree, 2)

    expect(tree.toJSON()).toBeNull()
  })

  test('Try again reads and claims nothing, and the claim after it takes only what the read says', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([b])
      .mockResolvedValueOnce([b]).mockResolvedValueOnce([])
    const onClaimed = jest.fn()
    const tree = await mount(onClaimed)
    await refresh(tree, 1, onClaimed)

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(3)
    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(onClaimed).not.toHaveBeenCalled()

    await pressBtn(tree, 'Receive')
    expect(jest.mocked(sparkClaimDeposit).mock.calls.map(call => call[0])).toEqual(['b'])
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  test('a Try again that fails too keeps the card not checked', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValue(new Error('offline'))
    const tree = await mount()
    await refresh(tree, 1)

    await pressBtn(tree, i18n.t('common.retry'))

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(3)
    expectUnchecked(tree)
    expect(tree.root.findByType(GradientButton).props.loading).toBe(false)
  })

  // A read that never answers holds nothing: the card stays as the last answer left it, and the next
  // refresh decides. The hung read landing late never lands over it.
  test('a refresh that never answers leaves the card as it was, and the next one decides', async () => {
    let hung: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (hung = resolve)))
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await mount()
    await refresh(tree, 1)
    expect(flat(tree)).toContain(sats(48_200))
    expect(texts(tree)).toContain('Accept the fee and receive')

    await refresh(tree, 2)
    expectUnchecked(tree)

    await ReactTestRenderer.act(async () => {
      hung?.([a, b])
    })
    await settle()
    expectUnchecked(tree)
  })

  test('a refresh that fails after a newer one answered changes nothing', async () => {
    let late: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise((_, reject) => (late = reject)))
      .mockResolvedValueOnce([b])
    const tree = await mount()
    await refresh(tree, 1)
    await refresh(tree, 2)
    expect(flat(tree)).toContain(sats(30_000))

    await ReactTestRenderer.act(async () => {
      late?.(new Error('offline'))
    })
    await settle()

    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
  })

  // A claim run's read starts after the refresh, so its answer is the newer one and stays.
  test('a refresh that fails after a claim run read the deposits again changes nothing', async () => {
    let late: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise((_, reject) => (late = reject)))
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([b])
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    const tree = await mount()
    await refresh(tree, 1)
    await pressBtn(tree, 'Accept the fee and receive')
    expect(flat(tree)).toContain(sats(30_000))

    await ReactTestRenderer.act(async () => {
      late?.(new Error('offline'))
    })
    await settle()

    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
  })

  // Nothing says there are funds to claim, so no card is drawn, also on the first read after the app
  // starts offline.
  test('a first read that fails draws no card', async () => {
    jest.mocked(sparkListUnclaimedDeposits).mockRejectedValue(new Error('offline'))
    const tree = await mount()

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(1)
    expect(tree.toJSON()).toBeNull()
  })

  test('a refresh that fails when no card was up draws none', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await mount()
    expect(tree.toJSON()).toBeNull()

    await refresh(tree, 1)

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(2)
    expect(tree.toJSON()).toBeNull()
  })

  test('after a claim run that left nothing, a refresh that fails draws no card', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await mount()
    await pressBtn(tree, 'Accept the fee and receive')
    expect(tree.toJSON()).toBeNull()

    await refresh(tree, 1)

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(tree.toJSON()).toBeNull()
  })

  test('after a Try again that left nothing, a refresh that fails draws no card', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('offline'))
    const tree = await mount()
    await refresh(tree, 1)
    await pressBtn(tree, i18n.t('common.retry'))
    expect(tree.toJSON()).toBeNull()

    await refresh(tree, 2)

    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(tree.toJSON()).toBeNull()
  })

  // The claim run's read is older than the refresh but answers first, so its empty list is the last
  // answer, and a refresh that then fails has nothing claimable to keep the card up for.
  test('a refresh started during a claim run read that left nothing draws no card when it fails', async () => {
    let claimRead: ((list: SparkDeposit[]) => void) | undefined
    let refreshFail: ((cause: Error) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (claimRead = resolve)))
      .mockImplementationOnce(() => new Promise((_, reject) => (refreshFail = reject)))
    const tree = await mount()
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()
    await refresh(tree, 1)
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)

    await ReactTestRenderer.act(async () => {
      claimRead?.([])
    })
    await settle()
    expect(tree.toJSON()).toBeNull()

    await ReactTestRenderer.act(async () => {
      refreshFail?.(new Error('offline'))
    })
    await settle()
    expect(tree.toJSON()).toBeNull()
  })

  // The claim line said what the last run did; once a refresh fails, what is left is not checked.
  test('a refresh that fails after a failed claim says the rest is not checked', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockResolvedValueOnce([b])
      .mockRejectedValueOnce(new Error('offline'))
    jest.mocked(sparkClaimDeposit).mockResolvedValueOnce('complete').mockRejectedValueOnce(new Error('fee'))
    const tree = await mount()
    await pressBtn(tree, 'Accept the fee and receive')
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
    expect(flat(tree)).toContain(sats(30_000))

    await refresh(tree, 1)

    expectUnchecked(tree)
    expect(flat(tree)).not.toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.claimFailed'))
  })

  // The claim's own payment event makes Home refresh while the run is still claiming.
  test('a refresh that fails during a claim run hides the figure until the run reads', async () => {
    const onClaimed = jest.fn()
    let first: ((s: 'complete') => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    jest.mocked(sparkClaimDeposit).mockImplementationOnce(() => new Promise(resolve => (first = resolve)))
    const tree = await mount(onClaimed)
    await ReactTestRenderer.act(async () => {
      tree.root.findByType(GradientButton).props.onPress()
    })
    await settle()

    await refresh(tree, 1, onClaimed)

    expectUnchecked(tree)
    expect(tree.root.findByType(GradientButton).props.loading).toBe(true)

    await ReactTestRenderer.act(async () => {
      first?.('complete')
    })
    await settle()

    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(tree.toJSON()).toBeNull()
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })
})

// A read that never answers would keep the spinner and the old figure, with Try again out of reach.
describe('a read after a claim run or a Try again that does not answer in time', () => {
  const a = { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const b = { txid: 'b', vout: 1, amountSat: 30_000, claimable: true, stage: 'arriving' as const, refundable: false }
  const flat = (tree: ReactTestRenderer.ReactTestRenderer) => texts(tree).join(' ').replace(/\s/g, '')
  const sats = (n: number) => formatSats(n).replace(/\s/g, '')
  const hang = () => new Promise<SparkDeposit[]>(() => undefined)
  const button = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(GradientButton)

  beforeEach(() => {
    jest.useFakeTimers()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  async function advance(ms: number): Promise<void> {
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(ms)
    })
    await settle()
  }

  function expectUncheckedAndFree(tree: ReactTestRenderer.ReactTestRenderer): void {
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain(i18n.t('common.retry'))
    expect(texts(tree)).not.toContain('Receive')
    expect(flat(tree)).not.toContain(sats(80_000))
    expect(flat(tree)).not.toContain(sats(50_000))
    expect(button(tree).props.loading).toBe(false)
    expect(button(tree).props.disabled).toBeFalsy()
  }

  test('after a claim run, the limit hides the figure and offers Try again, which only reads', async () => {
    const onClaimed = jest.fn()
    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b]).mockImplementationOnce(hang)
    const tree = await render(onClaimed)

    await pressBtn(tree, 'Receive')
    await advance(depositsRereadLimitMs() - 1)
    expect(button(tree).props.loading).toBe(true)

    await advance(1)
    expectUncheckedAndFree(tree)
    expect(onClaimed).not.toHaveBeenCalled()

    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([b])
    await pressBtn(tree, i18n.t('common.retry'))
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(4)
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(2)
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
  })

  test('a read before the run past the limit signs nothing, even when it answers later', async () => {
    let late: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    const tree = await render()

    await pressBtn(tree, 'Receive')
    await advance(depositsRereadLimitMs())
    expectUncheckedAndFree(tree)

    await ReactTestRenderer.act(async () => {
      late?.([a, b])
    })
    await settle()
    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(flat(tree)).toContain(sats(80_000))
    expect(texts(tree)).toContain('Receive')
  })

  // Nothing was signed, so the moved fee the late answer draws is said as an answer in time would
  // be.
  test('a read before the run that answers late with a moved quote says the new fee', async () => {
    const priced = { ...a, stage: 'needsFee' as const, quotedFeeSat: 1_000 }
    const spoken = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => {})
    let late: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([priced])
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    const tree = await render()

    await pressBtn(tree, i18n.t('deposits.acceptFee'))
    await advance(depositsRereadLimitMs())
    spoken.mockClear()
    await ReactTestRenderer.act(async () => {
      late?.([{ ...priced, quotedFeeSat: 4_000 }])
    })
    await settle()

    expect(sparkClaimDeposit).not.toHaveBeenCalled()
    expect(spoken.mock.calls).toEqual([[i18n.t('deposits.fee', { amount: formatSats(4_000) })]])
    spoken.mockRestore()
  })

  test('a Try again past the limit stays unchecked and can be tapped again', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(hang)
    const tree = await render()
    await pressBtn(tree, 'Receive')
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))

    await pressBtn(tree, i18n.t('common.retry'))
    await advance(depositsRereadLimitMs() - 1)
    expect(button(tree).props.loading).toBe(true)

    await advance(1)
    expectUncheckedAndFree(tree)

    jest.mocked(sparkListUnclaimedDeposits).mockResolvedValueOnce([])
    await pressBtn(tree, i18n.t('common.retry'))
    expect(sparkListUnclaimedDeposits).toHaveBeenCalledTimes(5)
    expect(sparkClaimDeposit).toHaveBeenCalledTimes(1)
    expect(tree.toJSON()).toBeNull()
  })

  test('an answer past the limit is dropped once a newer read has started', async () => {
    let late: ((list: SparkDeposit[]) => void) | undefined
    let newer: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
      .mockImplementationOnce(() => new Promise(resolve => (newer = resolve)))
    const tree = await render()
    await pressBtn(tree, 'Receive')
    await advance(depositsRereadLimitMs())
    await pressBtn(tree, i18n.t('common.retry'))

    await ReactTestRenderer.act(async () => {
      late?.([a])
    })
    await settle()
    expect(flat(tree)).not.toContain(sats(50_000))
    expect(texts(tree)).toContain(i18n.t('deposits.unchecked'))
    expect(button(tree).props.loading).toBe(true)

    await ReactTestRenderer.act(async () => {
      newer?.([b])
    })
    await settle()
    expect(flat(tree)).toContain(sats(30_000))
    expect(flat(tree)).not.toContain(sats(50_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
  })

  test('an answer past the limit with no newer read is taken and clears the line', async () => {
    const onClaimed = jest.fn()
    let late: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a, b]).mockResolvedValueOnce([a, b])
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    const tree = await render(onClaimed)
    await pressBtn(tree, 'Receive')
    await advance(depositsRereadLimitMs())
    expectUncheckedAndFree(tree)

    await ReactTestRenderer.act(async () => {
      late?.([b])
    })
    await settle()
    expect(flat(tree)).toContain(sats(30_000))
    expect(texts(tree)).not.toContain(i18n.t('deposits.unchecked'))
    expect(texts(tree)).toContain('Receive')
    expect(onClaimed).not.toHaveBeenCalled()
  })

  test('a Try again answer past the limit with no newer read is taken, and nothing left notifies', async () => {
    const onClaimed = jest.fn()
    let late: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    const tree = await render(onClaimed)
    await pressBtn(tree, 'Receive')
    await pressBtn(tree, i18n.t('common.retry'))
    await advance(depositsRereadLimitMs())
    expectUncheckedAndFree(tree)
    expect(onClaimed).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => {
      late?.([])
    })
    await settle()
    expect(tree.toJSON()).toBeNull()
    expect(onClaimed).toHaveBeenCalledTimes(1)
  })

  test('unmounting while the read waits leaves no timer and no state update', async () => {
    const errors = jest.spyOn(console, 'error').mockImplementation(() => undefined)
    let late: ((list: SparkDeposit[]) => void) | undefined
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a]).mockResolvedValueOnce([a])
      .mockImplementationOnce(() => new Promise(resolve => (late = resolve)))
    const onClaimed = jest.fn()
    const tree = await render(onClaimed)
    const set = jest.spyOn(global, 'setTimeout')
    const clear = jest.spyOn(global, 'clearTimeout')
    await pressBtn(tree, 'Receive')
    const at = set.mock.calls.map(call => call[1]).lastIndexOf(depositsRereadLimitMs())
    expect(at).toBeGreaterThanOrEqual(0)
    const limit = set.mock.results[at].value
    expect(clear).not.toHaveBeenCalledWith(limit)

    await ReactTestRenderer.act(async () => {
      tree.unmount()
    })
    expect(clear).toHaveBeenCalledWith(limit)

    await ReactTestRenderer.act(async () => {
      late?.([])
    })
    await settle()
    await advance(depositsRereadLimitMs())
    expect(onClaimed).not.toHaveBeenCalled()
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
    set.mockRestore()
    clear.mockRestore()
  })
})

describe('read aloud', () => {
  const a = {
    txid: 'a',
    vout: 0,
    amountSat: 50_000,
    claimable: true,
    stage: 'arriving' as const,
    refundable: false,
  }
  let heard: jest.SpyInstance
  beforeEach(() => {
    heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
  })
  afterEach(() => {
    heard.mockRestore()
  })

  test('says a failed claim as its line appears', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a])
      .mockResolvedValueOnce([a])
      .mockResolvedValueOnce([a])
    jest.mocked(sparkClaimDeposit).mockRejectedValueOnce(new Error('fee'))
    const tree = await render()
    expect(heard).not.toHaveBeenCalled()

    await pressBtn(tree, 'Receive')
    expect(texts(tree)).toContain(i18n.t('deposits.claimFailed'))
    expect(heard.mock.calls).toEqual([[i18n.t('deposits.claimFailed')]])
  })

  // The read after a failed claim can find nothing left, and the card then draws nothing to say.
  test('says nothing when the card leaves with the failed claim', async () => {
    jest
      .mocked(sparkListUnclaimedDeposits)
      .mockResolvedValueOnce([a])
      .mockResolvedValueOnce([a])
      .mockResolvedValueOnce([])
    jest.mocked(sparkClaimDeposit).mockRejectedValueOnce(new Error('fee'))
    const tree = await render()

    await pressBtn(tree, 'Receive')
    expect(tree.toJSON()).toBeNull()
    expect(heard).not.toHaveBeenCalled()
  })
})
