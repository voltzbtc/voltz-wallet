import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Modal, Switch, Text } from 'react-native'
import i18n from '../src/i18n'
import { SpendHeldByExit } from '../src/wallet/errors'
import { StableBalanceScreen } from '../src/screens/StableBalanceScreen'
import {
  connectActiveSpark,
  sparkConnectedWalletId,
  sparkDiscardConvertQuote,
  sparkGetIdentityPubkey,
  sparkGetStableBalance,
  sparkPrepareConvertBySpend,
  sparkSetStableBalance,
} from '../src/wallet/spark'
import { fetchUsdbPayouts, fetchUsdbRewards } from '../src/wallet/rewards'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import { font } from '../src/theme'
import { FigureRow } from '../src/components/FigureRow'
import { Txt } from '../src/components/Txt'
import { Skeleton } from '../src/components/Skeleton'
import { figuresHeldOut, figuresIn } from './support/figureFit'

jest.mock('../src/wallet/spark', () => ({
  connectActiveSpark: jest.fn(async () => undefined),
  sparkConnectedWalletId: jest.fn(() => 'primary'),
  sparkConversionLimits: jest.fn(async () => ({})),
  sparkDiscardConvertQuote: jest.fn(),
  sparkGetFiatRates: jest.fn(async () => ({ USD: 100_000 })),
  sparkGetWalletInfo: jest.fn(async () => ({ sync: 'synced', balanceSat: 100_000, tokens: [] })),
  sparkPrepareConvertBySpend: jest.fn(async () => ({
    handle: 'q1',
    spentBaseUnits: 100_000,
    receivedBaseUnits: 99_500_000,
    feeBaseUnits: 500_000,
  })),
  sparkGetStableBalance: jest.fn(async () => false),
  sparkSetStableBalance: jest.fn(async () => undefined),
  sparkGetIdentityPubkey: jest.fn(async () => '02' + 'ab'.repeat(32)),
}))
const mockNavigate = jest.fn()
jest.mock('@react-navigation/native', () => ({ useNavigation: () => ({ navigate: mockNavigate }) }))
jest.mock('../src/wallet/walletRegistry', () => ({
  getActiveWalletId: jest.fn(async () => 'primary'),
}))
jest.mock('../src/wallet/rewards', () => ({
  fetchUsdbRewards: jest.fn(async () => null),
  fetchUsdbPayouts: jest.fn(async () => []),
}))

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<StableBalanceScreen />)
  })
  await flush()
  return tree
}

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return textsIn(tree.root)
}

function textsIn(root: ReactTestRenderer.ReactTestInstance): string[] {
  return root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

function toggleSwitch(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.findByType(Switch)
}

// The pressable row a node sits in, found by the press handler the row carries.
function rowAround(
  node: ReactTestRenderer.ReactTestInstance,
): ReactTestRenderer.ReactTestInstance | undefined {
  for (let at = node.parent; at; at = at.parent) {
    if (typeof at.props.onPress === 'function' && at.props.accessibilityState) {
      return at
    }
  }
  return undefined
}

// The confirmation is a Voltz-styled sheet in a Modal, not a native alert.
function confirmSheet(
  tree: ReactTestRenderer.ReactTestRenderer,
): ReactTestRenderer.ReactTestInstance {
  return tree.root.findByType(Modal)
}

function pressButton(tree: ReactTestRenderer.ReactTestRenderer, label: string): void {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  btn.props.onPress()
}

// Either direction opens the confirmation sheet first, so reaching the SDK needs the confirm press.
async function flip(tree: ReactTestRenderer.ReactTestRenderer, next: boolean): Promise<void> {
  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(next)
  })
  await ReactTestRenderer.act(async () => {
    pressButton(tree, next ? 'Convert' : 'Back to bitcoin')
  })
  await flush()
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(connectActiveSpark).mockResolvedValue(undefined)
  jest.mocked(sparkGetStableBalance).mockResolvedValue(false)
  jest.mocked(sparkSetStableBalance).mockResolvedValue(undefined)
  jest.mocked(sparkConnectedWalletId).mockReturnValue('primary')
  jest.mocked(getActiveWalletId).mockResolvedValue('primary')
  jest.mocked(sparkGetIdentityPubkey).mockResolvedValue('02' + 'ab'.repeat(32))
  jest.mocked(fetchUsdbRewards).mockResolvedValue(null)
  jest.mocked(fetchUsdbPayouts).mockResolvedValue([])
})

test('the switch shows the state the SDK reports: off', async () => {
  const tree = await render()
  expect(toggleSwitch(tree).props.value).toBe(false)
})

