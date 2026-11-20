import RNFS from 'react-native-fs'

import type { Spec } from '../NativeVoltzDurable'

// The native side under Jest, wired by moduleNameMapper in jest.config.js, over the in-memory
// react-native-fs in __mocks__. A sync rejects for a path that is not there, as open(2) does, and
// changes nothing else: what a power cut keeps is modelled by the tests that need it, from the order of
// these calls.

type MockFs = {
  __rename: (from: string, to: string) => void
  __isFile: (path: string) => boolean
  __isDir: (dir: string) => boolean
}

const fs = (): MockFs => RNFS as unknown as MockFs

const Durable: Spec = {
  syncFile: async (path: string): Promise<void> => {
    if (!fs().__isFile(path)) {
      throw new Error(`ENOENT: ${path}`)
    }
  },
  rename: async (from: string, to: string): Promise<void> => {
    fs().__rename(from, to)
  },
  syncDirectory: async (dir: string): Promise<void> => {
    if (!fs().__isDir(dir)) {
      throw new Error(`ENOENT: ${dir}`)
    }
  },
}

export default Durable
