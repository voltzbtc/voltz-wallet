// A refused write that records whether its caller attached a rejection handler. Jest never hands the
// test an unhandled rejection, so the caller's handling is read off the answer it was given.
export function handledRefusal(): { answer: Promise<void>; handled: () => boolean } {
  const refused = Promise.reject(new Error('EACCES'))
  refused.catch(() => undefined)
  let handled = false
  const answer = {
    then(ok?: (value: void) => unknown, fail?: (reason: unknown) => unknown) {
      handled ||= typeof fail === 'function'
      return refused.then(ok, fail)
    },
    catch(fail?: (reason: unknown) => unknown) {
      handled ||= typeof fail === 'function'
      return refused.catch(fail)
    },
    finally(done?: () => void) {
      return refused.finally(done)
    },
  } as unknown as Promise<void>
  return { answer, handled: () => handled }
}
