/**
 * pi-prompterize: the Fixer sends each typed prompt to a cheap, fast model that fixes its
 * typos before the main agent reads it. The Boss's words are the only thing that changes;
 * nothing is added to the prompt to say what changed.
 *
 * Each Fixer run also goes to the Correction log, one JSONL file outside every repo, for a
 * later, smarter model to study the Boss's typing. The log is a study aid: when it cannot be
 * written, the prompt still goes on.
 *
 * The seam is the real pi session (see tests/prompterize.test.ts): this file only wires pi's
 * `input` event to the Fixer, and the Fixer speaks to its model through
 * `ctx.modelRegistry.streamSimple()`, so pi's own credentials are used.
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

/** One Fixer run as the Correction log keeps it, for a later model studying the Boss's typing. */
type FixerRecord = {
	id: string;
	time: string;
	sessionId: string;
	repoPath: string;
	remote: string;
	commit: string;
	model: string;
	thinkingLevel: ThinkingLevel;
	durationMs: number;
	outcome: FixerOutcome;
	original: string;
	fixed: string;
	changes: FixerChange[];
	error?: string;
};

const INSTRUCTIONS = `You are the Fixer in pi-prompterize. Fix the spelling mistakes in the user's prompt.

Rules:
- Fix typos and change nothing else. Do not reword, reorder, shorten, expand or add content.
- Keep the user's meaning, language, punctuation, capitalisation and layout as they are apart from the typos.
- Reply with JSON only, with no code fence and no explanation, in exactly this shape:
{"text":"<the prompt with its typos fixed>","changes":[{"from":"<the text as typed>","to":"<the text after fixing>"}]}
- The changes list holds one entry for each fix, with the original and the fixed word or phrase.`;

/** The prompterize settings, read from pi's effective settings with the defaults filled in. */
function fixerSettings(settings: PiSettings): FixerSettings {
	const fixer = (settings as { prompterize?: PrompterizeSettings }).prompterize?.fixer ?? {};
	const thinkingLevel = THINKING_LEVELS.find((level) => level === fixer.thinkingLevel) ?? DEFAULT_FIXER.thinkingLevel;
	return {
		enabled: typeof fixer.enabled === "boolean" ? fixer.enabled : DEFAULT_FIXER.enabled,
		model: typeof fixer.model === "string" && fixer.model.length > 0 ? fixer.model : DEFAULT_FIXER.model,
		thinkingLevel,
	};
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
	const top = await pi.exec("git", ["rev-parse", "--show-toplevel", "HEAD"], { cwd });
	if (top.code !== 0) return { repoPath: cwd, remote: "", commit: "" };
	const [repoPath, commit = ""] = top.stdout.trim().split("\n");
	const names = await pi.exec("git", ["remote"], { cwd });
	const remoteName = names.stdout.split("\n").find((name) => name.trim().length > 0);
	if (remoteName === undefined) return { repoPath, remote: "", commit };
	const url = await pi.exec("git", ["remote", "get-url", remoteName.trim()], { cwd });
	return { repoPath, remote: url.code === 0 ? url.stdout.trim() : "", commit };
}

/**
 * Append one Fixer record to the Correction log. The log is a study aid, so a log that cannot
 * be read, made or written is dropped: whatever the log does, the Boss's prompt still goes on.
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
			time: run.time,
			sessionId: ctx.sessionManager.getSessionId(),
			repoPath,
			remote,
			commit,
			model: settings.model,
			thinkingLevel: settings.thinkingLevel,
			durationMs: run.durationMs,
			outcome: run.outcome,
			original,
			fixed: run.fixed,
			changes: run.changes,
			...(run.error === undefined ? {} : { error: run.error }),
		};
		const path = correctionLogPath();
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify(record)}\n`, "utf8");
	} catch {
		// A Correction log that cannot be written never stops or changes the prompt.
	}
}

export default function prompterize(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Fixer's.
		if (event.text.startsWith("/")) return { action: "continue" };
		// The Skip prefix sends the rest with neither the Fixer nor the Clarity note.
		if (event.text.startsWith("*")) return { action: "transform", text: event.text.slice(1) };
		const settings = fixerSettings(pi.getSettings());
		if (!settings.enabled) return { action: "continue" };
		const run = await fixPrompt(ctx, event.text, settings);
		await logFixerRun(pi, ctx, settings, event.text, run);
		return run.outcome === "fixed" ? { action: "transform", text: run.fixed } : { action: "continue" };
	});
}
