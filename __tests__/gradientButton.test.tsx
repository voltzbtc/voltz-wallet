import React from 'react'
import { AccessibilityInfo, StyleSheet, Text } from 'react-native'
import ReactTestRenderer from 'react-test-renderer'
import LinearGradient from 'react-native-linear-gradient'
import { GradientButton } from '../src/components/GradientButton'
import { Ring } from '../src/components/Ring'
import { alpha, colors, gradients, press } from '../src/theme'

// Every filled CTA is this button, so the accent reaching it is what carries wallet mode past Home.
let mockDollarMode = false
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return {
    useAccent: () =>
      mockDollarMode
        ? { accent: theme.colors.dollar, gradient: theme.gradients.dollar }
        : { accent: theme.colors.primary, gradient: theme.gradients.primary },
  }
})

function render(props: Partial<React.ComponentProps<typeof GradientButton>> = {}) {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(<GradientButton label="Pay" onPress={() => undefined} {...props} />)
  })
  return tree
}

function gradientColors(tree: ReactTestRenderer.ReactTestRenderer): string[] {
  return tree.root.findByType(LinearGradient).props.colors as string[]
}

// Pressable renders as an inner View on RN 0.86, so the button is located by its declared role.
function pressableOf(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
}

// The native view the Pressable draws, which carries what the platform sees: style, touch and a11y.
function hostOf(tree: ReactTestRenderer.ReactTestRenderer): ReactTestRenderer.ReactTestInstance {
  return tree.root.find(n => typeof n.type === 'string' && n.props.accessibilityRole === 'button')
}

