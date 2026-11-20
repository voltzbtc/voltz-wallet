import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import {
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  RefreshControl,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native'
import { Screen, styles } from '../src/components/Screen'
import { Field } from '../src/components/Field'
import { colors, space } from '../src/theme'

jest.mock('react-native-safe-area-context', () => ({
  // A real inset, not zero. With zero every assertion about the bottom padding would pass whether the
  // component added the inset or forgot it.
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

// The type of the outermost host element, which is the only way to ask what this component itself
// rendered rather than what its children did.
function rootTag(tree: ReactTestRenderer.ReactTestRenderer): string {
  const json = tree.toJSON()
  return Array.isArray(json) ? String(json[0]?.type) : String(json?.type)
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

it('does not scroll unless asked, so a screen can hold a list', () => {
  // The load-bearing default. HistoryScreen returns a FlatList from one of its three roots, and a
  // Screen that scrolled by default would nest a virtualised list inside a scroll view.
  const tree = render(
    <Screen>
      <FlatList data={[]} renderItem={() => null} />
    </Screen>,
  )
  // Asserted on the root rather than on the tree, because FlatList renders a ScrollView of its own
  // inside, so searching the whole tree for one finds the list's and says nothing about what Screen
  // built.
  expect(rootTag(tree)).toBe('View')
  expect(tree.root.findAllByType(FlatList)).toHaveLength(1)
})

it('scrolls when asked', () => {
  const tree = render(
    <Screen scroll>
      <Text>body</Text>
    </Screen>,
  )
  expect(tree.root.findAllByType(ScrollView)).toHaveLength(1)
})

it('carries the app background at the root, which 27 blocks wrote out by hand', () => {
  const tree = render(
    <Screen>
      <Text>body</Text>
    </Screen>,
  )
  const root = flat(tree.root.findAllByType(View)[0]!.props.style)
  expect(root.backgroundColor).toBe(colors.background)
  expect(root.flex).toBe(1)
})

it('adds the bottom inset to the padding, which 13 files were copying', () => {
  const tree = render(
    <Screen scroll layout="padded">
      <Text>body</Text>
    </Screen>,
  )
  const content = flat(tree.root.findByType(ScrollView).props.contentContainerStyle)
  expect(content.paddingBottom).toBe(space.xl + 34)
})

it('keeps the inset even with no content layout, since the home indicator does not care', () => {
  const tree = render(
    <Screen scroll>
      <Text>body</Text>
    </Screen>,
  )
  expect(flat(tree.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom).toBe(
    space.xl + 34,
  )
})

describe('the footer', () => {
  it('sits outside the scrolling area, so a call to action stays put', () => {
    // AddAssetScreen is why this is a prop. Passing the button as a child of a scrolling Screen sends
    // it away with the content.
    const tree = render(
      <Screen scroll footer={<Text>pay</Text>}>
        <Text>body</Text>
      </Screen>,
    )
    const inScroll = tree.root
      .findByType(ScrollView)
      .findAllByType(Text)
      .map(n => n.props.children)
    expect(inScroll).toContain('body')
    expect(inScroll).not.toContain('pay')
    // The other half. Asserting only that the footer is not inside the scroll passes just as well
    // when the footer never renders at all, which is a version of AddAssetScreen with no pay
    // button.
    expect(tree.root.findAllByType(Text).map(n => n.props.children)).toContain('pay')
  })

  it('carries the safe-area inset itself, and takes it off the content', () => {
    // The whole bottom belongs to the footer: its top padding is the gap after the content and the
    // inset under it is the clearance. Padding the content too stacks a double gap and leaves 34pt
    // of empty list behind the footer, where no screenshot shows it.
    const tree = render(
      <Screen scroll footer={<Text>pay</Text>}>
        <Text>body</Text>
      </Screen>,
    )
    expect(flat(tree.root.findByType(ScrollView).props.contentContainerStyle).paddingBottom).toBe(0)
    // Found by its content, not by the property. `some(View => paddingBottom === 34)` asks whether
    // the tree holds the number anywhere, so it stays green with the inset on the outer stack and
    // the footer bare against the gesture indicator, which is the defect this guards, inverted.
    // The whole style, not the one key. Moving the inset up to the outer stack leaves the footer's
    // parent carrying `paddingBottom: 34` just the same, so asking only for that key stays green
    // with the footer bare against the gesture indicator and the entire screen padded instead. What
    // separates them is that the wrapper does nothing else.
    const pay = tree.root.findAll(n => n.props.children === 'pay')[0]!
    expect(flat(pay.parent!.props.style)).toEqual({ paddingBottom: 34 })
  })

  it('adds no wrapper when not given, so the scroll stays the root', () => {
    // ScrollView renders Views of its own, so counting Views proves nothing. What matters is that a
    // Screen without a footer does not gain a layer between the caller and the scroll.
    const tree = render(
      <Screen scroll>
        <Text>body</Text>
      </Screen>,
    )
    expect(rootTag(tree)).toBe('RCTScrollView')
  })
})

describe('the keyboard', () => {
  it('is not avoided unless the screen says it has one', () => {
    const tree = render(
      <Screen scroll>
        <Text>body</Text>
      </Screen>,
    )
    expect(tree.root.findAllByType(KeyboardAvoidingView)).toHaveLength(0)
  })

  it('is avoided when it does', () => {
    const tree = render(
      <Screen scroll keyboard>
        <Text>body</Text>
      </Screen>,
    )
    expect(tree.root.findAllByType(KeyboardAvoidingView)).toHaveLength(1)
  })

  // An edge-to-edge window on Android 15 and later is not resized for the keyboard, so an avoider
  // with no behavior there leaves every field and footer under it.
  it.each(['ios', 'android'] as const)('pads on %s, where the window is not resized for it', os => {
    const original = Platform.OS
    Platform.OS = os
    try {
      const tree = render(
        <Screen scroll keyboard>
          <Text>body</Text>
        </Screen>,
      )
      expect(tree.root.findByType(KeyboardAvoidingView).props.behavior).toBe('padding')
    } finally {
      Platform.OS = original
    }
  })

  // The avoider compares its parent-relative frame with the keyboard's window position, so the
  // offset has to be where it starts in the window, or a header's height stays under the keyboard.
  it('offsets the avoider by where it starts in the window', () => {
    const tree = render(
      <Screen scroll keyboard>
        <Text>body</Text>
      </Screen>,
    )
    const avoider = () => tree.root.findByType(KeyboardAvoidingView)
    expect(avoider().props.keyboardVerticalOffset).toBe(0)
    // The outermost view with a layout handler is the frame around the avoider, which renders its own.
    const frame = tree.root.findAll(n => n.type === View && typeof n.props.onLayout === 'function')[0]!
    // 103 is a native header under a status bar, the case the offset exists for.
    frame.instance.measureInWindow = (done: (x: number, y: number) => void) => done(0, 103)
    ReactTestRenderer.act(() => {
      frame.props.onLayout()
    })
    expect(avoider().props.keyboardVerticalOffset).toBe(103)
  })

  // The avoider shrinks the scroll under a focused field, and iOS does not scroll it back into view.
  describe('the focused field', () => {
    function shrink(fieldTop: number) {
      const tree = render(
        <Screen scroll keyboard>
          <Text>body</Text>
        </Screen>,
      )
      const list = tree.root.findByType(ScrollView)
      const scrollTo = jest.fn()
      list.instance.scrollTo = scrollTo
      list.instance.getInnerViewRef = () => ({})
      jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({
        measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
          done(24, fieldTop, 342, 70),
      } as never)
      const layout = (height: number) =>
        ReactTestRenderer.act(() => {
          list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } })
        })
      layout(640)
      expect(scrollTo).not.toHaveBeenCalled()
      layout(300)
      return scrollTo
    }

    afterEach(() => jest.restoreAllMocks())

    it('is scrolled back above the edge the keyboard brought up', () => {
      // 271 + 70 + space.lg is below a 300pt viewport.
      expect(shrink(271)).toHaveBeenCalledWith({ y: 271 + 70 + space.lg - 300, animated: true })
    })

    it('stays put when it is still in view', () => {
      expect(shrink(100)).not.toHaveBeenCalled()
    })

    // iOS announces the keyboard again when focus moves to another field with the keyboard already
    // up, and the scroll does not shrink then, so only the event can bring the new field into view.
    describe('when the keyboard shows', () => {
      function listen(node: React.JSX.Element) {
        // The avoider subscribes too, so each event keeps its own handler and its own remove.
        const handlers = new Map<string, () => void>()
        const removes = new Map<string, jest.Mock>()
        jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, handler: () => void) => {
          handlers.set(event, handler)
          const remove = jest.fn()
          removes.set(event, remove)
          return { remove }
        }) as never)
        const tree = render(node)
        return { tree, handlers, removes }
      }

      it('brings a field below the visible part back above its edge', () => {
        const { tree, handlers } = listen(
          <Screen scroll keyboard>
            <Text>body</Text>
          </Screen>,
        )
        const list = tree.root.findByType(ScrollView)
        const scrollTo = jest.fn()
        list.instance.scrollTo = scrollTo
        list.instance.getInnerViewRef = () => ({})
        ReactTestRenderer.act(() => {
          list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 300 } } })
          list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 40 } } })
        })
        jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({
          measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
            done(24, 400, 342, 70),
        } as never)

        ReactTestRenderer.act(() => handlers.get('keyboardDidShow')?.())

        expect(scrollTo).toHaveBeenCalledWith({ y: 400 + 70 + space.lg - 300, animated: true })
      })

      it('is no longer listened for once the screen is gone', () => {
        const { tree, removes } = listen(
          <Screen scroll keyboard>
            <Text>body</Text>
          </Screen>,
        )
        const remove = removes.get('keyboardDidShow')
        expect(remove).not.toHaveBeenCalled()
        ReactTestRenderer.act(() => tree.unmount())
        expect(remove).toHaveBeenCalledTimes(1)
      })

      it.each([
        ['a scroll without a keyboard', <Screen scroll key="s"><Text>body</Text></Screen>],
        ['a keyboard without a scroll', <Screen keyboard key="k"><Text>body</Text></Screen>],
      ])('is not listened for on %s', (_what, node) => {
        const { handlers } = listen(node)
        expect(handlers.has('keyboardDidShow')).toBe(false)
      })
    })

    // A hardware keyboard shows no keyboard and leaves the scroll its height, so no keyboard event and
    // no shrink ever come, and the focus itself has to bring the field above the footer.
    describe('when it gains focus with no keyboard showing', () => {
      function focusAt(fieldTop: number, { measured = true } = {}) {
        const tree = render(
          <Screen scroll keyboard>
            <Text>body</Text>
          </Screen>,
        )
        const list = tree.root.findByType(ScrollView)
        const scrollTo = jest.fn()
        list.instance.scrollTo = scrollTo
        list.instance.getInnerViewRef = () => ({})
        if (measured) {
          ReactTestRenderer.act(() => {
            list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height: 300 } } })
            list.props.onScroll({ nativeEvent: { contentOffset: { x: 0, y: 40 } } })
          })
        }
        jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({
          measureLayout: (_to: unknown, done: (x: number, y: number, w: number, h: number) => void) =>
            done(24, fieldTop, 342, 70),
        } as never)
        ReactTestRenderer.act(() => list.props.onFocus({ nativeEvent: {} }))
        return scrollTo
      }

      it('brings a field below the visible part back above its edge', () => {
        expect(focusAt(400)).toHaveBeenCalledWith({ y: 400 + 70 + space.lg - 300, animated: true })
      })

      it('stays put when the field is still in view', () => {
        expect(focusAt(100)).not.toHaveBeenCalled()
      })

      // A field focused as it mounts can be heard before the scroll has its height, and a reveal
      // against no height would scroll the field to the top.
      it('waits until the scroll has measured itself', () => {
        expect(focusAt(400, { measured: false })).not.toHaveBeenCalled()
      })

      it('is not listened for on a scroll without a keyboard', () => {
        const tree = render(
          <Screen scroll>
            <Text>body</Text>
          </Screen>,
        )
        expect(tree.root.findByType(ScrollView).props.onFocus).toBeUndefined()
      })
    })

    // The hint under a field belongs to it, so a reveal brings up the field's whole group, not only the
    // box the cursor is in, and the hint does not stay behind the footer above the keyboard.
    describe('with a hint under it', () => {
      type Measure = (to: unknown, done: (x: number, y: number, w: number, h: number) => void, fail: () => void) => void

      // The input's box sits at 400 and is 44 tall; `group` measures the field's group around it.
      function focusField(group: Measure) {
        jest.spyOn(TextInput.State, 'currentlyFocusedInput').mockReturnValue({
          measureLayout: ((_to, done) => done(24, 400, 342, 44)) as Measure,
        } as never)
        const tree = render(
          <Screen scroll keyboard>
            <Field value="" onChangeText={() => undefined} hint="hint" />
          </Screen>,
        )
        // The field's outermost view is the group holding the box and the hint.
        tree.root.findByType(Field).findAllByType(View)[0]!.instance.measureLayout = group
        const list = tree.root.findByType(ScrollView)
        const scrollTo = jest.fn()
        list.instance.scrollTo = scrollTo
        list.instance.getInnerViewRef = () => ({})
        const layout = (height: number) =>
          ReactTestRenderer.act(() => {
            list.props.onLayout({ nativeEvent: { layout: { x: 0, y: 0, width: 390, height } } })
          })
        layout(640)
        ReactTestRenderer.act(() => tree.root.findByType(TextInput).props.onFocus({ nativeEvent: {} }))
        layout(300)
        return scrollTo
      }

      it('brings the hint above the edge along with the box', () => {
        // The group starts at 380 and ends under the hint at 492.
        const scrollTo = focusField((_to, done) => done(0, 380, 342, 112))
        expect(scrollTo).toHaveBeenCalledWith({ y: 492 + space.lg - 300, animated: true })
      })

      // At the largest text sizes a hint can be taller than what the keyboard leaves, and the input is
      // what is being typed in.
      it('never scrolls the input above the top of the view', () => {
        const scrollTo = focusField((_to, done) => done(0, 380, 342, 900))
        expect(scrollTo).toHaveBeenCalledWith({ y: 400, animated: true })
      })

      it('brings up the box alone when the group cannot be measured', () => {
        const scrollTo = focusField((_to, _done, fail) => fail())
        expect(scrollTo).toHaveBeenCalledWith({ y: 400 + 44 + space.lg - 300, animated: true })
      })
    })
  })

  // Set on some scrolling screens and absent on the rest, and the difference is real: with it, a
  // tap while the keyboard is up both dismisses and fires. Tying it to `scroll` would change
  // behaviour on every scrolling screen without a keyboard; tying it to nothing breaks the
  // suggestion bar that relies on it.
  it('persists taps only where a keyboard is declared, not wherever there is a scroll', () => {
    const withKeyboard = render(
      <Screen scroll keyboard>
        <Text>body</Text>
      </Screen>,
    )
    const without = render(
      <Screen scroll>
        <Text>body</Text>
      </Screen>,
    )
    expect(withKeyboard.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe('handled')
    expect(without.root.findByType(ScrollView).props.keyboardShouldPersistTaps).toBe('never')
  })
})

