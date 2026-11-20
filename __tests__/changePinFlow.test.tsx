import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { ChangePinFlow } from '../src/navigation/RootNavigator'
import { verifyPin } from '../src/wallet/pin'

jest.mock('../src/wallet/pin', () => ({
  verifyPin: jest.fn(),
  hasPin: jest.fn(),
  savePin: jest.fn(),
}))

async function flush(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await Promise.resolve()
  })
}

async function pressDigit(tree: ReactTestRenderer.ReactTestRenderer, digit: string): Promise<void> {
  const key = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(t => t.props.children === digit))
  if (!key) {
    throw new Error(`keypad digit not found: ${digit}`)
  }
  await ReactTestRenderer.act(async () => {
    key.props.onPress()
  })
  await flush()
}

async function pressMany(tree: ReactTestRenderer.ReactTestRenderer, digit: string, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await pressDigit(tree, digit)
  }
}

function titles(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(n => {
    const c = n.props.children
    return typeof c === 'string' ? [c] : []
  })
}

// Without distinct keys React reuses the PinScreen instance across both phases, carrying the six
// filled dots from the verified PIN into the new step and freezing input.
test('the new-PIN step starts empty and accepts a fresh PIN after verifying the current one', async () => {
  jest.mocked(verifyPin).mockResolvedValue(true)
  const onDone = jest.fn()

  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChangePinFlow onDone={onDone} />)
  })
  await flush()

  for (const d of ['1', '2', '3', '4', '5', '6']) {
    await pressDigit(tree, d)
  }

  expect(titles(tree)).toContain('Enter new PIN')

  // Set mode asks for the new PIN and then its confirmation, hence the two runs.
  await pressMany(tree, '9', 6)
  await pressMany(tree, '9', 6)
  expect(onDone).toHaveBeenCalledWith('999999')
})

test('changing the PIN offers no way out of a forgotten one, since the app is already open', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ChangePinFlow onDone={() => undefined} />)
  })
  expect(tree.root.findAllByType(Text).some(node => node.props.children === i18n.t('pin.forgot'))).toBe(false)
})
