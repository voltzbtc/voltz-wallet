import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { FlatList, StyleSheet, Text, TextInput } from 'react-native'
import i18n from '../src/i18n'
import { ContactsScreen } from '../src/screens/ContactsScreen'
import {
  sparkClassify,
  sparkListContacts,
  sparkAddContact,
  sparkDeleteContact,
  sparkSubscribeToPayments,
  sparkSyncState,
  sparkUpdateContact,
  type BalanceSync,
  type SparkContact,
  type SparkDestinationKind,
} from '../src/wallet/spark'
import { AddRow } from '../src/components/AddRow'
import { EmptyState } from '../src/components/EmptyState'
import { GradientButton } from '../src/components/GradientButton'
import { Sheet } from '../src/components/Sheet'
import { answerQuestion, question } from './support/question'
import { Card } from '../src/components/Card'
import { Skeleton } from '../src/components/Skeleton'
import { colors, font, radius } from '../src/theme'

const mockNavigate = jest.fn()
const mockPopTo = jest.fn()
let mockRouteParams: { pick?: boolean } = {}

const mockConnected = new Set<() => void>()
const mockSynced = new Set<() => void>()
jest.mock('../src/wallet/spark', () => ({
  sparkClassify: jest.fn(),
  sparkListContacts: jest.fn(),
  sparkAddContact: jest.fn(),
  sparkUpdateContact: jest.fn(),
  sparkDeleteContact: jest.fn(),
  sparkSubscribeToPayments: jest.fn(),
  sparkSyncState: jest.fn(),
  sparkSyncWaitLeftMs: () => 0,
  onSparkConnected: (cb: () => void) => {
    mockConnected.add(cb)
    cb()
    return () => mockConnected.delete(cb)
  },
  onSparkSynced: (cb: () => void) => {
    mockSynced.add(cb)
    return () => mockSynced.delete(cb)
  },
}))
jest.mock('@react-navigation/native', () => {
  const react = require('react')
  return {
    useNavigation: () => ({ navigate: mockNavigate, popTo: mockPopTo }),
    useRoute: () => ({ params: mockRouteParams }),
    useFocusEffect: (cb: () => void) => react.useEffect(cb, []),
  }
})

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

async function render(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<ContactsScreen />)
  })
  await settle()
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

async function pressBtn(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  const btn = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === label))
  if (!btn) {
    throw new Error(`button not found: ${label}`)
  }
  await ReactTestRenderer.act(async () => {
    btn.props.onPress()
  })
  await settle()
}

// Presses one button of the question on screen, by its label, as the person answering it would.
async function reply(tree: ReactTestRenderer.ReactTestRenderer, label: string): Promise<void> {
  await answerQuestion(tree, label)
  await settle()
}

async function type(
  tree: ReactTestRenderer.ReactTestRenderer,
  index: number,
  value: string,
): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[index].props.onChangeText(value)
  })
}

async function focusAddress(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[1].props.onFocus({})
  })
}

