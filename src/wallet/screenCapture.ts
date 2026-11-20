import NativeVoltzCapture from '../../specs/NativeVoltzCapture'

// The one reader of the capture bridge. Only iOS has it: Android blocks capture at the window with
// FLAG_SECURE, and a binary without the module has nothing to report either, so with none of these
// signals the words are drawn at once.

export function captureWatched(): boolean {
  return NativeVoltzCapture !== null
}

export function readCaptured(): Promise<boolean> {
  return NativeVoltzCapture ? NativeVoltzCapture.isCaptured() : Promise.resolve(false)
}

export function onCapturedChange(listener: (captured: boolean) => void): () => void {
  const subscription = NativeVoltzCapture?.onCapturedChange(listener)
  return () => subscription?.remove()
}

export function onScreenshot(listener: () => void): () => void {
  const subscription = NativeVoltzCapture?.onScreenshot(listener)
  return () => subscription?.remove()
}
