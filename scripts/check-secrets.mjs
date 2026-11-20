#!/usr/bin/env node
// CI gate for four things a public repository must never carry, namely a recovery phrase that passes
// the BIP39 checksum, a private key, a filled Breez API key, or an absolute path into somebody's home
// directory. Every text file git would publish is read, tracked or not yet added, so a secret pasted
// into a doc or a fixture is caught as surely as one in code, and a new file is caught before its
// first commit rather than after it. Kept in-repo with no dependency beyond the bip39 wordlist the app
// already ships, for the same reason as audit-gate.mjs, so the gate adds nothing to audit.
//
// Findings name the file, the line and the kind, never the matched value, so the CI log does not
// republish the secret it is reporting.
import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

const WORDLIST = JSON.parse(
  readFileSync(new URL('../node_modules/bip39/src/wordlists/english.json', import.meta.url), 'utf8'),
)
// An empty or moved wordlist would scan every file and find no phrase, which reads as a pass.
if (WORDLIST.length !== 2048) {
  console.error(`bip39 english wordlist has ${WORDLIST.length} words, expected 2048. Run npm ci.`)
  process.exit(2)
}
const INDEX = new Map(WORDLIST.map((word, i) => [word, i]))

// The lengths the app generates and imports (MnemonicLength in src/wallet/seed.ts).
const LENGTHS = [12, 24]

// Phrases that are public by design. Anybody can recompute them, so they can never guard funds.
// The words of an allowed phrase leave the scan entirely, which also covers the shorter windows
// inside a 24-word phrase that pass the 12-word checksum by chance.
const ALLOWED_PHRASES = [
  // All-zero and all-one entropy, both from the official BIP39 vectors
  // (trezor/python-mnemonic vectors.json). The first is the conventional test mnemonic.
  `${'abandon '.repeat(11)}about`,
  `${'zoo '.repeat(11)}wrong`,
  // __tests__/diceSeed.test.ts pins the dice recipe with these. Their entropy is the SHA-256 of the
  // public roll strings '123456'.repeat(8) + '12' (first 16 bytes) and '123456'.repeat(16) + '1234'.
  'unveil nice picture region tragic fault cream strike tourist control recipe tourist',
  'tornado cactus wheel picture target finish home neither trend picture shoulder endless deputy ' +
    'glide open oxygen another ability forum swear side alcohol devote random',
].map(phrase => phrase.split(' '))

// A run of wordlist tokens split around every allowed phrase it contains.
function outsideAllowed(run) {
  const segments = []
  let start = 0
  let i = 0
  while (i < run.length) {
    const hit = ALLOWED_PHRASES.find(p => p.every((word, j) => run[i + j]?.word === word))
    if (hit) {
      segments.push(run.slice(start, i))
      i += hit.length
      start = i
    } else {
      i += 1
    }
  }
  segments.push(run.slice(start))
  return segments
}

// A phrase is valid when the SHA-256 of its entropy starts with the checksum bits it ends with:
// 4 bits for 12 words, 8 for 24. A run of wordlist words in ordinary prose passes by chance at
// those odds, which is why the checksum is verified rather than the words alone.
function validPhrase(words) {
  const bits = words.map(w => INDEX.get(w).toString(2).padStart(11, '0')).join('')
  const checksumBits = bits.length / 33
  const entropyBits = bits.slice(0, bits.length - checksumBits)
  const entropy = Buffer.from(entropyBits.match(/.{8}/g).map(byte => parseInt(byte, 2)))
  const hash = createHash('sha256').update(entropy).digest()
  const expected = [...hash]
    .map(byte => byte.toString(2).padStart(8, '0'))
    .join('')
    .slice(0, checksumBits)
  return expected === bits.slice(-checksumBits)
}

// Letters only, so digits, punctuation and line breaks between words (a numbered list, an array
// literal, a grid of words in a doc) do not break a phrase. A token counts only when it is a
// lowercase wordlist word, so an identifier such as `wordList` ends the run instead of lending it
// a fragment.
function phrases(text) {
  const found = []
  let run = []
  const flush = () => {
    for (const segment of outsideAllowed(run)) {
      for (const n of LENGTHS) {
        for (let i = 0; i + n <= segment.length; i += 1) {
          const slice = segment.slice(i, i + n)
          if (validPhrase(slice.map(t => t.word))) found.push(slice[0].at)
        }
      }
    }
    run = []
  }
  for (const m of text.matchAll(/[A-Za-z]+/g)) {
    if (INDEX.has(m[0])) {
      run.push({ word: m[0], at: m.index })
    } else {
      flush()
    }
  }
  flush()
  return found
}

// Each rule returns the offsets it matched in a file's text.
const matchAll = re => text => [...text.matchAll(re)].map(m => m.index)
const RULES = [
  { kind: 'BIP39 recovery phrase', find: phrases },
  // RSA, EC, OpenSSH, PKCS#8 (an App Store Connect .p8 is one), encrypted and PGP blocks alike.
  { kind: 'private key block', find: matchAll(/-{5}BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-{5}/g) },
  // A value after `=`, in .env style. A reference (`$VAR`, `${{ secrets.X }}`) and a placeholder in
  // angle brackets are not keys; `==` and `===` are comparisons, not assignments.
  {
    kind: 'filled Breez API key',
    find: matchAll(/\bBREEZ_(?:SPARK_)?API_KEY[ \t]*=(?!=)[ \t]*['"]?(?![$<'"\s#])[^\s'"#]+/g),
  },
  // A home directory named by its owner. A path written from the repository root or from `~` works
  // on every machine; one written from /Users/<name>/ works on one and names the person.
  { kind: 'absolute home path', find: matchAll(/\/(?:Users|home)\/[A-Za-z0-9._-]+\//g) },
  // A Google API key, the shape Firebase client configs carry. The configs stay out of git, and this
  // catches one that is force-added or a key pasted anywhere else.
  { kind: 'Google API key', find: matchAll(/\bAIza[0-9A-Za-z_-]{35}\b/g) },
]

const lineOf = (text, offset) => text.slice(0, offset).split('\n').length

// -c lists the tracked files and -o --exclude-standard the untracked ones .gitignore lets through,
// which are what the next `git add .` publishes.
const candidates = execFileSync('git', ['ls-files', '-z', '-co', '--exclude-standard'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
  .split('\0')
  .filter(Boolean)

const findings = []
let scanned = 0
for (const path of candidates) {
  // An App Store Connect key is caught by name as well, since the file may hold the key encrypted.
  if (/\.p8$/i.test(path)) {
    findings.push(`${path}: .p8 key file`)
  }
  let buffer
  try {
    buffer = readFileSync(path)
  } catch (err) {
    // A tracked file deleted from the working tree and not yet staged has nothing to read.
    if (err.code === 'ENOENT') continue
    throw err
  }
  // A NUL byte near the start is git's own test for binary content.
  if (buffer.subarray(0, 8000).includes(0)) continue
  scanned += 1
  const text = buffer.toString('utf8')
  for (const rule of RULES) {
    for (const offset of rule.find(text)) {
      findings.push(`${path}:${lineOf(text, offset)}: ${rule.kind}`)
    }
  }
}

if (findings.length) {
  console.error(`${findings.length} finding(s) that must not be published:`)
  for (const f of findings) console.error(`  - ${f}`)
  console.error(
    '\nRemove the value. A test that needs a phrase uses a public vector listed in ALLOWED_PHRASES.',
  )
  process.exit(1)
}

console.log(`Secrets gate passed: ${scanned} text files (tracked and untracked), no findings.`)
