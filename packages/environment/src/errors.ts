export class EnvironmentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly outcomeUnknown = false,
  ) { super(message); this.name = "EnvironmentError"; }
}
export class ExecutionAbortedBeforeStart extends EnvironmentError {
  constructor() { super("aborted_before_start", "Command was cancelled before it started."); }
}
export function required(value: string, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0"))
    throw new EnvironmentError("invalid_argument", label + " must be a nonempty string without NUL.");
  return value;
}
export function seconds(value: number, zero = false): number {
  if (!Number.isFinite(value) || value < (zero ? 0 : 1) || value > 86_400)
    throw new EnvironmentError("invalid_timeout", "Timeout must be between " + (zero ? 0 : 1) + " and 86400 seconds.");
  return value;
}
export function absolutePath(path: string): string {
  required(path, "path");
  if (!path.startsWith("/")) throw new EnvironmentError("invalid_path", "An absolute environment path is required.");
  return path;
}
