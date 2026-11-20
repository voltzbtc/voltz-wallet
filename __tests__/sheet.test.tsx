import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import {
  AccessibilityInfo,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  Text,
  View,
} from 'react-native'
import { GRABBER, Sheet } from '../src/components/Sheet'
import { colors, space } from '../src/theme'

jest.mock('react-native-safe-area-context', () => ({
  // A real inset. With zero, every assertion about the bottom padding would pass whether the sheet
  // added the inset or forgot it, which is the whole question on Android inside a Modal.
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}))

// The preset's reduce-motion double is a plain jest.fn, which jest.spyOn hands back as it is and
// restoreAllMocks leaves alone, so an answer set by one test would hold for every later one.
afterEach(() => {
  jest.mocked(AccessibilityInfo.isReduceMotionEnabled).mockImplementation(() => Promise.resolve(false))
})

function render(node: React.JSX.Element): ReactTestRenderer.ReactTestRenderer {
  let tree!: ReactTestRenderer.ReactTestRenderer
  ReactTestRenderer.act(() => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

// The panel is the View holding the children, which is the second one inside the Modal: the first is
// the backdrop's Pressable.
const panel = (tree: ReactTestRenderer.ReactTestRenderer): Record<string, unknown> =>
  flat(
    tree.root
      .findAllByType(View)
      .map(node => flat(node.props.style))
      .find(s => s.backgroundColor === colors.sheet),
  )

function base(extra: Partial<React.ComponentProps<typeof Sheet>> = {}): React.JSX.Element {
  return (
    <Sheet visible onClose={() => undefined} closeLabel="close" {...extra}>
      <Text>body</Text>
    </Sheet>
  )
}

it('draws nothing outside a Modal, so it never lands in the page flow', () => {
  expect(render(base()).root.findAllByType(Modal)).toHaveLength(1)
})

it('takes the safe-area inset for its bottom padding rather than a guessed constant', () => {
  // A guessed constant gives every sheet a different answer, and only the inset knows the device.
  expect(panel(render(base())).paddingBottom).toBe(space.xl + 34)
})

it('uses the sheet colour', () => {
  // Every sheet draws in colors.sheet, #0e0e10, rather than in the #1a1a1a surface colour.
  expect(panel(render(base())).backgroundColor).toBe(colors.sheet)
})

describe('the height cap', () => {
  // A panel taller than the window covers its own backdrop, and on iOS the backdrop is the only way
  // out of a sheet with no close button. Jest cannot lay out, so the cap is read off the panel with
  // content far taller than any phone.
  it('stops a very tall sheet short of the top, so the backdrop stays above it', () => {
    const tall = render(
      <Sheet visible onClose={() => undefined} closeLabel="close">
        <View style={{ height: 5000 }} />
      </Sheet>,
    )
    expect(panel(tall).maxHeight).toBe('90%')
  })

  it('takes a lower cap from a sheet that wants one', () => {
    expect(panel(render(base({ maxHeight: '80%' }))).maxHeight).toBe('80%')
  })

  it('keeps the cap on a sheet with a field while the keyboard is down', () => {
    expect(panel(render(base({ keyboard: true }))).maxHeight).toBe('90%')
  })

  // With the keyboard up the avoider leaves only the room above it, and content that does not scroll
  // ends under the keyboard at 90% of that room.
  describe('with the keyboard up', () => {
    afterEach(() => jest.restoreAllMocks())

    function keyboardEvents() {
      const listeners: Record<string, (() => void)[]> = {}
      const add = Keyboard.addListener.bind(Keyboard)
      jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
        ;(listeners[event] ??= []).push(listener)
        return add(event as never, listener as never)
      }) as never)
      return (event: string, payload?: unknown) =>
        ReactTestRenderer.act(() => (listeners[event] ?? []).forEach(fire => (fire as (e?: unknown) => void)(payload)))
    }

    // The keyboard's top edge on a 844pt screen with a 336pt keyboard.
    const raised = { endCoordinates: { screenX: 0, screenY: 508, width: 390, height: 336 } }

    it.each([
      ['ios', 'keyboardWillShow', 'keyboardWillHide'],
      ['android', 'keyboardDidShow', 'keyboardDidHide'],
    ] as const)('gives a sheet with a field the room below the status bar on %s, and caps it again once down', (os, show, hide) => {
      const original = Platform.OS
      Platform.OS = os
      try {
        const fire = keyboardEvents()
        const tree = render(base({ keyboard: true }))
        fire(show, raised)
        expect(panel(tree).maxHeight).toBe(508 - 47)
        // The keyboard covers the home indicator, so its inset is no longer padding.
        expect(panel(tree).paddingBottom).toBe(space.xl)
        fire(hide)
        expect(panel(tree).maxHeight).toBe('90%')
        expect(panel(tree).paddingBottom).toBe(space.xl + 34)
      } finally {
        Platform.OS = original
      }
    })

    // iOS reports a top of zero with cross-fade transitions, and the avoider then leaves the whole window.
    it('takes the whole room when the keyboard reports no top', () => {
      const fire = keyboardEvents()
      const tree = render(base({ keyboard: true }))
      fire(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', { endCoordinates: { screenY: 0 } })
      expect(panel(tree).maxHeight).toBe('100%')
    })

    // A sheet closed with the keyboard up hears no hide event, since its listeners go with it.
    it('opens again at the 90% cap after closing with the keyboard up', () => {
      const fire = keyboardEvents()
      const tree = render(base({ keyboard: true }))
      fire(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', raised)
      expect(panel(tree).maxHeight).toBe(508 - 47)
      ReactTestRenderer.act(() => tree.update(base({ keyboard: true, visible: false })))
      ReactTestRenderer.act(() => tree.update(base({ keyboard: true })))
      expect(panel(tree).maxHeight).toBe('90%')
    })

    it('keeps a lower cap the sheet asked for', () => {
      const fire = keyboardEvents()
      const tree = render(base({ keyboard: true, maxHeight: '80%' }))
      fire(Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow', raised)
      expect(panel(tree).maxHeight).toBe('80%')
    })
  })
})

describe('the backdrop', () => {
  it('announces what closing it does, in this sheet, not in general', () => {
    // The label differs between sheets on purpose, since cancelling a conversion is not closing a
    // detail. The prop is required in the type so a migration cannot quietly drop it, because
    // nobody opens a screen reader to notice.
    const tree = render(base({ closeLabel: 'cancel the conversion' } as never))
    const labelled = tree.root
      .findAll(n => typeof n.props.accessibilityLabel === 'string')
      .map(n => n.props.accessibilityLabel)
    expect(labelled).toContain('cancel the conversion')
  })

  it('closes when pressed, which is the only way out for three sheets that had no other', () => {
    let closed = 0
    const tree = render(
      <Sheet visible onClose={() => (closed += 1)} closeLabel="close">
        <Text>body</Text>
      </Sheet>,
    )
    ReactTestRenderer.act(() => {
      tree.root.find(n => n.props.accessibilityLabel === 'close').props.onPress()
    })
    expect(closed).toBe(1)
  })
})

describe('the keyboard', () => {
  it('is avoided only when the sheet says it has a field', () => {
    expect(render(base()).root.findAllByType(KeyboardAvoidingView)).toHaveLength(0)
    expect(render(base({ keyboard: true })).root.findAllByType(KeyboardAvoidingView)).toHaveLength(1)
  })

  // Jest cannot see paint, so this pins the structure. An auto-height avoider leaves a searchable
  // list's last row laid out but unpainted on iOS.
  it('fills the window with the backdrop inside it, above the panel', () => {
    const avoider = render(base({ keyboard: true })).root.findByType(KeyboardAvoidingView)
    expect(flat(avoider.props.style).flex).toBe(1)
    const layers = avoider.findAll(
      n => n.props.accessibilityLabel === 'close' || flat(n.props.style).backgroundColor === colors.sheet,
      { deep: true },
    )
    const kinds = layers.map(n => (n.props.accessibilityLabel === 'close' ? 'backdrop' : 'panel'))
    expect(kinds).toContain('backdrop')
    expect(kinds.indexOf('backdrop')).toBeLessThan(kinds.indexOf('panel'))
  })

  it('avoids it inside the Modal, since the Modal is its own native window', () => {
    // Placed outside, it would be avoiding a keyboard in a window the sheet is not in. This is also
    // why no vertical offset is passed: that window starts at the top of the screen.
    const tree = render(base({ keyboard: true }))
    const inside = tree.root.findByType(Modal).findAllByType(KeyboardAvoidingView)
    expect(inside).toHaveLength(1)
    expect(inside[0]!.props.keyboardVerticalOffset).toBeUndefined()
  })

  // React Native draws every Modal window edge to edge on Android 15 and later, and the system does
  // not resize such a window for the keyboard, so no behavior there leaves the field under it.
  it.each(['ios', 'android'] as const)('pads on %s', os => {
    const original = Platform.OS
    Platform.OS = os
    try {
      expect(render(base({ keyboard: true })).root.findByType(KeyboardAvoidingView).props.behavior).toBe('padding')
    } finally {
      Platform.OS = original
    }
  })
})

// Android sends back to the Modal as well as to the keyboard, and closing on it would drop whatever
// the person typed into the sheet.
describe('back with the keyboard up', () => {
  afterEach(() => jest.restoreAllMocks())

  function closable() {
    const onClose = jest.fn()
    const tree = render(base({ onClose, keyboard: true }))
    const back = () => ReactTestRenderer.act(() => tree.root.findByType(Modal).props.onRequestClose())
    return { onClose, back }
  }

  it('hides only the keyboard while it is still up', () => {
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(true)
    const dismiss = jest.spyOn(Keyboard, 'dismiss').mockImplementation(() => undefined)
    const { onClose, back } = closable()
    back()
    expect(dismiss).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('closes the sheet on the next back, once the keyboard is down', () => {
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
    const { onClose, back } = closable()
    back()
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('takes a back that arrives just after the keyboard hid as the press that hid it', () => {
    let hid: (() => void) | undefined
    const addListener = Keyboard.addListener.bind(Keyboard)
    jest.spyOn(Keyboard, 'addListener').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'keyboardDidHide') {
        hid = listener
      }
      return addListener(event as never, listener as never)
    }) as never)
    jest.spyOn(Keyboard, 'isVisible').mockReturnValue(false)
    const now = jest.spyOn(Date, 'now').mockReturnValue(10_000)
    const { onClose, back } = closable()
    expect(hid).toBeDefined()

    hid!()
    now.mockReturnValue(10_100)
    back()
    expect(onClose).not.toHaveBeenCalled()

    now.mockReturnValue(11_000)
    back()
    expect(onClose).toHaveBeenCalledTimes(1)
  })
})

// The grabber promises a drag, and without it the backdrop strip is the only way out on iOS of every
// sheet but the amount sheet, which alone has a close button.
describe('dragging the grabber', () => {
  afterEach(() => jest.restoreAllMocks())

  // PanResponder reads the gesture from touchHistory: each event moves the one touch from where it
  // was to `y` at time `t`.
  function touch(y: number, previousY: number, t: number) {
    const bank = {
      touchActive: true,
      startPageX: 100,
      startPageY: 0,
      startTimeStamp: 0,
      currentPageX: 100,
      currentPageY: y,
      currentTimeStamp: t,
      previousPageX: 100,
      previousPageY: previousY,
      previousTimeStamp: t === 0 ? 0 : t - 1,
    }
    return {
      nativeEvent: {
        locationX: 100,
        locationY: y,
        pageX: 100,
        pageY: y,
        identifier: 0,
        target: 1,
        timestamp: t,
        touches: [{ identifier: 0, pageX: 100, pageY: y, locationX: 100, locationY: y, timestamp: t }],
        changedTouches: [],
      },
      touchHistory: { touchBank: [bank], numberActiveTouches: 1, indexOfSingleActiveTouch: 0, mostRecentTimeStamp: t },
    }
  }

  async function sheet(node?: React.JSX.Element) {
    const onClose = jest.fn()
    let tree!: ReactTestRenderer.ReactTestRenderer
    await ReactTestRenderer.act(async () => {
      tree = ReactTestRenderer.create(node ?? base({ onClose }))
    })
    const handle = tree.root.find(
      n =>
        typeof n.props.onResponderMove === 'function' &&
        n.findAll(x => flat(x.props.style).width === GRABBER.width).length > 0,
    )
    // Moves the finger through `ys`, one step every `ms` milliseconds, then lifts it.
    const drag = (ys: number[], ms = 100) => {
      ReactTestRenderer.act(() => handle.props.onResponderGrant(touch(0, 0, 0)))
      let previous = 0
      ys.forEach((y, i) => {
        ReactTestRenderer.act(() => handle.props.onResponderMove(touch(y, previous, (i + 1) * ms)))
        previous = y
      })
      ReactTestRenderer.act(() => handle.props.onResponderRelease(touch(previous, previous, (ys.length + 1) * ms)))
    }
    // What the native panel is drawn with, read off the host view rather than the animated wrapper.
    const offset = () => {
      const host = tree.root.find(
        n => (n.type as unknown) === 'View' && flat(n.props.style).backgroundColor === colors.sheet,
      )
      const [shift] = (flat(host.props.style).transform as { translateY: number }[] | undefined) ?? []
      return shift?.translateY
    }
    return { onClose, handle, drag, offset, tree }
  }

  // A caller that hides the sheet when asked to close, as every caller but Convert's running review does.
  async function closingSheet() {
    let show!: () => void
    function Host() {
      const [visible, setVisible] = React.useState(true)
      show = () => setVisible(true)
      return (
        <Sheet visible={visible} onClose={() => setVisible(false)} closeLabel="close">
          <Text>body</Text>
        </Sheet>
      )
    }
    const opened = await sheet(<Host />)
    return { ...opened, show: () => ReactTestRenderer.act(() => show()) }
  }

  it('closes the sheet when pulled down past the threshold', async () => {
    const { onClose, drag } = await sheet()
    drag([40, 120])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('closes on a quick flick that travels less', async () => {
    const { onClose, drag } = await sheet()
    drag([30, 60], 10)
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  // Convert's review refuses to close while a conversion runs. A panel left where the finger let go
  // looks cancelled while the conversion goes on.
  it('puts the panel back when the caller keeps the sheet open after a pull past the threshold', async () => {
    const { onClose, drag, offset } = await sheet()
    drag([150, 400])
    expect(onClose).toHaveBeenCalledTimes(1)
    expect(offset()).toBe(0)
  })

  it('opens again in place after a pull closed it', async () => {
    const { drag, offset, show } = await closingSheet()
    drag([40, 120])
    show()
    expect(offset()).toBe(0)
  })

  // The jest Modal unmounts its children once hidden, which hides the slide out, so this one keeps them.
  it('lets a sheet that does close slide out from where the finger left it', async () => {
    const Kept = ({ visible, children }: { visible: boolean; children: React.ReactNode }) => (
      <View accessibilityState={{ expanded: visible }}>{children}</View>
    )
    jest.spyOn(require('react-native'), 'Modal', 'get').mockReturnValue(Kept)
    const { drag, offset, tree } = await closingSheet()
    drag([40, 120])
    expect(tree.root.findByType(Kept).props.visible).toBe(false)
    expect(offset()).toBe(120)
  })

  it('stays open after a short, slow pull or an upward one, and puts the panel back', async () => {
    const { onClose, drag, offset } = await sheet()
    drag([20, 40])
    expect(offset()).toBe(0)
    drag([-60, -150])
    expect(onClose).not.toHaveBeenCalled()
  })

  it('moves the panel with the finger', async () => {
    const { handle, offset } = await sheet()
    ReactTestRenderer.act(() => handle.props.onResponderGrant(touch(0, 0, 0)))
    ReactTestRenderer.act(() => handle.props.onResponderMove(touch(50, 0, 100)))
    expect(offset()).toBe(50)
  })

  it('still closes with reduced motion, without moving the panel', async () => {
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    const { onClose, handle, drag, offset } = await sheet()
    ReactTestRenderer.act(() => handle.props.onResponderGrant(touch(0, 0, 0)))
    ReactTestRenderer.act(() => handle.props.onResponderMove(touch(50, 0, 100)))
    expect(offset()).toBe(0)
    ReactTestRenderer.act(() => handle.props.onResponderRelease(touch(50, 50, 200)))
    drag([40, 120])
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('slides in with full motion and fades with reduced motion', async () => {
    // Set both ways, since the preset's double is a plain mock that a restore does not reset.
    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false)
    const { tree } = await sheet()
    expect(tree.root.findByType(Modal).props.animationType).toBe('slide')

    jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(true)
    const reduced = await sheet()
    expect(reduced.tree.root.findByType(Modal).props.animationType).toBe('fade')
  })

  // The strip reaches the 44pt target without moving the first child: its bottom padding reaches into
  // the gap and the negative margin gives that gap back.
  it('gives the grabber a 44pt strip and leaves the layout where it was', async () => {
    const { handle } = await sheet()
    const strip = flat(handle.props.style)
    expect((strip.paddingTop as number) + GRABBER.height + (strip.paddingBottom as number)).toBe(44)
    expect(strip.marginBottom).toBe(-(strip.paddingBottom as number))
    expect(strip.paddingTop).toBe(space.xl)
  })
})

it('wraps children in a plain view, so a list inside can still virtualise', () => {
  // AssetPickerSheet holds a FlatList. Wrapping children in a scroll would nest a virtualised list
  // inside a scroll view, which React Native warns about and which breaks the virtualisation.
  const tree = render(
    <Sheet visible onClose={() => undefined} closeLabel="close">
      <FlatList data={[]} renderItem={() => null} />
    </Sheet>,
  )
  const listInsideScroll = tree.root
    .findAllByType(ScrollView)
    .some(node => node.findAllByType(FlatList).length > 0 && node.props.horizontal === undefined)
  expect(listInsideScroll).toBe(false)
})

it('gives the grabber no margin of its own, so the container gap is the only spacing', () => {
  // The container gap spaces the grabber like any other child, so a margin of its own would double
  // the space below it.
  const tree = render(base())
  const grabber = tree.root
    .findAllByType(View)
    .map(node => flat(node.props.style))
    .find(s => s.width === GRABBER.width && s.height === GRABBER.height)
  expect(grabber).toBeDefined()
  expect(grabber!.marginBottom).toBeUndefined()
  expect(panel(render(base())).gap).toBe(space.lg)
})

describe('the basics every other case takes for granted', () => {
  // The one other case mentioning a child asserts that no ScrollView contains a list, which is
  // equally true when there is no list, so this asks whether the content is on screen at all.
  it('renders its content', async () => {
    const tree = render(base())
    expect(tree.root.findAllByType(Text).map(n => n.props.children)).toContain('body')
  })

  // An empty KeyboardAvoidingView beside the panel satisfies a count of avoiders and a prop read
  // off one, so this asks whether the panel is inside it, which is the only thing `keyboard` does.
  it('puts the panel inside the avoider, not merely next to one', async () => {
    const tree = render(base({ keyboard: true }))
    const inside = tree.root
      .findByType(KeyboardAvoidingView)
      .findAllByType(View)
      .map(n => flat(n.props.style))
    expect(inside.some(style => style.backgroundColor === colors.sheet)).toBe(true)
  })

  // A backdrop rendered after the panel covers the whole sheet and leaves it unusable, while the
  // close test still passes, because it finds the Pressable by its label and calls onPress
  // directly, which works just as well through a scrim on top.
  it('draws the backdrop behind the panel, not over it', async () => {
    const json = render(base()).toJSON()
    const children = (Array.isArray(json) ? json : [json]).flatMap(n => n?.children ?? [])
    const order = children
      .filter(c => typeof c === 'object' && c !== null)
      .map(c => (c as { props: { style?: unknown } }).props.style)
      .map(style => (flat(style).backgroundColor === colors.scrim ? 'backdrop' : 'panel'))
    expect(order.indexOf('backdrop')).toBeLessThan(order.indexOf('panel'))
  })

  // `visible` hardcoded to true passes every case that renders an open sheet, so this renders a
  // closed one.
  it('is closed when told to be closed', async () => {
    const tree = render(
      <Sheet visible={false} onClose={() => undefined} closeLabel="close">
        <Text>body</Text>
      </Sheet>,
    )
    expect(tree.root.findByType(Modal).props.visible).toBe(false)
  })

  it('forwards onShow, which is the only way to focus a field inside a Modal', async () => {
    const seen = jest.fn()
    expect(render(base({ onShow: seen })).root.findByType(Modal).props.onShow).toBe(seen)
  })
})
