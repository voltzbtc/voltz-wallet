import RNFS from 'react-native-fs'
import NativeVoltzDurable from '../specs/NativeVoltzDurable'
import {
  asideExists,
  isUnreadableFile,
  readDurable,
  removeDurable,
  serialQueue,
  setAside,
  UnreadableFile,
  writeDurable,
} from '../src/wallet/durableFile'

// Jest maps the spec to its in-memory double, which is never null.
const Durable = NativeVoltzDurable as NonNullable<typeof NativeVoltzDurable>

// The helper every file of the app that must survive a cut is written through. The in-memory RNFS mock
// refuses a move onto a path that exists and an unlink of a path that does not, as the native modules do.

const FILE = `${RNFS.DocumentDirectoryPath}/thing.json`
const TMP = `${FILE}.tmp`
const ASIDE = `${FILE}.unreadable`
const TMP_ASIDE = `${TMP}.unreadable`

const isNumbers = (value: unknown): boolean =>
  Array.isArray(value) && value.every(item => typeof item === 'number')

const OLD = '[1,2,3]'
const NEW = '[4,5,6]'
const COPY = '[7,8,9]'
// Cut mid write, and a finished file that is not the shape the caller accepts.
const TORN = '[1,2'
const OTHER_SHAPE = '{"wallets":"x"}'

const realWrite = RNFS.writeFile.bind(RNFS)
const realRead = RNFS.readFile.bind(RNFS)

const put = (path: string, text: string): Promise<void> => realWrite(path, text, 'utf8')

async function raw(path: string): Promise<string | null> {
  return (await RNFS.exists(path)) ? RNFS.readFile(path, 'utf8') : null
}

async function diskOf(paths: string[]): Promise<(string | null)[]> {
  return Promise.all(paths.map(raw))
}

type FsMethod = 'exists' | 'readFile' | 'writeFile' | 'unlink' | 'moveFile'
type SyncMethod = 'syncFile' | 'rename' | 'syncDirectory'
type Method = FsMethod | SyncMethod
const FS_METHODS: FsMethod[] = ['exists', 'readFile', 'writeFile', 'unlink', 'moveFile']
const SYNC_METHODS: SyncMethod[] = ['syncFile', 'rename', 'syncDirectory']

// Runs `hook` in front of every RNFS call and every call to the native sync module, with the call to
// make as `go`. Each call is one await of the code under test, so a hook keyed on the call number is a
// process killed, or a read sent, there.
function trace(
  hook: (method: Method, args: unknown[], go: () => Promise<unknown>) => Promise<unknown>,
): void {
  const targets: [object, Method[]][] = [
    [RNFS, FS_METHODS],
    [Durable, SYNC_METHODS],
  ]
  for (const [target, methods] of targets) {
    for (const method of methods) {
      const host = target as Record<Method, (...args: unknown[]) => Promise<unknown>>
      const real = host[method].bind(target)
      jest
        .spyOn(host, method)
        .mockImplementation(((...args: unknown[]) =>
          hook(method, args, () => real(...args))) as never)
    }
  }
}

// How many RNFS calls an unharmed run of `run` makes.
async function stepsOf(run: () => Promise<unknown>): Promise<number> {
  let calls = 0
  trace((_method, _args, go) => {
    calls += 1
    return go()
  })
  await run()
  jest.restoreAllMocks()
  return calls
}

// The process dies in front of call number `k`: that call and everything after it never happen, and
// the code under test is left hanging as a killed process would be. A thrown error would not do, since
// the code under test catches some. When the call is a write, `half` lets half its text land first, as
// a truncate-then-write does. Answers the method it died at.
function killBefore(k: number, half: boolean): Promise<Method> {
  let calls = 0
  let died: (method: Method) => void = () => undefined
  const gone = new Promise<Method>(resolve => {
    died = resolve
  })
  trace(async (method, args, go) => {
    if (calls++ !== k) {
      return go()
    }
    if (half && method === 'writeFile') {
      const [path, text] = args as [string, string]
      await realWrite(path, text.slice(0, Math.floor(text.length / 2)), 'utf8')
    }
    died(method)
    return new Promise<never>(() => undefined)
  })
  return gone
}

// Every spy on a method that changes the disk, the sync module's rename included, to prove that a
// refusal touched nothing.
function watchWrites(): Record<'writeFile' | 'unlink' | 'moveFile' | 'rename', jest.SpyInstance> {
  return {
    writeFile: jest.spyOn(RNFS, 'writeFile'),
    unlink: jest.spyOn(RNFS, 'unlink'),
    moveFile: jest.spyOn(RNFS, 'moveFile'),
    rename: jest.spyOn(Durable, 'rename'),
  }
}

function expectNoWrites(spies: ReturnType<typeof watchWrites>): void {
  expect(spies.writeFile).not.toHaveBeenCalled()
  expect(spies.unlink).not.toHaveBeenCalled()
  expect(spies.moveFile).not.toHaveBeenCalled()
  expect(spies.rename).not.toHaveBeenCalled()
}

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.restoreAllMocks()
})

describe('UnreadableFile', () => {
  test('is read by name, and carries the path that could not be read', () => {
    const err = new UnreadableFile(FILE)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('UnreadableFile')
    expect(err.path).toBe(FILE)
    expect(isUnreadableFile(err)).toBe(true)
    // Survives a class that transpilation did not keep an identity for.
    const plain = new Error('x')
    plain.name = 'UnreadableFile'
    expect(isUnreadableFile(plain)).toBe(true)
  })

  test('is not claimed by any other failure', () => {
    expect(isUnreadableFile(new Error('UnreadableFile'))).toBe(false)
    expect(isUnreadableFile(new TypeError('x'))).toBe(false)
    expect(isUnreadableFile('UnreadableFile')).toBe(false)
    expect(isUnreadableFile(null)).toBe(false)
    expect(isUnreadableFile(undefined)).toBe(false)
  })
})

