# Slack Subagent Card

Slack Block Kit status cards for OpenClaw sub-agent work.

The plugin posts a Block Kit `plan` card in the originating Slack thread when a sub-agent starts and updates that card as lifecycle events arrive. It is presentation-only: OpenClaw core remains responsible for orchestration, completion routing, session wake/resume behavior, and delivery correctness.

The implementation uses Block Kit message posts and updates only; it does not use Slack stream APIs. The installed package metadata is the source of truth for the current version.

## Requirements

- Node.js `>=22`
- OpenClaw `>=2026.7.2-beta.3`
- A Slack bot token in OpenClaw configuration, or `SLACK_BOT_TOKEN` for the effective default account

This OpenClaw floor is intentional. The plugin imports supported focused SDK entry points and uses the portable `subagent_progress` hook introduced by the pinned beta. Task metadata reads use the asynchronous task API when the host provides it, with synchronous reads on older supported hosts.

## Configuration

The plugin uses OpenClaw's account resolver for `channels.slack`. The requested account is selected first; when no account is requested, OpenClaw's configured `defaultAccount` and account-list rules determine the effective account.

For that effective account:

1. The account's `botToken` is merged over the channel-level `channels.slack.botToken`.
2. Configured secret references are resolved through OpenClaw's supported secret-input runtime.
3. `SLACK_BOT_TOKEN` is considered only for the effective default account and never as a fallback for a named account.

If no token can be resolved, the plugin logs a warning and skips the Slack post.

Compact Block Kit rows for individual sub-agent tool calls are disabled by default. To opt in:

```json
{
  "plugins": {
    "entries": {
      "slack-subagent-card": {
        "config": {
          "toolTasks": {
            "enabled": true
          }
        }
      }
    }
  }
}
```

The host setting `channels.slack.streaming.preview.toolProgress: false` disables these rows even when the plugin-local option is enabled.

## Hook Surface

The plugin registers the official typed hooks:

- `subagent_progress`
- `subagent_spawned`
- `subagent_ended`
- `after_tool_call`

The portable `subagent_progress` events provide the primary start/end lifecycle. The current `subagent_spawned` and `subagent_ended` hooks are retained as compatibility signals and fallback observations, allowing duplicate lifecycle signals to converge onto one tracked card without duplicate posts or terminal updates.

`after_tool_call` updates are optional. When enabled, the plugin adds compact task rows containing a generated local ID, the tool name, a small fixed category for selected file tools, and elapsed time when provided. It never renders tool arguments, tool output, or host call IDs, and retains at most the latest ten rows.

Hook handlers reserve state synchronously and perform Slack work asynchronously. Updates are serialized per run so a terminal result cannot be overwritten by a slower in-flight update. State is in memory and is normalized across plugin reloads in the same host process.

## Slack Target Resolution

The Slack thread can come from either:

- a Slack thread session key such as `agent:main:slack:channel:C123:thread:1777005219.760149`
- a hook requester with `to` and `threadId`, for example `to: "channel:C123"` and `threadId: "1777005219.760149"`

For a direct-message session containing a Slack user ID, the plugin resolves the user to a DM channel with `conversations.open`. That lookup cache is scoped to the selected Slack client/account.

## Presentation Safety

Cards use fixed, generic running and terminal descriptions. Raw OpenClaw task fields such as `progressSummary`, `terminalSummary`, and `error`, and raw hook error/reason values, are never rendered into Slack. Tool arguments and external tool-call identifiers are likewise neither rendered nor retained.

The card title can use the task label/title or hook label/agent ID supplied by OpenClaw. Treat those labels as host-provided presentation metadata; free-form task summaries and failure content are intentionally excluded.

## Package Layout

- `openclaw.plugin.json`: OpenClaw plugin manifest
- `package.json`: package metadata and exact SDK build target
- `index.ts`: typed plugin entry point
- `plugin-handlers.ts`: lifecycle, account, target, and Slack update handling
- `task-card.ts`: fixed card status/detail generation derived from the host task runtime type
- `task-text-sanitizer.ts`: standalone sanitizer retained for explicitly trusted future presentation inputs
- `dist/`: built runtime output

## Validation

```sh
npm ci
npm run preflight
git diff --check
```

`preflight` runs the TypeScript and behavior tests, release-helper tests, OpenClaw Plugin Inspector 0.3.18 against both declared entry points, and an isolated install/runtime inspection of the exact npm tarball against the locked OpenClaw version. It does not publish, push, commit, tag, or create a GitHub release.

## Releasing

Use the scripted release flow:

```sh
npm run metadata:check -- X.Y.Z
npm run release -- X.Y.Z
```

If a release stops after retaining state, inspect `.release/vX.Y.Z/release-state.json` and resume only that candidate with `npm run release -- --resume X.Y.Z`.

Release guidance and guardrails live in [RELEASING.md](./RELEASING.md).

## Limitations

- Codex-harness sub-agent lifecycle cards are not available yet because OpenClaw does not currently emit equivalent lifecycle events from that harness. Upstream tracking: [openclaw/openclaw#112440](https://github.com/openclaw/openclaw/issues/112440).
- Cards use Slack Block Kit message posts/updates only.
- Tool rows are optional and limited to the latest ten calls.
- Cards do not attach Slack `sources` links.
