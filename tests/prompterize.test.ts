/**
 * The seam the Spec names: a real pi session that loads the extension, with a test provider
 * at the provider edge playing both the Fixer's model and the main model, under a temporary
 * HOME. A test types a prompt the way the Boss does and checks what the main model received
 * and what the Correction log holds; it never reads inside the extension.
 *
 * pi in print mode calls session.prompt() without a source, and PromptOptions defaults that
 * source to "interactive", so a -p prompt is the typed prompt this Bead fixes (settled
 * 2026-11-18 with bd remember).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "prompterize.ts");
const testProvider = join(root, "tests", "fixtures", "prompterize-test-provider.ts");

/** The pi session id every test runs under, so a Correction log record's sessionId has a known value. */
const SESSION_ID = "prompterize-test-session";

/**
 * The pi arguments both session modes share: no discovery, the extension, the test provider, and
 * a session id the test knows.
 */
const SHARED_ARGS = [
	"--no-session",
	"--session-id",
	SESSION_ID,
	"-ne",
	"-e",
	extension,
	"-e",
	testProvider,
	"--model",
	"prompterize-test/main",
];

/** One request the test provider saw, as it wrote it to the log. */
type Request = {
	provider: string;
	model: string;
	reasoning: string | null;
	system: string;
	messages: string[];
};

/** A git repo a test runs pi in, with the facts the Correction log should record about it. */
type Repo = { path: string; remote: string; commit: string };

/**
 * One temporary Mac: a HOME, an agent folder, a data folder pi writes the Correction log under
 * (XDG_DATA_HOME), a git repo with one commit to run pi in, and the test provider's log.
 */
type Workspace = { dir: string; home: string; agentDir: string; data: string; log: string; repo: Repo };

/**
 * What a test sets up before pi runs: the settings pi reads, the repo's remote (null for none), and
 * the files git tracks besides README.md, which are the real names the Fixer may offer.
 */
type WorkspaceOptions = { settings?: Record<string, unknown>; remote?: string | null; files?: string[] };

/** The remote a temporary repo has unless its test says otherwise. */
const TEST_REMOTE = "https://example.com/boss/pi-prompterize-test.git";

/** Every workspace this file made, removed once its tests are done. */
const workspaces: Workspace[] = [];

after(() => {
	for (const workspace of workspaces) rmSync(workspace.dir, { recursive: true, force: true });
});

/** Run one git command in a test's repo and return its trimmed stdout, failing the test when git fails. */
function git(cwd: string, args: string[]): string {
	const result = spawnSync("git", args, { cwd, encoding: "utf8" });
	assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
	return result.stdout.trim();
}

/** A temporary Mac for one test: a HOME, an agent folder, a data folder, a git repo, and the test provider's log. */
function makeWorkspace(options: WorkspaceOptions = {}): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompterize-"));
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	const log = join(dir, "requests.jsonl");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	// The log exists, empty, from the start: a test reads it before any request is written, so a
	// missing file stays a fault instead of answering the same as no request.
	writeFileSync(log, "");
	if (options.settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(options.settings));
	writeFileSync(join(dir, "README.md"), "# a temporary repo\n");
	const tracked = ["README.md", ...(options.files ?? [])];
	for (const file of tracked.slice(1)) {
		mkdirSync(dirname(join(dir, file)), { recursive: true });
		writeFileSync(join(dir, file), "// a real file in the temporary repo\n");
	}
	git(dir, ["init", "--quiet", "--initial-branch=main"]);
	const remote = options.remote === undefined ? TEST_REMOTE : options.remote;
	if (remote !== null) git(dir, ["remote", "add", "origin", remote]);
	git(dir, ["add", ...tracked]);
	git(dir, [
		"-c",
		"user.name=prompterize test",
		"-c",
		"user.email=test@example.com",
		"commit",
		"--quiet",
		"-m",
		"the code as it was when the prompt was typed",
	]);
	const repo = {
		path: git(dir, ["rev-parse", "--show-toplevel"]),
		remote: remote ?? "",
		commit: git(dir, ["rev-parse", "HEAD"]),
	};
	const workspace = { dir, home, agentDir, data: join(dir, "data"), log, repo };
	workspaces.push(workspace);
	return workspace;
}

/**
 * The environment a pi process runs in: a temporary HOME and data folder, the test provider's
 * log, then `extra`. A test unsets XDG_DATA_HOME by passing it as undefined.
 */
const piEnv = (
	workspace: Workspace,
	extra: Record<string, string | undefined>,
): Record<string, string | undefined> => ({
	...process.env,
	HOME: workspace.home,
	XDG_DATA_HOME: workspace.data,
	PI_CODING_AGENT_DIR: workspace.agentDir,
	PI_SKIP_VERSION_CHECK: "1",
	PI_OFFLINE: "1",
	PI_TELEMETRY: "0",
	PROMPTERIZE_TEST_LOG: workspace.log,
	...extra,
});

