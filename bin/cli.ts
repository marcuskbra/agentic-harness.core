#!/usr/bin/env node
/**
 * A thin, stateless-per-invocation CLI over the domain modules in
 * `src/`. Each call reads whatever loop state it needs from a
 * small JSON file it owns, applies one command, and writes the
 * result back out — no daemon, no port, no long-lived process.
 * This is the shape both a Bash-invoked Claude Code skill and a
 * future hook dispatcher need: one process, one JSON in, one JSON
 * out.
 *
 * This file is the CLI adapter, not domain logic — argument
 * parsing and state-file I/O live here so `src/tdd` stays pure.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { effectiveCwd, tokenize } from "../command/index.js";
import { checkGitCli } from "../git-cli/index.js";
import { checkGithubCli } from "../github-cli/index.js";
import {
	type DestructiveMatch,
	detectDestructiveCommand,
} from "../internal/guardian/history-gate.js";
import {
	type Attestation,
	attest,
	idleLoop,
	type Loop,
	standingReminder,
} from "../tdd/index.js";
import { runVerify } from "../verify/index.js";
import { checkAttribution, ensureAttributionHook } from "./attribution.js";
import { fileGateDeps } from "./gate-deps.js";
import {
	checkCommitGuardian,
	checkIssueGuardian,
	checkPrGuardian,
} from "./guardians.js";
import {
	runMemoryEdit,
	runMemoryRecall,
	runMemoryReflect,
	runMemoryRetain,
} from "./memory.js";
import { runNotesAction } from "./notes.js";
import { processExec } from "./process-exec.js";
import { runQuestAction } from "./quest.js";
import { runSlackAuthLogin, runSlackAuthStatus } from "./slack-auth.js";
import { runWebCheck } from "./web.js";

/** Where a loop's state lives when the caller doesn't override it. */
const DEFAULT_STATE_FILE = ".agentic-harness/tdd-loop.json";
/** Where quest state lives when the caller doesn't override it. */
const DEFAULT_QUEST_STATE_FILE = ".agentic-harness/quest-state.json";

interface Options {
	domain: string;
	command: string;
	stateFile: string;
	questsRoot: string | undefined;
	notesRoot: string | undefined;
}

function parseArgs(argv: string[]): Options {
	const [domain, command, ...rest] = argv;
	if (!domain || !command) {
		throw new Error(
			"Usage: agentic-harness-core <domain> <command> [--state-file <path>] [--quests-root <path>] [--notes-root <path>]",
		);
	}
	let stateFile =
		domain === "quest" ? DEFAULT_QUEST_STATE_FILE : DEFAULT_STATE_FILE;
	let questsRoot: string | undefined;
	let notesRoot: string | undefined;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--state-file") {
			const value = rest[i + 1];
			if (!value) {
				throw new Error("--state-file requires a path");
			}
			stateFile = value;
			i++;
		} else if (rest[i] === "--quests-root") {
			const value = rest[i + 1];
			if (!value) {
				throw new Error("--quests-root requires a path");
			}
			questsRoot = value;
			i++;
		} else if (rest[i] === "--notes-root") {
			const value = rest[i + 1];
			if (!value) {
				throw new Error("--notes-root requires a path");
			}
			notesRoot = value;
			i++;
		}
	}
	return { domain, command, stateFile, questsRoot, notesRoot };
}

async function readStdin(): Promise<string> {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(chunk as Buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}

async function loadLoop(stateFile: string): Promise<Loop> {
	try {
		const raw = await readFile(stateFile, "utf8");
		return JSON.parse(raw) as Loop;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return idleLoop();
		}
		throw error;
	}
}

async function saveLoop(stateFile: string, loop: Loop): Promise<void> {
	await mkdir(dirname(stateFile), { recursive: true });
	await writeFile(stateFile, `${JSON.stringify(loop, null, 2)}\n`);
}

async function runTddAttest(stateFile: string): Promise<unknown> {
	const input = await readStdin();
	const attestation = JSON.parse(input) as Attestation;
	const loop = await loadLoop(stateFile);
	const result = attest(loop, attestation);
	await saveLoop(stateFile, result.loop);
	return result;
}

async function runTddStatus(stateFile: string): Promise<unknown> {
	const loop = await loadLoop(stateFile);
	return { loop, reminder: standingReminder(loop) };
}

/** The subset of Claude Code's PreToolUse hook stdin payload this reads. */
interface PreToolUseInput {
	tool_name?: string;
	tool_input?: { command?: string };
}

/** A plain-text explanation of why a destructive command was flagged. */
function historyReason(match: DestructiveMatch): string {
	const label = match.severity === "irrecoverable" ? "Destructive" : "Risky";
	return `${label} command: ${match.description}`;
}

