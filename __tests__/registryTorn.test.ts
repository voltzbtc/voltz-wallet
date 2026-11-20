import RNFS from 'react-native-fs'
import * as Keychain from 'react-native-keychain'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import { isUnreadableFile } from '../src/wallet/durableFile'
import {
  ensureRegistered,
  getActiveWalletId,
  loadRegistry,
  removeWalletEntry,
  reorderWallets,
  replaceUnreadableRegistry,
  setActiveWallet,
  type Registry,
} from '../src/wallet/walletRegistry'

// Jest maps the spec to its in-memory double, which is never null.
const Durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>

// The list of wallets over the in-memory RNFS mock, which refuses a move onto a path that exists and
// an unlink of a path that does not, as the native modules do. A list that cannot be read is never
// read as empty, and nothing is written over it.

type Fs = typeof RNFS
type RegistryModule = typeof import('../src/wallet/walletRegistry')

const FILE = `${RNFS.DocumentDirectoryPath}/wallets.json`
const TMP = `${FILE}.tmp`
const ASIDE = `${FILE}.unreadable`
const TMP_ASIDE = `${TMP}.unreadable`
const PATHS = [FILE, TMP, ASIDE, TMP_ASIDE]

const OLD: Registry = {
  wallets: [
    { id: 'primary', fingerprint: 'aaaa' },
    { id: 'w_1', fingerprint: 'bbbb' },
  ],
  active: 'primary',
}
const OLD_TEXT = JSON.stringify(OLD)
// Cut mid write, and a finished file of a shape this build cannot read.
const TORN = OLD_TEXT.slice(0, 30)
const OTHER_SHAPE = '{"wallets":"x"}'

const realWrite = RNFS.writeFile.bind(RNFS)

async function rawOf(fs: Fs, path: string): Promise<string | null> {
  return (await fs.exists(path)) ? fs.readFile(path, 'utf8') : null
}

async function diskOf(fs: Fs = RNFS): Promise<(string | null)[]> {
  return Promise.all(PATHS.map(path => rawOf(fs, path)))
}

const reset = (fs: Fs = RNFS): void => (fs as unknown as { __reset: () => void }).__reset()

async function outcome<T>(run: Promise<T>): Promise<T | 'unreadable' | 'failed'> {
  try {
    return await run
  } catch (err) {
    return isUnreadableFile(err) ? 'unreadable' : 'failed'
  }
}

beforeEach(() => {
  reset()
  jest.restoreAllMocks()
  jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
})

afterEach(() => {
  jest.mocked(Keychain.hasGenericPassword).mockImplementation(async () => false)
})

const unreadable: [string, () => Promise<void>][] = [
  ['a torn file', () => realWrite(FILE, TORN, 'utf8')],
  ['a file of another shape', () => realWrite(FILE, OTHER_SHAPE, 'utf8')],
  ['a torn copy with no file', () => realWrite(TMP, TORN, 'utf8')],
  ['a torn file beside a torn copy', async () => {
    await realWrite(FILE, TORN, 'utf8')
    await realWrite(TMP, OTHER_SHAPE, 'utf8')
  }],
]

const writers: [string, () => Promise<void>][] = [
  ['ensureRegistered', () => ensureRegistered('w_2', 'cccc')],
  ['setActiveWallet', () => setActiveWallet('w_1')],
  ['removeWalletEntry', () => removeWalletEntry('w_1')],
  ['reorderWallets', () => reorderWallets(['w_1', 'primary'])],
]

describe.each(unreadable)('over %s', (_label, setup) => {
  beforeEach(setup)

  test('loadRegistry and getActiveWalletId reject as unreadable, never empty', async () => {
    expect(await outcome(loadRegistry())).toBe('unreadable')
    expect(await outcome(getActiveWalletId())).toBe('unreadable')
  })

  test.each(writers)('%s rejects as unreadable and the bytes on disk stay as they were', async (_name, write) => {
    const before = await diskOf()
    const writes = [
      jest.spyOn(RNFS, 'writeFile'),
      jest.spyOn(RNFS, 'unlink'),
      jest.spyOn(RNFS, 'moveFile'),
      jest.spyOn(Durable, 'rename'),
    ]

    expect(await outcome(write())).toBe('unreadable')

    expect(await diskOf()).toEqual(before)
    writes.forEach(spy => expect(spy).not.toHaveBeenCalled())
  })

  test('ensureRegistered refuses even for a wallet whose seed is not on this device', async () => {
    jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(false)
    const before = await diskOf()
    expect(await outcome(ensureRegistered('w_2', 'cccc'))).toBe('unreadable')
    expect(await diskOf()).toEqual(before)
  })

  test('a failed writer does not stall the queue for the next read', async () => {
    await outcome(reorderWallets(['w_1']))
    expect(await outcome(loadRegistry())).toBe('unreadable')
  })
})

