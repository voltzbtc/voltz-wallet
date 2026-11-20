import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { WalletRowsSkeleton } from '../src/components/WalletRowsSkeleton'
import { space } from '../src/theme'
import { WalletsScreen } from '../src/screens/WalletsScreen'
import { markUnconfirmed } from '../src/wallet/backupMark'
import { passkeyRemovalNote } from '../src/wallet/passkey'
import { loadRegistry, reorderWallets } from '../src/wallet/walletRegistry'
import {
  WalletSeedAbsent,
  removeWalletById,
  switchWalletWithoutReconnecting,
} from '../src/wallet/wallet'

// Removing the active wallet tears the engine down and repoints the registry, so without returning
// Home nothing refocuses to reconnect and the drawer keeps the deleted identity.

const mockNavigate = jest.fn()
const mockSetOptions = jest.fn()
const mockAsked = jest.fn()

// Answers yes to the confirmation, whose own behaviour confirmSheet.test.tsx holds.
jest.mock('../src/components/ConfirmSheet', () => {
  const react = require('react')
  return {
    ConfirmSheet: ({
      request,
      onClose,
    }: {
      request: { danger?: boolean; onConfirm: () => void } | null
      onClose: () => void
    }) => {
      react.useEffect(() => {
        if (request) {
          mockAsked(request)
          onClose()
          request.onConfirm()
        }
      }, [request, onClose])
      return null
    },
  }
})

jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: mockNavigate, setOptions: mockSetOptions }),
    useFocusEffect: (cb: () => void) => {
      react.useEffect(cb, [])
    },
  }
})

// Capturing the props avoids rendering the real drag-and-drop list to reach onRemove.
let listProps: {
  rows: Array<{ id: string; fingerprint: string; active: boolean }>
  editing: boolean
  onRemove: (row: unknown) => void
  onPressRow: (row: unknown) => void
  onReorder: (ids: string[]) => void
} | null = null
jest.mock('../src/wallet/passkey', () => ({
  ...jest.requireActual('../src/wallet/passkey'),
  passkeyRemovalNote: jest.fn(async () => null),
}))
jest.mock('../src/components/WalletList', () => ({
  WalletList: (props: typeof listProps) => {
    listProps = props
    return null
  },
}))

