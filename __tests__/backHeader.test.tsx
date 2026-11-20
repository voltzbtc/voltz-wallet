import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { I18nManager, Platform } from 'react-native'
import '../src/i18n'
import { BackButton } from '../src/components/BackHeader'
import { TabIcon } from '../src/components/TabIcon'
import { colors } from '../src/theme'

function backIconOn(os: 'ios' | 'android'): string {
  const held = Platform.OS
  Object.defineProperty(Platform, 'OS', { value: os, configurable: true })
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<BackButton onBack={() => undefined} />)
    })
    return tree.root.findByType(TabIcon).props.name
  } finally {
    Object.defineProperty(Platform, 'OS', { value: held, configurable: true })
  }
}

test('a step outside the navigator goes back with the mark the native header draws', () => {
  expect(backIconOn('android')).toBe('arrow-left')
  expect(backIconOn('ios')).toBe('chevron-left')
})

test('the arrow turns under a right to left layout, as the chevron does', () => {
  const held = I18nManager.isRTL
  Object.defineProperty(I18nManager, 'isRTL', { value: true, configurable: true })
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<TabIcon name="arrow-left" color={colors.text} />)
    })
    expect(JSON.stringify(tree.toJSON())).toContain('scaleX')
  } finally {
    Object.defineProperty(I18nManager, 'isRTL', { value: held, configurable: true })
  }
})
