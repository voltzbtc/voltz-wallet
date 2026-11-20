import RNFS from 'react-native-fs'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import {
  forgetLnAddress,
  lastLnAddress,
  noteNotTakenBack,
  notTakenBack,
  rememberLnAddress,
} from '../src/wallet/lnAddressMemory'

// The last address each wallet was seen holding, over the in-memory RNFS mock. A memory lost to a cut
// write answers as none, and the caller then mints a generated name over the one the person chose.

type Fs = typeof RNFS
type MemoryModule = typeof import('../src/wallet/lnAddressMemory')

const FILE = `${RNFS.DocumentDirectoryPath}/ln-address-last.json`
const TMP = `${FILE}.tmp`
const PATHS = [FILE, TMP, `${FILE}.unreadable`, `${TMP}.unreadable`]
const OLD_TEXT = JSON.stringify({ w_a: 'padaria@example.com' })
const TORN = OLD_TEXT.slice(0, 12)

const realWrite = RNFS.writeFile.bind(RNFS)

async function diskOf(fs: Fs = RNFS): Promise<(string | null)[]> {
  return Promise.all(PATHS.map(async path => ((await fs.exists(path)) ? fs.readFile(path, 'utf8') : null)))
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
})

test('remembers an address per wallet and forgets one wallet only', async () => {
  await rememberLnAddress('padaria@example.com', 'w_a')
  await rememberLnAddress('bar@example.com', 'w_b')
  await forgetLnAddress('w_a')

  expect(await lastLnAddress('w_a')).toBeNull()
  expect(await lastLnAddress('w_b')).toBe('bar@example.com')
  expect(await RNFS.exists(TMP)).toBe(false)
})

// The gateway's answer that a remembered address was not taken back stands only beside that address.
describe('the note that the remembered address was not taken back', () => {
  test('is kept while the same address is remembered again, and is no address of its own', async () => {
    await rememberLnAddress('padaria@example.com', 'w_a')
    await noteNotTakenBack('PADARIA@example.com', 'w_a', ['c1'])
    await rememberLnAddress('padaria@example.com', 'w_a')

    expect(await notTakenBack('w_a', ['c1'])).toBe('PADARIA@example.com')
    expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
    expect(await notTakenBack('w_b', ['c1'])).toBeNull()
  })

  test('goes once another address is remembered, and does not come back with the first', async () => {
    await rememberLnAddress('padaria@example.com', 'w_a')
    await noteNotTakenBack('padaria@example.com', 'w_a', ['c1'])
    await rememberLnAddress('bar@example.com', 'w_a')
    expect(await notTakenBack('w_a', ['c1'])).toBeNull()
    await rememberLnAddress('padaria@example.com', 'w_a')
    expect(await notTakenBack('w_a', ['c1'])).toBeNull()
  })

  test('is never written beside another address, nor for a wallet that remembers none', async () => {
    await rememberLnAddress('bar@example.com', 'w_a')
    await noteNotTakenBack('padaria@example.com', 'w_a', ['c1'])
    await noteNotTakenBack('padaria@example.com', 'w_b', ['c1'])
    expect(await notTakenBack('w_a', ['c1'])).toBeNull()
    expect(await notTakenBack('w_b', ['c1'])).toBeNull()
    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).toEqual({ w_a: 'bar@example.com' })
  })

  test('goes with the memory it stands beside, and only that wallet\'s', async () => {
    await rememberLnAddress('padaria@example.com', 'w_a')
    await rememberLnAddress('bar@example.com', 'w_b')
    await noteNotTakenBack('padaria@example.com', 'w_a', ['c1'])
    await noteNotTakenBack('bar@example.com', 'w_b', ['c1'])
    await forgetLnAddress('w_a')

    expect(await notTakenBack('w_a', ['c1'])).toBeNull()
    expect(await notTakenBack('w_b', ['c1'])).toBe('bar@example.com')
    expect(Object.keys(JSON.parse(await RNFS.readFile(FILE, 'utf8'))).sort()).toEqual(['kept:w_b', 'w_b'])
  })

  // A later refund of the same address annuls another credit, which the answer never covered.
  test('stands for the annulled credits it was asked about, and not once a new one is listed', async () => {
    await rememberLnAddress('padaria@example.com', 'w_a')
    await noteNotTakenBack('padaria@example.com', 'w_a', ['c1', 'c2'])

    expect(await notTakenBack('w_a', ['c2'])).toBe('padaria@example.com')
    expect(await notTakenBack('w_a', ['c2', 'c1'])).toBe('padaria@example.com')
    expect(await notTakenBack('w_a', ['c1', 'c3'])).toBeNull()

    await noteNotTakenBack('padaria@example.com', 'w_a', ['c1', 'c2', 'c3'])
    expect(await notTakenBack('w_a', ['c1', 'c3'])).toBe('padaria@example.com')
  })

  test('written as the address alone reads as none, and the address stays remembered', async () => {
    await realWrite(FILE, JSON.stringify({ w_a: 'padaria@example.com', 'kept:w_a': 'padaria@example.com' }), 'utf8')

    expect(await notTakenBack('w_a', [])).toBeNull()
    expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
  })
})