describe('the three content layouts', () => {
  it('plain adds nothing, since most screens lay their own content out', () => {
    const tree = render(
      <Screen>
        <Text>body</Text>
      </Screen>,
    )
    expect(flat(tree.root.findAllByType(View)[0]!.props.style).padding).toBeUndefined()
  })

  it('padded is horizontal and top only, since the bottom comes from the inset', () => {
    // Two screen shapes collapse here, `paddingHorizontal + paddingTop` and `padding` on all sides,
    // and what separates them is a bottom margin neither can get right without knowing the device.
    const tree = render(
      <Screen layout="padded">
        <Text>body</Text>
      </Screen>,
    )
    const root = flat(tree.root.findAllByType(View)[0]!.props.style)
    expect(root.paddingHorizontal).toBe(space.xl)
    expect(root.paddingTop).toBe(space.xl)
    expect(root.paddingBottom).toBe(space.xl + 34)
  })

  it('center is for a screen holding one thing, or holding nothing', () => {
    const tree = render(
      <Screen layout="center">
        <Text>body</Text>
      </Screen>,
    )
    const root = flat(tree.root.findAllByType(View)[0]!.props.style)
    expect(root.alignItems).toBe('center')
    expect(root.justifyContent).toBe('center')
  })
})

describe('each layout and the inset, case by case', () => {
  // A check that only `padding` is undefined would let the layout gain any other padding key unseen,
  // including the paddingBottom the inset is supposed to own.
  it('plain writes no padding key of its own, so a caller can set every side', () => {
    // Asserted as empty rather than key by key. Naming the keys leaves every key not named free to
    // appear, and the invariant is that `plain` contributes nothing at all. Nothing renders here on
    // purpose, since the four-combination case below covers that it reaches the tree.
    expect(styles.plain).toEqual({})
  })

  // All four combinations of scroll and layout, because the inset has to reach every one of them,
  // including the shape HistoryScreen needs for its list.
  it.each([
    ['plain', false],
    ['plain', true],
    ['padded', false],
    ['center', true],
  ] as const)('carries the bottom inset with layout=%s and scroll=%s', (layout, scroll) => {
    const tree = render(
      <Screen layout={layout} scroll={scroll}>
        <Text>body</Text>
      </Screen>,
    )
    const style = scroll
      ? tree.root.findByType(ScrollView).props.contentContainerStyle
      : tree.root.findAllByType(View)[0]!.props.style
    expect(flat(style).paddingBottom).toBe(space.xl + 34)
  })

  // `flex: 1` on a content container pins the content to the viewport height, so it can never exceed
  // it and the scroll never happens. That breaks the one thing `center` is for: an empty state that
  // still has to scroll at a large text size.
  it('center grows rather than fixing its height, so it can still scroll', () => {
    const tree = render(
      <Screen layout="center" scroll>
        <Text>body</Text>
      </Screen>,
    )
    const content = flat(tree.root.findByType(ScrollView).props.contentContainerStyle)
    expect(content.flexGrow).toBe(1)
    expect(content.flex).toBeUndefined()
  })

  // `style` lands on the outermost element with or without a footer, so one prop never means two
  // things depending on another prop.
  it('puts style on the outermost element whether or not there is a footer', () => {
    const mark = { marginTop: 7 } as const
    for (const footer of [undefined, <Text key="f">pay</Text>]) {
      const tree = render(
        <Screen scroll style={mark} footer={footer}>
          <Text>body</Text>
        </Screen>,
      )
      const json = tree.toJSON()
      const root = Array.isArray(json) ? json[0] : json
      expect(flat(root?.props.style).marginTop).toBe(7)
      // And nowhere else. Applying it to both the wrapper and the inner element passes an assertion
      // that only looks at the root, while the caller's style silently reaches twice as far.
      const inner = (root?.children ?? []).filter(c => typeof c === 'object')
      for (const child of inner) {
        expect(
          flat((child as { props?: { style?: unknown } }).props?.style).marginTop,
        ).toBeUndefined()
      }
    }
  })

  it('lets contentStyle add what the layout does not set', () => {
    const tree = render(
      <Screen scroll layout="plain" contentStyle={{ gap: space.md }}>
        <Text>body</Text>
      </Screen>,
    )
    expect(flat(tree.root.findByType(ScrollView).props.contentContainerStyle).gap).toBe(space.md)
  })
})