async function leaveAddress(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
  await ReactTestRenderer.act(async () => {
    tree.root.findAllByType(TextInput)[1].props.onBlur({})
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  mockRouteParams = {}
  // Reset rather than cleared, since a queued once-answer a test left unread would reach the next test.
  for (const fn of [
    sparkListContacts,
    sparkAddContact,
    sparkUpdateContact,
    sparkDeleteContact,
    sparkClassify,
    sparkSubscribeToPayments,
  ]) {
    jest.mocked(fn).mockReset()
  }
  mockConnected.clear()
  mockSynced.clear()
  jest.mocked(sparkClassify).mockResolvedValue('lightningAddress')
  jest.mocked(sparkSubscribeToPayments).mockResolvedValue(() => undefined)
  jest.mocked(sparkSyncState).mockReturnValue('synced')
  jest
    .mocked(sparkListContacts)
    .mockResolvedValue([{ id: 'c1', name: 'Alice', address: 'alice@breez.tips' }])
  jest.mocked(sparkAddContact).mockResolvedValue({ id: 'c2', name: 'Bob', address: 'bob@x.com' })
})

test('lists the saved contacts with name and address', async () => {
  const tree = await render()
  const shown = texts(tree).join(' ')
  expect(shown).toContain('Alice')
  expect(shown).toContain('alice@breez.tips')
})

test('adds a contact with a name and a lightning address', async () => {
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await type(tree, 0, 'Bob')
  await type(tree, 1, 'bob@x.com')

  await pressBtn(tree, 'Save')

  expect(sparkAddContact).toHaveBeenCalledWith('Bob', 'bob@x.com')
})

test('keeps Save disabled for a malformed lightning address', async () => {
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await type(tree, 0, 'Bob')
  await type(tree, 1, 'not-an-address') // no valid user@domain

  const saveBtn = tree.root.find(n => n.props.label === 'Save' && 'disabled' in n.props)
  expect(saveBtn.props.disabled).toBe(true)
  expect(sparkAddContact).not.toHaveBeenCalled()
})

test('keeps Save disabled when the domain is junk (valid user, bad domain)', async () => {
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await type(tree, 0, 'Bob')
  await type(tree, 1, 'bob@!!!') // username is fine, domain is not a hostname

  const saveBtn = tree.root.find(n => n.props.label === 'Save' && 'disabled' in n.props)
  expect(saveBtn.props.disabled).toBe(true)
  expect(sparkAddContact).not.toHaveBeenCalled()
})

describe('removing a contact', () => {
  async function openAliceRow(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    const row = tree.root
      .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(txt => txt.props.children === 'Alice'))
    await ReactTestRenderer.act(async () => {
      row?.props.onPress()
    })
    await settle()
  }

  test('asks first, naming the contact, and deletes nothing on the tap alone', async () => {
    const tree = await render()
    await openAliceRow(tree)

    await pressBtn(tree, 'Remove contact')

    expect(question(tree)).toMatchObject({
      title: 'Remove Alice from your contacts?',
      cancel: i18n.t('common.cancel'),
      confirm: i18n.t('contacts.removeConfirm'),
      danger: true,
    })
    expect(tree.root.findAllByType(Sheet)).toHaveLength(1)
    expect(sparkDeleteContact).not.toHaveBeenCalled()
  })

  test('Cancel deletes nothing and leaves the sheet open', async () => {
    const tree = await render()
    await openAliceRow(tree)
    await pressBtn(tree, 'Remove contact')

    await reply(tree, i18n.t('common.cancel'))

    expect(sparkDeleteContact).not.toHaveBeenCalled()
    expect(tree.root.findByType(Sheet).props.visible).toBe(true)
    expect(question(tree)).toBeNull()
  })

  test('the backdrop ends the question and leaves the sheet open', async () => {
    const tree = await render()
    await openAliceRow(tree)
    await pressBtn(tree, 'Remove contact')

    await ReactTestRenderer.act(async () => tree.root.findByType(Sheet).props.onClose())

    expect(question(tree)).toBeNull()
    expect(sparkDeleteContact).not.toHaveBeenCalled()
    expect(tree.root.findByType(Sheet).props.visible).toBe(true)
  })

  test('the destructive answer deletes it once and reads the list again', async () => {
    const tree = await render()
    await openAliceRow(tree)
    await pressBtn(tree, 'Remove contact')
    const reads = jest.mocked(sparkListContacts).mock.calls.length

    await reply(tree, i18n.t('contacts.removeConfirm'))

    expect(sparkDeleteContact).toHaveBeenCalledTimes(1)
    expect(sparkDeleteContact).toHaveBeenCalledWith('c1')
    expect(jest.mocked(sparkListContacts).mock.calls.length).toBe(reads + 1)
    expect(tree.root.findByType(Sheet).props.visible).toBe(false)
  })
})

test('in picking mode, tapping a contact fills the send destination', async () => {
  mockRouteParams = { pick: true }
  const tree = await render()

  const row = tree.root
    .findAll(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === 'Alice'))
  await ReactTestRenderer.act(async () => {
    row?.props.onPress()
  })

  expect(mockPopTo).toHaveBeenCalledWith('Send', {
    destination: 'alice@breez.tips',
    contactName: 'Alice',
    picked: expect.any(Number),
  })
  expect(mockNavigate).not.toHaveBeenCalled()
})

test('says the list is empty once it has loaded, rather than showing nothing', async () => {
  // The empty list is the first thing a new wallet sees on this screen, so the empty state has to
  // be there rather than a blank.
  jest.mocked(sparkListContacts).mockResolvedValue([])
  expect(texts(await render()).join(' ')).toContain(i18n.t('contacts.empty'))
})

test('says nothing about being empty while it is still loading', async () => {
  // The skeleton is the loading state and the message is the loaded one. Drawn during the load, the
  // message reads as a fact about the wallet rather than about the request.
  let resolve!: (rows: never[]) => void
  jest.mocked(sparkListContacts).mockReturnValue(new Promise(r => (resolve = r)) as never)
  const tree = await render()
  expect(texts(tree).join(' ')).not.toContain(i18n.t('contacts.empty'))
  await ReactTestRenderer.act(async () => resolve([]))
  await settle()
  expect(texts(tree).join(' ')).toContain(i18n.t('contacts.empty'))
})

