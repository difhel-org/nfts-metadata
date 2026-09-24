export function requestsPerSecond(value: string | undefined, hasApiKey: boolean): number {
  const rps = value?.trim() ? Number(value) : hasApiKey ? 3 : 0.8;
  if (!Number.isFinite(rps) || rps <= 0 || rps > 1000) throw new Error('TONCENTER_RPS must be a number greater than 0 and at most 1000');
  return rps;
}

// Serialize request starts, not responses. Queued requests cannot claim the same
// time slot, and a slow response does not hold up independent requests.
export class RequestLimiter {
  private gate: Promise<void> = Promise.resolve();
  private nextStart = 0;
  constructor(private readonly rps: number) {
    if (!Number.isFinite(rps) || rps <= 0 || rps > 1000) throw new Error('Invalid request rate');
  }
  run<T>(request: () => Promise<T>): Promise<T> {
    let result: Promise<T>;
    const start = this.gate.then(async () => {
      while (performance.now() < this.nextStart) await Bun.sleep(Math.ceil(this.nextStart - performance.now()));
      this.nextStart = performance.now() + 1000 / this.rps;
      result = Promise.resolve().then(request);
      // Attach a rejection handler immediately; the caller receives the same error.
      void result.catch(() => {});
    });
    this.gate = start.catch(() => {});
    return start.then(() => result);
  }
}

export async function mapConcurrent<T, R>(items: readonly T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('Invalid concurrency');
  const results = new Array<R>(items.length);
  let cursor = 0;
  let failed = false;
  let firstError: unknown;
  const worker = async () => {
    while (!failed && cursor < items.length) {
      const index = cursor++;
      try { results[index] = await fn(items[index]!); }
      catch (error) { if (!failed) firstError = error; failed = true; }
    }
  };
  // Drain in-flight reads before returning an error, so nothing writes progress
  // after the caller has cleared the line or displayed an error/prompt.
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw firstError;
  return results;
}