/** What one pi process printed and how it exited. */
type PiOutput = { status: number | null; stdout: string; stderr: string };

/** A pi session in print mode with the extension, the test provider and one typed prompt. */
function runPi(workspace: Workspace, prompt: string, env: Record<string, string | undefined> = {}): PiOutput {
	const result = spawnSync("pi", [...SHARED_ARGS, "-p", prompt], {
		cwd: workspace.dir,
		encoding: "utf8",
		env: piEnv(workspace, env),
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A pi session in RPC mode, given one prompt command and run until it settles. */
async function runRpc(
	workspace: Workspace,
	prompt: string,
	env: Record<string, string | undefined> = {},
): Promise<PiOutput> {
	return new Promise((resolve, reject) => {
		const child = spawn("pi", ["--mode", "rpc", ...SHARED_ARGS], {
			cwd: workspace.dir,
			env: piEnv(workspace, env),
		});
		let stdout = "";
		let stderr = "";
		let buffer = "";
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(new Error(`the RPC session did not settle: ${stderr}`));
		}, 30_000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
			buffer += chunk;
			let newline: number;
			while ((newline = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (!line.trim()) continue;
				let record: { type?: string };
				try {
					record = JSON.parse(line) as { type?: string };
				} catch {
					continue;
				}
				if (record.type === "agent_settled" && !settled) {
					settled = true;
					child.stdin.end();
				}
			}
		});
		child.stderr.setEncoding("utf8");
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (status) => {
			clearTimeout(timer);
			if (!settled) {
				reject(new Error(`the RPC session closed before it settled: ${stderr}`));
				return;
			}
			resolve({ status, stdout, stderr });
		});
		child.stdin.write(`${JSON.stringify({ id: "1", type: "prompt", message: prompt })}\n`);
	});
}

/** Every request the test provider wrote, in order. */
function requests(workspace: Workspace): Request[] {
	return readFileSync(workspace.log, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Request);
}

/** The requests that reached one provider, which stands for one of the two models. */
const reached = (workspace: Workspace, provider: string): Request[] =>
	requests(workspace).filter((request) => request.provider === provider);

/** The placeholders one text carries, in the order they appear. */
const placeholdersIn = (text: string): string[] => text.match(/⟦prompterize:[0-9a-f]+:\d+⟧/g) ?? [];

/** One Fixer record, as the Bead names its fields. */
type FixerRecord = {
	id: string;
	time: string;
	sessionId: string;
	repoPath: string;
	remote: string;
	commit: string;
	model: string;
	thinkingLevel: string;
	durationMs: number;
	outcome: string;
	original: string;
	fixed: string;
	changes: ({ from: string; to: string } | { word: string; possibly: string[] })[];
	error?: string;
};

/** Where a test's Correction log lives: under the data folder piEnv hands pi as XDG_DATA_HOME. */
const correctionLog = (workspace: Workspace): string => join(workspace.data, "pi-prompterize", "corrections.jsonl");

/** Every record in the Correction log at `path`, in the order it was written. */
function correctionRecords(path: string): FixerRecord[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as FixerRecord);
}

test("a typed prompt with typos reaches the main model as the Fixer's fixed text, with no note of what changed", () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug in teh parser";
	const fixed = "Please fix the bug in the parser.";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({
			text: fixed,
			changes: [
				{ from: "pleas", to: "Please" },
				{ from: "teh", to: "the" },
			],
		}),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	assert.equal(fixer[0].messages.at(-1), typed, "the Fixer saw the words the Boss typed");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), fixed, "the main model received the fixed text and nothing else");
});

test("a typed prompt carries the Clarity note, which tells the main agent when to act and when to ask", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, "pleas fix teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	const request = main[0].system;
	assert.match(request, /clear enough to act on/i, "the note asks the agent to judge the prompt's clarity");
	assert.match(request, /proceed at once/i, "a clear prompt is acted on at once");
	assert.match(request, /context makes the intent plain/i, "context can make the intent plain");
	assert.match(request, /look up what you can/i, "the agent looks things up for itself first");
	assert.match(request, /one Question round/i, "an unclear prompt gets one Question round");
	assert.match(request, /numbered questions/i, "the Question round is numbered, as the grilling skill formats it");
	assert.match(request, /suggested answer/i, "each question carries a suggested answer");
	assert.match(request, /"yes"/, "yes accepts the suggested answers");
	assert.match(request, /wait for the answer/i, "the agent waits for the answer before working");
	assert.match(request, /whole new feature or project/i, "a whole new feature or project is told apart");
	assert.match(request, /grilling skill in full/i, "a whole new feature or project gets the full grilling skill");
});

