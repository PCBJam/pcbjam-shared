/**
 * Map `items` through `fn` with at most `limit` calls in flight, preserving
 * input order in the result. Fail-fast: after the first rejection no new call
 * starts (in-flight calls settle unobserved) and the error rethrows.
 *
 * The one fan-out helper of the code base: use it instead of
 * `Promise.all(items.map(fn))`, of batches that wait for a whole batch, and
 * of hand-rolled worker pools — an unbounded fan-out over a list whose size
 * depends on data opens that many connections at once.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: { err: unknown } | null = null;
  const worker = async () => {
    while (failure === null) {
      const i = next++;
      if (i >= items.length) return;
      try {
        results[i] = await fn(items[i]!, i);
      } catch (err) {
        failure ??= { err };
        return;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker),
  );
  if (failure !== null) throw (failure as { err: unknown }).err;
  return results;
}