function styleOf(tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> {
  return StyleSheet.flatten(hostOf(tree).props.style) as Record<string, unknown>
}

// Pressable makes its view focusable by default, so in sight means that default is left alone.
function expectInSight(host: ReactTestRenderer.ReactTestInstance): void {
  expect(host.props.pointerEvents).toBeUndefined()
  expect(host.props.focusable).not.toBe(false)
  expect(host.props.accessibilityElementsHidden).toBeUndefined()
  expect(host.props.importantForAccessibility).toBeUndefined()
}

beforeEach(() => {
  mockDollarMode = false
})

test('the filled CTA carries the bitcoin gradient by default', () => {
  expect(gradientColors(render())).toEqual([...gradients.primary])
})

test('the filled CTA turns green with the dollar wallet, without each screen passing it', () => {
  mockDollarMode = true
  expect(gradientColors(render())).toEqual([...gradients.dollar])
})

test('an explicitly passed gradient still wins over the mode', () => {
  mockDollarMode = true
  const pinned: readonly [string, string] = ['#111111', '#222222']
  expect(gradientColors(render({ gradient: pinned }))).toEqual([...pinned])
})

test('a disabled button reports it to assistive tech and refuses the press', () => {
  const onPress = jest.fn()
  const tree = render({ disabled: true, onPress })
  const pressable = pressableOf(tree)

  expect(pressable.props.accessibilityState).toMatchObject({ disabled: true })
  expect(pressable.props.disabled).toBe(true)
  expect(onPress).not.toHaveBeenCalled()
})

test('a loading button blocks the press while the action is in flight', () => {
  const onPress = jest.fn()
  const tree = render({ loading: true, onPress })
  const pressable = pressableOf(tree)

  expect(pressable.props.disabled).toBe(true)
  expect(pressable.props.accessibilityState).toMatchObject({ busy: true })
})

test('the secondary variant paints no gradient at all', () => {
  const tree = render({ variant: 'secondary' })
  expect(tree.root.findAllByType(LinearGradient)).toHaveLength(0)
})

test('a filled button that cannot act yet is unseen, untouchable and unannounced', () => {
  const host = hostOf(render({ disabled: true }))

  expect(StyleSheet.flatten(host.props.style).opacity).toBe(0)
  expect(alpha.concealed).toBe(0)
  expect(host.props.pointerEvents).toBe('none')
  expect(host.props.focusable).toBe(false)
  expect(host.props.accessibilityElementsHidden).toBe(true)
  expect(host.props.importantForAccessibility).toBe('no-hide-descendants')
})

test('the unseen button keeps the same box and content, so nothing moves when it turns on', () => {
  const hidden = render({ disabled: true })
  const shown = render()
  const { opacity, ...hiddenBox } = styleOf(hidden)

  expect(opacity).toBe(0)
  expect(hiddenBox).toEqual(styleOf(shown))
  expect(hidden.root.findByType(Text).props.children).toBe('Pay')
  expect(hidden.root.findAllByType(LinearGradient)).toHaveLength(1)
})

test('an enabled button carries none of the concealment and no dimming', () => {
  const host = hostOf(render())

  expectInSight(host)
  expect(StyleSheet.flatten(host.props.style).opacity).toBeUndefined()
})

// A faded spinner reads as a stuck one, so a button at work draws at full strength whatever its
// caller says about disabled.
test('loading wins over disabled, so the spinner shows at full strength', () => {
  const tree = render({ disabled: true, loading: true })
  const host = hostOf(tree)

  expectInSight(host)
  expect(StyleSheet.flatten(host.props.style).opacity).toBeUndefined()
  expect(pressableOf(tree).props.disabled).toBe(true)
  const spinners = tree.root.findAllByType(Ring).filter(n => n.props.color === colors.onPrimary)
  expect(spinners).toHaveLength(1)
})

test('a loading button that is not disabled draws at full strength', () => {
  const host = hostOf(render({ loading: true }))

  expectInSight(host)
  expect(StyleSheet.flatten(host.props.style).opacity).toBeUndefined()
})

test('the secondary variant keeps its dimmed disabled look and stays in sight', () => {
  const host = hostOf(render({ variant: 'secondary', disabled: true }))

  expectInSight(host)
  expect(StyleSheet.flatten(host.props.style).opacity).toBe(alpha.disabled)
})

test('the secondary variant also draws at full strength while it loads, even when disabled', () => {
  const host = hostOf(render({ variant: 'secondary', disabled: true, loading: true }))

  expectInSight(host)
  expect(StyleSheet.flatten(host.props.style).opacity).toBeUndefined()
})

// Too narrow to wrap between words, Home's half-width actions broke the word itself ("Envi / ar") at
// the largest text size. A single-line button shrinks its label instead.
test('a single-line button keeps its label on one line that shrinks to fit', () => {
  const label = render({ label: 'Receber', singleLine: true }).root.findByType(Text)
  expect([label.props.numberOfLines, label.props.adjustsFontSizeToFit]).toEqual([1, true])
  const wrapping = render({ label: 'Receber' }).root.findByType(Text)
  expect(wrapping.props.numberOfLines).toBeUndefined()
})

// Sized to its content under the body's centring, the row holding the icon and the label ran past a
// half-width button at a large text size, so the label kept its full width and was cut instead of
// shrinking. The row is capped at the button, and the label gives way inside it.
test("the icon and label row never runs past the button's width", () => {
  const tree = render({ label: 'Empfangen', singleLine: true, icon: <></> })
  const label = tree.root.findByType(Text)
  let row = label.parent
  while (row && typeof row.type !== 'string') row = row.parent
  expect(StyleSheet.flatten(row?.props.style)).toMatchObject({ flexDirection: 'row', maxWidth: '100%' })
  expect(StyleSheet.flatten(label.props.style)).toMatchObject({ flexShrink: 1 })
})

// Wrapping, a label breaks between words and never inside one.
test('a wrapping label keeps its words whole, and a single-line one shrinks instead', () => {
  const words = (props: Partial<React.ComponentProps<typeof GradientButton>>) =>
    render(props).root.findAll(n => n.props.wholeWords !== undefined)[0]?.props.wholeWords
  expect(words({ label: 'Frase de recuperação' })).toBe(true)
  expect(words({ label: 'Receber', singleLine: true })).toBe(false)
})

describe('with reduced motion', () => {
  afterEach(() => jest.restoreAllMocks())

  async function renderWith(reduced: boolean, props: Partial<React.ComponentProps<typeof GradientButton>> = {}) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(<GradientButton label="Pay" onPress={() => undefined} {...props} />)
    })
    return tree
  }

  const pressedStyle = (tree: ReactTestRenderer.ReactTestRenderer) =>
    StyleSheet.flatten(pressableOf(tree).props.style({ pressed: true })) as Record<string, unknown>

  test('a press shrinks the button with full motion', async () => {
    const style = pressedStyle(await renderWith(false))
    expect(style.transform).toEqual([{ scale: press.scale }])
    expect(style.opacity).toBe(press.scaled)
  })

  test('a press only dims the button with reduced motion', async () => {
    const style = pressedStyle(await renderWith(true))
    expect(style.transform).toBeUndefined()
    expect(style.opacity).toBe(press.scaled)
  })

  test('the busy spinner keeps turning, since it says the action is under way', async () => {
    const tree = await renderWith(true, { loading: true })
    const spinner = tree.root.find(
      n => typeof n.type === 'string' && Array.isArray(StyleSheet.flatten(n.props.style)?.transform),
    )
    expect(StyleSheet.flatten(spinner.props.style).transform[0]).toHaveProperty('rotate')
  })
})
