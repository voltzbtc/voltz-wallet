import React from 'react'
import ReactTestRenderer, { type ReactTestInstance } from 'react-test-renderer'
import { Text } from 'react-native'
import i18n from '../src/i18n'
import { DiceScreen } from '../src/screens/DiceScreen'
import { validateMnemonic } from '../src/wallet/seed'
import { colors } from '../src/theme'

function collectText(node: ReactTestInstance): string {
  return node
    .findAll(n => typeof n.children[0] === 'string', { deep: true })
    .map(n => n.children.filter(c => typeof c === 'string').join(''))
    .join(' ')
}

function pressByText(tree: ReactTestRenderer.ReactTestRenderer, label: string) {
  const target = tree.root
    .findAll(n => typeof n.props.onPress === 'function' && collectText(n).includes(label))
    // The innermost match is the button itself rather than a wrapper containing the same text.
    .pop()
  if (!target) {
    throw new Error(`no pressable containing "${label}"`)
  }
  ReactTestRenderer.act(() => {
    target.props.onPress()
  })
}

// The face keys render dice pips (dots), not digits, so they carry the number on accessibilityLabel.
function pressFace(tree: ReactTestRenderer.ReactTestRenderer, face: string) {
  const target = tree.root.find(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === face,
  )
  ReactTestRenderer.act(() => {
    target.props.onPress()
  })
}

describe('DiceScreen', () => {
  test('is gated until the roll floor, then generates a valid seed from the rolls', () => {
    let generated: { mnemonic: string; length: number } | null = null
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <DiceScreen
          onGenerated={(mnemonic, length) => (generated = { mnemonic, length })}
          onBack={() => {}}
        />,
      )
    })

    for (let i = 0; i < 49; i++) {
      pressFace(tree, String((i % 6) + 1))
    }
    pressByText(tree, 'Generate wallet')
    expect(generated).toBeNull()

    pressFace(tree, '1')
    pressByText(tree, 'Generate wallet')

    expect(generated).not.toBeNull()
    const result = generated as unknown as { mnemonic: string; length: number }
    expect(result.length).toBe(12)
    expect(validateMnemonic(result.mnemonic)).toBe(true)
    expect(result.mnemonic.split(' ')).toHaveLength(12)
  })

  test('all-identical rolls are blocked by the entropy gate with a friendly hint, never a redbox', () => {
    let generated: { mnemonic: string; length: number } | null = null
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <DiceScreen
          onGenerated={(mnemonic, length) => (generated = { mnemonic, length })}
          onBack={() => {}}
        />,
      )
    })

    // Fifty identical rolls clear the count floor while carrying no entropy at all.
    for (let i = 0; i < 50; i++) {
      pressFace(tree, '1')
    }
    pressByText(tree, 'Generate wallet')

    expect(generated).toBeNull()
    expect(collectText(tree.root)).toContain('skewed') // the bias hint (dice.lowEntropy), no redbox
  })
})

describe('the roll counter', () => {
  // The count reads against its floor ("49 of 50 rolls"), and the colour is the second signal: muted
  // while there is still work to do, full strength once the floor is reached.
  const counter = (tree: ReactTestRenderer.ReactTestRenderer, count: number) =>
    tree.root
      .findAllByType(Text)
      .map(n => ({ text: String(n.props.children), style: flatten(n.props.style) }))
      .find(n => n.text === i18n.t('dice.progress', { count, min: 50 }))!

  const flatten = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

  function rolled(times: number): ReactTestRenderer.ReactTestRenderer {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<DiceScreen onGenerated={() => {}} onBack={() => {}} />)
    })
    for (let i = 0; i < times; i++) {
      pressFace(tree, String((i % 6) + 1))
    }
    return tree
  }

  test('is muted while there are rolls still to make', () => {
    expect(counter(rolled(49), 49).style.color).toBe(colors.textSecondary)
  })

  test('comes up to full strength once the floor is reached', () => {
    expect(counter(rolled(50), 50).style.color).toBe(colors.text)
  })

  test('names the floor it counts toward, which a 24-word phrase raises', () => {
    const shown = (tree: ReactTestRenderer.ReactTestRenderer) =>
      tree.root.findAllByType(Text).map(n => String(n.props.children))
    const tree = rolled(3)
    expect(shown(tree)).toContain('3 of 50 rolls')
    const segment = tree.root.find(n => typeof n.props.onChange === 'function' && n.props.value === 12)
    ReactTestRenderer.act(() => {
      segment.props.onChange(24)
    })
    expect(shown(tree)).toContain('3 of 100 rolls')
  })
})

test('a key answers the touch, since the only other sign is a number moving', () => {
  // Fifty to ninety-nine taps in a row. With the counter as the sole feedback, a tap that did not
  // register looks exactly like one that did.
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<DiceScreen onGenerated={() => {}} onBack={() => {}} />)
  })
  const key = tree.root.find(
    n => typeof n.props.onPress === 'function' && n.props.accessibilityLabel === '4',
  )
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))
  const resting = flat(key.props.style({ pressed: false }))
  const held = flat(key.props.style({ pressed: true }))
  expect(held).not.toEqual(resting)
  expect(held.opacity).toBeLessThan(1)
})

test('writes the faces and counts of the statistics in the digits of the language on screen', async () => {
  await i18n.changeLanguage('ar-EG')
  try {
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(<DiceScreen onGenerated={() => {}} onBack={() => {}} />)
    })
    for (let i = 0; i < 12; i++) {
      pressFace(tree, '6')
    }
    pressByText(tree, i18n.t('dice.stats'))
    const shown = tree.root.findAllByType(Text).map(n => n.props.children)
    // Face six, rolled twelve times.
    expect(shown).toContain('٦')
    expect(shown).toContain('١٢')
    expect(shown).not.toContain(12)
  } finally {
    await ReactTestRenderer.act(async () => {
      await i18n.changeLanguage('en-US')
    })
  }
})

test('Clear and backspace leave sight and screen readers while there is nothing to edit', () => {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<DiceScreen onGenerated={() => {}} onBack={() => {}} />)
  })
  const flatten = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))
  // Each edit control with the nearest wrapper that decides whether a screen reader reaches it.
  const edits = () =>
    [i18n.t('backup.clear'), i18n.t('common.backspace')].map(label => {
      const control = tree.root
        .findAll(n => typeof n.props.onPress === 'function' && typeof n.props.style === 'function')
        .find(n => n.props.accessibilityLabel === label || collectText(n) === label)!
      let wrapper = control.parent
      while (wrapper && wrapper.props.importantForAccessibility === undefined) {
        wrapper = wrapper.parent
      }
      return {
        opacity: flatten(control.props.style({ pressed: false })).opacity,
        reader: wrapper?.props.importantForAccessibility,
        hidden: wrapper?.props.accessibilityElementsHidden,
      }
    })

  expect(edits()).toEqual([
    { opacity: 0, reader: 'no-hide-descendants', hidden: true },
    { opacity: 0, reader: 'no-hide-descendants', hidden: true },
  ])
  pressFace(tree, '2')
  for (const edit of edits()) {
    expect(edit.opacity).not.toBe(0)
    expect(edit.reader).toBe('auto')
    expect(edit.hidden).toBe(false)
  }
})
