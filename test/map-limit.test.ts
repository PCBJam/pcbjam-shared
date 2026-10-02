import { describe, expect, it } from "vitest";
import { mapLimit } from "../src/map-limit.js";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("mapLimit", () => {
  it("preserves input order in the results", async () => {
    const out = await mapLimit([3, 1, 2], 2, async (n) => {
      await new Promise((r) => setTimeout(r, n * 5));
      return n * 10;
    });
    expect(out).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapLimit(Array.from({ length: 20 }, (_, i) => i), 4, async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight -= 1;
    });
    expect(peak).toBeLessThanOrEqual(4);
    expect(peak).toBeGreaterThan(1);
  });

  it("fails fast: rethrows the first error and stops launching new work", async () => {
    const started: number[] = [];
    await expect(
      mapLimit(Array.from({ length: 20 }, (_, i) => i), 2, async (i) => {
        started.push(i);
        await tick();
        if (i === 3) throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    // Workers stop pulling after the failure — the tail is never started.
    expect(started.length).toBeLessThan(20);
  });

  it("handles empty input and limit larger than the list", async () => {
    expect(await mapLimit([], 8, async (n) => n)).toEqual([]);
    expect(await mapLimit([1, 2], 8, async (n) => n + 1)).toEqual([2, 3]);
  });
});
