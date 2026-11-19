/**
 * pi-prompterize: the Fixer sends each typed prompt to a cheap, fast model that fixes its
 * typos and maps near-miss file and symbol names to the repo's real names before the main agent
 * reads it. The Boss's words are the only thing that changes; nothing is added to the prompt to
 * say what changed.
 *
 * A typed prompt that was not skipped also gets the Clarity note in its run's system prompt,
 * so the main agent knows to act at once on a clear prompt and to ask one Question round
 * when it is unclear.
 *
 * Each Fixer run, and each Question round the Clarity note leads to, also goes to the Correction
 * log, one JSONL file outside every repo, for a later, smarter model to study the Boss's typing
 * and his unclear prompts. The log is a study aid: when it cannot be written, the prompt still
 * goes on.
 *
 * Text the Boss wrote or chose on purpose is never the Fixer's to change: each code fence, inline
 * code span, blockquote line, URL and @ reference is swapped for a random placeholder before the
 * model call, and put back byte for byte after it. A reply that mishandles a placeholder is
 * rejected by a plain string comparison, and the prompt goes on as typed with the run logged as
 * an error.
 *
 * While the Fixer's model runs, pi's status line shows "fixing prompt…", and Esc aborts the call.
 * The prompt then goes on as typed and the Correction log records the run as cancelled with the
 * time waited. The status is cleared however the call ends.
 *
 * The seam is the real pi session (see tests/prompterize.test.ts): this file wires pi's
 * `input`, `before_agent_start` and `agent_end` events to the Fixer, the Clarity note and the
 * Correction log, and the Fixer speaks to its model through `ctx.modelRegistry.streamSimple()`,
 * so pi's own credentials are used. The call names the pi session's id, because opencode's
 * providers answer 400 MissingSessionID unless the request carries a session to route by.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";
import { closeRealNames, type RealNameMatch } from "./real-names.ts";

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

/** A typo the Fixer fixed: the text as typed, and the text after fixing. */
type TypoFix = { from: string; to: string };

/** A possibly hint the Fixer added: the word as typed, and the real names close to it. */
type PossiblyHint = { word: string; possibly: string[] };

/**
 * One entry in the Fixer's changes list: a typo it fixed, or a word it left as typed with a
 * possibly hint naming the real names close to it.
 */
type FixerChange = TypoFix | PossiblyHint;

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
type FixerRecord = FixerRun &
	RepoFacts & {
		id: string;
		sessionId: string;
		model: string;
		thinkingLevel: ThinkingLevel;
		original: string;
	};

/**
 * The prompt that caused a Question round: the id of its Fixer record when the Fixer ran, or no
 * id when the Fixer is off. The prompt itself is kept either way, so a study of the log can read
 * which prompt was unclear without first finding the Fixer record.
 */
type QuestionRoundCause = { fixerRecordId?: string; prompt: string };

/** A Question round the agent asked and the Boss has not yet answered, and the prompt that caused it. */
type PendingQuestionRound = QuestionRoundCause & { questions: string[] };

/**
 * One Question round as the Correction log keeps it: its own id, the prompt that caused it, the
 * questions and the Boss's answers, and the repo facts a Fixer record carries.
 */
type QuestionRoundRecord = RepoFacts &
	PendingQuestionRound & {
		id: string;
		answers: string;
	};

const INSTRUCTIONS = `You are the Fixer in pi-prompterize. Fix the spelling mistakes in the user's prompt.

Rules:
- Fix typos and change nothing else. Do not reword, reorder, shorten, expand or add content.
- Keep the user's meaning, language, punctuation, capitalisation and layout as they are apart from the typos.
- Text in a placeholder such as ⟦prompterize:...⟧ was written or chosen by the user on purpose. Copy each placeholder exactly once, exactly as it is, and add no placeholder of your own.
- Some real names from the repo may be listed below, each beside a word that is close to it. When one of them is clearly the name the user meant, replace the word with that real name.
- When no given real name is a confident match for a word, keep the word exactly as typed and add a possibly hint right after it, naming the close real names: "(possibly A or B)". Use the word "possibly" and never "likely".
- Reply with JSON only, with no code fence and no explanation, in exactly this shape:
{"text":"<the prompt with its typos fixed>","changes":[{"from":"<the text as typed>","to":"<the text after fixing>"},{"word":"<the word as typed>","possibly":["<real name>"]}]}
- The changes list holds one entry for each fix, with the original and the fixed word or phrase. A possibly hint gets its own entry, with the word as typed and the real names close to it.`;

