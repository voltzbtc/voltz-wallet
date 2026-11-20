import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { FlatList, I18nManager, Settings } from 'react-native'
import RNRestart from 'react-native-restart'
import i18n from '../src/i18n'
import { LANGUAGES } from '../src/i18n/languages'
import { LanguageScreen } from '../src/screens/LanguageScreen'
import { EmptyState } from '../src/components/EmptyState'
import { Field } from '../src/components/Field'
import { PickerSkeleton } from '../src/components/PickerSkeleton'
import {
  clearDirectionRestart,
  loadDirectionRestart,
  saveDirectionRestart,
  saveDisplayLanguage,
  type LayoutDirection,
} from '../src/wallet/settings'
import { handledRefusal } from './support/handledRefusal'

// The marker is one slot that survives a restart, as the settings file does.
let stored: LayoutDirection | null = null
jest.mock('../src/wallet/settings', () => ({
  saveDisplayLanguage: jest.fn(),
  loadDirectionRestart: jest.fn(),
  saveDirectionRestart: jest.fn(),
  clearDirectionRestart: jest.fn(),
}))

let mockTransitionDone = true
jest.mock('../src/hooks/useTransitionDone', () => ({ useTransitionDone: () => mockTransitionDone }))

const h = React.createElement
const restart = jest.mocked(RNRestart.restart)

beforeEach(async () => {
  jest.clearAllMocks()
  stored = null
  mockTransitionDone = true
  await i18n.changeLanguage('en-US')
  jest.mocked(saveDisplayLanguage).mockResolvedValue(undefined)
  jest.mocked(loadDirectionRestart).mockImplementation(async () => stored)
  jest.mocked(saveDirectionRestart).mockImplementation(async direction => {
    stored = direction
  })
  jest.mocked(clearDirectionRestart).mockImplementation(async () => {
    stored = null
  })
  jest.replaceProperty(I18nManager, 'isRTL', false)
  jest.spyOn(I18nManager, 'allowRTL').mockImplementation(() => undefined)
  jest.spyOn(I18nManager, 'forceRTL').mockImplementation(() => undefined)
  jest.spyOn(console, 'warn').mockImplementation(() => undefined)
})

afterEach(async () => {
  jest.restoreAllMocks()
  await i18n.changeLanguage('en-US')
})

async function open(): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(h(LanguageScreen))
  })
  return tree
}

// The row as the list draws it now, read again after each tap so `selected` is current.
function row(tree: ReactTestRenderer.ReactTestRenderer, code: string) {
  const list = tree.root.findByType(FlatList)
  return list.props.renderItem({ item: LANGUAGES.find(l => l.code === code), index: 0 }).props
}

async function tap(tree: ReactTestRenderer.ReactTestRenderer, code: string): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await row(tree, code).onPress()
  })
}

test('a save that fails changes the words in place, and the next tap still answers', async () => {
  const tree = await open()
  jest.mocked(saveDisplayLanguage).mockRejectedValueOnce(new Error('disk full'))

  await tap(tree, 'ar')
  expect(restart).not.toHaveBeenCalled()
  expect(i18n.language).toBe('ar')
  expect(row(tree, 'ar').selected).toBe(true)

  await tap(tree, 'pt-BR')
  expect(i18n.language).toBe('pt-BR')
  expect(row(tree, 'pt-BR').selected).toBe(true)
  expect(saveDisplayLanguage).toHaveBeenLastCalledWith('pt-BR')
})

test('a save the platform refuses on an in-place change is handled', async () => {
  const tree = await open()
  const refusal = handledRefusal()
  jest.mocked(saveDisplayLanguage).mockReturnValueOnce(refusal.answer)

  await tap(tree, 'pt-BR')

  expect(i18n.language).toBe('pt-BR')
  expect(saveDisplayLanguage).toHaveBeenLastCalledWith('pt-BR')
  expect(refusal.handled()).toBe(true)
})

test('a restart for this direction that already did not take changes the words in place', async () => {
  stored = 'rtl'
  const tree = await open()

  await tap(tree, 'ar')
  expect(restart).not.toHaveBeenCalled()
  expect(i18n.language).toBe('ar')
  expect(saveDisplayLanguage).toHaveBeenLastCalledWith('ar')

  // The marker was cleared on the way, so the next tap that disagrees restarts once.
  await tap(tree, 'he')
  expect(restart).toHaveBeenCalledTimes(1)
  expect(saveDisplayLanguage).toHaveBeenLastCalledWith('he')
})

// UIKit takes its direction from the bundle localization the next launch picks, so every pick pins it,
// whether the language switches in place or through a restart.
test('every pick pins the iOS bundle to the language picked', async () => {
  const write = jest.spyOn(Settings, 'set').mockImplementation(() => undefined)
  const tree = await open()

  await tap(tree, 'pt-PT')
  expect(restart).not.toHaveBeenCalled()
  expect(write).toHaveBeenLastCalledWith({ AppleLanguages: ['pt-PT'] })

  await tap(tree, 'he')
  expect(restart).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenLastCalledWith({ AppleLanguages: ['he'] })
  expect(write).toHaveBeenCalledTimes(2)
})

test('the list waits for the end of the push, with the skeleton in its place', async () => {
  mockTransitionDone = false
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(h(LanguageScreen))
  })
  expect(tree.root.findAllByType(FlatList)).toHaveLength(0)
  expect(tree.root.findAllByType(PickerSkeleton)).toHaveLength(1)

  mockTransitionDone = true
  await ReactTestRenderer.act(async () => tree.update(h(LanguageScreen)))

  expect(tree.root.findAllByType(FlatList)).toHaveLength(1)
  expect(tree.root.findAllByType(PickerSkeleton)).toHaveLength(0)
})

test('a search narrows the list, and a search that finds nothing says so', async () => {
  mockTransitionDone = true
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(h(LanguageScreen))
  })
  const search = () => tree.root.findByType(Field)
  ReactTestRenderer.act(() => search().props.onChangeText('deutsch'))
  expect(tree.root.findByType(FlatList).props.data.map((l: { code: string }) => l.code)).toEqual(['de'])
  ReactTestRenderer.act(() => search().props.onChangeText('zzz'))
  expect(tree.root.findByType(FlatList).props.data).toEqual([])
  expect(tree.root.findByType(EmptyState).props.message).toBe(i18n.t('settings.languageNoResult'))
})