describe('the pull control', () => {
  const control = <RefreshControl refreshing={false} onRefresh={() => undefined} />

  test('reaches the scroll of a scrolling Screen', () => {
    const tree = render(
      <Screen scroll refreshControl={control}>
        <View />
      </Screen>,
    )

    expect(tree.root.findByType(ScrollView).props.refreshControl).toBe(control)
  })

  test('a Screen without one leaves the scroll without one', () => {
    const tree = render(
      <Screen scroll>
        <View />
      </Screen>,
    )

    expect(tree.root.findByType(ScrollView).props.refreshControl).toBeUndefined()
  })
})

describe('a touch on the body', () => {
  test('reaches onTouchStart on a scrolling screen', () => {
    const onTouchStart = jest.fn()
    const tree = render(
      <Screen scroll onTouchStart={onTouchStart}>
        <Text>body</Text>
      </Screen>,
    )
    tree.root.findByType(ScrollView).props.onTouchStart()
    expect(onTouchStart).toHaveBeenCalledTimes(1)
  })

  test('reaches it on a screen that does not scroll', () => {
    const onTouchStart = jest.fn()
    const tree = render(
      <Screen onTouchStart={onTouchStart}>
        <Text>body</Text>
      </Screen>,
    )
    tree.root.findAll(node => typeof node.props.onTouchStart === 'function' && node.type === View)[0].props.onTouchStart()
    expect(onTouchStart).toHaveBeenCalledTimes(1)
  })
})
