import RNFS from 'react-native-fs'
import { getBreezLnurlDomain } from '../config'
import { isUnreadableFile, readDurable, serialQueue, setAside, writeDurable } from './durableFile'

// The domain this wallet's lightning address lives on.
//
// The SDK takes it once, at connect, from the build. A customer who buys their own domain needs
// their addresses to live there instead, so the choice is stored per wallet and read before
// connecting. Without it the purchase changes nothing the customer can see.
const FILE = `${RNFS.DocumentDirectoryPath}/lnurl-domain.json`

type Stored = Record<string, string>

const isChoices = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

// Losing the file moves every wallet with a domain of its own back to the shared one, so it is
// written whole through a temporary copy (durableFile.ts), and every read and write of it runs in
// this one queue.
const serial = serialQueue()

// What a change starts from. Throws when the file cannot be read, torn or refused by the platform.
async function stored(): Promise<Stored> {
  return ((await readDurable(FILE, isChoices)) as Stored | null) ?? {}
}

// The readers' answer: a file that cannot be read holds no choice, so every wallet connects to the
// build's domain until a choice is written again.
async function all(): Promise<Stored> {
  try {
    return await serial(stored)
  } catch {
    return {}
  }
}

// A torn file is set aside, never written over, and the change starts from no choice. A read the
// platform refused says nothing about the file, so the change throws and the file stays as it is.
function update(change: (choices: Stored) => void): Promise<void> {
  return serial(async () => {
    let choices: Stored
    let torn = false
    try {
      choices = await stored()
    } catch (err) {
      if (!isUnreadableFile(err)) {
        throw err
      }
      choices = {}
      torn = true
    }
    change(choices)
    if (torn) {
      await setAside(FILE)
    }
    await writeDurable(FILE, JSON.stringify(choices), isChoices)
  })
}

// The domain to connect with, or the build's when this wallet has none of its own.
export async function domainFor(walletId: string): Promise<string | undefined> {
  return (await all())[walletId] ?? getBreezLnurlDomain()
}

// What this wallet actually chose, with no fallback. It differs from `domainFor` in one case, and
// that case is the whole point: a wallet with nothing stored connects to the build domain like every
// other, yet it is the only kind that may own a domain it cannot name, because the file that named
// it lived on a handset that is gone.
export async function storedDomainFor(walletId: string): Promise<string | undefined> {
  return (await all())[walletId]
}

export function setDomainFor(walletId: string, domain: string): Promise<void> {
  return update(choices => {
    choices[walletId] = domain.trim().toLowerCase()
  })
}

// Returns the wallet to the build's domain.
export function clearDomainFor(walletId: string): Promise<void> {
  return update(choices => {
    delete choices[walletId]
  })
}
