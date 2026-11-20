import React from 'react'
import ReactTestRenderer, { act, type ReactTestRenderer as Renderer } from 'react-test-renderer'
import { Linking, Text } from 'react-native'
import i18n from '../src/i18n'
import { expectMailFallback, expectNoMailFallback, mailBody, pressCopy } from './support/mailFallback'
import { DeleteDataScreen } from '../src/screens/DeleteDataScreen'
import { GradientButton } from '../src/components/GradientButton'
import { MenuRow } from '../src/components/MenuRow'
import { previewOrAdopt, requestDeletion, settleDeletion, type DeletionPreview, type RequestResult } from '../src/wallet/deletion'
import { lastLnAddress } from '../src/wallet/lnAddressMemory'
import { passkeyRemovalNote } from '../src/wallet/passkey'
import { SupportMailCard } from '../src/components/SupportMail'
import { confirmQuestion } from './support/question'

// The screen against its reads, each one driven here. Focus is driven too: the real hook needs a
// navigator, and these cases turn on what a press answered while the screen was away leaves behind.
jest.mock('../src/wallet/deletion', () => ({
  liveDeletionDeps: jest.fn(async () => ({ walletId: 'primary', pubkey: '02ab', sign: async () => 'sig' })),
  settleDeletion: jest.fn(),
  previewOrAdopt: jest.fn(),
  requestDeletion: jest.fn(),
  activeDeletionView: jest.fn(async () => ({ kind: 'none' })),
}))
jest.mock('../src/wallet/lnAddressMemory', () => ({ lastLnAddress: jest.fn(async () => null) }))
jest.mock('../src/wallet/passkey', () => ({ passkeyRemovalNote: jest.fn(async () => null) }))
let focus: (() => void | (() => void)) | null = null
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: jest.fn(), goBack: jest.fn() }),
  useRoute: () => ({ params: undefined }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    focus = cb
  },
}))

const PREVIEW: DeletionPreview = {
  names: [
    { domain: 'usevoltz.app', name: 'alice' },
    { domain: 'usevoltz.app', name: 'zed' },
  ],
  purchases: [],
  ownDomains: [],
  blockers: [],
  stays: ['mark'],
  owed: [],
}

function textOf(renderer: Renderer): string {
  return renderer.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat().join(''))
    .join('\n')
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve))
    })
  }
}

// Mounts, then focuses; the returned function blurs, as leaving the screen does.
async function mountFocused(): Promise<{ screen: Renderer; blur: () => void }> {
  let screen!: Renderer
  await act(async () => {
    screen = ReactTestRenderer.create(<DeleteDataScreen />)
  })
  let cleanup: void | (() => void)
  await act(async () => {
    cleanup = focus?.()
  })
  await settle()
  return { screen, blur: () => act(() => (cleanup ? cleanup() : undefined)) }
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  focus = null
  jest.mocked(settleDeletion).mockResolvedValue({ kind: 'none' })
  jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'preview', preview: PREVIEW, status: { kind: 'none' } })
  jest.mocked(lastLnAddress).mockResolvedValue(null)
})

describe('a request the gateway never recorded', () => {
  test('with nothing taken away before, the screen says nothing was deleted', async () => {
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'notArrived' })
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('deleteData.notArrived'))
    expect(textOf(screen)).toContain('Nothing was deleted')
    act(() => screen.unmount())
  })

  test('for a wallet that gave its address up first, it says only that the request did not arrive', async () => {
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'notArrived', removed: true })
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('deleteData.notArrivedRemoved'))
    expect(textOf(screen)).not.toContain('Nothing was deleted')
    act(() => screen.unmount())
  })
})

// The action that takes something away has the one look of a destructive button, never a gradient.
test('the delete button is the danger variant', async () => {
  const { screen } = await mountFocused()
  const button = screen.root.findByType(GradientButton)
  expect(button.props.variant).toBe('danger')
  expect(button.props.gradient).toBeUndefined()
})

