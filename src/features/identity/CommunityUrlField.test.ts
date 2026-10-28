import { expect, it } from "vitest";
import { enteredCommunity } from "./CommunityUrlField";

it.each([
  ["relay.example.com", "https://relay.example.com", ""],
  [" Relay.Example.com:8443 ", "https://relay.example.com:8443", ""],
  ["wss://relay.example.com/", "https://relay.example.com", ""],
  ["https://relay.example.com", "https://relay.example.com", ""],
  [
    "https://Relay.Example.com:8443/invite/v2.Invite-code_1",
    "https://relay.example.com:8443",
    "v2.Invite-code_1",
  ],
  [
    "https://relay.example.com/invite/v2.code/",
    "https://relay.example.com",
    "v2.code",
  ],
  [
    "buzz://join?relay=wss%3A%2F%2Frelay.example.com%3A8443&code=v2.code",
    "https://relay.example.com:8443",
    "v2.code",
  ],
  // Windows hands the app link over with a root path.
  [
    "buzz://join/?relay=wss%3A%2F%2Frelay.example.com&code=v2.code&policy_receipt=r",
    "https://relay.example.com",
    "v2.code",
  ],
])("reads %j as %s with code %j", (input, origin, code) => {
  expect(enteredCommunity(input)).toEqual({ origin, code });
});

it.each([
  "",
  "not a url",
  "ws://relay.example.com",
  "https://relay.example.com/other",
  "relay.example.com/invite/v2.code",
  "http://relay.example.com/invite/v2.code",
  "https://user@relay.example.com/invite/v2.code",
  "https://relay.example.com/invite/v2.code?next=evil",
  "buzz://join?relay=wss%3A%2F%2Frelay.example.com",
  "buzz://join?relay=ws%3A%2F%2Frelay.example.com&code=v2.code",
])("refuses %j", (input) => {
  expect(enteredCommunity(input)).toBeUndefined();
});
