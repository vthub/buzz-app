import { expect, it } from "vitest";
import {
  communityDestination,
  enteredRelayOrigin,
  relayAddress,
  relayOrigin,
  parseCommunityAliases,
} from "./destination";

it.each([
  ["primary", "wss://primary.example"],
  [" WSS://PRIMARY.EXAMPLE:443/ ", "wss://primary.example"],
  ["https://example.com:8443", "wss://example.com:8443"],
  ["https://[2001:db8::1]:8443/", "wss://[2001:db8::1]:8443"],
  ["WSS://bücher.example/", "wss://xn--bcher-kva.example"],
])(
  "addresses %s for the account service as its canonical wss origin",
  (input, expected) => {
    expect(relayAddress(input)).toBe(expected);
    expect(communityDestination(expected).url).toBe(
      communityDestination(input).url,
    );
  },
);

it("does not address what is not a destination", () => {
  expect(() => relayAddress("unconfigured-old")).toThrow(/relay URL/);
  expect(() => relayAddress("https://relay.example/path")).toThrow(/relay URL/);
});

it.each([
  [" wss://EXAMPLE.com:443/ ", "https://example.com"],
  ["https://example.com.", "https://example.com"],
  ["wss://example.com:8443", "https://example.com:8443"],
  ["https://[2001:db8::1]:8443/", "https://[2001:db8::1]:8443"],
  ["WSS://bücher.example/", "https://xn--bcher-kva.example"],
])("canonicalizes %s", (input, expected) => {
  expect(relayOrigin(input)).toBe(expected);
  expect(relayOrigin(expected)).toBe(expected);
});

it.each([
  "",
  "relay.example",
  "primary",
  "ws://relay.example",
  "http://relay.example",
  "javascript:alert(1)",
  "file:///tmp/relay",
  "https://user:password@relay.example",
  "https://@relay.example",
  "https://relay.example/path",
  "https://relay.example/?",
  "https://relay.example/#",
  "https://relay.example?x=1",
  "https://relay.example/#x",
  "https://relay.example/../",
  "https://relay.example/%2e/",
  "https://relay.example//",
  "https://relay.example\\@evil.example",
  "https://relay.example\n.evil.example",
  "https:///relay.example",
  "https://relay.example:99999",
  "https://",
  `https://${"a".repeat(2048)}`,
])("rejects unsupported or ambiguous input (%#)", (input) => {
  expect(() => relayOrigin(input)).toThrow(/relay URL/);
});

// Typed-address cases from old Buzz's relayProbe.test.mjs, under this app's
// secure-origin rule: ws/http, paths and doubled slashes stay rejected.
it.each([
  ["relay.example.com", "https://relay.example.com"],
  ["  relay.example.com  ", "https://relay.example.com"],
  ["relay.example.com:8443", "https://relay.example.com:8443"],
  ["localhost:3000", "https://localhost:3000"],
  ["wss://relay.example.com", "https://relay.example.com"],
  ["WSS://Relay.Example.com/", "https://relay.example.com"],
  ["HTTPS://relay.example.com:8443", "https://relay.example.com:8443"],
])("normalizes the typed address %s", (input, expected) => {
  expect(enteredRelayOrigin(input)).toBe(expected);
});

it.each([
  "",
  "   ",
  "not a url at all",
  "ftp://relay.example.com",
  "ws://localhost:3000",
  "http://relay.example.com",
  "javascript:alert(1)",
  "user:password@relay.example.com",
  "relay.example.com/custom",
  "relay.example.com?x=1",
  "relay.example.com#x",
  "wss://relay.example.com///",
  "//relay.example.com",
])("rejects the typed address %j", (input) => {
  expect(() => enteredRelayOrigin(input)).toThrow(/relay URL/);
});

it("preserves old IDs and deduplicates their typed secure URLs", () => {
  expect(communityDestination("primary")).toEqual(
    communityDestination(" WSS://PRIMARY.EXAMPLE:443/ "),
  );
  expect(communityDestination("secondary")).toEqual(
    communityDestination("https://secondary.example"),
  );
  expect(communityDestination("wss://third.example").id).toBe(
    "https://third.example",
  );
  expect(() => communityDestination("__proto__")).toThrow();
  expect(() => communityDestination("constructor")).toThrow();
});

it("has no implicit aliases and keeps explicitly configured aliases stable", () => {
  const empty = parseCommunityAliases();
  expect(empty).toEqual({});
  expect(communityDestination("wss://new.example", empty).id).toBe(
    "https://new.example",
  );
  expect(() => communityDestination("primary", empty)).toThrow();
  const aliases = parseCommunityAliases(
    '{"old-name":" WSS://RELAY.example:443/ "}',
  );
  expect(aliases).toEqual({ "old-name": "https://relay.example" });
  expect(communityDestination("old-name", aliases)).toEqual(
    communityDestination("https://relay.example", aliases),
  );
});

it.each([
  "not-json",
  "null",
  "[]",
  '{"primary":42}',
  '{"__proto__":"https://relay.example"}',
  '{"constructor":"https://relay.example"}',
  '{"bad/id":"https://relay.example"}',
  '{"primary":"https://user:password@relay.example"}',
  '{"primary":"https://relay.example/path"}',
  '{"one":"https://relay.example","two":"wss://RELAY.example:443/"}',
])(
  "rejects invalid deployment aliases without echoing their values (%#)",
  (raw) => {
    expect(() => parseCommunityAliases(raw)).toThrow(
      "BUZZ_COMMUNITY_ALIASES must be a JSON object of unique alias-to-secure-relay-origin mappings.",
    );
  },
);
