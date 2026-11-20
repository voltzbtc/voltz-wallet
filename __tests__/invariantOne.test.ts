import { readFileSync } from 'fs'
import { join } from 'path'

// Invariant 1 and the points of trust are promises kept in prose, which no type or screen test
// reads. The files are read here so that a rewrite cannot drop a promise with the suite still green.

const ROOT = join(__dirname, '..')
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8')
const flat = (text: string): string => text.replace(/\s+/g, ' ').trim()

const INVARIANT =
  "The wallet's private key is created on the device and never leaves it. No server run by the " +
  "project receives a mnemonic, a seed, a key, a passkey or a passkey's PRF output, whatever the " +
  "feature. A passkey wallet derives its mnemonic on the device from the user's passkey, which the " +
  "user's own Apple or Google account may sync, end to end encrypted, and which the project never " +
  'receives.'

/** The body under a level two heading, up to the next one, or undefined with no such heading. */
function section(text: string, title: string): string | undefined {
  const start = text.split('\n').indexOf(`## ${title}`)
  if (start < 0) {
    return undefined
  }
  const rest = text.split('\n').slice(start + 1)
  const end = rest.findIndex(line => line.startsWith('## '))
  return (end < 0 ? rest : rest.slice(0, end)).join('\n')
}

function agentsInvariant(): string | undefined {
  return section(read('AGENTS.md'), 'Invariants')?.match(/^1\. ([\s\S]*?)^2\. /m)?.[1]
}

function principlesInvariant(): string | undefined {
  const body = section(
    read('docs/principles.md'),
    '1. The key is born on the device and stays there',
  )
  return body?.trim().split('\n\n')[0]
}

describe('reading the files', () => {
  it('answers undefined for a heading the text does not have', () => {
    expect(section('## One\nbody\n## Two\nmore\n', 'Three')).toBeUndefined()
  })

  it('stops a section at the next heading', () => {
    expect(section('## One\nbody\n## Two\nmore\n', 'One')).toBe('body')
  })
})

describe('invariant 1', () => {
  it('reads word for word in AGENTS.md', () => {
    expect(flat(agentsInvariant() ?? '')).toBe(INVARIANT)
  })

  it('reads word for word in principles.md', () => {
    expect(flat(principlesInvariant() ?? '')).toBe(INVARIANT)
  })

  it.each([
    ['AGENTS.md', agentsInvariant],
    ['principles.md', principlesInvariant],
  ])('in %s, keeps every secret from every server the project runs', (_file, invariant) => {
    const sentence = flat(invariant() ?? '').match(
      /No server run by the project receives ([^.]*), whatever the feature\./,
    )
    // Compared as a whole list, because "a passkey" would still match inside "a passkey's".
    expect(sentence?.[1].split(/, | or /)).toEqual([
      'a mnemonic',
      'a seed',
      'a key',
      'a passkey',
      "a passkey's PRF output",
    ])
  })
})

describe('the trust model', () => {
  const model = read('docs/trust-model.md')
  const titles = ['Passkey wallets', 'Update notice', 'Emergency exit relay']

  it.each(titles)('has a section called %s', title => {
    expect(section(model, title)).toBeDefined()
  })

  // A trust model that describes something absent misleads its reader, so each section says first
  // whether any release carries it.
  it.each(titles)('opens %s with the release it applies from', title => {
    const opening = flat(section(model, title) ?? '')
    expect(opening).toMatch(/^(Not active in any released build yet\.|Applies from release \d)/)
  })

  it('says who decides which apps can ask for the passkey', () => {
    expect(flat(section(model, 'Passkey wallets') ?? '')).toMatch(
      /controls the `\.well-known` files of `usevoltz\.app` decides which apps can ask for the passkey/,
    )
  })

  it('says that taking the files down costs the passkey on a new device and not the words', () => {
    expect(flat(section(model, 'Passkey wallets') ?? '')).toMatch(
      /Taking those files down cuts the passkey off on a new device, and the recovery words stay valid/,
    )
  })
})
