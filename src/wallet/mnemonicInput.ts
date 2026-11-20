import { wordlists } from 'bip39'

// Import is English-wordlist only regardless of UI language, matching the default
// that bip39 validation applies.
const ENGLISH: readonly string[] = wordlists.english

// BIP39 defines the mnemonic in NFKD form and the wordlist is lowercase, so pasted or
// typed text is folded to both before any wordlist or checksum check.
export function splitPhrase(text: string): string[] {
  return text
    .normalize('NFKD')
    .toLowerCase()
    .split(/\s+/)
    .filter(word => word.length > 0)
}

// An empty prefix returns nothing so the suggestion bar stays hidden until typing starts.
export function suggestWords(prefix: string, limit = 4): string[] {
  const p = prefix.trim().toLowerCase()
  if (p.length === 0) {
    return []
  }
  const matches: string[] = []
  for (const word of ENGLISH) {
    if (word.startsWith(p)) {
      matches.push(word)
      if (matches.length >= limit) {
        break
      }
    }
  }
  return matches
}

// Flags a misspelled word before the whole-phrase checksum check, which only returns a
// boolean and cannot point at the wrong word.
export function isWordlistWord(word: string): boolean {
  return ENGLISH.includes(word.trim().toLowerCase())
}