test('the switch shows the state the SDK reports: on', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()
  expect(toggleSwitch(tree).props.value).toBe(true)
})

test('a line of its own says the mode belongs to this device', async () => {
  const tree = await render()

  expect(texts(tree)).toContain(i18n.t('stable.deviceOnly'))
})

test('turning it on asks the SDK to activate the stable balance', async () => {
  const tree = await render()

  await flip(tree, true)

  expect(sparkSetStableBalance).toHaveBeenCalledWith(true)
  expect(toggleSwitch(tree).props.value).toBe(true)
})

test('turning it on asks for confirmation first, because it converts the whole balance', async () => {
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await flush()

  expect(confirmSheet(tree).props.visible).toBe(true)
  expect(sparkSetStableBalance).not.toHaveBeenCalled()
})

test('canceling the confirmation leaves the balance in bitcoin and the switch off', async () => {
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await ReactTestRenderer.act(async () => {
    pressButton(tree, 'Cancel')
  })
  await flush()

  expect(sparkSetStableBalance).not.toHaveBeenCalled()
  expect(toggleSwitch(tree).props.value).toBe(false)
  expect(confirmSheet(tree).props.visible).toBe(false)
})

test('turning it off asks the SDK to deactivate it (both directions move funds)', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()

  await flip(tree, false)

  expect(sparkSetStableBalance).toHaveBeenCalledWith(false)
  expect(toggleSwitch(tree).props.value).toBe(false)
})

test('turning it off also asks for confirmation, since it converts the whole balance back', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(false)
  })
  await flush()

  expect(confirmSheet(tree).props.visible).toBe(true)
  expect(sparkSetStableBalance).not.toHaveBeenCalled()
})

test('a failed switch snaps back and says so, instead of claiming a conversion that never happened', async () => {
  jest.mocked(sparkSetStableBalance).mockRejectedValue(new Error('spark not connected'))
  const tree = await render()

  await flip(tree, true)

  // A switch left on after a failed conversion claims the money is in dollars while it is still in bitcoin.
  expect(toggleSwitch(tree).props.value).toBe(false)
  expect(texts(tree).join(' ')).toContain('Could not change it right now')
})

// spark.ts refuses to turn the mode on while an exit holds the wallet, since that sells its sats.
test.each([
  ['exit', 'emergencyExit.spendHeld'],
  ['unread', 'emergencyExit.spendHeldUnread'],
] as const)('a switch an exit holds (%s) snaps back and says why', async (hold, key) => {
  jest.mocked(sparkSetStableBalance).mockRejectedValue(new SpendHeldByExit(hold))
  const tree = await render()

  await flip(tree, true)

  expect(toggleSwitch(tree).props.value).toBe(false)
  expect(texts(tree).join(' ')).toContain(i18n.t(key))
})

test('the switch is locked while the SDK works, so a double tap cannot fire two conversions', async () => {
  let release: (() => void) | undefined
  jest.mocked(sparkSetStableBalance).mockImplementation(
    () =>
      new Promise<void>(resolve => {
        release = () => resolve()
      }),
  )
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await ReactTestRenderer.act(async () => {
    pressButton(tree, 'Convert')
  })

  expect(toggleSwitch(tree).props.disabled).toBe(true)
  // The row around it refuses the press as well, and says so.
  expect(rowAround(toggleSwitch(tree))?.props.accessibilityState?.disabled).toBe(true)

  await ReactTestRenderer.act(async () => {
    release?.()
  })
  await flush()
  expect(rowAround(toggleSwitch(tree))?.props.accessibilityState?.disabled).toBe(false)
  expect(sparkSetStableBalance).toHaveBeenCalledTimes(1)
})

test('no rewards to report shows the minimum-holding note, not a row of zeros', async () => {
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Nothing to show yet')
  // A zero estimate rendered as data claims nothing accrued today, which is not the same as
  // holding below the minimum.
  expect(shown).not.toContain("Today's estimate")
})

