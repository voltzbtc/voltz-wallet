import { inspect } from 'util'

// Every line written to the console while `run` goes, as it would print, nested values in full, so a
// check that a value never reaches a log reads what a log would show.
export async function consoleLines(run: () => Promise<void>): Promise<string[]> {
  const lines: string[] = []
  const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level =>
    jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => (typeof arg === 'string' ? arg : inspect(arg, { depth: Infinity }))).join(' '))
    }),
  )
  try {
    await run()
  } finally {
    spies.forEach(spy => spy.mockRestore())
  }
  return lines
}
