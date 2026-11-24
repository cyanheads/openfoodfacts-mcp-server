/**
 * @fileoverview Unit tests for `untilCancelled`: one caller's wait on shared work ends with the
 * work's answer, or with that caller's own cancellation the moment it lands, and the work runs on.
 * @module tests/utils/until-cancelled.test
 */

import { describe, expect, it } from 'vitest';

import { untilCancelled } from '@/utils/until-cancelled.js';

/** How a promise has settled so far: read after `flush()`. */
type Tracked = { settled: boolean; value?: unknown; error?: unknown };

function track(promise: Promise<unknown>): Tracked {
  const state: Tracked = { settled: false };
  promise.then(
    (value) => Object.assign(state, { settled: true, value }),
    (error: unknown) => Object.assign(state, { settled: true, error }),
  );
  return state;
}

/** Runs every pending promise reaction, so a `Tracked` reads what has settled by now. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('untilCancelled', () => {
  it('rejects at once with the reason of a signal aborted before the call, whatever the work holds', async () => {
    const reason = new DOMException('The caller went away.', 'AbortError');
    const controller = new AbortController();
    controller.abort(reason);

    await expect(untilCancelled(Promise.resolve('answer'), controller.signal)).rejects.toBe(reason);

    const waiting = track(
      untilCancelled(Promise.withResolvers<string>().promise, controller.signal),
    );
    await flush();
    expect(waiting).toEqual({ settled: true, error: reason });
  });

  it('rejects with the reason the moment the signal aborts, leaving the work to answer the rest', async () => {
    const work = Promise.withResolvers<string>();
    const controller = new AbortController();
    const cancelled = track(untilCancelled(work.promise, controller.signal));
    const other = track(untilCancelled(work.promise, new AbortController().signal));

    await flush();
    expect(cancelled.settled).toBe(false);

    const reason = new DOMException('The caller went away.', 'AbortError');
    controller.abort(reason);
    await flush();
    expect(cancelled).toEqual({ settled: true, error: reason });
    expect(other.settled).toBe(false);

    work.resolve('answer');
    await flush();
    expect(other).toEqual({ settled: true, value: 'answer' });
    expect(cancelled).toEqual({ settled: true, error: reason });
  });

  it('settles as the work does when it settles first, and a later abort changes nothing', async () => {
    const answered = Promise.withResolvers<string>();
    const answeredController = new AbortController();
    const resolved = track(untilCancelled(answered.promise, answeredController.signal));
    answered.resolve('answer');
    await flush();
    answeredController.abort(new DOMException('Too late.', 'AbortError'));
    await flush();
    expect(resolved).toEqual({ settled: true, value: 'answer' });

    const failure = new Error('The upstream answered 503.');
    const failed = Promise.withResolvers<string>();
    const failedController = new AbortController();
    const rejected = track(untilCancelled(failed.promise, failedController.signal));
    failed.reject(failure);
    await flush();
    failedController.abort(new DOMException('Too late.', 'AbortError'));
    await flush();
    expect(rejected).toEqual({ settled: true, error: failure });
  });
});