/**
 * The real names the Fixer's model is given, each beside the typed word it is close to, or nothing
 * when no word found a close name. Only these close matches go to the model: never the repo's
 * whole file list or symbol list, and never the conversation.
 */
function realNameSection(matches: RealNameMatch[]): string {
	if (matches.length === 0) return "";
	const lines = matches.map(({ word, names }) => `- ${word}: ${names.join(", ")}`);
	return `Real names from this repo that are close to words in the prompt. A word may be a misspelling of one of its names:\n${lines.join("\n")}`;
}

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

/** The agent's final reply in a run: the text of its last assistant message. */
function finalReplyText(messages: readonly { role: string; content?: unknown }[]): string {
	const last = messages.filter((message) => message.role === "assistant").at(-1);
	if (last === undefined || !Array.isArray(last.content)) return "";
	return textOf({ content: last.content as { type: string; text?: string }[] });
}

/**
 * A question in the grilling skill's format: the ❓ mark followed by a numbered, bold question.
 * The number runs across the whole grilling, so the marker carries whatever number it reached.
 */
const QUESTION_MARKER = /❓\s*\*\*Q\d+\*\*/;

/**
 * The questions of the Question round in an agent reply, each with its body and suggested answer,
 * or nothing when the reply holds no Question round. The marker starts each question and a rule or
 * the closing "For your information" section ends the last one, so no context outside the round
 * lands in the record.
 */
function questionRoundIn(reply: string): string[] {
	const questions: string[] = [];
	let current: string[] | null = null;
	const finish = (): void => {
		if (current === null) return;
		const question = current.join("\n").trim();
		if (question.length > 0) questions.push(question);
		current = null;
	};
	for (const line of reply.split("\n")) {
		if (QUESTION_MARKER.test(line)) {
			finish();
			current = [line];
			continue;
		}
		if (current === null) continue;
		if (line.trim() === "---" || /^\s*\*\*For your information\*\*/i.test(line)) {
			finish();
			continue;
		}
		current.push(line);
	}
	finish();
	return questions;
}

/** The Fixer's reply as JSON, with the code fence a model sometimes adds removed. */
function parseReply(raw: string): FixerReply {
	const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== "object" || parsed === null) throw new Error("the Fixer's reply is not an object");
	const { text: fixed, changes } = parsed as { text?: unknown; changes?: unknown };
	if (typeof fixed !== "string") throw new Error("the Fixer's reply has no text");
	if (!Array.isArray(changes)) throw new Error("the Fixer's reply has no changes list");
	return { text: fixed, changes: changes.map(parseChange) };
}

/** One entry of the Fixer's changes list: a typo fix, or a word left as typed with a possibly hint. */
function parseChange(change: unknown): FixerChange {
	if (typeof change !== "object" || change === null) throw new Error("a change is not an object");
	const { from, to, word, possibly } = change as { from?: unknown; to?: unknown; word?: unknown; possibly?: unknown };
	if (typeof from === "string" && typeof to === "string") return { from, to };
	if (typeof word === "string" && Array.isArray(possibly) && possibly.every((name) => typeof name === "string")) {
		return { word, possibly };
	}
	throw new Error("a change is neither a from/to pair nor a possibly hint");
}

/** Half-open `[start, stop)`: where a line or a span starts, and where it ends. */
type Range = { start: number; stop: number };

/** One protected span, and the placeholder that stands in for it in the Fixer's request. */
type ProtectedSpan = { placeholder: string; span: string };

/** The prompt as the Fixer's model sees it, and the spans its placeholders stand for. */
type ProtectedPrompt = { text: string; spans: ProtectedSpan[] };

/** The marks that fence a placeholder, so the request and the guard cannot spell one differently. */
const PLACEHOLDER_OPEN = "⟦prompterize:";
const PLACEHOLDER_CLOSE = "⟧";

/**
 * The shape of every placeholder: the open mark, a hex token random to one request, the span's
 * index and the close mark. A reply may carry no token of this shape except the ones this request
 * made, so the guard can tell a placeholder the model invented from ordinary text. It is built from
 * the same marks the request is built from, so the two cannot drift apart.
 */