// The section from its title to the line that credits Flashnet.
function rewardsSection(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance {
  const title = tree.root
    .findAllByType(Text)
    .find(n => n.props.children === i18n.t('stable.rewardsTitle', { ticker: 'USDB' }))!
  const issuer = i18n.t('stable.rewardsIssuer', { ticker: 'USDB' })
  for (let at = title.parent; at; at = at.parent) {
    if (textsIn(at).includes(issuer)) {
      return at
    }
  }
  throw new Error('rewards section not found')
}

test('reported rewards show the estimate for today and the balance counted', async () => {
  jest.mocked(fetchUsdbRewards).mockResolvedValue({
    balance: '1250.5',
    percent: 4.5,
    estimatedSatsToday: 137,
  })
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain("Today's estimate")
  expect(shown).toContain('137')
  expect(shown).toContain('Balance counted')
  // The en test locale groups thousands, so the raw "1250.5" from the API renders grouped.
  expect(shown).toContain('1,250.5')
})

// Flashnet sets the rate and its rules and can change or end them, so a rate drawn here would read as
// a figure the app stands behind.
test('the rewards show no rate, whatever the API reports', async () => {
  jest.mocked(fetchUsdbRewards).mockResolvedValue({
    balance: '1250.5',
    percent: 4.75,
    estimatedSatsToday: 137,
  })
  const tree = await render()

  const section = textsIn(rewardsSection(tree))
  expect(section.join(' ')).toContain("Today's estimate")
  expect(section.filter(line => line.includes('%'))).toEqual([])
  expect(texts(tree).filter(line => /4[.,]75/.test(line))).toEqual([])
})

test('while the rewards are read, the card holds the two rows it lands in and no rate', async () => {
  let answer: (value: null) => void = () => undefined
  jest.mocked(fetchUsdbRewards).mockReturnValue(new Promise(resolve => (answer = resolve)))
  const tree = await render()

  const placeholders = tree.root.findAllByType(Skeleton)
  expect(placeholders).toHaveLength(4)
  expect(placeholders.filter(p => p.props.height === font.leading.xxl)).toEqual([])

  await ReactTestRenderer.act(async () => {
    answer(null)
  })
})

test('the rewards are credited to their issuer, never presented as something Voltz pays', async () => {
  jest.mocked(fetchUsdbRewards).mockResolvedValue({
    balance: '1250.5',
    percent: 4.5,
    estimatedSatsToday: 137,
  })
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Flashnet')
  expect(shown).toContain('no cut')
  expect(shown).toContain("The rules and the amount are Flashnet's and can change or end.")
  // A raw "{{ticker}}" reaching the screen means the call site forgot to interpolate.
  expect(shown).not.toContain('{{')
  expect(shown).toContain('10 USDB')
})

test('an empty payout history hides the section rather than showing an empty card', async () => {
  const tree = await render()
  expect(texts(tree).join(' ')).not.toContain('Recent payouts')
})

test('payouts render per day, flagging the ones not settled yet', async () => {
  jest.mocked(fetchUsdbPayouts).mockResolvedValue([
    { day: '2026-08-05', sats: 137, paid: true },
    { day: '2026-08-06', sats: 210, paid: false },
  ])
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).toContain('Recent payouts')
  expect(shown).toContain('137')
  expect(shown).toContain('210')
  expect(shown).toContain('pending')
})

test('a payout dated with a full ISO timestamp still renders as a date', async () => {
  jest
    .mocked(fetchUsdbPayouts)
    .mockResolvedValue([{ day: '2026-08-25T00:00:00.000Z', sats: 3, paid: true }])
  const tree = await render()

  const shown = texts(tree).join(' ')
  expect(shown).not.toContain('2026-08-25T00:00:00.000Z')
  expect(shown).toContain('3')
  expect(shown).toMatch(/\d{1,2}\/\d{1,2}\/\d{4}|Aug/)
})

test('a rewards outage never blocks the switch', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockRejectedValue(new Error('spark not connected'))
  const tree = await render()

  await flip(tree, true)

  expect(sparkSetStableBalance).toHaveBeenCalledWith(true)
})

test('the screen never frames the dollar balance as an investment', async () => {
  jest.mocked(fetchUsdbRewards).mockResolvedValue({
    balance: '1250.5',
    percent: 4.5,
    estimatedSatsToday: 137,
  })
  jest.mocked(fetchUsdbPayouts).mockResolvedValue([{ day: '2026-08-05', sats: 137, paid: true }])
  const tree = await render()

  // Investment language would put the product in a regulated category, so a balance is never framed
  // as an investment, in any locale (docs/principles.md).
  for (const line of texts(tree)) {
    expect(line).not.toMatch(/invest|yield|profit|earn on|rende|lucro|aplica/i)
  }
})

test('the payout list is a preview of five, not the whole record', async () => {
  jest
    .mocked(fetchUsdbPayouts)
    .mockResolvedValue(
      Array.from({ length: 12 }, (_, i) => ({ day: `2026-08-${10 + i}`, sats: i + 1, paid: true })),
    )
  const tree = await render()

  expect(fetchUsdbPayouts).toHaveBeenCalledWith(expect.any(String), 5)
  const shown = texts(tree).join(' ')
  expect(shown).toContain('1 sats')
  expect(shown).toContain('5 sats')
  expect(shown).not.toContain('12 sats')
})