test("a typed prompt starting with * reaches the main model with the * stripped and no Fixer call or Clarity note", () => {
	const workspace = makeWorkspace();
	const typed = "*pleas fix teh bug in teh parser";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed.slice(1), "the main model received the prompt without its *");
	assert.doesNotMatch(main[0].system, /Clarity note/i, "a skipped prompt carries no Clarity note");
});

test("a slash command reaches pi untouched, with no Fixer call and no Clarity note", () => {
	const workspace = makeWorkspace();
	const typed = "/model opencode-go/deepseek-v4.1-flash";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "fixed", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the command exactly as typed");
	assert.doesNotMatch(main[0].system, /Clarity note/i, "a slash command carries no Clarity note");
});

test("a prompt from RPC is not sent to the Fixer and carries no Clarity note", async () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug from rpc";
	const run = await runRpc(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug from RPC.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the prompt exactly as RPC sent it");
	assert.doesNotMatch(main[0].system, /Clarity note/i, "a prompt from RPC carries no Clarity note");
});

test("a prompt sent by another extension is not sent to the Fixer and carries no Clarity note", async () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug from an extension";
	const run = await runRpc(workspace, "/prompterize-test-extension", {
		PROMPTERIZE_TEST_EXTENSION_TEXT: typed,
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug from an extension.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the extension's prompt unchanged");
	assert.doesNotMatch(main[0].system, /Clarity note/i, "a prompt from another extension carries no Clarity note");
});

test("when the Fixer's model call fails, the prompt reaches the main model unchanged", () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug in teh parser";
	const run = runPi(workspace, typed, { PROMPTERIZE_TEST_FIX_FAILURE: "the Fixer's model is down" });
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 1, "the Fixer tried its model");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the prompt unchanged");
});

test("the Fixer uses opencode-go/deepseek-v4.1-flash at low thinking by default", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1);
	assert.equal(fixer[0].model, "deepseek-v4.1-flash", "the default Fixer model");
	assert.equal(fixer[0].reasoning, "low", "the default thinking level");
});

test("the Fixer's model and thinking level come from the prompterize settings", () => {
	const settings = { prompterize: { fixer: { model: "opencode-go/flash", thinkingLevel: "high" } } };
	const workspace = makeWorkspace({ settings });
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1);
	assert.equal(fixer[0].model, "flash", "the model named in the settings");
	assert.equal(fixer[0].reasoning, "high", "the thinking level named in the settings");
});

test("turning the Fixer off sends typed prompts to the main model unchanged, with the Clarity note still on", () => {
	const settings = { prompterize: { fixer: { enabled: false } } };
	const workspace = makeWorkspace({ settings });
	const typed = "pleas fix teh bug in teh parser";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the prompt unchanged");
	assert.match(main[0].system, /Clarity note/i, "the Clarity note is still on when the Fixer is off");
});

test("turning the Clarity note off leaves the Fixer fixing typed prompts", () => {
	const settings = { prompterize: { clarity: { enabled: false } } };
	const workspace = makeWorkspace({ settings });
	const typed = "pleas fix teh bug in teh parser";
	const fixed = "Please fix the bug in the parser.";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: fixed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 1, "the Fixer still ran");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), fixed, "the main model received the fixed text");
	assert.doesNotMatch(main[0].system, /Clarity note/i, "the Clarity note was turned off");
});

test("the Fixer's instructions tell its model to fix typos and change nothing else", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1);
	assert.match(fixer[0].system, /fix.*typos/i);
	assert.match(fixer[0].system, /change nothing else/i);
	assert.match(fixer[0].system, /do not reword/i);
	assert.match(fixer[0].system, /add content/i);
	assert.equal(fixer[0].messages.at(-1), "pleas fix teh bug in teh parser", "the model saw the prompt as typed");
});

/**
 * A typed prompt with one of each protected span. The typo "teh" sits inside every span as well as
 * outside them, so a Fixer that saw a span would change it; only the two typos outside may change.
 */
const typedWithProtectedSpans = [
	"pleas fix teh build in the parser",
	"",
	"Use `tehConfig` and mind the fence:",
	"",
	"```ts",
	"const teh = 1;",
	"```",
	"",
	"> teh quoted complaint, kept as it was",
	"",
	"Read https://example.com/docs/teh-config and @src/teh-config.ts first.",
].join("\n");

/** The same prompt with its two typos outside the spans fixed, and every span byte for byte as typed. */
const fixedWithProtectedSpans = [
	"Please fix the build in the parser",
	"",
	"Use `tehConfig` and mind the fence:",
	"",
	"```ts",
	"const teh = 1;",
	"```",
	"",
	"> teh quoted complaint, kept as it was",
	"",
	"Read https://example.com/docs/teh-config and @src/teh-config.ts first.",
].join("\n");