describe('readDurable', () => {
  test('answers null when neither the file nor its copy exists', async () => {
    expect(await readDurable(FILE, isNumbers)).toBeNull()
  })

  test('answers the file', async () => {
    await put(FILE, OLD)
    expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
  })

  test('answers the file over a finished copy beside it', async () => {
    await put(FILE, OLD)
    await put(TMP, COPY)
    expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
  })

  test('answers the finished copy when the file is missing, torn or of another shape', async () => {
    await put(TMP, COPY)
    expect(await readDurable(FILE, isNumbers)).toEqual([7, 8, 9])
    await put(FILE, TORN)
    expect(await readDurable(FILE, isNumbers)).toEqual([7, 8, 9])
    await put(FILE, OTHER_SHAPE)
    expect(await readDurable(FILE, isNumbers)).toEqual([7, 8, 9])
  })

  test('answers the file when only the copy is torn', async () => {
    await put(FILE, OLD)
    await put(TMP, TORN)
    expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
  })

  test.each([
    ['a torn file', TORN, null],
    ['a file of another shape', OTHER_SHAPE, null],
    ['a torn copy with no file', null, TORN],
    ['a torn file and a torn copy', TORN, TORN],
    ['an empty file', '', null],
  ])('throws UnreadableFile for %s, and never answers null', async (_label, file, copy) => {
    if (file !== null) {
      await put(FILE, file)
    }
    if (copy !== null) {
      await put(TMP, copy)
    }
    const before = await diskOf([FILE, TMP])
    const err = await readDurable(FILE, isNumbers).then(
      () => null,
      (e: unknown) => e,
    )
    expect(isUnreadableFile(err)).toBe(true)
    expect((err as UnreadableFile).path).toBe(FILE)
    expect(await diskOf([FILE, TMP])).toEqual(before)
  })
})

// A torn copy with no file is the trace of a first write that was cut, whose last finished state is no
// file at all. A caller whose first writes lose nothing when cut reads it so.
describe("readDurable, reading a cut first write as 'nothing'", () => {
  test('answers null for a torn copy with no file, and leaves the copy where it is', async () => {
    await put(TMP, TORN)
    const spies = watchWrites()
    expect(await readDurable(FILE, isNumbers, 'nothing')).toBeNull()
    expectNoWrites(spies)
    expect(await diskOf([FILE, TMP])).toEqual([null, TORN])
  })

  test('answers null for a copy of another shape with no file', async () => {
    await put(TMP, OTHER_SHAPE)
    expect(await readDurable(FILE, isNumbers, 'nothing')).toBeNull()
  })

  test('still answers the file, the finished copy, and null for nothing at all', async () => {
    expect(await readDurable(FILE, isNumbers, 'nothing')).toBeNull()
    await put(TMP, COPY)
    expect(await readDurable(FILE, isNumbers, 'nothing')).toEqual([7, 8, 9])
    await put(FILE, OLD)
    expect(await readDurable(FILE, isNumbers, 'nothing')).toEqual([1, 2, 3])
  })

  test.each([
    ['a torn file', TORN, null],
    ['a file of another shape', OTHER_SHAPE, null],
    ['a torn file and a torn copy', TORN, TORN],
    ['an empty file', '', null],
  ])('throws UnreadableFile for %s, as the default does', async (_label, file, copy) => {
    await put(FILE, file)
    if (copy !== null) {
      await put(TMP, copy)
    }
    const before = await diskOf([FILE, TMP])
    const err = await readDurable(FILE, isNumbers, 'nothing').then(
      () => null,
      (e: unknown) => e,
    )
    expect(isUnreadableFile(err)).toBe(true)
    expect(await diskOf([FILE, TMP])).toEqual(before)
  })
})