jest.mock('../src/wallet/walletRegistry', () => ({
  loadRegistry: jest.fn(),
  reorderWallets: jest.fn(),
}))
jest.mock('../src/wallet/walletMeta', () => ({ loadWalletMeta: jest.fn(async () => null) }))
jest.mock('../src/wallet/wallet', () => {
  const actual = jest.requireActual('../src/wallet/wallet')
  return {
    WalletSeedAbsent: actual.WalletSeedAbsent,
    isWalletSeedAbsent: actual.isWalletSeedAbsent,
    removeWalletById: jest.fn(async () => undefined),
    switchWalletWithoutReconnecting: jest.fn(async () => undefined),
  }
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

let current: ReactTestRenderer.ReactTestRenderer | null = null

async function render(): Promise<void> {
  await ReactTestRenderer.act(async () => {
    current = ReactTestRenderer.create(<WalletsScreen />)
  })
  await settle()
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  listProps = null
  mockNavigate.mockClear()
  mockAsked.mockClear()
  jest.mocked(removeWalletById).mockReset()
  jest.mocked(removeWalletById).mockResolvedValue(undefined)
  jest.mocked(switchWalletWithoutReconnecting).mockReset()
  jest.mocked(switchWalletWithoutReconnecting).mockResolvedValue(undefined)
  jest.mocked(loadRegistry).mockReset()
  jest.mocked(loadRegistry).mockResolvedValue({
    active: 'w1',
    wallets: [
      { id: 'w1', fingerprint: 'aaaa1111' },
      { id: 'w2', fingerprint: 'bbbb2222' },
    ],
  } as Awaited<ReturnType<typeof loadRegistry>>)
})

afterEach(async () => {
  if (current) {
    await ReactTestRenderer.act(async () => {
      current!.unmount()
    })
    current = null
  }
  jest.restoreAllMocks()
})

// Picking a row is the one place the non-reconnecting switch is the right call: the navigation
// that follows is what reconnects, through Home's focus. A switch that stayed on this screen would
// leave the SDK on the wallet just left behind.
test('switching repoints the registry and returns Home, which is what connects the new wallet', async () => {
  await render()
  const other = listProps!.rows.find(r => !r.active)!
  await ReactTestRenderer.act(async () => {
    listProps!.onPressRow(other)
  })
  await settle()

  expect(switchWalletWithoutReconnecting).toHaveBeenCalledWith('w2')
  expect(mockNavigate).toHaveBeenCalledWith('Main')
})

test('pressing the ACTIVE row edits it instead of switching to what is already active', async () => {
  await render()
  const active = listProps!.rows.find(r => r.active)!
  await ReactTestRenderer.act(async () => {
    listProps!.onPressRow(active)
  })
  await settle()

  expect(switchWalletWithoutReconnecting).not.toHaveBeenCalled()
  expect(mockNavigate).toHaveBeenCalledWith('EditWallet')
})

test('removing the ACTIVE wallet returns Home so the engine reconnects the fallback', async () => {
  await render()
  const active = listProps!.rows.find(r => r.active)!
  await ReactTestRenderer.act(async () => {
    listProps!.onRemove(active)
  })
  await settle()

  expect(removeWalletById).toHaveBeenCalledWith('w1', 'aaaa1111')
  expect(mockNavigate).toHaveBeenCalledWith('Main')
})

test('removing a NON-active wallet stays put, refreshing the list without navigating', async () => {
  await render()
  const other = listProps!.rows.find(r => !r.active)!
  await ReactTestRenderer.act(async () => {
    listProps!.onRemove(other)
  })
  await settle()

  expect(removeWalletById).toHaveBeenCalledWith('w2', 'bbbb2222')
  expect(mockNavigate).not.toHaveBeenCalled()
})

// A failed call never leaves the skeleton up, and the list it returns to is the registry read again,
// since a removal stopped halfway may have taken the wallet or not.
describe('when the call fails', () => {
  const texts = (): string[] =>
    current!.root.findAllByType(Text).map(node => String(node.props.children))
  const skeletons = () => current!.root.findAllByType(WalletRowsSkeleton)
  const registry = (ids: string[]) =>
    ({
      active: 'w1',
      wallets: ids.map(id => ({ id, fingerprint: id === 'w1' ? 'aaaa1111' : 'bbbb2222' })),
    }) as Awaited<ReturnType<typeof loadRegistry>>

  test('a failed removal shows the registry as read again, still holding the wallet', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(other)
    })
    await settle()

    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('wallets.removeFailed'))
    expect(loadRegistry).toHaveBeenCalledTimes(2)
    expect(listProps!.rows.map(r => r.id)).toEqual(['w1', 'w2'])
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('a removal that failed after taking the wallet shows it gone', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    jest.mocked(loadRegistry).mockResolvedValue(registry(['w1']))
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(other)
    })
    await settle()

    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('wallets.removeFailed'))
    expect(listProps!.rows.map(r => r.id)).toEqual(['w1'])
  })

  test('a failed removal whose re-read fails too keeps the rows last read', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    jest.mocked(loadRegistry).mockRejectedValue(new Error('storage'))
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(other)
    })
    await settle()

    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('wallets.removeFailed'))
    expect(listProps!.rows.map(r => r.id)).toEqual(['w1', 'w2'])
  })

  // The engine is disconnected before the pointer moves, so staying here would leave no connection
  // until something else brought Home back.
  test('a removal of the ACTIVE wallet that failed halfway returns Home, which reconnects', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new Error('keychain'))
    await render()
    const active = listProps!.rows.find(r => r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(active)
    })
    await settle()

    expect(mockNavigate).toHaveBeenCalledWith('Main')
  })

  test('the refusal to remove the only wallet that opens touches nothing and stays here', async () => {
    jest.mocked(removeWalletById).mockRejectedValueOnce(new WalletSeedAbsent('w2'))
    await render()
    const active = listProps!.rows.find(r => r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(active)
    })
    await settle()

    expect(mockNavigate).not.toHaveBeenCalled()
    expect(texts()).toContain(i18n.t('wallets.removeFailed'))
  })

  test('a failed switch stays here with the error and the rows read again', async () => {
    jest.mocked(switchWalletWithoutReconnecting).mockRejectedValueOnce(new Error('storage'))
    await render()
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onPressRow(other)
    })
    await settle()

    expect(skeletons()).toHaveLength(0)
    expect(texts()).toContain(i18n.t('wallets.switchFailed'))
    expect(loadRegistry).toHaveBeenCalledTimes(2)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  // A registry restored onto a new iPhone lists wallets whose seeds stayed on the old one. Trying again
  // never helps there, so the words say why and what can be done instead.
  test('a wallet whose recovery phrase is not on this device is refused with words that say so', async () => {
    jest.mocked(switchWalletWithoutReconnecting).mockRejectedValueOnce(new WalletSeedAbsent('w2'))
    await render()
    const other = listProps!.rows.find(r => !r.active)!

    await ReactTestRenderer.act(async () => {
      listProps!.onPressRow(other)
    })
    await settle()

    expect(texts()).toContain(i18n.t('wallets.seedAbsent'))
    expect(texts()).not.toContain(i18n.t('wallets.switchFailed'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  test('the error goes once the next action starts', async () => {
    jest.mocked(switchWalletWithoutReconnecting).mockRejectedValueOnce(new Error('storage'))
    await render()
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onPressRow(other)
    })
    await settle()
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(other)
    })
    await settle()

    expect(texts()).not.toContain(i18n.t('wallets.switchFailed'))
  })
})

