// @vitest-environment node
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const binary = process.env.CODEX_PROTECTION_BIN;
it.skipIf(!binary)(
  "disabled input inspection accepts a large model request without sending its evidence",
  async () => {
    if (!binary)
      throw new Error("Set the pinned runtime binary for this native fixture");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./protection-fixture.mjs", import.meta.url)),
        binary,
        "--context-off",
      ],
      { timeout: 35_000 },
    );
    expect(JSON.parse(stdout)).toEqual({ disabledInputInspection: true });
  },
  40_000,
);
it.skipIf(!binary)(
  "native Codex code mode holds and denies nested tool execution through its bundled helper",
  async () => {
    if (!binary)
      throw new Error("Set the pinned runtime binary for this native fixture");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./protection-fixture.mjs", import.meta.url)),
        binary,
        "--code-mode",
      ],
      { timeout: 35_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      heldSideEffect: true,
      deniedSideEffect: true,
      deniedModelInput: true,
      codeModeToolCalls: true,
    });
  },
  40_000,
);
it.skipIf(!binary)(
  "native Codex holds an exact action, prevents denied writes, and denies input before inference",
  async () => {
    if (!binary)
      throw new Error("Set the pinned runtime binary for this native fixture");
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        fileURLToPath(new URL("./protection-fixture.mjs", import.meta.url)),
        binary,
      ],
      { timeout: 35_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      heldSideEffect: true,
      exactContext: true,
      deniedSideEffect: true,
      deniedModelInput: true,
    });
  },
  40_000,
);
