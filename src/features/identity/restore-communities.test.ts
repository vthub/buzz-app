import { afterEach, expect, it, vi } from "vitest";
import { inspectProfile } from "../communities/api";
import type { ClientSnapshot } from "../communities/service";
import { ReadError } from "../relay/errors";
import { restoreKnown } from "./restore-communities";
import { restoreCommunities } from "./setup";

vi.mock("../communities/api", () => ({ inspectProfile: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
});

type Read = Awaited<ReturnType<typeof inspectProfile>>;
const empty = { name: "", picture: "", about: "" };
const found = (name: string): Read => ({
  existing: { name },
  profile: { name, picture: "", about: "" },
  exists: true,
});
const none: Read = { existing: {}, profile: empty, exists: false };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function service(status: ClientSnapshot["status"] = "ready") {
  return {
    snapshot: () => ({ status, profile: empty }) as ClientSnapshot,
    joined: vi.fn(),
  };
}
const options = { concurrency: 3, startBy: 45_000 };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

it("reads at most three destinations at once and reports outcomes in list order", async () => {
  const reads = new Map<string, ReturnType<typeof deferred<Read>>>();
  vi.mocked(inspectProfile).mockImplementation((id) => {
    const read = deferred<Read>();
    reads.set(id, read);
    return read.promise;
  });
  const communities = service();
  const known = ["a", "b", "c", "d", "e"].map(
    (host) => `wss://${host}.example`,
  );
  const restoring = restoreKnown(known, communities, options);
  await flush();
  expect([...reads.keys()]).toEqual([
    "https://a.example",
    "https://b.example",
    "https://c.example",
  ]);
  // The second finishing first frees its slot for the fourth.
  reads.get("https://b.example")?.resolve(none);
  await flush();
  expect([...reads.keys()]).toHaveLength(4);
  for (const read of reads.values()) read.resolve(none);
  await flush();
  reads.get("https://e.example")?.resolve(none);
  const outcomes = await restoring;
  expect(outcomes.map((outcome) => outcome.host)).toEqual([
    "a.example",
    "b.example",
    "c.example",
    "d.example",
    "e.example",
  ]);
  expect(communities.joined).toHaveBeenCalledTimes(5);
});

it("joins only the destinations that admit the key, and records refusals and failures as outcomes", async () => {
  const ada = found("Ada");
  vi.mocked(inspectProfile).mockImplementation(async (id) => {
    if (id === "https://denied.example")
      throw new ReadError("denied", "Relay read failed (403)", 403);
    if (id === "https://down.example") throw "Community discovery failed";
    return id === "https://ada.example" ? ada : none;
  });
  const communities = service();
  const outcomes = await restoreKnown(
    [
      "wss://denied.example",
      "wss://ada.example",
      "wss://down.example",
      "wss://new.example:8443",
    ],
    communities,
    options,
  );
  expect(outcomes).toEqual([
    {
      url: "https://denied.example",
      id: "https://denied.example",
      host: "denied.example",
      kind: "denied",
    },
    {
      url: "https://ada.example",
      id: "https://ada.example",
      host: "ada.example",
      kind: "admitted",
      read: ada,
    },
    {
      url: "https://down.example",
      id: "https://down.example",
      host: "down.example",
      kind: "unavailable",
    },
    {
      url: "https://new.example:8443",
      id: "https://new.example:8443",
      host: "new.example:8443",
      kind: "admitted",
      read: none,
    },
  ]);
  // A relay profile is offered to the empty local default; otherwise the
  // local default is.
  expect(communities.joined.mock.calls).toEqual([
    [{ id: "https://ada.example", name: "ada.example" }, ada.profile],
    [{ id: "https://new.example:8443", name: "new.example:8443" }, empty],
  ]);
});

it("reads a destination listed twice once and skips one this build cannot open", async () => {
  vi.mocked(inspectProfile).mockResolvedValue(none);
  const outcomes = await restoreKnown(
    ["wss://a.example", "https://A.example/", "ws://insecure.example"],
    service(),
    options,
  );
  expect(vi.mocked(inspectProfile).mock.calls).toEqual([["https://a.example"]]);
  expect(outcomes.map((outcome) => outcome.kind)).toEqual(["admitted"]);
});

it("an admitted destination whose membership cannot be saved, or arrives before the device record is ready, is unavailable", async () => {
  vi.mocked(inspectProfile).mockResolvedValue(none);
  const failing = service();
  failing.joined.mockImplementation(() => {
    throw new Error("Your saved communities could not be stored.");
  });
  expect(
    await restoreKnown(["wss://a.example"], failing, options),
  ).toMatchObject([{ kind: "unavailable" }]);
  const loading = service("loading");
  expect(
    await restoreKnown(["wss://a.example"], loading, options),
  ).toMatchObject([{ kind: "unavailable" }]);
  expect(loading.joined).not.toHaveBeenCalled();
});

it("starts no read 45 s after the restore began, leaving the rest unavailable", async () => {
  vi.useFakeTimers();
  const first = deferred<Read>();
  vi.mocked(inspectProfile).mockReturnValueOnce(first.promise);
  const restoring = restoreKnown(
    ["wss://a.example", "wss://b.example"],
    service(),
    { concurrency: 1, startBy: 45_000 },
  );
  await vi.advanceTimersByTimeAsync(45_000);
  first.resolve(none);
  expect((await restoring).map((outcome) => outcome.kind)).toEqual([
    "admitted",
    "unavailable",
  ]);
  expect(inspectProfile).toHaveBeenCalledTimes(1);
});

it("the restore step hands the outcomes to `decide` and rests where it says", async () => {
  vi.mocked(inspectProfile).mockResolvedValue(none);
  const decide = vi.fn(() => ({ status: "idle" }) as const);
  const step = restoreCommunities(["wss://a.example"], service(), decide);
  expect(step.label).toBe("Restoring your communities…");
  expect(await step.run()).toEqual({ status: "idle" });
  expect(decide).toHaveBeenCalledWith([
    expect.objectContaining({ id: "https://a.example", kind: "admitted" }),
  ]);
});