// A read the platform refuses says nothing about the bytes on disk, so an intact file it fails on is
// never taken for a torn one: nothing is set aside, unlinked or written over, and the next read finds
// the file.
describe('a read the platform refuses on an intact file', () => {
  // The next `times` text reads of `path` reject as an I/O error would, and so does the bytes read that
  // follows each; every other call goes through. `bytes` stands for what the platform answers when the
  // text read was the decoder's refusal rather than the disk's.
  function refuseReads(path: string, times: number, bytes: () => Promise<unknown> = () => Promise.reject(new Error('EIO: i/o error'))): void {
    const real = realRead
    let left = times
    let refusing = false
    jest.spyOn(RNFS, 'readFile').mockImplementation(((p: string, encoding?: string) => {
      if (p === path && encoding === 'base64' && refusing) {
        refusing = false
        return bytes()
      }
      if (p === path && encoding === 'utf8' && left > 0) {
        left -= 1
        refusing = true
        return Promise.reject(new Error('EIO: i/o error'))
      }
      return (real as (...args: unknown[]) => Promise<string>)(p, encoding)
    }) as never)
  }

  async function failure(run: () => Promise<unknown>): Promise<unknown> {
    return run().then(
      () => 'resolved',
      (e: unknown) => e,
    )
  }

  test.each(['unreadable', 'nothing'] as const)(
    "readDurable rejects with the platform's error under %p, and the next read answers the file",
    async firstWriteCut => {
      await put(FILE, OLD)
      refuseReads(FILE, 1)
      const err = await failure(() => readDurable(FILE, isNumbers, firstWriteCut))
      expect(err).toBeInstanceOf(Error)
      expect(isUnreadableFile(err)).toBe(false)
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([OLD, null, null])
      expect(await readDurable(FILE, isNumbers, firstWriteCut)).toEqual([1, 2, 3])
    },
  )

  test.each(['unreadable', 'nothing'] as const)(
    'readDurable never answers null for a finished copy it could not read under %p',
    async firstWriteCut => {
      await put(TMP, COPY)
      refuseReads(TMP, 1)
      const err = await failure(() => readDurable(FILE, isNumbers, firstWriteCut))
      expect(err).toBeInstanceOf(Error)
      expect(isUnreadableFile(err)).toBe(false)
      expect(await readDurable(FILE, isNumbers, firstWriteCut)).toEqual([7, 8, 9])
    },
  )

  test.each(['refuse', 'replace'] as const)(
    'writeDurable under %p rejects before touching the disk',
    async overTorn => {
      await put(FILE, OLD)
      refuseReads(FILE, 1)
      const spies = watchWrites()
      const err = await failure(() => writeDurable(FILE, NEW, isNumbers, overTorn))
      expect(isUnreadableFile(err)).toBe(false)
      expect(err).toBeInstanceOf(Error)
      expectNoWrites(spies)
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([OLD, null, null])
    },
  )

  // Under 'nothing' a torn copy with no file is removed by the next write, so a finished copy that the
  // platform refused to read must not be taken for one: it is the only finished write.
  test("writeDurable under 'nothing' never removes a finished copy it could not read", async () => {
    await put(TMP, COPY)
    refuseReads(TMP, 2)
    const spies = watchWrites()
    expect(await failure(() => readDurable(FILE, isNumbers, 'nothing'))).toBeInstanceOf(Error)
    const err = await failure(() => writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing'))
    expect(isUnreadableFile(err)).toBe(false)
    expectNoWrites(spies)
    expect(await diskOf([FILE, TMP])).toEqual([null, COPY])
  })

  const base64Of = (...parts: (string | number[])[]): string =>
    Buffer.concat(parts.map(part => (typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part)))).toString('base64')

  // RNFS decodes UTF-8 in JS, so a file cut inside a multibyte character refuses the text read while
  // its bytes still read. Bytes that are not UTF-8 are a torn file, as any cut file is.
  test.each([
    ['cut inside a multibyte character', base64Of('[1,"Caf', [0xc3])],
    ['an overlong form', base64Of('[1,', [0xc0, 0x80], ']')],
    ['an encoded surrogate', base64Of('["', [0xed, 0xa0, 0x80], '"]')],
    ['a byte that is never UTF-8', base64Of('[', [0xff], ']')],
  ])('a file whose bytes read but are not UTF-8, %s, is torn', async (_label, bytes) => {
    await put(FILE, OLD)
    refuseReads(FILE, 1, () => Promise.resolve(bytes))
    const spies = watchWrites()
    expect(isUnreadableFile(await failure(() => readDurable(FILE, isNumbers)))).toBe(true)
    refuseReads(FILE, 1, () => Promise.resolve(bytes))
    expect(isUnreadableFile(await failure(() => writeDurable(FILE, NEW, isNumbers)))).toBe(true)
    expectNoWrites(spies)
  })

  // A text read the platform refused once, whose bytes then read and decode, was a refusal that is
  // gone: the file is read from those bytes and nothing is taken for torn.
  test('a text read refused once whose bytes decode reads the file, and a write goes ahead', async () => {
    await put(FILE, '["café",1]')
    const isList = (value: unknown): boolean => Array.isArray(value)
    refuseReads(FILE, 1, () => Promise.resolve(base64Of('["café",1]')))
    expect(await readDurable(FILE, isList)).toEqual(['café', 1])
    refuseReads(FILE, 1, () => Promise.resolve(base64Of('["café",1]')))
    await writeDurable(FILE, NEW, isList)
    jest.restoreAllMocks()
    expect(await diskOf([FILE, TMP, ASIDE])).toEqual([NEW, null, null])
  })

  // RNFS's own base64 decoder takes digits without their trailing padding, so bytes that come back
  // that way read as they would padded. A lone digit past the last group holds no whole byte, and
  // the bytes are not text.
  test.each([
    ['one padding digit', '["café",1]'],
    ['two padding digits', '[1,2,3,45]'],
  ])('bytes that come back without their %s read the file', async (_count, text) => {
    const bare = base64Of(text).replace(/[=]+$/, '')
    expect(bare).not.toBe(base64Of(text))
    await put(FILE, text)
    const isList = (value: unknown): boolean => Array.isArray(value)
    refuseReads(FILE, 1, () => Promise.resolve(bare))
    expect(await readDurable(FILE, isList)).toEqual(JSON.parse(text))
  })

  // The same rules as RNFS's decoder, which refuses both: a lone digit holds no whole byte, and an
  // '=' anywhere but at the end of a whole group is not base64.
  test.each([
    ['a lone digit past the last group', `${base64Of('[1]')}A`],
    ['padding cut short', base64Of('[1,2,3,45]').slice(0, -1)],
  ])('bytes with %s are torn', async (_label, bytes) => {
    await put(FILE, OLD)
    refuseReads(FILE, 1, () => Promise.resolve(bytes))
    expect(isUnreadableFile(await failure(() => readDurable(FILE, isNumbers)))).toBe(true)
  })

  // iOS resolves nil when contentsAtPath fails, so the bytes read answers no string at all.
  test.each([
    ['answers nothing', () => Promise.resolve(null)],
    ['answers an empty string', () => Promise.resolve('')],
    ['fails as well', () => Promise.reject(new Error('EIO: i/o error'))],
  ])('a text read refused whose bytes read %s is the platform refusing', async (_label, bytes) => {
    await put(FILE, OLD)
    refuseReads(FILE, 1, bytes)
    const err = await failure(() => readDurable(FILE, isNumbers))
    expect(err).toBeInstanceOf(Error)
    expect(isUnreadableFile(err)).toBe(false)
    expect(await diskOf([FILE, TMP, ASIDE])).toEqual([OLD, null, null])
  })
})

