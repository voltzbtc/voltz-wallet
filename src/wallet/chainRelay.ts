import { answerWithin } from './answerWithin'
import { emergencyExitLive } from './emergencyExit'

// The app's one reader of the two public chain hosts, used by an emergency exit, which has to work
// the day nothing of ours does. It reads the UTXOs of an address and sends transactions the device
// already signed, so all it takes is an address, hex, or the txid of that hex: a host learns those and
// the caller's IP, can refuse or stall, and can change nothing. One host failing leads to the other.
//
// Failing to read is its own answer, never an empty list, and only an answer that says so is "sent".

type Host = { name: string; api: string; packagePath: string }

const HOSTS: readonly Host[] = [
  { name: 'mempool.space', api: 'https://mempool.space/api', packagePath: '/v1/txs/package' },
  { name: 'blockstream.info', api: 'https://blockstream.info/api', packagePath: '/txs/package' },
]

const HOST_WAIT_MS = 10_000

// A reason is a host's own text, shown to the person, and a host chooses its length.
const MAX_REASON_CHARS = 200

const FEE_ADDRESS = /^bc1[a-z0-9]{8,87}$/
const HEX = /^(?:[0-9a-fA-F]{2})+$/
const TXID = /^[0-9a-fA-F]{64}$/

// Bitcoin Core's whole reason for a transaction the network already has, with the hyphens of its
// reject codes (txn-already-known, txn-already-in-mempool), and "already in utxo set" beside "already
// in block chain", since a host can run either wording. Sending again is harmless, so a retry lands
// here. It has to be all of one reason: text that only holds these words can be a refusal quoting them.
const ALREADY_THERE =
  /^(?:txn|transaction(?:\s+outputs)?)[\s-]+already[\s-]+(?:known|in[\s-]+mempool|in[\s-]+block[\s-]*chain|in[\s-]+utxo[\s-]+set)\.?$/i

// Esplora puts the RPC's name and code in front of the node's plain text ("sendrawtransaction RPC
// error -27: Transaction outputs already in utxo set"), where mempool.space puts JSON after the name.
// Only that head comes off; what follows still has to be the whole reason.
const RPC_HEAD = /^(?:sendrawtransaction|submitpackage)\s+RPC\s+error(?:\s+-?\d+)?\s*:\s*/i

const isAlreadyThere = (reason: string): boolean => ALREADY_THERE.test(reason.trim().replace(RPC_HEAD, ''))

// Bitcoin Core's reason for an input it cannot find, given both for a transaction already in a block
// whose outputs are all spent and for one whose input another spend took. Only the host's own record
// of the txid tells the two apart.
const MISSING_OR_SPENT = /missingorspent/i

export type ChainUtxo = { txid: string; vout: number; valueSat: number }

// Only confirmed outputs can pay a package's fee. What is still in the mempool is a sum to wait for.
export type FundingRead =
  | { status: 'read'; confirmed: ChainUtxo[]; pendingSat: number }
  | { status: 'failed' }

export type Broadcast =
  | { status: 'sent'; host: string }
  | { status: 'refused'; reason: string }
  | { status: 'unreachable' }

type Deps = { request?: typeof fetch }

type HostAnswer = { status: number; text: string }
type Verdict = { kind: 'sent' } | { kind: 'refused'; reason: string }

async function ask(url: string, init: RequestInit, request: typeof fetch): Promise<HostAnswer | null> {
  const controller = new AbortController()
  const read = request(url, { ...init, signal: controller.signal })
    .then(async response => ({ status: response.status, text: await response.text() }))
    .catch(() => null)
  const answer = await answerWithin(read, HOST_WAIT_MS)
  if (answer === null) {
    controller.abort()
  }
  return answer
}

const reasonFrom = (text: string, status: number): string =>
  text.trim().slice(0, MAX_REASON_CHARS) || `HTTP ${status}`

const refused = (reason: string): Verdict => ({ kind: 'refused', reason: reason.slice(0, MAX_REASON_CHARS) })

