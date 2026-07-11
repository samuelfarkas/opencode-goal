# opencode-goal

A durable `/goal` workflow for OpenCode. Set an objective once and the plugin
keeps it in context, persists progress across compaction and restarts, and
continues while the goal remains active.

This is an independent community project. It is not built, maintained, or
endorsed by the OpenCode team.

## Requirements

- OpenCode `>=1.17.9 <2`
- Node.js `>=22.18`

## Install

Add the versioned GitHub release tarball to your project `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "@samuelfarkas/opencode-goal@https://github.com/samuelfarkas/opencode-goal/releases/download/v0.3.8/samuelfarkas-opencode-goal-0.3.8.tgz"
  ]
}
```

This uses GitHub Releases directly. It does not use npm, GitHub Packages,
Verdaccio, a private registry, or an access token.

Alternatively, let the packaged installer update your global OpenCode config:

```sh
bunx --package '@samuelfarkas/opencode-goal@https://github.com/samuelfarkas/opencode-goal/releases/download/v0.3.8/samuelfarkas-opencode-goal-0.3.8.tgz?download=1' opencode-goal --global
```

Restart OpenCode, then create a goal:

```text
/goal implement the checkout retry flow and verify the tests
```

That is the complete setup. The plugin registers `/goal` at load time, so you
do not need a separate `command.goal` block. It does not pin an agent or model;
OpenCode keeps using your current selection.

Goal state is stored under `.opencode/goals/`. Add it to the consuming
project's `.gitignore`:

```gitignore
.opencode/goals/
```

To install manually for every project, add the same package entry to
`~/.config/opencode/opencode.json` instead. Upgrade by replacing both version
numbers in the URL with the new release version.

## Use

```text
/goal ship the feature and verify tests pass
/goal --check "unit tests pass" --check "docs are updated" ship the feature
/goal --max-turns 6 --max-minutes 20 --max-tokens 12000 ship safely
/goal status
/goal history
/goal checks
/goal add "manual smoke passes"
/goal done C1 "bun test passed"
/goal mode checklist
/goal mode standard
/goal pause
/goal resume
/goal status blocked
/goal status complete
/goal clear
/goal purge
/goal help
```

Creation flags are stored with the goal:

- `--check`, `--checks`, and `-c` add checklist items and can be repeated.
- `--constraint` adds a persistent constraint and can be repeated.
- `--max-turns`, `--max-minutes`, and `--max-tokens` set goal-specific limits.
- `--` ends flag parsing when an objective intentionally begins with a dash.

## How completion works

The agent completes a goal by ending its response with evidence and a completion
marker:

```text
[goal:evidence] bun test passed and the changed behavior was exercised
[goal:complete]
```

A blocked goal ends with a concrete blocker followed by:

```text
[goal:blocked]
```

In checklist mode every check must have evidence before completion is accepted.
The agent can record evidence through the plugin tools or by naming a check ID
in the evidence marker.

## Behavior

- One current goal is maintained per OpenCode session.
- Active goals survive compaction and OpenCode restarts.
- Progress, token use, active time, and continuation count are persisted.
- Provider usage-window errors pause continuation until the reported or
  configured reset time without changing the goal status.
- Repeated low-progress turns, prompt failures, and user intervention stop
  unattended continuation safely.
- Completion, blocking, pausing, and budget limits are reflected in the session
  title and transient toasts when those host surfaces are available.
- `/goal clear` archives the result; `/goal purge` removes the session's current
  and archived goal data from the plugin's live files.

The plugin also exposes `get_goal`, `set_goal`, `update_goal`,
`add_goal_check`, `record_goal_check_evidence`, and `clear_goal` to the agent
when the OpenCode tool factory is available.

## Diagnostics

Run the provider-free doctor against a project configuration:

```sh
opencode-goal doctor --config /path/to/project/opencode.json
```

Doctor inspects package metadata, configuration, existing goal files, and the
installed OpenCode version. It does not contact a model or provider and does
not create goal state.

## Configuration

Defaults are designed to work without configuration. On OpenCode builds that
accept plugin tuples, options can be supplied with the package entry:

```json
{
  "plugin": [
    [
      "@samuelfarkas/opencode-goal@https://github.com/samuelfarkas/opencode-goal/releases/download/v0.3.8/samuelfarkas-opencode-goal-0.3.8.tgz",
      {
        "maxTurns": 0,
        "maxDurationSeconds": 0,
        "tokenBudget": 200000,
        "toastNotifications": true,
        "sessionTitle": true
      }
    ]
  ]
}
```

Supported options:

| Option | Default | Purpose |
| --- | ---: | --- |
| `commandName` | `goal` | Slash-command name |
| `maxTurns` | `0` (disabled) | Optional continuation limit per goal |
| `maxDurationSeconds` | `0` (disabled) | Optional active-time limit per goal |
| `tokenBudget` | none | Cumulative assistant-token limit |
| `stateFilePath` | `.opencode/goals/opencode-goal-state.json` | Durable state path |
| `persistState` | `true` | Enable durable state |
| `registerTools` | `true` | Expose agent-facing goal tools |
| `autoContinue` | `true` | Continue active goals automatically |
| `idleSettleMs` | `500` | Quiet period before continuation |
| `minDelayMs` | `1500` | Minimum continuation delay |
| `maxPromptFailures` | `3` | Failures allowed before pausing |
| `usageLimitWaitSeconds` | `18000` | Fallback provider reset wait |
| `maxRecentMessages` | `50` | Transcript reconciliation window |
| `noProgressTokenThreshold` | `50` | Thin-turn threshold |
| `noProgressTurnsBeforePause` | `3` | Thin turns allowed before pausing |
| `noToolCallTurnsBeforePause` | `0` | No-tool guard; `0` disables it |
| `budgetWrapupRatio` | `0.85` | Near-budget wrap-up threshold |
| `maxObjectiveLength` | `4000` | Maximum objective length |
| `completionMarker` | `[goal:complete]` | Completion marker |
| `blockedMarker` | `[goal:blocked]` | Blocked marker |
| `evidenceMarker` | `[goal:evidence]` | Evidence marker |
| `toastNotifications` | `true` | Lifecycle toasts |
| `sessionTitle` | `true` | Status glyph in session titles |

If your OpenCode version rejects tuple entries, use the plain package string;
all defaults remain available.

Like Codex `/goal`, a plain goal has no turn or elapsed-time limit. Set a
positive configuration value or use `--max-turns` / `--max-minutes` when a
specific goal should have those safeguards.

## Development

```sh
bun install
bun run release:check
```

The release check runs strict TypeScript checking, 171 unit and race tests, a
clean build, and a packed external-consumer smoke test. Maintainers can also run
`bun run smoke:host` against supported OpenCode binaries.

## Limitations

- Completion is marker-based. Review evidence for high-risk unattended work.
- OpenCode does not expose a native goal API, so state is maintained by this
  plugin under `.opencode/goals/`.
- The session title and toast are best-effort host integrations rather than a
  persistent pinned TUI panel.

## License

MIT
