import type { Spec } from '../NativeVoltzCapture'

// The capture bridge under Jest, with the slice of UIKit it relays. Not wired in jest.setup.js: a test
// about capture asks for it, and every other suite runs as Android does, with no module at all. Like
// the real emitter it reaches only handlers subscribed at that moment and drops the rest, and a read
// stays in flight until a test answers it, so a screen that drew the words early has nowhere to hide.

type Pending = { resolve: (captured: boolean) => void; reject: (error: Error) => void }

const capturedHandlers = new Set<(captured: boolean) => void>()
const screenshotHandlers = new Set<() => void>()
let pending: Pending[] = []

export const device = {
  // Answers the oldest read still in flight.
  answer(captured: boolean): void {
    pending.shift()?.resolve(captured)
  },
  fail(): void {
    pending.shift()?.reject(new Error('read failed'))
  },
  capturedChange(captured: boolean): void {
    capturedHandlers.forEach(handler => handler(captured))
  },
  screenshot(): void {
    screenshotHandlers.forEach(handler => handler())
  },
  readsInFlight: (): number => pending.length,
  listeners: (): number => capturedHandlers.size + screenshotHandlers.size,
  reset(): void {
    capturedHandlers.clear()
    screenshotHandlers.clear()
    pending = []
  },
}

// The declared EventSubscription is the legacy emitter's class; callers only ever call remove().
function subscription(remove: () => void): ReturnType<Spec['onScreenshot']> {
  return { remove } as unknown as ReturnType<Spec['onScreenshot']>
}

const NativeVoltzCapture: Pick<Spec, 'isCaptured' | 'onCapturedChange' | 'onScreenshot'> = {
  isCaptured: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
  onCapturedChange: handler => {
    const listener = handler as (captured: boolean) => void
    capturedHandlers.add(listener)
    return subscription(() => capturedHandlers.delete(listener))
  },
  onScreenshot: handler => {
    const listener = handler as () => void
    screenshotHandlers.add(listener)
    return subscription(() => screenshotHandlers.delete(listener))
  },
}

export default NativeVoltzCapture
