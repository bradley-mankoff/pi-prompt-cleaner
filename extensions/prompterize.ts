/**
 * pi-prompterize: the Fixer sends each typed prompt to a cheap, fast model that fixes its
 * typos before the main agent reads it. The Boss's words are the only thing that changes;
 * nothing is added to the prompt to say what changed.
 *
 * The seam is the real pi session (see tests/prompterize.test.ts): this file only wires pi's
 * `input` event to the Fixer, and the Fixer speaks to its model through
 * `ctx.modelRegistry.streamSimple()`, so pi's own credentials are used.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, Context, Model } from "@earendil-works/pi-ai";

/** The thinking levels pi offers, as the prompterize settings accept them. */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** What pi's settings.json holds under the prompterize key. */
type PrompterizeSettings = {
	fixer?: { enabled?: boolean; model?: string; thinkingLevel?: string };
};

/** The Fixer's resolved settings, after defaults and validation. */
type FixerSettings = { enabled: boolean; model: string; thinkingLevel: ThinkingLevel };

const DEFAULT_FIXER: FixerSettings = {
	enabled: true,
	model: "opencode-go/deepseek-v4.1-flash",
	thinkingLevel: "low",
};

/** One replacement the Fixer made, kept for the Correction log. */
export type FixerChange = { from: string; to: string };

/** What the Fixer's model replies with: the prompt after fixing, and each change it made. */
export type FixerReply = { text: string; changes: FixerChange[] };

const INSTRUCTIONS = `You are the Fixer in pi-prompterize. Fix the spelling mistakes in the user's prompt.

Rules:
- Fix typos and change nothing else. Do not reword, reorder, shorten, expand or add content.
- Keep the user's meaning, language, punctuation, capitalisation and layout as they are apart from the typos.
- Reply with JSON only, with no code fence and no explanation, in exactly this shape:
{"text":"<the prompt with its typos fixed>","changes":[{"from":"<the text as typed>","to":"<the text after fixing>"}]}
- The changes list holds one entry for each fix, with the original and the fixed word or phrase.`;

/** The prompterize settings, read from pi's effective settings with the defaults filled in. */
function fixerSettings(settings: Record<string, unknown>): FixerSettings {
	const prompterize = settings.prompterize as PrompterizeSettings | undefined;
	const fixer = prompterize?.fixer ?? {};
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
 * Send one prompt to the Fixer's model and return its fixed text and changes. Any failure
 * throws; the input handler lets the prompt through unchanged when that happens.
 */
async function fixPrompt(
	ctx: ExtensionContext,
	prompt: string,
	settings: FixerSettings,
): Promise<FixerReply> {
	const { provider, id } = splitModel(settings.model);
	const model: Model<Api> | undefined = ctx.modelRegistry.find(provider, id);
	if (!model) throw new Error(`the Fixer's model ${settings.model} is not available`);
	const context: Context = {
		systemPrompt: INSTRUCTIONS,
		messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
	};
	const reply = await ctx.modelRegistry.streamSimple(model, context, { reasoning: settings.thinkingLevel }).result();
	if (reply.stopReason !== "stop") throw new Error(reply.errorMessage ?? `the Fixer stopped with ${reply.stopReason}`);
	return parseReply(textOf(reply));
}

export default function prompterize(pi: ExtensionAPI): void {
	pi.on("input", async (event, ctx) => {
		// Only the Boss's own typing is a typed prompt (GLOSSARY.md).
		if (event.source !== "interactive") return { action: "continue" };
		// Slash commands are pi's, not the Fixer's.
		if (event.text.startsWith("/")) return { action: "continue" };
		// The Skip prefix sends the rest with neither the Fixer nor the Clarity note.
		if (event.text.startsWith("*")) return { action: "transform", text: event.text.slice(1) };
		const settings = fixerSettings(pi.getSettings() as unknown as Record<string, unknown>);
		if (!settings.enabled) return { action: "continue" };
		try {
			const fixed = await fixPrompt(ctx, event.text, settings);
			return fixed.text === event.text ? { action: "continue" } : { action: "transform", text: fixed.text };
		} catch {
			// A broken Fixer never blocks the Boss's work.
			return { action: "continue" };
		}
	});
}
