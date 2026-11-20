import React from 'react'
import ReactTestRenderer, { act, type ReactTestRenderer as Renderer } from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { DeleteDataScreen } from '../src/screens/DeleteDataScreen'
import { GradientButton } from '../src/components/GradientButton'
import { Skeleton } from '../src/components/Skeleton'
import {
  activeDeletionView,
  liveDeletionDeps,
  previewOrAdopt,
  requestDeletion,
  settleDeletion,
  type DeletionPreview,
  type DeletionView,
  type RequestResult,
} from '../src/wallet/deletion'
import { WalletHasLiveExit } from '../src/wallet/exitPlan'
import { removeWalletById } from '../src/wallet/wallet'
import { loadRegistry } from '../src/wallet/walletRegistry'
import { confirmQuestion, question } from './support/question'

// The remove flow's deletion: the wallet named in `thenRemove` goes only once the gateway answered
// pending or done for it, with the screen focused, and only when the deletion signed as that wallet.
// The removal itself is the real shared one, over a mocked registry and removeWalletById.
jest.mock('../src/wallet/deletion', () => ({
  liveDeletionDeps: jest.fn(),
  settleDeletion: jest.fn(),
  previewOrAdopt: jest.fn(),
  requestDeletion: jest.fn(),
  activeDeletionView: jest.fn(async () => ({ kind: 'none' })),
}))
jest.mock('../src/wallet/lnAddressMemory', () => ({ lastLnAddress: jest.fn(async () => null) }))
jest.mock('../src/wallet/passkey', () => ({ passkeyRemovalNote: jest.fn(async () => null) }))
jest.mock('../src/wallet/wallet', () => ({ removeWalletById: jest.fn() }))
jest.mock('../src/wallet/walletRegistry', () => ({ loadRegistry: jest.fn() }))
const mockNavigate = jest.fn()
let mockParams: { thenRemove?: string } | undefined
let focus: (() => void | (() => void)) | null = null
jest.mock('@react-navigation/native', () => ({
  useNavigation: () => ({ navigate: mockNavigate, goBack: jest.fn() }),
  useRoute: () => ({ params: mockParams }),
  useFocusEffect: (cb: () => void | (() => void)) => {
    focus = cb
  },
}))

const PREVIEW: DeletionPreview = {
  names: [{ domain: 'usevoltz.app', name: 'alice' }],
  purchases: [],
  ownDomains: [],
  blockers: [],
  stays: ['mark'],
  owed: [],
}

const textOf = (screen: Renderer): string =>
  screen.root
    .findAllByType(Text)
    .map(n => [n.props.children].flat().join(''))
    .join('\n')

async function settle(): Promise<void> {
  for (let i = 0; i < 12; i++) {
    await act(async () => {
      await new Promise(resolve => setImmediate(resolve))
    })
  }
}

// Mounts, then focuses; the returned function blurs, as leaving the screen does.
async function mountFocused(): Promise<{ screen: Renderer; blur: () => void; refocus: () => Promise<void> }> {
  let screen!: Renderer
  await act(async () => {
    screen = ReactTestRenderer.create(<DeleteDataScreen />)
  })
  let cleanup: void | (() => void)
  await act(async () => {
    cleanup = focus?.()
  })
  await settle()
  return {
    screen,
    blur: () => act(() => (cleanup ? cleanup() : undefined)),
    refocus: async () => {
      await act(async () => {
        cleanup = focus?.()
      })
      await settle()
    },
  }
}

async function confirmDeletion(screen: Renderer): Promise<void> {
  const button = screen.root.findAllByType(GradientButton).find(b => b.props.label === i18n.t('deleteData.button'))!
  await act(async () => button.props.onPress())
  await confirmQuestion(screen)
  await settle()
}

const removed = () => jest.mocked(removeWalletById).mock.calls.map(call => call[0])

// Each line on screen whole, since some then-remove lines are the start of the line they replace.
const linesOf = (screen: Renderer): string[] =>
  screen.root.findAllByType(Text).map(n => [n.props.children].flat().join(''))

async function openConfirm(screen: Renderer): Promise<string | undefined> {
  const button = screen.root
    .findAllByType(GradientButton)
    .find(b => b.props.label === i18n.t('deleteData.button'))!
  await act(async () => button.props.onPress())
  return question(screen)?.body
}

beforeEach(async () => {
  await i18n.changeLanguage('en-US')
  focus = null
  mockParams = { thenRemove: 'w1' }
  mockNavigate.mockReset()
  jest.mocked(liveDeletionDeps).mockReset().mockResolvedValue({ walletId: 'w1', pubkey: '02ab', sign: async () => 'sig' })
  jest.mocked(settleDeletion).mockReset().mockResolvedValue({ kind: 'none' })
  jest.mocked(previewOrAdopt).mockReset().mockResolvedValue({ kind: 'preview', preview: PREVIEW, status: { kind: 'none' } })
  jest.mocked(requestDeletion).mockReset()
  jest.mocked(activeDeletionView).mockReset().mockResolvedValue({ kind: 'none' })
  jest.mocked(removeWalletById).mockReset().mockResolvedValue(undefined)
  jest.mocked(loadRegistry)
    .mockReset()
    .mockResolvedValue({
      active: 'w1',
      wallets: [
        { id: 'w1', fingerprint: 'fp-w1' },
        { id: 'w2', fingerprint: 'fp-w2' },
      ],
    })
})

