/**
 * The typo cases the real-name harvest is judged by. Each case is one word the Boss might type,
 * with one typo from the research's controlled test (a deleted character, wrong case, missing
 * underscores or hyphens, or transposed letters), and the real name the Fixer must offer first
 * for it. The declarations behind the names are in this folder's `store.ts`, `layout.js`,
 * `archive.py` and `badge.swift`, one file per language.
 */

/** One word a test types, and the real name that must rank first for it. */
export type TypoCase = { typed: string; realName: string };

/** TypeScript: a class and its members, an interface, a type, a top-level function and a const. */
export const typescriptTypoCases: TypoCase[] = [
	{ typed: "PromptStroe", realName: "PromptStore" },
	{ typed: "promptrecrod", realName: "PromptRecord" },
	{ typed: "PromptFiltr", realName: "PromptFilter" },
	{ typed: "normaliseTypedPromt", realName: "normaliseTypedPrompt" },
	{ typed: "NORMALISETYPEDPROMPT", realName: "normaliseTypedPrompt" },
	{ typed: "loadStoredPromps", realName: "loadStoredPrompts" },
	{ typed: "cachedRecrods", realName: "cachedRecords" },
	{ typed: "changedByFixr", realName: "changedByFixer" },
	{ typed: "DEFAULTPROMPTSTORE", realName: "DEFAULT_PROMPT_STORE" },
];

/** JavaScript: an object literal's methods, properties and the binding that holds it. */
export const javaScriptTypoCases: TypoCase[] = [
	{ typed: "renderPromtBadge", realName: "renderPromptBadge" },
	{ typed: "sidbarTitle", realName: "sidebarTitle" },
	{ typed: "emptyArchveNotice", realName: "emptyArchiveNotice" },
	{ typed: "promptlayuot", realName: "promptLayout" },
];

/** Python: a class with attributes and a method, an instance attribute, a function and dict keys. */
export const pythonTypoCases: TypoCase[] = [
	{ typed: "PromptArchiv", realName: "PromptArchive" },
	{ typed: "collectArchivedPrompt", realName: "collect_archived_prompts" },
	{ typed: "archive_buckt", realName: "archive_bucket" },
	{ typed: "retention_dyas", realName: "retention_days" },
	{ typed: "archive_recrods", realName: "archive_records" },
	{ typed: "PROMPTSUMMARYHEADER", realName: "PROMPT_SUMMARY_HEADER" },
	{ typed: "renderpromptsumary", realName: "render_prompt_summary" },
	{ typed: "sidebarTitel", realName: "sidebarTitle" },
	{ typed: "emptyArchiveSumary", realName: "emptyArchiveSummary" },
];

/** Swift: a struct with properties and a method, and a top-level function. */
export const swiftTypoCases: TypoCase[] = [
	{ typed: "PromptBadg", realName: "PromptBadge" },
	{ typed: "BADGECOLOUR", realName: "badgeColour" },
	{ typed: "accessibilityLable", realName: "accessibilityLabel" },
	{ typed: "renderBadgeCaptoin", realName: "renderBadgeCaption" },
	{ typed: "formatPromptCont", realName: "formatPromptCount" },
];
