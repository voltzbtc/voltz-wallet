import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Dimensions, Text, TextInput, View } from 'react-native'
import { Field } from '../src/components/Field'
import { FontScaleProvider } from '../src/components/Text'
import { colors, font, space, touch } from '../src/theme'

// Answers both ways, so the accent case cannot pass against a field that never asked.
let mockAccent = '#ff7a00'
jest.mock('../src/wallet/dollarMode', () => ({ useAccent: () => ({ accent: mockAccent }) }))

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

// The box around the input is the second View, since the first is the group holding label and hint.
const box = (tree: ReactTestRenderer.ReactTestRenderer) =>
  flat(
    tree.root
      .findAllByType(View)
      .map(n => flat(n.props.style))
      .find(s => s.borderRadius != null),
  )

const input = (tree: ReactTestRenderer.ReactTestRenderer) => tree.root.findByType(TextInput)

const words = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.findAllByType(Text).map(n => String(n.props.children))

beforeEach(() => {
  mockAccent = colors.primary
})

const field = (props: Partial<React.ComponentProps<typeof Field>> = {}) =>
  render(<Field value="" onChangeText={() => undefined} {...props} />)

it('is a text input', () => {
  expect(field().root.findAllByType(TextInput)).toHaveLength(1)
})

it('reports what was typed', () => {
  const typed: string[] = []
  const tree = field({ onChangeText: t => typed.push(t) })
  ReactTestRenderer.act(() => input(tree).props.onChangeText('abc'))
  expect(typed).toEqual(['abc'])
})

it('is as tall and as padded as a picker row, by declaring it rather than by adding padding', () => {
  // A hand-written `paddingVertical: 14` reaches a height only through the line height it pads, and
  // stops holding the moment the device scales type, so the height is declared instead.
  const style = box(field())
  expect(style.minHeight).toBe(touch.selector)
  expect(style.paddingHorizontal).toBe(space.lg)
  expect(style.paddingVertical).toBeUndefined()
})

it('is a fill with no outline, in every state', () => {
  const style = box(field())
  expect(style.backgroundColor).toBe(colors.surfaceVariant)
  expect(style.borderCurve).toBe('continuous')
  const focused = field()
  ReactTestRenderer.act(() => input(focused).props.onFocus({}))
  for (const state of [style, box(focused), box(field({ error: 'Too long' })), box(field({ invalid: true }))]) {
    expect(state.borderWidth).toBeUndefined()
    expect(state.borderColor).toBeUndefined()
  }
})

describe('focus', () => {
  it('steps the fill while focused', () => {
    // A field that looks identical with and without the keyboard is a field somebody taps twice.
    const tree = field()
    expect(box(tree).backgroundColor).toBe(colors.surfaceVariant)
    ReactTestRenderer.act(() => input(tree).props.onFocus({}))
    expect(box(tree).backgroundColor).toBe(colors.surfaceRaised)
  })

  it('steps it back on blur', () => {
    const tree = field()
    ReactTestRenderer.act(() => input(tree).props.onFocus({}))
    ReactTestRenderer.act(() => input(tree).props.onBlur({}))
    expect(box(tree).backgroundColor).toBe(colors.surfaceVariant)
  })

  it('keeps the danger fill while an error is focused', () => {
    const tree = field({ error: 'Too long' })
    ReactTestRenderer.act(() => input(tree).props.onFocus({}))
    expect(box(tree).backgroundColor).toBe(colors.dangerSoft)
  })

  it('still calls a handler the caller passed, rather than swallowing it', () => {
    // The component's own handlers are attached after the spread, so a caller adding one cannot
    // silently take the focus step with it, and cannot be silently dropped either.
    const seen: string[] = []
    const tree = field({ onFocus: () => seen.push('focus'), onBlur: () => seen.push('blur') })
    ReactTestRenderer.act(() => input(tree).props.onFocus({}))
    ReactTestRenderer.act(() => input(tree).props.onBlur({}))
    expect(seen).toEqual(['focus', 'blur'])
    expect(box(tree).backgroundColor).toBe(colors.surfaceVariant)
  })
})

