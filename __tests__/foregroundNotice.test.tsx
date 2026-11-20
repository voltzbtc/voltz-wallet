import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, StyleSheet } from 'react-native'
import { ForegroundNotice } from '../src/components/ForegroundNotice'
import { TabIcon } from '../src/components/TabIcon'
import { Txt } from '../src/components/Txt'
import { DollarModeProvider } from '../src/wallet/dollarMode'
import { colors } from '../src/theme'

// The notice covers the navigation header for its six seconds, so it has to be put away by hand as
// well as by its timer, and the two must not both report the dismissal.

type Handlers = Record<string, (event: unknown) => unknown>

let current: ReactTestRenderer.ReactTestRenderer | null = null

function render(onPress = jest.fn(), onDismiss = jest.fn()) {
  ReactTestRenderer.act(() => {
    current = ReactTestRenderer.create(
      <ForegroundNotice title="Payment received" body="21 sats" onPress={onPress} onDismiss={onDismiss} />,
    )
  })
  const handlers = current!.root.find(
    node => typeof node.props.onMoveShouldSetResponderCapture === 'function',
  ).props as Handlers
  return { handlers, onPress, onDismiss }
}

// A touch history in the shape the responder system hands PanResponder: one finger, moving from
// `from` to `to` on the y axis between two timestamps.
function event(prevY: number, y: number, prevT: number, t: number, active = true) {
  return {
    nativeEvent: { touches: active ? [{}] : [] },
    touchHistory: {
      numberActiveTouches: active ? 1 : 0,
      indexOfSingleActiveTouch: 0,
      mostRecentTimeStamp: t,
      touchBank: [
        {
          touchActive: active,
          startPageX: 100,
          startPageY: prevY,
          startTimeStamp: prevT,
          currentPageX: 100,
          currentPageY: y,
          currentTimeStamp: t,
          previousPageX: 100,
          previousPageY: prevY,
          previousTimeStamp: prevT,
        },
      ],
    },
  }
}

// A drag of `dy` points over `ms` milliseconds, through the handlers the card's wrapper carries.
function drag(handlers: Handlers, dy: number, ms = 400): boolean {
  let claimed = false
  ReactTestRenderer.act(() => {
    handlers.onStartShouldSetResponderCapture!(event(200, 200, 1, 1))
    claimed = handlers.onMoveShouldSetResponderCapture!(event(200, 200 + dy / 2, 1, 1 + ms / 2)) as boolean
    if (claimed) {
      handlers.onResponderGrant!(event(200 + dy / 2, 200 + dy / 2, 1 + ms / 2, 1 + ms / 2))
      handlers.onResponderMove!(event(200 + dy / 2, 200 + dy, 1 + ms / 2, 1 + ms))
      handlers.onResponderRelease!(event(200 + dy, 200 + dy, 1 + ms, 2 + ms, false))
    }
  })
  return claimed
}

beforeEach(() => {
  jest.useFakeTimers()
})

afterEach(() => {
  if (current) {
    ReactTestRenderer.act(() => current!.unmount())
    current = null
  }
  jest.useRealTimers()
})

test('a swipe up dismisses it before its time, once', () => {
  const { handlers, onDismiss } = render()
  expect(drag(handlers, -80)).toBe(true)
  expect(onDismiss).toHaveBeenCalledTimes(1)

  // The timer that would have closed it finds it already closed.
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(6000)
  })
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

test('a swipe after the timer has already closed it reports nothing more', () => {
  const { handlers, onDismiss } = render()
  ReactTestRenderer.act(() => {
    jest.advanceTimersByTime(6000)
  })
  expect(onDismiss).toHaveBeenCalledTimes(1)
  drag(handlers, -80)
  expect(onDismiss).toHaveBeenCalledTimes(1)
})

test('a drag down or a short nudge leaves it where it is, and a tap still opens it', () => {
  const { handlers, onPress, onDismiss } = render()
  expect(drag(handlers, 80)).toBe(false)
  drag(handlers, -20, 800)
  expect(onDismiss).not.toHaveBeenCalled()

  const card = current!.root.find(
    node => node.props.accessibilityRole === 'button' && typeof node.props.onPress === 'function',
  )
  ReactTestRenderer.act(() => card.props.onPress())
  expect(onPress).toHaveBeenCalledTimes(1)
  expect(onDismiss).not.toHaveBeenCalled()
})

// The release reads the flick's speed, so a short swipe made fast is a dismissal too.
test('a short fast flick dismisses it, where the same distance slowly does not', () => {
  const slow = render()
  drag(slow.handlers, -20, 800)
  expect(slow.onDismiss).not.toHaveBeenCalled()
  ReactTestRenderer.act(() => current!.unmount())

  const fast = render()
  expect(drag(fast.handlers, -20, 20)).toBe(true)
  expect(fast.onDismiss).toHaveBeenCalledTimes(1)
})

// It lands over the screen without taking focus, so a screen reader hears it only when told.
test('announces its title and body when it shows, set in the text roles', () => {
  const announce = jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined)
  try {
    render()
    expect(announce).toHaveBeenCalledWith('Payment received, 21 sats')
    const roles = current!.root.findAllByType(Txt).map(n => [n.props.role, n.props.children])
    expect(roles).toEqual([
      ['bodyBold', 'Payment received'],
      ['caption', '21 sats'],
    ])
  } finally {
    announce.mockRestore()
  }
})

test('draws its mark in the wallet accent, green in the dollar wallet', () => {
  ReactTestRenderer.act(() => {
    current = ReactTestRenderer.create(
      <DollarModeProvider initial>
        <ForegroundNotice title="Payment received" body="21 sats" onPress={jest.fn()} onDismiss={jest.fn()} />
      </DollarModeProvider>,
    )
  })
  expect(current!.root.findByType(TabIcon).props.color).toBe(colors.dollar)
})

describe('with reduced motion', () => {
  afterEach(() => jest.restoreAllMocks())

  async function renderWith(reduced: boolean) {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(reduced)
    const shown = render()
    await ReactTestRenderer.act(async () => {
      await Promise.resolve()
    })
    return shown
  }

  // The wrapper that carries the swipe is the one that slides.
  const wrapStyle = () =>
    StyleSheet.flatten(
      current!.root.find(node => typeof node.props.onMoveShouldSetResponderCapture === 'function').props.style,
    )

  test('slides in from above with full motion', async () => {
    await renderWith(false)
    expect(wrapStyle().transform).toBeDefined()
    expect(wrapStyle().opacity).toBeDefined()
  })

  test('only fades, with no slide and no drag follow', async () => {
    await renderWith(true)
    expect(wrapStyle().transform).toBeUndefined()
    expect(wrapStyle().opacity).toBeDefined()
  })

  test('a swipe up still dismisses it by the same distance', async () => {
    const { handlers, onDismiss } = await renderWith(true)
    drag(handlers, -20, 800)
    expect(onDismiss).not.toHaveBeenCalled()
    expect(drag(handlers, -80)).toBe(true)
    expect(onDismiss).toHaveBeenCalledTimes(1)
  })
})
