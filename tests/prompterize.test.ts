/**
 * The seam the Spec names: a real pi session that loads the extension, with a test provider
 * at the provider edge playing both the Fixer's model and the main model, under a temporary
 * HOME. A test types a prompt the way the Boss does and checks what the main model received;
 * it never reads inside the extension.
 *
 * pi in print mode calls session.prompt() without a source, and PromptOptions defaults that
 * source to "interactive", so a -p prompt is the typed prompt this Bead fixes (settled
 * 2026-11-18 with bd remember).
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "extensions", "prompterize.ts");
const testProvider = join(root, "tests", "fixtures", "prompterize-test-provider.ts");

/** The pi arguments both session modes share: no discovery, the extension, the test provider. */
const SHARED_ARGS = ["--no-session", "-ne", "-e", extension, "-e", testProvider, "--model", "prompterize-test/main"];

/** One request the test provider saw, as it wrote it to the log. */
type Request = {
	provider: string;
	model: string;
	reasoning: string | null;
	system: string;
	messages: string[];
};

/** One temporary Mac: a HOME, an agent folder, and the test provider's log. */
type Workspace = { dir: string; home: string; agentDir: string; log: string };

/** Every workspace this file made, removed once its tests are done. */
const workspaces: Workspace[] = [];

after(() => {
	for (const workspace of workspaces) rmSync(workspace.dir, { recursive: true, force: true });
});

/** A workspace whose agent folder holds the settings a test wants pi to read. */
function makeWorkspace(settings?: Record<string, unknown>): Workspace {
	const dir = mkdtempSync(join(tmpdir(), "pi-prompterize-"));
	const home = join(dir, "home");
	const agentDir = join(dir, "pi-agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	if (settings !== undefined) writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
	const workspace = { dir, home, agentDir, log: join(dir, "requests.jsonl") };
	workspaces.push(workspace);
	return workspace;
}

/** The environment a pi process runs in: a temporary HOME, the test provider's log, `extra`. */
const piEnv = (workspace: Workspace, extra: Record<string, string>): Record<string, string | undefined> => ({
	...process.env,
	HOME: workspace.home,
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
function runPi(workspace: Workspace, prompt: string, env: Record<string, string> = {}): PiOutput {
	const result = spawnSync("pi", [...SHARED_ARGS, "-p", prompt], {
		cwd: workspace.dir,
		encoding: "utf8",
		env: piEnv(workspace, env),
	});
	return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A pi session in RPC mode, given one prompt command and run until it settles. */
async function runRpc(workspace: Workspace, prompt: string, env: Record<string, string> = {}): Promise<PiOutput> {
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

test("a typed prompt starting with * reaches the main model with the * stripped and no Fixer call", () => {
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
});

test("a slash command reaches pi untouched and is not sent to the Fixer", () => {
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
});

test("a prompt from RPC is not sent to the Fixer", async () => {
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
});

test("a prompt sent by another extension is not sent to the Fixer", async () => {
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
	const workspace = makeWorkspace(settings);
	const run = runPi(workspace, "pleas fix teh bug in teh parser", {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	const fixer = reached(workspace, "opencode-go");
	assert.equal(fixer.length, 1);
	assert.equal(fixer[0].model, "flash", "the model named in the settings");
	assert.equal(fixer[0].reasoning, "high", "the thinking level named in the settings");
});

test("turning the Fixer off sends typed prompts to the main model unchanged", () => {
	const settings = { prompterize: { fixer: { enabled: false } } };
	const workspace = makeWorkspace(settings);
	const typed = "pleas fix teh bug in teh parser";
	const run = runPi(workspace, typed, {
		PROMPTERIZE_TEST_FIX: JSON.stringify({ text: "Please fix the bug in the parser.", changes: [] }),
	});
	assert.equal(run.status, 0, run.stderr);
	assert.equal(reached(workspace, "opencode-go").length, 0, "the Fixer was not called");
	const main = reached(workspace, "prompterize-test");
	assert.equal(main.length, 1);
	assert.equal(main[0].messages.at(-1), typed, "the main model received the prompt unchanged");
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
