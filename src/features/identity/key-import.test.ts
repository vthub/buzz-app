import { npubEncode, nsecEncode } from "nostr-tools/nip19";
import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { expect, it, vi } from "vitest";
import {
  KEY_FILE_MAX_BYTES,
  classifyKeyImport,
  readKeyFile,
} from "./key-import";

const secret = generateSecretKey();
const nsec = nsecEncode(secret);
const npub = npubEncode(getPublicKey(secret));

it("accepts an nsec as typed, trimmed of surrounding whitespace, and previews its npub", () => {
  expect(classifyKeyImport(nsec)).toEqual({ kind: "nsec", nsec, npub });
  expect(classifyKeyImport(`\n  ${nsec} \r\n`)).toEqual({
    kind: "nsec",
    nsec,
    npub,
  });
  // Bech32 allows an all-uppercase string, and so does native import.
  expect(classifyKeyImport(nsec.toUpperCase())).toEqual({
    kind: "nsec",
    nsec: nsec.toUpperCase(),
    npub,
  });
});

it("tells a password-protected backup apart from an invalid key", () => {
  expect(
    classifyKeyImport(
      "ncryptsec1qgg9947rlpvqu76pj5ecreduf9jxhselq2nae2kghhvd5g7dgjtcxfqtd67p9m0w57lspw8gsq6yphnm8623nsl8xn9j4jdzz84zm3frztj3z7s35vpzmqf6ksu8r89qk5z2zxfmu5gv8th8wclt0h4p",
    ),
  ).toEqual({ kind: "encrypted" });
  expect(classifyKeyImport("  NcryptSec1abc  ")).toEqual({ kind: "encrypted" });
  for (const text of [
    "hello",
    "nsec1",
    `${nsec.slice(0, -1)}${nsec.endsWith("q") ? "p" : "q"}`,
    npub,
    "ab".repeat(32),
  ])
    expect(classifyKeyImport(text)).toEqual({ kind: "invalid" });
  expect(classifyKeyImport("")).toEqual({ kind: "empty" });
  expect(classifyKeyImport(" \n\t")).toEqual({ kind: "empty" });
});

it("reads the first non-blank line of a small key file and refuses a larger one unread", async () => {
  const text = vi.fn(async () => `\r\n   ${nsec}  \r\nsecond line\n`);
  await expect(readKeyFile({ size: KEY_FILE_MAX_BYTES, text })).resolves.toBe(
    nsec,
  );
  await expect(
    readKeyFile({ size: 3, text: async () => "\n\n" }),
  ).resolves.toBe("");
  const big = vi.fn(async () => nsec);
  await expect(
    readKeyFile({ size: KEY_FILE_MAX_BYTES + 1, text: big }),
  ).rejects.toThrow(/too large to be a private key/);
  expect(big).not.toHaveBeenCalled();
});