// A read that failed is not an empty list (docs/design-system.md, Loading). "No contacts yet" drawn
// after a failed read states something false about the wallet.
describe('when the list read fails', () => {
  const loadFailed = () => i18n.t('contacts.loadFailed')
  const retry = () => i18n.t('common.retry')

  test('says the contacts could not be loaded and offers Try again, never the empty state', async () => {
    jest.mocked(sparkListContacts).mockRejectedValue(new Error('spark not connected'))
    const shown = texts(await render())
    expect(shown).toContain(loadFailed())
    expect(shown).toContain(retry())
    expect(shown).not.toContain(i18n.t('contacts.empty'))
  })

  test('Try again shows the skeleton while it reads, then the contacts it answers', async () => {
    jest.mocked(sparkListContacts).mockRejectedValueOnce(new Error('spark not connected'))
    const tree = await render()
    let resolve!: (rows: { id: string; name: string; address: string }[]) => void
    jest.mocked(sparkListContacts).mockReturnValueOnce(new Promise(r => (resolve = r)))

    await pressBtn(tree, retry())

    expect(sparkListContacts).toHaveBeenCalledTimes(2)
    expect(texts(tree)).not.toContain(loadFailed())
    expect(texts(tree)).not.toContain(i18n.t('contacts.empty'))
    await ReactTestRenderer.act(async () =>
      resolve([{ id: 'c1', name: 'Alice', address: 'alice@breez.tips' }]),
    )
    await settle()
    expect(texts(tree)).toContain('Alice')
    expect(texts(tree)).not.toContain(loadFailed())
  })

  test('Try again that answers with nothing is the empty state', async () => {
    jest.mocked(sparkListContacts).mockRejectedValueOnce(new Error('spark not connected'))
    const tree = await render()
    jest.mocked(sparkListContacts).mockResolvedValueOnce([])

    await pressBtn(tree, retry())

    expect(texts(tree)).toContain(i18n.t('contacts.empty'))
    expect(texts(tree)).not.toContain(loadFailed())
  })

  test('a failed read after a save shows the error, not the list from before the save', async () => {
    // The list on screen no longer holds the contact just saved, so keeping it would say the save
    // did nothing.
    const tree = await render()
    jest.mocked(sparkListContacts).mockRejectedValueOnce(new Error('storage'))
    await pressBtn(tree, 'Add contact')
    await type(tree, 0, 'Bob')
    await type(tree, 1, 'bob@x.com')

    await pressBtn(tree, 'Save')

    expect(sparkAddContact).toHaveBeenCalledWith('Bob', 'bob@x.com')
    expect(texts(tree)).toContain(loadFailed())
    expect(texts(tree)).not.toContain('Alice')
    expect(texts(tree)).not.toContain(i18n.t('contacts.empty'))
  })
})

// Focus, a save, a removal and Try again each start a read, and the reads can answer out of order.
describe('only the last read started lands', () => {
  const bob = { id: 'c2', name: 'Bob', address: 'bob@x.com' }
  const alice = { id: 'c1', name: 'Alice', address: 'alice@breez.tips' }

  async function addBobWhileTheFirstReadHangs(): Promise<{
    tree: ReactTestRenderer.ReactTestRenderer
    first: { resolve: (rows: never[]) => void; reject: (e: Error) => void }
  }> {
    const first = {} as { resolve: (rows: never[]) => void; reject: (e: Error) => void }
    jest.mocked(sparkListContacts).mockReturnValueOnce(
      new Promise<never[]>((res, rej) => {
        first.resolve = res
        first.reject = rej
      }),
    )
    jest.mocked(sparkListContacts).mockResolvedValueOnce([alice, bob])
    const tree = await render()
    await pressBtn(tree, 'Add contact')
    await type(tree, 0, 'Bob')
    await type(tree, 1, 'bob@x.com')
    await pressBtn(tree, 'Save')
    expect(texts(tree)).toContain('Bob')
    return { tree, first }
  }

  test('an older read answering empty does not wipe the list a newer read drew', async () => {
    const { tree, first } = await addBobWhileTheFirstReadHangs()
    await ReactTestRenderer.act(async () => first.resolve([]))
    await settle()
    expect(texts(tree)).toContain('Bob')
    expect(texts(tree)).not.toContain(i18n.t('contacts.empty'))
  })

  test('an older read failing late does not turn a newer list into the error', async () => {
    const { tree, first } = await addBobWhileTheFirstReadHangs()
    await ReactTestRenderer.act(async () => first.reject(new Error('timeout')))
    await settle()
    expect(texts(tree)).toContain('Bob')
    expect(texts(tree)).not.toContain(i18n.t('contacts.loadFailed'))
  })
})

