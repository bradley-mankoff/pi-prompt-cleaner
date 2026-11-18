/**
 * pi-prompterize: the Fixer sends each typed prompt to a cheap, fast model that fixes its
 * typos before the main agent reads it. The Boss's words are the only thing that changes;
 * nothing is added to the prompt to say what changed.
 *
 * A typed prompt that was not skipped also gets the Clarity note in its run's system prompt,
 * so the main agent knows to act at once on a clear prompt and to ask one Question round
 * when it is unclear.
 *
 * Each Fixer run also goes to the Correction log, one JSONL file outside every repo, for a
 * later, smarter model to study the Boss's typing. The log is a study aid: when it cannot be
 * written, the prompt still goes on.
 *
 * The seam is the real pi session (see tests/prompterize.test.ts): this file wires pi's
 * `input` and `before_agent_start` events to the Fixer and the Clarity note, and the Fixer
 * speaks to its model through `ctx.modelRegistry.streamSimple()`, so pi's own credentials
 * are used.
 */
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

/** The thinking levels pi offers, as the prompterize settings accept them. */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What pi's settings.json holds under the prompterize key. */
type PrompterizeSettings = {
	fixer?: { enabled?: boolean; model?: string; thinkingLevel?: string };
	clarity?: { enabled?: boolean };
};

/**
 * pi's effective settings as `pi.getSettings()` returns them. The alias exists because pi's
 * own `Settings` type does not name the `prompterize` key and is not exported from the package.
 */
type PiSettings = ReturnType<ExtensionAPI["getSettings"]>;

/** The Fixer's resolved settings, after defaults and validation. */
type FixerSettings = { enabled: boolean; model: string; thinkingLevel: ThinkingLevel };

const DEFAULT_FIXER: FixerSettings = {
	enabled: true,
	model: "opencode-go/deepseek-v4.1-flash",
	thinkingLevel: "low",
};

/**
 * The Clarity note, adapted from severity1's claude-code-prompt-improver evaluation wrapper.
 *
 * MIT License
 *
 * Copyright (c) 2025 severity1
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * The note goes into the system prompt of a run started by a typed prompt that was not
 * skipped. It asks the main agent to judge the prompt before acting, to look things up for
 * itself, and to ask one Question round in the grilling skill's format when the prompt is
 * unclear. A clear prompt costs one judgement and no question.
 */
const CLARITY_NOTE = `Clarity note: before acting, judge whether this prompt is clear enough to act on.

- If it is clear, or the context makes the intent plain, proceed at once and do the work. Do not ask anything.
- If it is not clear, first look up what you can find for yourself: the code, the docs, the Beads and the conversation so far. Then ask exactly one Question round in the grilling skill's format: numbered questions, each with a suggested answer, worded so "yes" accepts every suggestion. Wait for the answer before working. Ask only what the Boss alone can answer.
- If the prompt starts a whole new feature or project, run the grilling skill in full instead of a single Question round.

Do not add or call a tool for this; ask the questions in your reply.`;

/** One replacement the Fixer made, kept for the Correction log. */
type FixerChange = { from: string; to: string };

/** What the Fixer's model replies with: the prompt after fixing, and each change it made. */
type FixerReply = { text: string; changes: FixerChange[] };

/** How a Fixer run ended, as the Correction log records it. */
type FixerOutcome = "fixed" | "unchanged" | "error" | "cancelled";

/** One Fixer run: when it started, how long its model call took, and what came of it. */
type FixerRun = {
	/** When the Boss's prompt arrived, ISO 8601. */
	time: string;
	/** How long the Fixer's model call took, in milliseconds. */
	durationMs: number;
	outcome: FixerOutcome;
	/** The text the prompt goes on as: the reply's, or the prompt as typed when the run failed. */
	fixed: string;
	changes: FixerChange[];
	error?: string;
};

/**
 * One Fixer run as the Correction log keeps it: the run itself, plus where and with what it
 * ran and the text it started from.
 */
type FixerRecord = FixerRun & {
	id: string;
	sessionId: string;
	repoPath: string;
	remote: string;
	commit: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	original: string;
};