describe('a focus read', () => {
  test.each<DeletionView>([
    { kind: 'pending', requestedAt: 1_760_000_000, deadline: 1_761_000_000 },
    { kind: 'done', doneAt: 1_760_000_000 },
  ])('that settles on $kind removes the named wallet and goes Home', async settled => {
    jest.mocked(settleDeletion).mockResolvedValue(settled)
    const { screen } = await mountFocused()
    expect(removed()).toEqual(['w1'])
    expect(removeWalletById).toHaveBeenCalledWith('w1', 'fp-w1')
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    act(() => screen.unmount())
  })

  test.each<DeletionView>([
    { kind: 'asked' },
    { kind: 'checking' },
    { kind: 'none' },
    { kind: 'removed' },
    { kind: 'notArrived' },
    { kind: 'notArrived', removed: true },
  ])('that settles on $kind removes nothing', async settled => {
    jest.mocked(settleDeletion).mockResolvedValue(settled)
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    expect(mockNavigate).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('on asked says the wallet stays until Voltz confirms the request', async () => {
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'asked' })
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('deleteData.staysUntilConfirmed'))
    act(() => screen.unmount())
  })

  test('on asked opened without the remove flow says nothing about the wallet staying', async () => {
    mockParams = undefined
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'asked' })
    const { screen } = await mountFocused()
    expect(textOf(screen)).not.toContain(i18n.t('deleteData.staysUntilConfirmed'))
    act(() => screen.unmount())
  })

  test('that adopts a request asked elsewhere, now pending, removes the named wallet', async () => {
    jest.mocked(previewOrAdopt).mockResolvedValue({ kind: 'adopted', view: { kind: 'pending' } })
    const { screen } = await mountFocused()
    expect(removed()).toEqual(['w1'])
    act(() => screen.unmount())
  })

  test('that failed removes nothing, even with a pending mark on the device', async () => {
    jest.mocked(liveDeletionDeps).mockRejectedValue(new Error('spark connected as another wallet'))
    jest.mocked(activeDeletionView).mockResolvedValue({ kind: 'pending' })
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('that lands after focus was lost removes nothing', async () => {
    let answer!: (view: DeletionView) => void
    jest.mocked(settleDeletion).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const { screen, blur } = await mountFocused()
    blur()
    await act(async () => answer({ kind: 'pending' }))
    await settle()
    expect(removeWalletById).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('signed for another wallet than the one named removes nothing', async () => {
    jest.mocked(liveDeletionDeps).mockResolvedValue({ walletId: 'w2', pubkey: '02cd', sign: async () => 'sig' })
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'pending' })
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('opened without the remove flow removes nothing on pending', async () => {
    mockParams = undefined
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'pending' })
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })
})

describe('a confirmed request', () => {
  test('answered with a 202 removes the named wallet and goes Home', async () => {
    jest.mocked(requestDeletion).mockResolvedValue({ kind: 'pending', requestedAt: 1, deadline: 2 })
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    await confirmDeletion(screen)
    expect(removed()).toEqual(['w1'])
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    act(() => screen.unmount())
  })

  test.each<RequestResult>([{ kind: 'noAnswer' }, { kind: 'blocked', blockers: ['sats_charge_open'] }, { kind: 'failed' }])(
    'answered $kind removes nothing',
    async result => {
      jest.mocked(requestDeletion).mockResolvedValue(result)
      const { screen } = await mountFocused()
      await confirmDeletion(screen)
      expect(removeWalletById).not.toHaveBeenCalled()
      expect(mockNavigate).not.toHaveBeenCalled()
      act(() => screen.unmount())
    },
  )

  test('with no answer says the wallet stays until Voltz confirms the request', async () => {
    jest.mocked(requestDeletion).mockResolvedValue({ kind: 'noAnswer' })
    const { screen } = await mountFocused()
    await confirmDeletion(screen)
    expect(textOf(screen)).toContain(i18n.t('deleteData.staysUntilConfirmed'))
    act(() => screen.unmount())
  })

  test('answered with a 202 after focus was lost removes nothing', async () => {
    let answer!: (result: RequestResult) => void
    jest.mocked(requestDeletion).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    const { screen, blur } = await mountFocused()
    await confirmDeletion(screen)
    blur()
    await act(async () => answer({ kind: 'pending', requestedAt: 1, deadline: 2 }))
    await settle()
    expect(removeWalletById).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })
})

