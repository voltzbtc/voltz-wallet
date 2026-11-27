import RNFS from 'react-native-fs'
import type { Spec } from '../NativeVoltzShare'

// The Android image share under Jest, wired by the tests that ask for it. Like the platform it reads
// the file it is handed, so a share of a card that was never written, or was removed before the
// chooser started, rejects here as it would on a phone. Each share is kept with the bytes it found.

export type SharedImage = { path: string; text: string; title: string; content: string }

let shared: SharedImage[] = []
let failure: string | null = null

export const shareSheet = {
  shared: (): SharedImage[] => shared,
  rejects(message: string): void {
    failure = message
  },
  reset(): void {
    shared = []
    failure = null
  },
}

const NativeVoltzShare: Pick<Spec, 'shareImage'> = {
  shareImage: async (path, text, title) => {
    if (failure !== null) {
      throw new Error(failure)
    }
    if (!(await RNFS.exists(path))) {
      throw new Error('E_FAILED: no such file')
    }
    shared.push({ path, text, title, content: await RNFS.readFile(path) })
  },
}

export default NativeVoltzShare