const PLACEHOLDER_SHAPE = new RegExp(`${PLACEHOLDER_OPEN}[0-9a-f]+:\\d+${PLACEHOLDER_CLOSE}`, "g");

/**
 * One prompt's claimed spans: the mask says which characters an earlier kind already holds, and the
 * ranges are the spans themselves. Kinds claim in turn, and a caller never sees the mask.
 */
type SpanClaims = {
	/** Take `[start, stop)` as one span, unless a span claimed earlier already holds part of it. */
	take(start: number, stop: number): boolean;
	/** Whether the character at `index` sits inside a claimed span. */
	holds(index: number): boolean;
	/** Every claimed span, in the order it was taken. */
	readonly ranges: Range[];
};

/** The claims of one prompt, `length` characters long, with nothing claimed yet. */
function spanClaims(length: number): SpanClaims {
	const covered = new Uint8Array(length);
	const ranges: Range[] = [];
	return {
		take(start, stop) {
			if (stop <= start) return false;
			for (let i = start; i < stop; i += 1) if (covered[i] === 1) return false;
			for (let i = start; i < stop; i += 1) covered[i] = 1;
			ranges.push({ start, stop });
			return true;
		},
		holds: (index) => covered[index] === 1,
		ranges,
	};
}

/** Where each line of the prompt starts, and where its newline or the prompt ends. */
function linesOf(text: string): Range[] {
	const lines: Range[] = [];
	let start = 0;
	while (start <= text.length) {
		const newline = text.indexOf("\n", start);
		const stop = newline < 0 ? text.length : newline;
		lines.push({ start, stop });
		if (newline < 0) break;
		start = newline + 1;
	}
	return lines;
}

/**
 * Swap each protected span for its own placeholder, so the Fixer's model can fix the words around
 * them but never touch them. The spans are claimed in turn, earlier kinds first, so a blockquote
 * line keeps the inline code inside it and a code fence keeps the URL-shaped text inside it.
 * Placeholders carry a token random to this request, so a reply can only ever answer this prompt.
 */
function protectSpans(prompt: string): ProtectedPrompt {
	const token = randomBytes(6).toString("hex");
	const claims = spanClaims(prompt.length);
	claimFencedBlocks(prompt, claims);
	claimBlockquoteLines(prompt, claims);
	claimInlineCode(prompt, claims);
	claimUrls(prompt, claims);
	claimAtReferences(prompt, claims);
	const ranges = [...claims.ranges].sort((left, right) => left.start - right.start);
	const spans: ProtectedSpan[] = [];
	let text = "";
	let end = 0;
	for (const { start, stop } of ranges) {
		const placeholder = `${PLACEHOLDER_OPEN}${token}:${spans.length}${PLACEHOLDER_CLOSE}`;
		spans.push({ placeholder, span: prompt.slice(start, stop) });
		text += prompt.slice(end, start) + placeholder;
		end = stop;
	}
	return { text: text + prompt.slice(end), spans };
}

/**
 * Claim each code fence, from its opening line through its closing line, or through the prompt's
 * end when it has no closing line. A closing fence is at least as long as its opener and carries
 * nothing else.
 */
