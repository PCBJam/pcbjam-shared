import { describe, expect, it } from "vitest";
// @ts-expect-error -- plain .mjs script, no declarations
import { checkDoc } from "../scripts/check-doc-dates.mjs";

const doc = (created: string, updated: string, body = "Text.\n") =>
  `---\ntitle: T\ncreated: ${created}\nupdated: ${updated}\n---\n\n${body}`;
const TODAY = "2026-10-05";

describe("check-doc-dates", () => {
  it("accepts a new page with sane dates", () => {
    expect(checkDoc("a.md", doc("2026-09-01", "2026-10-01"), null, TODAY)).toEqual([]);
  });

  it("catches a text change without an updated bump", () => {
    const problems = checkDoc("a.md", doc("2026-09-01", "2026-10-01", "New text.\n"), doc("2026-09-01", "2026-10-01"), TODAY);
    expect(problems.join()).toMatch(/bump it/);
  });

  it("accepts a text change with a bump, and a dates-only change", () => {
    expect(checkDoc("a.md", doc("2026-09-01", "2026-10-05", "New.\n"), doc("2026-09-01", "2026-10-01"), TODAY)).toEqual([]);
    expect(checkDoc("a.md", doc("2026-09-01", "2026-10-01"), doc("2026-09-01", "2026-10-01"), TODAY)).toEqual([]);
  });

  it("catches future dates, updated before created, missing or malformed dates, a moved created", () => {
    expect(checkDoc("a.md", doc("2026-09-01", "2027-01-01"), null, TODAY).join()).toMatch(/future/);
    expect(checkDoc("a.md", doc("2026-09-10", "2026-09-01"), null, TODAY).join()).toMatch(/before `created`/);
    expect(checkDoc("a.md", "---\ntitle: T\n---\nx", null, TODAY)).toHaveLength(2);
    expect(checkDoc("a.md", doc("2026-9-1", "2026-10-01"), null, TODAY).join()).toMatch(/not YYYY-MM-DD/);
    expect(checkDoc("a.md", doc("2026-09-02", "2026-10-02"), doc("2026-09-01", "2026-10-01"), TODAY).join()).toMatch(/never changes/);
  });
});
