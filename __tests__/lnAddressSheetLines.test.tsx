import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { LnAddressSheet } from '../src/components/LnAddressSheet'
import { Skeleton } from '../src/components/Skeleton'
import { sparkCheckLnAddress } from '../src/wallet/spark'
import { font } from '../src/theme'

// The status and retry lines under the name field. The purchase itself is covered by
// lnAddressSheet.test.tsx; these cases only read what the lines look like.
jest.mock('../src/wallet/spark', () => ({
  connectedLnurlDomain: jest.fn(() => undefined),
  sparkGetLnAddress: jest.fn(async () => null),
  sparkCheckLnAddress: jest.fn(async () => true),
  sparkRegisterLnAddress: jest.fn(),
  sparkDeleteLnAddress: jest.fn(async () => undefined),
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(),
  sparkConfirmSend: jest.fn(),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findAllByType(Text).flatMap(node => {
    const children = node.props.children
    return (Array.isArray(children) ? children : [children]).filter(
      (child): child is string => typeof child === 'string',
    )
  })
}

async function typed(name: string): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<LnAddressSheet visible onClose={jest.fn()} onRegistered={jest.fn()} />)
  })
  await ReactTestRenderer.act(async () => {
    tree.root.findByType(TextInput).props.onChangeText(name)
  })
  return tree
}

// Real timers, so settling means waiting past the 400ms availability debounce.
async function settle(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await new Promise<void>(resolve => setTimeout(resolve, 450))
  })
}

beforeEach(() => {
  jest.clearAllMocks()
})

it('holds the status line at its height while availability loads, with no word saying so', async () => {
  jest.mocked(sparkCheckLnAddress).mockReturnValue(new Promise(() => undefined))
  const tree = await typed('alice')
  const bars = tree.root.findAllByType(Skeleton)
  expect(bars).toHaveLength(1)
  expect(bars[0]!.props.height).toBe(font.leading.sm)
  expect(texts(tree)).not.toContain(i18n.t('receive.lnChecking'))
})

it('centres the status and retry lines, as every other line of the sheet is', async () => {
  jest.mocked(sparkCheckLnAddress).mockRejectedValue(new Error('offline'))
  const tree = await typed('alice')
  await settle()
  const line = (text: string) => tree.root.findAll(n => n.type === Text && n.props.children === text)[0]!
  expect(flat(line(i18n.t('receive.lnCheckFailed')).props.style).textAlign).toBe('center')
  const retry = tree.root.find(
    n => typeof n.props.onPress === 'function' && n.findAll(x => x.props.children === i18n.t('receive.lnCheckRetry')).length > 0,
  )
  expect(flat(retry.props.style).alignSelf).toBe('center')
  expect(flat(line(i18n.t('receive.lnCheckRetry')).props.style).textAlign).toBe('center')
})