const INSTRUCTIONS = `You are the Fixer in pi-prompterize. Fix the spelling mistakes in the user's prompt.

Rules:
- Fix typos and change nothing else. Do not reword, reorder, shorten, expand or add content.
- Keep the user's meaning, language, punctuation, capitalisation and layout as they are apart from the typos.
- Reply with JSON only, with no code fence and no explanation, in exactly this shape:
{"text":"<the prompt with its typos fixed>","changes":[{"from":"<the text as typed>","to":"<the text after fixing>"}]}
- The changes list holds one entry for each fix, with the original and the fixed word or phrase.`;

/** The prompterize settings pi holds, before any default is filled in. */
function prompterizeSettings(settings: PiSettings): PrompterizeSettings {
	return (settings as { prompterize?: PrompterizeSettings }).prompterize ?? {};
}

/** The Fixer's resolved settings, after defaults and validation. */
function fixerSettings(settings: PiSettings): FixerSettings {
	const fixer = prompterizeSettings(settings).fixer ?? {};
	const thinkingLevel = THINKING_LEVELS.find((level) => level === fixer.thinkingLevel) ?? DEFAULT_FIXER.thinkingLevel;
	return {
		enabled: typeof fixer.enabled === "boolean" ? fixer.enabled : DEFAULT_FIXER.enabled,
		model: typeof fixer.model === "string" && fixer.model.length > 0 ? fixer.model : DEFAULT_FIXER.model,
		thinkingLevel,
	};
}

/** Whether runs started by a typed prompt carry the Clarity note; on unless the settings say otherwise. */
function clarityEnabled(settings: PiSettings): boolean {
	return prompterizeSettings(settings).clarity?.enabled ?? true;
}

/** Split "provider/model" at its first slash, as pi names a model in settings. */
function splitModel(model: string): { provider: string; id: string } {
	const slash = model.indexOf("/");
	if (slash <= 0 || slash === model.length - 1) throw new Error(`the Fixer's model ${model} is not provider/id`);
	return { provider: model.slice(0, slash), id: model.slice(slash + 1) };
}

/** The text of an assistant message, from its text parts alone. */
const textOf = (message: { content: { type: string; text?: string }[] }): string =>
	message.content.flatMap((part) => (part.type === "text" && typeof part.text === "string" ? [part.text] : [])).join("");

/** The Fixer's reply as JSON, with the code fence a model sometimes adds removed. */
function parseReply(raw: string): FixerReply {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null) throw new Error("the Fixer's reply is not an object");
	const { text: fixed, changes } = parsed as { text?: unknown; changes?: unknown };
	if (typeof fixed !== "string") throw new Error("the Fixer's reply has no text");
	if (!Array.isArray(changes)) throw new Error("the Fixer's reply has no changes list");
	const checked = changes.map((change) => {
		if (typeof change !== "object" || change === null) throw new Error("a change is not an object");
		const { from, to } = change as { from?: unknown; to?: unknown };
		if (typeof from !== "string" || typeof to !== "string") throw new Error("a change has no from/to pair");
		return { from, to };
	});
	return { text: fixed, changes: checked };
}

/**
 * Send one prompt to the Fixer's model and return what the run did to it. The result is total:
 * a failure comes back as the error outcome, so the caller never has to catch one.
 */
async function fixPrompt(ctx: ExtensionContext, prompt: string, settings: FixerSettings): Promise<FixerRun> {
	const started = Date.now();
	const time = new Date(started).toISOString();
	try {
		const { provider, id } = splitModel(settings.model);
		const model: Model<Api> | undefined = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`the Fixer's model ${settings.model} is not available`);
		const context: Context = {
			systemPrompt: INSTRUCTIONS,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: started }],
		};
		const reply = await ctx.modelRegistry.streamSimple(model, context, { reasoning: settings.thinkingLevel }).result();
		if (reply.stopReason !== "stop") throw new Error(reply.errorMessage ?? `the Fixer stopped with ${reply.stopReason}`);
		const fixed = parseReply(textOf(reply));
		return {
			time,
			durationMs: Date.now() - started,
			outcome: fixed.text === prompt ? "unchanged" : "fixed",
			fixed: fixed.text,
			changes: fixed.changes,
		};
	} catch (failure) {
		return {
			time,
			durationMs: Date.now() - started,
			outcome: "error",
			fixed: prompt,
			changes: [],
			error: failure instanceof Error ? failure.message : String(failure),
		};
	}
}