test('keeps the remove button away from the save button rather than one gap from it', async () => {
  // The sheet lays its children out on one uniform gap, so without this the destructive action sits
  // exactly as far from Save as the title sits from the first field. That distance is worth choosing.
  jest
    .mocked(sparkListContacts)
    .mockResolvedValue([{ id: 'c1', name: 'Alice', address: 'alice@breez.tips' }])
  const tree = await render()
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === 'Alice'))!
  await ReactTestRenderer.act(async () => row.props.onPress())
  await settle()

  const remove = tree.root
    .findAllByType(GradientButton)
    .find(button => button.props.label === i18n.t('contacts.remove'))!
  expect(remove.props.variant).toBe('danger')
  expect(StyleSheet.flatten(remove.parent!.props.style).marginTop).toBeGreaterThan(0)
})

// The line's own style, flattened, from the pressable that holds `label`.
function lineStyleOf(tree: ReactTestRenderer.ReactTestRenderer, label: string): Record<string, unknown> {
  const line = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
    .find(n => n.findAllByType(Text).some(txt => String(txt.props.children).includes(label)))!
  return Object.assign(
    {},
    ...[line.props.style({ pressed: false })].flat(Infinity).filter(x => x && typeof x === 'object'),
  )
}

// A Touch is a column, so a line that does not lay itself across stacks every part vertically.
test('a contact line lays its avatar, name and chevron across', async () => {
  const style = lineStyleOf(await render(), 'Alice')
  expect(style.flexDirection).toBe('row')
  expect(style.alignItems).toBe('center')
})

// Save stays hidden while the address does not parse, and the placeholder naming the format is gone
// once typing starts, so the field itself says why the sheet has no Save, once the person is done.
test.each([
  ['a Spark address', 'spark1testaddr'],
  ['a Lightning invoice', 'lnbc1invoice'],
  ['an on-chain address', 'bc1qtestaddress'],
  ['a domain with no top-level part', 'bob@localhost'],
])('says the address is not a lightning address on leaving the field with %s', async (_, addr) => {
  const error = i18n.t('contacts.invalidAddress')
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await type(tree, 0, 'Bob')
  await focusAddress(tree)
  await type(tree, 1, addr)
  expect(texts(tree)).not.toContain(error)

  await leaveAddress(tree)
  expect(texts(tree)).toContain(error)
})

test('says nothing while each letter of an address is typed', async () => {
  const error = i18n.t('contacts.invalidAddress')
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await focusAddress(tree)
  const address = 'bob@x.com'
  for (let end = 1; end <= address.length; end++) {
    await type(tree, 1, address.slice(0, end))
    expect(texts(tree)).not.toContain(error)
  }
})

test('says so under the keyboard once the text can be whole and still is not an address', async () => {
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await focusAddress(tree)
  await type(tree, 1, 'bob!@x.com')

  expect(texts(tree)).toContain(i18n.t('contacts.invalidAddress'))
})

test('goes quiet again when the field is taken back to be fixed', async () => {
  const error = i18n.t('contacts.invalidAddress')
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  await focusAddress(tree)
  await type(tree, 1, 'bob')
  await leaveAddress(tree)
  expect(texts(tree)).toContain(error)

  await focusAddress(tree)
  await type(tree, 1, 'bob@')
  expect(texts(tree)).not.toContain(error)
})

test('says nothing about the address while it is empty or once it is a lightning address', async () => {
  const error = i18n.t('contacts.invalidAddress')
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  expect(texts(tree)).not.toContain(error)

  await type(tree, 1, 'bob@x.com')
  expect(texts(tree)).not.toContain(error)

  await type(tree, 1, '   ')
  expect(texts(tree)).not.toContain(error)

  await type(tree, 1, '')
  expect(texts(tree)).not.toContain(error)
})

// The line under the field is taken from the start, so Save arriving moves nothing in the sheet.
test('the line under the address stands before typing and when Save appears', async () => {
  const hint = i18n.t('contacts.addressHint')
  const tree = await render()
  await pressBtn(tree, 'Add contact')
  expect(texts(tree)).toContain(hint)

  await type(tree, 0, 'Bob')
  await focusAddress(tree)
  await type(tree, 1, 'bob')
  expect(texts(tree)).toContain(hint)

  await type(tree, 1, 'bob@x.com')
  expect(texts(tree)).toContain(hint)
})

