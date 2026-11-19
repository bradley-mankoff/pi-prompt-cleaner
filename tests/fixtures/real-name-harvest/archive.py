"""A temporary repo's archive: top-level declarations, a class and its members, and dict keys."""

PROMPT_SUMMARY_HEADER = "Prompts"


class PromptArchive:
    archive_bucket = "prompts"
    retention_days = 30

    def __init__(self, records: list[dict]) -> None:
        self.archive_records = records

    async def collect_archived_prompts(self) -> list[dict]:
        return self.archive_records


def render_prompt_summary(record: dict) -> str:
    return record["promptText"]


ARCHIVE_LAYOUT = {
    "sidebarTitle": "Prompts",
    "emptyArchiveSummary": "No prompts yet",
}
