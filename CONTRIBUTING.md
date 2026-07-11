# Contributing

Thank you for helping improve `opencode-goal`.

## Development

Requirements:

- Bun 1.3.9
- Node.js 22.18 or newer
- OpenCode 1.17.9 or newer and below 2.0 for host smoke tests

Install dependencies and run the release gate from the repository root:

```sh
bun install
bun run release:check
```

Behavioral changes should include focused tests and matching README or docs
updates. Compatibility changes must also be checked with
`bun run smoke:host` against the minimum and current supported OpenCode
versions. Provider-backed tests must use disposable projects and must not
commit credentials or generated `.opencode/goals/` state.

## Pull requests

Keep changes focused, explain user-visible behavior and compatibility impact,
and include the verification commands you ran. By contributing, you agree that
your contribution is licensed under the MIT License.