test('says so when an edit breaks a saved contact address, and not once it parses again', async () => {
  const error = i18n.t('contacts.invalidAddress')
  const tree = await render()
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === 'Alice'))!
  await ReactTestRenderer.act(async () => row.props.onPress())
  await settle()

  await focusAddress(tree)
  await type(tree, 1, 'alice@breez')
  await leaveAddress(tree)
  expect(texts(tree)).toContain(error)

  await focusAddress(tree)
  await type(tree, 1, 'alice@breez.tips')
  await leaveAddress(tree)
  expect(texts(tree)).not.toContain(error)
})

test('a saved contact opens for editing with no address error', async () => {
  const tree = await render()
  const row = tree.root
    .findAll(n => typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(x => x.props.children === 'Alice'))!
  await ReactTestRenderer.act(async () => row.props.onPress())
  await settle()

  expect(texts(tree)).toContain(i18n.t('contacts.editTitle'))
  expect(texts(tree)).not.toContain(i18n.t('contacts.invalidAddress'))
})

// A store call that fails keeps the sheet open with what was typed and says so inside it, rather than
// closing on nothing or doing nothing at all.
describe('when the store call fails', () => {
  const inSheet = (tree: ReactTestRenderer.ReactTestRenderer): string[] =>
    tree.root
      .findByType(Sheet)
      .findAllByType(Text)
      .map(node => String(node.props.children))
  const fields = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(TextInput).map(input => input.props.value)
  async function openAlice(tree: ReactTestRenderer.ReactTestRenderer): Promise<void> {
    const row = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(x => x.props.children === 'Alice'))!
    await ReactTestRenderer.act(async () => row.props.onPress())
    await settle()
  }

  test('a failed add says so in the sheet and keeps the fields', async () => {
    jest.mocked(sparkAddContact).mockRejectedValueOnce(new Error('storage'))
    const tree = await render()
    await pressBtn(tree, 'Add contact')
    await type(tree, 0, 'Bob')
    await type(tree, 1, 'bob@x.com')

    await pressBtn(tree, 'Save')

    expect(inSheet(tree)).toContain(i18n.t('contacts.saveFailed'))
    expect(tree.root.findByType(Sheet).props.visible).toBe(true)
    expect(fields(tree)).toEqual(['Bob', 'bob@x.com'])
    expect(tree.root.find(n => n.props.label === 'Save' && 'loading' in n.props).props.loading).toBe(false)
  })

  test('a failed edit says so in the sheet and keeps the fields', async () => {
    jest.mocked(sparkUpdateContact).mockRejectedValueOnce(new Error('storage'))
    const tree = await render()
    await openAlice(tree)
    await type(tree, 0, 'Alice B')

    await pressBtn(tree, 'Save')

    expect(sparkUpdateContact).toHaveBeenCalledWith('c1', 'Alice B', 'alice@breez.tips')
    expect(inSheet(tree)).toContain(i18n.t('contacts.saveFailed'))
    expect(fields(tree)).toEqual(['Alice B', 'alice@breez.tips'])
  })

  test('a failed removal says so in the sheet and keeps it open', async () => {
    jest.mocked(sparkDeleteContact).mockRejectedValueOnce(new Error('storage'))
    const tree = await render()
    await openAlice(tree)

    await pressBtn(tree, i18n.t('contacts.remove'))
    await reply(tree, i18n.t('contacts.removeConfirm'))

    expect(inSheet(tree)).toContain(i18n.t('contacts.removeFailed'))
    expect(tree.root.findByType(Sheet).props.visible).toBe(true)
  })

  test('the error is gone when the sheet opens again', async () => {
    jest.mocked(sparkDeleteContact).mockRejectedValueOnce(new Error('storage'))
    const tree = await render()
    await openAlice(tree)
    await pressBtn(tree, i18n.t('contacts.remove'))
    await reply(tree, i18n.t('contacts.removeConfirm'))
    await ReactTestRenderer.act(async () => tree.root.findByType(Sheet).props.onClose())
    await settle()

    await openAlice(tree)

    expect(inSheet(tree)).not.toContain(i18n.t('contacts.removeFailed'))
  })
})

const flatStyle = (raw: unknown): Record<string, unknown> =>
  Object.assign({}, ...[raw].flat(Infinity).filter(x => x && typeof x === 'object'))

