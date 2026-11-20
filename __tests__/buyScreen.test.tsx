import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import i18n from '../src/i18n'
import { GradientButton } from '../src/components/GradientButton'
import { BuyScreen } from '../src/screens/BuyScreen'
import { sparkBuyBitcoinUrl } from '../src/wallet/spark'
import { ReceiveHeldByExit } from '../src/wallet/errors'

jest.mock('../src/wallet/spark', () => ({ sparkBuyBitcoinUrl: jest.fn() }))

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
  })
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<BuyScreen />)
  })
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

async function press(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await flush()
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.mocked(sparkBuyBitcoinUrl).mockResolvedValue('https://buy.moonpay/session')
  jest.spyOn(Linking, 'openURL').mockResolvedValue(true)
})

test('opens the Moonpay purchase URL', async () => {
  const tree = await render()

  await press(tree, i18n.t('buy.cta'))

  expect(sparkBuyBitcoinUrl).toHaveBeenCalled()
  expect(Linking.openURL).toHaveBeenCalledWith('https://buy.moonpay/session')
})

test('shows an error when opening the URL fails', async () => {
  jest.spyOn(Linking, 'openURL').mockRejectedValue(new Error('no browser'))

  const tree = await render()
  await press(tree, i18n.t('buy.cta'))

  expect(texts(tree).join(' ')).toContain('Could not open the purchase')
})

// The spinner says it is working, so the button keeps naming the action beside it.
test('while the purchase opens the button keeps its label beside the spinner', async () => {
  jest.mocked(sparkBuyBitcoinUrl).mockImplementationOnce(() => new Promise(() => undefined))
  const tree = await render()
  await press(tree, i18n.t('buy.cta'))

  const button = tree.root.findByType(GradientButton)
  expect(button.props.loading).toBe(true)
  expect(button.props.label).toBe(i18n.t('buy.cta'))
})

// A purchase lands at the wallet's own address, so spark.ts holds it during an exit like any receive.
test.each([
  ['exit', 'emergencyExit.receiveHeld'],
  ['unread', 'emergencyExit.receiveHeldUnread'],
] as const)('a purchase held by the exit (%s) says why and opens nothing', async (hold, key) => {
  jest.mocked(sparkBuyBitcoinUrl).mockRejectedValueOnce(new ReceiveHeldByExit(hold))
  const tree = await render()
  await press(tree, i18n.t('buy.cta'))

  expect(Linking.openURL).not.toHaveBeenCalled()
  expect(texts(tree)).toContain(i18n.t(key))
  expect(texts(tree)).not.toContain(i18n.t('buy.failed'))
})