function claimFencedBlocks(text: string, claims: SpanClaims): void {
	let open: { start: number; fence: string } | undefined;
	for (const line of linesOf(text)) {
		const body = text.slice(line.start, line.stop);
		const fence = /^\s*(`{3,}|~{3,})/.exec(body)?.[1];
		if (open === undefined) {
			if (fence !== undefined) open = { start: line.start, fence };
			continue;
		}
		const closes = fence !== undefined && fence[0] === open.fence[0] && fence.length >= open.fence.length && body.trim() === fence;
		if (!closes) continue;
		claims.take(open.start, line.stop);
		open = undefined;
	}
	if (open !== undefined) claims.take(open.start, text.length);
}

/** Claim each blockquote line whole: the Boss quoted that text, so none of it is the Fixer's. */
function claimBlockquoteLines(text: string, claims: SpanClaims): void {
	for (const line of linesOf(text)) {
		if (/^\s*>/.test(text.slice(line.start, line.stop))) claims.take(line.start, line.stop);
	}
}

/**
 * Claim each inline code span: a run of backticks, its text, and a closing run of the same length.
 * A run with no partner is ordinary text, and a partner inside a fence or another span is not one
 * this span may use.
 */
function claimInlineCode(text: string, claims: SpanClaims): void {
	for (let i = 0; i < text.length; i += 1) {
		if (text[i] !== "`" || claims.holds(i)) continue;
		let length = 0;
		while (text[i + length] === "`") length += 1;
		for (let j = i + length; j < text.length; ) {
			if (text[j] !== "`") {
				j += 1;
				continue;
			}
			if (claims.holds(j)) break;
			let closing = 0;
			while (text[j + closing] === "`") closing += 1;
			if (closing !== length) {
				j += closing;
				continue;
			}
			if (claims.take(i, j + closing)) i = j + closing - 1;
			break;
		}
	}
}

/** Claim each http(s) URL, leaving the sentence's punctuation and any unbalanced closing bracket outside. */
function claimUrls(text: string, claims: SpanClaims): void {
	for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/g)) {
		const start = match.index;
		let stop = start + match[0].length;
		while (stop > start && ".,;:!?'\"".includes(text[stop - 1])) stop -= 1;
		for (const [opening, closing] of [
			["(", ")"],
			["[", "]"],
		]) {
			while (stop > start && text[stop - 1] === closing) {
				const url = text.slice(start, stop - 1);
				if (url.split(opening).length > url.split(closing).length) break;
				stop -= 1;
			}
		}
		claims.take(start, stop);
	}
}

/** Claim each @ reference, such as @src/file.ts, but never the @ of an email address. */
function claimAtReferences(text: string, claims: SpanClaims): void {
	for (const match of text.matchAll(/@[A-Za-z0-9_][A-Za-z0-9_./-]*/g)) {
		const start = match.index;
		if (start > 0 && /[\w.+-]/.test(text[start - 1])) continue;
		claims.take(start, start + match[0].length);
	}
}

/**
 * Check the Fixer's reply against the placeholders this request made: each must appear exactly
 * once, unchanged, and the reply must invent none of its own. This is a plain string comparison,
 * not a model's judgement, so a reply that fails it can be rejected outright.
 */
function checkPlaceholders(reply: string, spans: ProtectedSpan[]): void {
	for (const { placeholder } of spans) {
		const kept = reply.split(placeholder).length - 1;
		if (kept !== 1) throw new Error(`the Fixer's reply must keep each protected placeholder exactly once, unchanged: ${placeholder} appears ${kept} times`);
	}
	const known = new Set(spans.map(({ placeholder }) => placeholder));
	for (const found of reply.match(PLACEHOLDER_SHAPE) ?? []) {
		if (!known.has(found)) throw new Error(`the Fixer's reply invented the placeholder ${found}`);
	}
}

/** Put each protected span back in place of its placeholder. */
function restoreSpans(text: string, spans: ProtectedSpan[]): string {
	return spans.reduce((restored, { placeholder, span }) => restored.split(placeholder).join(span), text);
}

/** Put each protected span back in a change's text, whichever kind of change it is. */
function restoreChange(change: FixerChange, spans: ProtectedSpan[]): FixerChange {
	if ("from" in change) return { from: restoreSpans(change.from, spans), to: restoreSpans(change.to, spans) };
	return { word: restoreSpans(change.word, spans), possibly: change.possibly.map((name) => restoreSpans(name, spans)) };
}

/** The status line pi shows while the Fixer waits on its model. */
const FIXER_STATUS_KEY = "prompterize";
const FIXER_STATUS_TEXT = "fixing prompt…";

/** The record a run ends with: when it started, how long the call took, and what came of it. */
function runEnded(started: number, run: Omit<FixerRun, "time" | "durationMs">): FixerRun {
	return { time: new Date(started).toISOString(), durationMs: Date.now() - started, ...run };
}

/**
 * The record a call that Esc cancelled ends with: the prompt goes on as typed, and the Correction
 * log records how long the Boss waited before pressing Esc.
 */
function cancelledRun(started: number, prompt: string): FixerRun {
	return runEnded(started, { outcome: "cancelled", fixed: prompt, changes: [] });
}

