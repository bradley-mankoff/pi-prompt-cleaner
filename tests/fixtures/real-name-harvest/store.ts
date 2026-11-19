/** A temporary repo's prompt store: top-level declarations, a class and its members. */

export interface PromptRecord {
	promptText: string;
	fixerOutcome: string;
	changedByFixer(): boolean;
}

export type PromptFilter = (record: PromptRecord) => boolean;

export class PromptStore {
	private cachedRecords: PromptRecord[] = [];

	constructor(records: PromptRecord[]) {
		this.cachedRecords = records;
	}

	loadStoredPrompts(): PromptRecord[] {
		return this.cachedRecords;
	}

	archivePrompt(promptId: string): void {
		this.cachedRecords = this.cachedRecords.filter((record) => record.promptText !== promptId);
	}
}

export const DEFAULT_PROMPT_STORE = "prompts";

export function normaliseTypedPrompt(text: string): string {
	return text.trim();
}
