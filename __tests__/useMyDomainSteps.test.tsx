import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { GradientButton } from '../src/components/GradientButton'
import { AccessibilityInfo, StyleSheet, Text, TextInput } from 'react-native'
import Clipboard from '@react-native-clipboard/clipboard'
import '../src/i18n'
import i18n from 'i18next'
import { UseMyDomainScreen } from '../src/screens/UseMyDomainScreen'
import { claimDomain, fetchPrices } from '../src/wallet/domainOnboard'
import { TabIcon } from '../src/components/TabIcon'
import { font } from '../src/theme'

// The DNS steps the domain screen hands over, read as lines. The purchase that leads here is covered
// by useMyDomainScreen.test.tsx.
jest.mock('../src/wallet/spark', () => ({
  sparkGetIdentityPubkey: jest.fn(async () => `02${'a'.repeat(64)}`),
  sparkSignMessage: jest.fn(async () => 'deadbeef'),
  sparkPrepareSend: jest.fn(),
  sparkSyncedBalanceSat: jest.fn(async () => 1_000_000),
  sparkGetBalanceSat: jest.fn(async () => 1_000_000),
  sparkConfirmSend: jest.fn(),
}))

jest.mock('../src/config', () => ({ getBreezLnurlDomain: () => 'lnurl.usevoltz.app', getDistribution: () => 'direct' }))

jest.mock('../src/wallet/walletRegistry', () => ({
  ...jest.requireActual('../src/wallet/walletRegistry'),
  getActiveWalletId: jest.fn(async () => null),
}))

jest.mock('@react-navigation/native', () => ({ useRoute: () => ({ params: undefined }) }))

jest.mock('../src/wallet/domainOnboard', () => ({
  ...jest.requireActual('../src/wallet/domainOnboard'),
  claimDomain: jest.fn(),
  quoteDomain: jest.fn(),
  confirmDomain: jest.fn(),
  fetchPrices: jest.fn(),
}))

function texts(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => [node.props.children].flat().filter((c: unknown): c is string => typeof c === 'string'))
}

async function settle(tree?: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
      tree?.update(<UseMyDomainScreen />)
    })
  }
}

async function atTheSteps(): Promise<ReactTestRenderer.ReactTestRenderer> {
  jest.mocked(claimDomain).mockResolvedValue({
    host: 'pay.bakery.com.br',
    provider: 'hostinger',
    supportsRoot: false,
    isRoot: false,
    target: 'saas.usevoltz.app',
    state: 'awaiting_dns',
  })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    tree.root
      .findAll(node => typeof node.props.onPress === 'function')
      .find(node => node.findAllByType(Text).some(text => text.props.children === 'Continue'))!
      .props.onPress()
  })
  await settle(tree)
  return tree
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers()
  jest.mocked(fetchPrices).mockResolvedValue({ domain_tier: 9990 })
})

afterEach(() => {
  jest.useRealTimers()
})

// The pair was glued with an English colon outside t(), so no language could write it its own way.
describe('each step line', () => {
  const original = i18n.t('useDomain.stepLine')
  afterEach(() => {
    i18n.addResource(i18n.language, 'translation', 'useDomain.stepLine', original)
  })

  it('is written by the locale, field and value together', async () => {
    i18n.addResource(i18n.language, 'translation', 'useDomain.stepLine', '{{label}} = {{value}}')
    const shown = texts(await atTheSteps())
    expect(shown).toContain(`${i18n.t('useDomain.stepType')} = CNAME`)
    expect(shown).toContain(`${i18n.t('useDomain.stepTarget')} = saas.usevoltz.app`)
  })
})

// What gets typed into a DNS panel, so it copies, says so, and reads character by character.
describe('the name and target rows', () => {
  const targetRow = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.feedback !== undefined)
      .find(n => n.findAllByType(Text).some(x => String(x.props.children).endsWith('saas.usevoltz.app')))!

  it('copies, shows Copied with a check, and says it to a screen reader, for a moment', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
    try {
      const tree = await atTheSteps()
      expect(texts(tree)).not.toContain(i18n.t('useDomain.copied'))
      await ReactTestRenderer.act(async () => targetRow(tree).props.onPress())
      expect(Clipboard.setString).toHaveBeenLastCalledWith('saas.usevoltz.app')
      expect(announce).toHaveBeenCalledWith(i18n.t('useDomain.copied'))
      expect(texts(tree)).toContain(i18n.t('useDomain.copied'))
      expect(targetRow(tree).findByType(TabIcon).props.name).toBe('check')

      await ReactTestRenderer.act(async () => {
        jest.advanceTimersByTime(2000)
      })
      expect(texts(tree)).not.toContain(i18n.t('useDomain.copied'))
      expect(targetRow(tree).findByType(TabIcon).props.name).toBe('copy')
    } finally {
      announce.mockRestore()
    }
  })

  it('draws the name and the target in the monospaced face', async () => {
    const tree = await atTheSteps()
    const mono = tree.root
      .findAllByType(Text)
      .filter(n => StyleSheet.flatten(n.props.style)?.fontFamily === font.mono)
      .map(n => String(n.props.children))
    expect(mono).toHaveLength(2)
    expect(mono[1]).toContain('saas.usevoltz.app')
  })
})

// Buttons shrink under a finger and cards that are choices do not flash, one answer each.
it('answers a press like a button on the actions, and the same way on both place choices', async () => {
  jest.mocked(claimDomain).mockReset()
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<UseMyDomainScreen />)
  })
  await settle()
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[0]!.props.onChangeText('bakery.com.br')
  })
  await settle()
  const choices = tree.root.findAll(n => n.props.state?.selected !== undefined && n.props.feedback !== undefined)
  expect(choices.map(n => n.props.feedback)).toEqual(['none', 'none'])
  await ReactTestRenderer.act(async () => choices[0]!.props.onPress())
  const button = (root: ReactTestRenderer.ReactTestInstance, label: string) =>
    root.findAllByType(GradientButton).find(n => n.props.label === label)
  expect(button(tree.root, i18n.t('useDomain.rootHaveSite', { domain: 'bakery.com.br' }))?.props.variant).toBe('secondary')

  const steps = await atTheSteps()
  expect(button(steps.root, i18n.t('useDomain.sendSteps'))?.props.variant).toBe('secondary')
})
