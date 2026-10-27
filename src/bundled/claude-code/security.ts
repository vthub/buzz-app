import type { AgentProtection } from "../../features/agent-protection/service";
import type { Spawn } from "./claude";
export const PROTECTED_CLAUDE_VERSION = "2.1.305";
export type ClaudeProtection = Readonly<{
  gate: AgentProtection;
  history(path: string, signal: AbortSignal): Promise<unknown>;
}>;
export async function protectedRuntime(spawn: Spawn) {
  let stdout = "",
    stderr = "";
  const process = await spawn("runtime", {
    env: { BUZZ_CLAUDE_VERSION: PROTECTED_CLAUDE_VERSION },
    onStdout: (data) => {
      stdout += data;
    },
    onStderr: (data) => {
      stderr += data;
    },
  });
  const timer = setTimeout(() => void process.kill(), 15000);
  try {
    if ((await process.exited) !== 0)
      throw new Error(
        stderr.trim() || "Install the protected Claude runtime in Buzz",
      );
    const result = JSON.parse(stdout) as { version: string; root: string };
    if (
      result.version !== PROTECTED_CLAUDE_VERSION ||
      !result.root?.startsWith("/")
    )
      throw new Error("The protected Claude runtime is unavailable");
    return result;
  } finally {
    clearTimeout(timer);
  }
}