describe('the list as it loads, empty, and under the sheet', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  test('loads as one card shaped like the contact rows, at their line heights', async () => {
    jest.mocked(sparkListContacts).mockImplementationOnce(() => new Promise(() => undefined))
    const tree = await render()
    const bars = tree.root.findAllByType(Skeleton)
    expect(bars.map(bar => bar.props.height)).toEqual([40, font.leading.base, font.leading.sm, 40, font.leading.base, font.leading.sm, 40, font.leading.base, font.leading.sm])
    expect(tree.root.findAllByType(Card)).toHaveLength(1)
  })

  // One card, with the first and last row carrying its corners, and a line only between two rows.
  test('the contacts draw as one card with lines between them', async () => {
    jest.mocked(sparkListContacts).mockResolvedValue([
      { id: 'a', name: 'Ana', address: 'ana@usevoltz.app' },
      { id: 'b', name: 'Bia', address: 'bia@usevoltz.app' },
    ] as Awaited<ReturnType<typeof sparkListContacts>>)
    const tree = await render()
    const rows = tree.root
      .findAll(n => typeof n.props.onPress === 'function' && n.props.feedback === 'row')
      .map(n => flatStyle(n.props.style))
    expect(rows.map(row => row.backgroundColor)).toEqual([colors.surface, colors.surface])
    expect(rows[0].borderTopLeftRadius).toBe(radius.lg)
    expect(rows[0].borderBottomWidth).toBeGreaterThan(0)
    expect(rows[1].borderBottomLeftRadius).toBe(radius.lg)
    expect(rows[1].borderBottomWidth).toBeUndefined()
  })

  test.each(['synced', 'stale'] as const)(
    'an empty answer on a %s connection draws the add row inside its centred block',
    async sync => {
      jest.mocked(sparkSyncState).mockReturnValue(sync)
      jest.mocked(sparkListContacts).mockResolvedValue([])
      const tree = await render()
      const blocks = tree.root.findAllByType(EmptyState)
      expect(blocks).toHaveLength(1)
      expect(blocks[0].findAllByType(AddRow)).toHaveLength(1)
      expect(tree.root.findAllByType(AddRow)).toHaveLength(1)
    },
  )

  test('a list with contacts keeps the add row under it, outside any block', async () => {
    const tree = await render()
    expect(tree.root.findAllByType(EmptyState)).toHaveLength(0)
    expect(tree.root.findAllByType(AddRow)).toHaveLength(1)
  })

  test('an empty answer is centred in the screen', async () => {
    jest.mocked(sparkListContacts).mockResolvedValue([])
    const tree = await render()
    expect(texts(tree)).toContain(i18n.t('contacts.empty'))
    const content = flatStyle(tree.root.findByType(FlatList).props.contentContainerStyle)
    expect([content.flexGrow, content.justifyContent]).toEqual([1, 'center'])
  })
})

