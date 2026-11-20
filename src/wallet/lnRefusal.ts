import type { Store } from './store'

// The lightning address gateway refuses with a machine-readable code, and screens show the sentence
// that code maps to, never the code itself.

// The gateway holds no charge under that reference for this wallet's key.
export const DISOWNED = 'reference does not belong to this purchase'

// A paid confirmation the gateway could not turn into the purchase.
export const PAID_NOT_GRANTED = 'paid_but_not_granted'

// A charge that bought its name or year when it settled, confirmed again once the wallet no longer
// holds it. Final, and nothing is owed, for a name and for a domain year alike.
export const BOUGHT_BEFORE = 'bought_before'

// What confirmName throws for a charge the gateway settled as paid again: the wallet already held the
// name, so the gateway answers as the holder, while this payment bought nothing.
export const PAID_AGAIN = 'paid_again'

// Codes the gateway answers with when there is nothing to charge for, covering a domain the
// customer owns, a name the generator could have produced, and one this wallet already paid for and
// never claimed. The caller registers the name directly instead of selling it.
export const FREE_NAME_CODES: ReadonlySet<string> = new Set(['free_on_this_domain', 'free_name', 'already_paid'])

// A Map rather than an object literal, because a code can come out of a response body and one like
// `constructor` must find nothing.
const KNOWN = new Map<string, string>([
  ['reserved', 'receive.lnReserved'],
  ['blocked_word', 'receive.lnReserved'],
  ['name is being bought by someone else', 'receive.lnTaken'],
  // Refused before any invoice, so nothing was charged and the name is simply not for sale.
  ['name_paid_by_another_wallet', 'receive.lnTaken'],
  // A wallet that paid a store credit for the name holds it while its register resolves.
  ['name_held_for_credit', 'receive.lnTaken'],
  // The server charges for a name the app offered as free. Saying only that it could not be created
  // leaves the buyer with no idea that paying is the way forward.
  ['payment_required', 'receive.lnNeedsPaying'],
  ['change_limit_reached', 'receive.lnChangeLimit'],
  // The shop is shut, not the name refused. Blaming the buyer for an outage sends them off to pick
  // another name that will fail the same way.
  ['treasury_unavailable', 'receive.lnShopClosed'],
  // The money already left on this one, so "nothing was charged" would be false. Read from the code
  // alone it is a payment a person sorts out, since only `final: false` says the name may still come,
  // and a reader that has the whole refusal asks paidRefusal before reaching this line.
  [PAID_NOT_GRANTED, 'recover.blockedBody'],
  // Read from the code alone, a payment that bought nothing because the name was already the wallet's,
  // said as one whose sats a person still gives back. `repaid` says whether they came back, and only
  // paidRefusal reads it, so this line claims nothing came back, as the line above claims nothing came.
  [PAID_AGAIN, 'recover.paidAgainBody'],
  // These codes are a name's, so a charge that bought its name before reads as the name, never as a
  // year on a domain.
  [BOUGHT_BEFORE, 'recover.boughtBeforeNameBody'],
  // The gateway holds no charge of this wallet's under that reference, so this wallet cannot finish
  // it. The buyer is somewhere else, and telling them the address could not be created sends them to
  // buy a name they may already own.
  [DISOWNED, 'receive.lnOtherWallet'],
  // The edge refused the request, not the name. Anything about the address failing points the buyer
  // at the one thing that is fine.
  ['too many requests', 'receive.lnTooOften'],
  // Refused on this device before anything is asked: the address was given up here, and a purchase
  // waits for "Create the address again" (deletionMark.ts, deletionRefusal).
  ['address_removed', 'receive.lnOffBuy'],
])

export function refusalKey(code: string): string | undefined {
  return KNOWN.get(code)
}

// The gateway judges a move as the receiving wallet taking the name, so a domain refusal is about
// that wallet, not about the one the person is looking at.
const MOVE = new Map<string, string>([
  ['domain_not_yours', 'receive.lnMoveNotAllowed'],
  // Refused from the moment the year runs out, while addresses already on the domain still receive,
  // so it reads as the year having run out and not as the domain being paused. Takes `domain`.
  ['domain_expired', 'domain.noticeExpiredTitle'],
])

export function moveRefusalKey(code: string | undefined): string | undefined {
  if (code === undefined) {
    return undefined
  }
  return MOVE.get(code) ?? KNOWN.get(code)
}

// SDK 0.27.2 turns any answer of the LNURL server other than 2xx or 401 into SdkError.NetworkError, and
// on React Native that error's message is only the class name. The status and the body travel in
// `inner` as "network request failed with status <n>: <body>", so the gateway's code is read from
// the body. A body that is not the gateway's JSON, such as an edge error page, is no refusal of its.
const SERVER_ANSWER = /^network request failed with status \d{3}: ([\s\S]*)$/