describe('writeDurable', () => {
  describe.each(['refuse', 'replace'] as const)('over a file that reads, in %s mode', mode => {
    test('writes a file that was never there, and leaves no copy', async () => {
      await writeDurable(FILE, NEW, isNumbers, mode)
      expect(await diskOf([FILE, TMP])).toEqual([NEW, null])
    })

    test('replaces a good file, and never writes the file itself', async () => {
      await put(FILE, OLD)
      const spies = watchWrites()
      await writeDurable(FILE, NEW, isNumbers, mode)
      expect(await diskOf([FILE, TMP])).toEqual([NEW, null])
      expect(spies.writeFile.mock.calls.map(call => call[0])).toEqual([TMP])
    })

    test('moves a finished copy in when the file is missing, before it writes its own', async () => {
      await put(TMP, COPY)
      jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('killed'))
      await expect(writeDurable(FILE, NEW, isNumbers, mode)).rejects.toThrow('killed')
      jest.restoreAllMocks()
      expect(await diskOf([FILE, TMP])).toEqual([COPY, null])
      await writeDurable(FILE, NEW, isNumbers, mode)
      expect(await diskOf([FILE, TMP])).toEqual([NEW, null])
    })

    test('drops a torn copy beside a good file', async () => {
      await put(FILE, OLD)
      await put(TMP, TORN)
      await writeDurable(FILE, NEW, isNumbers, mode)
      expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([NEW, null, null, null])
    })

    test('never lets a short write replace the file, whatever the platform reported', async () => {
      await put(FILE, OLD)
      jest
        .spyOn(RNFS, 'writeFile')
        .mockImplementationOnce(async (path: string, text: string) => put(path, text.slice(0, 3)))
      await expect(writeDurable(FILE, NEW, isNumbers, mode)).rejects.toThrow('did not read back')
      jest.restoreAllMocks()
      expect(await raw(FILE)).toBe(OLD)
      expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
    })
  })

  describe('over a file that does not read, refusing', () => {
    test('sets a torn file aside and moves the finished copy in', async () => {
      await put(FILE, TORN)
      await put(TMP, COPY)
      jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('killed'))
      await expect(writeDurable(FILE, NEW, isNumbers)).rejects.toThrow('killed')
      jest.restoreAllMocks()
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([COPY, null, TORN])
      await writeDurable(FILE, NEW, isNumbers)
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([NEW, null, TORN])
    })

    test('keeps what is already set aside when the name is taken', async () => {
      jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
      await put(ASIDE, 'older bytes')
      await put(FILE, OTHER_SHAPE)
      await put(TMP, COPY)
      await writeDurable(FILE, NEW, isNumbers)
      expect(await diskOf([FILE, ASIDE, `${ASIDE}-1700000000000`])).toEqual([
        NEW,
        'older bytes',
        OTHER_SHAPE,
      ])
    })

    test.each([
      ['a torn file with no copy', TORN, null],
      ['a file of another shape with no copy', OTHER_SHAPE, null],
      ['a torn copy with no file', null, TORN],
      ['a torn file and a torn copy', TORN, TORN],
    ])('throws UnreadableFile for %s and touches nothing', async (_label, file, copy) => {
      if (file !== null) {
        await put(FILE, file)
      }
      if (copy !== null) {
        await put(TMP, copy)
      }
      const before = await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])
      const spies = watchWrites()
      const err = await writeDurable(FILE, NEW, isNumbers).then(
        () => null,
        (e: unknown) => e,
      )
      expect(isUnreadableFile(err)).toBe(true)
      expect((err as UnreadableFile).path).toBe(FILE)
      expectNoWrites(spies)
      expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual(before)
    })

    test('refuses by default', async () => {
      await put(FILE, TORN)
      await expect(writeDurable(FILE, NEW, isNumbers)).rejects.toThrow('cannot be read')
      expect(await raw(FILE)).toBe(TORN)
    })
  })

  describe('over a file that does not read, replacing', () => {
    test('writes over a torn file with no copy, and sets nothing aside', async () => {
      await put(FILE, TORN)
      await writeDurable(FILE, NEW, isNumbers, 'replace')
      expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([NEW, null, null, null])
    })

    test('moves the finished copy over a torn file without setting the torn file aside', async () => {
      await put(FILE, OTHER_SHAPE)
      await put(TMP, COPY)
      jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('killed'))
      await expect(writeDurable(FILE, NEW, isNumbers, 'replace')).rejects.toThrow('killed')
      jest.restoreAllMocks()
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([COPY, null, null])
    })

    test('writes over a torn copy with no file, and over a torn file with a torn copy', async () => {
      await put(TMP, TORN)
      await writeDurable(FILE, NEW, isNumbers, 'replace')
      expect(await diskOf([FILE, TMP])).toEqual([NEW, null])
      await put(FILE, TORN)
      await put(TMP, TORN)
      await writeDurable(FILE, COPY, isNumbers, 'replace')
      expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([COPY, null, null, null])
    })
  })

  describe("reading a cut first write as 'nothing'", () => {
    test.each(['refuse', 'replace'] as const)(
      'in %s mode removes a torn copy with no file and writes, setting nothing aside',
      async mode => {
        await put(TMP, TORN)
        await writeDurable(FILE, NEW, isNumbers, mode, 'nothing')
        expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([NEW, null, null, null])
      },
    )

    test.each([
      ['a torn file with no copy', TORN, null],
      ['a file of another shape with no copy', OTHER_SHAPE, null],
      ['a torn file and a torn copy', TORN, TORN],
    ])('still refuses %s and touches nothing', async (_label, file, copy) => {
      await put(FILE, file)
      if (copy !== null) {
        await put(TMP, copy)
      }
      const before = await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])
      const spies = watchWrites()
      const err = await writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing').then(
        () => null,
        (e: unknown) => e,
      )
      expect(isUnreadableFile(err)).toBe(true)
      expectNoWrites(spies)
      expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual(before)
    })

    test('still moves a finished copy in, and sets a torn file aside for it', async () => {
      await put(FILE, TORN)
      await put(TMP, COPY)
      jest.spyOn(RNFS, 'writeFile').mockRejectedValueOnce(new Error('killed'))
      await expect(writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing')).rejects.toThrow('killed')
      jest.restoreAllMocks()
      expect(await diskOf([FILE, TMP, ASIDE])).toEqual([COPY, null, TORN])
    })
  })

  test('applies the caller validity to the file and to the copy alike', async () => {
    const isString = (value: unknown): boolean => typeof value === 'string'
    await put(FILE, '"ok"')
    await writeDurable(FILE, '"next"', isString)
    expect(await raw(FILE)).toBe('"next"')
    await put(FILE, OLD)
    await expect(writeDurable(FILE, '"next"', isString)).rejects.toThrow('cannot be read')
  })
})

