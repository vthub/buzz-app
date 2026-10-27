// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { recordReaction } from "../messages/quick-reactions";
import { readView, writeView } from "../../shared/view-state";
import { purgeCommunityDeviceState } from "./device-state";
import { localCommunityNameKey } from "./names";
import { repositoriesKey } from "./repositories";

// The relay's stores record what they are asked to forget, in order.
const relay = vi.hoisted(() => ({
  calls: [] as unknown[][],
  fail: new Map<string, Error>(),
}));
const record = (...call: unknown[]) => {
  relay.calls.push(call);
  const error = relay.fail.get(String(call[0]));
  return error ? Promise.reject(error) : Promise.resolve();
};
vi.mock("../relay/persistence", () => ({
  createHeadPersistence: (viewer: string, origin: string) => {
    relay.calls.push(["heads", viewer, origin]);
    return {
      clear: () => record("heads.clear"),
      close: () => relay.calls.push(["heads.close"]),
    };
  },
}));
vi.mock("../relay/read-state-storage", () => ({
  purgeReadStateStorage: (scope: string) => record("read state", scope),
}));
vi.mock("../relay/outbox-storage", () => ({
  purgeOutboxStorage: (scope: string) => record("outbox", scope),
}));
vi.mock("../relay/thread-participation", () => ({
  purgeThreadParticipation: (scope: string) =>
    record("thread participation", scope),
}));

const viewer = "a".repeat(64);
const other = "b".repeat(64);
const origin = "https://left.example";
const kept = "https://kept.example";
const receipt = (scope: string) => `buzz-channel-setup.v2:${scope}:general`;
const reactions = (scope: string) => `buzz.quick-reactions.v1:${scope}`;
const follows = (scope: string) => `buzz.thread-follows.v1:${scope}`;

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  relay.calls.splice(0);
  relay.fail.clear();
});

it("forgets every store partitioned to the left community and viewer, and nothing else", async () => {
  const scope = `${origin}:${viewer}`;
  localStorage.setItem(repositoriesKey(origin, viewer), "/code");
  localStorage.setItem(repositoriesKey(origin, other), "/other-account");
  localStorage.setItem(localCommunityNameKey(origin, viewer), "Local nickname");
  localStorage.setItem(localCommunityNameKey(origin, other), "Other account");
  writeView(scope, "draft:general", "unsent");
  writeView(scope, "channel", "general");
  writeView(`${kept}:${viewer}`, "draft:general", "another community");
  writeView(`${origin}:${other}`, "draft:general", "another viewer");
  // A scope that merely extends the left one is a different partition.
  writeView(`${scope}0`, "draft:general", "longer viewer");
  recordReaction(scope, "🎉");
  recordReaction(`${kept}:${viewer}`, "🎉");
  localStorage.setItem(receipt(scope), "1");
  localStorage.setItem(receipt(`${kept}:${viewer}`), "1");
  localStorage.setItem(follows(scope), "[]");
  localStorage.setItem(follows(`${kept}:${viewer}`), "[]");
  expect(await purgeCommunityDeviceState(origin, viewer)).toEqual([]);
  expect(
    localStorage.getItem(localCommunityNameKey(origin, viewer)),
  ).toBeNull();
  expect(localStorage.getItem(localCommunityNameKey(origin, other))).toBe(
    "Other account",
  );
  expect(localStorage.getItem(repositoriesKey(origin, viewer))).toBeNull();
  expect(localStorage.getItem(repositoriesKey(origin, other))).toBe(
    "/other-account",
  );
  expect(localStorage.getItem(follows(scope))).toBeNull();
  expect(localStorage.getItem(follows(`${kept}:${viewer}`))).toBe("[]");
  expect(readView(scope, "draft:general", "")).toBe("");
  expect(readView(scope, "channel", "")).toBe("");
  expect(readView(`${kept}:${viewer}`, "draft:general", "")).toBe(
    "another community",
  );
  expect(readView(`${origin}:${other}`, "draft:general", "")).toBe(
    "another viewer",
  );
  expect(readView(`${scope}0`, "draft:general", "")).toBe("longer viewer");
  expect(localStorage.getItem(reactions(scope))).toBeNull();
  expect(localStorage.getItem(reactions(`${kept}:${viewer}`))).not.toBeNull();
  expect(localStorage.getItem(receipt(scope))).toBeNull();
  expect(localStorage.getItem(receipt(`${kept}:${viewer}`))).toBe("1");
});

it("clears the remaining stores when one is unavailable and reports each failure by store", async () => {
  const scope = `${origin}:${viewer}`;
  writeView(scope, "draft:general", "unsent");
  recordReaction(scope, "🎉");
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  // Key enumeration fails, which the view and channel-setup sweeps rely on.
  const denied = new Error("denied");
  vi.spyOn(Storage.prototype, "key").mockImplementation(() => {
    throw denied;
  });
  const failures = await purgeCommunityDeviceState(origin, viewer);
  expect(failures).toEqual([
    { store: "view state", error: denied },
    { store: "channel setups", error: denied },
  ]);
  expect(localStorage.getItem(reactions(scope))).toBeNull();
  // Nothing retries a failed purge later, so each one is at least on record,
  // naming the store and the community it belongs to.
  expect(warn.mock.calls).toEqual([
    [`Couldn't clear view state for ${origin} on this device`, denied],
    [`Couldn't clear channel setups for ${origin} on this device`, denied],
  ]);
});

it("purges the relay's heads, read state, thread participation and outbox for the exact partition, in order", async () => {
  vi.stubGlobal("indexedDB", {});
  expect(await purgeCommunityDeviceState(origin, viewer)).toEqual([]);
  // Heads keep their reversed `viewer:origin` encoding inside persistence.
  expect(relay.calls).toEqual([
    ["heads", viewer, origin],
    ["heads.clear"],
    ["heads.close"],
    ["read state", `${origin}:${viewer}`],
    ["thread participation", `${origin}:${viewer}`],
    ["outbox", `${origin}:${viewer}`],
  ]);
});

it("skips the head cache without IndexedDB and still purges the other relay stores", async () => {
  expect(await purgeCommunityDeviceState(origin, viewer)).toEqual([]);
  expect(relay.calls).toEqual([
    ["read state", `${origin}:${viewer}`],
    ["thread participation", `${origin}:${viewer}`],
    ["outbox", `${origin}:${viewer}`],
  ]);
});

it("reports each failed relay store by name, closes heads and still clears the outbox", async () => {
  vi.stubGlobal("indexedDB", {});
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const heads = new Error("heads blocked");
  const reads = new Error("read state blocked");
  relay.fail.set("heads.clear", heads).set("read state", reads);
  expect(await purgeCommunityDeviceState(origin, viewer)).toEqual([
    { store: "channel heads", error: heads },
    { store: "read state", error: reads },
  ]);
  expect(relay.calls.map(([name]) => name)).toEqual([
    "heads",
    "heads.clear",
    "heads.close",
    "read state",
    "thread participation",
    "outbox",
  ]);
  expect(warn.mock.calls).toEqual([
    [`Couldn't clear channel heads for ${origin} on this device`, heads],
    [`Couldn't clear read state for ${origin} on this device`, reads],
  ]);
});
