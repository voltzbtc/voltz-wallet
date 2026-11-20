import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { Dimensions, StyleSheet, Text as NativeText } from 'react-native'
import { FontScaleProvider, Text, TextInput, brokenWordShare } from '../src/components/Text'
import { Field } from '../src/components/Field'
import { Txt } from '../src/components/Txt'

// A text measured at one system text size and kept across a change to another is drawn at the new
// size inside its old box, cut until the app is reopened. The app's Text is a new text at each size,
// which is what makes the platform measure it again.

const start = Dimensions.get('window')

function setWindow(change: Partial<typeof start>): void {
  const window = { ...Dimensions.get('window'), ...change }
  ReactTestRenderer.act(() => {
    Dimensions.set({ window, screen: window })
  })
}

afterEach(() => {
  setWindow(start)
})

function mountCounter(): { ref: (node: unknown) => void; mounts: () => number } {
  let count = 0
  return {
    ref: (node: unknown) => {
      if (node) {
        count += 1
      }
    },
    mounts: () => count,
  }
}

test('a text size change mounts every text again, and nothing else does', () => {
  const plain = mountCounter()
  const role = mountCounter()
  ReactTestRenderer.act(() => {
    ReactTestRenderer.create(
      <FontScaleProvider>
        <Text ref={plain.ref}>plain</Text>
        <Txt ref={role.ref} role="display">
          R$ 76,61
        </Txt>
      </FontScaleProvider>,
    )
  })
  expect([plain.mounts(), role.mounts()]).toEqual([1, 1])

  // Rotating or resizing the window keeps the size of the type, so the texts stay as they are.
  setWindow({ width: start.width + 100 })
  expect([plain.mounts(), role.mounts()]).toEqual([1, 1])

  setWindow({ fontScale: 3.12 })
  expect([plain.mounts(), role.mounts()]).toEqual([2, 2])

  setWindow({ fontScale: 1 })
  expect([plain.mounts(), role.mounts()]).toEqual([3, 3])
})

// A field measures its text as a text does, so it is mounted again at a new size too. The value is
// the caller's state and comes back with it; the focus does not, which closes the keyboard.
test('a text size change mounts a field again with the value it held', () => {
  const field = mountCounter()
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(
      <FontScaleProvider>
        <TextInput ref={field.ref} value="bc1qtyped" onChangeText={() => undefined} />
        <Field value="note" onChangeText={() => undefined} />
      </FontScaleProvider>,
    )
  })
  const values = () => tree.root.findAll(n => typeof n.type === 'string' && n.props.value !== undefined).map(n => n.props.value)
  expect(field.mounts()).toBe(1)
  setWindow({ fontScale: 3.12 })
  expect(field.mounts()).toBe(2)
  expect(values()).toEqual(['bc1qtyped', 'note'])
})

describe('a label that keeps its words whole', () => {
  it('reads where a line break falls inside a word, and how much of the word fit', () => {
    expect(brokenWordShare('Frase de recuperação', ['Frase de ', 'recuperaç', 'ão'])).toBeCloseTo(9 / 11)
    expect(brokenWordShare('Converted', ['Conv', 'erted'])).toBeCloseTo(4 / 9)
  })

  it('reads breaks between words, after a hyphen or a slash, and a single line as whole', () => {
    expect(brokenWordShare('Frase de recuperação', ['Frase de ', 'recuperação'])).toBeNull()
    expect(brokenWordShare('e-mail address', ['e-', 'mail address'])).toBeNull()
    expect(brokenWordShare('on/off', ['on/', 'off'])).toBeNull()
    expect(brokenWordShare('Converted', ['Converted'])).toBeNull()
  })

  it('does not read lines that do not add up to the text', () => {
    expect(brokenWordShare('Frase de recuperação', ['Frase de', 'recuperação'])).toBeNull()
  })

  function laidOut(tree: ReactTestRenderer.ReactTestRenderer, lines: string[]): void {
    const host = tree.root.findByType(NativeText)
    ReactTestRenderer.act(() => {
      host.props.onTextLayout({ nativeEvent: { lines: lines.map(text => ({ text })) } })
    })
  }
  // The size the label draws at, after the system text size, which React Native applies on top.
  const size = (tree: ReactTestRenderer.ReactTestRenderer): number =>
    StyleSheet.flatten(tree.root.findByType(NativeText).props.style).fontSize
  const cap = (tree: ReactTestRenderer.ReactTestRenderer): unknown =>
    tree.root.findByType(NativeText).props.maxFontSizeMultiplier

  it('shrinks itself by its size when a word breaks, until the word fits, never below the default', () => {
    setWindow({ fontScale: 3.12 })
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <FontScaleProvider>
          <Text wholeWords style={{ fontSize: 16, lineHeight: 22 }}>
            recuperação
          </Text>
        </FontScaleProvider>,
      )
    })
    expect(size(tree)).toBe(16)
    laidOut(tree, ['recuperaç', 'ão'])
    const first = size(tree)
    expect(first).toBeLessThan(16 * (9 / 11))
    expect(first).toBeGreaterThan(16 / 3.12)
    // The line grows and shrinks with its type.
    expect(StyleSheet.flatten(tree.root.findByType(NativeText).props.style).lineHeight).toBeCloseTo((22 * first) / 16)
    // A cap alone would draw small glyphs in the box measured for large ones, since the measure cache
    // does not tell layouts apart by it, so none is set.
    expect(cap(tree)).toBeUndefined()
    // Laid out whole at the new size, it stays there.
    laidOut(tree, ['recuperação'])
    expect(size(tree)).toBe(first)
    for (let i = 0; i < 20; i += 1) {
      laidOut(tree, ['r', 'ecuperação'])
    }
    expect(size(tree)).toBeCloseTo(16 / 3.12)
  })

  it('leaves a text that wraps between words at the system size', () => {
    setWindow({ fontScale: 3.12 })
    let tree!: ReactTestRenderer.ReactTestRenderer
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <FontScaleProvider>
          <Text wholeWords style={{ fontSize: 16 }}>
            Frase de recuperação
          </Text>
        </FontScaleProvider>,
      )
    })
    laidOut(tree, ['Frase de ', 'recuperação'])
    expect(size(tree)).toBe(16)
  })

  it('starts again at the new size when the text size changes', () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    setWindow({ fontScale: 3.12 })
    ReactTestRenderer.act(() => {
      tree = ReactTestRenderer.create(
        <FontScaleProvider>
          <Text wholeWords style={{ fontSize: 16 }}>
            recuperação
          </Text>
        </FontScaleProvider>,
      )
    })
    laidOut(tree, ['recuperaç', 'ão'])
    expect(size(tree)).toBeLessThan(16)
    setWindow({ fontScale: 2 })
    expect(size(tree)).toBe(16)
  })
})
