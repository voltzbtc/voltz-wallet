// Who hears that the display currency changed. Apart from settings.ts so a view can listen without
// depending on every stand-in for settings.ts that a screen's test builds. saveDisplayCurrency is the
// one sender, and it sends after the write, so a read made in the callback sees the new currency.
const listeners = new Set<() => void>()

export function onDisplayCurrencyChanged(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function announceDisplayCurrencyChanged(): void {
  listeners.forEach(cb => cb())
}