describe('shapes this build reads', () => {
  test.each([
    ['an empty object', '{}', { wallets: [], active: null }],
    ['a null pointer', '{"wallets":[],"active":null}', { wallets: [], active: null }],
    [
      'the legacy list keyed by fingerprint, with its engine field',
      '{"wallets":[{"fingerprint":"aaaa","engine":"liquid"},{"fingerprint":"bbbb"}],"active":"bbbb"}',
      {
        wallets: [
          { id: 'primary', fingerprint: 'aaaa' },
          { id: 'w_1', fingerprint: 'bbbb' },
        ],
        active: 'w_1',
      },
    ],
  ])('reads %s', async (_label, text, expected) => {
    await realWrite(FILE, text, 'utf8')
    expect(await loadRegistry()).toEqual(expected)
  })

  test.each([
    ['an array', '[]'],
    ['null', 'null'],
    ['a wallet that is not an object', '{"wallets":[1]}'],
    ['a pointer that is not text', '{"wallets":[],"active":5}'],
  ])('refuses %s', async (_label, text) => {
    await realWrite(FILE, text, 'utf8')
    expect(await outcome(loadRegistry())).toBe('unreadable')
  })
})

describe('a torn file beside a finished copy', () => {
  beforeEach(async () => {
    await realWrite(FILE, TORN, 'utf8')
    await realWrite(TMP, OLD_TEXT, 'utf8')
  })

  test('reads as the copy', async () => {
    expect(await loadRegistry()).toEqual(OLD)
  })

  test('a writer moves the copy in and keeps the torn bytes aside', async () => {
    await reorderWallets(['w_1', 'primary'])

    expect(await loadRegistry()).toEqual({ ...OLD, wallets: [OLD.wallets[1], OLD.wallets[0]] })
    expect(await rawOf(RNFS, ASIDE)).toBe(TORN)
    expect(await RNFS.exists(TMP)).toBe(false)
  })
})

describe('replaceUnreadableRegistry', () => {
  const REBUILT: Registry = { wallets: [{ id: 'primary', fingerprint: 'ffff' }], active: 'primary' }

  test('sets the torn file aside, byte for byte, and writes the rebuilt list', async () => {
    await realWrite(FILE, TORN, 'utf8')

    expect(await replaceUnreadableRegistry(REBUILT.wallets, REBUILT.active)).toEqual(REBUILT)

    expect(await rawOf(RNFS, ASIDE)).toBe(TORN)
    expect(await loadRegistry()).toEqual(REBUILT)
  })

  test('sets a torn copy with no file aside too', async () => {
    await realWrite(TMP, TORN, 'utf8')

    await replaceUnreadableRegistry(REBUILT.wallets, REBUILT.active)

    expect(await rawOf(RNFS, TMP_ASIDE)).toBe(TORN)
    expect(await loadRegistry()).toEqual(REBUILT)
  })

  test('with no entries sets the file aside and writes nothing, so the list reads as empty', async () => {
    await realWrite(FILE, TORN, 'utf8')

    expect(await replaceUnreadableRegistry([], null)).toEqual({ wallets: [], active: null })

    expect(await rawOf(RNFS, FILE)).toBeNull()
    expect(await rawOf(RNFS, TMP)).toBeNull()
    expect(await rawOf(RNFS, ASIDE)).toBe(TORN)
    expect(await loadRegistry()).toEqual({ wallets: [], active: null })
  })

  test('over a list that reads, returns it and writes nothing', async () => {
    await realWrite(FILE, OLD_TEXT, 'utf8')
    const before = await diskOf()

    expect(await replaceUnreadableRegistry(REBUILT.wallets, REBUILT.active)).toEqual(OLD)

    expect(await diskOf()).toEqual(before)
  })

  test('two sent together write once, and the second answers what the first wrote', async () => {
    await realWrite(FILE, TORN, 'utf8')
    const asides = jest.spyOn(RNFS, 'moveFile')
    const renames = jest.spyOn(Durable, 'rename')
    const other: Registry = { wallets: [{ id: 'w_9', fingerprint: '9999' }], active: 'w_9' }

    const [first, second] = await Promise.all([
      replaceUnreadableRegistry(REBUILT.wallets, REBUILT.active),
      replaceUnreadableRegistry(other.wallets, other.active),
    ])

    expect(first).toEqual(REBUILT)
    expect(second).toEqual(REBUILT)
    // One move sets the torn file aside and one rename puts the finished copy in.
    expect(asides).toHaveBeenCalledTimes(1)
    expect(renames).toHaveBeenCalledTimes(1)
    expect(await rawOf(RNFS, ASIDE)).toBe(TORN)
  })

  test('a failure other than an unreadable file propagates and moves nothing', async () => {
    await realWrite(FILE, TORN, 'utf8')
    const before = await diskOf()
    jest.spyOn(RNFS, 'exists').mockRejectedValueOnce(new Error('disk unavailable'))

    await expect(replaceUnreadableRegistry(REBUILT.wallets, REBUILT.active)).rejects.toThrow('disk unavailable')

    expect(await diskOf()).toEqual(before)
  })
})

