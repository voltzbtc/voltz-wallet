import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Animated, Text, View, type GestureResponderEvent } from 'react-native'
// The hook reads its string through useTranslation, which needs an initialized instance.
import i18n from '../src/i18n'
import { CrossFade } from '../src/components/CrossFade'
import { FadeInLine } from '../src/components/FadeInLine'
import { usePullFeedback } from '../src/hooks/usePullFeedback'
import { useFreshLines } from '../src/hooks/useFreshLines'
import { motion } from '../src/theme'
import { UnderLock } from '../src/components/UnderLock'

type Feedback = ReturnType<typeof usePullFeedback>
let feedback!: Feedback

function Host(): React.JSX.Element {
  feedback = usePullFeedback()
  return <View />
}

let tree: ReactTestRenderer.ReactTestRenderer | null = null

async function render(element: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(element)
  })
  return tree as ReactTestRenderer.ReactTestRenderer
}

async function advance(ms: number): Promise<void> {
  await ReactTestRenderer.act(async () => {
    await jest.advanceTimersByTimeAsync(ms)
  })
}

// What a touch event carries of what is still on the screen, cast since the rest of it is not read.
const lifted = (fingers: number) =>
  ({ nativeEvent: { touches: Array(fingers).fill({}) } }) as unknown as GestureResponderEvent

beforeEach(() => {
  jest.useFakeTimers()
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
})

// Animated runs its frames on timers too, and only the app's own timers are the question.
const stillAnimated = () =>
  jest.spyOn(Animated, 'timing').mockReturnValue({
    start: () => undefined,
    stop: () => undefined,
    reset: () => undefined,
  })

afterEach(() => {
  ReactTestRenderer.act(() => tree?.unmount())
  tree = null
  jest.useRealTimers()
  jest.restoreAllMocks()
})

