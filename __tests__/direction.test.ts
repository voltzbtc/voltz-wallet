import fs from 'fs'
import path from 'path'
import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { FlatList, I18nManager, NativeModules, Platform, StyleSheet, Text, TextInput } from 'react-native'
import RNRestart from 'react-native-restart'
import { DISCONNECT_BOUND_MS, settleDirection } from '../src/i18n/directionRestart'
import { disconnectSpark } from '../src/wallet/spark'
import { Txt } from '../src/components/Txt'
import { MenuRow } from '../src/components/MenuRow'
import { Field } from '../src/components/Field'
import { LANGUAGES } from '../src/i18n/languages'
import { LanguageScreen } from '../src/screens/LanguageScreen'
import {
  clearDirectionRestart,
  loadDirectionRestart,
  saveDirectionRestart,
  saveDisplayLanguage,
  type LayoutDirection,
} from '../src/wallet/settings'

// The marker lives in the settings file, modelled here as one slot that survives a restart, which
// is what the file does.
let stored: LayoutDirection | null = null
jest.mock('../src/hooks/useTransitionDone', () => ({ useTransitionDone: () => true }))
jest.mock('../src/wallet/settings', () => ({
  saveDisplayLanguage: jest.fn().mockResolvedValue(undefined),
  loadDirectionRestart: jest.fn(),
  saveDirectionRestart: jest.fn(),
  clearDirectionRestart: jest.fn(),
}))

jest.mock('../src/wallet/spark', () => ({
  ...jest.requireActual('../src/wallet/spark'),
  disconnectSpark: jest.fn(),
}))

// The running runtime's direction. A real restart would hand the next runtime the forced value;
// leaving it as set models a restart that did not take.
function runningDirection(rtl: boolean) {
  jest.replaceProperty(I18nManager, 'isRTL', rtl)
}

// The test file is .ts, so elements are built without JSX.
const h = React.createElement

const restart = jest.mocked(RNRestart.restart)
let allowRTL: jest.SpyInstance
let forceRTL: jest.SpyInstance
let warn: jest.SpyInstance

beforeEach(() => {
  jest.clearAllMocks()
  stored = null
  jest.mocked(loadDirectionRestart).mockImplementation(async () => stored)
  jest.mocked(saveDirectionRestart).mockImplementation(async direction => {
    stored = direction
  })
  jest.mocked(clearDirectionRestart).mockImplementation(async () => {
    stored = null
  })
  allowRTL = jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined)
  forceRTL = jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined)
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
  jest.mocked(disconnectSpark).mockResolvedValue(undefined)
})

afterEach(() => {
  jest.restoreAllMocks()
})

test('a restart that does not take is not repeated: the next boot settles and clears the marker', async () => {
  runningDirection(false)

  expect(await settleDirection('ar')).toBe('restarting')
  expect(restart).toHaveBeenCalledTimes(1)
  expect(stored).toBe('rtl')

  // The next boot, still LTR.
  expect(await settleDirection('ar')).toBe('settled')
  expect(restart).toHaveBeenCalledTimes(1)
  expect(stored).toBeNull()
  expect(warn).toHaveBeenCalledTimes(1)

  // And the one after it does not loop either: one restart per cold start at most.
  expect(await settleDirection('ar')).toBe('restarting')
  expect(await settleDirection('ar')).toBe('settled')
  expect(restart).toHaveBeenCalledTimes(2)
})

test('allowRTL always equals the target direction', async () => {
  runningDirection(true)
  await settleDirection('en-US')
  expect(allowRTL).toHaveBeenCalledWith(false)
  expect(forceRTL).toHaveBeenCalledWith(false)
  expect(allowRTL).not.toHaveBeenCalledWith(true)

  jest.clearAllMocks()
  stored = null
  runningDirection(false)
  await settleDirection('ar')
  expect(allowRTL).toHaveBeenCalledWith(true)
  expect(forceRTL).toHaveBeenCalledWith(true)
  expect(allowRTL).not.toHaveBeenCalledWith(false)
})

test('agreement never restarts and clears a stale marker', async () => {
  runningDirection(true)
  stored = 'rtl'

  expect(await settleDirection('ar')).toBe('settled')

  expect(restart).not.toHaveBeenCalled()
  expect(forceRTL).not.toHaveBeenCalled()
  expect(allowRTL).not.toHaveBeenCalled()
  expect(stored).toBeNull()
})