// A read the platform refuses on an intact memory leaves it as it is: a write that took it for no memory
// would keep only one wallet's name and drop the others', and those wallets would then mint over theirs.
describe('when the platform refuses a read of an intact memory', () => {
  function refuseNextRead(): void {
    const real = RNFS.readFile.bind(RNFS)
    let left = 1
    let bytes = false
    jest.spyOn(RNFS, 'readFile').mockImplementation(((path: string, encoding?: string) => {
      if (path === FILE && ((encoding === 'utf8' && left > 0) || (encoding === 'base64' && bytes))) {
        bytes = encoding === 'utf8'
        left -= encoding === 'utf8' ? 1 : 0
        return Promise.reject(new Error('EIO: i/o error'))
      }
      return (real as (...a: unknown[]) => Promise<string>)(path, encoding)
    }) as never)
  }

  test.each([
    ['remembering another wallet', () => rememberLnAddress('bar@example.com', 'w_b')],
    ['forgetting another wallet', () => forgetLnAddress('w_b')],
  ])('%s keeps every name already remembered', async (_, write) => {
    await rememberLnAddress('padaria@example.com', 'w_a')
    await rememberLnAddress('bar@example.com', 'w_b')
    const before = await diskOf()
    refuseNextRead()
    await write()
    jest.mocked(RNFS.readFile).mockRestore()
    expect(await diskOf()).toEqual(before)
    expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
  })
})

describe('over a torn file', () => {
  beforeEach(() => realWrite(FILE, TORN, 'utf8'))

  test('reads as no memory, as documented', async () => {
    expect(await lastLnAddress('w_a')).toBeNull()
  })

  test.each([
    ['rememberLnAddress', () => rememberLnAddress('bar@example.com', 'w_b')],
    ['forgetLnAddress', () => forgetLnAddress('w_a')],
  ])('%s resolves and writes nothing over it', async (_name, write) => {
    const before = await diskOf()

    await expect(write()).resolves.toBeUndefined()

    expect(await diskOf()).toEqual(before)
  })
})

test('a torn file beside a finished copy reads as the copy, and a write keeps the torn bytes aside', async () => {
  await realWrite(FILE, TORN, 'utf8')
  await realWrite(TMP, OLD_TEXT, 'utf8')

  expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
  await rememberLnAddress('bar@example.com', 'w_b')

  expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
  expect(await lastLnAddress('w_b')).toBe('bar@example.com')
  expect(await RNFS.readFile(`${FILE}.unreadable`, 'utf8')).toBe(TORN)
})

// A killed process, and the next launch over the same bytes, as in registryTorn.test.ts: the write
// left hanging holds its own queue forever, so the next read comes from a fresh copy of the modules.
type Process = { fs: Fs; memory: MemoryModule }

function launch(): Process {
  let proc!: Process
  jest.isolateModules(() => {
    proc = { fs: require('react-native-fs').default, memory: require('../src/wallet/lnAddressMemory') }
    durableOf.set(proc.fs, require('../specs/NativeVoltzDurable').default)
  })
  return proc
}

type Method = 'exists' | 'readFile' | 'writeFile' | 'unlink' | 'moveFile' | 'syncFile' | 'rename' | 'syncDirectory'
const FS_METHODS: Method[] = ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']
// The sync module's calls are steps of a write as well: the copy goes in place through its rename.
const SYNC_METHODS: Method[] = ['syncFile', 'rename', 'syncDirectory']
type DurableSpec = NonNullable<typeof NativeVoltzDurable>
// The sync module of each process, over that process's own files.
const durableOf = new Map<Fs, DurableSpec>()

