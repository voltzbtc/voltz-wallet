import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, Linking, StyleSheet, Text } from 'react-native'
import RNFS from 'react-native-fs'
import i18n from '../src/i18n'
import { ExplorersScreen } from '../src/screens/ExplorersScreen'
import { TransactionDetailSheet } from '../src/components/TransactionDetailSheet'
import { TX_EXPLORER_PRESETS } from '../src/wallet/settings'
import type { HistoryItem } from '../src/wallet/payment'
import { Sheet } from '../src/components/Sheet'
import { ErrorBox } from '../src/components/ErrorBox'
import { Screen } from '../src/components/Screen'
import { SectionLabel } from '../src/components/SectionLabel'
import { motion, rhythm } from '../src/theme'

async function flush(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
  }
}

// The row list runs a 200ms Animated timing that would fire after the test ends, so trees are torn down.
const mounted: ReactTestRenderer.ReactTestRenderer[] = []

afterEach(() => {
  ReactTestRenderer.act(() => {
    for (const tree of mounted.splice(0)) {
      tree.unmount()
    }
  })
})

async function render(node: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(node)
  })
  await flush()
  mounted.push(tree)
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

async function pickRow(tree: ReactTestRenderer.ReactTestRenderer, url: string): Promise<void> {
  const row = tree.root
    .findAll(n => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function')
    .find(n => n.findAllByType(Text).some(txt => txt.props.children === url))
  if (!row) {
    throw new Error(`row not found: ${url}`)
  }
  await ReactTestRenderer.act(async () => {
    row.props.onPress()
  })
  await flush()
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
  await flush()
}

async function addExplorer(tree: ReactTestRenderer.ReactTestRenderer, url: string): Promise<void> {
  await pressBtn(tree, 'Add explorer')
  const input = tree.root.findAll(n => typeof n.props.onChangeText === 'function')[0]
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText(url)
  })
  await flush()
  await pressBtn(tree, 'Save')
}

const ONCHAIN_TX: HistoryItem = {
  id: 'p1',
  direction: 'received',
  status: 'complete',
  amountSat: 50_000,
  feesSat: 0,
  timestamp: 1_754_400_000,
  method: 'bitcoin',
  asset: null,
  txId: 'deadbeefcafe',
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
})

// The intro is a hint under the header, so the first block sits a hint's distance under it, and the
// sections keep a section's distance between them.
test('its sections stand apart by the rhythm, and from the text that opens the screen', async () => {
  const tree = await render(<ExplorersScreen />)
  expect(tree.root.findAllByType(SectionLabel).length).toBeGreaterThan(0)
  const screen = tree.root.findByType(Screen).props.contentStyle
  expect(StyleSheet.flatten(screen).gap).toBe(rhythm.hintToContent)
  const sections = tree.root.findAll(
    node => typeof node.type === 'string' && StyleSheet.flatten(node.props.style)?.gap === rhythm.section,
  )
  expect(sections.some(node => node.findAllByType(SectionLabel).length > 0)).toBe(true)
})

test('lists the shipped explorers with the first one selected', async () => {
  const tree = await render(<ExplorersScreen />)

  const shown = texts(tree)
  for (const preset of TX_EXPLORER_PRESETS) {
    expect(shown).toContain(preset.url)
  }
  const selected = tree.root.findAll(
    n =>
      n.props.accessibilityRole === 'radio' &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityState?.checked === true,
  )
  expect(selected).toHaveLength(1)
})

test('adding a self-hosted address stores it and makes it the selected one', async () => {
  const tree = await render(<ExplorersScreen />)

  await addExplorer(tree, 'http://mempool.local:3006')

  expect(texts(tree)).toContain('http://mempool.local:3006')
  // Adding is choosing, so the new entry is the checked radio.
  const checked = tree.root.find(
    n =>
      n.props.accessibilityRole === 'radio' &&
      typeof n.props.onPress === 'function' &&
      n.props.accessibilityState?.checked === true,
  )
  expect(
    checked.findAllByType(Text).some(t => t.props.children === 'http://mempool.local:3006'),
  ).toBe(true)
})

test('the save button stays disabled for an address that is not http(s)', async () => {
  const tree = await render(<ExplorersScreen />)
  await pressBtn(tree, 'Add explorer')

  const input = tree.root.findAll(n => typeof n.props.onChangeText === 'function')[0]
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('mempool.local:3006')
  })
  await flush()

  const save = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && n.props.disabled !== undefined)
    .find(n => n.findAllByType(Text).some(t => t.props.children === 'Save'))
  expect(save?.props.disabled).toBe(true)
  expect(texts(tree).join(' ')).toContain('Invalid address')
})

