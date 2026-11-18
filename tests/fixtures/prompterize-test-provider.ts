/**
 * The outside service the prompterize tests talk to: a pi provider at the edge that plays
 * both models a typed prompt can reach. The main model answers with PROMPTERIZE_TEST_REPLY.
 * The Fixer's model (opencode-go/deepseek-v4.1-flash by default) answers with the raw text
 * in PROMPTERIZE_TEST_FIX, or fails with PROMPTERIZE_TEST_FIX_FAILURE.
 *
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

const message = (requested: Model<Api>, text: string, stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
	role: "assistant",
	content: noText(stopReason) ? [] : [{ type: "text", text }],
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
	stopReason,
	...(stopReason === "error" ? { errorMessage: fixFailure ?? "the Fixer failed" } : {}),
	timestamp: Date.now(),
});

/** Whether a reply carries no text because the model failed. */
const noText = (stopReason: AssistantMessage["stopReason"]): boolean => stopReason === "error" || stopReason === "aborted";

export default function prompterizeTestProvider(pi: ExtensionAPI): void {
	const streamSimple = (requested: Model<Api>, context: Context, options?: SimpleStreamOptions) => {
		const system = [context.systemPrompt ?? "", ...context.messages.filter((message) => message.role === "system").map(textOf)]
			.filter(Boolean)
			.join("\n");
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
		const stream = createAssistantMessageEventStream();
		const failed = requested.provider === fixerProvider && fixFailure !== undefined;
		const text = requested.provider === fixerProvider ? fixReply : mainReply;
		const answer = message(requested, text, failed ? "error" : "stop");
		queueMicrotask(() => {
			if (failed) {
				stream.push({ type: "error", reason: "error", error: answer });
				return;
			}
			stream.push({ type: "start", partial: answer });
			stream.push({ type: "text_start", contentIndex: 0, partial: answer });
			stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: answer });
			stream.push({ type: "text_end", contentIndex: 0, content: text, partial: answer });
			stream.push({ type: "done", reason: "stop", message: answer });
		});
		return stream;
	};

	pi.registerProvider(fixerProvider, {
		name: "Prompterize test provider: the Fixer's model",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("deepseek-v4.1-flash"), model("flash")],
		streamSimple,
	});
	pi.registerProvider("prompterize-test", {
		name: "Prompterize test provider: the main model",
		api,
		apiKey: "test-key",
		baseUrl: "http://localhost:0",
		models: [model("main")],
		streamSimple,
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
