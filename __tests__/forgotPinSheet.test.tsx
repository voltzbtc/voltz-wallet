import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import '../src/i18n'
import { ForgotPinSheet } from '../src/components/ForgotPinSheet'
import { GradientButton } from '../src/components/GradientButton'
import { Notice } from '../src/components/Notice'
import { TabIcon } from '../src/components/TabIcon'
import { Txt } from '../src/components/Txt'
import { countUnconfirmedWallets } from '../src/wallet/wallet'

jest.mock('../src/wallet/wallet', () => ({
  countUnconfirmedWallets: jest.fn(async () => 0),
  eraseAllWallets: jest.fn(),
}))
jest.mock('../src/wallet/biometrics', () => ({ passesDeviceCheck: jest.fn() }))

// The press that can cost a wallet never wears the colour that says go.
test('erasing is drawn as danger, and Cancel is the plain way out', async () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ForgotPinSheet visible onClose={jest.fn()} onErased={jest.fn()} />)
  })
  expect(tree.root.findAllByType(GradientButton).map(button => button.props.variant)).toEqual(['danger', 'secondary'])
})

// The two stacked with one red read as two warnings, and the button lost its place as the action.
test('the warning above the erase is not drawn in the erase button\'s red', async () => {
  jest.mocked(countUnconfirmedWallets).mockResolvedValueOnce(2)
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ForgotPinSheet visible onClose={jest.fn()} onErased={jest.fn()} />)
  })

  const notice = tree.root.findByType(Notice)
  expect(notice.props.tone).not.toBe('danger')
  expect(notice.findAllByType(TabIcon).map(icon => icon.props.name)).toEqual(['alert'])
  expect(notice.findByType(Txt).props.tone).not.toBe('danger')
  expect(tree.root.findAllByType(GradientButton)[0].props.variant).toBe('danger')
})
