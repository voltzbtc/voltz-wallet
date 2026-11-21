import type { AgeAnswer, Spec } from '../NativeVoltzAge'

// The stores' age signal under Jest. By default the store marks nobody as regulated, as for most of the
// world, so a suite that renders the app asks once and is told nothing. Tests that need a signal wire
// it here: regulated or not, the range shared, a failure of either call, or a request held in flight.

const NOT_SHARED: AgeAnswer = { status: 'notShared', lower: -1, upper: -1 }

let regulatedAnswer: () => Promise<boolean> = async () => false
let requestAnswer: () => Promise<AgeAnswer> = async () => NOT_SHARED
let held: (() => void) | null = null

export const ageStore = {
  calls: { regulated: 0, request: 0 },
  regulated(on: boolean): void {
    regulatedAnswer = async () => on
  },
  answers(answer: AgeAnswer): void {
    requestAnswer = async () => answer
  },
  shares(lower: number, upper: number): void {
    ageStore.regulated(true)
    ageStore.answers({ status: 'shared', lower, upper })
  },
  regulatedFails(code: string): void {
    regulatedAnswer = async () => {
      throw Object.assign(new Error('age signal failed'), { code })
    }
  },
  requestFails(code: string): void {
    requestAnswer = async () => {
      throw Object.assign(new Error('age signal failed'), { code })
    }
  },
  holds(): void {
    const gate = new Promise<void>(resolve => {
      held = resolve
    })
    const next = requestAnswer
    requestAnswer = async () => {
      await gate
      return next()
    }
  },
  release(): void {
    held?.()
    held = null
  },
  reset(): void {
    regulatedAnswer = async () => false
    requestAnswer = async () => NOT_SHARED
    held = null
    ageStore.calls = { regulated: 0, request: 0 }
  },
}

const NativeVoltzAge: Pick<Spec, 'regulated' | 'request'> = {
  regulated: () => {
    ageStore.calls.regulated += 1
    return regulatedAnswer()
  },
  request: () => {
    ageStore.calls.request += 1
    return requestAnswer()
  },
}

export default NativeVoltzAge
