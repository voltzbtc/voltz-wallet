// A wait as minutes and seconds (2:05), in the language's digits, as the word grid numbers its cells.
// Rounded up, so a wait never reads 0:00 while it still runs.
export function formatClock(ms: number, language: string): string {
  const total = Math.ceil(ms / 1000)
  const minutes = new Intl.NumberFormat(language).format(Math.floor(total / 60))
  const seconds = new Intl.NumberFormat(language, { minimumIntegerDigits: 2 }).format(total % 60)
  return `${minutes}:${seconds}`
}
