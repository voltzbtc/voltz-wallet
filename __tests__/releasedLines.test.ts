import RNFS from 'react-native-fs'
import { getActiveWalletId } from '../src/wallet/walletRegistry'
import {
  activeScope,
  claimLine,
  forgetWalletLines,
  listLines,
  noteLine,
  onAskedWallet,
  putBack,
  sayOnce,
  scopeOn,
  takeLine,
  type ReleasedLine,
} from '../src/wallet/releasedLines'

jest.mock('../src/wallet/walletRegistry', () => ({ getActiveWalletId: jest.fn(async () => 'w_a') }))

const FILE = `${RNFS.DocumentDirectoryPath}/released-lines.json`
const ASIDE = `${FILE}.unreadable`

const line = (reference: string, kind: 'name' | 'tier' = 'name', answer: ReleasedLine['answer'] = 'repaid'): ReleasedLine => ({
  kind,
  reference,
  answer,
  subject: kind === 'name' ? `alice@usevoltz.app` : 'pay.bakery.com.br',
})

beforeEach(() => {
  ;(RNFS as unknown as { __reset: () => void }).__reset()
  jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
})

// A case that fails before restoring a file system spy would otherwise fail every case after it.
afterEach(() => {
  jest.restoreAllMocks()
})

// A line lives on its own, as many per wallet as there are, one per kind and reference, and is
// shown only by the reader that took it out.
describe('the list of lines no view has shown', () => {
  it('hands each line out once, oldest of its kind first, and leaves the others', async () => {
    await noteLine(line('ref-1'), await activeScope())
    await noteLine(line('ref-2', 'tier', 'boughtBefore'), await activeScope())
    await noteLine(line('ref-3', 'name', 'paidAgain'), await activeScope())
    expect((await listLines()).map(l => l.reference)).toEqual(['ref-1', 'ref-2', 'ref-3'])

    expect(await takeLine('name', await activeScope())).toEqual(line('ref-1'))
    expect(await takeLine('name', await activeScope())).toEqual(line('ref-3', 'name', 'paidAgain'))
    expect(await takeLine('name', await activeScope())).toBeNull()
    expect((await listLines()).map(l => l.reference)).toEqual(['ref-2'])
    expect(await claimLine('ref-2', await activeScope())).toEqual({ outcome: 'claimed', line: line('ref-2', 'tier', 'boughtBefore') })
    expect(await claimLine('ref-2', await activeScope())).toEqual({ outcome: 'shown' })
    expect(await takeLine('tier', await activeScope())).toBeNull()
    expect(await listLines()).toEqual([])
  })

  it('keeps one line per kind and reference', async () => {
    await noteLine(line('ref-1'), await activeScope())
    await noteLine(line('ref-1', 'name', 'paidAgain'), await activeScope())
    expect(await listLines()).toEqual([line('ref-1')])
  })

  // The same answer heard by a reader whose question was already out when another view showed it is
  // not kept to be said again, so it is never said twice.
  it('drops a line heard again after its reference was shown, whoever took it', async () => {
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'claimed', line: null })
    await noteLine(line('ref-1'), await activeScope())
    expect(await listLines()).toEqual([])

    await noteLine(line('ref-2'), await activeScope())
    expect(await takeLine('name', await activeScope())).not.toBeNull()
    await noteLine(line('ref-2'), await activeScope())
    expect(await listLines()).toEqual([])

    // A reference never shown is kept, as the check against the drop above.
    await noteLine(line('ref-3'), await activeScope())
    expect(await listLines()).toEqual([line('ref-3')])
  })

  it('remembers only the newest shown references', async () => {
    for (let n = 0; n < 17; n++) {
      await claimLine(`ref-${n}`, await activeScope())
    }
    await noteLine(line('ref-0'), await activeScope())
    await noteLine(line('ref-1'), await activeScope())
    expect((await listLines()).map(l => l.reference)).toEqual(['ref-0'])
  })

  it('puts a line taken by a view that went away back first, and takes it again once', async () => {
    await noteLine(line('ref-1'), await activeScope())
    await noteLine(line('ref-2'), await activeScope())
    const taken = (await takeLine('name', await activeScope()))!
    await putBack(taken, await activeScope())
    await putBack(taken, await activeScope())
    expect((await listLines()).map(l => l.reference)).toEqual(['ref-1', 'ref-2'])
    expect((await takeLine('name', await activeScope()))?.reference).toBe('ref-1')
    expect((await takeLine('name', await activeScope()))?.reference).toBe('ref-2')
    expect(await takeLine('name', await activeScope())).toBeNull()
  })

  // A wallet whose data is gone, or that left the device, takes its lines and shown references with it.
  it('forgets one wallet whole and leaves every other wallet as it was', async () => {
    await noteLine(line('ref-1'), await activeScope())
    expect(await claimLine('ref-s', await activeScope())).toEqual({ outcome: 'claimed', line: null })
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    await noteLine(line('ref-2', 'tier'), await activeScope())
    await forgetWalletLines('w_a')
    expect(await listLines()).toEqual([line('ref-2', 'tier')])
    jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
    expect(await listLines()).toEqual([])
    expect(await claimLine('ref-s', await activeScope())).toEqual({ outcome: 'claimed', line: null })
    await forgetWalletLines('w_a')
    await forgetWalletLines('w_b')
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  // A reader that took a line before its wallet was removed or its data deleted (the sweep's card,
  // Home dropping it) must not write it back under that id, or the same words taking the id again bring
  // the line back, which the forget exists to prevent.
  it('puts back no line handed out before its wallet was forgotten, from a take or a claim', async () => {
    await noteLine(line('ref-1'), scopeOn('w_a'))
    await noteLine(line('ref-2'), scopeOn('w_a'))
    const claimedOn = scopeOn('w_a')
    const claim = await claimLine('ref-1', claimedOn)
    const takenOn = await activeScope()
    const taken = await takeLine('name', takenOn)
    expect(claim).toEqual({ outcome: 'claimed', line: line('ref-1') })
    expect(taken).toEqual(line('ref-2'))
    await forgetWalletLines('w_a')
    await putBack((claim as { line: ReleasedLine }).line, claimedOn)
    await putBack(taken as ReleasedLine, takenOn)
    expect(await listLines('w_a')).toEqual([])
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('keeps it out whichever of the forget and the put-back the queue runs first', async () => {
    await noteLine(line('ref-1'), scopeOn('w_a'))
    const firstOn = scopeOn('w_a')
    const first = (await takeLine('name', firstOn)) as ReleasedLine
    await Promise.all([forgetWalletLines('w_a'), putBack(first, firstOn)])
    expect(await listLines('w_a')).toEqual([])
    await noteLine(line('ref-2'), scopeOn('w_a'))
    const secondOn = scopeOn('w_a')
    const second = (await takeLine('name', secondOn)) as ReleasedLine
    await Promise.all([putBack(second, secondOn), forgetWalletLines('w_a')])
    expect(await listLines('w_a')).toEqual([])
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('keeps out a line taken before a forget that could not read the file', async () => {
    await noteLine(line('ref-1'), scopeOn('w_a'))
    const on = scopeOn('w_a')
    const taken = (await takeLine('name', on)) as ReleasedLine
    const read = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    await expect(forgetWalletLines('w_a')).rejects.toThrow('EACCES')
    read.mockRestore()
    await putBack(taken, on)
    expect(await listLines('w_a')).toEqual([])
  })

  it('control: puts back a line taken after the forget, or before a forget of another wallet', async () => {
    await forgetWalletLines('w_a')
    await noteLine(line('ref-1'), scopeOn('w_a'))
    const afterOn = scopeOn('w_a')
    const after = (await takeLine('name', afterOn)) as ReleasedLine
    await putBack(after, afterOn)
    expect(await listLines('w_a')).toEqual([line('ref-1')])
    const claimedOn = scopeOn('w_a')
    const claim = await claimLine('ref-1', claimedOn)
    await forgetWalletLines('w_b')
    await putBack((claim as { line: ReleasedLine }).line, claimedOn)
    expect(await listLines('w_a')).toEqual([line('ref-1')])
  })

  // An operation that started before its wallet was forgotten writes nothing for it afterwards,
  // whether the write is a note of the answer it heard, a claim's shown mark or a take.
  it('notes, claims and takes nothing for a wallet forgotten after the operation started', async () => {
    await noteLine(line('ref-1'), scopeOn('w_a'))
    const on = scopeOn('w_a')
    await forgetWalletLines('w_a')
    await noteLine(line('ref-2'), on)
    expect(await claimLine('ref-3', on)).toEqual({ outcome: 'unknown' })
    expect(await RNFS.exists(FILE)).toBe(false)
    // A line a newer reader kept after the forget is not handed to the older one.
    await noteLine(line('ref-4'), scopeOn('w_a'))
    expect(await takeLine('name', on)).toBeNull()
    expect(await claimLine('ref-4', on)).toEqual({ outcome: 'unknown' })
    expect(await listLines('w_a')).toEqual([line('ref-4')])
  })

  it('counts a forget queued ahead of the write, and one queued behind it drops what it wrote', async () => {
    const on = scopeOn('w_a')
    await Promise.all([forgetWalletLines('w_a'), noteLine(line('ref-1'), on), claimLine('ref-2', on)])
    expect(await RNFS.exists(FILE)).toBe(false)
    const later = scopeOn('w_a')
    await Promise.all([noteLine(line('ref-3'), later), claimLine('ref-4', later), forgetWalletLines('w_a')])
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('control: an operation that started after the forget, or on another wallet, writes as before', async () => {
    const other = scopeOn('w_b')
    await forgetWalletLines('w_a')
    const on = scopeOn('w_a')
    await noteLine(line('ref-1'), on)
    await noteLine(line('ref-2'), other)
    expect(await claimLine('ref-3', on)).toEqual({ outcome: 'claimed', line: null })
    expect(await claimLine('ref-3', on)).toEqual({ outcome: 'shown' })
    expect(await claimLine('ref-4', other)).toEqual({ outcome: 'claimed', line: null })
    expect(await listLines('w_a')).toEqual([line('ref-1')])
    expect(await listLines('w_b')).toEqual([line('ref-2')])
    expect(await takeLine('name', on)).toEqual(line('ref-1'))
  })

  // The forgets are counted before the registry is read, so a forget that runs while the active wallet
  // is being read keeps the operation's writes out.
  it('counts the forgets before it reads which wallet is active', async () => {
    let answer!: (id: string) => void
    jest.mocked(getActiveWalletId).mockReturnValueOnce(new Promise(resolve => (answer = resolve)))
    const pending = activeScope()
    await forgetWalletLines('w_a')
    answer('w_a')
    const on = await pending
    await noteLine(line('ref-1'), on)
    expect(await RNFS.exists(FILE)).toBe(false)
    // A scope read after the forget writes, as the check against the drop above.
    await noteLine(line('ref-1'), await activeScope())
    expect(await listLines('w_a')).toEqual([line('ref-1')])
  })

  // A write goes to the wallet its operation started on, never to the one active at the write.
  it('writes under the scope wallet whatever wallet is active when the write runs', async () => {
    const on = await activeScope()
    expect(on).toMatchObject({ walletId: 'w_a' })
    await noteLine(line('ref-1'), on)
    const taken = (await takeLine('name', on)) as ReleasedLine
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    await putBack(taken, on)
    await noteLine(line('ref-2'), on)
    expect(await listLines('w_a')).toEqual([line('ref-1'), line('ref-2')])
    expect(await listLines('w_b')).toEqual([])
  })

  // A question whose start could not read which wallet was active knows no wallet to write an answer
  // to, so nothing is written, even once the registry reads again by the time the answer lands.
  it('runs no write an answer leads to for a scope whose wallet could not be read', async () => {
    jest.mocked(getActiveWalletId).mockRejectedValueOnce(new Error('registry unreadable'))
    const unread = activeScope()
    expect(await unread).toMatchObject({ walletId: null })
    const write = jest.fn(async (_walletId: string) => undefined)
    await onAskedWallet(unread, write)
    await onAskedWallet(await unread, write)
    expect(write).not.toHaveBeenCalled()
    // A scope that read its wallet writes there, whatever wallet is active by then.
    const on = await activeScope()
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    await onAskedWallet(on, write)
    expect(write.mock.calls).toEqual([['w_a']])
  })

  it('keys lines by the paying wallet', async () => {
    await noteLine(line('ref-1'), await activeScope())
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    expect(await takeLine('name', await activeScope())).toBeNull()
    expect(await listLines()).toEqual([])
    jest.mocked(getActiveWalletId).mockResolvedValue(null)
    expect(await takeLine('name', await activeScope())).toBeNull()
    jest.mocked(getActiveWalletId).mockResolvedValue('w_a')
    expect(await takeLine('name', await activeScope())).toEqual(line('ref-1'))
  })

  it('outlives the process, and hands a line out once after it', async () => {
    await noteLine(line('ref-1'), await activeScope())
    let fresh!: typeof import('../src/wallet/releasedLines')
    // A fresh module over the same files, which is all a restart keeps.
    jest.isolateModules(() => {
      jest.doMock('react-native-fs', () => ({ __esModule: true, default: RNFS }))
      fresh = require('../src/wallet/releasedLines')
    })
    expect(await fresh.takeLine('name', await fresh.activeScope())).toEqual(line('ref-1'))
    expect(await takeLine('name', await activeScope())).toBeNull()
  })

  it('writes a line of a shape this build cannot read back untouched and never hands it out', async () => {
    const future = { kind: 'name', reference: 'ref-9', answer: 'someLaterAnswer', subject: 'x@y' }
    await RNFS.writeFile(FILE, JSON.stringify({ w_a: [future] }), 'utf8')
    expect(await takeLine('name', await activeScope())).toBeNull()
    await noteLine(line('ref-1'), await activeScope())
    expect(await takeLine('name', await activeScope())).toEqual(line('ref-1'))
    expect(JSON.parse(await RNFS.readFile(FILE, 'utf8')).w_a).toContainEqual(future)
  })
})

// A list file that cannot be read is set aside by the next note and never written over, and a reader
// meeting it shows nothing and writes nothing.
describe('a list file that cannot be read', () => {
  const TORN = '{"w_a":[{"kind":"name","refer'

  it('shows no line and writes nothing over it', async () => {
    await RNFS.writeFile(FILE, TORN, 'utf8')
    expect(await takeLine('name', await activeScope())).toBeNull()
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'unknown' })
    expect(await listLines()).toEqual([])
    await putBack(line('ref-1'), await activeScope())
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(TORN)
    expect(await RNFS.exists(ASIDE)).toBe(false)
  })

  it('is set aside by the next note, which starts the list again from its line', async () => {
    await RNFS.writeFile(FILE, TORN, 'utf8')
    await noteLine(line('ref-1'), await activeScope())
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
    expect(await takeLine('name', await activeScope())).toEqual(line('ref-1'))
  })

  it('a read the platform refused keeps the file as it is, and a note never rejects', async () => {
    await noteLine(line('ref-1'), await activeScope())
    const before = await RNFS.readFile(FILE, 'utf8')
    const readFile = jest.spyOn(RNFS, 'readFile').mockRejectedValue(new Error('EACCES'))
    await expect(noteLine(line('ref-2'), await activeScope())).resolves.toBeUndefined()
    expect(await takeLine('name', await activeScope())).toBeNull()
    readFile.mockRestore()
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
    expect(await RNFS.exists(ASIDE)).toBe(false)
  })

  it('a wallet registry that cannot be read keeps nothing and hands nothing out', async () => {
    jest.mocked(getActiveWalletId).mockRejectedValue(new Error('registry unreadable'))
    await expect(noteLine(line('ref-1'), await activeScope())).resolves.toBeUndefined()
    expect(await takeLine('name', await activeScope())).toBeNull()
    expect(await RNFS.exists(FILE)).toBe(false)
  })
})

// Only the reader that claimed a reference shows its line: one turn of the list's queue answers
// `shown`, `claimed` or `unknown`.
describe('a claim on a reference', () => {
  const TORN = '{"w_a":[{"kind":"name","refer'

  it('takes the line kept for it out, records it as shown, and answers shown to every later claim', async () => {
    await noteLine(line('ref-1'), await activeScope())
    await noteLine(line('ref-2'), await activeScope())
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'claimed', line: line('ref-1') })
    expect(await listLines()).toEqual([line('ref-2')])
    await noteLine(line('ref-1'), await activeScope())
    expect(await listLines()).toEqual([line('ref-2')])
    const before = await RNFS.readFile(FILE, 'utf8')
    const write = jest.spyOn(RNFS, 'writeFile')
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'shown' })
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(before)
  })

  it('answers claimed to exactly one of two readers claiming at once', async () => {
    await noteLine(line('ref-1'), await activeScope())
    const answers = await Promise.all([claimLine('ref-1', await activeScope()), claimLine('ref-1', await activeScope())])
    expect(answers).toEqual([{ outcome: 'claimed', line: line('ref-1') }, { outcome: 'shown' }])
  })

  // A take reads and writes the list in one turn of its queue, so of two readers taking one line at
  // once exactly one is handed it.
  it('hands a line to exactly one of two openings taking at once', async () => {
    await noteLine(line('ref-1'), await activeScope())
    expect(await Promise.all([takeLine('name', await activeScope()), takeLine('name', await activeScope())])).toEqual([line('ref-1'), null])
  })

  it('hands a line to exactly one of an opening taking it and a reader claiming it at once', async () => {
    await noteLine(line('ref-1'), await activeScope())
    expect(await Promise.all([takeLine('name', await activeScope()), claimLine('ref-1', await activeScope())])).toEqual([line('ref-1'), { outcome: 'shown' }])
    await noteLine(line('ref-2'), await activeScope())
    expect(await Promise.all([claimLine('ref-2', await activeScope()), takeLine('name', await activeScope())])).toEqual([
      { outcome: 'claimed', line: line('ref-2') },
      null,
    ])
  })

  it('answers unknown and writes nothing over a file that cannot be read', async () => {
    await RNFS.writeFile(FILE, TORN, 'utf8')
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'unknown' })
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(TORN)
    expect(await RNFS.exists(ASIDE)).toBe(false)
  })

  it('answers unknown when its write does not land, and leaves the line kept', async () => {
    await noteLine(line('ref-1'), await activeScope())
    const write = jest.spyOn(RNFS, 'writeFile').mockRejectedValue(new Error('ENOSPC'))
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'unknown' })
    write.mockRestore()
    expect(await listLines()).toEqual([line('ref-1')])
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'claimed', line: line('ref-1') })
  })
})

