// Native shell environments identify a session. A shared Unix account is one trust boundary.
const sessionVariables = {
  codex: "CODEX_THREAD_ID",
  claude: "CLAUDE_CODE_SESSION_ID",
  agy: "ANTIGRAVITY_CONVERSATION_ID",
  dsh: "DSH_SESSION_ID",
  opencode: "OPENCODE_SESSION_ID",
  pi: "PI_DURABLE_CONVERSATION_ID",
  kimi: "KIMI_CODE_SESSION_ID",
  hermes: "HERMES_SESSION_ID",
} as const;

/** Whether this Host can identify requests from the kernel's terminal. */
export const supportsSessionRelay = (kernel: string | undefined) =>
  kernel !== undefined && Object.hasOwn(sessionVariables, kernel);

export function shellSession(env: NodeJS.ProcessEnv) {
  const sessions = Object.entries(sessionVariables).flatMap(([kernel, variable]) => {
    const threadId = env[variable];
    return threadId ? [{ kernel, threadId }] : [];
  });
  if (sessions.length > 1) throw new Error("ambiguous_shell_session");
  return sessions[0];
}

export function relayIdentity(env: NodeJS.ProcessEnv) {
  const session = shellSession(env);
  if (!session) return undefined;
  // The original Codex format also works with Hosts that require the native command receipt.
  if (session.kernel === "codex" && env.CODEX_TOOL_CALL_ID)
    return { threadId: session.threadId, callId: env.CODEX_TOOL_CALL_ID };
  return session;
}