// A move is drawn at once and written after, and the list never keeps an order the registry was not
// left holding. Every move writes the whole order, so a later one that saves covers an earlier one
// that failed.
describe('reordering', () => {
  // The registry file as the doubles leave it: a read answers what the last write that saved wrote.
  let held: string[]
  const registryOf = (ids: string[]) =>
    ({ active: 'w1', wallets: ids.map(id => ({ id, fingerprint: `${id}fp` })) }) as Awaited<
      ReturnType<typeof loadRegistry>
    >
  const shown = () => listProps!.rows.map(r => r.id)
  const saves = async (ids: string[]) => {
    held = ids
  }
  async function move(ids: string[]): Promise<void> {
    await ReactTestRenderer.act(async () => {
      listProps!.onReorder(ids)
    })
  }
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (err: Error) => void
    const promise = new Promise<T>((yes, no) => {
      resolve = yes
      reject = no
    })
    return { promise, resolve, reject }
  }

  beforeEach(() => {
    held = ['w1', 'w2', 'w3']
    jest.mocked(loadRegistry).mockImplementation(async () => registryOf(held))
    jest.mocked(reorderWallets).mockReset()
    jest.mocked(reorderWallets).mockImplementation(saves)
  })

  test('a move that saves shows the new order without reading the registry again', async () => {
    await render()
    await move(['w2', 'w1', 'w3'])
    await settle()

    expect(held).toEqual(['w2', 'w1', 'w3'])
    expect(shown()).toEqual(['w2', 'w1', 'w3'])
    expect(loadRegistry).toHaveBeenCalledTimes(1)
  })

  test('a move whose write fails shows the order the registry holds, read back', async () => {
    jest.mocked(reorderWallets).mockRejectedValueOnce(new Error('disk full'))
    await render()
    await move(['w2', 'w1', 'w3'])
    await settle()

    expect(loadRegistry).toHaveBeenCalledTimes(2)
    expect(shown()).toEqual(['w1', 'w2', 'w3'])
  })

  test('an earlier move that failed does not undo a later one that saved', async () => {
    const first = deferred<void>()
    const second = deferred<void>()
    jest
      .mocked(reorderWallets)
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(ids => second.promise.then(() => saves(ids)))
    await render()
    await move(['w2', 'w1', 'w3'])
    await move(['w2', 'w3', 'w1'])

    // The writes run in the order asked, so the first fails while the second is still out.
    await ReactTestRenderer.act(async () => first.reject(new Error('disk full')))
    await settle()
    await ReactTestRenderer.act(async () => second.resolve())
    await settle()

    expect(held).toEqual(['w2', 'w3', 'w1'])
    expect(shown()).toEqual(held)
  })

  test('a read back that answers after a newer move leaves the newer order', async () => {
    const readBack = deferred<Awaited<ReturnType<typeof loadRegistry>>>()
    jest.mocked(reorderWallets).mockRejectedValueOnce(new Error('disk full'))
    await render()
    jest.mocked(loadRegistry).mockImplementationOnce(() => readBack.promise)
    await move(['w2', 'w1', 'w3'])
    await settle()
    await move(['w3', 'w1', 'w2'])
    await settle()

    // The read began before the newer move was written, so it answers the order from before it.
    await ReactTestRenderer.act(async () => readBack.resolve(registryOf(['w1', 'w2', 'w3'])))
    await settle()

    expect(held).toEqual(['w3', 'w1', 'w2'])
    expect(shown()).toEqual(held)
  })
})