/** The two fixes the test's Fixer model makes, as the from/to pairs it reports back. */
const protectedSpanFixes = JSON.stringify([
	{ from: "pleas", to: "Please" },
	{ from: "teh", to: "the" },
]);

test("code fences, inline code, blockquote lines, URLs and @ references reach the main model byte for byte, while typos around them are fixed", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, typedWithProtectedSpans, {
		PROMPTERIZE_TEST_FIX_SUBSTITUTIONS: protectedSpanFixes,
	});
	assert.equal(run.status, 0, run.stderr);
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), fixedWithProtectedSpans);
});

test("a fixed prompt appends one Fixer record to the Correction log under XDG_DATA_HOME", () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug in teh parser";
	const fixed = "Please fix the bug in the parser.";
	const changes = [
		{ from: "pleas", to: "Please" },
		{ from: "teh", to: "the" },
	];
	const before = Date.now();
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: fixed, changes }),
		PROMPTERIZE_TEST_FIX_DELAY_MS: "50",
	});
	const after = Date.now();
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1, "the run wrote one line, one Fixer record");
	const record = records[0];
	assert.equal(record.outcome, "fixed");
	assert.equal(record.original, typed, "the text as the Boss typed it");
	assert.equal(record.fixed, fixed, "the text the main model received");
	assert.deepEqual(record.changes, changes, "each change the Fixer made, as a from/to pair");
	assert.equal(record.sessionId, SESSION_ID);
	assert.equal(record.repoPath, workspace.repo.path);
	assert.equal(record.remote, workspace.repo.remote);
	assert.equal(record.commit, workspace.repo.commit);
	assert.equal(record.model, "opencode-go/deepseek-v4.1-flash");
	assert.equal(record.thinkingLevel, "low");
	assert.match(
		record.id,
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		"the record's id is a UUID",
	);
	assert.ok(record.durationMs >= 50, `the Fixer call took the 50ms the test provider delayed: ${record.durationMs}`);
	assert.ok(
		Date.parse(record.time) >= before && Date.parse(record.time) <= after,
		`the time is when the prompt was typed: ${record.time}`,
	);
	assert.equal(record.error, undefined, "a fixed run has no error");
});

test("a prompt the Fixer left as it was is logged with outcome unchanged", () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug in teh parser";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: typed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "unchanged");
	assert.equal(records[0].fixed, typed, "the text the main model received is the text as typed");
});

test("each Fixer run appends its own line, so the log keeps every run in order", () => {
	const workspace = makeWorkspace();
	const first = runPi(workspace, "pleas fix teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the parser.", changes: [] }),
	});
	assert.equal(first.status, 0, first.stderr);
	const second = runPi(workspace, "pleas fix teh reader", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the reader.", changes: [] }),
	});
	assert.equal(second.status, 0, second.stderr);
	const records = correctionRecords(correctionLog(workspace));
	const originals = records.map((record) => record.original);
	assert.deepEqual(originals, ["pleas fix teh parser", "pleas fix teh reader"]);
});

test("a failed Fixer call is logged with outcome error and the error's message", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX_FAILURE: "the Fixer's model is down",
	});
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "error");
	assert.equal(records[0].error, "the Fixer's model is down");
});

test("the Correction log falls back to ~/.local/share when XDG_DATA_HOME is unset", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		XDG_DATA_HOME: undefined,
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(join(workspace.home, ".local", "share", "pi-prompterize", "corrections.jsonl"));
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "fixed");
});

test("a skipped prompt and a slash command are not logged", () => {
	const workspace = makeWorkspace();
	const skipped = runPi(workspace, "*pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(skipped.status, 0, skipped.stderr);
	const command = runPi(workspace, "/model prompterize-test/main", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(command.status, 0, command.stderr);
	assert.equal(existsSync(correctionLog(workspace)), false, "neither prompt wrote a Fixer record");
});

test("a repo with no git remote logs the remote as empty and lets the fixed prompt through", () => {
	const workspace = makeWorkspace({ remote: null });
	const fixed = "Please fix the bug in the parser.";
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: fixed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1);
	assert.equal(records[0].remote, "");
	assert.equal(records[0].commit, workspace.repo.commit, "the commit is still recorded");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.at(-1)?.messages.at(-1), fixed, "the fixed prompt still reached the main model");
});

test("a Correction log that cannot be written leaves the prompt to go on", () => {
	const workspace = makeWorkspace();
	const blocked = join(workspace.dir, "blocked-data-home");
	writeFileSync(blocked, "a file where the data home's folder should be\n");
	const fixed = "Please fix the bug in the parser.";
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		XDG_DATA_HOME: blocked,
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: fixed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(existsSync(join(blocked, "pi-prompterize")), false, "the log could not be written");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.at(-1)?.messages.at(-1), fixed, "the fixed prompt still reached the main model");
});

