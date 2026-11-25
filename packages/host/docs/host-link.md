# Host link: let a Router reach an Agent on your own machine

A machine at home or in an office usually has no public address, so a Router elsewhere cannot call its Agent Host.
With a host link the Host connects out to the Router and keeps that connection open. The Router then sends messages
to one of the Host's runtimes through it and receives the replies.

The link carries messages, not control of the machine. Working directory, sandbox, approval policy, model and
credentials stay as `host.json` and the native Agent define them.

## Pair and stay connected

Create `host.json` as in the [HTTP service guide](http-service.md), ask the Router's owner for a pairing code, then:

```sh
npx --no-install agent-host link --config host.json --url https://router.example --code XXXX-XXXX
```

The command exchanges the code for a device credential, stores it, and then serves like `agent-host serve`. From then
on `agent-host serve --config host.json` connects by itself whenever it starts.

| Option | Meaning |
| --- | --- |
| `--url` | The Router's origin, or its API base ending in `/_agent-router/v1`. `https` is required unless the Router runs on this machine. |
| `--code` | The pairing code. It works once and expires after an hour. Hyphen, spaces and letter case do not matter. |
| `--runtime` | Which runtime of `host.json` the Router may reach. Required when `host.json` has more than one. |
| `--name` | The name shown for this machine. Default: the machine's hostname. |
| `--enroll-only` | Pair and exit without serving, for example before installing a service. |
| `--json` | Print the result of pairing as one JSON object: `linkId`, `agentId`, `runtimeId`, `deviceName`, `url`, `linkFile`. |

The credential is written to `link.json` in the state directory, readable by the current user only (file mode `0600`;
on Windows the file inherits the permissions of the state directory, so keep that directory inside your user
profile). It is never printed. Pairing again replaces the file; the Router then refuses the earlier credential.

To stop linking, stop the service and delete `link.json`. The Router's owner can also revoke the link there. If the
linked runtime is removed from `host.json`, `serve` refuses to start with `link_runtime_not_found` until you pair
again or delete `link.json`.

## What the Router can do through the link

| Allowed | Operation |
| --- | --- |
| Check the service | `GET /v1/health` |
| See the linked runtime | `GET /v1/runtimes`, `POST /v1/runtimes/inspect` (that runtime only, without its working directory) |
| Send a message | `POST /v1/runs` with `sessionId`, `runtimeId`, `input`, and optionally `requestKey`, `context`, `settings`, `mode`, `timeoutMs` |
| Follow a run | `GET /v1/runs/:id`, `GET /v1/runs/by-request`, `GET /v1/runs/:id/events` |
| Control a run | `POST /v1/runs/:id/cancel`, `POST /v1/runs/:id/steer` |
| Answer approvals and questions | `GET /v1/runs/:id/calls`, `POST /v1/runs/:id/calls/:callId/result` |

Everything else answers `403 link_route_not_allowed`: workspace files, native session management, the native
extension, runtime discovery, the session and run lists, and the relay.

A linked submission is a message. These fields are refused with `403 link_field_not_allowed:<field>` when they carry
anything: `instructions`, `tools`, `toolOutput`, `inputItems`, `attachments`. `context` may say who is asking and is
limited to 4,000 characters (`413 link_context_too_large`); it is per-turn context, not an instruction.
`settings` are checked against the `allowedSettings` of `host.json`, as for any caller. A run of another runtime, or
another `runtimeId`, does not exist for the link (`404 run_not_found`, `403 link_runtime_not_allowed`).

Sessions the link starts are marked `origin: "link"`. Only the link continues them, and the link cannot continue a
session that a local client started (`409 session_configuration_conflict`).

The local HTTP listener is unchanged: it still listens on `127.0.0.1` with the owner token, and the owner there keeps
full access. The link opens no listening port.

## Approvals that wait for a person

A native approval or question waits for an answer for `interactionTimeoutMs` (default `1800000`, half an hour;
between `1000` and `86400000`). Set another time in `host.json`:

```json
{
  "interactionTimeoutMs": 600000,
  "runtimes": [{ "id": "local-codex", "kernel": "codex", "cwd": "./workspace" }]
}
```

An unanswered call is closed as `timed_out`, and a late answer is refused. The kernel is told that no one answered,
which is neither a refusal by the person nor a failure of the turn, and its turn goes on:

| Kernel | What it is told |
| --- | --- |
| Codex | A JSON-RPC error. Codex treats the request as failed: a command or file change is not run, a question has no answers. |
| Claude | The tool is denied with "No one answered this request before it expired."; an elicitation is cancelled. |
| Pi | The tool call is blocked with the same sentence. |
| Hermes | Its own refusal (`deny` for an approval, an empty answer otherwise). |
| ACP kernels | `cancelled` for a permission request or an elicitation. |
| OpenClaw | Nothing: the approval expires in OpenClaw by its own time. |

A run's own `timeoutMs` (default one hour) still ends the run, also while an approval waits.

## Connection behavior

- The Host opens one WebSocket to `<router>/_agent-router/v1/host-links/socket` with
  `Authorization: Bearer <device credential>`. The Router sends `{type:"request", id, method, path, body?}` and the
  Host answers `{type:"response", id, status, body}` with what the same HTTP request would return. Frames are limited
  to 16 MiB; a larger answer becomes `413 response_too_large`.
- The Router greets with `{type:"hello", heartbeatMs}` and pings at that interval. A connection that is silent for 2.5
  intervals is dropped.
- A lost connection is retried after 1 second, then with doubling delays up to 30 seconds, for as long as the service
  runs. A Router restart needs no action on the machine.
- A run keeps going while the connection is down. The Router finds it again by its run id or `requestKey`. Approvals
  asked meanwhile wait for `interactionTimeoutMs`.
- `agent-host serve` prints each change: `Host link online`, `offline; reconnecting`, `rejected by the Router` (the
  credential was revoked or replaced; retried every 30 seconds until you pair again) and `taken over by another
  process` (a second service used the same `link.json`; this one stops linking).

## Keep it running

`agent-host serve` is a foreground process. Let the operating system start it when you sign in, as your own user, so
the native Agent finds its login and configuration. Use absolute paths; the examples assume the package is installed
in `<project>` and `host.json` is there.

### Windows: Task Scheduler

Run once in PowerShell:

```powershell
$project = "C:\path\to\project"
$action = New-ScheduledTaskAction -Execute "node.exe" `
  -Argument "`"$project\node_modules\@olorinm\agent-host\dist\service\cli.js`" serve --config `"$project\host.json`"" `
  -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Agent Host" -Action $action -Trigger $trigger -Settings $settings
Start-ScheduledTask -TaskName "Agent Host"
```

The task runs in your session after sign-in, without administrator rights. `-ExecutionTimeLimit` zero removes the
default three-day limit. Check it with `Get-ScheduledTask -TaskName "Agent Host" | Get-ScheduledTaskInfo` and remove it
with `Unregister-ScheduledTask -TaskName "Agent Host"`. To keep output, wrap the command in a `.cmd` file that
redirects to a log file and point `-Execute` at that file.

### macOS: launchd

Save as `~/Library/LaunchAgents/agent-host.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>agent-host</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/local/bin/node</string>
    <string>/path/to/project/node_modules/@olorinm/agent-host/dist/service/cli.js</string>
    <string>serve</string>
    <string>--config</string>
    <string>/path/to/project/host.json</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/project</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/path/to/project/agent-host.log</string>
  <key>StandardErrorPath</key><string>/path/to/project/agent-host.log</string>
</dict>
</plist>
```

Then `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/agent-host.plist`. Stop and remove it with
`launchctl bootout gui/$(id -u)/agent-host`. launchd starts processes with a minimal `PATH`: use the absolute path of
`node` (`which node`), and add an `EnvironmentVariables` entry for `PATH` when the native Agent's command is not in
`/usr/bin:/bin`.

### Linux: systemd user service

Save as `~/.config/systemd/user/agent-host.service`:

```ini
[Unit]
Description=Agent Host
After=network-online.target

[Service]
WorkingDirectory=/path/to/project
ExecStart=/usr/bin/node /path/to/project/node_modules/@olorinm/agent-host/dist/service/cli.js serve --config /path/to/project/host.json
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
```

Then `systemctl --user daemon-reload && systemctl --user enable --now agent-host`. Read its output with
`journalctl --user -u agent-host`. A user service stops when you log out; `loginctl enable-linger "$USER"` keeps it
running without a session.

On every platform, pair first (`agent-host link ... --enroll-only`) and then install the service, so the service
itself never needs the pairing code.
