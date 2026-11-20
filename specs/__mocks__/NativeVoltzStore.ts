import type {
  NativeBuyResult,
  NativeProduct,
  NativePurchase,
  NativeRefundResult,
  NativeUpdate,
  Spec,
} from '../NativeVoltzStore'

// The store bridge under Jest, wired by jest.setup.js. It keeps the native contract the spec
// describes, queue included: an update that arrives before anyone listens waits in a queue capped at
// QUEUE_LIMIT, takeQueued hands it back and switches to emitting, and losing the last listener goes
// back to queueing. Tests drive it through `control`, read with jest.requireMock, since importing this
// file directly yields a second instance that the code under test never sees.

export const QUEUE_LIMIT = 100

type Handler = (update: NativeUpdate) => void
type BuyScript = (productId: string, reference: string, accountId: string | null) => NativeBuyResult | Promise<NativeBuyResult>
type Method = 'loadProducts' | 'buy' | 'openPurchases' | 'finish' | 'takeQueued' | 'beginRefundRequest'
type RefundScript = (transactionId: string) => NativeRefundResult | Promise<NativeRefundResult>

const state = {
  queue: [] as NativeUpdate[],
  direct: false,
  handlers: new Set<Handler>(),
  products: [] as NativeProduct[],
  open: [] as NativePurchase[],
  buy: null as BuyScript | null,
  refund: null as RefundScript | null,
  failures: new Map<Method, { code: string; message: string }>(),
  // A takeQueued that answers only when the test releases it, for the window between subscribing and
  // draining.
  heldDrain: null as null | (() => void),
  holdDrain: false,
  calls: {
    buy: [] as Array<{ productId: string; reference: string; accountId: string | null }>,
    finish: [] as string[],
    openPurchases: 0,
    takeQueued: 0,
    beginRefundRequest: [] as string[],
  },
}

function failure(method: Method): Error | null {
  const planned = state.failures.get(method)
  if (!planned) {
    return null
  }
  state.failures.delete(method)
  // What a rejected TurboModule promise looks like in JS: an Error carrying the native code.
  return Object.assign(new Error(planned.message), { code: planned.code })
}

const double: Spec = {
  getConstants: () => ({}),
  async loadProducts(ids) {
    const failed = failure('loadProducts')
    if (failed) {
      throw failed
    }
    return state.products.filter(p => ids.includes(p.id))
  },
  async buy(productId, reference, accountId) {
    state.calls.buy.push({ productId, reference, accountId })
    const failed = failure('buy')
    if (failed) {
      throw failed
    }
    if (!state.buy) {
      throw new Error('the double has no scripted purchase')
    }
    return state.buy(productId, reference, accountId)
  },
  async openPurchases() {
    state.calls.openPurchases += 1
    const failed = failure('openPurchases')
    if (failed) {
      throw failed
    }
    return [...state.open]
  },
  async finish(transactionId) {
    state.calls.finish.push(transactionId)
    const failed = failure('finish')
    if (failed) {
      throw failed
    }
    const index = state.open.findIndex(p => p.key === transactionId)
    if (index < 0) {
      return false
    }
    state.open.splice(index, 1)
    return true
  },
  async takeQueued() {
    state.calls.takeQueued += 1
    const failed = failure('takeQueued')
    if (failed) {
      throw failed
    }
    if (state.holdDrain) {
      await new Promise<void>(resolve => {
        state.heldDrain = resolve
      })
    }
    const drained = state.queue
    state.queue = []
    state.direct = true
    return drained
  },
  async beginRefundRequest(transactionId) {
    state.calls.beginRefundRequest.push(transactionId)
    const failed = failure('beginRefundRequest')
    if (failed) {
      throw failed
    }
    if (!state.refund) {
      throw new Error('the double has no scripted refund sheet')
    }
    return state.refund(transactionId)
  },
  onUpdate(handler) {
    state.handlers.add(handler)
    const subscription = {
      remove: () => {
        state.handlers.delete(handler)
        if (state.handlers.size === 0) {
          state.direct = false
        }
      },
    }
    // The declared EventSubscription is the legacy emitter's class; callers only ever call remove().
    return subscription as unknown as ReturnType<Spec['onUpdate']>
  },
}

export default double

export function purchase(over: Partial<NativePurchase> = {}): NativePurchase {
  return {
    productIds: ['name_standard'],
    key: '2000000123456789',
    reference: null,
    state: 'purchased',
    purchasedAt: 1_800_000_000_000,
    verified: true,
    revoked: false,
    ...over,
  }
}

export function update(purchases: NativePurchase[], code = 'OK', subCode: string | null = null): NativeUpdate {
  return { code, subCode, message: null, purchases }
}

export const control = {
  state,
  // What the store does next: an update reaches the listeners when the native side emits directly,
  // and waits in the queue otherwise.
  emit(next: NativeUpdate): void {
    if (state.direct && state.handlers.size > 0) {
      state.handlers.forEach(handler => handler(next))
      return
    }
    state.queue.push(next)
    if (state.queue.length > QUEUE_LIMIT) {
      state.queue.shift()
    }
  },
  scriptBuy(script: BuyScript): void {
    state.buy = script
  },
  scriptRefund(script: RefundScript): void {
    state.refund = script
  },
  failNext(method: Method, code: string, message = code): void {
    state.failures.set(method, { code, message })
  },
  // Stands for a JS reload, which invalidates the module, drops its listeners and queues again.
  reload(): void {
    state.handlers.clear()
    state.direct = false
  },
  releaseDrain(): void {
    state.holdDrain = false
    state.heldDrain?.()
    state.heldDrain = null
  },
  reset(): void {
    state.queue = []
    state.direct = false
    state.handlers.clear()
    state.products = []
    state.open = []
    state.buy = null
    state.refund = null
    state.failures.clear()
    state.heldDrain = null
    state.holdDrain = false
    state.calls = { buy: [], finish: [], openPurchases: 0, takeQueued: 0, beginRefundRequest: [] }
  },
}