// The rows come only from a read that answered: the skeleton until the first one does, and the error
// with Try again when it fails, never a list that reads as a device with no wallets.
// Nothing on screen says that holding a card opens edit mode, so an Edit link sits in the header,
// for a list with something to reorder or remove.
describe('the Edit link', () => {
  const STILL = { pressed: false }

  const links = async (label: string) => {
    const header = mockSetOptions.mock.calls.at(-1)?.[0].headerRight?.()
    if (!header) {
      return []
    }
    let drawn!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      drawn = ReactTestRenderer.create(header)
    })
    return drawn.root
      .findAll(n => typeof n.props.onPress === 'function')
      .filter(n => n.findAllByType(Text).some(t => t.props.children === label))
  }

  test('has room inside the glass and says its name to a screen reader', async () => {
    await render()
    const edit = (await links('Edit')).find(n => n.props.accessibilityRole === 'button')
    expect(edit?.props.accessibilityLabel).toBe('Edit')
    expect(StyleSheet.flatten(edit?.props.style(STILL)).paddingHorizontal).toBe(space.md)
  })

  test('opens edit mode and turns into Done, which closes it', async () => {
    await render()
    expect(listProps!.editing).toBe(false)
    expect(await links(i18n.t('home.done'))).toHaveLength(0)

    const edit = (await links(i18n.t('wallets.edit')))[0]!
    await ReactTestRenderer.act(async () => {
      edit.props.onPress()
    })
    expect(listProps!.editing).toBe(true)
    expect(await links(i18n.t('wallets.edit'))).toHaveLength(0)

    const done = (await links(i18n.t('home.done')))[0]!
    await ReactTestRenderer.act(async () => {
      done.props.onPress()
    })
    expect(listProps!.editing).toBe(false)
    expect((await links(i18n.t('wallets.edit'))).length).toBeGreaterThan(0)
  })

  test('is not shown for a single wallet, which has nothing to reorder or remove', async () => {
    jest.mocked(loadRegistry).mockResolvedValue({
      active: 'w1',
      wallets: [{ id: 'w1', fingerprint: 'aaaa1111' }],
    } as Awaited<ReturnType<typeof loadRegistry>>)
    await render()
    expect(listProps!.rows).toHaveLength(1)
    expect(await links(i18n.t('wallets.edit'))).toHaveLength(0)
  })
})

