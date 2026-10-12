/** Isolated SDK helpers inherit the same CLAUDE_CONFIG_DIR as the native engine. */
import {
  listSessions,
  getSessionMessages,
  forkSession,
  deleteSession,
} from "@anthropic-ai/claude-agent-sdk";
let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const { action, id, options } = JSON.parse(input);
  let result: unknown;
  if (action === "list") result = await listSessions(options);
  else if (action === "history") result = await getSessionMessages(id, options);
  else if (action === "fork") result = await forkSession(id, options);
  else if (action === "delete") {
    await deleteSession(id, options);
    result = null;
  } else throw new Error("unknown_session_operation");
  process.stdout.write(JSON.stringify(result));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