/** The Correction log's one file, outside every repo: under XDG_DATA_HOME, or ~/.local/share. */
function correctionLogPath(): string {
	const dataHome = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
	return join(dataHome, "pi-prompterize", "corrections.jsonl");
}

/** The repo a prompt was typed in, so a correction can be judged against the code as it was then. */
type RepoFacts = { repoPath: string; remote: string; commit: string };

/**
 * The repo's path, its first remote's URL and its current commit, asked of git in `cwd`. A
 * folder git does not know, or a repo with no remote, gives an empty field instead of a failure.
 */
async function repoFacts(pi: ExtensionAPI, cwd: string): Promise<RepoFacts> {
	const pathAndCommit = await pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd });
	if (pathAndCommit.code !== 0) return { repoPath: cwd, remote: "", commit: "" };
	// One call answers both questions, one line each: the repo's top level, then HEAD.
	const [repoPath, commit = ""] = pathAndCommit.stdout.trim().split("\n");
	const remoteNames = await pi.exec("git", ["remote"], { cwd });
	const remoteName = remoteNames.stdout.split("\n").find((name) => name.trim().length > 0);
	if (remoteName === undefined) return { repoPath, remote: "", commit };
	const url = await pi.exec("git", ["remote", "get-url", remoteName.trim()], { cwd });
	return { repoPath, remote: url.code === 0 ? url.stdout.trim() : "", commit };
}

/**
 * Append one Fixer record to the Correction log. The log is a study aid, so a log that cannot
 * be made or written is dropped: whatever the log does, the Boss's prompt still goes on.
 */
async function logFixerRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: FixerSettings,
	original: string,
	run: FixerRun,
): Promise<void> {
	try {
		const { repoPath, remote, commit } = await repoFacts(pi, ctx.cwd);
		const record: FixerRecord = {
			id: randomUUID(),
			sessionId: ctx.sessionManager.getSessionId(),
			repoPath,
			remote,
			commit,
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			original,
			...run,
		};
		const path = correctionLogPath();
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// A Correction log that cannot be written never stops or changes the prompt.
	}
}

export default function prompterize(pi: ExtensionAPI): void {
	/**
	 * The text of the next run's prompt when that run should carry the Clarity note, or null.
	 * The input handler sets it; `before_agent_start` consumes it, and matches it against the
	 * run's prompt so a run started by another extension or RPC can never pick it up.
	 */
	let promptForClarityNote: string | null = null;

	pi.on("before_agent_start", (event) => {
		const prompt = promptForClarityNote;
		promptForClarityNote = null;
		if (event.messageType !== "user") return;
		if (prompt === null || event.prompt !== prompt) return;
		event.systemPromptOptions.sections.clarity_note = CLARITY_NOTE;
	});

	pi.on("input", async (event, ctx) => {
		promptForClarityNote = null;
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Fixer's, and carry no Clarity note.
		if (event.text.startsWith("/")) return { action: "continue" };
		// The Skip prefix sends the rest with neither the Fixer nor the Clarity note.
		if (event.text.startsWith("*")) return { action: "transform", text: event.text.slice(1) };
		const piSettings = pi.getSettings();
		const settings = fixerSettings(piSettings);
		let text = event.text;
		if (settings.enabled) {
			const run = await fixPrompt(ctx, event.text, settings);
			await logFixerRun(pi, ctx, settings, event.text, run);
			if (run.outcome === "fixed") text = run.fixed;
		}
		if (clarityEnabled(piSettings)) promptForClarityNote = text;
		return text === event.text ? { action: "continue" } : { action: "transform", text };
	});
}