describe('an address new to the list is checked before it is saved', () => {
  const fetching = jest.fn()
  const realFetch = global.fetch

  beforeEach(() => {
    fetching.mockReset()
    global.fetch = fetching as unknown as typeof fetch
  })
  afterEach(() => {
    global.fetch = realFetch
  })

  const addBob = async () => {
    const tree = await render()
    await pressBtn(tree, 'Add contact')
    await type(tree, 0, 'Bob')
    await type(tree, 1, 'bob@x.com')
    await pressBtn(tree, 'Save')
    return tree
  }
  const sheetOpen = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(Sheet).props.visible

  test('an address the SDK can read saves', async () => {
    const tree = await addBob()
    expect(sparkClassify).toHaveBeenCalledWith('bob@x.com')
    expect(sparkAddContact).toHaveBeenCalledWith('Bob', 'bob@x.com')
    expect(sheetOpen(tree)).toBe(false)
  })

  test('a server saying there is no such name keeps the sheet and saves nothing', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('other')
    fetching.mockResolvedValue({ status: 404 })
    const tree = await addBob()

    expect(texts(tree)).toContain(i18n.t('contacts.addressNotFound'))
    expect(sparkAddContact).not.toHaveBeenCalled()
    expect(sheetOpen(tree)).toBe(true)
  })

  test('no connection never calls the address wrong, and saves nothing', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('other')
    fetching.mockRejectedValue(new TypeError('Network request failed'))
    const tree = await addBob()

    expect(texts(tree)).toContain(i18n.t('contacts.addressUnreachable'))
    expect(texts(tree)).not.toContain(i18n.t('contacts.addressNotFound'))
    expect(sparkAddContact).not.toHaveBeenCalled()
    expect(sheetOpen(tree)).toBe(true)
  })

  test('a save that follows a refusal starts clean', async () => {
    jest.mocked(sparkClassify).mockResolvedValueOnce('other')
    fetching.mockRejectedValue(new TypeError('Network request failed'))
    const tree = await addBob()
    await pressBtn(tree, 'Save')

    expect(texts(tree)).not.toContain(i18n.t('contacts.addressUnreachable'))
    expect(sparkAddContact).toHaveBeenCalledTimes(1)
  })

  const editAlice = async (newName: string, newAddress: string) => {
    const tree = await render()
    await pressBtn(tree, 'Alice')
    await type(tree, 0, newName)
    await type(tree, 1, newAddress)
    await pressBtn(tree, 'Save')
    return tree
  }

  test('a new name on the same address consults nothing', async () => {
    await editAlice('Alicia', 'alice@breez.tips')
    expect(sparkClassify).not.toHaveBeenCalled()
    expect(fetching).not.toHaveBeenCalled()
    expect(sparkUpdateContact).toHaveBeenCalledWith('c1', 'Alicia', 'alice@breez.tips')
  })

  test('the same address in other capitals is the same address', async () => {
    await editAlice('Alice', 'Alice@Breez.Tips')
    expect(sparkClassify).not.toHaveBeenCalled()
  })

  test('a changed address is checked, and a wrong one keeps the contact as it was', async () => {
    jest.mocked(sparkClassify).mockResolvedValue('other')
    fetching.mockResolvedValue({ status: 404 })
    const tree = await editAlice('Alice', 'alice2@breez.tips')

    expect(sparkClassify).toHaveBeenCalledWith('alice2@breez.tips')
    expect(sparkUpdateContact).not.toHaveBeenCalled()
    expect(texts(tree)).toContain(i18n.t('contacts.addressNotFound'))
  })

  describe('while the check is out', () => {
    let answer!: (kind: SparkDestinationKind) => void
    const checking = async () => {
      jest.mocked(sparkClassify).mockReturnValue(new Promise(resolve => (answer = resolve)))
      return addBob()
    }

    test('a second tap saves once', async () => {
      const tree = await checking()
      await pressBtn(tree, 'Save')
      expect(sparkClassify).toHaveBeenCalledTimes(1)

      await ReactTestRenderer.act(async () => answer('lightningAddress'))
      await settle()
      expect(sparkAddContact).toHaveBeenCalledTimes(1)
    })

    test('the fields hold what is being checked', async () => {
      const tree = await checking()
      expect(tree.root.findAllByType(TextInput).map(input => input.props.editable)).toEqual([false, false])
    })

    test('an answer after the sheet closed saves nothing and says nothing', async () => {
      const tree = await checking()
      await ReactTestRenderer.act(async () => tree.root.findByType(Sheet).props.onClose())
      await ReactTestRenderer.act(async () => answer('lightningAddress'))
      await settle()

      expect(sparkAddContact).not.toHaveBeenCalled()
      expect(sheetOpen(tree)).toBe(false)
    })

    test('a sheet opened after the close is not touched by that answer', async () => {
      jest.mocked(sparkClassify).mockResolvedValue('other')
      fetching.mockResolvedValue({ status: 404 })
      const tree = await checking()
      jest.mocked(sparkClassify).mockReturnValue(new Promise(resolve => (answer = resolve)))
      await ReactTestRenderer.act(async () => tree.root.findByType(Sheet).props.onClose())
      await pressBtn(tree, 'Add contact')
      await ReactTestRenderer.act(async () => answer('other'))
      await settle()

      expect(sheetOpen(tree)).toBe(true)
      expect(texts(tree)).not.toContain(i18n.t('contacts.addressNotFound'))
      expect(tree.root.findAllByType(TextInput)[0].props.editable).toBe(true)
    })
  })
})