/** Build the hook's JSON stdout for a deny or ask decision. */
function decisionOutput(
	permissionDecision: "deny" | "ask",
	permissionDecisionReason: string,
): string {
	return JSON.stringify({
		hookSpecificOutput: {
			hookEventName: "PreToolUse",
			permissionDecision,
			permissionDecisionReason,
		},
	});
}

/**
 * Claude Code's PreToolUse hook contract for a Bash call: deny with a
 * reason, ask with a reason, or say nothing so the normal permission
 * flow decides. Never emit an explicit "allow" here — that would
 * bypass whatever else (other hooks, the user's permission mode)
 * would otherwise decide, for every bash command this hook doesn't
 * flag.
 *
 * Deny takes precedence over ask throughout: a hard-rule violation
 * (an amend, an unattributed PR, a content-gate violation) is not a
 * judgment call the way a destructive command or an otherwise-clean
 * commit/PR/issue is, so it is refused outright rather than softened
 * into a question. Every guardian wired in here (history, commit, PR,
 * issue) never rewrites in its own pi-side review either, so "ask" is
 * a complete adapter for all of them — unlike a guardian that does
 * rewrite, which a hook can only approximate as deny-and-retry, these
 * map onto Claude Code's native permission prompt exactly as pi's own
 * allow/block confirmation does.
 */
async function runHookPreBash(): Promise<string> {
	const input = await readStdin();
	const payload = JSON.parse(input) as PreToolUseInput;
	const command = payload.tool_input?.command;
	if (payload.tool_name !== "Bash" || !command) return "";

	const cwd = effectiveCwd(tokenize(command), process.cwd());
	const resolvedCwd = "dir" in cwd ? cwd.dir : process.cwd();
	ensureAttributionHook(resolvedCwd);

	const denyReason =
		checkGitCli(command) ??
		checkGithubCli(command) ??
		checkAttribution(command);
	if (denyReason) return decisionOutput("deny", denyReason);

	const destructive = detectDestructiveCommand(command);
	if (destructive) return decisionOutput("ask", historyReason(destructive));

	const deps = fileGateDeps(resolvedCwd);
	const guardianResult =
		checkCommitGuardian(command, deps) ??
		(await checkPrGuardian(command, resolvedCwd, deps, processExec)) ??
		checkIssueGuardian(command, deps);
	if (guardianResult) {
		return decisionOutput(guardianResult.decision, guardianResult.reason);
	}

	return "";
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));

	if (options.domain === "tdd" && options.command === "attest") {
		process.stdout.write(
			`${JSON.stringify(await runTddAttest(options.stateFile))}\n`,
		);
		return;
	}
	if (options.domain === "tdd" && options.command === "status") {
		process.stdout.write(
			`${JSON.stringify(await runTddStatus(options.stateFile))}\n`,
		);
		return;
	}
	if (options.domain === "hook" && options.command === "pre-bash") {
		const output = await runHookPreBash();
		if (output) process.stdout.write(`${output}\n`);
		return;
	}
	if (options.domain === "verify" && options.command === "run") {
		const result = await runVerify({ cwd: process.cwd() });
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	if (options.domain === "quest") {
		const input = await readStdin();
		const params = input.trim().length > 0 ? JSON.parse(input) : {};
		const result = await runQuestAction(
			{
				action: options.command,
				stateFile: options.stateFile,
				questsRoot: options.questsRoot,
			},
			params,
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	if (options.domain === "notes") {
		const input = await readStdin();
		const params = input.trim().length > 0 ? JSON.parse(input) : {};
		const result = await runNotesAction(
			{ action: options.command, notesRoot: options.notesRoot },
			params,
		);
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	if (options.domain === "memory") {
		const handlers: Record<string, (input: string) => Promise<unknown>> = {
			retain: runMemoryRetain,
			recall: runMemoryRecall,
			reflect: runMemoryReflect,
			edit: runMemoryEdit,
		};
		const handler = handlers[options.command];
		if (handler) {
			const input = await readStdin();
			process.stdout.write(`${JSON.stringify(await handler(input))}\n`);
			return;
		}
	}
	if (options.domain === "web" && options.command === "check") {
		const result = await runWebCheck(await readStdin());
		process.stdout.write(`${JSON.stringify(result)}\n`);
		process.exitCode = result.ok ? 0 : 1;
		return;
	}
	if (options.domain === "slack-auth") {
		if (options.command === "status") {
			process.stdout.write(`${JSON.stringify(await runSlackAuthStatus())}\n`);
			return;
		}
		if (options.command === "login") {
			process.stdout.write(`${JSON.stringify(await runSlackAuthLogin())}\n`);
			return;
		}
	}

	throw new Error(`Unknown command: ${options.domain} ${options.command}`);
}

main().catch((error: unknown) => {
	process.stderr.write(
		`${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exitCode = 1;
});
