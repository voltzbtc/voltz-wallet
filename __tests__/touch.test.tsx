import React from 'react'
import ReactTestRenderer from 'react-test-renderer'
import { AccessibilityInfo, Text } from 'react-native'
import { Touch } from '../src/components/Touch'
import { alpha, press, space, touch } from '../src/theme'

// Answers both ways, and starts off. A double stuck on "not reduced" would let the reduced-motion
// case pass against a component that never asked.
let reduceMotion = false
beforeEach(() => {
  reduceMotion = false
  jest
    .spyOn(AccessibilityInfo, 'isReduceMotionEnabled')
    .mockImplementation(() => Promise.resolve(reduceMotion))
  jest
    .spyOn(AccessibilityInfo, 'addEventListener')
    .mockImplementation((() => ({ remove: () => undefined })) as never)
})
afterEach(() => jest.restoreAllMocks())

async function render(node: React.JSX.Element): Promise<ReactTestRenderer.ReactTestRenderer> {
  let tree!: ReactTestRenderer.ReactTestRenderer
  await ReactTestRenderer.act(async () => {
    tree = ReactTestRenderer.create(node)
  })
  return tree
}

// Finds the Pressable by its onPress, because Pressable renders as an inner View in RN 0.86 and
// findByType never sees it.
const target = (tree: ReactTestRenderer.ReactTestRenderer) =>
  tree.root.find(n => typeof n.props.onPress === 'function' && n.props.accessibilityRole != null)

const flat = (style: unknown): Record<string, unknown> =>
  Object.assign({}, ...[style].flat(Infinity).filter(s => s && typeof s === 'object'))

const resting = (tree: ReactTestRenderer.ReactTestRenderer) =>
  flat(target(tree).props.style({ pressed: false }))
const held = (tree: ReactTestRenderer.ReactTestRenderer) =>
  flat(target(tree).props.style({ pressed: true }))

function base(extra: Partial<React.ComponentProps<typeof Touch>> = {}): React.JSX.Element {
  return (
    <Touch onPress={() => undefined} {...extra}>
      <Text>tap</Text>
    </Touch>
  )
}

it('is at least 44pt tall, which is the whole reason it exists', async () => {
  // The floor lives in the component rather than in a rule. In prose, every future control has to
  // remember it; here none of them can forget.
  expect(resting(await render(base())).minHeight).toBe(touch.min)
})

it('renders what it was given, since a target with nothing in it is not a target', async () => {
  const tree = await render(base())
  expect(tree.root.findAllByType(Text).map(n => n.props.children)).toContain('tap')
})

it('fires on press', async () => {
  let fired = 0
  const tree = await render(base({ onPress: () => (fired += 1) }))
  target(tree).props.onPress()
  expect(fired).toBe(1)
})

describe('what a finger changes', () => {
  it('a row lights up, and never shrinks or fades', async () => {
    // Dimming a row reads as the row being unavailable, which is the opposite of what a press means.
    // And a line that shrinks drags its neighbours visually, reading as the list moving rather than
    // as this one being pressed.
    const style = held(await render(base({ feedback: 'row' })))
    expect(style.backgroundColor).toBe(press.row)
    expect(style.opacity).toBeUndefined()
    expect(style.transform).toBeUndefined()
  })

  it('a surface shrinks, and dims only subtly because the shrink carries it', async () => {
    const style = held(await render(base({ feedback: 'surface' })))
    expect(style.opacity).toBe(press.scaled)
    expect(style.transform).toEqual([{ scale: press.scale }])
  })

  it('a link dims, having no surface to change', async () => {
    expect(held(await render(base({ feedback: 'link' }))).opacity).toBe(press.dim)
  })

  it('changes nothing at rest, so the feedback means something', async () => {
    // Without this, every assertion above would pass against a component that applied the pressed
    // style permanently.
    const style = resting(await render(base({ feedback: 'surface' })))
    expect(style.opacity).toBeUndefined()
    expect(style.transform).toBeUndefined()
    expect(resting(await render(base({ feedback: 'row' }))).backgroundColor).toBeUndefined()
  })
})

describe('reduced motion', () => {
  it('drops the shrink, since scale is movement', async () => {
    reduceMotion = true
    const style = held(await render(base({ feedback: 'surface' })))
    expect(style.transform).toBeUndefined()
  })

  it('keeps the dim, since a press with no answer at all is worse for everybody', async () => {
    // Reduced motion asks for less movement, not for less feedback. Removing both would leave the
    // person who turned it on unable to tell whether the tap registered.
    reduceMotion = true
    expect(held(await render(base({ feedback: 'surface' }))).opacity).toBe(press.scaled)
  })

  it('leaves the shrink alone when the setting is off', async () => {
    expect(held(await render(base({ feedback: 'surface' }))).transform).toEqual([
      { scale: press.scale },
    ])
  })
})

describe('what a screen reader hears', () => {
  it('is a button unless told otherwise', async () => {
    expect(target(await render(base())).props.accessibilityRole).toBe('button')
    expect(target(await render(base({ role: 'switch' }))).props.accessibilityRole).toBe('switch')
  })

  it('announces state, which 100 of the app 108 targets do not', async () => {
    const state = target(await render(base({ state: { selected: true } }))).props.accessibilityState
    expect(state.selected).toBe(true)
  })

  it('keeps the disabled state when a caller passes state of its own', async () => {
    // Replacing rather than merging would erase the disabled flag the same call declared, so a
    // control that refuses the press would still announce itself as available.
    const state = target(await render(base({ disabled: true, state: { selected: true } }))).props
      .accessibilityState
    expect(state).toEqual({ disabled: true, selected: true })
  })

  it('carries a label only when given one, since text inside already announces itself', async () => {
    // A label replaces the announcement rather than adding to it, so setting one on a target that
    // contains readable text usually makes it worse.
    expect(target(await render(base())).props.accessibilityLabel).toBeUndefined()
    expect(target(await render(base({ label: 'copy' }))).props.accessibilityLabel).toBe('copy')
  })
})