describe('the list follows the wallet', () => {
  const event = async () => {
    const listener = jest.mocked(sparkSubscribeToPayments).mock.calls.at(-1)?.[0]
    await ReactTestRenderer.act(async () => listener?.())
    await settle()
  }
  const synced = async () => {
    await ReactTestRenderer.act(async () => mockSynced.forEach(cb => cb()))
    await settle()
  }
  const BOB: SparkContact = { id: 'c2', name: 'Bob', address: 'bob@x.com' }

  test('a contact from another device shows on the next SDK event', async () => {
    const tree = await render()
    jest.mocked(sparkListContacts).mockResolvedValue([BOB])
    await event()
    expect(texts(tree)).toContain('Bob')
  })

  test('a read of the wallet that fails keeps the list on screen', async () => {
    const tree = await render()
    jest.mocked(sparkListContacts).mockRejectedValue(new Error('storage'))
    await event()

    expect(texts(tree)).toContain('Alice')
    expect(texts(tree)).not.toContain(i18n.t('contacts.loadFailed'))
  })

  test('such a failure over a first read still out is the error, never a skeleton for good', async () => {
    jest.mocked(sparkListContacts).mockReturnValueOnce(new Promise(() => undefined))
    const tree = await render()
    jest.mocked(sparkListContacts).mockRejectedValue(new Error('storage'))
    await event()
    expect(texts(tree)).toContain(i18n.t('contacts.loadFailed'))
  })

  test('an event with the sheet open keeps the sheet and what was typed', async () => {
    const tree = await render()
    await pressBtn(tree, 'Add contact')
    await type(tree, 0, 'Bo')
    jest.mocked(sparkListContacts).mockResolvedValue([BOB])
    await event()

    expect(tree.root.findByType(Sheet).props.visible).toBe(true)
    expect(tree.root.findAllByType(TextInput)[0].props.value).toBe('Bo')
    expect(texts(tree)).toContain('Bob')
  })

  test('leaving the screen lets go of the listener', async () => {
    const off = jest.fn()
    jest.mocked(sparkSubscribeToPayments).mockResolvedValue(off)
    const tree = await render()
    expect(off).not.toHaveBeenCalled()

    await ReactTestRenderer.act(async () => tree.unmount())
    expect(off).toHaveBeenCalledTimes(1)
    expect(mockConnected.size).toBe(0)
  })

  test('a listener that lands after leaving is let go as it lands', async () => {
    const off = jest.fn()
    let landed!: (next: () => void) => void
    jest.mocked(sparkSubscribeToPayments).mockReturnValue(new Promise(resolve => (landed = resolve)))
    const tree = await render()
    await ReactTestRenderer.act(async () => tree.unmount())
    await ReactTestRenderer.act(async () => landed(off))
    expect(off).toHaveBeenCalledTimes(1)
  })

  test('a new connection subscribes again and lets go of the old one', async () => {
    const first = jest.fn()
    jest.mocked(sparkSubscribeToPayments).mockResolvedValueOnce(first)
    await render()
    await ReactTestRenderer.act(async () => mockConnected.forEach(cb => cb()))
    await settle()

    expect(first).toHaveBeenCalledTimes(1)
    expect(sparkSubscribeToPayments).toHaveBeenCalledTimes(2)
  })

  test('with two subscriptions out, only the newest stays', async () => {
    const older = jest.fn()
    let landed!: (next: () => void) => void
    jest.mocked(sparkSubscribeToPayments).mockReturnValueOnce(new Promise(resolve => (landed = resolve)))
    await render()
    await ReactTestRenderer.act(async () => mockConnected.forEach(cb => cb()))
    await ReactTestRenderer.act(async () => landed(older))
    await settle()
    expect(older).toHaveBeenCalledTimes(1)
  })

  test('a subscription that fails leaves the screen as it is', async () => {
    jest.mocked(sparkSubscribeToPayments).mockRejectedValue(new Error('not connected'))
    const tree = await render()
    expect(texts(tree)).toContain('Alice')
  })

  describe('an empty answer before the sync', () => {
    const emptyOn = async (sync: BalanceSync) => {
      jest.mocked(sparkSyncState).mockReturnValue(sync)
      jest.mocked(sparkListContacts).mockResolvedValue([])
      return render()
    }

    test('waiting keeps the skeleton and says nothing of the wallet', async () => {
      const tree = await emptyOn('waiting')
      expect(tree.root.findAllByType(Skeleton).length).toBeGreaterThan(0)
      expect(texts(tree)).not.toContain(i18n.t('contacts.empty'))
    })

    test('stale says it is not updated, and not that there are no contacts', async () => {
      const tree = await emptyOn('stale')
      expect(texts(tree)).toContain(i18n.t('home.notUpdated'))
      expect(texts(tree)).not.toContain(i18n.t('contacts.empty'))
      expect(tree.root.findAllByType(Skeleton)).toHaveLength(0)
    })

    test('synced is the fact', async () => {
      expect(texts(await emptyOn('synced'))).toContain(i18n.t('contacts.empty'))
    })

    test('waiting that becomes synced turns into the empty state', async () => {
      const tree = await emptyOn('waiting')
      jest.mocked(sparkSyncState).mockReturnValue('synced')
      await synced()
      expect(texts(tree)).toContain(i18n.t('contacts.empty'))
    })

    test('waiting that runs out turns into the not updated line', async () => {
      const tree = await emptyOn('waiting')
      jest.mocked(sparkSyncState).mockReturnValue('stale')
      await synced()
      expect(texts(tree)).toContain(i18n.t('home.notUpdated'))
    })
  })

  test.each(['waiting', 'stale', 'synced'] as BalanceSync[])(
    'a list with a contact shows on a %s connection',
    async sync => {
      jest.mocked(sparkSyncState).mockReturnValue(sync)
      const tree = await render()
      expect(texts(tree)).toContain('Alice')
      expect(texts(tree)).not.toContain(i18n.t('home.notUpdated'))
    },
  )
})
