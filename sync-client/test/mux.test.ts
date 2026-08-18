import type { ClientMsg, ServerMsg } from "@pcbjam/shared";
import { describe, expect, it } from "vitest";
import {
  createMuxChannelFactory,
  type RealtimeChannel,
} from "../src/transport.js";

/**
 * The shared-socket multiplexer (scope-sync-room): layers carrying a `lib`
 * multiplex key share ONE raw channel per url, frames stamped/routed by `lib`.
 * This is the piece that turns N per-lib mirror websockets into one per team.
 */

class FakeRaw implements RealtimeChannel {
  readonly sent: ClientMsg[] = [];
  closed = false;
  private openCbs: Array<() => void> = [];
  private msgCbs: Array<(m: ServerMsg) => void> = [];
  onOpen(cb: () => void): void {
    this.openCbs.push(cb);
  }
  onMessage(cb: (m: ServerMsg) => void): void {
    this.msgCbs.push(cb);
  }
  send(msg: ClientMsg): void {
    this.sent.push(msg);
  }
  close(): void {
    this.closed = true;
  }
  fireOpen(): void {
    for (const cb of this.openCbs) cb();
  }
  deliver(m: ServerMsg): void {
    for (const cb of this.msgCbs) cb(m);
  }
}

function harness() {
  const raws = new Map<string, FakeRaw[]>();
  const factory = createMuxChannelFactory((url) => {
    const raw = new FakeRaw();
    raws.set(url, [...(raws.get(url) ?? []), raw]);
    return raw;
  });
  const rawsFor = (url: string) => raws.get(url) ?? [];
  return { factory, rawsFor };
}

const ROOM = "http://api/parties/sync-room/mirror:team1";

