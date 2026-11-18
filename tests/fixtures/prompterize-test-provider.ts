/**
 * The outside service the prompterize tests talk to: a pi provider at the edge that plays
 * both models a typed prompt can reach. The main model answers with PROMPTERIZE_TEST_REPLY.
 * The Fixer's model (opencode-go/deepseek-v4.1-flash by default) answers with the raw text
 * in PROMPTERIZE_TEST_FIX, after PROMPTERIZE_TEST_FIX_DELAY_MS milliseconds when a test sets
 * that, or fails with PROMPTERIZE_TEST_FIX_FAILURE.
 *
 * A test that cannot know its reply in advance, because the protected spans carry random
 * placeholders, sets one of two other Fixer replies instead:
 *
 * - PROMPTERIZE_TEST_FIX_SUBSTITUTIONS, a JSON list of from/to pairs: the model applies them
 *   to the prompt it received, as a model that fixed those typos would.
 * - PROMPTERIZE_TEST_FIX_PLACEHOLDER_MUTATION, one of "drop", "change", "duplicate" or
 *   "add": the model mishandles the first placeholder, as a model ignoring its instructions
 *   would, so a test can see the extension reject the reply.
 *
 * Each model has its own stream function, so neither has to ask which model it is playing.
 * Every request is written as one JSON object a line to PROMPTERIZE_TEST_LOG, with the
 * provider, model, thinking level, system prompt and message text, so a test can see what
 * each model received without reading inside the extension.
 *
 * It also registers one command, /prompterize-test-extension, which sends
 * PROMPTERIZE_TEST_EXTENSION_TEXT as a prompt from an extension. A test uses it to show
 * that an extension's prompt reaches the main model without visiting the Fixer.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createAssistantMessageEventStream,
	getSystemMessageText,
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

/** The ways a Fixer reply can mishandle a placeholder, as a test names one. */
type PlaceholderMutation = "drop" | "change" | "duplicate" | "add";

/**
 * The mutation a test asked for, or none. A name outside the four fails loudly at start-up rather
 * than leaving a test to pass while its reply does nothing.
 */
function placeholderMutation(name: string | undefined): PlaceholderMutation | undefined {
	if (name === undefined) return undefined;
	if (name === "drop" || name === "change" || name === "duplicate" || name === "add") return name;
	throw new Error(`PROMPTERIZE_TEST_FIX_PLACEHOLDER_MUTATION is not one of drop, change, duplicate or add: ${name}`);
}

const api = "prompterize-test";
const log = process.env.PROMPTERIZE_TEST_LOG ?? "/dev/null";
const mainReply = process.env.PROMPTERIZE_TEST_REPLY ?? "answered";
const fixReply = process.env.PROMPTERIZE_TEST_FIX ?? '{"text":"fixed","changes":[]}';
const fixSubstitutions = process.env.PROMPTERIZE_TEST_FIX_SUBSTITUTIONS;
const fixPlaceholderMutation = placeholderMutation(process.env.PROMPTERIZE_TEST_FIX_PLACEHOLDER_MUTATION);
const fixDelay = Number(process.env.PROMPTERIZE_TEST_FIX_DELAY_MS ?? "0");
const fixFailure = process.env.PROMPTERIZE_TEST_FIX_FAILURE;
const extensionText = process.env.PROMPTERIZE_TEST_EXTENSION_TEXT ?? "sent by an extension";

/**
 * The placeholders the Fixer's request carries: the protected spans the extension swapped out.
 * A test provider playing a real model sees these tokens in the prompt and has to keep them.
 */
const placeholderPattern = /⟦prompterize:[0-9a-f]+:\d+⟧/g;

/**
 * The Fixer's reply to one request. A substitution or mutation reply is built from the prompt the
 * model received, because only then does the reply carry the random placeholders of this request.
 */
function fixReplyFor(prompt: string): string {
	if (fixSubstitutions !== undefined) {
		const substitutions = JSON.parse(fixSubstitutions) as { from: string; to: string }[];
		const text = substitutions.reduce((current, { from, to }) => current.split(from).join(to), prompt);
		return JSON.stringify({ text, changes: substitutions });
	}
	if (fixPlaceholderMutation !== undefined) {
		return JSON.stringify({ text: mutatePlaceholder(prompt, fixPlaceholderMutation), changes: [] });
	}
	return fixReply;
}

