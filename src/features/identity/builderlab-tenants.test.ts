import { expect, it } from "vitest";
import type { FoundCommunity } from "../communities/find-community";
import { relayOrigin } from "../communities/destination";
import {
  discoverAuthentication,
  parseBuilderlabTenants,
} from "./builderlab-tenants";

const BLOCK_SELF =
  "76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01";
const TENANTS = JSON.stringify([
  {
    relayHost: "communities.buzz.xyz",
    self: "12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3",
    loginOrigin: "https://app.builderlab.xyz",
  },
  {
    relayHost: "block.builderlab.xyz",
    self: BLOCK_SELF,
    loginOrigin: "https://block.builderlab.xyz",
  },
  {
    relayHost: "test.blockstaging.build",
    self: "f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1",
    loginOrigin: "https://test.blockstaging.build",
  },
]);
const tenants = parseBuilderlabTenants(TENANTS);
/** As `findCommunity` reports it: the canonical origin, plus `self` when given. */
const found = (input: string, self?: string): FoundCommunity => ({
  url: relayOrigin(input),
  host: new URL(relayOrigin(input)).host,
  self,
  policy: null,
});
const discover = (input: string, self?: string) =>
  discoverAuthentication(found(input, self), tenants);

it.each([
  ["wss://communities.buzz.xyz", "https://app.builderlab.xyz"],
  ["https://design.communities.buzz.xyz", "https://app.builderlab.xyz"],
  ["wss://buzz.block.builderlab.xyz", "https://block.builderlab.xyz"],
  [
    "wss://acme.communities.block.builderlab.xyz",
    "https://block.builderlab.xyz",
  ],
  ["wss://buzz.test.blockstaging.build", "https://test.blockstaging.build"],
  ["WSS://Design.Communities.BUZZ.xyz.", "https://app.builderlab.xyz"],
])("%s is a Builderlab tenant signing in at %s", (input, origin) => {
  expect(discover(input)).toEqual({ kind: "builderlab", origin });
});

it.each([
  "wss://communities.buzz.xyz.evil.com",
  "wss://notcommunities.buzz.xyz",
  "wss://xcommunities.buzz.xyz",
  "wss://buzz.xyz",
  "wss://buzz.acme.builderlab.xyz",
  "wss://relay.example.com",
])("%s is not a known tenant, so no portal is chosen", (input) => {
  expect(discover(input)).toEqual({ kind: "none" });
});

it("matches only the default port: Block's deployments serve on 443", () => {
  expect(discover("https://communities.buzz.xyz:8443")).toEqual({
    kind: "none",
  });
  expect(discover("https://communities.buzz.xyz:443")).toEqual({
    kind: "builderlab",
    origin: "https://app.builderlab.xyz",
  });
});

it("falls back to the relay key when the hostname is unknown, never to a new origin", () => {
  // A deployment moved to a new domain keeps its relay key.
  expect(discover("wss://buzz.block.example", BLOCK_SELF)).toEqual({
    kind: "builderlab",
    origin: "https://block.builderlab.xyz",
  });
  // The hostname decides first: a listed host's key is not consulted.
  expect(discover("wss://buzz.test.blockstaging.build", BLOCK_SELF)).toEqual({
    kind: "builderlab",
    origin: "https://test.blockstaging.build",
  });
  expect(discover("https://buzz.block.example:8443", BLOCK_SELF)).toEqual({
    kind: "none",
  });
  expect(discover("wss://buzz.block.example", "ab".repeat(32))).toEqual({
    kind: "none",
  });
  expect(discover("wss://buzz.block.example")).toEqual({ kind: "none" });
});

it("a tenant announced later is one more row, and a nested row wins by suffix length", () => {
  const acme = parseBuilderlabTenants(
    JSON.stringify([
      {
        relayHost: "builderlab.xyz",
        loginOrigin: "https://app.builderlab.xyz",
      },
      {
        relayHost: "buzz.acme.builderlab.xyz",
        loginOrigin: "https://acme.builderlab.xyz",
      },
    ]),
  );
  expect(
    discoverAuthentication(found("wss://buzz.acme.builderlab.xyz"), acme),
  ).toEqual({ kind: "builderlab", origin: "https://acme.builderlab.xyz" });
  expect(
    discoverAuthentication(found("wss://buzz.other.builderlab.xyz"), acme),
  ).toEqual({ kind: "builderlab", origin: "https://app.builderlab.xyz" });
  expect(
    discoverAuthentication(found("wss://buzz.acme.builderlab.xyz"), []),
  ).toEqual({ kind: "none" });
});