test("the Fixer's model sees a placeholder in place of each protected span and never the span itself", () => {
	const workspace = makeWorkspace();
	const run = runPi(workspace, typedWithProtectedSpans, {
		PROMPTERIZE_TEST_FIX_SUBSTITUTIONS: protectedSpanFixes,
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	const request = fixer[0].messages.at(-1) ?? "";
	const spans = [
		"`tehConfig`",
		["```ts", "const teh = 1;", "```"].join("\n"),
		"> teh quoted complaint, kept as it was",
		"https://example.com/docs/teh-config",
		"@src/teh-config.ts",
	];
	for (const span of spans) {
		assert.equal(request.includes(span), false, `the Fixer's model did not see ${JSON.stringify(span)}`);
	}
	assert.equal(placeholdersIn(request).length, spans.length, "each span became its own placeholder");
});

test("each request gets placeholders of its own, so a reply can only ever answer the prompt it was made for", () => {
	const workspace = makeWorkspace();
	const first = runPi(workspace, typedWithProtectedSpans, { PROMPTERIZE_TEST_FIX_SUBSTITUTIONS: protectedSpanFixes });
	assert.equal(first.status, 0, first.stderr);
	const second = runPi(workspace, typedWithProtectedSpans, { PROMPTERIZE_TEST_FIX_SUBSTITUTIONS: protectedSpanFixes });
	assert.equal(second.status, 0, second.stderr);
	const placeholders = reached(workspace, "opencode-go").map((request) => placeholdersIn(request.messages.at(-1) ?? ""));
	assert.equal(placeholders.length, 2, "both prompts reached the Fixer's model");
	assert.notDeepEqual(placeholders[0], placeholders[1], "the placeholders differ from one request to the next");
});

/** The ways a Fixer reply can mishandle a placeholder, each with the word a test name uses for it. */
const placeholderMishandlings = [
	{ mutation: "drop", verb: "drops" },
	{ mutation: "change", verb: "changes" },
	{ mutation: "duplicate", verb: "duplicates" },
	{ mutation: "add", verb: "adds" },
] as const;

for (const { mutation, verb } of placeholderMishandlings) {
	test(`a Fixer reply that ${verb} a placeholder is rejected, so the prompt goes on as typed and the Correction log records error`, () => {
		const workspace = makeWorkspace();
		const run = runPi(workspace, typedWithProtectedSpans, {
			PROMPTERIZE_TEST_FIX_PLACEHOLDER_MUTATION: mutation,
		});
		assert.equal(run.status, 0, run.stderr);
		const main = reached(workspace, "prompterize-test");
		assert.equal(main.length, 1, "the prompt reached the main model once");
		assert.equal(main[0].messages.at(-1), typedWithProtectedSpans, "the main model received the prompt exactly as typed");
		const records = correctionRecords(correctionLog(workspace));
		assert.equal(records.length, 1, "the rejected run was logged");
		assert.equal(records[0].outcome, "error", "a rejected reply is an error outcome");
		assert.match(records[0].error ?? "", /placeholder/i, "the record says a placeholder was mishandled");
	});
}

/**
 * The real-name tests: the same pi session seam, in a repo whose tracked files are the real names
 * the Fixer may offer its model. A test reads what the Fixer's model was sent and what the main
 * model received, never how the lookup is built.
 */

/** The lines of a Fixer request's system prompt that carry `word` beside `name`, so a test can see the pair without fixing the section's format. */
const linesBeside = (system: string, word: string, name: string): string[] =>
	system.split("\n").filter((line) => line.includes(word) && line.includes(name));

test("matching real names ignores case, underscores, hyphens and dots and tolerates small spelling errors", () => {
	const workspace = makeWorkspace({ files: ["src/auth-session.ts"] });
	const typed = "fix authsession, Auth.Session, auth_sesion and src/auth-sesion.ts please";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: typed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	// Each word is close to src/auth-session.ts once case and separators are ignored and one letter
	// is allowed to be wrong: authsession has no separators at all, Auth.Session carries a dot and
	// capitals, auth_sesion an underscore and a missing s, and src/auth-sesion.ts a missing s.
	for (const word of ["authsession", "Auth.Session", "auth_sesion", "src/auth-sesion.ts"]) {
		assert.equal(
			linesBeside(fixer[0].system, word, "src/auth-session.ts").length,
			1,
			`the Fixer's model saw ${word} beside the real name src/auth-session.ts`,
		);
	}
});

test("the Fixer's model request carries only the close real names, never the whole file list and never the conversation", () => {
	const files = ["src/auth-session.ts", "src/unrelated-widget.ts", "docs/notes.md"];
	const workspace = makeWorkspace({ files });
	const typed = "fix the authsession check";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "fix the auth-session.ts check", changes: [{ from: "authsession", to: "auth-session.ts" }] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	assert.equal(linesBeside(fixer[0].system, "authsession", "src/auth-session.ts").length, 1, "the close real name is given to the Fixer's model");
	for (const name of ["README.md", ...files]) {
		if (name === "src/auth-session.ts") continue;
		assert.equal(fixer[0].system.includes(name), false, `a real name no typed word is close to stays out of the request: ${name}`);
	}
	assert.deepEqual(fixer[0].messages, [typed], "the request carries the typed prompt and no conversation");
});

test("a misspelled file path in a typed prompt reaches the main model as the real tracked path", () => {
	const workspace = makeWorkspace({ files: ["src/auth-session.ts", "src/parser.ts"] });
	const typed = "pleas fix the bug in src/auth-sesion.ts";
	const fixed = "Please fix the bug in src/auth-session.ts";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({
			text: fixed,
			changes: [
				{ from: "pleas", to: "Please" },
				{ from: "src/auth-sesion.ts", to: "src/auth-session.ts" },
			],
		}),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	assert.equal(
		linesBeside(fixer[0].system, "src/auth-sesion.ts", "src/auth-session.ts").length,
		1,
		"the tracked path is given to the Fixer's model as the real name for the misspelled one",
	);
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), fixed, "the main model received the real tracked path");
});