// A killed process, and the next launch, as a fresh copy of the modules over the same bytes. A write
// left hanging holds its own queue forever, as a dead process would, so the next read has to come from
// a process of its own.
type Process = { fs: Fs; registry: RegistryModule; keychain: typeof Keychain }

function launch(): Process {
  let proc!: Process
  jest.isolateModules(() => {
    proc = {
      fs: require('react-native-fs').default,
      registry: require('../src/wallet/walletRegistry'),
      keychain: require('react-native-keychain'),
    }
    durableOf.set(proc.fs, require('../specs/NativeVoltzDurable').default)
  })
  jest.mocked(proc.keychain.hasGenericPassword).mockResolvedValue(true)
  return proc
}

type Method = 'exists' | 'readFile' | 'writeFile' | 'unlink' | 'moveFile' | 'syncFile' | 'rename' | 'syncDirectory'
const FS_METHODS: Method[] = ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']
// The sync module's calls are steps of a write as well: the copy goes in place through its rename.
const SYNC_METHODS: Method[] = ['syncFile', 'rename', 'syncDirectory']
type DurableSpec = NonNullable<typeof NativeVoltzDurable>
// The sync module of each process, over that process's own files.
const durableOf = new Map<Fs, DurableSpec>()
durableOf.set(RNFS, Durable)

// Runs `hook` in front of every RNFS call of `fs` and every call of its sync module, with the call to
// make as `go`.
function trace(fs: Fs, hook: (method: Method, args: unknown[], go: () => Promise<unknown>) => Promise<unknown>): void {
  const targets: [object, Method[]][] = [
    [fs, FS_METHODS],
    [durableOf.get(fs) as DurableSpec, SYNC_METHODS],
  ]
  for (const [target, methods] of targets) {
    for (const method of methods) {
      const host = target as Record<Method, (...args: unknown[]) => Promise<unknown>>
      const real = host[method].bind(target)
      jest.spyOn(host, method).mockImplementation(((...args: unknown[]) => hook(method, args, () => real(...args))) as never)
    }
  }
}

// The process dies in front of call number `k`: that call and everything after it never happen. With
// `half`, a write lets half its text land first, as Android's truncate-then-write does.
function killBefore(fs: Fs, k: number, half: boolean): Promise<Method> {
  const write = fs.writeFile.bind(fs)
  let calls = 0
  let died: (method: Method) => void = () => undefined
  const gone = new Promise<Method>(resolve => {
    died = resolve
  })
  trace(fs, async (method, args, go) => {
    if (calls++ !== k) {
      return go()
    }
    if (half && method === 'writeFile') {
      const [path, text] = args as [string, string]
      await write(path, text.slice(0, Math.floor(text.length / 2)), 'utf8')
    }
    died(method)
    return new Promise<never>(() => undefined)
  })
  return gone
}

async function reopened(disk: (string | null)[]): Promise<Registry | 'unreadable' | 'failed'> {
  const next = launch()
  for (let i = 0; i < PATHS.length; i += 1) {
    const text = disk[i]
    if (text !== null) {
      await next.fs.writeFile(PATHS[i], text, 'utf8')
    }
  }
  return outcome(next.registry.loadRegistry())
}