test('agreement with no marker writes nothing', async () => {
  runningDirection(false)

  expect(await settleDirection('pt-BR')).toBe('settled')

  expect(saveDirectionRestart).not.toHaveBeenCalled()
  expect(clearDirectionRestart).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
})

test('a marker that cannot be written never restarts', async () => {
  runningDirection(false)
  jest.mocked(saveDirectionRestart).mockRejectedValue(new Error('disk full'))

  expect(await settleDirection('ar')).toBe('settled')

  expect(restart).not.toHaveBeenCalled()
  expect(forceRTL).not.toHaveBeenCalled()
  expect(allowRTL).not.toHaveBeenCalled()
})

test('an unreadable marker counts as none and still restarts only once it is written', async () => {
  runningDirection(false)
  jest.mocked(loadDirectionRestart).mockRejectedValue(new Error('unreadable'))

  expect(await settleDirection('ar')).toBe('restarting')

  expect(saveDirectionRestart).toHaveBeenCalledWith('rtl')
  expect(restart).toHaveBeenCalledTimes(1)
})

test('a marker read that throws before it starts counts as none', async () => {
  runningDirection(false)
  jest.mocked(loadDirectionRestart).mockImplementation(() => {
    throw new TypeError('not a function')
  })

  expect(await settleDirection('en-US')).toBe('settled')
  expect(await settleDirection('ar')).toBe('restarting')
  expect(restart).toHaveBeenCalledTimes(1)
})

test('a marker left for the other direction does not stop a restart for this one', async () => {
  runningDirection(false)
  stored = 'ltr'

  expect(await settleDirection('he')).toBe('restarting')

  expect(stored).toBe('rtl')
  expect(restart).toHaveBeenCalledTimes(1)
})

describe('on Android', () => {
  const reload = jest.fn()

  beforeEach(() => {
    jest.replaceProperty(Platform, 'OS', 'android')
    NativeModules.VoltzRestart = { reload }
  })

  afterEach(() => {
    delete NativeModules.VoltzRestart
  })

  test('the restart reloads the ReactHost, never react-native-restart', async () => {
    runningDirection(false)

    expect(await settleDirection('ar')).toBe('restarting')

    expect(reload).toHaveBeenCalledTimes(1)
    expect(restart).not.toHaveBeenCalled()
  })

  test('the reload comes only after the SDK has disconnected', async () => {
    runningDirection(false)
    const order: string[] = []
    jest.mocked(disconnectSpark).mockImplementation(async () => {
      await Promise.resolve()
      order.push('disconnected')
    })
    reload.mockImplementation(() => order.push('reload'))

    expect(await settleDirection('ar')).toBe('restarting')

    expect(order).toEqual(['disconnected', 'reload'])
  })
})

// A restart keeps the process. An SDK still connected from the old runtime would sync next to the
// one the new runtime connects, on the same seed and storage directory.
describe('the SDK before a restart', () => {
  test('is disconnected, and the restart waits for it', async () => {
    runningDirection(false)
    const order: string[] = []
    jest.mocked(disconnectSpark).mockImplementation(async () => {
      await Promise.resolve()
      order.push('disconnected')
    })
    restart.mockImplementation(() => {
      order.push('restart')
    })

    expect(await settleDirection('ar')).toBe('restarting')

    expect(disconnectSpark).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['disconnected', 'restart'])
  })

  test('a disconnect that never answers holds the restart back only up to the bound', async () => {
    jest.useFakeTimers()
    try {
      runningDirection(false)
      jest.mocked(disconnectSpark).mockReturnValue(new Promise(() => undefined))

      let outcome: string | undefined
      settleDirection('ar').then(result => {
        outcome = result
      })
      await jest.advanceTimersByTimeAsync(DISCONNECT_BOUND_MS - 1)
      expect(restart).not.toHaveBeenCalled()

      await jest.advanceTimersByTimeAsync(1)
      expect(restart).toHaveBeenCalledTimes(1)
      expect(outcome).toBe('restarting')
      expect(DISCONNECT_BOUND_MS).toBeLessThanOrEqual(3000)
    } finally {
      jest.useRealTimers()
    }
  })

  test('a disconnect that fails, or throws before it starts, still restarts', async () => {
    runningDirection(false)
    jest.mocked(disconnectSpark).mockRejectedValue(new Error('sdk busy'))

    expect(await settleDirection('ar')).toBe('restarting')
    expect(restart).toHaveBeenCalledTimes(1)

    stored = null
    jest.mocked(disconnectSpark).mockImplementation(() => {
      throw new TypeError('not a function')
    })
    expect(await settleDirection('he')).toBe('restarting')
    expect(restart).toHaveBeenCalledTimes(2)
  })

  test('is left connected on every path that settles without a restart', async () => {
    // Agreement.
    runningDirection(false)
    expect(await settleDirection('en-US')).toBe('settled')
    // A restart for this direction already made.
    stored = 'rtl'
    expect(await settleDirection('ar')).toBe('settled')
    // A marker that cannot be written.
    jest.mocked(saveDirectionRestart).mockRejectedValue(new Error('disk full'))
    expect(await settleDirection('ar')).toBe('settled')

    expect(disconnectSpark).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
  })
})

