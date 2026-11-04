# Contributing to Plumary

Thanks for your interest in improving Plumary. It is an open-source, provider-agnostic
writing assistant: a headless TypeScript core, provider plugins, a CLI, and a desktop app.
Contributions of all sizes are welcome.

## Getting started

Requirements: Node 22+, [pnpm](https://pnpm.io) 12+, and (for the desktop app) a Rust
toolchain with the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm build        # build every package
pnpm test         # run the test suite
pnpm typecheck    # type-check every package
```

Try the engine from the command line:

```bash
export ANTHROPIC_API_KEY=sk-...
echo "she go to store yesterday" | node apps/cli/dist/index.js --provider anthropic --caps grammar,spell
```

Run the desktop app:

```bash
pnpm --filter @plumary/desktop tauri dev
```

## Layout

| Path | What it is |
|---|---|
| `packages/core` | Headless engine, types, and the provider contract |
| `packages/providers/*` | Provider plugins (Anthropic, Ollama, …) |
| `apps/cli` | Command-line smoke-test |
| `apps/desktop` | Tauri macOS menu-bar app |

## Writing a provider plugin

A provider declares which capabilities it supports and implements `run()`. See
`packages/providers/anthropic` for a complete example and `packages/core/src/types.ts`
for the contract. New providers live under `packages/providers/<name>`.

## Pull requests

- Keep changes focused and follow the existing style; code and comments in English.
- Add tests for new behavior. Run `pnpm build && pnpm test && pnpm typecheck` before opening a PR.
- Describe what changed and why. Link any related issue.

By contributing you agree that your contributions are licensed under the MIT License.