test('the transaction detail opens the explorer the user chose', async () => {
  const screen = await render(<ExplorersScreen />)
  await addExplorer(screen, 'https://node.example.com/mempool')

  const opened: string[] = []
  const spy = jest.spyOn(Linking, 'openURL').mockImplementation(async url => {
    opened.push(url)
    return true
  })

  const sheet = await render(<TransactionDetailSheet item={ONCHAIN_TX} onClose={() => undefined} />)
  await pressBtn(sheet, 'View in explorer')

  expect(opened).toEqual(['https://node.example.com/mempool/tx/deadbeefcafe'])
  spy.mockRestore()
})

test('switching to the other shipped explorer changes where the link opens', async () => {
  const screen = await render(<ExplorersScreen />)
  await pickRow(screen, TX_EXPLORER_PRESETS[1].url)

  const opened: string[] = []
  const spy = jest.spyOn(Linking, 'openURL').mockImplementation(async url => {
    opened.push(url)
    return true
  })

  const sheet = await render(<TransactionDetailSheet item={ONCHAIN_TX} onClose={() => undefined} />)
  await pressBtn(sheet, 'View in explorer')

  expect(opened).toEqual([`${TX_EXPLORER_PRESETS[1].url}/tx/deadbeefcafe`])
  spy.mockRestore()
})

test('with nothing chosen, the link falls back to the default explorer', async () => {
  const opened: string[] = []
  const spy = jest.spyOn(Linking, 'openURL').mockImplementation(async url => {
    opened.push(url)
    return true
  })

  const sheet = await render(<TransactionDetailSheet item={ONCHAIN_TX} onClose={() => undefined} />)
  await pressBtn(sheet, 'View in explorer')

  expect(opened).toEqual([`${TX_EXPLORER_PRESETS[0].url}/tx/deadbeefcafe`])
  spy.mockRestore()
})

test('the list names each explorer by its host, not only by its full address', async () => {
  // The host is what a person recognises; the URL below it is the detail. Without the host the rows
  // are told apart by a line of small grey text alone.
  const tree = await render(<ExplorersScreen />)
  expect(texts(tree)).toContain('mempool.space')
})

test('says what shape an address should be, before one is typed and after a bad one', async () => {
  // The hint is the only thing on the sheet explaining that a self-hosted instance needs the scheme.
  // It gives way to the error, which is the behaviour, so both states are checked.
  const tree = await render(<ExplorersScreen />)
  await pressBtn(tree, 'Add explorer')
  expect(texts(tree)).toContain(i18n.t('explorers.hint'))

  const input = tree.root.findAll(n => typeof n.props.onChangeText === 'function')[0]!
  await ReactTestRenderer.act(async () => {
    input.props.onChangeText('not a url')
  })
  await flush()
  expect(texts(tree)).toContain(i18n.t('explorers.invalidUrl'))
  expect(texts(tree)).not.toContain(i18n.t('explorers.hint'))
})

// A store that cannot be written says so, rather than clearing the spinner and nothing else.
describe('a change that cannot be stored', () => {
  const settings = jest.requireActual('../src/wallet/settings') as typeof import('../src/wallet/settings')
  afterEach(() => {
    jest.restoreAllMocks()
  })
  const sheetOpen = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAllByType(Sheet).some(sheet => sheet.props.visible)

  test('an explorer that cannot be added says so in its sheet, which stays open', async () => {
    jest.spyOn(settings, 'addTxExplorer').mockRejectedValueOnce(new Error('disk full'))
    const tree = await render(<ExplorersScreen />)

    await addExplorer(tree, 'http://mempool.local:3006')

    expect(sheetOpen(tree)).toBe(true)
    const sheet = tree.root.findAllByType(Sheet).find(node => node.props.visible)!
    expect(sheet.findAllByType(ErrorBox).map(box => box.props.message)).toEqual([i18n.t('explorers.saveFailed')])
    expect(texts(tree)).not.toContain('http://mempool.local:3006')
  })

  test('a choice that cannot be stored says so under the list and keeps the one before', async () => {
    jest.spyOn(settings, 'selectTxExplorer').mockRejectedValueOnce(new Error('disk full'))
    const tree = await render(<ExplorersScreen />)

    await pickRow(tree, TX_EXPLORER_PRESETS[1].url)

    expect(texts(tree)).toContain(i18n.t('explorers.saveFailed'))
    const checked = tree.root.find(
      n => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function' && n.props.accessibilityState?.checked,
    )
    expect(checked.findAllByType(Text).some(t => t.props.children === TX_EXPLORER_PRESETS[0].url)).toBe(true)
  })

  test('no list stands before the file answers, and a failed read offers Try again', async () => {
    let refuse!: (cause: Error) => void
    jest.spyOn(settings, 'loadTxExplorers').mockImplementationOnce(
      () => new Promise((_, reject) => (refuse = reject)),
    )
    const tree = await render(<ExplorersScreen />)
    const radios = () => tree.root.findAll(n => n.props.accessibilityRole === 'radio')
    expect(radios()).toHaveLength(0)

    await ReactTestRenderer.act(async () => {
      refuse(new Error('unreadable'))
    })
    await flush()
    expect(radios()).toHaveLength(0)
    expect(texts(tree)).toContain(i18n.t('explorers.loadFailed'))

    const retry = tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .find(n => n.findAllByType(Text).some(t => t.props.children === i18n.t('common.retry')))!
    await ReactTestRenderer.act(async () => {
      retry.props.onPress()
    })
    await flush()
    expect(radios().length).toBeGreaterThan(0)
  })

  test('a removal that cannot be stored says so and keeps the explorer', async () => {
    const tree = await render(<ExplorersScreen />)
    await addExplorer(tree, 'http://mempool.local:3006')
    jest.spyOn(settings, 'removeTxExplorer').mockRejectedValueOnce(new Error('disk full'))

    const custom = tree.root
      .findAll(n => n.props.accessibilityRole === 'radio' && typeof n.props.onLongPress === 'function')
      .find(n => n.findAllByType(Text).some(t => t.props.children === 'http://mempool.local:3006'))!
    await ReactTestRenderer.act(async () => custom.props.onLongPress())
    await flush()
    const remove = tree.root.find(
      n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === i18n.t('common.remove'),
    )
    await ReactTestRenderer.act(async () => remove.props.onPress())
    await flush()

    expect(texts(tree)).toContain(i18n.t('explorers.saveFailed'))
    expect(texts(tree)).toContain('http://mempool.local:3006')
  })
})

