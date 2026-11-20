// Who hears that spark.ts restarted the live connection's wait for a sync after a return from the
// background. Apart from spark.ts so a hook can listen without depending on every stand-in for
// spark.ts that a screen's test builds, and apart from onSparkConnected, whose listeners run work
// meant once per connect. sparkNoteResumed is the one sender.
const listeners = new Set<() => void>()

export function onSparkResumed(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function announceResumed(): void {
  listeners.forEach(cb => cb())
}