const isSuccess = (status: number): boolean => status >= 200 && status < 300

function parsedObject(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function txErrors(body: Record<string, unknown>): string[] {
  const results = body['tx-results']
  if (typeof results !== 'object' || results === null) {
    return []
  }
  return Object.values(results).flatMap(result => {
    const error = (result as { error?: unknown } | null)?.error
    if (error === undefined || error === null) {
      return []
    }
    return [typeof error === 'string' ? error : 'unreadable answer']
  })
}

// One reason per transaction with an error, or the one the answer gives for all of them. The node's
// text comes bare or as JSON behind a prefix ("sendrawtransaction RPC error: {...}"), and a host can
// wrap that in an object of its own, so a string found inside is read the same way. Text that parses
// as neither stays one whole reason, which a list in prose cannot pass off as "already there".
function reasonsIn(text: string): string[] {
  const body = parsedObject(text.slice(Math.max(text.indexOf('{'), 0)))
  if (!body) {
    return [text.trim()]
  }
  const errors = txErrors(body)
  if (errors.length > 0) {
    return errors
  }
  const stated = [body.package_msg, body.message, body.error].find(value => typeof value === 'string')
  return typeof stated === 'string' ? reasonsIn(stated) : []
}

const blockingReason = (reasons: string[]): string | undefined =>
  reasons.find(reason => !isAlreadyThere(reason))

// A host answers a broadcast of something the network already has with an error status, so the status
// alone is no refusal. The body counts as sent under the rule of a 200: a search of it would read a
// list holding one known transaction and one refused as sent.
function refusalVerdict({ status, text }: HostAnswer): Verdict {
  const reasons = reasonsIn(text)
  const blocking = blockingReason(reasons)
  return reasons.length > 0 && blocking === undefined
    ? { kind: 'sent' }
    : refused(reasonFrom(blocking ?? text, status))
}

// The plain endpoint answers a txid, so anything else on a 200 (a proxy's page, say) is not a yes.
function txVerdict(answer: HostAnswer): Verdict {
  if (!isSuccess(answer.status)) {
    return refusalVerdict(answer)
  }
  return TXID.test(answer.text.trim()) ? { kind: 'sent' } : refused('unreadable answer')
}

// bitcoind answers submitpackage with a 200 even when it refuses, so the body is the verdict. Every
// transaction with an error has to be one the network already has: a parent already known beside a
// child refused for its fee is a refusal, which a search of the whole body would read as sent.
function packageVerdict(answer: HostAnswer): Verdict {
  if (!isSuccess(answer.status)) {
    return refusalVerdict(answer)
  }
  const body = parsedObject(answer.text)
  const message = body?.package_msg
  if (!body || typeof message !== 'string') {
    return refused('unreadable answer')
  }
  if (message === 'success') {
    return { kind: 'sent' }
  }
  const blocking = blockingReason(reasonsIn(answer.text))
  return blocking === undefined ? { kind: 'sent' } : refused(blocking)
}

// Whether the host holds this txid as confirmed. A spend that took the input elsewhere leaves this
// one unknown, which a host answers as not confirmed or not found, and anything short of a readable
// yes, a read that fails or never answers included, is no.
async function confirmedOn(host: Host, txid: string, request: typeof fetch): Promise<boolean> {
  if (!TXID.test(txid)) {
    return false
  }
  const answer = await ask(`${host.api}/tx/${txid}/status`, { method: 'GET' }, request)
  return answer !== null && isSuccess(answer.status) && parsedObject(answer.text)?.confirmed === true
}

async function firstToTake(
  send: (host: Host) => Promise<HostAnswer | null>,
  verdictOf: (answer: HostAnswer) => Verdict,
  txid: string,
  request: typeof fetch,
): Promise<Broadcast> {
  let refusal: string | null = null
  for (const host of HOSTS) {
    const answer = await send(host)
    if (answer === null) {
      continue
    }
    const verdict = verdictOf(answer)
    if (verdict.kind === 'sent') {
      return { status: 'sent', host: host.name }
    }
    // Asked of the host that refused, so the yes and the refusal come from the same view of the chain.
    if (MISSING_OR_SPENT.test(answer.text) && (await confirmedOn(host, txid, request))) {
      return { status: 'sent', host: host.name }
    }
    refusal ??= verdict.reason
  }
  return refusal === null ? { status: 'unreachable' } : { status: 'refused', reason: refusal }
}

// A fan-out, a sweep or a cooperative recovery, which pay their own fee. `txid` is that of `txHex`.
export async function broadcastTx(txHex: string, txid: string, deps: Deps = {}): Promise<Broadcast> {
  if (!emergencyExitLive()) {
    return { status: 'unreachable' }
  }
  if (!HEX.test(txHex)) {
    return { status: 'refused', reason: 'not a transaction' }
  }
  const request = deps.request ?? fetch
  return firstToTake(
    host =>
      ask(
        `${host.api}/tx`,
        { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: txHex },
        request,
      ),
    txVerdict,
    txid,
    request,
  )
}

// A zero-fee transaction and the child that pays for it. A plain broadcast refuses the parent alone.
// `parentTxid` is that of `parentHex`, the step the pair sends.
export async function broadcastPackage(
  parentHex: string,
  childHex: string,
  parentTxid: string,
  deps: Deps = {},
): Promise<Broadcast> {
  if (!emergencyExitLive()) {
    return { status: 'unreachable' }
  }
  if (!HEX.test(parentHex) || !HEX.test(childHex)) {
    return { status: 'refused', reason: 'not a transaction' }
  }
  const request = deps.request ?? fetch
  const body = JSON.stringify([parentHex, childHex])
  return firstToTake(
    host =>
      ask(
        `${host.api}${host.packagePath}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body },
        request,
      ),
    packageVerdict,
    parentTxid,
    request,
  )
}

type UtxoEntry = { utxo: ChainUtxo; confirmed: boolean }

function utxoEntry(value: unknown): UtxoEntry | null {
  const { txid, vout, value: sats, status } = (value ?? {}) as {
    txid?: unknown
    vout?: unknown
    value?: unknown
    status?: { confirmed?: unknown } | null
  }
  const confirmed = status?.confirmed
  if (
    typeof txid !== 'string' ||
    !TXID.test(txid) ||
    !Number.isSafeInteger(vout) ||
    (vout as number) < 0 ||
    !Number.isSafeInteger(sats) ||
    (sats as number) < 0 ||
    typeof confirmed !== 'boolean'
  ) {
    return null
  }
  return { utxo: { txid, vout: vout as number, valueSat: sats as number }, confirmed }
}

// One entry it cannot read makes the whole answer unreadable, since a list short of an output would
// understate what arrived. An output worth nothing states nothing and pays no fee, so it is read and
// left out, or anyone mining one to the address would stop every read for good.
function fundingFrom(text: string): FundingRead | null {
  let list: unknown
  try {
    list = JSON.parse(text)
  } catch {
    return null
  }
  if (!Array.isArray(list)) {
    return null
  }
  const entries = list.map(utxoEntry)
  if (entries.some(entry => entry === null)) {
    return null
  }
  const read = (entries as UtxoEntry[]).filter(entry => entry.utxo.valueSat > 0)
  return {
    status: 'read',
    confirmed: read.filter(entry => entry.confirmed).map(entry => entry.utxo),
    pendingSat: read.filter(entry => !entry.confirmed).reduce((sum, entry) => sum + entry.utxo.valueSat, 0),
  }
}

export async function readFunding(address: string, deps: Deps = {}): Promise<FundingRead> {
  if (!emergencyExitLive() || !FEE_ADDRESS.test(address)) {
    return { status: 'failed' }
  }
  const request = deps.request ?? fetch
  for (const host of HOSTS) {
    const answer = await ask(`${host.api}/address/${address}/utxo`, { method: 'GET' }, request)
    const read = answer && isSuccess(answer.status) ? fundingFrom(answer.text) : null
    if (read) {
      return read
    }
  }
  return { status: 'failed' }
}