// Nothing on screen says that holding an added explorer opens edit mode, so an Edit link opens it
// once there is one to remove, and an added explorer offers edit to a screen reader. Shipped
// explorers have neither.
describe('editing the list', () => {
  const SELF = 'https://mempool.example.org'
  const links = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root
      .findAll(n => typeof n.props.onPress === 'function')
      .filter(n => n.findAllByType(Text).some(t => t.props.children === label))
  const radios = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.accessibilityRole === 'radio' && typeof n.props.onPress === 'function')
  const removeButtons = (tree: ReactTestRenderer.ReactTestRenderer) =>
    tree.root.findAll(n => n.props.accessibilityLabel === i18n.t('common.remove') && typeof n.props.onPress === 'function')

  test('has no Edit link and no edit action while only shipped explorers are listed', async () => {
    const tree = await render(<ExplorersScreen />)
    expect(links(tree, i18n.t('explorers.edit'))).toHaveLength(0)
    for (const radio of radios(tree)) {
      expect(radio.props.accessibilityActions).toBeUndefined()
    }
  })

  test('the Edit link opens edit mode once an explorer is added, and Done closes it', async () => {
    const tree = await render(<ExplorersScreen />)
    await addExplorer(tree, SELF)
    expect(removeButtons(tree)).toHaveLength(0)

    await pressBtn(tree, i18n.t('explorers.edit'))
    expect(removeButtons(tree).length).toBeGreaterThan(0)
    expect(links(tree, i18n.t('explorers.edit'))).toHaveLength(0)

    await pressBtn(tree, i18n.t('home.done'))
    expect(removeButtons(tree)).toHaveLength(0)
  })

  test('the added explorer alone carries edit, which opens edit mode without removing anything', async () => {
    const tree = await render(<ExplorersScreen />)
    await addExplorer(tree, SELF)
    const withActions = radios(tree).filter(r => r.props.accessibilityActions)
    expect(withActions).toHaveLength(1)
    expect(withActions[0]!.props.accessibilityActions).toEqual([{ name: 'edit', label: i18n.t('explorers.edit') }])

    await ReactTestRenderer.act(async () => {
      withActions[0]!.props.onAccessibilityAction({ nativeEvent: { actionName: 'edit' } })
    })
    await flush()

    expect(removeButtons(tree).length).toBeGreaterThan(0)
    expect(texts(tree)).toContain(SELF)
    // In edit mode the rows carry no action, so the remove button is the only way to remove.
    expect(radios(tree).filter(r => r.props.accessibilityActions)).toHaveLength(0)
  })

  test('the delete slot slides over the motion scale, and jumps with reduced motion', async () => {
    const timing = jest.spyOn(Animated, 'timing')
    for (const [reduced, duration] of [
      [false, motion.fast],
      [true, 0],
    ] as const) {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
      const tree = await render(<ExplorersScreen />)
      await addExplorer(tree, SELF)
      timing.mockClear()
      await pressBtn(tree, i18n.t('explorers.edit'))
      expect(timing.mock.calls.map(([, config]) => config.duration)).toEqual([duration])
    }
    jest.restoreAllMocks()
  })
})
