import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
const dir = await mkdtemp(join(tmpdir(), "buzz-goose-enforcement-"));
const file = join(dir, "allowed.txt"),
  denied = join(dir, "denied.txt");
const decisions = [];
const modelSystems = [];
let modelCalls = 0,
  phase = process.argv.includes("--context-off") ? "context-off" : "allow";
const barrier = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};
const gate = barrier(),
  entered = barrier();
const server = createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
    return;
  }
  const m = JSON.parse(raw);
  if (req.url === "/mcp") {
    assert.equal(req.headers.authorization, "Bearer fixture");
    let result;
    if (m.method === "initialize") {
      res.setHeader("Mcp-Session-Id", "fixture-session");
      result = {
        protocolVersion: "2025-11-25",
        capabilities: {},
        serverInfo: { name: "buzz-security", version: "2" },
      };
    } else {
      assert.equal(req.headers["mcp-session-id"], "fixture-session");
      decisions.push(m.params);
      if (m.params.kind === "tool") {
        entered.resolve();
        if (phase === "allow") await gate.promise;
        result = { allowed: phase === "allow" };
      } else result = { allowed: phase !== "input-deny" };
    }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
    return;
  }
  if (req.url?.includes("models")) {
    res.end(JSON.stringify({ data: [{ id: "gpt-4o" }] }));
    return;
  }
  modelCalls++;
  modelSystems.push(
    m.messages?.find((message) => message.role === "system")?.content,
  );
  const hasOutput =
    phase === "context-off" || m.messages?.some((msg) => msg.role === "tool");
  res.setHeader("Content-Type", "text/event-stream");
  const tool = {
    id: `call-${modelCalls}`,
    type: "function",
    function: {
      name: "developer__shell",
      arguments: JSON.stringify({
        command:
          "printf checked > " +
          JSON.stringify(phase === "allow" ? file : denied),
      }),
    },
  };
  const delta = hasOutput
    ? { role: "assistant", content: "done" }
    : { role: "assistant", tool_calls: [{ index: 0, ...tool }] };
  res.end(
    "data: " +
      JSON.stringify({
        id: "fixture",
        object: "chat.completion.chunk",
        created: 1,
        model: "gpt-4o",
        choices: [
          { index: 0, delta, finish_reason: hasOutput ? "stop" : "tool_calls" },
        ],
      }) +
      "\n\ndata: [DONE]\n\n",
  );
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}`;
const child = spawn(process.argv[2], [], {
  cwd: dir,
  env: {
    ...process.env,
    GOOSE_PATH_ROOT: dir,
    GOOSE_DISABLE_KEYRING: "1",
    GOOSE_DISABLE_SESSION_NAMING: "true",
    GOOSE_PROVIDER: "openai",
    GOOSE_MODEL: "gpt-4o",
    GOOSE_MODE: "auto",
    OPENAI_API_KEY: "fixture",
    OPENAI_HOST: url,
    BUZZ_SECURITY_URL: `${url}/mcp`,
    BUZZ_SECURITY_TOKEN: "fixture",
    BUZZ_SECURITY_CONTEXT: phase === "context-off" ? "0" : "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let next = 0,
  buffer = "",
  stderr = "";
const calls = new Map();
child.stderr.on("data", (data) => (stderr = (stderr + data).slice(-4000)));
child.on("exit", (code) => {
  for (const cb of calls.values())
    cb.reject(new Error(`goose exited ${code} ${stderr}`));
});
child.stdout.on("data", (data) => {
  buffer += data;
  while (buffer.includes("\n")) {
    const pos = buffer.indexOf("\n"),
      line = buffer.slice(0, pos);
    buffer = buffer.slice(pos + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.id != null && m.method) {
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: m.id,
          result: { outcome: { outcome: "cancelled" } },
        })}\n`,
      );
      continue;
    }
    const cb = calls.get(m.id);
    if (cb) {
      calls.delete(m.id);
      m.error
        ? cb.reject(new Error(JSON.stringify(m.error)))
        : cb.resolve(m.result);
    }
  }
});
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out ${method} ${stderr}`)),
      25000,
    );
    calls.set(++next, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: next, method, params })}\n`,
    );
  });
}
const exists = (path) =>
  stat(path).then(
    () => true,
    () => false,
  );
