import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { createIdentity } from "./service";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
afterEach(() => vi.resetAllMocks());

it("exposes explicit backup choices without delaying identity readiness or issuing an upload command", async () => {
  const pubkey = "ab".repeat(32);
  const choice = { available: true, pubkey, automatic: null };
  const choiceError = new Error("Could not save choice");
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "identity_restore") return pubkey;
    if (command === "nsec_backup_choice") return choice;
    if (command === "nsec_backup_set_choice") {
      if (!(args as { automatic: boolean }).automatic) throw choiceError;
      return { ...choice, automatic: true };
    }
    throw new Error(`Unexpected command: ${command}`);
  });
  const identity = createIdentity();
  try {
    await expect(identity.ready).resolves.toBe(pubkey);
    expect(invoke).toHaveBeenCalledTimes(1);
    await expect(identity.getBackupChoice()).resolves.toEqual(choice);
    await expect(identity.setBackupChoice(pubkey, true)).resolves.toEqual({
      ...choice,
      automatic: true,
    });
    expect(invoke).toHaveBeenLastCalledWith("nsec_backup_set_choice", {
      pubkey,
      automatic: true,
    });
    await expect(identity.setBackupChoice(pubkey, false)).rejects.toBe(
      choiceError,
    );
    expect(identity.snapshot()).toEqual({ status: "ready", viewer: pubkey });
    // The backup status registers on first read, not with the identity.
    expect(identity.backup.snapshot()).toBeUndefined();
    expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual([
      "identity_restore",
      "nsec_backup_choice",
      "nsec_backup_set_choice",
      "nsec_backup_set_choice",
    ]);
  } finally {
    identity.dispose();
  }
});
