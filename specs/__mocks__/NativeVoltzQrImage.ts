import RNFS from 'react-native-fs'
import type { Spec } from '../NativeVoltzQrImage'

// The reader under Jest, wired by the tests that ask for it. Like the platform it reads a file: a URI
// with nothing behind it rejects, so code that discards the picked image before reading it fails here
// as it would on a phone. A reader may also stay in flight until a test lets it go.

let answer: () => Promise<string[]> = async () => []
let held: (() => void) | null = null

export const reader = {
  finds(codes: string[]): void {
    answer = async () => codes
  },
  rejects(message: string): void {
    answer = async () => {
      throw new Error(message)
    }
  },
  holds(): void {
    const gate = new Promise<void>(resolve => {
      held = resolve
    })
    const next = answer
    answer = async () => {
      await gate
      return next()
    }
  },
  release(): void {
    held?.()
    held = null
  },
  reset(): void {
    answer = async () => []
    held = null
  },
}

const NativeVoltzQrImage: Pick<Spec, 'decode'> = {
  decode: async uri => {
    const path = uri.replace(/^file:\/\//, '')
    if (!(await RNFS.exists(path))) {
      throw new Error('The file could not be opened')
    }
    return answer()
  },
}

export default NativeVoltzQrImage
