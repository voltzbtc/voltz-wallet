import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Dimensions, StyleSheet, Text } from 'react-native'
import { FontScaleProvider } from '../src/components/Text'
import { figuresIn, textOf } from './support/figureFit'
import i18n from '../src/i18n'
import { formatSats } from '../src/wallet/amount'
import { font, space } from '../src/theme'

// jest.setup stubs this component out for every other suite, since its worklets do not run here.
// This one exercises it directly, so the animation libraries are replaced with inert stand-ins that
// keep the component mounting while the amount logic stays real.
jest.unmock('../src/components/ReceivedOverlay')
// How many times each animated text has been mounted, by its text.
const mockMounts = new Map<string, number>()
jest.mock('react-native-reanimated', () => {
  const react = require('react')
  const rn = require('react-native')
  const passthrough = (Component: unknown) => Component
  const CountedText = (props: { children?: unknown }) => {
    react.useEffect(() => {
      const text = String(props.children)
      mockMounts.set(text, (mockMounts.get(text) ?? 0) + 1)
    }, [])
    return react.createElement(rn.Text, props)
  }
  return {
    __esModule: true,
    default: {
      View: rn.View,
      Text: CountedText,
      createAnimatedComponent: passthrough,
    },
    Easing: { out: () => undefined, ease: undefined, back: () => undefined },
    ReduceMotion: { Never: 'never' },
    cancelAnimation: () => undefined,
    useAnimatedProps: () => ({}),
    useAnimatedStyle: () => ({}),
    useSharedValue: (v: unknown) => ({ value: v }),
    withDelay: (_d: number, v: unknown) => v,
    withSequence: (v: unknown) => v,
    withTiming: (v: unknown) => v,
    createAnimatedComponent: passthrough,
    react,
  }
})
jest.mock('react-native-svg', () => {
  const rn = require('react-native')
  return { __esModule: true, default: rn.View, Svg: rn.View, G: rn.View, Path: rn.View, Circle: rn.View }
})
jest.mock('../src/wallet/dollarMode', () => {
  const theme = require('../src/theme')
  return { useAccent: () => ({ accent: theme.colors.primary, gradient: theme.gradients.primary }) }
})

const { ReceivedOverlay } = require('../src/components/ReceivedOverlay')

function shownAmount(tree: ReactTestRenderer.ReactTestRenderer): string {
  return tree.root
    .findAllByType(Text)
    .flatMap(node => {
      const children = node.props.children
      return (Array.isArray(children) ? children : [children]).filter(
        (child: unknown): child is string => typeof child === 'string',
      )
    })
    .join(' ')
}

async function render(amountSat: number): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(
      <ReceivedOverlay
        visible
        amount={{ value: amountSat, unit: 'sats', format: formatSats }}
        onDone={() => undefined}
      />,
    )
  })
  return tree
}

beforeEach(() => {
  jest.useFakeTimers()
  // The count-up runs on requestAnimationFrame, which is exactly what stalls while the app sits in
  // the background. Silencing it here reproduces that state.
  jest.spyOn(global, 'requestAnimationFrame').mockImplementation(() => 0 as unknown as number)
})

afterEach(() => {
  jest.useRealTimers()
  jest.restoreAllMocks()
})

test('the amount settles even when the animation frames never run', async () => {
  // rAF is frozen in the background and the ramp never advances, so a hero that waits on it keeps
  // the starting value and shows a 3-sat reward as "0".
  const tree = await render(3)

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1480 + 800 + 50)
  })

  expect(shownAmount(tree)).toContain('3')
})

test('a large amount settles on its exact value, not a rounded step', async () => {
  const tree = await render(61_076)

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(1480 + 800 + 50)
  })

  expect(shownAmount(tree).replace(/\s/g, '')).toContain(formatSats(61_076).replace(/\s/g, ''))
})

test('the overlay closes itself after the hold, so it never traps the screen', async () => {
  const onDone = jest.fn()
  await ReactTestRenderer.act(async () => {
    ReactTestRenderer.create(
      <ReceivedOverlay
        visible
        amount={{ value: 10, unit: 'sats', format: formatSats }}
        onDone={onDone}
      />,
    )
  })

  await ReactTestRenderer.act(async () => {
    jest.advanceTimersByTime(3600 + 50)
  })

  expect(onDone).toHaveBeenCalled()
})

