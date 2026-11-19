/** A temporary repo's layout: an object literal with methods and properties. */

export const promptLayout = {
	sidebarHeading: "Prompts",
	emptyArchiveNotice: "No prompts yet",
	renderPromptBadge(record) {
		return record.promptText;
	},
};
