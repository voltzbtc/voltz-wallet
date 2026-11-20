import { StyleSheet, Text } from 'react-native'
import { touch } from '../../src/theme'
import type ReactTestRenderer from 'react-test-renderer'

type Instance = ReactTestRenderer.ReactTestInstance
type Style = {
  flexDirection?: string
  flexShrink?: number
  flex?: number
  flexBasis?: unknown
  maxWidth?: unknown
  minWidth?: unknown
  width?: unknown
  position?: string
}

// The money figures in a tree: texts on one line that shrink to fit, the shape Figure draws.
export function figuresIn(root: Instance): Instance[] {
  return root
    .findAllByType(Text)
    .filter(n => n.props.numberOfLines === 1 && n.props.adjustsFontSizeToFit === true)
}

const styleOf = (node: Instance): Style => (StyleSheet.flatten(node.props.style) ?? {}) as Style

const share = (value: unknown): number | null =>
  typeof value === 'string' && /^\d+(\.\d+)?%$/.test(value) ? parseFloat(value) : null
const shrinks = (style: Style): boolean => (style.flexShrink ?? 0) >= 1 || (style.flex ?? 0) > 0
// A floor of a touch target is narrower than any row it sits in, so it never pushes a figure out.
const lowFloor = (style: Style): boolean =>
  style.minWidth === undefined || (typeof style.minWidth === 'number' && style.minWidth <= touch.min)
const capped = (style: Style): boolean => {
  const cap = share(style.maxWidth)
  return cap !== null && cap <= 100
}

// A box that cannot be pushed past its row: it shrinks, or a share of the row caps it.
function givesWay(style: Style): boolean {
  return (shrinks(style) || capped(style)) && lowFloor(style)
}

// Whether a box beside the figure's side leaves the figure its share of the row. A box keeps its
// width by default (React Native's flexShrink is 0), and one that shrinks from its own width shrinks
// in step with the figure, so a long label at a large text size takes the row either way. It leaves
// the figure its share when a number of points bounds it (an icon, a badge), when a share of the row
// caps it, when it takes only what is left (a zero basis), or when it shrinks from its own width
// beside a figure side that never shrinks, so every point the row lacks comes out of the label.
// FigureRow lays its two boxes out the last way. That side is capped as well: figuresHeldOut asks
// this only of a row whose figure side gives way, and a side that never shrinks gives way only by
// its cap.
function leavesRoom(sibling: Instance, figureSide: Style): boolean {
  const style = styleOf(sibling)
  if (style.position === 'absolute') {
    return true
  }
  if ([style.width, style.maxWidth, sibling.props.width].some(size => typeof size === 'number')) {
    return true
  }
  const cap = share(style.maxWidth)
  if (cap !== null && cap < 100) {
    return true
  }
  if (style.flexBasis === 0 || ((style.flex ?? 0) > 0 && style.flexBasis === undefined)) {
    return true
  }
  return shrinks(style) && (style.minWidth ?? 0) === 0 && !shrinks(figureSide)
}

const isRow = (style: Style): boolean =>
  style.flexDirection === 'row' || style.flexDirection === 'row-reverse'

// Each figure against every row it sits in, nearest first, as Yoga lays them out. React Native's
// default flexShrink is 0, so a box between the figure and a row that keeps its width lays the figure
// out at its full width past the row's edge, where it is cut and never shrinks; and a box beside the
// figure's side that keeps its width, a label at the largest text size, squeezes the figure to a few
// points. A row inside another row is the figure's side in the outer one. Returns what holds out, by
// the figure's text, so a failure names the figure.
export function figuresHeldOut(root: Instance): string[] {
  const figures = figuresIn(root)
  if (figures.length === 0) {
    return ['no money figure was drawn']
  }
  const held: string[] = []
  for (const figure of figures) {
    // The native box the figure draws, which is what its row lays out beside its siblings.
    let chain: Instance[] = [typeof figure.type === 'string' ? figure : hostChildren(figure)[0]]
    for (let node = hostParent(chain[0]); node; node = hostParent(node)) {
      if (!isRow(styleOf(node))) {
        chain.push(node)
        continue
      }
      const side = chain[chain.length - 1]
      const besides = hostChildren(node).filter(child => child !== side)
      const boxesGiveWay = chain.every(box => givesWay(styleOf(box)))
      if (!boxesGiveWay || !besides.every(box => leavesRoom(box, styleOf(side)))) {
        held.push(textOf(figure))
        break
      }
      chain = [node]
    }
  }
  return held
}

// The boxes Yoga lays out inside a native box, through any components between them.
export function hostChildren(node: Instance): Instance[] {
  return node.children.flatMap(child =>
    typeof child === 'string' ? [] : typeof child.type === 'string' ? [child] : hostChildren(child),
  )
}

export function textOf(node: Instance): string {
  return node.children
    .map(child => (typeof child === 'string' ? child : textOf(child)))
    .join('')
}

// The nearest native box around a node, which is what Yoga lays it out in.
export function hostParent(node: Instance): Instance | null {
  for (let up = node.parent; up; up = up.parent) {
    if (typeof up.type === 'string') {
      return up
    }
  }
  return null
}

export const flat = (node: Instance | null): Style => (node ? styleOf(node) : {})
