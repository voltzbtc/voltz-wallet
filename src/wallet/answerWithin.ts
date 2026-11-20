// The read's answer, or null once `ms` pass without one. The read itself keeps running.
export function answerWithin<T>(read: Promise<T | null>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), ms)
  })
  return Promise.race([read, bound]).finally(() => clearTimeout(timer))
}
