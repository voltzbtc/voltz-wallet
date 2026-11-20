import { wordlists } from 'bip39'
import {
  OPTIONS,
  isWordAt,
  optionsFor,
  pickPositions,
  shuffle,
  wordsOf,
} from '../src/wallet/backup'

describe('shuffle', () => {
  it('preserves the length', () => {
    expect(shuffle([1, 2, 3, 4])).toHaveLength(4)
  })

  it('preserves the multiset of elements', () => {
    const input = ['a', 'b', 'c', 'a']
    const output = shuffle(input)
    expect([...output].sort()).toEqual([...input].sort())
  })

  it('does not mutate the original array', () => {
    const input = [1, 2, 3, 4]
    shuffle(input, () => 0)
    expect(input).toEqual([1, 2, 3, 4])
  })

  it('produces a deterministic permutation with random fixed at 0', () => {
    // Fisher-Yates with random()=0 always swaps index i with 0.
    expect(shuffle(['A', 'B', 'C', 'D'], () => 0)).toEqual(['B', 'C', 'D', 'A'])
  })

  it('is identity when random always points to its own index', () => {
    expect(shuffle(['A', 'B', 'C', 'D'], () => 0.999)).toEqual(['A', 'B', 'C', 'D'])
  })

  it('handles empty and single-element arrays', () => {
    expect(shuffle([])).toEqual([])
    expect(shuffle(['x'])).toEqual(['x'])
  })

  it('varies the order between calls', () => {
    const draws = new Set(Array.from({ length: 40 }, () => shuffle([1, 2, 3, 4, 5, 6]).join(',')))
    expect(draws.size).toBeGreaterThan(1)
  })
})

describe('pickPositions', () => {
  test.each([12, 24])(
    'draws one position from each third of a %i word phrase, in ascending order',
    count => {
      const third = count / 3
      for (let run = 0; run < 200; run++) {
        const positions = pickPositions(count)
        expect(positions).toHaveLength(3)
        positions.forEach((position, part) => {
          expect(position).toBeGreaterThanOrEqual(part * third)
          expect(position).toBeLessThan((part + 1) * third)
        })
      }
    },
  )

  test('reaches both ends of each third', () => {
    expect(pickPositions(12, () => 0)).toEqual([0, 4, 8])
    expect(pickPositions(12, () => 0.999)).toEqual([3, 7, 11])
    expect(pickPositions(24, () => 0.999)).toEqual([7, 15, 23])
  })
})

const PHRASE = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima'
const WORDS = PHRASE.split(' ')

describe('optionsFor', () => {
  test('offers the word at the position among other words of the phrase, each once', () => {
    for (let run = 0; run < 200; run++) {
      const position = run % WORDS.length
      const options = optionsFor(WORDS, position)
      expect(options).toHaveLength(OPTIONS)
      expect(options).toContain(WORDS[position])
      expect(new Set(options).size).toBe(OPTIONS)
      // Every distractor comes from the same phrase, so only the paper tells them apart.
      expect(options.every(option => WORDS.includes(option))).toBe(true)
    }
  })

  test('the right word is not always in the same place', () => {
    const places = new Set(
      Array.from({ length: 60 }, () => optionsFor(WORDS, 4).indexOf(WORDS[4]!)),
    )
    expect(places.size).toBeGreaterThan(1)
  })

  test('a repeated word is offered once, and never as its own distractor', () => {
    const repeated = ['abandon', 'abandon', 'abandon', 'about', 'above', 'abandon']
    for (let run = 0; run < 100; run++) {
      const options = optionsFor(repeated, 1)
      expect(options.filter(option => option === 'abandon')).toHaveLength(1)
      expect(new Set(options).size).toBe(OPTIONS)
    }
  })

  test('a phrase with too few distinct words tops up from the wordlist, not from itself', () => {
    const narrow = [
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
      'abandon',
    ]
    const options = optionsFor(narrow, 3)
    expect(options).toHaveLength(OPTIONS)
    expect(options.filter(option => option === 'abandon')).toHaveLength(1)
    expect(options.every(option => wordlists.english!.includes(option))).toBe(true)
  })

  test('a position past the phrase is refused rather than asked with no right answer', () => {
    expect(() => optionsFor(WORDS, WORDS.length)).toThrow(RangeError)
    expect(() => optionsFor(WORDS, -1)).toThrow(RangeError)
  })
})

describe('wordsOf', () => {
  test('splits on any run of whitespace and ignores the ends', () => {
    expect(wordsOf('  alpha   bravo\ncharlie  ')).toEqual(['alpha', 'bravo', 'charlie'])
  })
})

describe('isWordAt', () => {
  test('the word at the position passes', () => {
    expect(isWordAt(PHRASE, 3, 'delta')).toBe(true)
  })

  test('a word of the phrase at another position fails', () => {
    expect(isWordAt(PHRASE, 3, 'echo')).toBe(false)
    expect(isWordAt(PHRASE, 3, 'alpha')).toBe(false)
  })

  test('a position past the phrase, or nothing picked, fails', () => {
    expect(isWordAt(PHRASE, 12, 'lima')).toBe(false)
    expect(isWordAt(PHRASE, 3, '')).toBe(false)
  })

  test('a repeated word passes by value at any of its positions', () => {
    expect(isWordAt('abandon abandon about', 1, 'abandon')).toBe(true)
  })

  test('tolerates surrounding and repeated whitespace', () => {
    expect(isWordAt('  alpha   bravo  ', 1, 'bravo')).toBe(true)
  })
})