describe('the first read', () => {
  const texts = (): string[] =>
    current!.root.findAllByType(Text).map(node => String(node.props.children))
  const skeletons = () => current!.root.findAllByType(WalletRowsSkeleton)

  test('holds the skeleton until the registry answers, then draws the rows', async () => {
    let answer!: (value: Awaited<ReturnType<typeof loadRegistry>>) => void
    jest.mocked(loadRegistry).mockImplementationOnce(() => new Promise(resolve => (answer = resolve)))
    await render()

    expect(skeletons()).toHaveLength(1)
    expect(listProps).toBeNull()
    expect(texts()).not.toContain(i18n.t('wallets.add'))

    await ReactTestRenderer.act(async () => {
      answer({ active: 'w1', wallets: [{ id: 'w1', fingerprint: 'aaaa1111' }] } as Awaited<
        ReturnType<typeof loadRegistry>
      >)
    })
    await settle()

    expect(skeletons()).toHaveLength(0)
    expect(listProps!.rows.map(r => r.id)).toEqual(['w1'])
  })

  test('a read that fails shows the error and Try again, and Try again draws the rows', async () => {
    jest.mocked(loadRegistry).mockRejectedValueOnce(new Error('storage'))
    await render()

    expect(skeletons()).toHaveLength(0)
    expect(listProps).toBeNull()
    expect(texts()).toContain(i18n.t('wallets.loadFailed'))
    expect(texts()).not.toContain(i18n.t('wallets.add'))

    const retry = current!.root.find(
      n => typeof n.props.onPress === 'function' && n.props.label === i18n.t('common.retry'),
    )
    await ReactTestRenderer.act(async () => {
      retry.props.onPress()
    })
    await settle()

    expect(loadRegistry).toHaveBeenCalledTimes(2)
    expect(texts()).not.toContain(i18n.t('wallets.loadFailed'))
    expect(listProps!.rows.map(r => r.id)).toEqual(['w1', 'w2'])
  })
})

// Adding below a list reads the same on Home and here: the plus mark beside the label, laid across, at
// the left edge rather than at the card's inset.
describe('the Add wallet row', () => {
  // The pressable itself, which carries the drawn style, rather than the component that wraps it.
  const addRow = () =>
    current!.root
      .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === i18n.t('wallets.add')))!
  const flat = (raw: unknown): Record<string, unknown> =>
    Object.assign(
      {},
      ...[typeof raw === 'function' ? raw({ pressed: false }) : raw]
        .flat(Infinity)
        .filter(x => x && typeof x === 'object'),
    )

  test('draws the plus mark beside its label, laid across at the left edge', async () => {
    await render()
    const row = addRow()

    expect(row.findAll(n => n.props.name === 'plus').length).toBeGreaterThan(0)
    const style = flat(row.props.style)
    expect(style.flexDirection).toBe('row')
    expect(style.alignItems).toBe('center')
    expect(style.paddingHorizontal).toBe(space.xs)
    expect(style.marginTop).toBe(space.xs)
  })

  test('carries no literal plus in any language, since the mark draws it', () => {
    const resources = i18n.options.resources as Record<string, { translation: { wallets: { add: string } } }>
    const languages = Object.keys(resources)
    expect(languages.length).toBeGreaterThanOrEqual(24)
    for (const lng of languages) {
      expect(resources[lng].translation.wallets.add.trim().startsWith('+')).toBe(false)
    }
  })
})

// Removing the only copy of words nobody confirmed is the one removal that can take the funds with it.
describe('the warning before a removal', () => {
  async function warningFor(marked: boolean): Promise<string> {
    if (marked) {
      await markUnconfirmed('w2')
    }
    await render()
    const other = listProps!.rows.find(r => !r.active)!
    await ReactTestRenderer.act(async () => {
      listProps!.onRemove(other)
    })
    await settle()
    return String(mockAsked.mock.calls[0]?.[0].body)
  }

  test('says the words were not confirmed for a wallet with the mark', async () => {
    expect(await warningFor(true)).toBe(i18n.t('backup.removeUnconfirmed'))
  })

  test('stays the usual one for a wallet without it', async () => {
    expect(await warningFor(false)).toBe(i18n.t('editWallet.removeWarning'))
  })

  test('adds where the passkey is deleted, for a wallet that has one', async () => {
    jest.mocked(passkeyRemovalNote).mockResolvedValueOnce('passkey.deleteAndroid')
    const warning = await warningFor(false)
    expect(warning).toContain(i18n.t('editWallet.removeWarning'))
    expect(warning).toContain(i18n.t('passkey.deleteAndroid'))
  })
})