function gatewayBody(cause: unknown): Record<string, unknown> | undefined {
  if (typeof cause !== 'object' || cause === null) {
    return undefined
  }
  const { tag, inner } = cause as { tag?: unknown; inner?: unknown }
  if (tag !== 'NetworkError' || !Array.isArray(inner) || typeof inner[0] !== 'string') {
    return undefined
  }
  const body = SERVER_ANSWER.exec(inner[0])?.[1]
  if (body === undefined) {
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(body)
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

export function gatewayRefusal(cause: unknown): string | undefined {
  const error = gatewayBody(cause)?.error
  return typeof error === 'string' ? error : undefined
}

// The unix second a refusal that clears on its own clears, which the gateway sends as `retry_at`
// beside the code. Undefined for any other answer.
export function gatewayRetryAt(cause: unknown): number | undefined {
  return retryAtOf(gatewayBody(cause))
}

export function retryAtOf(body: Record<string, unknown> | undefined): number | undefined {
  const at = body?.retry_at
  return typeof at === 'number' && Number.isFinite(at) ? at : undefined
}

// Whether a paid refusal is final, as the gateway sends it beside `paid_but_not_granted`. Undefined
// when the body carries no boolean there, as from a gateway older than the field or for a year.
export function finalOf(body: Record<string, unknown> | undefined): boolean | undefined {
  const final = body?.final
  return typeof final === 'boolean' ? final : undefined
}

// Whether the gateway says this charge's sats were given back, or that it was paid again for a name
// the wallet already held. Absent from an older gateway, which reads as neither.
export function repaidOf(body: Record<string, unknown> | undefined): boolean | undefined {
  return body?.repaid === true ? true : undefined
}

export function paidAgainOf(body: Record<string, unknown> | undefined): boolean | undefined {
  return body?.paidAgain === true ? true : undefined
}

// What the gateway's answer about a paid charge says of the money. `coming` is `final: false`,
// another wallet's reservation in the way, which a later confirmation may still get past. `kept`
// covers `final: true`, where a person gives the sats back, and a refusal with no `final` at all,
// which a year and a gateway older than the field send for both cases alike. Saying the name or year
// is on its way there promises what may never come, so only an explicit false says it. The rest are
// final too. `repaid` is a charge whose sats were given back, `paidAgain` a payment that bought
// nothing because the wallet already held the name, whose sats a person gives back, and
// `paidAgainRepaid` the same once they were given back. `boughtBefore` is a name or year the
// charge bought before, which owes nothing. Each says the sats came back only on `repaid: true` beside it, which
// the gateway sends for this charge alone.
export type PaidAnswer = 'coming' | 'kept' | 'repaid' | 'paidAgain' | 'paidAgainRepaid' | 'boughtBefore'

// An answer no later confirmation changes, which closes the proof it is about.
export type FinalAnswer = Exclude<PaidAnswer, 'coming'>

const FINAL_ANSWERS: ReadonlySet<string> = new Set<FinalAnswer>([
  'kept',
  'repaid',
  'paidAgain',
  'paidAgainRepaid',
  'boughtBefore',
])

// Undefined for any answer that is none of these, which an older gateway never sends beside a 200.
export function paidRefusal(err: unknown): PaidAnswer | undefined {
  if (typeof err !== 'object' || err === null) {
    return undefined
  }
  const { message, final, repaid, paidAgain } = err as {
    message?: unknown
    final?: unknown
    repaid?: unknown
    paidAgain?: unknown
  }
  const given = repaid === true
  if (message === PAID_AGAIN || (message === PAID_NOT_GRANTED && paidAgain === true)) {
    return given ? 'paidAgainRepaid' : 'paidAgain'
  }
  if (message === BOUGHT_BEFORE) {
    return 'boughtBefore'
  }
  if (message !== PAID_NOT_GRANTED) {
    return undefined
  }
  if (given) {
    return 'repaid'
  }
  return final === false ? 'coming' : 'kept'
}

// Whether a value read from disk is a final answer this build knows.
export function isFinalAnswer(value: unknown): value is FinalAnswer {
  return typeof value === 'string' && FINAL_ANSWERS.has(value)
}

// The final answer a proof keeps from the gateway's last word on it, for a screen with no fresh
// answer. A proof refused for good with no answer named, or one this build does not know, reads as
// `kept`, which is what every build before the field wrote and what claims nothing came back.
export function keptAnswer(proof: { refusedForGood?: unknown; finalAnswer?: unknown }): FinalAnswer | undefined {
  if (proof.refusedForGood !== true) {
    return undefined
  }
  return isFinalAnswer(proof.finalAnswer) ? proof.finalAnswer : 'kept'
}

// Whether the answer still needs a person, who gives sats back that nobody gave back yet.
export function needsAPerson(answer: FinalAnswer): boolean {
  return answer === 'kept' || answer === 'paidAgain'
}

// An answer that owes nothing: the sats came back, or the charge bought what it was for before.
// Listed rather than read as the opposite of needsAPerson, so an answer added later holds the slot
// until it is placed here on purpose.
export function owesNothing(answer: PaidAnswer): answer is 'repaid' | 'paidAgainRepaid' | 'boughtBefore' {
  return answer === 'repaid' || answer === 'paidAgainRepaid' || answer === 'boughtBefore'
}

// Whether a paid-again answer came as the holder's, a 200 with `entitled: true`, which confirmName
// throws as PAID_AGAIN. The wallet holds the name then, while the payment itself bought nothing. A 409
// with `paidAgain` says the name is gone since.
export function holdsTheName(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { message?: unknown }).message === PAID_AGAIN
}

// Whether the answer gives the proof's slot up at once, so no reader asks the gateway about that
// charge again and the next opening offers a fresh quote. Every final answer does, except the two owed
// with nothing delivered: `kept`, and a paid-again answer that is not the holder's, whose name is gone
// since. Those keep the slot and are asked again until the gateway says the sats came back. A holder's
// paid-again answer releases: the wallet has the name, and the sats owed back are the gateway's to
// track (paid_again_at on the charge), which no confirmation from this device changes.
export function releases(answer: PaidAnswer, err: unknown): answer is FinalAnswer {
  return owesNothing(answer) || (answer === 'paidAgain' && holdsTheName(err))
}

// A record whose last answer owes nothing, or one marked as given up (`released`, written before the
// clear of every answer that releases the slot), stands for no payment owed here. Readers answer it as
// no proof, as they do one written before the send, so a clear that never landed after it is neither
// confirmed again nor holds a price back. The line such an answer says lives in releasedLines.ts,
// never here.
export function releasedProof(proof: { refusedForGood?: unknown; finalAnswer?: unknown; released?: unknown }): boolean {
  if (proof.released === true) {
    return true
  }
  const kept = keptAnswer(proof)
  return kept !== undefined && owesNothing(kept)
}

// Codes only a store order or a register that spends a credit produce, read before the ones above.
// Each one is a clear refusal that leaves no credit reserved behind it, so a register answered with
// any other code, or with none, may have landed and is read back before anything is offered.
const STORE_NAME = new Map<string, string>([
  // Another wallet holds the name while it pays, or has it already. Either way somebody else has
  // it, which is the one thing the buyer needs to hear.
  ['name_taken', 'receive.lnTaken'],
  ['held_by_another_wallet', 'receive.lnTaken'],
  // A credit's reservation of the name is waiting for its answer. Callers that can tell this
  // wallet's own reservation apart say so before reaching this line, which is about somebody else.
  ['name_pending', 'store.otherPending'],
  ['sats_purchase_in_progress', 'store.satsInProgress'],
  ['order_in_other_store', 'store.otherStore'],
  // The intent that lets a register spend a credit was missing, used or stale by the time the
  // gateway read it. Signing again fixes all three.
  ['intent_missing', 'store.retry'],
  ['intent_used', 'store.retry'],
  ['intent_expired', 'store.retry'],
  ['name_holder_unavailable', 'receive.lnShopClosed'],
])

export function storeNameRefusalKey(code: string): string | undefined {
  return STORE_NAME.get(code) ?? KNOWN.get(code)
}

// What the store answered a purchase, by the stable code store.ts maps it to. A cancel is the
// person's own choice and says nothing, and `unknown` gets the caller's fallback.
const STORE = new Map<string, string>([
  ['network', 'store.errorNetwork'],
  ['storeUnavailable', 'store.unavailable'],
  ['notAllowed', 'store.errorNotAllowed'],
  ['declined', 'store.errorDeclined'],
  ['notVerified', 'store.errorNotVerified'],
  // Google refuses a product an earlier purchase still holds, which the sync is now confirming.
  ['alreadyOwned', 'store.errorAlreadyOwned'],
])

export function storeErrorKey(code: string): string | undefined {
  return STORE.get(code)
}

// A domain year's store order, refused before the store opens. `held_by_another_wallet` here is the
// ten minute hold on the host, which on a renewal is the owner's own unsettled purchase.
const DOMAIN_ORDER = new Map<string, string>([
  ['held_by_another_wallet', 'useDomain.domainBeingBought'],
  ['sats_purchase_in_progress', 'useDomain.renewalInProgress'],
  ['order_in_other_store', 'store.otherStore'],
])

// The line under a purchase the gateway refused for good, by `${status} ${code}`. A purchase the store
// already refunded, which the gateway reads from the store's own answer about it, has its money back,
// and one made in a test environment, which the gateway reads from the transaction the store signed,
// was never charged. Every other refusal says how that store gives the money back.
const REFUSED_LINE = new Map<string, string>([
  ['409 refunded', 'store.refusedRefunded'],
  ['403 environment_not_allowed', 'store.refusedTest'],
  ['403 xcode_environment', 'store.refusedTest'],
])

export function storeRefusedKey(refusal: string, store: Store): string {
  return REFUSED_LINE.get(refusal) ?? (store === 'apple' ? 'store.refusedApple' : 'store.refusedGoogle')
}

export function domainOrderRefusalKey(code: string, renewing: boolean): string | undefined {
  if (renewing && code === 'held_by_another_wallet') {
    return 'useDomain.renewalInProgress'
  }
  return DOMAIN_ORDER.get(code)
}