// A view that heard a released answer itself decides once the claim is answered.
describe('a line a view heard itself', () => {
  const TORN = '{"w_a":[{"kind":"name","refer'
  const view = (open: boolean) => ({ onScreen: jest.fn(() => open), show: jest.fn(), passOver: jest.fn() })

  it('is shown by a view on screen that claimed it, and by no later claim', async () => {
    await noteLine(line('ref-1'), await activeScope())
    const on = view(true)
    await sayOnce(line('ref-1'), await activeScope(), on)
    expect(on.show).toHaveBeenCalledTimes(1)
    expect(on.passOver).not.toHaveBeenCalled()
    expect(await listLines()).toEqual([])
    const again = view(true)
    await sayOnce(line('ref-1'), await activeScope(), again)
    expect(again.show).not.toHaveBeenCalled()
    expect(again.passOver).toHaveBeenCalledTimes(1)
  })

  it('is shown by a view on screen when the list cannot be read, which is left as it is', async () => {
    await RNFS.writeFile(FILE, TORN, 'utf8')
    const on = view(true)
    await sayOnce(line('ref-1'), await activeScope(), on)
    expect(on.show).toHaveBeenCalledTimes(1)
    expect(await RNFS.readFile(FILE, 'utf8')).toBe(TORN)
  })

  it('goes back to the list for the next view when the view closed during a claim it won', async () => {
    const off = view(false)
    await sayOnce(line('ref-1', 'name', 'paidAgain'), await activeScope(), off)
    expect(off.show).not.toHaveBeenCalled()
    expect(off.passOver).not.toHaveBeenCalled()
    expect(await listLines()).toEqual([line('ref-1', 'name', 'paidAgain')])
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'claimed', line: line('ref-1', 'name', 'paidAgain') })
  })

  it('is noted when the view closed and the list could not be read', async () => {
    await RNFS.writeFile(FILE, TORN, 'utf8')
    await sayOnce(line('ref-1'), await activeScope(), view(false))
    expect(await RNFS.readFile(ASIDE, 'utf8')).toBe(TORN)
    expect(await listLines()).toEqual([line('ref-1')])
  })

  it('is left alone when the view closed and another reader showed it', async () => {
    await claimLine('ref-1', await activeScope())
    await sayOnce(line('ref-1'), await activeScope(), view(false))
    expect(await listLines()).toEqual([])
    expect(await claimLine('ref-1', await activeScope())).toEqual({ outcome: 'shown' })
  })

  // The line a closed view heard goes back under its question's scope, so a forget of that wallet
  // after the question started keeps it out, whether the forget runs before the claim or between the
  // claim and the put-back, and whether or not a line was kept for that reference.
  it('is neither put back nor noted for a wallet forgotten before its claim', async () => {
    const on = scopeOn('w_a')
    await forgetWalletLines('w_a')
    const off = view(false)
    await sayOnce(line('ref-1'), on, off)
    expect(off.show).not.toHaveBeenCalled()
    expect(await listLines('w_a')).toEqual([])
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  it('is not put back for a wallet forgotten between its claim and the put-back', async () => {
    for (const kept of [false, true]) {
      if (kept) {
        await noteLine(line('ref-2'), scopeOn('w_a'))
      }
      const said = sayOnce(line(kept ? 'ref-2' : 'ref-1'), scopeOn('w_a'), view(false))
      const forgot = forgetWalletLines('w_a')
      await Promise.all([said, forgot])
      expect(await listLines('w_a')).toEqual([])
      expect(await RNFS.exists(FILE)).toBe(false)
    }
  })

  it('is shown by a view still on screen whose wallet was forgotten, and written nowhere', async () => {
    const on = scopeOn('w_a')
    await forgetWalletLines('w_a')
    const open = view(true)
    await sayOnce(line('ref-1'), on, open)
    expect(open.show).toHaveBeenCalledTimes(1)
    expect(await RNFS.exists(FILE)).toBe(false)
  })

  // A view that asked on one wallet and closed after a switch puts its line back on that wallet.
  it('goes back to the wallet the question started on after a switch', async () => {
    const on = await activeScope()
    jest.mocked(getActiveWalletId).mockResolvedValue('w_b')
    await sayOnce(line('ref-1'), on, view(false))
    expect(await listLines('w_a')).toEqual([line('ref-1')])
    expect(await listLines('w_b')).toEqual([])
  })

  // Read when the claim is answered, never before it: a view open as the claim starts and closed
  // before it is answered is not painted.
  it('reads whether the view is on screen only once the claim is answered', async () => {
    let open = true
    const seen = { onScreen: jest.fn(() => open), show: jest.fn(), passOver: jest.fn() }
    const said = sayOnce(line('ref-1'), await activeScope(), seen)
    open = false
    await said
    expect(seen.show).not.toHaveBeenCalled()
    expect(await listLines()).toEqual([line('ref-1')])
  })
})
