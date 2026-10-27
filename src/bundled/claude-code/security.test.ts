import { expect, it, vi } from "vitest";
import type { AgentProtection } from "../../features/agent-protection/service";
import { ClaudeProcess, type Spawn } from "./claude";
import { fakeSpawn, flush } from "./claude-testing";
import { AgentSessions } from "./sessions";
import type { ClaudeProtection } from "./security";

function fixture(initialization: "success" | "error" | "held" = "success") {
  const fake = fakeSpawn();
  let acknowledge = () => {};
  const spawn: Spawn = async (id, options = {}) => {
    if (id === "runtime") {
      options.onStdout?.('{"version":"2.1.305","root":"/runtime"}\n');
      return {
        write: async () => {},
        end: async () => {},
        kill: async () => {},
        exited: Promise.resolve(0),
      };
    }
    return fake.spawn(id, {
      ...options,
      onStdout(data) {
        const message = JSON.parse(data);
        if (
          message.type === "control_response" &&
          message.response.request_id === "buzz-1"
        ) {
          acknowledge = () => options.onStdout?.(data);
          if (initialization === "held") return;
          if (initialization === "error") {
            message.response = {
              ...message.response,
              subtype: "error",
              error: "unsupported hooks",
            };
            options.onStdout?.(`${JSON.stringify(message)}\n`);
            return;
          }
        }
        options.onStdout?.(data);
      },
    });
  };
  const check = vi.fn<AgentProtection["check"]>().mockResolvedValue();
  const protection: ClaudeProtection = {
    gate: {
      key: "policy",
      stateKey: "revision",
      processProtection: { readOnlyPaths: [], hiddenPaths: [] },
      assertAvailable() {},
      check,
    },
    history: async () => [{ role: "user", content: "authorized task" }],
  };
  const launch = { cwd: "/work", systemPrompt: "instructions", protection };
  return {
    ...fake,
    spawn,
    protection,
    launch,
    check,
    acknowledge: () => acknowledge(),
  };
}

it("requires hook registration acknowledgment before returning a protected process", async () => {
  const f = fixture("held");
  let ready = false;
  const started = ClaudeProcess.start(f.spawn, f.launch).then((p) => {
    ready = true;
    return p;
  });
  await flush();
  expect(ready).toBe(false);
  expect(f.processes[0]?.prompts).toEqual([]);
  f.acknowledge();
  const process = await started;
  await process.kill();
});

it("kills a protected process when hook registration is rejected", async () => {
  const f = fixture("error");
  const process = await ClaudeProcess.spawn(f.spawn, f.launch);
  await expect(process.initialize(f.launch)).rejects.toThrow(
    "unsupported hooks",
  );
  expect(f.processes[0]?.killed).toBe(true);
  expect(f.processes[0]?.prompts).toEqual([]);
});

it("Stop revokes a pending approval and never releases its callback", async () => {
  const f = fixture();
  let signal: AbortSignal | undefined;
  f.check.mockImplementation(async (_action, stop) => {
    signal = stop;
    await new Promise<void>((_resolve, reject) =>
      stop.addEventListener("abort", () => reject(new Error("stopped")), {
        once: true,
      }),
    );
  });
  const process = await ClaudeProcess.start(f.spawn, f.launch);
  const worker = f.processes[0];
  if (!worker) throw new Error("Claude did not start");
  worker.hold = true;
  const turn = process.send("authorized task");
  worker.emit({
    type: "control_request",
    request_id: "pending-approval",
    request: {
      subtype: "hook_callback",
      callback_id: "security-tool",
      input: {
        hook_event_name: "PreToolUse",
        transcript_path: "/native/transcript",
        tool_name: "Bash",
        tool_input: { command: "write" },
      },
    },
  });
  await flush();
  expect(signal?.aborted).toBe(false);
  await process.interrupt();
  await turn;
  expect(signal?.aborted).toBe(true);
  expect(worker.killed).toBe(true);
  expect(worker.received.some((m) => m.type === "control_response")).toBe(
    false,
  );
});

it("keeps protected metadata discovery pinned, contained and free of workspace tools", async () => {
  const f = fixture();
  const sessions = new AgentSessions({
    spawn: f.spawn,
    launch: async () => f.launch,
    fingerprint: () => "policy",
    newId: () => "session",
    store: { get: () => undefined, set() {}, delete() {} },
  });
  await sessions.metadata();
  const worker = f.processes[0];
  if (!worker) throw new Error("Claude did not start");
  expect(worker.options.args).toContain("--safe-mode");
  expect(worker.options.env?.BUZZ_CLAUDE_VERSION).toBe("2.1.305");
  expect(worker.options.protection?.readOnlyPaths).toContain("/runtime");
  expect(worker.received[0]).toMatchObject({
    request: {
      hooks: {
        PreToolUse: [{ hookCallbackIds: ["security-tool"], timeout: 600 }],
        PostToolBatch: [
          { hookCallbackIds: ["security-incoming"], timeout: 600 },
        ],
      },
    },
  });
  expect(worker.killed).toBe(true);
});