describe('the figure, its unit and its formatter, which arrive together', () => {
  // One prop rather than three side by side. With the number, a unit defaulting to "sats" and a
  // formatter defaulting to whole numbers as separate props, a caller with a token amount that
  // fills in only the first reads as correct at the call site.
  async function drawn(
    amount: React.ComponentProps<typeof ReceivedOverlay>['amount'],
  ): Promise<string> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay visible amount={amount} onDone={() => undefined} />,
      )
    })
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1480 + 800 + 50)
    })
    return shownAmount(tree)
  }

  test('keeps the decimals of a token amount', async () => {
    // Whole-number rounding draws 0.25 USDB as "0 USDB" and 10.5 as "11". The formatter is the
    // caller's, and required, so the rounding cannot come back by omission.
    const text = await drawn({ value: 0.25, unit: 'USDB', format: (n: number) => n.toFixed(2) })
    expect(text).toContain('0.25')
    expect(text).toContain('USDB')
  })

  test('says the unit it was given and never assumes sats', async () => {
    const text = await drawn({ value: 10, unit: 'USDB', format: (n: number) => n.toFixed(2) })
    expect(text).toContain('USDB')
    expect(text).not.toContain('sats')
  })
})

test('the counting figure is drawn in tabular digits, so it does not slide sideways as it counts', async () => {
  const tree = await render(21_000)
  const flat = (style: unknown): Record<string, unknown> =>
    Object.assign({}, ...[style].flat(Infinity).filter(x => x && typeof x === 'object'))
  const figure = tree.root
    .findAllByType(Text)
    .find(node => flat(node.props.style).fontSize === font.size.display)!
  expect(flat(figure.props.style).fontVariant).toEqual(['tabular-nums'])
})

// The figure counts up from zero, so a screen reader reading it would hear a number on its way.
describe('for a screen reader', () => {
  test('announces the amount that arrived as the overlay shows', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
    await render(21_000)
    expect(announce).toHaveBeenCalledWith(`Received, ${formatSats(21_000)} sats`)
  })

  test('a figure with no unit is spoken without a gap before the next line', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
    const beneath = i18n.t('notice.unknownToken')
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <ReceivedOverlay
          visible
          amount={{ value: 10, unit: '', format: (n: number) => String(n) }}
          beneath={beneath}
          onDone={() => undefined}
        />,
      )
    })
    expect(announce).toHaveBeenCalledWith(`Received, 10, ${beneath}`)
  })

  test('labels the press that closes it with the same amount', async () => {
    const tree = await render(21_000)
    const target = tree.root.find(n => n.props.accessibilityRole === 'button' && typeof n.props.onPress === 'function')
    expect(target.props.accessibilityLabel).toBe(`Received, ${formatSats(21_000)} sats`)
  })
})

test('keeps the figure on one line inside the screen margin, shrinking to fit', async () => {
  const tree = await render(2_100_000_000)
  const figure = tree.root.findAll(n => n.type === Text && n.props.adjustsFontSizeToFit === true)
  expect(figure).toHaveLength(1)
  expect(figure[0]!.props.numberOfLines).toBe(1)
  expect(StyleSheet.flatten(figure[0]!.props.style).paddingHorizontal).toBe(space.xl)
})