// The gateway counts the other wallets on a domain, so most domains a wallet owns have none.
describe('a domain the wallet owns', () => {
  const preview = (guests: number) =>
    jest.mocked(previewOrAdopt).mockResolvedValue({
      kind: 'preview',
      preview: { ...PREVIEW, ownDomains: [{ host: 'pay.example.com', guests }] } as never,
      status: { kind: 'none' },
    })

  test('with no other wallet on it, the line names the domain and counts no wallets', async () => {
    preview(0)
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('deleteData.domainAlone', { domain: 'pay.example.com' }))
    expect(textOf(screen)).not.toMatch(/\b0 wallets\b/)
    act(() => screen.unmount())
  })

  test('with other wallets on it, the line says how many lose their address', async () => {
    preview(2)
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('deleteData.domain', { domain: 'pay.example.com', count: 2 }))
    expect(textOf(screen)).toContain('2 wallets lose their address')
    act(() => screen.unmount())
  })
})

test('a store refund with no support row under it ends with no line', async () => {
  const STORE = { kind: 'name' as const, subject: 'alice', reference: 'ref-store', paidWith: 'store' as const, at: 1_760_000_000 }
  jest.mocked(previewOrAdopt).mockResolvedValue({
    kind: 'preview',
    preview: { ...PREVIEW, purchases: [STORE] } as never,
    status: { kind: 'none' },
  })
  const { screen } = await mountFocused()
  const row = screen.root.findAllByType(MenuRow).find(n => n.props.label === i18n.t('deleteData.refundStore'))!
  expect(row.props.divider).toBe(false)
})

describe('a passkey wallet', () => {
  // The remove wallet screens' sentence speaks of removing the wallet, which this screen does not do.
  test.each([
    ['passkey.deleteIos', 'deleteData.passkeyIos'],
    ['passkey.deleteAndroid', 'deleteData.passkeyAndroid'],
  ] as const)('is told where the passkey stays (%s), in this screen\'s own words', async (note, line) => {
    jest.mocked(passkeyRemovalNote).mockResolvedValueOnce(note)
    const { screen } = await mountFocused()
    const shown = screen.root.findByProps({ testID: 'stays-passkey' }).props.children
    expect(shown).toBe(i18n.t(line))
    expect(shown).not.toBe(i18n.t(note))
    act(() => screen.unmount())
  })

  test('any other wallet reads no such line', async () => {
    const { screen } = await mountFocused()
    expect(screen.root.findAllByProps({ testID: 'stays-passkey' })).toHaveLength(0)
    act(() => screen.unmount())
  })
})

test('a press answered while the screen was away does not leave the button busy on the next focus', async () => {
  let answer!: (result: RequestResult) => void
  jest.mocked(requestDeletion).mockImplementation(() => new Promise(resolve => (answer = resolve)))
  const { screen, blur } = await mountFocused()
  const button = () => screen.root.findAllByType(GradientButton)[0]!
  await act(async () => button().props.onPress())
  await confirmQuestion(screen)
  expect(button().props.loading).toBe(true)

  blur()
  await act(async () => answer({ kind: 'failed' }))
  await settle()
  await act(async () => {
    focus?.()
  })
  await settle()
  expect(button().props.loading).toBe(false)
  act(() => screen.unmount())
})

describe('the address the screen says goes', () => {
  test("is the wallet's own address when the gateway lists it, not the first name in the list", async () => {
    jest.mocked(lastLnAddress).mockResolvedValue('Zed@usevoltz.app')
    const { screen } = await mountFocused()
    expect(screen.root.findByProps({ testID: 'deletion-goes' }).props.children).toBe(
      i18n.t('deleteData.whatGoes', { address: 'zed@usevoltz.app' }),
    )
    act(() => screen.unmount())
  })

  // Every card of the preview reads in the same tone, so what goes is not louder than what stays.
  test('is in the same muted tone as what stays', async () => {
    jest.mocked(lastLnAddress).mockResolvedValue('Zed@usevoltz.app')
    const { screen } = await mountFocused()
    expect(screen.root.findByProps({ testID: 'deletion-goes' }).props.tone).toBe('muted')
    act(() => screen.unmount())
  })

  test('is the first name listed when the wallet notes none, or one the gateway does not list', async () => {
    for (const noted of [null, 'bob@usevoltz.app']) {
      jest.mocked(lastLnAddress).mockResolvedValue(noted)
      const { screen } = await mountFocused()
      expect(screen.root.findByProps({ testID: 'deletion-goes' }).props.children).toBe(
        i18n.t('deleteData.whatGoes', { address: 'alice@usevoltz.app' }),
      )
      act(() => screen.unmount())
    }
  })

  test('is the first name listed when the noted address cannot be read', async () => {
    jest.mocked(lastLnAddress).mockRejectedValue(new Error('unreadable'))
    const { screen } = await mountFocused()
    expect(screen.root.findByProps({ testID: 'deletion-goes' }).props.children).toBe(
      i18n.t('deleteData.whatGoes', { address: 'alice@usevoltz.app' }),
    )
    act(() => screen.unmount())
  })
})