describe('what it says around the input', () => {
  it('says nothing when given nothing', () => {
    expect(words(field())).toEqual([])
  })

  it('shows a label above and a hint below', () => {
    expect(words(field({ label: 'Name', hint: 'Up to 40 characters' }))).toEqual([
      'Name',
      'Up to 40 characters',
    ])
  })

  it('replaces the hint with the error rather than stacking them', () => {
    // Two lines under one field, one saying what to do and one saying what went wrong, is where a
    // person stops reading either.
    expect(words(field({ hint: 'Up to 40', error: 'Too long' }))).toEqual(['Too long'])
  })

  it('reads an error out as it appears and as it changes, never a hint or an empty one', () => {
    const heard = jest
      .spyOn(AccessibilityInfo, 'announceForAccessibility')
      .mockImplementation(() => undefined)
    heard.mockClear()
    const tree = field({ hint: 'Up to 40' })
    const show = (error: string) =>
      ReactTestRenderer.act(() => {
        tree.update(<Field value="" onChangeText={() => undefined} hint="Up to 40" error={error} />)
      })
    show('')
    expect(heard).not.toHaveBeenCalled()

    show('Too long')
    show('Too long')
    show('Not a name')
    expect(heard.mock.calls).toEqual([['Too long'], ['Not a name']])
    heard.mockRestore()
  })

  it('fills the box as wrong when there is an error, so the message has something to point at', () => {
    expect(box(field({ error: 'Too long' })).backgroundColor).toBe(colors.dangerSoft)
  })

  it('takes the same fill with no line under it for a cell whose message sits elsewhere', () => {
    const tree = field({ invalid: true, hint: 'Word' })
    expect(box(tree).backgroundColor).toBe(colors.dangerSoft)
    expect(words(tree)).toEqual(['Word'])
  })

  it('puts leading content inside the box, ahead of the input', () => {
    expect(words(field({ leading: <Text>7</Text> }))).toEqual(['7'])
  })

  it('puts trailing content inside the box, not beside it', () => {
    // A domain suffix or a unit sits inside the box, laid out in a row with the input.
    const tree = field({ trailing: <Text>@voltz.app</Text> })
    expect(words(tree)).toContain('@voltz.app')
    expect(box(tree).flexDirection).toBe('row')
  })
})

it('passes the rest of the TextInput props through', () => {
  const tree = field({ maxLength: 40, autoCapitalize: 'none', placeholder: 'Name' })
  expect(input(tree).props.maxLength).toBe(40)
  expect(input(tree).props.autoCapitalize).toBe('none')
  expect(input(tree).props.placeholder).toBe('Name')
})

it('spaces the group with the app scale rather than a number', () => {
  const group = flat(
    render(<Field value="" onChangeText={() => undefined} label="x" />).root.findAllByType(View)[0]!
      .props.style,
  )
  expect(group.gap).toBe(space.sm)
})

describe('the input itself', () => {
  // The style of the element a person types into, which no assertion on the box, the words around
  // it or the handlers reaches.
  const typed = (tree: ReactTestRenderer.ReactTestRenderer) => flat(input(tree).props.style)

  it('draws the typed text in the app colour and size', () => {
    // Without these the text falls back to React Native's default, which is dark and smaller, on a
    // dark surface. A field where nobody can read what they typed.
    expect(typed(field()).color).toBe(colors.text)
    expect(typed(field()).fontSize).toBe(font.size.base)
  })

  it('takes the room left over, so trailing content does not crowd it', () => {
    // Without this the input shrinks to its content and whatever sits beside it moves against it.
    expect(typed(field()).flex).toBe(1)
  })

  it('carries no vertical padding of its own, so the two platforms agree on height', () => {
    // Android's TextInput is a native EditText and reserves vertical space by itself, which makes the
    // same field visibly taller there than on iOS unless this is zeroed.
    expect(typed(field()).paddingVertical).toBe(0)
  })

  it('draws the placeholder in the muted colour', () => {
    expect(input(field()).props.placeholderTextColor).toBe(colors.textSecondary)
  })
})

describe('order and ownership', () => {
  it('puts trailing content after the input, not before it', () => {
    // Rendered first, a domain suffix or a unit appears on the wrong side of what is being typed.
    const tree = field({ trailing: <Text>@voltz.app</Text> })
    const children = tree.root
      .findAllByType(View)
      .find(n => flat(n.props.style).borderRadius != null)!
      .props.children.filter(Boolean)
    expect(children).toHaveLength(2)
    expect(children[1].props.children).toBe('@voltz.app')
  })

  it('dresses the whole group, not just the box', () => {
    // Callers pass margins and widths through this prop. Applied to the box instead, the label and
    // the hint fall outside whatever the caller is arranging.
    const tree = field({ label: 'x', style: { marginTop: 9 } })
    expect(flat(tree.root.findAllByType(View)[0]!.props.style).marginTop).toBe(9)
    expect(box(tree).marginTop).toBeUndefined()
  })
})

