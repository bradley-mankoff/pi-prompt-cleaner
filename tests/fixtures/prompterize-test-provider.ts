/**
 * The outside service the prompterize tests talk to: a pi provider at the edge that plays
 * both models a typed prompt can reach. The main model answers with PROMPTERIZE_TEST_REPLY.
 * The Fixer's model (opencode-go/deepseek-v4.1-flash by default) answers with the raw text
 * in PROMPTERIZE_TEST_FIX, or fails with PROMPTERIZE_TEST_FIX_FAILURE.
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
	type Api,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai";

const api = "prompterize-test";
const log = process.env.PROMPTERIZE_TEST_LOG ?? "/dev/null";
const mainReply = process.env.PROMPTERIZE_TEST_REPLY ?? "answered";
const fixReply = process.env.PROMPTERIZE_TEST_FIX ?? '{"text":"fixed","changes":[]}';
const fixFailure = process.env.PROMPTERIZE_TEST_FIX_FAILURE;
const extensionText = process.env.PROMPTERIZE_TEST_EXTENSION_TEXT ?? "sent by an extension";

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

/** The one request the log records, so a test can see what a model was sent. */
function record(requested: Model<Api>, context: Context, options?: SimpleStreamOptions): void {
	const systemMessages = context.messages.filter((message) => message.role === "system").map(textOf);
	const system = [context.systemPrompt ?? "", ...systemMessages].filter(Boolean).join("\n");
	appendFileSync(
		log,
		`${JSON.stringify({
			provider: requested.provider,
			model: requested.id,
			reasoning: options?.reasoning ?? null,
			system,
			messages: context.messages.filter((message) => message.role !== "system").map(textOf),
		})}\n`,
	);
}

/** One reply, as pi's stream of events, or the failure when `failure` is given. */
function replyOf(requested: Model<Api>, text: string, failure?: string): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const reply = message(requested, text, failure);
	queueMicrotask(() => {
		if (failure !== undefined) {
			stream.push({ type: "error", reason: "error", error: reply });
			return;
		}
		stream.push({ type: "start", partial: reply });
		stream.push({ type: "text_start", contentIndex: 0, partial: reply });
		stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: reply });
		stream.push({ type: "text_end", contentIndex: 0, content: text, partial: reply });
		stream.push({ type: "done", reason: "stop", message: reply });
	});
	return stream;
}

export default function prompterizeTestProvider(pi: ExtensionAPI): void {
	/** The Fixer's model: the reply the test set, or the failure the test asked for. */
	const fixerStream = (requested: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		record(requested, context, options);
		return replyOf(requested, fixReply, fixFailure);
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