/**
 * Wait for `reply` unless `signal` aborts first, which answers `undefined`. The stream keeps its
 * own abort handling; this only decides when the Fixer stops waiting, so a provider that ignores
 * the signal cannot hold the Boss's prompt.
 */
function unlessAborted<T>(reply: Promise<T>, signal: AbortSignal): Promise<T | undefined> {
	return new Promise((resolve, reject) => {
		const abort = () => resolve(undefined);
		if (signal.aborted) {
			reply.catch(() => {});
			abort();
			return;
		}
		signal.addEventListener("abort", abort, { once: true });
		reply.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(failure) => {
				signal.removeEventListener("abort", abort);
				reject(failure);
			},
		);
	});
}

/**
 * Send one prompt to the Fixer's model and return what the run did to it, showing pi's status
 * line while it waits. Esc during the wait aborts the call and leaves the prompt as typed. The
 * result is total: a failure comes back as the error outcome, so the caller never has to catch
 * one.
 */
async function fixPrompt(pi: ExtensionAPI, ctx: ExtensionContext, prompt: string, settings: FixerSettings): Promise<FixerRun> {
	const started = Date.now();
	const controller = new AbortController();
	// Esc during the wait cancels the call, so the Boss is never stuck behind a slow or hung model.
	const stopListening = ctx.ui.onTerminalInput((data) => {
		if (data !== "\x1b") return undefined;
		controller.abort();
		return { consume: true };
	});
	ctx.ui.setStatus(FIXER_STATUS_KEY, FIXER_STATUS_TEXT);
	try {
		const { provider, id } = splitModel(settings.model);
		const model: Model<Api> | undefined = ctx.modelRegistry.find(provider, id);
		if (!model) throw new Error(`the Fixer's model ${settings.model} is not available`);
		const protectedPrompt = protectSpans(prompt);
		const realNames = await closeRealNames(pi, ctx.cwd, protectedPrompt.text);
		const context: Context = {
			systemPrompt: [INSTRUCTIONS, realNameSection(realNames)].filter((section) => section.length > 0).join("\n\n"),
			messages: [{ role: "user", content: [{ type: "text", text: protectedPrompt.text }], timestamp: started }],
		};
		const reply = await unlessAborted(
			ctx.modelRegistry
				.streamSimple(model, context, {
					reasoning: settings.thinkingLevel,
					// opencode's providers answer `400 MissingSessionID` to a request that names
					// no session, so pi turns this id into the `x-opencode-session` header.
					sessionId: ctx.sessionManager.getSessionId(),
					signal: controller.signal,
				})
				.result(),
			controller.signal,
		);
		if (reply === undefined || reply.stopReason === "aborted") return cancelledRun(started, prompt);
		if (reply.stopReason !== "stop") throw new Error(reply.errorMessage ?? `the Fixer stopped with ${reply.stopReason}`);
		const parsed = parseReply(textOf(reply));
		checkPlaceholders(parsed.text, protectedPrompt.spans);
		const fixed = restoreSpans(parsed.text, protectedPrompt.spans);
		return runEnded(started, {
			outcome: fixed === prompt ? "unchanged" : "fixed",
			fixed,
			changes: parsed.changes.map((change) => restoreChange(change, protectedPrompt.spans)),
		});
	} catch (failure) {
		// A provider that fails on the abort, rather than reporting it, still ends as cancelled.
		if (controller.signal.aborted) return cancelledRun(started, prompt);
		return runEnded(started, {
			outcome: "error",
			fixed: prompt,
			changes: [],
			error: failure instanceof Error ? failure.message : String(failure),
		});
	} finally {
		// However the call ended, pi stops saying it is fixing the prompt.
		ctx.ui.setStatus(FIXER_STATUS_KEY, undefined);
		stopListening();
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
 * Append one record to the Correction log with the repo it was typed in filled in, and answer
 * whether it was written. The log is a study aid, so a log that cannot be made or written is
 * dropped: whatever the log does, the Boss's prompt still goes on.
 */
async function appendCorrectionRecord(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	record: Omit<FixerRecord, keyof RepoFacts> | Omit<QuestionRoundRecord, keyof RepoFacts>,
): Promise<boolean> {
	try {
		const facts = await repoFacts(pi, ctx.cwd);
		const path = correctionLogPath();
		await mkdir(dirname(path), { recursive: true });
		await appendFile(path, `${JSON.stringify({ ...record, ...facts })}\n`, "utf8");
		return true;
	} catch {
		// A Correction log that cannot be written never stops or changes the prompt.
		return false;
	}
}

/**
 * Append one Fixer record to the Correction log and answer its id, so a Question round can link
 * back to the run that caused it, or undefined when the log could not be written.
 */
async function logFixerRun(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	settings: FixerSettings,
	original: string,
	run: FixerRun,
): Promise<string | undefined> {
	const record = {
		id: randomUUID(),
		sessionId: ctx.sessionManager.getSessionId(),
		model: settings.model,
		thinkingLevel: settings.thinkingLevel,
		original,
		...run,
	};
	return (await appendCorrectionRecord(pi, ctx, record)) ? record.id : undefined;
}

/**
 * Append one Question round, with the Boss's answers to it, to the Correction log. Like a Fixer
 * record, the log is a study aid: a log that cannot be written never stops or changes the Boss's
 * next prompt.
 */
async function logQuestionRound(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	round: PendingQuestionRound,
	answers: string,
): Promise<void> {
	await appendCorrectionRecord(pi, ctx, {
		id: randomUUID(),
		...(round.fixerRecordId === undefined ? {} : { fixerRecordId: round.fixerRecordId }),
		prompt: round.prompt,
		questions: round.questions,
		answers,
	});
}

export default function prompterize(pi: ExtensionAPI): void {
	/**
	 * The prompt and cause of the next run when that run should carry the Clarity note, or null.
	 * The input handler sets it; `before_agent_start` consumes it, and matches the prompt against
	 * the run's prompt so a run started by another extension or RPC can never pick it up.
	 */
	let nextClarityRun: { prompt: string; cause: QuestionRoundCause } | null = null;
	/**
	 * The cause of the run now under way when that run carried the Clarity note, or null. Its end
	 * is the only place the agent's reply can be read for a Question round.
	 */
	let clarityRunCause: QuestionRoundCause | null = null;
	/**
	 * The Question round the last Clarity run asked, waiting for the Boss's next typed prompt to
	 * answer it, or null. Only a typed prompt can answer a Question round, so a slash command or
	 * a prompt from RPC or another extension leaves it waiting.
	 */
	let unansweredRound: PendingQuestionRound | null = null;

	pi.on("before_agent_start", (event) => {
		const waiting = nextClarityRun;
		nextClarityRun = null;
		if (event.messageType !== "user") return;
		if (waiting === null || event.prompt !== waiting.prompt) return;
		event.systemPromptOptions.sections.clarity_note = CLARITY_NOTE;
		clarityRunCause = waiting.cause;
	});

	pi.on("agent_end", (event) => {
		const cause = clarityRunCause;
		clarityRunCause = null;
		if (cause === null) return;
		const questions = questionRoundIn(finalReplyText(event.messages));
		if (questions.length > 0) unansweredRound = { ...cause, questions };
	});

	pi.on("input", async (event, ctx) => {
		nextClarityRun = null;
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Fixer's, and carry no Clarity note.
		if (event.text.startsWith("/")) return { action: "continue" };
		// The Skip prefix sends the rest with neither the Fixer nor the Clarity note.
		const skipped = event.text.startsWith("*");
		const typed = skipped ? event.text.slice(1) : event.text;
		// A typed prompt after a Question round is the Boss's answer to it.
		if (unansweredRound !== null) {
			await logQuestionRound(pi, ctx, unansweredRound, typed);
			unansweredRound = null;
		}
		if (skipped) return { action: "transform", text: typed };
		const piSettings = pi.getSettings();
		const settings = fixerSettings(piSettings);
		let text = event.text;
		let fixerRecordId: string | undefined;
		if (settings.enabled) {
			const run = await fixPrompt(pi, ctx, event.text, settings);
			fixerRecordId = await logFixerRun(pi, ctx, settings, event.text, run);
			if (run.outcome === "fixed") text = run.fixed;
		}
		if (clarityEnabled(piSettings)) nextClarityRun = { prompt: text, cause: { fixerRecordId, prompt: event.text } };
		return text === event.text ? { action: "continue" } : { action: "transform", text };
	});
}
