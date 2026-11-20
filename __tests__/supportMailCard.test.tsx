import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { StyleSheet, Text, View } from 'react-native'
import i18n from '../src/i18n'
import { Card } from '../src/components/Card'
import { SupportMailCard } from '../src/components/SupportMail'
import { colors, font } from '../src/theme'
import { carriedTexts } from './support/mailFallback'

const NOTE = { mail: 'refused', text: null } as const

async function fill(raised?: boolean): Promise<unknown> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportMailCard note={NOTE} raised={raised} />)
  })
  return StyleSheet.flatten(tree.root.findByType(Card).findAllByType(View)[0]!.props.style).backgroundColor
}

test('stands off a sheet or a card on the raised fill', async () => {
  expect(await fill(true)).toBe(colors.surfaceVariant)
})

test('stays a card on a page', async () => {
  expect(await fill()).toBe(colors.surface)
})

// A 66-character key has nowhere to wrap, and a caption breaking it mid-run reads as two words.
test('a line holding a key stays on one line in the monospace face, and a sentence wraps', async () => {
  const key = `02${'a1'.repeat(32)}`
  const text = i18n.t('recover.mailBody', { pubkey: key, reference: 'ref-7' })
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportMailCard note={{ mail: 'refused', text }} />)
  })
  const lineOf = (part: string) =>
    tree.root.findAllByType(Text).find(n => [n.props.children].flat().some(c => typeof c === 'string' && c.includes(part)))!
  const keyLine = lineOf(key)
  // The run sits in its own span inside the line that holds the label.
  const outer = tree.root.findAllByType(Text).find(n => n.props.numberOfLines === 1 && n.findAllByType(Text).includes(keyLine))
  expect(outer?.props.ellipsizeMode).toBe('middle')
  expect(StyleSheet.flatten(keyLine.props.style).fontFamily).toBe(font.mono)
  expect(lineOf('ref-7').props.numberOfLines).toBeUndefined()
  expect(lineOf(i18n.t('recover.mailBody', { pubkey: '', reference: '' }).split('\n')[0]!).props.numberOfLines).toBeUndefined()
  // Copy and the reader below still take the whole text.
  expect(carriedTexts(tree)).toEqual([text])
})

// A line can hold more than one reference with words between them, as the deletion mail's list does,
// and only the references take the monospace face.
test('only the keys of a line take the monospace face', async () => {
  const one = `ref-${'1a'.repeat(12)}`
  const two = `ref-${'2b'.repeat(12)}`
  const text = `${one}, ${two} sent`
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(<SupportMailCard note={{ mail: 'refused', text }} />)
  })
  const spans = tree.root.findAllByType(Text).filter(n => typeof n.props.children === 'string')
  const mono = spans.filter(n => StyleSheet.flatten(n.props.style)?.fontFamily === font.mono)
  expect(mono.map(n => n.props.children)).toEqual([one, two])
  expect(carriedTexts(tree)).toEqual([text])
})
