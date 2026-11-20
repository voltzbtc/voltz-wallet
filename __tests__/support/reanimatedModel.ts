// A stand-in for react-native-reanimated that keeps two behaviours of the real library (4.5) which an
// inert double hides, for suites that test how a component honours reduce motion:
//
// - With the system setting on, an animation without `reduceMotion: ReduceMotion.Never` ends on its
//   first frame: a timing jumps to its end value, a delay is skipped, and a sequence runs only its last
//   step (src/animation/util.ts, delay.ts, sequence.ts). A child with no option of its own takes its
//   parent's answer.
// - An animated style's keys from the first render stay on the view, and a later style only
//   overwrites the keys it sets (PropsFilter.tsx keeps the first props, and native updates are merged).
//
// Timings are linear and read the fake clock, so a test advances the timers and renders again to see a
// style at a given moment. The setting is read when an animation is evaluated, as Reanimated reads it
// when the animation starts.
import React from 'react'
import { Text, View } from 'react-native'

type Mode = 'system' | 'always' | 'never' | undefined

type Anim =
  | { kind: 'timing'; to: number; duration: number; reduceMotion: Mode }
  | { kind: 'delay'; ms: number; next: Anim; reduceMotion: Mode }
  | { kind: 'sequence'; steps: Anim[]; reduceMotion: Mode }

let systemReduced = false

export function setSystemReduceMotion(on: boolean): void {
  systemReduced = on
}

const isAnim = (v: unknown): v is Anim => typeof v === 'object' && v !== null && 'kind' in v

function reducedFor(own: Mode, inherited: boolean | undefined): boolean {
  if (own === 'never') {
    return false
  }
  if (own === 'always') {
    return true
  }
  return own === 'system' ? systemReduced : inherited ?? systemReduced
}

// A reduced step of a sequence is skipped, except the last, so the sequence still ends where it should.
function stepsOf(anim: Extract<Anim, { kind: 'sequence' }>, reduced: boolean): Anim[] {
  const last = anim.steps.length - 1
  return anim.steps.filter((s, i) => i === last || !reducedFor(s.reduceMotion, reduced))
}

function durationOf(anim: Anim, inherited?: boolean): number {
  const reduced = reducedFor(anim.reduceMotion, inherited)
  switch (anim.kind) {
    case 'timing':
      return reduced ? 0 : anim.duration
    case 'delay':
      return (reduced ? 0 : anim.ms) + durationOf(anim.next, reduced)
    case 'sequence':
      return stepsOf(anim, reduced).reduce((sum, s) => sum + durationOf(s, reduced), 0)
  }
}

function valueAt(anim: Anim, from: number, t: number, inherited?: boolean): number {
  const reduced = reducedFor(anim.reduceMotion, inherited)
  switch (anim.kind) {
    case 'timing': {
      if (reduced || anim.duration <= 0) {
        return anim.to
      }
      const p = Math.min(1, Math.max(0, t / anim.duration))
      return from + (anim.to - from) * p
    }
    case 'delay': {
      const wait = reduced ? 0 : anim.ms
      return t < wait ? from : valueAt(anim.next, from, t - wait, reduced)
    }
    case 'sequence': {
      const steps = stepsOf(anim, reduced)
      let start = 0
      let value = from
      for (let i = 0; i < steps.length; i++) {
        const length = durationOf(steps[i], reduced)
        if (t < start + length || i === steps.length - 1) {
          return valueAt(steps[i], value, t - start, reduced)
        }
        value = valueAt(steps[i], value, Infinity, reduced)
        start += length
      }
      return value
    }
  }
}

type Shared = { value: unknown; cancel: () => void }

function makeShared(initial: unknown): Shared {
  let base = initial
  let running: { anim: Anim; from: number; at: number } | null = null
  const current = () =>
    running ? valueAt(running.anim, running.from, Date.now() - running.at) : base
  return {
    get value() {
      return current()
    },
    set value(next: unknown) {
      if (isAnim(next)) {
        running = { anim: next, from: Number(current()), at: Date.now() }
      } else {
        running = null
        base = next
      }
    },
    cancel() {
      base = current()
      running = null
    },
  }
}

// What the view shows: the first render's keys, each overwritten by the latest style that sets it.
function useShown<T extends object>(updater: () => T): T {
  const shown = React.useRef<T | null>(null)
  shown.current = { ...(shown.current ?? {}), ...updater() } as T
  return shown.current
}

export function reanimatedModel() {
  return {
    __esModule: true,
    default: { View, Text, createAnimatedComponent: (c: unknown) => c },
    ReduceMotion: { System: 'system', Always: 'always', Never: 'never' },
    Easing: {
      out: (f: unknown) => f,
      in: (f: unknown) => f,
      inOut: (f: unknown) => f,
      ease: 'ease',
      cubic: 'cubic',
      linear: 'linear',
      back: () => 'back',
      bezier: () => 'bezier',
    },
    cancelAnimation: (v: Shared) => v.cancel(),
    useSharedValue: (initial: unknown) => React.useState(() => makeShared(initial))[0],
    useAnimatedStyle: useShown,
    useAnimatedProps: useShown,
    withTiming: (to: number, config?: { duration?: number; reduceMotion?: Mode }): Anim => ({
      kind: 'timing',
      to,
      duration: config?.duration ?? 300,
      reduceMotion: config?.reduceMotion,
    }),
    withDelay: (ms: number, next: Anim, reduceMotion?: Mode): Anim => ({
      kind: 'delay',
      ms,
      next,
      reduceMotion,
    }),
    withSequence: (...args: (Anim | Mode)[]): Anim => {
      const reduceMotion = typeof args[0] === 'string' ? (args.shift() as Mode) : undefined
      return { kind: 'sequence', steps: args as Anim[], reduceMotion }
    },
  }
}
