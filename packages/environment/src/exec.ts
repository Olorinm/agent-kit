import { EnvironmentError, ExecutionAbortedBeforeStart, required, seconds, absolutePath } from "./errors.js";
import { commandExit, type RemoteSandbox, type RemoteProcess } from "./driver.js";
import type { ExecOptions, OutputChunk } from "./types.js";

/** The SDK accepts a shell string. Quote every argument, including empty ones. */
export function commandString(argv: string[]): string {
  if (!argv.length) throw new EnvironmentError("invalid_command", "Command argv must not be empty.");
  required(argv[0]!, "executable");
  if (argv.some(value => typeof value !== "string" || value.includes("\0")))
    throw new EnvironmentError("invalid_command", "Command arguments must be strings without NUL.");
  return "exec -- " + argv.map(value => "'" + value.replaceAll("'", "'\\''") + "'").join(" ");
}

/** Cancellation observes remote exit; a lost transport is never treated as success. */
export async function* execute(
  sandbox: RemoteSandbox, argv: string[], options: ExecOptions = {},
): AsyncGenerator<OutputChunk> {
  const command = commandString(argv);
  if (options.cwd) absolutePath(options.cwd);
  if (options.timeoutSeconds !== undefined) seconds(options.timeoutSeconds, true);
  if (options.signal?.aborted) throw new ExecutionAbortedBeforeStart();
  const queue: OutputChunk[] = [];
  let queuedBytes = 0;
  let wake: (() => void) | undefined;
  let process: RemoteProcess | undefined;
  let ended = false;
  let cancelled = false;
  let failure: unknown;
  let exit: { exitCode: number | null; signal?: string } | undefined;
  let killing: Promise<boolean> | undefined;
  let cancelDeadline: ReturnType<typeof setTimeout> | undefined;
  let killFailure: (value: { error: unknown }) => void;
  const killFailed = new Promise<{ error: unknown }>(resolve => { killFailure = resolve; });
  const cancel = () => {
    cancelled = true;
    if (process && !ended && !killing) {
      cancelDeadline = setTimeout(() => killFailure({ error: new Error("Remote exit was not observed after cancellation.") }), 10_000);
      killing = process.kill();
      void killing.catch(error => killFailure({ error }));
    }
  };
  const push = (stream: OutputChunk["stream"]) => (text: string) => {
    queuedBytes += Buffer.byteLength(text);
    if (queuedBytes > 8 * 1024 * 1024) {
      failure ??= new EnvironmentError("output_overflow", "Output consumer is too slow; command cancellation requested.", true);
      cancel();
      return;
    }
    queue.push({ stream, text }); wake?.();
  };
  options.signal?.addEventListener("abort", cancel, { once: true });
  const completion = (async () => {
    try {
      // Do not abort startup transport: a late process handle must still be killed.
      process = await sandbox.commands.run(command, {
        background: true, cwd: options.cwd, envs: options.env,
        ...(options.timeoutSeconds !== undefined ? { timeoutMs: options.timeoutSeconds * 1000 } : {}),
        onStdout: push("stdout"), onStderr: push("stderr"),
      });
      const waiting = process.wait().then(result => ({ result }), error => ({ error }));
      if (cancelled) cancel();
      const outcome = await Promise.race([waiting, killFailed]);
      if ("result" in outcome) exit = { exitCode: outcome.result.exitCode };
      else {
        const code = commandExit(outcome.error);
        if (code === undefined) throw outcome.error;
        exit = { exitCode: code };
      }
      if (cancelled) failure ??= new DOMException("Command cancelled.", "AbortError");
    } catch {
      failure ??= new EnvironmentError("execution_unknown", "Command outcome is unknown; inspect the environment before retrying.", true);
    } finally {
      ended = true;
      clearTimeout(cancelDeadline);
      try { await process?.disconnect(); } catch { /* No change to observed exit. */ }
      wake?.();
    }
  })();
  try {
    while (!ended || queue.length) {
      const item = queue.shift();
      if (item) { queuedBytes -= Buffer.byteLength(item.text); yield item; }
      else await new Promise<void>(resolve => { wake = resolve; });
    }
    if (failure) throw failure;
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    if (!ended) cancel();
    await completion;
    if (exit) options.onExit?.(exit);
    else if (failure) throw failure;
  }
}