test('see all opens the history, where the full record lives', async () => {
  jest.mocked(fetchUsdbPayouts).mockResolvedValue([{ day: '2026-08-05', sats: 3, paid: true }])
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    pressButton(tree, 'See all')
  })

  expect(mockNavigate).toHaveBeenCalledWith('Main', {
    screen: 'Tabs',
    params: { screen: 'History' },
  })
})

// A failed rewards read is not the end of the card: the same read can be asked for again.
test('a rewards read that failed offers Try again, which reads again and shows the rewards', async () => {
  jest.mocked(sparkGetIdentityPubkey).mockRejectedValueOnce(new Error('spark not connected'))
  jest.mocked(fetchUsdbRewards).mockResolvedValue({ balance: '1250.5', percent: 4.5, estimatedSatsToday: 137 })
  const tree = await render()
  expect(fetchUsdbRewards).not.toHaveBeenCalled()
  expect(texts(tree)).toContain(i18n.t('common.retry'))

  await ReactTestRenderer.act(async () => {
    pressButton(tree, i18n.t('common.retry'))
  })
  await flush()

  expect(fetchUsdbRewards).toHaveBeenCalledTimes(1)
  expect(texts(tree).join(' ')).toContain("Today's estimate")
  expect(texts(tree)).not.toContain(i18n.t('common.retry'))
})

// The row's text names the switch, and a label on the switch too made a screen reader say it twice.
test('the dollar switch is named once, by its row', async () => {
  const tree = await render()
  expect(toggleSwitch(tree).props.accessibilityLabel).toBeUndefined()
  const row = rowAround(toggleSwitch(tree))
  expect(row?.findAllByType(Text).map(text => text.props.children)).toContain(i18n.t('stable.toggle'))
})

// The rewards and payout figures share the rule of every label and figure, so at the largest text
// size each goes under its label rather than being squeezed beside it.
test('the rewards and each payout lay their figures out through FigureRow', async () => {
  jest.mocked(fetchUsdbRewards).mockResolvedValue({ balance: '1250.5', percent: 4.5, estimatedSatsToday: 137 })
  jest.mocked(fetchUsdbPayouts).mockResolvedValue([
    { day: '2026-08-05', sats: 137, paid: true },
    { day: '2026-08-06', sats: 210, paid: false },
  ])
  const tree = await render()
  const rows = tree.root.findAllByType(FigureRow)
  expect(rows).toHaveLength(4)
  expect(rows.slice(0, 2).map(row => row.props.label)).toEqual(["Today's estimate", 'Balance counted'])
  expect(rows.flatMap(row => figuresIn(row)).length).toBe(4)
  expect(figuresHeldOut(tree.root)).toEqual([])
  // A payout's day is its label, so it wraps between words beside the pending mark.
  const day = rows[3].findAllByType(Txt).find(n => n.props.role === 'body')!
  expect(day.props.wholeWords).toBe(true)
})

function primaryButton(tree: ReactTestRenderer.ReactTestRenderer, label: string): ReactTestRenderer.ReactTestInstance {
  const found = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && n.props.accessibilityState !== undefined)
    .find(n => n.findAllByType(Text).some(t => t.props.children === label))
  if (!found) {
    throw new Error(`button not found: ${label}`)
  }
  return found
}

// One rule for every wallet: the switch shows what the SDK answers, and a press asks first.
test('the switch shows the mode the SDK answers, stays live, and a press asks first', async () => {
  jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
  const tree = await render()

  expect(toggleSwitch(tree).props.value).toBe(true)
  expect(toggleSwitch(tree).props.disabled).toBe(false)
  expect(texts(tree)).toContain(i18n.t('stable.toggleHint'))
  expect(texts(tree)).toContain(i18n.t('stable.deviceOnly'))

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(false)
  })

  expect(confirmSheet(tree).props.visible).toBe(true)
  expect(sparkSetStableBalance).not.toHaveBeenCalled()
})

test('two presses on Convert make one call', async () => {
  const tree = await render()
  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await flush()

  await ReactTestRenderer.act(async () => {
    const confirm = primaryButton(tree, 'Convert').props.onPress
    confirm()
    confirm()
  })
  await flush()

  expect(sparkSetStableBalance).toHaveBeenCalledTimes(1)
})