describe('a write that is cut never costs the last finished one', () => {
  const putBoth = async (file: string, copy: string): Promise<void> => {
    await put(FILE, file)
    await put(TMP, copy)
  }
  // The value to read back from the start state, null when there was no start state.
  const states: [string, (() => Promise<void>) | null, number[] | null][] = [
    ['a good file', () => put(FILE, OLD), [1, 2, 3]],
    ['a finished copy and no file', () => put(TMP, OLD), [1, 2, 3]],
    ['a good file with a torn copy beside it', () => putBoth(OLD, TORN), [1, 2, 3]],
    ['a torn file with a finished copy', () => putBoth(TORN, OLD), [1, 2, 3]],
    ['no file at all', null, null],
  ]
  const modes = ['refuse', 'replace'] as const

  async function readBack(): Promise<unknown> {
    try {
      return await readDurable(FILE, isNumbers)
    } catch (err) {
      return isUnreadableFile(err) ? 'unreadable' : 'failed'
    }
  }

  test.each(
    states.flatMap(state => modes.map(mode => [state[0], mode, state[1], state[2]] as const)),
  )(
    'from %s, in %s mode, at every step and with half a write',
    async (_label, mode, setup, before) => {
      const prepare = async (): Promise<void> => {
        ;(RNFS as unknown as { __reset: () => void }).__reset()
        await setup?.()
      }
      await prepare()
      const steps = await stepsOf(() => writeDurable(FILE, NEW, isNumbers, mode))
      expect(steps).toBeGreaterThan(4)
      for (const half of [false, true]) {
        for (let k = 0; k < steps; k += 1) {
          await prepare()
          const gone = killBefore(k, half)
          const write = writeDurable(FILE, NEW, isNumbers, mode)
          const method = await Promise.race([
            gone,
            write.then(
              () => 'finished',
              () => 'finished',
            ),
          ])
          jest.restoreAllMocks()
          expect({ half, k, died: method !== 'finished' }).toEqual({ half, k, died: true })
          // Every step leaves a finished version to read, the old one or the new one. The one start
          // with no version at all can also be left with a first write torn and nothing else, which
          // reads as unreadable rather than as none.
          const firstWriteTorn = before === null && half && method === 'writeFile'
          const allowed = firstWriteTorn ? ['unreadable'] : [before, [4, 5, 6]]
          const answer = await readBack()
          expect({
            half,
            k,
            method,
            answer: allowed.some(v => JSON.stringify(v) === JSON.stringify(answer)),
          }).toEqual({ half, k, method, answer: true })
        }
      }
    },
  )
})

// Under 'nothing' the one start with no version at all reads back as none or the new one at every
// step, since a first write torn with nothing else is the start's own state.
test.each([
  ['a good file', () => put(FILE, OLD), [1, 2, 3]],
  ['a good file with a torn copy beside it', () => Promise.all([put(FILE, OLD), put(TMP, TORN)]), [1, 2, 3]],
  ['no file at all', null, null],
  ['a torn copy and no file', () => put(TMP, TORN), null],
] as const)(
  "a write cut at every step from %s, read as 'nothing', leaves the last finished state or the new one",
  async (_label, setup, before) => {
    const prepare = async (): Promise<void> => {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await setup?.()
    }
    await prepare()
    const steps = await stepsOf(() => writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing'))
    expect(steps).toBeGreaterThan(4)
    for (const half of [false, true]) {
      for (let k = 0; k < steps; k += 1) {
        await prepare()
        const gone = killBefore(k, half)
        const write = writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing')
        const method = await Promise.race([
          gone,
          write.then(
            () => 'finished',
            () => 'finished',
          ),
        ])
        jest.restoreAllMocks()
        expect({ half, k, died: method !== 'finished' }).toEqual({ half, k, died: true })
        const answer = await readDurable(FILE, isNumbers, 'nothing').catch((err: unknown) =>
          isUnreadableFile(err) ? 'unreadable' : 'failed',
        )
        expect({
          half,
          k,
          method,
          answer: [before, [4, 5, 6]].some(v => JSON.stringify(v) === JSON.stringify(answer)),
        }).toEqual({ half, k, method, answer: true })
        // The next write always lands, and leaves no name set aside.
        await writeDurable(FILE, COPY, isNumbers, 'refuse', 'nothing')
        expect({ half, k, disk: await diskOf([FILE, TMP, ASIDE, TMP_ASIDE]) }).toEqual({
          half,
          k,
          disk: [COPY, null, null, null],
        })
      }
    }
  },
)

// A setAside cut between its two moves leaves the torn copy with no file. Read as 'nothing' that is no
// file, and asideExists still answers for the torn file already moved.
test('a setAside cut between its moves reads as nothing under that setting, and stays set aside', async () => {
  await put(FILE, TORN)
  await put(TMP, TORN)
  const gone = killBefore(5, false)
  setAside(FILE).catch(() => undefined)
  expect(await gone).toBe('moveFile')
  jest.restoreAllMocks()
  expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([null, TORN, TORN, null])
  expect(await readDurable(FILE, isNumbers, 'nothing')).toBeNull()
  await expect(readDurable(FILE, isNumbers)).rejects.toThrow('cannot be read')
  expect(await asideExists(FILE)).toBe(true)
})

describe('a read sent at each step of a write', () => {
  const OLD_VALUE = [1, 2, 3]
  const NEW_VALUE = [4, 5, 6]

  test('answers before or after when it waits in the write queue', async () => {
    const serial = serialQueue()
    await put(FILE, OLD)
    const steps = await stepsOf(() => serial(() => writeDurable(FILE, NEW, isNumbers)))
    expect(steps).toBeGreaterThan(4)
    for (let k = 0; k < steps; k += 1) {
      await put(FILE, OLD)
      const reads: Promise<unknown>[] = []
      let calls = 0
      trace((_method, _args, go) => {
        if (calls++ === k) {
          reads.push(serial(() => readDurable(FILE, isNumbers)))
        }
        return go()
      })
      await serial(() => writeDurable(FILE, NEW, isNumbers))
      jest.restoreAllMocks()
      expect(reads).toHaveLength(1)
      const [answer] = await Promise.all(reads)
      expect({
        k,
        ok: [OLD_VALUE, NEW_VALUE].some(v => JSON.stringify(v) === JSON.stringify(answer)),
      }).toEqual({
        k,
        ok: true,
      })
    }
  })

  // A write that moves a finished copy in before its own: the read finds no file, then no copy.
  test('control: the same read sent outside the queue finds nothing at some step', async () => {
    await put(TMP, OLD)
    const steps = await stepsOf(() => writeDurable(FILE, NEW, isNumbers))
    const answers: unknown[] = []
    for (let k = 0; k < steps; k += 1) {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await put(TMP, OLD)
      const reads: Promise<unknown>[] = []
      let calls = 0
      trace((_method, _args, go) => {
        if (calls++ === k) {
          reads.push(
            readDurable(FILE, isNumbers).then(
              value => value,
              () => 'threw',
            ),
          )
        }
        return go()
      })
      await writeDurable(FILE, NEW, isNumbers)
      jest.restoreAllMocks()
      answers.push(...(await Promise.all(reads)))
    }
    expect(answers).toContain(null)
  })
})

describe('setAside', () => {
  test('moves the file and a torn copy to their own names, byte for byte', async () => {
    await put(FILE, TORN)
    await put(TMP, OTHER_SHAPE)
    const where = await setAside(FILE)
    expect(where).toBe(ASIDE)
    expect(await diskOf([FILE, TMP, ASIDE, TMP_ASIDE])).toEqual([null, null, TORN, OTHER_SHAPE])
    expect(await readDurable(FILE, isNumbers)).toBeNull()
  })

  test('never deletes', async () => {
    await put(FILE, TORN)
    await put(TMP, TORN)
    const unlink = jest.spyOn(RNFS, 'unlink')
    await setAside(FILE)
    expect(unlink).not.toHaveBeenCalled()
  })

  test('moves a torn copy that has no file, and answers where it went', async () => {
    await put(TMP, TORN)
    expect(await setAside(FILE)).toBe(TMP_ASIDE)
    expect(await diskOf([FILE, TMP, TMP_ASIDE])).toEqual([null, null, TORN])
  })

  test('answers an empty string and touches nothing when there is nothing to move', async () => {
    const spies = watchWrites()
    expect(await setAside(FILE)).toBe('')
    expectNoWrites(spies)
  })

  test('puts a timestamp after the name when it is taken, for the file and for the copy', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    await put(FILE, 'first')
    await put(TMP, 'first copy')
    await setAside(FILE)
    await put(FILE, 'second')
    await put(TMP, 'second copy')
    expect(await setAside(FILE)).toBe(`${ASIDE}-1700000000000`)
    expect(
      await diskOf([
        ASIDE,
        TMP_ASIDE,
        `${ASIDE}-1700000000000`,
        `${TMP_ASIDE}-1700000000000`,
        FILE,
        TMP,
      ]),
    ).toEqual(['first', 'first copy', 'second', 'second copy', null, null])
  })

  test('never takes a name that a timestamp already holds', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000)
    for (const text of ['one', 'two', 'three']) {
      await put(FILE, text)
      await setAside(FILE)
    }
    expect(await diskOf([ASIDE, `${ASIDE}-1700000000000`, `${ASIDE}-1700000000001`])).toEqual([
      'one',
      'two',
      'three',
    ])
  })
})

