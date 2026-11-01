/**
 * @fileoverview Tests for the scheduled refresh: it is scheduled only when `OFF_MIRROR_PATH` is set,
 * the job child's JSON log lines are relayed at their own level (anything else as a warning), and
 * stopping a job sends SIGTERM, then SIGKILL once the grace period passes.
 * @module tests/services/mirror/mirror-scheduler.test
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger, requestContextService } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jobLogger, spawnMirrorJob } from '@/services/mirror/mirror-scheduler.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'off-mirror-job-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

async function child(source: string): Promise<string> {
  const entry = join(dir, `child-${Math.random().toString(36).slice(2)}.mjs`);
  await writeFile(entry, source);
  return entry;
}

const context = () => requestContextService.createRequestContext({ operation: 'test' });

describe('spawnMirrorJob', () => {
  it('relays job log lines at their level and any other output as warnings', async () => {
    const info = vi.spyOn(logger, 'info');
    const error = vi.spyOn(logger, 'error');
    const warning = vi.spyOn(logger, 'warning');
    const entry = await child(`
      process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'info', message: 'Applied a delta.', meta: { delta: 'd1' } })}\n`)});
      process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'error', message: 'HTTP 429' })}\n`)});
      process.stdout.write('not a log line\\n');
      process.stderr.write('a stack trace\\n');
      process.exitCode = 3;
    `);

    const exit = await spawnMirrorJob(entry, context()).exited;

    expect(exit).toEqual({ code: 3, signal: null });
    expect(info).toHaveBeenCalledWith(
      'Applied a delta.',
      expect.objectContaining({ extra: { delta: 'd1' } }),
    );
    expect(error).toHaveBeenCalledWith('HTTP 429', expect.anything());
    const warnings = warning.mock.calls.map(([message]) => message);
    expect(warnings).toContain('Mirror refresh job: not a log line');
    expect(warnings).toContain('Mirror refresh job: a stack trace');
    expect(warnings).toContain('Mirror refresh job did not finish cleanly.');
  });

  it('stops a job with SIGTERM, letting it finish its own shutdown', async () => {
    const info = vi.spyOn(logger, 'info');
    const entry = await child(`
      process.on('SIGTERM', () => {
        process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'info', message: 'stopping' })}\n`)});
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'info', message: 'ready' })}\n`)});
    `);
    const job = spawnMirrorJob(entry, context());
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('ready', expect.anything()), {
      timeout: 15_000,
    });

    await job.stop(30_000);

    expect(await job.exited).toEqual({ code: 0, signal: null });
    expect(info).toHaveBeenCalledWith('stopping', expect.anything());
  });

  it('kills a job that outlives the grace period with SIGKILL', async () => {
    const info = vi.spyOn(logger, 'info');
    const entry = await child(`
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1000);
      process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'info', message: 'ready' })}\n`)});
    `);
    const job = spawnMirrorJob(entry, context());
    await vi.waitFor(() => expect(info).toHaveBeenCalledWith('ready', expect.anything()), {
      timeout: 15_000,
    });

    await job.stop(50);

    expect(await job.exited).toEqual({ code: null, signal: 'SIGKILL' });
  });
});

describe('jobLogger', () => {
  it('writes one JSON object per line, with meta only when given', () => {
    const lines: string[] = [];
    const log = jobLogger((line) => lines.push(line));
    log.warning?.('slow', { ms: 5 });
    log.info?.('done');
    expect(lines).toEqual([
      '{"level":"warning","message":"slow","meta":{"ms":5}}\n',
      '{"level":"info","message":"done"}\n',
    ]);
  });
});

describe('startMirrorRefreshSchedule', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function load() {
    vi.resetModules();
    const scheduler = await import('@/services/mirror/mirror-scheduler.js');
    const { schedulerService } = await import('@cyanheads/mcp-ts-core/utils');
    return { ...scheduler, schedulerService };
  }

  it('schedules nothing when OFF_MIRROR_PATH is unset', async () => {
    vi.stubEnv('OFF_MIRROR_PATH', undefined);
    const { schedulerService, startMirrorRefreshSchedule, stopMirrorRefreshSchedule } =
      await load();
    await startMirrorRefreshSchedule();
    expect(schedulerService.listJobs()).toEqual([]);
    await stopMirrorRefreshSchedule();
  });

  it('schedules the refresh every three hours when OFF_MIRROR_PATH is set, and unschedules it', async () => {
    vi.stubEnv('OFF_MIRROR_PATH', join(dir, 'store.sqlite'));
    const {
      MIRROR_REFRESH_SCHEDULE,
      schedulerService,
      startMirrorRefreshSchedule,
      stopMirrorRefreshSchedule,
    } = await load();
    await startMirrorRefreshSchedule();
    expect(schedulerService.listJobs().map((job) => job.schedule)).toEqual([
      MIRROR_REFRESH_SCHEDULE,
    ]);
    expect(MIRROR_REFRESH_SCHEDULE).toBe('30 */3 * * *');
    await stopMirrorRefreshSchedule();
    expect(schedulerService.listJobs()).toEqual([]);
  });

  it('stops the job a scheduled run started, settling once it has exited', {
    timeout: 60_000,
  }, async () => {
    vi.stubEnv('OFF_MIRROR_PATH', join(dir, 'store.sqlite'));
    const { schedulerService, startMirrorRefreshSchedule, stopMirrorRefreshSchedule } =
      await load();
    const { logger: relay } = await import('@cyanheads/mcp-ts-core/utils');
    const schedule = vi.spyOn(schedulerService, 'schedule');
    const info = vi.spyOn(relay, 'info');
    await startMirrorRefreshSchedule();
    const tick = schedule.mock.calls[0]?.[2];
    if (tick === undefined) throw new Error('Expected the refresh to be scheduled.');

    // Loaded before the job entry and never settling, so the child stays up, touches no store or
    // network, and answers SIGTERM by logging it and exiting.
    const preload = await child(`
      process.on('SIGTERM', () => {
        process.stdout.write(${JSON.stringify(`${JSON.stringify({ level: 'info', message: 'job child got SIGTERM' })}\n`)});
        process.exit(0);
      });
      setInterval(() => {}, 1000);
      process.stdout.write(JSON.stringify({ level: 'info', message: 'job child ready', meta: { pid: process.pid } }) + '\\n');
      await new Promise(() => {});
    `);
    const execArgv = process.execArgv;
    process.execArgv = [process.versions.bun ? '--preload' : '--import', preload];
    let pid: number | undefined;
    try {
      const running = Promise.resolve(tick(context()));
      await vi.waitFor(
        () => expect(info).toHaveBeenCalledWith('job child ready', expect.anything()),
        { timeout: 15_000 },
      );
      const ready = info.mock.calls.find(([message]) => message === 'job child ready')?.[1] as
        | { extra?: { pid?: number } }
        | undefined;
      pid = ready?.extra?.pid;
      expect(pid).toEqual(expect.any(Number));

      await stopMirrorRefreshSchedule();

      // Settled only after the child took SIGTERM and exited.
      expect(info).toHaveBeenCalledWith('job child got SIGTERM', expect.anything());
      expect(info).toHaveBeenCalledWith(
        'Mirror refresh job finished.',
        expect.objectContaining({ extra: { code: 0, signal: null } }),
      );
      await running;
      expect(schedulerService.listJobs()).toEqual([]);
    } finally {
      process.execArgv = execArgv;
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Already gone, as it should be.
        }
      }
    }
  });
});