// The count-up is a money figure, drawn by the figure primitive in the animated box that moves it, and
// the animated texts are mounted again at a new text size like the app's Text, which they are not.
describe('at a large text size', () => {
  const start = Dimensions.get('window')
  const setScale = (fontScale: number) => {
    const window = { ...start, fontScale }
    ReactTestRenderer.act(() => Dimensions.set({ window, screen: window }))
  }
  afterEach(() => setScale(start.fontScale))

  it('draws the count and the lines under it as figures', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay
          visible
          amount={{ value: 21_000, unit: 'sats', format: formatSats }}
          feeLabel="Fee 12 sats"
          fiat="$14.00"
          onDone={() => undefined}
        />,
      )
    })
    const drawn = figuresIn(tree.root).map(textOf)
    expect(drawn).toHaveLength(3)
    expect(drawn[1]).toBe('Fee 12 sats')
  })

  it('mounts the title and the comment again when the text size changes', async () => {
    mockMounts.clear()
    await ReactTestRenderer.act(async () => {
      ReactTestRenderer.create(
        <FontScaleProvider>
          <ReceivedOverlay
            visible
            amount={{ value: 21_000, unit: 'sats', format: formatSats }}
            label="Received"
            zap={{ comment: 'thanks' }}
            onDone={() => undefined}
          />
        </FontScaleProvider>,
      )
    })
    expect([mockMounts.get('Received'), mockMounts.get('thanks')]).toEqual([1, 1])
    setScale(3.12)
    expect([mockMounts.get('Received'), mockMounts.get('thanks')]).toEqual([2, 2])
  })
})

describe('words from the other side', () => {
  const amount = { value: 1000, unit: 'sats', format: formatSats }

  test('show under the figure, untouched and capped', async () => {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay visible amount={amount} label="Sent" note="Thanks for the coffee" onDone={() => undefined} />,
      )
    })
    const shown = tree.root.findAll(n => n.props.numberOfLines === 3 && n.props.children === 'Thanks for the coffee')
    expect(shown.length).toBeGreaterThan(0)
    await ReactTestRenderer.act(async () => tree.unmount())
  })

  test('hold the overlay long enough to read them', async () => {
    jest.useFakeTimers()
    const done = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay visible amount={amount} label="Sent" note="Thanks" onDone={done} />,
      )
    })
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(6_999)
    })
    expect(done).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1)
    })
    expect(done).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => tree.unmount())
    jest.useRealTimers()
  })
})

// A payment with no end yet is drawn apart from one that completed, by the mark and by the line that
// says how its end will be told.
describe('a payment still pending', () => {
  const amount = { value: 1000, unit: 'sats', format: formatSats }
  const told = 'The app will let you know when it finishes.'
  // Whether each is drawn. A component and the host view under it both carry the props, so counts
  // would say two for one mark.
  const marks = (tree: ReactTestRenderer.ReactTestRenderer) => ({
    check: tree.root.findAll(n => n.props.testID === 'overlay-check').length > 0,
    pending: tree.root.findAll(n => n.props.testID === 'overlay-pending').length > 0,
    checkPath: tree.root.findAll(n => n.props.d === 'M14 27 L23 36 L39 17').length > 0,
  })

  async function show(pending?: string): Promise<ReactTestRenderer.ReactTestRenderer> {
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay visible amount={amount} label="On the way" pending={pending} onDone={() => undefined} />,
      )
    })
    return tree
  }

  test('shows the clock and its line, and no check is drawn', async () => {
    const tree = await show(told)

    expect(marks(tree)).toEqual({ check: false, pending: true, checkPath: false })
    expect(tree.root.findAllByType(Text).some(n => n.props.children === told)).toBe(true)
    await ReactTestRenderer.act(async () => tree.unmount())
  })

  test('a completed payment keeps the check and no line', async () => {
    const tree = await show(undefined)

    expect(marks(tree)).toEqual({ check: true, pending: false, checkPath: true })
    expect(tree.root.findAllByType(Text).some(n => n.props.children === told)).toBe(false)
    await ReactTestRenderer.act(async () => tree.unmount())
  })

  test('the line is spoken with the figure', async () => {
    const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility')
    const tree = await show(told)

    expect(announce).toHaveBeenCalledWith(expect.stringContaining(told))
    await ReactTestRenderer.act(async () => tree.unmount())
  })

  test('the overlay stays up long enough to read the line', async () => {
    const done = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(
        <ReceivedOverlay visible amount={amount} label="On the way" pending={told} onDone={done} />,
      )
    })
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(6_999)
    })
    expect(done).not.toHaveBeenCalled()
    await ReactTestRenderer.act(async () => {
      jest.advanceTimersByTime(1)
    })
    expect(done).toHaveBeenCalledTimes(1)
    await ReactTestRenderer.act(async () => tree.unmount())
  })
})