describe('asideExists', () => {
  test('is false until something is set aside, then true', async () => {
    expect(await asideExists(FILE)).toBe(false)
    await put(FILE, TORN)
    expect(await asideExists(FILE)).toBe(false)
    await setAside(FILE)
    expect(await asideExists(FILE)).toBe(true)
  })

  test('is true for a copy set aside alone', async () => {
    await put(TMP, TORN)
    await setAside(FILE)
    expect(await asideExists(FILE)).toBe(true)
  })

  test('is true after a write set a torn file aside, and is about that path only', async () => {
    await put(FILE, TORN)
    await put(TMP, COPY)
    await writeDurable(FILE, NEW, isNumbers)
    expect(await asideExists(FILE)).toBe(true)
    expect(await asideExists(`${RNFS.DocumentDirectoryPath}/other.json`)).toBe(false)
  })
})

describe('removeDurable', () => {
  test('removes the file and its copy, the copy first', async () => {
    await put(FILE, OLD)
    await put(TMP, COPY)
    const unlink = jest.spyOn(RNFS, 'unlink')
    await removeDurable(FILE)
    expect(unlink.mock.calls.map(call => call[0])).toEqual([TMP, FILE])
    expect(await diskOf([FILE, TMP])).toEqual([null, null])
    expect(await readDurable(FILE, isNumbers)).toBeNull()
  })

  test('removes a copy that has no file', async () => {
    await put(TMP, COPY)
    await removeDurable(FILE)
    expect(await diskOf([FILE, TMP])).toEqual([null, null])
  })

  test('resolves when nothing is there, without touching the disk', async () => {
    const spies = watchWrites()
    await removeDurable(FILE)
    expectNoWrites(spies)
  })

  test('a cut after the copy went leaves the file, never the copy alone', async () => {
    await put(FILE, OLD)
    await put(TMP, COPY)
    const real = RNFS.unlink.bind(RNFS)
    jest.spyOn(RNFS, 'unlink').mockImplementation(async path => {
      if (path === FILE) {
        throw new Error('killed')
      }
      return real(path)
    })
    await expect(removeDurable(FILE)).rejects.toThrow('killed')
    jest.restoreAllMocks()
    expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
  })
})

describe('serialQueue', () => {
  const deferred = (): { promise: Promise<void>; release: () => void } => {
    let release = (): void => undefined
    const promise = new Promise<void>(resolve => {
      release = resolve
    })
    return { promise, release }
  }

  test('runs the work in the order it was sent, one at a time', async () => {
    const serial = serialQueue()
    const order: string[] = []
    const gate = deferred()
    const first = serial(async () => {
      order.push('first start')
      await gate.promise
      order.push('first end')
      return 1
    })
    const second = serial(async () => {
      order.push('second')
      return 2
    })
    await Promise.resolve()
    expect(order).toEqual(['first start'])
    gate.release()
    expect(await Promise.all([first, second])).toEqual([1, 2])
    expect(order).toEqual(['first start', 'first end', 'second'])
  })

  test('hands a failure to its own caller only, and the next work still runs', async () => {
    const serial = serialQueue()
    const failing = serial(async () => {
      throw new Error('boom')
    })
    const next = serial(async () => 'ran')
    await expect(failing).rejects.toThrow('boom')
    expect(await next).toBe('ran')
    expect(await serial(async () => 'again')).toBe('again')
  })

  test('keeps a queue of its own, so one module never waits on another', async () => {
    const mine = serialQueue()
    const theirs = serialQueue()
    const gate = deferred()
    const held = mine(() => gate.promise)
    expect(await theirs(async () => 'not held')).toBe('not held')
    gate.release()
    await held
  })
})