// Both refund rows mail support with the sats references, and a phone with no app for mailto
// rejects the link: the row then leaves the address, the references and Copy rather than nothing.
describe('the refund mail to support', () => {
  const SATS = { kind: 'name' as const, subject: 'alice', reference: 'ref-sats', paidWith: 'sats' as const, at: 1_760_000_000 }
  const OWED = {
    reference: 'ref-owed',
    kind: 'name' as const,
    domain: 'usevoltz.app',
    subject: 'bob',
    sats: 2000,
    state: 'refused' as const,
    at: 1_760_000_000,
  }

  async function pressRefund(screen: Renderer): Promise<void> {
    const row = screen.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === i18n.t('deleteData.refundSupport')))
    if (!row) {
      throw new Error('refund row not found')
    }
    await act(async () => {
      row.props.onPress()
    })
    await settle()
  }

  afterEach(() => jest.restoreAllMocks())

  test.each([
    ['a sats purchase', { ...PREVIEW, purchases: [SATS] }, 'ref-sats'],
    ['a charge owed', { ...PREVIEW, purchases: [SATS], owed: [OWED] }, 'ref-sats, ref-owed'],
  ])('beside %s, a mail that does not open leaves the address, the references and Copy', async (_, preview, body) => {
    jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'preview', preview, status: { kind: 'none' } })
    const open = jest.spyOn(Linking, 'openURL').mockClear().mockRejectedValue(new Error('no mail app'))
    const { screen } = await mountFocused()
    expectNoMailFallback(screen)
    await pressRefund(screen)
    expect(mailBody(open.mock.calls[0]?.[0])).toBe(body)
    expectMailFallback(screen, body)
    expect(await pressCopy(screen)).toBe(body)
  })

  // A mail app can open and still send nothing, as a Gmail signed in to no account does. With
  // charges owed the card sits inside their card, so that placement is held as well.
  test.each([
    ['a sats purchase', { ...PREVIEW, purchases: [SATS] }, 'ref-sats'],
    ['a charge owed', { ...PREVIEW, purchases: [SATS], owed: [OWED] }, 'ref-sats, ref-owed'],
  ])('beside %s, a mail that opens still leaves the address, the references and Copy', async (_, preview, body) => {
    jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'preview', preview, status: { kind: 'none' } })
    const open = jest.spyOn(Linking, 'openURL').mockClear().mockResolvedValue(true)
    const { screen } = await mountFocused()
    expectNoMailFallback(screen)
    await pressRefund(screen)
    expect(open).toHaveBeenCalledTimes(1)
    expect(mailBody(open.mock.calls[0]?.[0])).toBe(body)
    expectMailFallback(screen, body, 'opened')
    // Inside the charges' card it stands on the raised fill, and on the page it needs none.
    expect(Boolean(screen.root.findByType(SupportMailCard).props.raised)).toBe(preview.owed.length > 0)
    expect(await pressCopy(screen)).toBe(body)
  })

  // Every focus reads the preview again, so the card stays only beside the charges its mail named.
  test('a card about one set of charges goes when a later focus reads another', async () => {
    jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'preview', preview: { ...PREVIEW, purchases: [SATS] }, status: { kind: 'none' } })
    jest.spyOn(Linking, 'openURL').mockClear().mockResolvedValue(true)
    const { screen, blur } = await mountFocused()
    await pressRefund(screen)
    expectMailFallback(screen, 'ref-sats', 'opened')

    jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'preview', preview: { ...PREVIEW, purchases: [SATS], owed: [OWED] }, status: { kind: 'none' } })
    blur()
    await act(async () => {
      focus?.()
    })
    await settle()
    expect(textOf(screen)).toContain('ref-owed')
    expectNoMailFallback(screen)
  })
})