// Runs `hook` in front of every RNFS call of `fs` and every call of its sync module.
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

// The process dies in front of call number `k`; with `half`, a write lets half its text land first.
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

async function reopened(disk: (string | null)[], walletId: string): Promise<string | null> {
  const next = launch()
  for (let i = 0; i < PATHS.length; i += 1) {
    const text = disk[i]
    if (text !== null) {
      await next.fs.writeFile(PATHS[i], text, 'utf8')
    }
  }
  return next.memory.lastLnAddress(walletId)
}

test.each([
  ['rememberLnAddress', (m: MemoryModule) => m.rememberLnAddress('padaria@other.com', 'w_a'), ['padaria@example.com', 'padaria@other.com']],
  ['forgetLnAddress', (m: MemoryModule) => m.forgetLnAddress('w_b'), ['padaria@example.com']],
] as const)('%s cut at every step, and with half a write, leaves the last address readable', async (_name, run, allowed) => {
  const start = JSON.stringify({ w_a: 'padaria@example.com', w_b: 'bar@example.com' })
  const counting = launch()
  await counting.fs.writeFile(FILE, start, 'utf8')
  let steps = 0
  trace(counting.fs, (_method, _args, go) => {
    steps += 1
    return go()
  })
  await run(counting.memory)
  jest.restoreAllMocks()
  expect(steps).toBeGreaterThan(4)

  for (const half of [false, true]) {
    for (let k = 0; k < steps; k += 1) {
      const proc = launch()
      await proc.fs.writeFile(FILE, start, 'utf8')
      const gone = killBefore(proc.fs, k, half)
      const method = await Promise.race([gone, run(proc.memory).then(() => 'finished')])
      jest.restoreAllMocks()
      const answer = await reopened(await diskOf(proc.fs), 'w_a')
      expect({ half, k, method, ok: (allowed as readonly string[]).includes(answer ?? '') }).toEqual({
        half,
        k,
        method,
        ok: true,
      })
    }
  }
})

// Reads and writes share one queue. A write over the file replaces it in one step, through the rename,
// but one that starts from a finished copy and no file moves the copy in first, and a read beside that
// move finds neither and answers no memory for a wallet that has one.
describe('one queue', () => {
  test.each([
    ['a file', FILE],
    ['a finished copy and no file', TMP],
  ])('a read sent at any step of a write, from %s, answers the address before or after it, never none', async (_label, at) => {
    const start = JSON.stringify({ w_a: 'padaria@example.com' })
    const allowed = ['padaria@example.com', 'padaria@other.com']
    const counting = launch()
    await counting.fs.writeFile(at, start, 'utf8')
    let steps = 0
    trace(counting.fs, (_method, _args, go) => {
      steps += 1
      return go()
    })
    await counting.memory.rememberLnAddress('padaria@other.com', 'w_a')
    jest.restoreAllMocks()
    expect(steps).toBeGreaterThan(4)

    for (let k = 0; k < steps; k += 1) {
      const proc = launch()
      await proc.fs.writeFile(at, start, 'utf8')
      let calls = 0
      // Answers none unless the read was sent, so a step never reached fails too.
      let read: Promise<string | null> = Promise.resolve(null)
      trace(proc.fs, (_method, _args, go) => {
        if (calls++ === k) {
          read = proc.memory.lastLnAddress('w_a')
        }
        return go()
      })
      await proc.memory.rememberLnAddress('padaria@other.com', 'w_a')
      const answer = await read
      jest.restoreAllMocks()
      expect({ k, ok: allowed.includes(answer ?? '') }).toEqual({ k, ok: true })
    }
  })

  test('two wallets remembered at once both stay remembered', async () => {
    await Promise.all([
      rememberLnAddress('padaria@example.com', 'w_a'),
      rememberLnAddress('bar@example.com', 'w_b'),
    ])

    expect(await lastLnAddress('w_a')).toBe('padaria@example.com')
    expect(await lastLnAddress('w_b')).toBe('bar@example.com')
  })
})