// A power cut keeps less than a killed process. Writes and renames sit in the page cache until the
// kernel flushes them, so after a cut each file holds what its last sync put on stable storage, and
// the directory holds the entries of its last sync plus any prefix of the changes after it, in order,
// as a journal commits them. A file never synced is taken as empty: with delayed allocation a cut can
// keep a rename and lose the data it points at, leaving 0 bytes (LWN, "ext4 and data loss", 2009).
type DiskOp =
  | { kind: 'write'; path: string; text: string }
  | { kind: 'unlink'; path: string }
  | { kind: 'move'; from: string; to: string }
  | { kind: 'syncFile'; path: string }
  | { kind: 'syncDirectory' }

function diskOpOf(method: Method, args: unknown[]): DiskOp | null {
  const [a, b] = args as [string, string]
  switch (method) {
    case 'writeFile':
      return { kind: 'write', path: a, text: b }
    case 'unlink':
      return { kind: 'unlink', path: a }
    case 'moveFile':
    case 'rename':
      return { kind: 'move', from: a, to: b }
    case 'syncFile':
      return { kind: 'syncFile', path: a }
    case 'syncDirectory':
      return { kind: 'syncDirectory' }
    default:
      return null
  }
}

// Every state a power cut can leave, from files that were on stable storage before the ops ran.
function afterCut(start: Record<string, string>, ops: DiskOp[]): Record<string, string>[] {
  const inodes: { text: string; stable: string }[] = []
  const dir = new Map<string, number>()
  for (const [path, text] of Object.entries(start)) {
    inodes.push({ text, stable: text })
    dir.set(path, inodes.length - 1)
  }
  let since: Map<string, number>[] = [new Map(dir)]
  for (const op of ops) {
    if (op.kind === 'write') {
      inodes.push({ text: op.text, stable: '' })
      dir.set(op.path, inodes.length - 1)
    } else if (op.kind === 'unlink') {
      dir.delete(op.path)
    } else if (op.kind === 'move') {
      const id = dir.get(op.from) as number
      dir.delete(op.from)
      dir.set(op.to, id)
    } else if (op.kind === 'syncFile') {
      const inode = inodes[dir.get(op.path) as number]
      inode.stable = inode.text
      continue
    } else {
      since = [new Map(dir)]
      continue
    }
    since.push(new Map(dir))
  }
  return since.map(entries =>
    Object.fromEntries([...entries].map(([path, id]) => [path, inodes[id].stable])),
  )
}

// Runs the write and cuts the power in front of call number `k`, or after the write resolved when `k`
// is past its last call. Answers the disk ops that completed before the cut.
async function opsBefore(k: number, run: () => Promise<unknown>): Promise<{ ops: DiskOp[]; resolved: boolean }> {
  const ops: DiskOp[] = []
  let calls = 0
  let died: () => void = () => undefined
  const gone = new Promise<'cut'>(resolve => {
    died = () => resolve('cut')
  })
  trace(async (method, args, go) => {
    if (calls++ === k) {
      died()
      return new Promise<never>(() => undefined)
    }
    const answer = await go()
    const op = diskOpOf(method, args)
    if (op) {
      ops.push(op)
    }
    return answer
  })
  const end = await Promise.race([gone, run().then(() => 'resolved' as const)])
  jest.restoreAllMocks()
  return { ops, resolved: end === 'resolved' }
}

async function readAfterCut(disk: Record<string, string>, cut: FirstWriteCutSetting): Promise<unknown> {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  for (const [path, text] of Object.entries(disk)) {
    await put(path, text)
  }
  return readDurable(FILE, isNumbers, cut).catch((err: unknown) =>
    isUnreadableFile(err) ? 'unreadable' : 'failed',
  )
}

type FirstWriteCutSetting = 'unreadable' | 'nothing'

describe('a power cut at any step of a write, and after it resolved', () => {
  const starts: [string, 'refuse' | 'replace', Record<string, string>, unknown][] = [
    ['a good file', 'refuse', { [FILE]: OLD }, [1, 2, 3]],
    ['no file', 'refuse', {}, null],
    ['a finished copy and no file', 'refuse', { [TMP]: COPY }, [7, 8, 9]],
    ['a torn file beside a finished copy', 'refuse', { [FILE]: TORN, [TMP]: COPY }, [7, 8, 9]],
    ['a torn file beside a finished copy', 'replace', { [FILE]: TORN, [TMP]: COPY }, [7, 8, 9]],
  ]

  test.each(starts)(
    'from %s, in %s mode, leaves the old content or the new one, and the new one once resolved',
    async (_label, mode, start, before) => {
      const prepare = async (): Promise<void> => {
        ;(RNFS as unknown as { __reset: () => void }).__reset()
        for (const [path, text] of Object.entries(start)) {
          await put(path, text)
        }
      }
      await prepare()
      const steps = await stepsOf(() => writeDurable(FILE, NEW, isNumbers, mode))
      expect(steps).toBeGreaterThan(4)
      for (let k = 0; k <= steps; k += 1) {
        await prepare()
        const { ops, resolved } = await opsBefore(k, () => writeDurable(FILE, NEW, isNumbers, mode))
        expect({ k, resolved }).toEqual({ k, resolved: k === steps })
        // With no file before, a first write cut before its copy was synced leaves a torn copy and no
        // file, which reads as unreadable under this setting (FirstWriteCut), as after a killed process.
        const allowed = resolved ? [[4, 5, 6]] : before === null ? [null, 'unreadable', [4, 5, 6]] : [before, [4, 5, 6]]
        for (const disk of afterCut(start, ops)) {
          const answer = await readAfterCut(disk, 'unreadable')
          expect({ k, disk, ok: allowed.some(v => JSON.stringify(v) === JSON.stringify(answer)) }).toEqual({
            k,
            disk,
            ok: true,
          })
        }
      }
    },
  )

  // The model has to be able to fail: the order without syncs ends with the new name on a file of 0
  // bytes and nothing else to read.
  test('control: the copy written, the file unlinked and the copy moved, with no sync, loses the file', async () => {
    const legacy: DiskOp[] = [
      { kind: 'write', path: TMP, text: NEW },
      { kind: 'unlink', path: FILE },
      { kind: 'move', from: TMP, to: FILE },
    ]
    const answers = await Promise.all(
      afterCut({ [FILE]: OLD }, legacy).map(async disk => readAfterCut(disk, 'unreadable')),
    )
    expect(answers).toContain('unreadable')
    expect(afterCut({ [FILE]: OLD }, legacy)).toContainEqual({ [FILE]: '' })
  })

  // A process killed after its copy was written and before its sync leaves a copy that reads whole from
  // the page cache but was never written out. The write that moves it in syncs it first, so no cut
  // leaves the file's own name on blocks that were never written, which reads as torn under any setting.
  test('a recovery from a finished copy never synced, cut at any step, reads as nothing, the copy or the new content', async () => {
    const unsynced: DiskOp = { kind: 'write', path: TMP, text: COPY }
    const prepare = async (): Promise<void> => {
      ;(RNFS as unknown as { __reset: () => void }).__reset()
      await put(TMP, COPY)
    }
    const write = (): Promise<void> => writeDurable(FILE, NEW, isNumbers, 'refuse', 'nothing')
    await prepare()
    const steps = await stepsOf(write)
    expect(steps).toBeGreaterThan(4)
    for (let k = 0; k <= steps; k += 1) {
      await prepare()
      const { ops, resolved } = await opsBefore(k, write)
      expect({ k, resolved }).toEqual({ k, resolved: k === steps })
      const allowed = resolved ? [[4, 5, 6]] : [null, [7, 8, 9], [4, 5, 6]]
      for (const disk of afterCut({}, [unsynced, ...ops])) {
        const answer = await readAfterCut(disk, 'nothing')
        expect({ k, disk, ok: allowed.some(v => JSON.stringify(v) === JSON.stringify(answer)) }).toEqual({
          k,
          disk,
          ok: true,
        })
      }
    }
  })

  test('syncs the copy before the rename, and the directory after it and before resolving', async () => {
    await put(FILE, OLD)
    const { ops } = await opsBefore(Number.MAX_SAFE_INTEGER, () => writeDurable(FILE, NEW, isNumbers))
    const at = (match: (op: DiskOp) => boolean): number => ops.findIndex(match)
    const synced = at(op => op.kind === 'syncFile' && op.path === TMP)
    const renamed = at(op => op.kind === 'move' && op.from === TMP && op.to === FILE)
    const dirSynced = at(op => op.kind === 'syncDirectory')
    expect(synced).toBeGreaterThan(-1)
    expect(renamed).toBeGreaterThan(synced)
    expect(dirSynced).toBeGreaterThan(renamed)
    expect(ops[ops.length - 1]).toEqual({ kind: 'syncDirectory' })
  })
})