it("normalises rows and leaves an unset table empty", () => {
  expect(parseBuilderlabTenants()).toEqual([]);
  expect(parseBuilderlabTenants(" \n")).toEqual([]);
  expect(
    parseBuilderlabTenants(
      '[{"relayHost":" Relay.Example. ","loginOrigin":"https://login.example"}]',
    ),
  ).toEqual([
    {
      relayHost: "relay.example",
      self: undefined,
      loginOrigin: "https://login.example",
    },
  ]);
  expect(tenants.map((tenant) => tenant.relayHost)).toEqual([
    "test.blockstaging.build",
    "communities.buzz.xyz",
    "block.builderlab.xyz",
  ]);
  expect(Object.isFrozen(tenants)).toBe(true);
});

it.each([
  ["not JSON", "{"],
  ["an object", '{"relayHost":"a.example","loginOrigin":"https://a.example"}'],
  ["a non-object row", '["a.example"]'],
  ["http", '[{"relayHost":"a.example","loginOrigin":"http://secret.example"}]'],
  [
    "credentials",
    '[{"relayHost":"a.example","loginOrigin":"https://user:secret@a.example"}]',
  ],
  [
    "a path",
    '[{"relayHost":"a.example","loginOrigin":"https://a.example/path"}]',
  ],
  [
    "a non-canonical origin",
    '[{"relayHost":"a.example","loginOrigin":"https://a.example:443"}]',
  ],
  [
    "a query",
    '[{"relayHost":"a.example","loginOrigin":"https://a.example?x"}]',
  ],
  [
    "a scheme in the host",
    '[{"relayHost":"https://a.example","loginOrigin":"https://a.example"}]',
  ],
  [
    "a wildcard host",
    '[{"relayHost":"*.a.example","loginOrigin":"https://a.example"}]',
  ],
  [
    "a port in the host",
    '[{"relayHost":"a.example:8443","loginOrigin":"https://a.example"}]',
  ],
  [
    // Four 63-byte labels: every label is legal, the 255-byte whole is not.
    "an over-long host",
    `[{"relayHost":"${["a", "b", "c", "d"].map((l) => l.repeat(63)).join(".")}","loginOrigin":"https://a.example"}]`,
  ],
  [
    // U+212A KELVIN SIGN: toLowerCase() would fold it to ASCII "k"; build.rs does not.
    "a Kelvin sign in the host",
    '[{"relayHost":"\u212Aelvin.example","loginOrigin":"https://a.example"}]',
  ],
  ["a missing host", '[{"loginOrigin":"https://a.example"}]'],
  [
    "an unknown field",
    '[{"relayHost":"a.example","loginOrigin":"https://a.example","extra":1}]',
  ],
  [
    "a short key",
    '[{"relayHost":"a.example","self":"abcd","loginOrigin":"https://a.example"}]',
  ],
  [
    "an uppercase key",
    `[{"relayHost":"a.example","self":"${"AB".repeat(32)}","loginOrigin":"https://a.example"}]`,
  ],
  [
    "a duplicate host",
    '[{"relayHost":"a.example","loginOrigin":"https://a.example"},{"relayHost":"A.example.","loginOrigin":"https://b.example"}]',
  ],
  [
    "a duplicate key",
    `[{"relayHost":"a.example","self":"${"ab".repeat(32)}","loginOrigin":"https://a.example"},{"relayHost":"b.example","self":"${"ab".repeat(32)}","loginOrigin":"https://b.example"}]`,
  ],
])("rejects a table with %s without echoing it", (_label, raw) => {
  let error: unknown;
  try {
    parseBuilderlabTenants(raw);
  } catch (thrown) {
    error = thrown;
  }
  expect(error).toBeInstanceOf(Error);
  expect(String(error)).toMatch(/^Error: BUZZ_BUILDERLAB_TENANTS must be/);
  expect(String(error)).not.toContain("secret");
  expect(String(error)).not.toContain("a.example");
});