describe('the accent and the empty error', () => {
  it('draws the caret in the wallet accent, whatever a caller passes', () => {
    // Fixed orange would make it the single thing flashing while the whole of the rest turns green
    // for the dollar wallet, and the system default is a colour the app never chose.
    mockAccent = colors.dollar
    const props = input(field({ selectionColor: 'teal', cursorColor: 'teal' })).props
    expect(props.selectionColor).toBe(colors.dollar)
    expect(props.cursorColor).toBe(colors.dollar)
  })

  // A recycled input that turns multiline gets a new native view under an unchanged prop, so its tint
  // is lost unless the prop changes after the mount: the Send field drew the system's blue caret.
  it('sets the tint of a multiline field when focus brings the caret', () => {
    mockAccent = colors.dollar
    const tree = field({ multiline: true })
    expect(input(tree).props.selectionColor).toBeUndefined()

    ReactTestRenderer.act(() => input(tree).props.onFocus({}))
    expect(input(tree).props.selectionColor).toBe(colors.dollar)
    expect(input(tree).props.cursorColor).toBe(colors.dollar)
  })

  it('opens a dark keyboard, whatever a caller passes and however the system is set', () => {
    expect(input(field({ keyboardAppearance: 'light' })).props.keyboardAppearance).toBe('dark')
    expect(input(field({ multiline: true })).props.keyboardAppearance).toBe('dark')
  })

  it('treats an empty error as no error', () => {
    // Testing `error != null` would let `setError('')` keep the box red for good, draw a blank line
    // under it, and displace the hint while doing so.
    const tree = field({ hint: 'up to 40', error: '' })
    expect(box(tree).backgroundColor).toBe(colors.surfaceVariant)
    expect(words(tree)).toEqual(['up to 40'])
  })
})

// At the largest text sizes a trailing domain is as wide as the box, and an input that takes only
// what is left draws the typed name with no width. The input keeps room for a few characters at the
// size it draws, and the trailing piece wraps under it instead.
describe('the room the input keeps beside a trailing piece', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...Dimensions.get('window'), fontScale }
    ReactTestRenderer.act(() => {
      Dimensions.set({ window, screen: window })
    })
  }
  afterEach(() => setScale(start.fontScale))

  it.each([1, 2, 3.12])('keeps an input floor that grows with the type, at %s', scale => {
    setScale(scale)
    const tree = render(
      <FontScaleProvider>
        <Field value="alice" onChangeText={() => undefined} trailing={<Text>@usevoltz.app</Text>} />
      </FontScaleProvider>,
    )
    expect(box(tree).flexWrap).toBe('wrap')
    // Without it the wrapping lines sit at the top of the 44pt box rather than in its middle.
    expect(box(tree).alignContent).toBe('center')
    const floor = flat(input(tree).props.style).minWidth as number
    expect(floor).toBeCloseTo(font.size.base * scale * 4)
    expect(floor).toBeGreaterThan(font.size.base * scale * 3)
  })
})

// A pasted address needs three lines, and iOS caches the native contentSize of a multiline input, so
// the height is fixed where every other box only has a floor.
describe('multiline', () => {
  it('is a top-aligned box of a fixed height', () => {
    const style = flat(input(field({ multiline: true })).props.style)
    expect(style.height).toBe(touch.multiline)
    expect(style.textAlignVertical).toBe('top')
    expect(flat(input(field()).props.style).height).toBeUndefined()
  })

  it('keeps a trailing piece at the top, and the box in one row', () => {
    const tree = field({ multiline: true, trailing: <Text>x</Text> })
    expect(box(tree).flexWrap).toBe('nowrap')
    expect(words(tree)).toEqual(['x'])
  })
})

it('hands the caller the input, for a sheet that focuses it on show', () => {
  const ref = React.createRef<never>()
  render(<Field ref={ref} value="" onChangeText={() => undefined} />)
  expect(ref.current).not.toBeNull()
})