// An unlink or a move is a directory entry that a cut can undo until the directory is synced, so a
// removal or a set aside that resolved has to be on stable storage before it resolves.
describe('a power cut after a removal or a set aside resolved', () => {
  test('a removed file and its copy never come back', async () => {
    const start = { [FILE]: OLD, [TMP]: COPY }
    for (const [path, text] of Object.entries(start)) {
      await put(path, text)
    }
    const { ops, resolved } = await opsBefore(Number.MAX_SAFE_INTEGER, () => removeDurable(FILE))
    expect(resolved).toBe(true)
    for (const disk of afterCut(start, ops)) {
      expect({ disk, answer: await readAfterCut(disk, 'unreadable') }).toEqual({ disk, answer: null })
    }
  })

  test('a file and a copy set aside stay aside', async () => {
    const start = { [FILE]: TORN, [TMP]: TORN }
    for (const [path, text] of Object.entries(start)) {
      await put(path, text)
    }
    const { ops, resolved } = await opsBefore(Number.MAX_SAFE_INTEGER, () => setAside(FILE))
    expect(resolved).toBe(true)
    expect(afterCut(start, ops)).toEqual([{ [ASIDE]: TORN, [TMP_ASIDE]: TORN }])
  })
})

// The rename replaces the file in one step, so the file itself, not only its copy, holds the old
// content or the new one at every step of a write over it.
test('a process killed at any step of a write over a good file leaves the file itself whole', async () => {
  await put(FILE, OLD)
  const steps = await stepsOf(() => writeDurable(FILE, NEW, isNumbers))
  for (let k = 0; k < steps; k += 1) {
    ;(RNFS as unknown as { __reset: () => void }).__reset()
    await put(FILE, OLD)
    const gone = killBefore(k, true)
    writeDurable(FILE, NEW, isNumbers).catch(() => undefined)
    const method = await gone
    jest.restoreAllMocks()
    expect({ k, method, file: await raw(FILE) }).toEqual({ k, method, file: expect.stringMatching(/^\[(1,2,3|4,5,6)\]$/) })
  }
})

test('a sync the platform refuses fails the write, and the file keeps its content', async () => {
  await put(FILE, OLD)
  jest.spyOn(Durable, 'syncFile').mockRejectedValueOnce(new Error('EIO'))
  await expect(writeDurable(FILE, NEW, isNumbers)).rejects.toThrow('EIO')
  expect(await raw(FILE)).toBe(OLD)
  expect(await readDurable(FILE, isNumbers)).toEqual([1, 2, 3])
})

// The rename has landed when the directory sync fails, the state a cut right after the rename leaves.
// The write rejects, since its content is not known to be on stable storage, while the file already
// reads as the new content and the next write goes ahead.
test('a directory sync the platform refuses after the rename fails the write, and the next write lands', async () => {
  await put(FILE, OLD)
  jest.spyOn(Durable, 'syncDirectory').mockRejectedValueOnce(new Error('EIO'))
  await expect(writeDurable(FILE, NEW, isNumbers)).rejects.toThrow('EIO')
  expect(await raw(FILE)).toBe(NEW)
  expect(await readDurable(FILE, isNumbers)).toEqual([4, 5, 6])
  await writeDurable(FILE, COPY, isNumbers)
  expect(await diskOf([FILE, TMP])).toEqual([COPY, null])
})

test('the native sync module has one reader', () => {
  const { execSync } = require('node:child_process') as typeof import('node:child_process')
  const readers = execSync('git grep -l "NativeVoltzDurable" -- src App.tsx index.js', {
    cwd: `${__dirname}/..`,
  })
    .toString()
    .trim()
    .split('\n')
  expect(readers).toEqual(['src/wallet/durableFile.ts'])
})
