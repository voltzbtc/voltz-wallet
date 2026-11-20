import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet } from 'react-native'
import i18n from '../src/i18n'
import { UnclaimedDepositsCard } from '../src/components/UnclaimedDepositsCard'
import { GlassCard } from '../src/components/GlassCard'
import { GradientButton } from '../src/components/GradientButton'
import { sparkClaimDeposit, sparkListUnclaimedDeposits } from '../src/wallet/spark'
import { space } from '../src/theme'

jest.mock('../src/wallet/spark', () => ({
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

async function render(element: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  await settle()
  return tree
}

beforeEach(() => {
  jest.mocked(sparkListUnclaimedDeposits).mockReset()
  jest.mocked(sparkListUnclaimedDeposits).mockResolvedValue([
    { txid: 'a', vout: 0, amountSat: 50_000, claimable: true, stage: 'arriving', refundable: false },
  ])
  jest.mocked(sparkClaimDeposit).mockReset()
})

// The space around a primitive belongs to the screen that places it.
describe('where the card sits', () => {
  test('brings no margin of its own', async () => {
    const tree = await render(<UnclaimedDepositsCard />)
    const style = StyleSheet.flatten(tree.root.findByType(GlassCard).props.style)
    expect(style.marginTop).toBeUndefined()
  })

  test('takes the margin its caller passes', async () => {
    const tree = await render(<UnclaimedDepositsCard style={{ marginTop: space.xxl }} />)
    const style = StyleSheet.flatten(tree.root.findByType(GlassCard).props.style)
    expect(style.marginTop).toBe(space.xxl)
  })
})

// The spinner says the claim is running; the label stays the action's name, so the button does not
// change width or wording under the finger.
test('keeps the Claim label while the claim runs, beside the spinner', async () => {
  jest.mocked(sparkClaimDeposit).mockReturnValue(new Promise(() => undefined))
  const tree = await render(<UnclaimedDepositsCard />)
  const button = () => tree.root.findByType(GradientButton)
  expect(button().props.label).toBe(i18n.t('deposits.claim'))

  await ReactTestRenderer.act(async () => {
    button().props.onPress()
  })
  await settle()

  expect(button().props.loading).toBe(true)
  expect(button().props.label).toBe(i18n.t('deposits.claim'))
})
