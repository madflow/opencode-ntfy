# @madflow/opencode-ntfy

OpenCode plugin that sends push notifications through the ntfy HTTP API when a session completes or errors.

## Install

Add the npm package to your OpenCode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@madflow/opencode-ntfy"]
}
```

## Configure

Create `.opencode/ntfy.json` in your project:

```json
{
  "server": "https://ntfy.sh",
  "topic": "my-opencode-notifications",
  "accessToken": "tk_your_access_token",
  "events": ["session.idle", "session.error"],
  "minSessionDurationSeconds": 30
}
```

Configuration fields:

| Field | Required | Default | Description |
| --- | --- | --- | --- |
| `server` | no | `https://ntfy.sh` | ntfy server URL |
| `topic` | yes | none | ntfy topic name |
| `accessToken` | no | none | ntfy bearer token for protected topics |
| `events` | no | `['session.idle', 'session.error']` | events to notify on |
| `minSessionDurationSeconds` | no | `30` | Only send notifications for sessions lasting at least this many seconds. Set to `0` to disable the filter. |

If `.opencode/ntfy.json` is missing, invalid, or does not contain a `topic`, the plugin logs a warning and disables itself. It does not throw.

For protected ntfy topics, the plugin sends `Authorization: Bearer <accessToken>`.

## Supported Events

- `session.idle`: sends `opencode: task complete` with default priority `3`
- `session.error`: sends `opencode: error` with high priority `4`

Example notifications:

```text
Project: my-project | Session: abc123
Project: my-project | Session: abc123 | Error: ProviderAuthError
```

## Development

```bash
bun install
bun run build
bun test
```

## Notes

- Only `.opencode/ntfy.json` is supported.
- ntfy topics should be hard to guess.
- Username/password auth, templating, and deduplication are not implemented in this version.