describe('the removal', () => {
  beforeEach(() => {
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'pending' })
  })

  test('refused for a live exit says so and stays', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new WalletHasLiveExit('w1'))
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('emergencyExit.removeRefused'))
    expect(screen.root.findAllByType(Skeleton)).toHaveLength(0)
    expect(mockNavigate).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('that fails with the wallet still listed says so and stays', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    const { screen } = await mountFocused()
    expect(textOf(screen)).toContain(i18n.t('editWallet.removeFailed'))
    expect(mockNavigate).not.toHaveBeenCalled()
    act(() => screen.unmount())
  })

  test('that fails after the wallet left the registry goes Home', async () => {
    jest.mocked(removeWalletById).mockImplementationOnce(async () => {
      jest.mocked(loadRegistry).mockResolvedValue({ active: 'w2', wallets: [{ id: 'w2', fingerprint: 'fp-w2' }] })
      throw new Error('keychain')
    })
    const { screen } = await mountFocused()
    expect(removed()).toEqual(['w1'])
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    expect(textOf(screen)).not.toContain(i18n.t('editWallet.removeFailed'))
    act(() => screen.unmount())
  })

  test('with the registry unreadable removes nothing and says so', async () => {
    jest.mocked(loadRegistry).mockRejectedValue(new Error('storage'))
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    expect(textOf(screen)).toContain(i18n.t('editWallet.removeFailed'))
    act(() => screen.unmount())
  })

  // Its photos are swept by the registry's fingerprint, so an empty one would sweep every wallet's.
  test('of a wallet the registry no longer lists sweeps nothing and goes Home', async () => {
    jest.mocked(loadRegistry).mockResolvedValue({ active: 'w2', wallets: [{ id: 'w2', fingerprint: 'fp-w2' }] })
    const { screen } = await mountFocused()
    expect(removeWalletById).not.toHaveBeenCalled()
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    act(() => screen.unmount())
  })

  test('in flight shows the screen busy and starts no second one on another focus', async () => {
    let land!: () => void
    jest.mocked(removeWalletById).mockImplementationOnce(() => new Promise<void>(resolve => (land = resolve)))
    const { screen, blur, refocus } = await mountFocused()
    expect(screen.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
    blur()
    await refocus()
    expect(removeWalletById).toHaveBeenCalledTimes(1)
    await act(async () => land())
    await settle()
    expect(mockNavigate).toHaveBeenCalledWith('Main')
    act(() => screen.unmount())
  })
})

// From the remove flow the wallet leaves this device once Voltz holds the request, so no line there
// says it stays, or that this screen tells when the deletion is done. Opened for the only wallet,
// the lines are the ones it always had.
describe('the lines about what stays', () => {
  test('in the preview, from the remove flow, say the wallet leaves this device', async () => {
    const { screen } = await mountFocused()
    const lines = linesOf(screen)
    expect(lines).toContain(i18n.t('deleteData.walletThenRemove'))
    expect(lines).not.toContain(i18n.t('deleteData.wallet'))
    expect(lines).toContain(i18n.t('deleteData.deadlineThenRemove'))
    expect(lines).not.toContain(i18n.t('deleteData.deadline'))
    act(() => screen.unmount())
  })

  test('in the preview, for the only wallet, say it stays', async () => {
    mockParams = undefined
    const { screen } = await mountFocused()
    const lines = linesOf(screen)
    expect(lines).toContain(i18n.t('deleteData.wallet'))
    expect(lines).not.toContain(i18n.t('deleteData.walletThenRemove'))
    expect(lines).toContain(i18n.t('deleteData.deadline'))
    expect(lines).not.toContain(i18n.t('deleteData.deadlineThenRemove'))
    act(() => screen.unmount())
  })

  test('in the confirm, from the remove flow, say the wallet leaves this device', async () => {
    const { screen } = await mountFocused()
    expect(await openConfirm(screen)).toBe(i18n.t('deleteData.confirmBodyThenRemove'))
    act(() => screen.unmount())
  })

  test('in the confirm, for the only wallet, say it stays', async () => {
    mockParams = undefined
    const { screen } = await mountFocused()
    expect(await openConfirm(screen)).toBe(i18n.t('deleteData.confirmBody'))
    act(() => screen.unmount())
  })

  test('of a request asked from the remove flow drop the promise to tell here', async () => {
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'asked' })
    const { screen } = await mountFocused()
    const lines = linesOf(screen)
    expect(lines).toContain(i18n.t('deleteData.inProgressThenRemove'))
    expect(lines).not.toContain(i18n.t('deleteData.inProgress'))
    expect(lines).toContain(i18n.t('deleteData.deadlineThenRemove'))
    expect(lines).not.toContain(i18n.t('deleteData.deadline'))
    act(() => screen.unmount())
  })

  test('of a request asked for the only wallet are the ones it always had', async () => {
    mockParams = undefined
    jest.mocked(settleDeletion).mockResolvedValue({ kind: 'asked' })
    const { screen } = await mountFocused()
    const lines = linesOf(screen)
    expect(lines).toContain(i18n.t('deleteData.inProgress'))
    expect(lines).toContain(i18n.t('deleteData.deadline'))
    expect(lines).toContain(i18n.t('deleteData.wallet'))
    act(() => screen.unmount())
  })
})
