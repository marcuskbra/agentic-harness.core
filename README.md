# agentic-harness.core

Pi-agnostic business logic for [agentic-harness](https://github.com/Jitsusama/agentic-harness.pi):
state machines, guardian decisions, quest/TDD domain model. Each domain is a
pure, host-agnostic TypeScript module plus a stateless-per-invocation CLI;
adapters (pi, Claude Code, ...) own persistence, presentation and how their
host surfaces things like confirmation.

## Domains

### `tdd`

Drives one discrete red-green-refactor loop by attesting each transition.

```ts
import { attest, idleLoop } from "@jitsusama/agentic-harness.core/tdd";

const result = attest(idleLoop(), {
	action: "plan",
	behaviour: "rejects an empty cart",
});
// { outcome: "advanced", loop: {...}, discipline: "..." }
```

`./tdd/presentation` exports the optional glyph/colour vocabulary for hosts
with a scoreboard; nothing else needs it.

## CLI

Each invocation reads/writes its own small JSON state file — no daemon, no
long-lived process. This is the shape a Bash-invoked skill or a hook
dispatcher needs.

```sh
echo '{"action":"plan","behaviour":"rejects an empty cart"}' \
  | agentic-harness-core tdd attest --state-file .agentic-harness/tdd-loop.json

agentic-harness-core tdd status --state-file .agentic-harness/tdd-loop.json
```

Omit `--state-file` to use the default, `.agentic-harness/tdd-loop.json`
relative to the current directory.

## Development

```sh
pnpm install
pnpm run build      # compiles src/ + bin/ to dist/
pnpm test           # builds, then runs the vitest suite (unit + CLI)
pnpm run typecheck
pnpm run lint
```
