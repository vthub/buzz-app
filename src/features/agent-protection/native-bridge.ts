import type { HostMcpServer, McpHandler } from "../host/service";
import {
  ALL_PHASES,
  type AgentProtection,
  type ProtectionAction,
} from "./service";

export function protectionEnvironment(protection: AgentProtection) {
  const phases = protection.phases ?? ALL_PHASES;
  return {
    BUZZ_SECURITY_CONTEXT: phases.context ? "1" : "0",
    BUZZ_SECURITY_TOOL: phases.tool ? "1" : "0",
    BUZZ_SECURITY_TOOL_RESULT: phases["tool-result"] ? "1" : "0",
  };
}

/** A native worker has one immutable agent/policy binding. Its requests can
 * describe evidence, but cannot choose policy, reviewer or requesting identity. */
export async function nativeProtectionBridge(
  serve: (handler: McpHandler) => Promise<HostMcpServer>,
  protection: AgentProtection,
) {
  protection.assertAvailable();
  const lifetime = new AbortController();
  let pending = 0;
  const server = await serve(async (message) => {
    const call = message as {
      id?: string;
      method?: string;
      params?: ProtectionAction;
    };
    if (call?.method === "initialize")
      return {
        jsonrpc: "2.0",
        id: call.id,
        result: {
          protocolVersion: "2025-11-25",
          capabilities: {},
          serverInfo: { name: "buzz-security", version: "2" },
        },
      };
    if (call?.method === "notifications/initialized") return undefined;
    if (call?.method === "ping")
      return { jsonrpc: "2.0", id: call.id, result: {} };
    const action = call?.params;
    if (
      typeof call?.id !== "string" ||
      call?.method !== "buzz/security/check" ||
      !action ||
      !["context", "tool", "tool-result"].includes(action.kind) ||
      typeof action.session !== "string" ||
      !action.session ||
      Object.keys(action).sort().join(",") !== "content,kind,session" ||
      pending >= 16
    )
      throw new Error("Invalid native security request");
    pending++;
    try {
      await protection.check(structuredClone(action), lifetime.signal);
      return { jsonrpc: "2.0", id: call.id, result: { allowed: true } };
    } catch {
      return { jsonrpc: "2.0", id: call.id, result: { allowed: false } };
    } finally {
      pending--;
    }
  });
  void server.closed.then(() => lifetime.abort());
  const authorization = server.headers.find(
    (header) => header.name.toLowerCase() === "authorization",
  )?.value;
  if (!authorization?.startsWith("Bearer ")) {
    await server.close();
    throw new Error("The native security bridge has no authentication");
  }
  return {
    env: {
      ...protectionEnvironment(protection),
      BUZZ_SECURITY_URL: server.url,
      BUZZ_SECURITY_TOKEN: authorization.slice(7),
    },
    async close() {
      lifetime.abort();
      await server.close();
    },
  };
}