describe('a write cut at any step leaves the last finished list readable', () => {
  const NEW: Record<string, Registry> = {
    ensureRegistered: { ...OLD, wallets: [...OLD.wallets, { id: 'w_2', fingerprint: 'cccc' }] },
    setActiveWallet: { ...OLD, active: 'w_1' },
    removeWalletEntry: { wallets: [OLD.wallets[0]], active: 'primary' },
    reorderWallets: { ...OLD, wallets: [OLD.wallets[1], OLD.wallets[0]] },
  }
  const run: Record<string, (registry: RegistryModule) => Promise<void>> = {
    ensureRegistered: r => r.ensureRegistered('w_2', 'cccc'),
    setActiveWallet: r => r.setActiveWallet('w_1'),
    removeWalletEntry: r => r.removeWalletEntry('w_1'),
    reorderWallets: r => r.reorderWallets(['w_1', 'primary']),
  }
  const starts: [string, (fs: Fs) => Promise<void>][] = [
    ['a good file', fs => fs.writeFile(FILE, OLD_TEXT, 'utf8')],
    ['a finished copy and no file', fs => fs.writeFile(TMP, OLD_TEXT, 'utf8')],
    ['a torn file beside a finished copy', async fs => {
      await fs.writeFile(FILE, TORN, 'utf8')
      await fs.writeFile(TMP, OLD_TEXT, 'utf8')
    }],
  ]

  test.each(Object.keys(run).flatMap(name => starts.map(([label, setup]) => [name, label, setup] as const)))(
    '%s, from %s, at every step and with half a write',
    async (name, _label, setup) => {
      const counting = launch()
      await setup(counting.fs)
      let steps = 0
      trace(counting.fs, (_method, _args, go) => {
        steps += 1
        return go()
      })
      await run[name](counting.registry)
      jest.restoreAllMocks()
      expect(steps).toBeGreaterThan(4)

      const allowed = [JSON.stringify(OLD), JSON.stringify(NEW[name])]
      for (const half of [false, true]) {
        for (let k = 0; k < steps; k += 1) {
          const proc = launch()
          await setup(proc.fs)
          const gone = killBefore(proc.fs, k, half)
          const method = await Promise.race([
            gone,
            run[name](proc.registry).then(
              () => 'finished',
              () => 'finished',
            ),
          ])
          jest.restoreAllMocks()
          const answer = await reopened(await diskOf(proc.fs))
          expect({ half, k, method, ok: allowed.includes(JSON.stringify(answer)) }).toEqual({
            half,
            k,
            method,
            ok: true,
          })
        }
      }
    },
  )

  test('control: a write left whole lands the new list', async () => {
    const proc = launch()
    await proc.fs.writeFile(FILE, OLD_TEXT, 'utf8')
    await run.reorderWallets(proc.registry)
    expect(await reopened(await diskOf(proc.fs))).toEqual(NEW.reorderWallets)
  })
})

// A write over a list leaves no step where it is gone, since the rename replaces it in one step. A
// write that starts from a finished copy and no list moves the copy in first, and a read beside that
// move finds neither unless it waits in the list's queue.
describe('a read sent at each step of a write', () => {
  const starts: [string, string][] = [
    ['a good file', FILE],
    ['a finished copy and no file', TMP],
  ]
  test.each(writers.flatMap(([name, write]) => starts.map(([label, at]) => [name, label, at, write] as const)))(
    'answers the list from before or after %s, from %s, never empty',
    async (name, _label, at, write) => {
      reset()
      await realWrite(at, OLD_TEXT, 'utf8')
      let steps = 0
      trace(RNFS, (_method, _args, go) => {
        steps += 1
        return go()
      })
      await write()
      jest.restoreAllMocks()
      jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
      expect(steps).toBeGreaterThan(4)
      const after = await loadRegistry()

      for (let k = 0; k < steps; k += 1) {
        reset()
        await realWrite(at, OLD_TEXT, 'utf8')
        const reads: Promise<unknown>[] = []
        let calls = 0
        trace(RNFS, (_method, _args, go) => {
          if (calls++ === k) {
            reads.push(outcome(loadRegistry()), outcome(getActiveWalletId()))
          }
          return go()
        })
        await write()
        jest.restoreAllMocks()
        jest.mocked(Keychain.hasGenericPassword).mockResolvedValue(true)
        const [registry, active] = await Promise.all(reads)
        expect({ name, k, ok: [OLD, after].some(r => JSON.stringify(r) === JSON.stringify(registry)) }).toEqual({
          name,
          k,
          ok: true,
        })
        expect({ name, k, active }).toEqual({ name, k, active: (registry as Registry).active })
      }
    },
  )
})