/** The two real names a word with no confident match is close to, as the test's Fixer model names them. */
const closeAuthNames = ["src/auth-session.ts", "src/auth-sessions.ts"];

test("a word with several close matches and no confident one reaches the main model unchanged and followed by a possibly hint", () => {
	const workspace = makeWorkspace({ files: closeAuthNames });
	const typed = "check the authsesion flow";
	const hinted = "check the authsesion (possibly src/auth-session.ts or src/auth-sessions.ts) flow";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({
			text: hinted,
			changes: [{ word: "authsesion", possibly: closeAuthNames }],
		}),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	for (const name of closeAuthNames) {
		assert.equal(linesBeside(fixer[0].system, "authsesion", name).length, 1, `the Fixer's model saw ${name} beside the word it may be close to`);
	}
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), hinted, "the word stays as typed, followed by the possibly hint");
	assert.match(main[0].messages.at(-1) ?? "", /\(possibly src\/auth-session\.ts or src\/auth-sessions\.ts\)/, "the hint uses the word possibly and names the close matches");
	assert.doesNotMatch(main[0].messages.at(-1) ?? "", /likely/i, "the hint never says likely");
});

test("each change and each possibly hint, with its matches, appears in the Fixer record's list of changes", () => {
	const workspace = makeWorkspace({ files: closeAuthNames });
	const typed = "pleas check the authsesion flow";
	const changes = [
		{ from: "pleas", to: "Please" },
		{ word: "authsesion", possibly: closeAuthNames },
	];
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({
			text: "Please check the authsesion (possibly src/auth-session.ts or src/auth-sessions.ts) flow",
			changes,
		}),
	});
	assert.equal(run.status, 0, run.stderr);
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1, "the run wrote one Fixer record");
	assert.equal(records[0].outcome, "fixed");
	assert.deepEqual(records[0].changes, changes, "the record holds the typo fix and the possibly hint with its matches");
});

test("the Fixer's instructions tell its model to map a confidently meant word to its real name and otherwise to use a possibly hint, never likely", () => {
	const workspace = makeWorkspace({ files: ["src/auth-session.ts"] });
	const typed = "check the authsession flow";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: typed, changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1, "the typed prompt reached the Fixer's model");
	const system = fixer[0].system;
	assert.match(system, /replace the word with that real name/i, "a confident match is mapped to the real name");
	assert.match(system, /no given real name is a confident match/i, "the model decides confidence, and the instructions name it");
	assert.match(system, /keep the word exactly as typed/i, "an unconfident word stays as typed");
	assert.match(system, /possibly/i, "the hint uses the word possibly");
	assert.match(system, /never "likely"/i, "the instructions forbid likely");
});

/**
 * The tests above drive pi as a `pi -p` subprocess. The status line and Esc need the interactive
 * TUI, which a print-mode subprocess has no terminal for. The tests below run a real pi session
 * in-process through pi's SDK, with a stand-in at pi's UI edge: it records the statuses the
 * interactive footer would show and hands keys to the extension the way the TUI's raw input
 * listener does. The provider fixture stays at the provider edge, exactly as above, so the checks
 * still read what each model received and what the Correction log holds.
 *
 * The stand-in passes "\x1b", the bytes pi's TUI hands an extension when the Boss presses Esc, so
 * these tests drive Esc itself; no manual interactive check is needed.
 */