describe('the beat', () => {
  test('moves once for a pull that landed', async () => {
    await render(<Host />)

    await ReactTestRenderer.act(async () => feedback.answered(true))

    expect(feedback.beat).toBe(1)
  })

  test('stays for a pull that did not, where the not updated mark says so', async () => {
    await render(<Host />)

    await ReactTestRenderer.act(async () => feedback.answered(false))

    expect(feedback.beat).toBe(0)
  })

  test('never comes with a finger on the page', async () => {
    await render(<Host />)
    ReactTestRenderer.act(() => feedback.touch.onTouchStart())

    await ReactTestRenderer.act(async () => feedback.answered(true))
    expect(feedback.beat).toBe(0)

    ReactTestRenderer.act(() => feedback.touch.onTouchEnd(lifted(0)))
    await ReactTestRenderer.act(async () => feedback.answered(true))
    expect(feedback.beat).toBe(1)
  })

  test('waits for the last finger, and a cancelled touch counts as lifted', async () => {
    await render(<Host />)
    ReactTestRenderer.act(() => feedback.touch.onTouchStart())
    ReactTestRenderer.act(() => feedback.touch.onTouchEnd(lifted(1)))

    await ReactTestRenderer.act(async () => feedback.answered(true))
    expect(feedback.beat).toBe(0)

    ReactTestRenderer.act(() => feedback.touch.onTouchCancel(lifted(0)))
    await ReactTestRenderer.act(async () => feedback.answered(true))
    expect(feedback.beat).toBe(1)
  })

  // Android's order: the touch, then a cancel with no touches as the native scroll takes over.
  async function scrollTakesOver(): Promise<void> {
    ReactTestRenderer.act(() => {
      feedback.touch.onTouchStart()
      feedback.touch.onTouchCancel(lifted(0))
      feedback.scroll.onScrollBeginDrag()
    })
  }
  const beatAfterAnswer = async (): Promise<number> => {
    await ReactTestRenderer.act(async () => feedback.answered(true))
    return feedback.beat
  }

  test('never comes under a finger that is scrolling', async () => {
    await render(<Host />)
    await scrollTakesOver()

    expect(await beatAfterAnswer()).toBe(0)

    ReactTestRenderer.act(() => feedback.scroll.onScrollEndDrag())
    expect(await beatAfterAnswer()).toBe(1)
  })

  test('waits for the end of a glide', async () => {
    await render(<Host />)
    await scrollTakesOver()
    ReactTestRenderer.act(() => {
      feedback.scroll.onScrollEndDrag()
      feedback.scroll.onMomentumScrollBegin()
    })

    expect(await beatAfterAnswer()).toBe(0)

    ReactTestRenderer.act(() => feedback.scroll.onMomentumScrollEnd())
    expect(await beatAfterAnswer()).toBe(1)
  })

  test('a tap that stops a glide frees it, since Android sends no momentum end then', async () => {
    await render(<Host />)
    ReactTestRenderer.act(() => feedback.scroll.onMomentumScrollBegin())

    ReactTestRenderer.act(() => feedback.touch.onTouchStart())
    ReactTestRenderer.act(() => feedback.touch.onTouchEnd(lifted(0)))

    expect(await beatAfterAnswer()).toBe(1)
  })

  test('a drag over a glide keeps it, and only the end of what follows frees it', async () => {
    await render(<Host />)
    ReactTestRenderer.act(() => {
      feedback.scroll.onMomentumScrollBegin()
      feedback.scroll.onScrollBeginDrag()
    })
    expect(await beatAfterAnswer()).toBe(0)

    ReactTestRenderer.act(() => feedback.scroll.onScrollEndDrag())

    expect(await beatAfterAnswer()).toBe(1)
  })

  test('leaves no timer behind on unmount', async () => {
    const root = await render(<Host />)
    await ReactTestRenderer.act(async () => feedback.reading())
    await ReactTestRenderer.act(async () => feedback.answered(true))

    ReactTestRenderer.act(() => root.unmount())
    tree = null

    await advance(0)
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('what a screen reader hears', () => {
  const heard = () => jest.mocked(AccessibilityInfo.announceForAccessibility).mock.calls

  beforeEach(() => {
    jest.spyOn(AccessibilityInfo, 'announceForAccessibility').mockImplementation(() => undefined).mockClear()
  })

  test('a pull that landed says so, and the page moves as well', async () => {
    await render(<Host />)

    await ReactTestRenderer.act(async () => feedback.pulled(true))

    expect(heard()).toEqual([[i18n.t('home.updatedNow')]])
    expect(feedback.beat).toBe(1)
  })

  test('a pull that did not land says nothing, and its fade still ends', async () => {
    await render(<Host />)
    await ReactTestRenderer.act(async () => feedback.reading())

    await ReactTestRenderer.act(async () => feedback.pulled(false))

    expect(heard()).toEqual([])
    await advance(motion.base)
    expect(feedback.fading).toBe(false)
  })

  test('a finger holds the page back and not the words', async () => {
    await render(<Host />)
    ReactTestRenderer.act(() => feedback.touch.onTouchStart())

    await ReactTestRenderer.act(async () => feedback.pulled(true))

    expect(heard()).toHaveLength(1)
    expect(feedback.beat).toBe(0)
  })

  test('a read nobody asked for says nothing', async () => {
    await render(<Host />)

    await ReactTestRenderer.act(async () => feedback.answered(true))

    expect(heard()).toEqual([])
  })

  // A pull that answers after the app left and the PIN was asked again lands under the lock, where
  // nothing is said, and nothing of it is said at the unlock either, since it is no longer news.
  test('a pull that lands under the lock says nothing, then or at the unlock', async () => {
    await render(
      <UnderLock locked>
        <Host />
      </UnderLock>,
    )

    await ReactTestRenderer.act(async () => feedback.pulled(true))
    expect(heard()).toEqual([])

    await ReactTestRenderer.act(async () => {
      tree?.update(
        <UnderLock locked={false}>
          <Host />
        </UnderLock>,
      )
    })
    expect(heard()).toEqual([])
    await ReactTestRenderer.act(async () => feedback.pulled(true))
    expect(heard()).toEqual([[i18n.t('home.updatedNow')]])
  })
})

describe('fades arm only around a read that follows a pull', () => {
  test('armed by the read, disarmed after the answer once the figures had time to land', async () => {
    await render(<Host />)
    expect(feedback.fading).toBe(false)

    await ReactTestRenderer.act(async () => feedback.reading())
    expect(feedback.fading).toBe(true)

    await ReactTestRenderer.act(async () => feedback.answered(false))
    expect(feedback.fading).toBe(true)
    await advance(motion.base)
    expect(feedback.fading).toBe(false)
  })

  test('a second read keeps them armed past the first answer', async () => {
    await render(<Host />)
    await ReactTestRenderer.act(async () => feedback.reading())
    await ReactTestRenderer.act(async () => feedback.answered(true))
    await ReactTestRenderer.act(async () => feedback.reading())

    await advance(motion.base)

    expect(feedback.fading).toBe(true)
  })
})

describe('CrossFade', () => {
  const screen = (value: string, armed: boolean, tapped?: string) => (
    <CrossFade value={value} armed={armed} tapped={tapped}>
      <Text>{value}</Text>
    </CrossFade>
  )
  const leaving = (root: ReactTestRenderer.ReactTestRenderer) =>
    root.root.findAll(node => typeof node.type === 'string' && node.props.testID === 'cross-fade-leaving')
  const words = (root: ReactTestRenderer.ReactTestRenderer) =>
    root.root.findAllByType(Text).map(node => node.props.children)

  test('an armed change keeps the old value over the new one until the fade ends', async () => {
    const root = await render(screen('100', true))

    await ReactTestRenderer.act(async () => root.update(screen('200', true)))

    expect(words(root)).toEqual(['200', '100'])
    expect(leaving(root)).toHaveLength(1)
    await advance(motion.base)
    expect(words(root)).toEqual(['200'])
    expect(leaving(root)).toHaveLength(0)
  })

  test('the old value takes no touch and is hidden from a screen reader', async () => {
    const root = await render(screen('100', true))

    await ReactTestRenderer.act(async () => root.update(screen('200', true)))

    const [old] = leaving(root)
    expect(old.props.pointerEvents).toBe('none')
    expect(old.props.accessibilityElementsHidden).toBe(true)
    expect(old.props.importantForAccessibility).toBe('no-hide-descendants')
  })

  test('a change that is not armed just changes', async () => {
    const root = await render(screen('100', false))

    await ReactTestRenderer.act(async () => root.update(screen('200', false)))

    expect(words(root)).toEqual(['200'])
  })

  test('a tap answers at once, armed or not', async () => {
    const root = await render(screen('100', true, 'sats'))

    await ReactTestRenderer.act(async () => root.update(screen('200', true, 'btc')))

    expect(words(root)).toEqual(['200'])
    expect(leaving(root)).toHaveLength(0)
  })

  test('a tap ends a fade under way, and its timer with it', async () => {
    stillAnimated()
    const root = await render(screen('100', true, 'shown'))
    await ReactTestRenderer.act(async () => root.update(screen('200', true, 'shown')))
    expect(words(root)).toEqual(['200', '100'])

    await ReactTestRenderer.act(async () => root.update(screen('••••', true, 'hidden')))

    expect(words(root)).toEqual(['••••'])
    await advance(0)
    expect(jest.getTimerCount()).toBe(0)
  })

  test('a read after a tap fades again', async () => {
    const root = await render(screen('100', true, 'sats'))
    await ReactTestRenderer.act(async () => root.update(screen('200', true, 'btc')))

    await ReactTestRenderer.act(async () => root.update(screen('300', true, 'btc')))

    expect(words(root)).toEqual(['300', '200'])
  })

  test('the same value fades nothing, armed or not', async () => {
    const root = await render(screen('100', false))

    await ReactTestRenderer.act(async () => root.update(screen('100', true)))

    expect(leaving(root)).toHaveLength(0)
  })

  test('a change during a fade starts from the latest value and leaves one copy', async () => {
    const root = await render(screen('100', true))
    await ReactTestRenderer.act(async () => root.update(screen('200', true)))
    await advance(motion.base / 2)

    await ReactTestRenderer.act(async () => root.update(screen('300', true)))

    expect(words(root)).toEqual(['300', '200'])
    await advance(motion.base / 2)
    expect(words(root)).toEqual(['300', '200'])
    await advance(motion.base / 2)
    expect(words(root)).toEqual(['300'])
  })

  test('unmounting mid fade leaves no timer', async () => {
    stillAnimated()
    const root = await render(screen('100', true))
    await ReactTestRenderer.act(async () => root.update(screen('200', true)))

    ReactTestRenderer.act(() => root.unmount())
    tree = null

    await advance(0)
    expect(jest.getTimerCount()).toBe(0)
  })
})

describe('a line new since the pull', () => {
  let lines!: ReturnType<typeof useFreshLines>
  function Lines(): null {
    lines = useFreshLines()
    return null
  }

  test('is the one the list did not hold when the pull began', async () => {
    await render(<Lines />)

    await ReactTestRenderer.act(async () => {
      lines.pullStarted(['a', 'b'])
      lines.readLanded(['c', 'a', 'b'])
    })

    expect(Array.from(lines.fresh)).toEqual(['c'])
  })

  test('stops being new once the fade is over', async () => {
    await render(<Lines />)
    await ReactTestRenderer.act(async () => {
      lines.pullStarted(['a'])
      lines.readLanded(['b', 'a'])
    })

    await advance(motion.base)

    expect(lines.fresh.size).toBe(0)
  })

  test('with no pull under way, a read marks nothing', async () => {
    await render(<Lines />)

    await ReactTestRenderer.act(async () => {
      lines.readLanded(['a', 'b'])
    })

    expect(lines.fresh.size).toBe(0)
  })

  test('after the pull ended, a read marks nothing', async () => {
    await render(<Lines />)

    await ReactTestRenderer.act(async () => {
      lines.pullStarted(['a'])
      lines.pullEnded()
      lines.readLanded(['b', 'a'])
    })

    expect(lines.fresh.size).toBe(0)
  })

  test('FadeInLine starts a fresh line clear and leaves an old one alone', async () => {
    const timing = jest.spyOn(Animated, 'timing')

    await render(
      <FadeInLine fresh={false}>
        <View />
      </FadeInLine>,
    )
    expect(timing).not.toHaveBeenCalled()

    const fresh = await render(
      <FadeInLine fresh>
        <View />
      </FadeInLine>,
    )
    expect(timing).toHaveBeenCalledTimes(1)
    expect(fresh.toJSON()).toMatchObject({ props: { style: expect.objectContaining({ opacity: 0 }) } })
  })
})
