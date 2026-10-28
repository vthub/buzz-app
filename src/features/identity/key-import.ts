import { decode, npubEncode } from "nostr-tools/nip19";
import { getPublicKey } from "nostr-tools/pure";

/** What pasted, typed or file-sourced private-key text turned out to be. */
export type KeyImportInput =
  | { kind: "empty" }
  /** `nsec` is the trimmed text native import takes as is; `npub` its public identity. */
  | { kind: "nsec"; nsec: string; npub: string }
  /** A NIP-49 password-protected backup: nothing here can decrypt it. */
  | { kind: "encrypted" }
  | { kind: "invalid" };

export function classifyKeyImport(text: string): KeyImportInput {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed.slice(0, 10).toLowerCase() === "ncryptsec1")
    return { kind: "encrypted" };
  try {
    const decoded = decode(trimmed);
    if (decoded.type !== "nsec") return { kind: "invalid" };
    // Derivation also rejects a secret outside the curve order, as native import does.
    return {
      kind: "nsec",
      nsec: trimmed,
      npub: npubEncode(getPublicKey(decoded.data)),
    };
  } catch {
    return { kind: "invalid" };
  }
}

/** Anything larger is not a key file; it is refused before being read. */
export const KEY_FILE_MAX_BYTES = 1024;

/** The first non-blank line of a small text file, trimmed. */
export async function readKeyFile(
  file: Pick<File, "size" | "text">,
): Promise<string> {
  if (file.size > KEY_FILE_MAX_BYTES)
    throw new Error(
      "That file is too large to be a private key. Choose a small text file whose first line is an nsec1 key.",
    );
  const text = await file.text();
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() ?? ""
  );
}