test('a switch with the SDK still on the previous wallet does not move, says so and reads again', async () => {
  jest.mocked(sparkConnectedWalletId).mockReturnValue('other')
  const tree = await render()
  const reads = jest.mocked(sparkGetStableBalance).mock.calls.length

  await flip(tree, true)

  expect(sparkSetStableBalance).not.toHaveBeenCalled()
  expect(toggleSwitch(tree).props.value).toBe(false)
  expect(texts(tree)).toContain('Could not change it right now.')
  expect(connectActiveSpark).toHaveBeenCalled()
  expect(jest.mocked(sparkGetStableBalance).mock.calls.length).toBeGreaterThan(reads)
})

// The connection an ended exit leaves reads the mode as off and refuses to turn it on until the next
// connection request replaces it (stableSwitchAfterExit.test.tsx runs this on the real spark.ts).
describe('a connection request first', () => {
  const order = (mock: jest.Mock): number => mock.mock.invocationCallOrder[0]

  test('the mode is read after one', async () => {
    await render()
    expect(connectActiveSpark).toHaveBeenCalled()
    expect(order(jest.mocked(connectActiveSpark))).toBeLessThan(order(jest.mocked(sparkGetStableBalance)))
  })

  test('a request that fails still reads the mode of what is connected', async () => {
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('spark connection timeout'))
    jest.mocked(sparkGetStableBalance).mockResolvedValue(true)
    const tree = await render()
    expect(toggleSwitch(tree).props.value).toBe(true)
  })

  test('a switch asks for one before it converts', async () => {
    const tree = await render()
    jest.mocked(connectActiveSpark).mockClear()
    await flip(tree, true)
    expect(connectActiveSpark).toHaveBeenCalledTimes(1)
    expect(order(jest.mocked(connectActiveSpark))).toBeLessThan(order(jest.mocked(sparkSetStableBalance)))
  })

  test('a switch whose request fails with the wallet still connected goes on, as it did', async () => {
    const tree = await render()
    jest.mocked(connectActiveSpark).mockRejectedValue(new Error('spark connection timeout'))
    await flip(tree, true)
    expect(sparkSetStableBalance).toHaveBeenCalledWith(true)
  })

  test.each([
    ['fails and leaves nothing connected', null, true],
    ['lands on another wallet', 'other', false],
  ] as const)('a switch whose request %s converts nothing, says so and reads again', async (_name, after, fails) => {
    const tree = await render()
    const reads = jest.mocked(sparkGetStableBalance).mock.calls.length
    jest.mocked(connectActiveSpark).mockImplementation(async () => {
      jest.mocked(sparkConnectedWalletId).mockReturnValue(after)
      if (fails) {
        throw new Error('spark connection timeout')
      }
    })
    await flip(tree, true)
    expect(sparkSetStableBalance).not.toHaveBeenCalled()
    expect(toggleSwitch(tree).props.value).toBe(false)
    expect(toggleSwitch(tree).props.disabled).toBe(false)
    expect(texts(tree)).toContain('Could not change it right now.')
    expect(jest.mocked(sparkGetStableBalance).mock.calls.length).toBeGreaterThan(reads)
  })
})

test('the sheet shows the estimate of the quote it dropped', async () => {
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await flush()

  expect(texts(tree)).toContain(i18n.t('stable.costEstimate', { pct: '0.5' }))
  expect(sparkDiscardConvertQuote).toHaveBeenCalledTimes(1)
})

test('while the estimate is out Convert waits, and a failed one leaves Convert standing', async () => {
  let fail: (cause: Error) => void = () => undefined
  jest.mocked(sparkPrepareConvertBySpend).mockReturnValueOnce(new Promise((_, reject) => (fail = reject)))
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await flush()
  expect(primaryButton(tree, 'Convert').props.accessibilityState.disabled).toBe(true)

  await ReactTestRenderer.act(async () => {
    fail(new Error('pool down'))
  })
  await flush()

  expect(texts(tree)).toContain(i18n.t('stable.costUnknown'))
  expect(primaryButton(tree, 'Convert').props.accessibilityState.disabled).toBeFalsy()
})

test('below the minimum the sheet names it and shows no cost', async () => {
  const { sparkGetWalletInfo, sparkConversionLimits } = jest.requireMock('../src/wallet/spark')
  sparkGetWalletInfo.mockResolvedValueOnce({ sync: 'synced', balanceSat: 500, tokens: [] })
  sparkConversionLimits.mockResolvedValueOnce({ minFromBaseUnits: 1000 })
  const tree = await render()

  await ReactTestRenderer.act(async () => {
    toggleSwitch(tree).props.onValueChange(true)
  })
  await flush()

  expect(texts(tree)).toContain(i18n.t('stable.belowMinimumAmount', { min: '1\u00A0000 sats' }))
})