// A second tap before the restart lands would save a language the new runtime was not started for,
// and a direction the marker does not name.
test('the picker lets the first restart win over a second tap', async () => {
  runningDirection(false)
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(h(LanguageScreen))
  })
  const list = tree.root.findByType(FlatList)
  const row = (code: string) =>
    list.props.renderItem({ item: LANGUAGES.find(l => l.code === code), index: 0 }).props

  await ReactTestRenderer.act(async () => {
    const first = row('ar').onPress()
    const second = row('he').onPress()
    const third = row('en-US').onPress()
    await Promise.all([first, second, third])
  })

  expect(saveDisplayLanguage).toHaveBeenCalledTimes(1)
  expect(saveDisplayLanguage).toHaveBeenCalledWith('ar')
  expect(saveDirectionRestart).toHaveBeenCalledTimes(1)
  expect(disconnectSpark).toHaveBeenCalledTimes(1)
  expect(restart).toHaveBeenCalledTimes(1)
})

// Every text imports the alignment helpers, so the module that holds them stays free of the SDK,
// the settings file and the restart.
test('the alignment helpers import nothing but react-native', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/i18n/direction.ts'), 'utf8')
  expect([...source.matchAll(/from '([^']+)'/g)].map(match => match[1])).toEqual(['react-native'])
})

// iOS aligns text without textAlign by the bundle's localization, so the shared text pieces give it
// one. Jest resolves react-native for iOS.
describe('text alignment on iOS', () => {
  async function mount(element: React.ReactElement): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(element)
    })
    return tree
  }
  const align = (node: ReactTestRenderer.ReactTestInstance) => StyleSheet.flatten(node.props.style)?.textAlign
  const textOf = (tree: ReactTestRenderer.ReactTestRenderer, label: string) =>
    tree.root.findAllByType(Text).find(node => node.props.children === label)!

  test.each([true, false])('text takes the leading edge with RTL %s, which Fabric swaps under RTL', async rtl => {
    runningDirection(rtl)
    expect(align(textOf(await mount(h(Txt, null, 'Backup')), 'Backup'))).toBe('left')
    const row = await mount(h(MenuRow, { label: 'Language', onPress: () => undefined }))
    expect(align(textOf(row, 'Language'))).toBe('left')
  })

  test('a field aligns its value and placeholder to the right under RTL and to the left otherwise', async () => {
    runningDirection(true)
    const rtl = await mount(h(Field, { value: '', onChangeText: () => undefined, placeholder: 'Passphrase' }))
    expect(align(rtl.root.findByType(TextInput))).toBe('right')

    runningDirection(false)
    const ltr = await mount(h(Field, { value: '', onChangeText: () => undefined, placeholder: 'Passphrase' }))
    expect(align(ltr.root.findByType(TextInput))).toBe('left')
  })

  test("a caller's own alignment still wins", async () => {
    runningDirection(true)
    const tree = await mount(h(Txt, { style: { textAlign: 'center' as const }, children: 'Centred' }))
    expect(align(textOf(tree, 'Centred'))).toBe('center')
  })

  test('Android is left to align by the layout', async () => {
    jest.replaceProperty(Platform, 'OS', 'android')
    runningDirection(true)
    expect(align(textOf(await mount(h(Txt, null, 'Backup')), 'Backup'))).toBeUndefined()
    const field = await mount(h(Field, { value: '', onChangeText: () => undefined }))
    expect(align(field.root.findByType(TextInput))).toBeUndefined()
  })
})
