import type { Spec } from '../NativeVoltzReview'

// The stores' review prompt under Jest. It counts each request, and a test can make the request fail.

let answer: () => Promise<void> = async () => undefined

export const reviewStore = {
  calls: 0,
  fails(code: string): void {
    answer = async () => {
      throw Object.assign(new Error('review failed'), { code })
    }
  },
  reset(): void {
    answer = async () => undefined
    reviewStore.calls = 0
  },
}

const NativeVoltzReview: Pick<Spec, 'request'> = {
  request: () => {
    reviewStore.calls += 1
    return answer()
  },
}

export default NativeVoltzReview