/** The slice of pi's SDK the in-process tests use. */
type PiSdk = {
	createAgentSession(options: Record<string, unknown>): Promise<{ session: SdkSession }>;
	DefaultResourceLoader: new (options: Record<string, unknown>) => {
		reload(): Promise<void>;
		getExtensions(): { errors: unknown[] };
	};
	SessionManager: { inMemory(cwd: string): unknown };
	SettingsManager: { create(cwd: string, agentDir: string): unknown };
};

/** The session operations the in-process tests use. */
type SdkSession = {
	bindExtensions(bindings: { uiContext: unknown; mode: string }): Promise<void>;
	prompt(text: string): Promise<void>;
	dispose(): void;
};

/** The installed pi package, found from the `pi` binary on PATH, so the tests use the same pi as the CLI. */
function piPackageRoot(): string {
	const bin = (process.env.PATH ?? "")
		.split(delimiter)
		.map((directory) => join(directory, "pi"))
		.find((path) => existsSync(path));
	if (bin === undefined) throw new Error("pi is not on PATH");
	for (let directory = dirname(realpathSync(bin)); ; directory = dirname(directory)) {
		const manifest = join(directory, "package.json");
		if (existsSync(manifest)) {
			const { name } = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
			if (name === "@earendil-works/pi-coding-agent") return directory;
		}
		if (dirname(directory) === directory) throw new Error(`the package that holds ${bin} is not on disk`);
	}
}

/** pi's SDK, loaded once from the installed package. */
let piSdk: Promise<PiSdk> | undefined;
const loadPiSdk = (): Promise<PiSdk> =>
	(piSdk ??= import(pathToFileURL(join(piPackageRoot(), "dist", "index.js")).href).then((module) => module as PiSdk));

/** The main model the in-process session runs, as the test provider registers it. */
const MAIN_MODEL = {
	id: "main",
	name: "main",
	api: "prompterize-test",
	provider: "prompterize-test",
	baseUrl: "http://localhost:0",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
};

/** One status the TUI was asked to show. */
type StatusChange = { key: string; text: string | undefined };

/** pi's UI port as a test sees it: the statuses the footer would show, and the keys the editor receives. */
type TestTui = {
	statuses: StatusChange[];
	ui: Record<string, unknown>;
	/** Hand a key to pi's terminal input listeners, as the TUI does. */
	press(data: string): void;
};

