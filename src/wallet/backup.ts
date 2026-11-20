import { wordlists } from 'bip39'

// Math.random suffices because the shuffle only randomizes what the backup check asks and the order
// of its options, and never produces key material.
export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const result = [...items]
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[result[i], result[j]] = [result[j], result[i]]
  }
  return result
}

// How many words the check asks for. Enough that a guess fails, few enough to be done in a moment,
// which is what keeps the check from being skipped.
const QUESTIONS = 3

// How many words each question offers, the right one among them, as Blockstream Green does. Three
// in a row guessed right is a chance in 64, and a wrong pick starts over with new positions.
export const OPTIONS = 4

// One position from each third of the phrase, so a page holding only part of it cannot pass, and
// ascending by construction, so the questions follow the order the words are written down. Never
// stored: a check left halfway draws new positions.
export function pickPositions(wordCount: number, random: () => number = Math.random): number[] {
  return Array.from({ length: QUESTIONS }, (_, part) => {
    const start = Math.floor((part * wordCount) / QUESTIONS)
    const end = Math.floor(((part + 1) * wordCount) / QUESTIONS)
    return start + Math.floor(random() * (end - start))
  })
}

export type Question = {
  // Zero based; the screen numbers it from one.
  position: number
  options: string[]
}

// The word at the position among other words of the same phrase, so a pick proves where a word sits
// on the paper rather than that it looks familiar. Distinct by value, since two options reading the
// same word would pass or fail alike. A phrase with fewer distinct words than that, as a dice
// phrase can be, tops up from the wordlist.
export function optionsFor(
  words: readonly string[],
  position: number,
  random: () => number = Math.random,
): string[] {
  const right = words[position]
  if (right === undefined) {
    throw new RangeError(`no word at ${position}`)
  }
  const taken = new Set(words)
  const others = shuffle(
    [...taken].filter(word => word !== right),
    random,
  )
  const fillers =
    others.length < OPTIONS - 1
      ? shuffle(
          wordlists.english.filter(word => !taken.has(word)),
          random,
        )
      : []
  const distractors = [...others, ...fillers].slice(0, OPTIONS - 1)
  return shuffle([right, ...distractors], random)
}

export const wordsOf = (mnemonic: string): string[] => mnemonic.trim().split(/\s+/)

// By value, so a phrase that repeats a word passes with that word at any of its positions.
export function isWordAt(mnemonic: string, position: number, picked: string): boolean {
  return wordsOf(mnemonic)[position] === picked
}
