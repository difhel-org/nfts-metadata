import { test, expect, spyOn } from 'bun:test';
import { RequestLimiter, mapConcurrent, requestsPerSecond } from '../scripts/requests';
import { parseEnvironment } from '../scripts/wallet';
import { Chain } from '../scripts/network';
import { ProgressLine } from '../scripts/progress';

test('TONCENTER_RPS defaults and explicit limits are validated before secret loading', () => {
  expect(requestsPerSecond(undefined, false)).toBe(0.8);
  expect(requestsPerSecond('', true)).toBe(3);
  expect(parseEnvironment({ WALLET_VERSION: 'w5', TONCENTER_RPS: '10' }).rps).toBe(10);
  expect(requestsPerSecond('0.5', false)).toBe(0.5);
  for (const value of ['0', '-1', 'NaN', 'Infinity', 'abc', '1001']) expect(() => requestsPerSecond(value, false)).toThrow('TONCENTER_RPS');
});

test('concurrent requests start at separate rate-limited times, without waiting for responses', async () => {
  const limiter = new RequestLimiter(50);
  const starts: number[] = [];
  let releaseFirst!: () => void;
  const firstResponse = new Promise<void>(resolve => { releaseFirst = resolve; });
  let firstFinished = false;
  const jobs = Array.from({ length: 8 }, (_, i) => limiter.run(async () => {
    starts.push(performance.now());
    if (i === 0) { await firstResponse; firstFinished = true; }
    if (i === 7) { expect(firstFinished).toBe(false); releaseFirst(); }
    return i;
  }));
  expect(await Promise.all(jobs)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i-1]!).toBeGreaterThanOrEqual(19);
});

test('failed request does not poison the scheduler', async () => {
  const limiter = new RequestLimiter(1000);
  const results = await Promise.allSettled([
    limiter.run(async () => { throw new Error('failed'); }),
    limiter.run(async () => 'ok'),
  ]);
  expect(results[0]!.status).toBe('rejected');
  expect(results[1]).toEqual({ status: 'fulfilled', value: 'ok' });
});

test('shared limiter includes read retries and single-attempt submission', async () => {
  const reports: string[] = [];
  const chain = new Chain('mainnet', undefined, message => reports.push(message), 50);
  let attempts = 0;
  const starts: number[] = [];
  const send = spyOn(chain.client, 'sendFile').mockImplementation(async () => {
    starts.push(performance.now());
    throw Object.assign(new Error('submission uncertain'), { status: 429 });
  });
  try {
    const results = await Promise.allSettled([
      chain.read(async () => {
        starts.push(performance.now());
        if (++attempts === 1) throw Object.assign(new Error('rate limited'), { status: 429 });
        return 'ok';
      }),
      chain.sendFile(Buffer.alloc(0)),
    ]);
    expect(attempts).toBe(2);
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'ok' });
    expect(results[1]!.status).toBe('rejected');
    expect(send).toHaveBeenCalledTimes(1);
    expect(reports[0]).toContain('HTTP 429');
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i-1]!).toBeGreaterThanOrEqual(19);
  } finally { send.mockRestore(); }
});

test('parallel NFT checks preserve index order and stay within the worker bound', async () => {
  let active = 0, maxActive = 0;
  const result = await mapConcurrent([0, 1, 2, 3], 2, async i => {
    maxActive = Math.max(maxActive, ++active);
    await Bun.sleep(i === 0 ? 25 : 1);
    active--;
    return `#${i}`;
  });
  expect(result).toEqual(['#0', '#1', '#2', '#3']);
  expect(maxActive).toBe(2);
});

test('failed batch drains in-flight work and stops starting new NFT checks', async () => {
  const seen: number[] = [];
  let drained = false;
  await expect(mapConcurrent([0, 1, 2, 3], 2, async i => {
    seen.push(i);
    if (i === 0) throw new Error('RPC unavailable');
    await Bun.sleep(10);
    drained = true;
  })).rejects.toThrow('RPC unavailable');
  expect(seen).toEqual([0, 1]);
  expect(drained).toBe(true);
});

test('terminal progress replaces one line and clears it; redirected output stays clean', () => {
  const writes: string[] = [];
  const progress = new ProgressLine({ isTTY: true, columns: 80, write: s => writes.push(s) });
  progress.update('Fetching 1');
  progress.update('Fetching 2');
  progress.clear();
  progress.clear();
  expect(writes).toEqual(['\r\x1b[2KFetching 1', '\r\x1b[2KFetching 2', '\r\x1b[2K']);
  const pipe = new ProgressLine({ isTTY: false, write: s => writes.push(s) });
  pipe.update('hidden');
  pipe.clear();
  expect(writes.length).toBe(3);
});
