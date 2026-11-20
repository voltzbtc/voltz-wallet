// Native module, absent in Jest. Backed by an in-memory fs so tests exercise persistence for real
// instead of stubbing it out.
let files: Record<string, string> = {}
// Directories made with mkdir. A write into a directory nobody made rejects, as the native writes do,
// a directory stays once its files are gone, and the app's Documents directory always exists.
let dirs = new Set<string>()
const DOCUMENTS = '/mock/Documents'

const dirExists = (dir: string): boolean =>
  dir === DOCUMENTS || [...dirs].some(made => made === dir || made.startsWith(`${dir}/`))
const refuseMissingDir = (path: string): void => {
  const dir = path.slice(0, path.lastIndexOf('/'))
  if (!dirExists(dir)) {
    throw new Error(`ENOENT: no such directory ${dir}`)
  }
}

export default {
  DocumentDirectoryPath: DOCUMENTS,
  exists: async (path: string): Promise<boolean> => path in files || dirs.has(path),
  readFile: async (path: string): Promise<string> => {
    if (!(path in files)) {
      throw new Error(`ENOENT: ${path}`)
    }
    return files[path]
  },
  writeFile: async (path: string, content: string): Promise<void> => {
    refuseMissingDir(path)
    files[path] = content
  },
  // Rejects as the native modules do: unlink on a missing path, and moveFile onto a path that exists,
  // which iOS refuses (NSFileManager moveItemAtPath) while Android replaces, so code that passes here
  // passes on both.
  // A directory goes with everything in it, as both native modules do.
  unlink: async (path: string): Promise<void> => {
    if (dirs.has(path)) {
      Object.keys(files)
        .filter(file => file.startsWith(`${path}/`))
        .forEach(file => delete files[file])
      dirs = new Set([...dirs].filter(dir => dir !== path && !dir.startsWith(`${path}/`)))
      return
    }
    if (!(path in files)) {
      throw new Error(`ENOENT: ${path}`)
    }
    delete files[path]
  },
  moveFile: async (from: string, to: string): Promise<void> => {
    if (!(from in files)) {
      throw new Error(`ENOENT: ${from}`)
    }
    if (to in files) {
      throw new Error(`EEXIST: ${to}`)
    }
    refuseMissingDir(to)
    files[to] = files[from]
    delete files[from]
  },
  // connectSpark creates the SDK storage dir before connecting, and the call site cannot recover
  // from a missing stub, because "mkdir is not a function" throws synchronously, past its
  // .catch(). Succeeds unconditionally, intermediate directories included, as the native one does.
  mkdir: async (dir: string): Promise<void> => {
    dirs.add(dir)
  },
  // The files directly inside a directory, as the native readDir lists them. A directory that does not
  // exist rejects, as both native modules do (contentsOfDirectoryAtPath on iOS, "Folder does not
  // exist" on Android).
  readDir: async (dir: string): Promise<{ name: string; path: string }[]> => {
    if (!dirExists(dir)) {
      throw new Error(`ENOENT: ${dir}`)
    }
    return Object.keys(files)
      .filter(path => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes('/'))
      .map(path => ({ name: path.slice(dir.length + 1), path }))
  },
  // Refuses a destination that exists, as iOS does (NSFileManager copyItemAtPath).
  copyFile: async (from: string, to: string): Promise<void> => {
    if (!(from in files)) {
      throw new Error(`ENOENT: ${from}`)
    }
    if (to in files) {
      throw new Error(`EEXIST: ${to}`)
    }
    refuseMissingDir(to)
    files[to] = files[from]
  },
  // rename(2), which the app reaches through specs/NativeVoltzDurable.ts rather than RNFS, so it sits
  // outside the methods a test spies on: replaces a file at `to` in one step, on both platforms.
  __rename: (from: string, to: string): void => {
    if (!(from in files)) {
      throw new Error(`ENOENT: ${from}`)
    }
    refuseMissingDir(to)
    files[to] = files[from]
    delete files[from]
  },
  __isFile: (path: string): boolean => path in files,
  __isDir: (dir: string): boolean => dirExists(dir),
  __reset: (): void => {
    files = {}
    dirs = new Set()
  },
}