/** A reply that mishandles the first placeholder, as a model that ignored its guard would. */
function mutatePlaceholder(prompt: string, mutation: PlaceholderMutation): string {
	const [first] = prompt.match(placeholderPattern) ?? [];
	if (first === undefined) return prompt;
	switch (mutation) {
		case "drop":
			return prompt.replace(first, "");
		case "change":
			return prompt.replace(first, first.replace(/:\d+⟧$/, ":9⟧"));
		case "duplicate":
			return prompt.replace(first, `${first}${first}`);
		case "add":
			return `${prompt}\n⟦prompterize:ffffffffffff:9⟧`;
	}
}

/** The text of the latest message the request carries, which is the prompt the model answers. */
function promptOf(context: Context): string {
	const messages = context.messages.filter((message) => message.role === "user");
	const last = messages.at(-1);
	return last === undefined ? "" : textOf(last);
}

/** The provider that stands in for the Fixer's model. */
const fixerProvider = "opencode-go";

const model = (id: string) => ({
	id,
	name: id,
	reasoning: true,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 4096,
});

/** One assistant message, carrying either its text or, when `failure` is given, that error. */
const message = (requested: Model<Api>, text: string, failure?: string): AssistantMessage => ({
	role: "assistant",
	content: failure === undefined ? [{ type: "text", text }] : [],
	api: requested.api,
	provider: requested.provider,
	model: requested.id,
	usage: {
		input: 1,
		output: 1,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 2,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: failure === undefined ? "stop" : "error",
	...(failure === undefined ? {} : { errorMessage: failure }),
	timestamp: Date.now(),
});

/**
 * The system prompt a request carries: the context's plain prompt, then each system message
 * rendered as pi renders it, sections included. A system message that patches named prompt
 * sections carries no text in `content`, so skipping the sections would hide it.
 */
function systemOf(context: Context): string {
	const systemMessages = context.messages.flatMap((message) =>
		message.role === "system" ? [getSystemMessageText(message)] : [],
	);
	return [context.systemPrompt ?? "", ...systemMessages].filter(Boolean).join("\n");
}

/** The one request the log records, so a test can see what a model was sent. */
function record(requested: Model<Api>, context: Context, options?: SimpleStreamOptions): void {
	appendFileSync(
		log,
		`${JSON.stringify({
			provider: requested.provider,
			model: requested.id,
			reasoning: options?.reasoning ?? null,
			system: systemOf(context),
			messages: context.messages.filter((message) => message.role !== "system").map(textOf),
		})}\n`,
	);
}

/** One reply, as pi's stream of events, sent after `delayMs` (`0` sends it next tick), or the failure when given. */
function replyOf(requested: Model<Api>, text: string, failure?: string, delayMs = 0): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const reply = message(requested, text, failure);
	const send = () => {
		if (failure !== undefined) {
			stream.push({ type: "error", reason: "error", error: reply });
			return;
		}
		stream.push({ type: "start", partial: reply });
		stream.push({ type: "text_start", contentIndex: 0, partial: reply });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: reply });
		stream.push({ type: "done", reason: "stop", message: reply });
	};
	setTimeout(send, delayMs);
	return stream;
}

export default function prompterizeTestProvider(pi: ExtensionAPI): void {
	/** The Fixer's model: the reply the test set, after its delay, or the failure the test asked for. */
	const fixerStream = (requested: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		record(requested, context, options);
		return replyOf(requested, fixReplyFor(promptOf(context)), fixFailure, fixDelay);
	};
	/** The main model: always answers, so a test can read what the main agent received. */
	const mainStream = (requested: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		record(requested, context, options);
		return replyOf(requested, mainReply);
	};

	pi.registerProvider(fixerProvider, {
		name: "Prompterize test provider: the Fixer's model",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("deepseek-v4.1-flash"), model("flash")],
		streamSimple: fixerStream,
	});
	pi.registerProvider("prompterize-test", {
		name: "Prompterize test provider: the main model",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("main")],
		streamSimple: mainStream,
	});

	pi.registerCommand("prompterize-test-extension", {
		description: "Send a prompt from an extension, as another extension would",
		handler: async () => {
			pi.sendUserMessage(extensionText);
		},
	});
}

/** The text a message carries (copied from pi-links, so this fixture stands alone). */
const textOf = (message: unknown): string => {
	if (typeof message !== "object" || message === null) return "";
	const { content } = message as { content?: unknown };
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => {
			if (typeof part !== "object" || part === null) return [];
			const { type, text } = part as { type?: unknown; text?: unknown };
			return type === "text" && typeof text === "string" ? [text] : [];
		})
		.join("\n");
};