describe('disabled', () => {
  it('dims to the refused level and refuses the press', async () => {
    const tree = await render(base({ disabled: true }))
    expect(resting(tree).opacity).toBe(alpha.disabled)
    expect(target(tree).props.disabled).toBe(true)
  })

  it('shows no press feedback, so nothing suggests the tap did something', async () => {
    expect(
      held(await render(base({ disabled: true, feedback: 'surface' }))).transform,
    ).toBeUndefined()
  })
})

describe('what every target inherits without asking', () => {
  // The default governs every target that does not choose. Set to `surface`, the component would
  // shrink a list row, which its own comment says never to do.
  it('defaults to row, since most targets are a line in a list', async () => {
    const style = held(await render(base()))
    expect(style.backgroundColor).toBe(press.row)
    expect(style.transform).toBeUndefined()
  })

  // With `style` after the pressed entry, a caller passing its own backgroundColor kills the row
  // feedback and one passing opacity kills the link feedback. Targets that change a background pass
  // their resting one through `style`, so this is not hypothetical.
  it('lets the press win over a caller style, not the other way round', async () => {
    const tree = await render(
      base({ feedback: 'row', style: { backgroundColor: 'rebeccapurple' } }),
    )
    expect(resting(tree).backgroundColor).toBe('rebeccapurple')
    expect(held(tree).backgroundColor).toBe(press.row)
  })

  it('is 44 on both axes, since the rule is 44 by 44', async () => {
    // Setting only the height would leave an icon in a header 24 wide and 44 tall, so the floor
    // covers both axes.
    const style = resting(await render(base()))
    expect(style.minHeight).toBe(touch.min)
    expect(style.minWidth).toBe(touch.min)
  })

  it('centres its content, which four screens have to override when migrating', async () => {
    // Vertical in the common case. A caller writing flexDirection: 'row' turns it horizontal, and
    // then passes its own alignment unless a child with `flex: 1` takes the slack.
    expect(resting(await render(base())).justifyContent).toBe('center')
  })
})

describe('a target that does not answer on its own', () => {
  it('changes nothing under the finger', async () => {
    // A sheet backdrop should not flash when a finger lands on it, and a target inside another target
    // would answer twice. Not a fourth treatment, a declaration.
    const style = held(await render(base({ feedback: 'none' })))
    expect(style.backgroundColor).toBeUndefined()
    expect(style.opacity).toBeUndefined()
    expect(style.transform).toBeUndefined()
  })

  it('still carries the floor and the role, since it is still a target', async () => {
    const tree = await render(base({ feedback: 'none' }))
    expect(resting(tree).minHeight).toBe(touch.min)
    expect(target(tree).props.accessibilityRole).toBe('button')
  })
})

describe('what a migration would otherwise drop', () => {
  it('extends the touch area past the box, which style cannot do', async () => {
    // The floor grows the box; this reaches outside it, which is the case for a small icon that
    // must not grow.
    expect(target(await render(base({ hitSlop: 10 }))).props.hitSlop).toBe(10)
  })

  it('passes a long press through, which would have vanished in silence', async () => {
    const held2 = jest.fn()
    target(await render(base({ onLongPress: held2 }))).props.onLongPress()
    expect(held2).toHaveBeenCalled()
  })

  it('passes testID through, which would have broken loudly', async () => {
    expect(target(await render(base({ testID: 'pay' }))).props.testID).toBe('pay')
  })
})

describe('a drawn size under the floor', () => {
  // minWidth and minHeight beat width and height in Yoga regardless of array order, so a caller
  // passing its own 22pt circle after the floor does not undo it. Without this prop the three remove
  // buttons would double in diameter inside drawers sized for 22, with the suite green.
  it('replaces the floor with the size it was given', async () => {
    const style = resting(await render(base({ size: 22, hitSlop: space.md })))
    expect(style.minHeight).toBe(22)
    expect(style.minWidth).toBe(22)
  })

  it('leaves the floor alone when not given, which is every other call site', async () => {
    const style = resting(await render(base()))
    expect(style.minHeight).toBe(touch.min)
    expect(style.minWidth).toBe(touch.min)
  })

  it('refuses a size that hit slop does not carry to 44, so it cannot be an opt-out', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await render(base({ size: 22 }))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('under the 44 floor'))
    warn.mockRestore()
  })

  it('says nothing when the slop does carry it, which is the shape the three sites use', async () => {
    // 22 drawn plus 12 of slop on each side is 46, over the floor, and draws the same 22pt circle.
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined)
    await render(base({ size: 22, hitSlop: space.md }))
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

it('lets the caller win over its own disabled dimming, which the dice keypad depends on', async () => {
  // The dice clear and backspace controls are disabled AND invisible at zero rolls: they hold their
  // place in the counter row so it does not jump when the first roll lands. `alpha.disabled` is 0.4,
  // so with the component's dimming applied after the caller's style they would sit there at 40%.
  const style = resting(await render(base({ disabled: true, style: { opacity: 0 } })))
  expect(style.opacity).toBe(0)
})
