import type { Spec } from '../NativeVoltzReview'

// The stores' review prompt under Jest. It counts each prepare and each launch (`calls`), and a test
// can make either fail, or run something while a prepare is in flight.

let launchAnswer: () => Promise<void> = async () => undefined
let prepareAnswer: () => Promise<boolean> = async () => true
let duringPrepare: () => void | Promise<void> = () => undefined

export const reviewStore = {
  prepares: 0,
  calls: 0,
  fails(code: string): void {
    launchAnswer = async () => {
      throw Object.assign(new Error('review failed'), { code })
    }
  },
  prepareFails(code: string): void {
    prepareAnswer = async () => {
      throw Object.assign(new Error('review unavailable'), { code })
    }
  },
  prepareAnswers(ready: boolean): void {
    prepareAnswer = async () => ready
  },
  whilePreparing(run: () => void | Promise<void>): void {
    duringPrepare = run
  },
  reset(): void {
    launchAnswer = async () => undefined
    prepareAnswer = async () => true
    duringPrepare = () => undefined
    reviewStore.prepares = 0
    reviewStore.calls = 0
  },
}

const NativeVoltzReview: Pick<Spec, 'prepare' | 'launch'> = {
  prepare: async () => {
    reviewStore.prepares += 1
    await duringPrepare()
    return prepareAnswer()
  },
  launch: () => {
    reviewStore.calls += 1
    return launchAnswer()
  },
}

export default NativeVoltzReview
