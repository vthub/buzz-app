import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, stat, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "buzz-codex-enforcement-")),
  file = join(dir, "allowed.txt"),
  denied = join(dir, "denied.txt");
let phase = process.argv.includes("--context-off") ? "context-off" : "allow",
  calls = 0,
  release,
  entered;
const held = new Promise((r) => (release = r)),
  toolEntered = new Promise((r) => (entered = r)),
  checks = [];
const http = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const m = JSON.parse(raw || "{}");
  if (req.url === "/mcp") {
    assert.equal(req.headers.authorization, "Bearer fixture");
    let result;
    if (m.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "fixture");
      result = {
        serverInfo: { version: "2" },
        capabilities: {},
        protocolVersion: "2025-11-25",
      };
    } else {
      assert.equal(req.headers["mcp-session-id"], "fixture");
      checks.push(m.params);
      if (m.params.kind === "tool") {
        entered();
        if (phase === "allow") await held;
      }
      result = {
        allowed:
          phase === "context-off" ||
          phase === "allow" ||
          (phase === "deny" && m.params.kind !== "tool"),
      };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    return;
  }
  calls++;
  console.error("MODEL", req.url, "bytes", raw.length);
  if (calls === 1)
    console.error(
      "TOOLS",
      JSON.stringify(
        m.tools?.map((t) => ({
          type: t.type,
          name: t.name,
          tools: t.tools?.map((t) => t.name),
        })),
      ),
    );
  else
    console.error(
      "OUTPUT",
      JSON.stringify(m.input?.filter((i) => i.type === "function_call_output")),
    );
  const output =
    phase === "context-off" ||
    (Array.isArray(m.input) &&
      m.input.some((item) => item.type === "function_call_output"));
  const item = output
    ? {
        type: "message",
        role: "assistant",
        id: `message-${calls}`,
        content: [{ type: "output_text", text: "done", annotations: [] }],
      }
    : {
        type: "function_call",
        id: `fc-${calls}`,
        call_id: `call-${calls}`,
        name: "exec_command",
        namespace: "functions",
        arguments: JSON.stringify({
          cmd:
            "printf checked > " +
            JSON.stringify(phase === "allow" ? file : denied),
          max_output_tokens: 200,
        }),
      };
  res.setHeader("Content-Type", "text/event-stream");
  for (const event of [
    {
      type: "response.created",
      response: { id: `response-${calls}`, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    {
      type: "response.completed",
      response: {
        id: `response-${calls}`,
        status: "completed",
        output: [item],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
});
await new Promise((r) => http.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${http.address().port}`;
const child = spawn(process.argv[2], [], {
  cwd: dir,
  detached: process.platform !== "win32",
  env: {
    ...process.env,
    CODEX_HOME: dir,
    BUZZ_SECURITY_URL: `${url}/mcp`,
    BUZZ_SECURITY_TOKEN: "fixture",
    BUZZ_SECURITY_CONTEXT: phase === "context-off" ? "0" : "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let id = 0,
  buffer = "",
  stderr = "";
const pending = new Map();
child.stderr.on("data", (v) => (stderr = (stderr + v).slice(-4000)));
child.stdout.on("data", (v) => {
  buffer += v;
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n"),
      m = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    console.error("RPC", m.method || m.id, m.error || "");
    const cb = pending.get(m.id);
    if (cb) {
      pending.delete(m.id);
      m.error
        ? cb.reject(new Error(JSON.stringify(m.error)))
        : cb.resolve(m.result);
    }
    if (m.method === "turn/completed") ended?.(m.params.turn);
  }
});
let ended;
child.on("exit", (code) => {
  for (const cb of pending.values())
    cb.reject(new Error(`Exited ${code} ${stderr}`));
});
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out ${method} ${stderr}`)),
      30000,
    );
    pending.set(++id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );
const config = {
  model_provider: "fixture",
  "model_providers.fixture": {
    name: "fixture",
    base_url: `${url}/v1`,
    wire_api: "responses",
    requires_openai_auth: false,
    supports_websockets: false,
  },
  web_search: "disabled",
  "features.code_mode": false,
  "features.plugins": false,
  "features.apps": false,
};
const start = () =>
  rpc("thread/start", {
    cwd: dir,
    model: "fixture-model",
    approvalPolicy: "never",
    sandbox: "danger-full-access",
    ephemeral: true,
    config,
  });
const turn = async (thread, text) => {
  const completed = new Promise((r) => (ended = r));
  await rpc("turn/start", {
    threadId: thread,
    input: [{ type: "text", text, text_elements: [] }],
  });
  return completed;
};
try {
  const initialized = await rpc("initialize", {
    clientInfo: { name: "buzz", version: "1" },
    capabilities: { experimentalApi: true },
  });
  assert.ok(initialized.userAgent.includes("buzz-protection-v2"));
  child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
  if (phase === "context-off") {
    const session = await start();
    await turn(session.thread.id, "large input ".repeat(7000));
    assert.ok(calls > 0);
    assert.ok(
      checks.length > 0 &&
        checks.every((row) => row.kind === "context" && row.content === null),
    );
    console.log(JSON.stringify({ disabledInputInspection: true }));
  } else {
    const evidenceTail = "final complete security evidence";
    const largeInput =
      "Write the requested fixture file. " +
      "context ".repeat(12000) +
      evidenceTail;
    const session = await start();
    const working = turn(session.thread.id, largeInput);
    let deadline;
    await Promise.race([
      toolEntered,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Tool gate not reached: ${stderr}`)),
          20000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(await exists(file), false);
    release();
    assert.equal((await working).status, "completed");
    assert.equal(await readFile(file, "utf8"), "checked");
    assert.ok(
      checks.some(
        (row) =>
          row.kind === "tool" &&
          JSON.stringify(row.content.conversation).includes(
            "Write the requested fixture file.",
          ),
      ),
    );
    const inspectedInput = checks.find(
      (row) =>
        row.kind === "context" &&
        JSON.stringify(row.content).includes(evidenceTail),
    );
    assert.ok(inspectedInput, "Large model input lost its final evidence");
    assert.ok(
      Buffer.byteLength(JSON.stringify(inspectedInput.content)) > 65536,
    );
    assert.ok(
      checks.some(
        (row) =>
          row.kind === "tool" &&
          JSON.stringify(row.content.conversation).includes(evidenceTail),
      ),
      "Tool review lost the large preceding conversation",
    );
    phase = "deny";
    const second = await start();
    await turn(second.thread.id, "Write the second fixture.");
    assert.equal(await exists(denied), false);
    phase = "input-deny";
    const count = calls;
    await turn(second.thread.id, "Blocked input.");
    assert.equal(calls, count);
    console.log(
      JSON.stringify({
        heldSideEffect: true,
        exactContext: true,
        deniedSideEffect: true,
        deniedModelInput: true,
        calls,
      }),
    );
  }
} finally {
  const stopped =
    child.exitCode !== null || child.signalCode !== null
      ? Promise.resolve()
      : new Promise((resolve) => child.once("exit", resolve));
  if (process.platform === "win32") child.kill();
  else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error("Fixture process group could not stop", error);
        child.kill();
      }
    }
  }
  await stopped;
  http.closeAllConnections();
  await new Promise((r) => http.close(r));
  await rm(dir, {
    recursive: true,
    force: true,
    maxRetries: 3,
    retryDelay: 100,
  });
}