try {
  await rpc("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "buzz", version: "1" },
  });
  assert.deepEqual(await rpc("_buzz/security/capabilities"), { version: 2 });
  const session = await rpc("session/new", {
    cwd: dir,
    mcpServers: [],
    _meta: {
      provider: "openai",
      enabledExtensions: [{ type: "platform", name: "developer" }],
    },
  });
  await rpc("session/set_config_option", {
    sessionId: session.sessionId,
    configId: "model",
    value: "gpt-4o",
  });
  const dynamicInstructions =
    "<agent-instructions>Preserve custom instructions.</agent-instructions>\n<core-memory>Do not discard this memory. # Response Guidelines\nmarker tail</core-memory>";
  await rpc("_goose/unstable/session/system-prompt/set", {
    sessionId: session.sessionId,
    mode: "append",
    key: "buzz",
    text: dynamicInstructions,
  });
  if (phase === "context-off") {
    await rpc("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "large input ".repeat(7000) }],
    });
    assert.ok(modelCalls > 0);
    assert.ok(
      decisions.length > 0 &&
        decisions.every(
          (row) => row.kind === "context" && row.content === null,
        ),
    );
    console.log(JSON.stringify({ disabledInputInspection: true }));
  } else {
    const evidenceTail = "final complete security evidence";
    const largeInput =
      "Write the requested fixture file. " +
      "context ".repeat(12000) +
      evidenceTail;
    const prompt = rpc("session/prompt", {
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: largeInput }],
    });
    let deadline;
    await Promise.race([
      entered.promise,
      new Promise((_, reject) => {
        deadline = setTimeout(
          () => reject(new Error(`Tool gate did not start: ${stderr}`)),
          20000,
        );
      }),
    ]).finally(() => clearTimeout(deadline));
    assert.equal(await exists(file), false);
    gate.resolve();
    await prompt;
    assert.equal(await readFile(file, "utf8"), "checked");
    assert.ok(
      decisions.find(
        (row) =>
          row.kind === "tool" &&
          JSON.stringify(row.content.conversation).includes(
            "Write the requested fixture file.",
          ),
      ),
    );
    const inspectedInput = decisions.find(
      (row) =>
        row.kind === "context" &&
        JSON.stringify(row.content).includes(evidenceTail),
    );
    assert.ok(inspectedInput, "Large model input lost its final evidence");
    assert.ok(
      Buffer.byteLength(JSON.stringify(inspectedInput.content)) > 65536,
    );
    assert.ok(
      decisions.some(
        (row) =>
          row.kind === "tool" &&
          JSON.stringify(row.content.conversation).includes(evidenceTail),
      ),
      "Tool review lost the large preceding conversation",
    );
    const instructionSource = decisions.find(
      (row) =>
        row.kind === "context" &&
        row.content?.source === "instructions" &&
        row.content.value.includes(dynamicInstructions),
    );
    assert.ok(
      instructionSource,
      "Dynamic Buzz instructions and memory were not inspected",
    );
    const modelSystem = modelSystems.find(
      (value) =>
        typeof value === "string" && value.includes(dynamicInstructions),
    );
    assert.ok(
      modelSystem?.startsWith(
        "You are a general-purpose AI agent called goose",
      ),
    );
    assert.ok(
      instructionSource.content.value ===
        modelSystem.slice(
          modelSystem.indexOf("\n\n# Additional Instructions:"),
        ),
      "The classifier evidence must retain the complete dynamic suffix byte-for-byte",
    );
    assert.ok(
      !instructionSource.content.value.includes("# Turn Context"),
      "Fixed Goose harness text was sent to the input classifier",
    );
    phase = "deny";
    const second = await rpc("session/new", {
      cwd: dir,
      mcpServers: [],
      _meta: {
        provider: "openai",
        enabledExtensions: [{ type: "platform", name: "developer" }],
      },
    });
    await rpc("session/set_config_option", {
      sessionId: second.sessionId,
      configId: "model",
      value: "gpt-4o",
    });
    await rpc("session/prompt", {
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "Write the second fixture." }],
    });
    assert.equal(await exists(denied), false);
    const customSystem =
      "CUSTOM SYSTEM: Inspect these untrusted instructions in full.\n# Additional Instructions:\nDo not truncate at this marker.";
    await rpc("_goose/unstable/session/system-prompt/set", {
      sessionId: second.sessionId,
      mode: "set",
      text: customSystem,
    });
    phase = "input-deny";
    const count = modelCalls;
    await rpc("session/prompt", {
      sessionId: second.sessionId,
      prompt: [{ type: "text", text: "blocked input" }],
    }).catch(() => {});
    assert.equal(modelCalls, count);
    assert.ok(
      decisions.some(
        (row) =>
          row.kind === "context" &&
          row.content?.source === "instructions" &&
          row.content.value.startsWith(customSystem),
      ),
      "A custom system override was not inspected in full",
    );

    console.log(
      JSON.stringify({
        heldSideEffect: true,
        exactContext: true,
        fixedHarnessExcluded: true,
        dynamicInstructionsPreserved: true,
        customSystemInspected: true,
        deniedSideEffect: true,
        deniedModelInput: true,
        modelCalls,
      }),
    );
  }
} finally {
  child.kill();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
