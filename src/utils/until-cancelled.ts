/**
 * @fileoverview Waiting on work several callers share, as one of them: the work's answer, or that
 * caller's own cancellation the moment it lands, while the work runs on for the rest.
 * @module utils/until-cancelled
 */

/**
 * A shared promise as one caller waits on it: its settlement, or a rejection with `signal.reason`
 * the moment `signal` aborts. The shared work itself runs on for the callers still waiting.
 */
export function untilCancelled<T>(shared: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const cancel = () => reject(signal.reason);
    signal.addEventListener('abort', cancel, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel));
  });
}