describe("mux channel factory", () => {
  it("layers with a lib share ONE raw channel per url", () => {
    const { factory, rawsFor } = harness();
    factory({ url: ROOM, namespace: "mirror:team1:libA", lib: "libA" });
    factory({ url: ROOM, namespace: "mirror:team1:libB", lib: "libB" });
    expect(rawsFor(ROOM)).toHaveLength(1);

    factory({ url: "http://api/parties/sync-room/mirror:team2", namespace: "n", lib: "libA" });
    expect(rawsFor("http://api/parties/sync-room/mirror:team2")).toHaveLength(1);
    expect(rawsFor(ROOM)).toHaveLength(1);
  });

  it("a layer WITHOUT a lib gets its own dedicated channel", () => {
    const { factory, rawsFor } = harness();
    factory({ url: ROOM, namespace: "org:lib1" });
    factory({ url: ROOM, namespace: "org:lib1-again" });
    expect(rawsFor(ROOM)).toHaveLength(2);
  });

  it("outbound frames are stamped with the facade's lib", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    const b = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    a.send({ t: "hello", sinceVersion: 3 });
    b.send({ t: "hello" });
    expect(rawsFor(ROOM)[0]!.sent).toEqual([
      { t: "hello", sinceVersion: 3, lib: "libA" },
      { t: "hello", lib: "libB" },
    ]);
  });

  it("inbound frames route to the matching lib only; untagged frames go nowhere", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    const b = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    const got: Record<string, ServerMsg[]> = { a: [], b: [] };
    a.onMessage((m) => got.a!.push(m));
    b.onMessage((m) => got.b!.push(m));

    const raw = rawsFor(ROOM)[0]!;
    raw.deliver({ t: "change", op: "put", path: "symbol/R", version: 1, lib: "libA" });
    raw.deliver({ t: "synced", version: 2, lib: "libB" });
    raw.deliver({ t: "synced", version: 9 }); // untagged — no facade matches

    expect(got.a).toEqual([
      { t: "change", op: "put", path: "symbol/R", version: 1, lib: "libA" },
    ]);
    expect(got.b).toEqual([{ t: "synced", version: 2, lib: "libB" }]);
  });

  it("a room-level registry frame fans out to every facade it mentions", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    const b = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    const c = factory({ url: ROOM, namespace: "nsC", lib: "libC" });
    const got: Record<string, ServerMsg[]> = { a: [], b: [], c: [] };
    a.onMessage((m) => got.a!.push(m));
    b.onMessage((m) => got.b!.push(m));
    c.onMessage((m) => got.c!.push(m));

    const frame: ServerMsg = {
      t: "registry",
      libs: { libA: { v: 3, digest: "dA" }, libB: { v: 5, digest: "dB" } },
    };
    rawsFor(ROOM)[0]!.deliver(frame);

    // Untagged, yet routed: each mentioned facade gets the ONE shared frame
    // (layers pick their own entry by namespace); an unmentioned facade
    // (dirty/unknown sub-namespace) hears nothing.
    expect(got.a).toEqual([frame]);
    expect(got.b).toEqual([frame]);
    expect(got.c).toEqual([]);
  });

  it("replays the registry snapshot to a facade created after the frame", async () => {
    const { factory, rawsFor } = harness();
    factory({ url: ROOM, namespace: "nsA", lib: "libA" }); // opens the raw socket
    const frame: ServerMsg = {
      t: "registry",
      libs: { libA: { v: 1, digest: "dA" }, libB: { v: 2, digest: "dB" } },
    };
    rawsFor(ROOM)[0]!.deliver(frame);

    // A boot's presync creates facades over time — a late layer must still
    // receive the connect-time snapshot (state, not event), delivered on the
    // next task so its onMessage handler is wired first.
    const late = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    const got: ServerMsg[] = [];
    late.onMessage((m) => got.push(m));
    expect(got).toEqual([]); // not synchronously
    await new Promise((r) => setTimeout(r, 0));
    expect(got).toEqual([frame]);

    // A facade whose lib the snapshot does not mention gets no replay.
    const unmentioned = factory({ url: ROOM, namespace: "nsC", lib: "libC" });
    const gotC: ServerMsg[] = [];
    unmentioned.onMessage((m) => gotC.push(m));
    await new Promise((r) => setTimeout(r, 0));
    expect(gotC).toEqual([]);

    // A reconnect invalidates the snapshot — no stale replay afterwards.
    rawsFor(ROOM)[0]!.fireOpen();
    const postReconnect = factory({ url: ROOM, namespace: "nsB2", lib: "libB" });
    const gotB2: ServerMsg[] = [];
    postReconnect.onMessage((m) => gotB2.push(m));
    await new Promise((r) => setTimeout(r, 0));
    expect(gotB2).toEqual([]);
  });

  it("onOpen fans out to every facade (each layer re-hellos on reconnect)", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    const b = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    let opens = 0;
    a.onOpen(() => opens++);
    b.onOpen(() => opens++);
    rawsFor(ROOM)[0]!.fireOpen();
    expect(opens).toBe(2);
  });

  it("refcounted close: raw closes with the LAST facade; reopening dials fresh", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    const b = factory({ url: ROOM, namespace: "nsB", lib: "libB" });
    const raw = rawsFor(ROOM)[0]!;

    a.close();
    a.close(); // double-close must not double-decrement
    expect(raw.closed).toBe(false);
    b.close();
    expect(raw.closed).toBe(true);

    factory({ url: ROOM, namespace: "nsC", lib: "libC" });
    expect(rawsFor(ROOM)).toHaveLength(2); // a NEW raw, not the closed one
  });

  it("a closed facade no longer receives inbound frames", () => {
    const { factory, rawsFor } = harness();
    const a = factory({ url: ROOM, namespace: "nsA", lib: "libA" });
    factory({ url: ROOM, namespace: "nsB", lib: "libB" }); // keeps the raw alive
    const got: ServerMsg[] = [];
    a.onMessage((m) => got.push(m));
    a.close();
    rawsFor(ROOM)[0]!.deliver({ t: "synced", version: 1, lib: "libA" });
    expect(got).toEqual([]);
  });

  it("supports sibling facades for the same lib without close disrupting routing", () => {
    const { factory, rawsFor } = harness();
    const first = factory({ url: ROOM, namespace: "nsA-1", lib: "libA" });
    const sibling = factory({ url: ROOM, namespace: "nsA-2", lib: "libA" });
    const firstMessages: ServerMsg[] = [];
    const siblingMessages: ServerMsg[] = [];
    first.onMessage((message) => firstMessages.push(message));
    sibling.onMessage((message) => siblingMessages.push(message));
    const raw = rawsFor(ROOM)[0]!;

    const beforeClose: ServerMsg = {
      t: "synced",
      version: 1,
      lib: "libA",
    };
    raw.deliver(beforeClose);
    expect(firstMessages).toEqual([beforeClose]);
    expect(siblingMessages).toEqual([beforeClose]);

    first.close();
    expect(raw.closed).toBe(false);
    const afterClose: ServerMsg = {
      t: "synced",
      version: 2,
      lib: "libA",
    };
    raw.deliver(afterClose);

    expect(firstMessages).toEqual([beforeClose]);
    expect(siblingMessages).toEqual([beforeClose, afterClose]);
    sibling.send({ t: "hello", sinceVersion: 2 });
    expect(raw.sent.at(-1)).toEqual({
      t: "hello",
      sinceVersion: 2,
      lib: "libA",
    });
    sibling.close();
    expect(raw.closed).toBe(true);
  });
});