/** The TUI stand-in: it records status changes and lets a test press a key. */
function makeTestTui(): TestTui {
	const statuses: StatusChange[] = [];
	const inputHandlers = new Set<(data: string) => { consume?: boolean } | undefined>();
	const ui: Record<string, unknown> = {
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		notify: () => {},
		onTerminalInput(handler: (data: string) => { consume?: boolean } | undefined) {
			inputHandlers.add(handler);
			return () => inputHandlers.delete(handler);
		},
		setStatus(key: string, text: string | undefined) {
			statuses.push({ key, text });
		},
		setWorkingMessage: () => {},
		setWorkingVisible: () => {},
		setWorkingIndicator: () => {},
		setHiddenThinkingLabel: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async () => undefined,
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		getEditorComponent: () => undefined,
		theme: {},
		getAllThemes: () => [],
		getTheme: () => undefined,
		setTheme: () => ({ success: false, error: "no theme in the test's UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
	return {
		statuses,
		ui,
		press(data) {
			for (const handler of [...inputHandlers]) handler(data);
		},
	};
}

/** Wait for something a session does in the background, failing the test rather than hanging forever. */
async function waitFor(condition: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

/** What a test sets beyond the workspace: the extension's environment, and work to do while the Fixer runs. */
type InteractiveOptions = {
	env?: Record<string, string | undefined>;
	duringFixer?: (tui: TestTui) => Promise<void> | void;
};

/**
 * Run one typed prompt through a real pi session in-process, with the TUI stand-in at the UI edge.
 * The environment is swapped for the session's duration and restored afterwards, so each test
 * starts clean even though the process is shared.
 */
async function runInteractiveSession(
	workspace: Workspace,
	typed: string,
	options: InteractiveOptions = {},
): Promise<TestTui> {
	const savedEnvironment = { ...process.env };
	for (const [key, value] of Object.entries(piEnv(workspace, options.env ?? {}))) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	const tui = makeTestTui();
	let session: SdkSession | undefined;
	try {
		const sdk = await loadPiSdk();
		const loader = new sdk.DefaultResourceLoader({
			cwd: workspace.dir,
			agentDir: workspace.agentDir,
			additionalExtensionPaths: [extension, testProvider],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, [], "the extension and test provider loaded");
		session = (
			await sdk.createAgentSession({
				cwd: workspace.dir,
				agentDir: workspace.agentDir,
				model: MAIN_MODEL,
				resourceLoader: loader,
				sessionManager: sdk.SessionManager.inMemory(workspace.dir),
				settingsManager: sdk.SettingsManager.create(workspace.dir, workspace.agentDir),
			})
		).session;
		await session.bindExtensions({ uiContext: tui.ui, mode: "tui" });
		const prompt = session.prompt(typed);
		if (options.duringFixer !== undefined) {
			await waitFor(() => reached(workspace, "opencode-go").length === 1, "the Fixer's model request");
			await options.duringFixer(tui);
		}
		await prompt;
	} finally {
		session?.dispose();
		for (const key of Object.keys(process.env)) {
			if (!(key in savedEnvironment)) delete process.env[key];
		}
		Object.assign(process.env, savedEnvironment);
	}
	return tui;
}

test("pi shows the fixing prompt… status while the Fixer's model call runs and clears it when the call succeeds", async () => {
	const workspace = makeWorkspace();
	const tui = await runInteractiveSession(workspace, "pleas fix teh bug in teh parser", {
		env: {
			PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
			PROMPTERIZE_TEST_FIX_DELAY_MS: "150",
		},
		duringFixer: (running) => {
			assert.equal(reached(workspace, "opencode-go").length, 1, "the Fixer's model was asked while the status showed");
			assert.deepEqual(
				running.statuses,
				[{ key: "prompterize", text: "fixing prompt…" }],
				"the status showed before the model's reply and had not yet been cleared",
			);
		},
	});
	assert.deepEqual(
		tui.statuses,
		[
			{ key: "prompterize", text: "fixing prompt…" },
			{ key: "prompterize", text: undefined },
		],
		"the status was cleared once the call ended",
	);
});

test("pi clears the fixing prompt… status when the Fixer's model call fails", async () => {
	const workspace = makeWorkspace();
	const tui = await runInteractiveSession(workspace, "pleas fix teh bug in teh parser", {
		env: {
			PROMPTERIZE_TEST_FIX_FAILURE: "the Fixer's model is down",
			PROMPTERIZE_TEST_FIX_DELAY_MS: "100",
		},
		duringFixer: (running) => {
			assert.equal(running.statuses.at(-1)?.text, "fixing prompt…", "the status is shown while the failing call runs");
		},
	});
	assert.deepEqual(tui.statuses.map(({ text }) => text), ["fixing prompt…", undefined], "the status was cleared after the failure");
});

test("pi clears the fixing prompt… status when Esc cancels the Fixer's model call", async () => {
	const workspace = makeWorkspace();
	const tui = await runInteractiveSession(workspace, "pleas fix teh bug in teh parser", {
		env: {
			PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
			PROMPTERIZE_TEST_FIX_DELAY_MS: "2000",
		},
		duringFixer: (running) => {
			assert.equal(running.statuses.at(-1)?.text, "fixing prompt…", "the status is shown while the call runs");
			running.press("\x1b");
		},
	});
	assert.deepEqual(tui.statuses.map(({ text }) => text), ["fixing prompt…", undefined], "the status was cleared after the cancellation");
});

test("Esc during the Fixer's model call sends the original prompt to the main model and the Correction log records cancelled with the time waited", async () => {
	const workspace = makeWorkspace();
	const typed = "pleas fix teh bug in teh parser";
	await runInteractiveSession(workspace, typed, {
		env: {
			PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
			PROMPTERIZE_TEST_FIX_DELAY_MS: "2000",
		},
		duringFixer: async (running) => {
			await new Promise((resolve) => setTimeout(resolve, 200));
			running.press("\x1b");
		},
	});
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1, "the prompt reached the main model once");
	assert.equal(main[0].messages.at(-1), typed, "the main model received the prompt exactly as typed");
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1, "the cancelled run wrote one Fixer record");
	assert.equal(records[0].outcome, "cancelled");
	assert.equal(records[0].original, typed);
	assert.equal(records[0].fixed, typed, "the log holds the text the main model received");
	assert.deepEqual(records[0].changes, []);
	assert.equal(records[0].error, undefined);
	assert.ok(records[0].durationMs >= 200, `the log records the time waited: ${records[0].durationMs}ms`);
});

test("a Fixer call longer than three seconds is still waited for, and its fix reaches the main model", async () => {
	const workspace = makeWorkspace();
	const fixed = "Please fix the bug in the parser.";
	await runInteractiveSession(workspace, "pleas fix teh bug in teh parser", {
		env: {
			PROMPTERIZE_TEST_FIX: JSON.stringify({ text: fixed, changes: [] }),
			PROMPTERIZE_TEST_FIX_DELAY_MS: "3200",
		},
	});
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.at(-1)?.messages.at(-1), fixed, "the main model received the fix from the slow call");
	const records = correctionRecords(correctionLog(workspace));
	assert.equal(records.length, 1);
	assert.equal(records[0].outcome, "fixed");
	assert.ok(records[0].durationMs >= 3000, `the slow call was waited for: ${records[0].durationMs}ms`);
});
