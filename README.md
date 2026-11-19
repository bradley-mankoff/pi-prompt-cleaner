# pi-prompterize

Prepares each prompt you type into pi before the main agent reads it. The Fixer silently fixes
the typos in a typed prompt and maps near-miss file and symbol names to the names the repo uses,
and the Clarity note lets the main agent ask when a prompt is unclear. The main agent receives the
fixed text, with no note of what changed.

## Install

```bash
pi install git:github.com/bradley-mankoff/pi-prompterize
```

Or try it for one session without installing:

```bash
pi -e ./pi-prompterize
```

The Fixer uses pi's own model credentials through `ctx.modelRegistry.streamSimple()`, so it
needs no API key of its own.

## What the Fixer touches

Only a **typed prompt** is fixed: input whose pi `input` event `source` is `"interactive"`.
Prompts written by RPC clients, the Factory, or another extension are sent through unchanged,
as are slash commands.

The Fixer has no timeout. If its model call fails, or the reply cannot be used, the prompt
goes on unchanged, so a broken Fixer never blocks your work.

While the Fixer waits on its model, pi's status line shows **fixing prompt…**, so you know pi is
busy rather than stuck. Press Esc to cancel the call: the prompt goes on exactly as you typed it,
and the Correction log records the run as `cancelled` with the time you waited. The status is
cleared however the call ends.

### Real names

Before the Fixer's model call, real-name lookup reads two sources. Git's file list answers in every
repo, tracked files and untracked ones alike, so a file an agent just wrote counts. Ripgrep then
harvests the declarations in the working tree: functions, classes, interfaces, types, constants,
class members and object-literal methods and properties, plus Python and Swift declarations. A
symbol typed without its underscores or capitals, such as `getuserbyid`, can find `getUserById`.
The harvest reads the files as they are, so it needs no index, never goes stale, and works inside
a git worktree as well as the main checkout.

For each word in the prompt that looks like a path or symbol, it finds at most five real names
close to it. The match ignores case, underscores, hyphens and dots, and allows a few wrong,
missing or extra letters, so `authsession`, `auth_sesion` and `src/auth-sesion.ts` all find
`src/auth-session.ts`.

Only those close matches go to the Fixer's model, each beside the word it is close to: never the
repo's whole file list or symbol list, and never the conversation. The Fixer's model maps a word
to the real name when it is clearly the one meant. When no real name is a confident match, it
keeps the word as typed and adds a **possibly hint** after it, such as
`(possibly src/auth-session.ts or src/auth-sessions.ts)`. The hint always says "possibly" and
never "likely", so the main agent does its own analysis instead of trusting a guess.

Every fix and every possibly hint, with its close matches, is listed in the Fixer's reply and
lands in the Correction log. Real-name lookup lives in `extensions/real-names.ts`; a repo with no
ripgrep, or a failing one, falls back to git's files alone, so no failure holds up a prompt.

### Protected spans

Text you wrote or chose on purpose is never the Fixer's to change. Before its model call, the
Fixer swaps each of these spans for an opaque placeholder that is random to that request, and puts
each span back afterwards, byte for byte:

- a code fence, from its opening line to its closing line;
- inline code, between a run of backticks and a closing run of the same length;
- a blockquote line, one that starts with `>`;
- an `http://` or `https://` URL;
- an `@` reference, such as `@src/parser.ts`.

The Fixer's model is told to keep every placeholder exactly as it is. The extension then checks
the reply by plain string comparison, not with a model: each placeholder must appear exactly once,
unchanged, and the reply may add none of its own. A reply that fails the check is rejected, the
Correction log records the outcome as `error`, and the prompt goes on exactly as typed.

pi's `input` event carries a prompt's text, its images and where it came from, but nothing that
says which part of the text was pasted. Pasted text that is none of the spans above is therefore
fixed like typed text.

### Skip prefix

Start a typed prompt with `*` to send it without the Fixer and without the Clarity note. The
`*` is stripped before the prompt goes on:

```text
*please leave this exactly as i typed it
```

The main agent receives `please leave this exactly as i typed it`.

## The Clarity note

A typed prompt that was not skipped also carries the **Clarity note** to the main agent. It
is added to the run's system prompt and asks the agent to judge the prompt before acting:

- If the prompt is clear, or the context makes the intent plain, the agent proceeds at once,
  so the note costs nothing on a clear prompt.
- If it is not clear, the agent first looks up what it can find for itself, then asks one
  **Question round** in the grilling skill's format: numbered questions, each with a suggested
  answer, where "yes" accepts all of them. It waits for the answer before working.
- If the prompt starts a whole new feature or project, the agent runs the grilling skill in
  full instead of asking one Question round.

The note adds no tool; the agent asks in its reply. Its text is adapted from severity1's
claude-code-prompt-improver (MIT, Copyright (c) 2025 severity1), whose notice sits beside the
text in `extensions/prompterize.ts`.

## Correction log

Every Fixer run is appended to `$XDG_DATA_HOME/pi-prompterize/corrections.jsonl`, falling back
to `~/.local/share/pi-prompterize/corrections.jsonl` when `XDG_DATA_HOME` is unset. The file
lives outside every repo, so it can never be committed or published by accident, and a later,
smarter model can study it. One line holds one run:

```json
{
  "id": "5f0c6c1e-7a4e-4a6c-8d0e-2b3f1a9c7d10",
  "time": "2026-11-18T21:16:00.000Z",
  "sessionId": "2b7c1f4e-...",
  "repoPath": "/Users/you/code/project",
  "remote": "https://github.com/you/project.git",
  "commit": "eabcbd2...",
  "model": "opencode-go/deepseek-v4.1-flash",
  "thinkingLevel": "low",
  "durationMs": 812,
  "outcome": "fixed",
  "original": "pleas fix teh authsesion check",
  "fixed": "Please fix the authsesion (possibly src/auth-session.ts or src/auth-sessions.ts) check",
  "changes": [
    { "from": "pleas", "to": "Please" },
    { "from": "teh", "to": "the" },
    { "word": "authsesion", "possibly": ["src/auth-session.ts", "src/auth-sessions.ts"] }
  ]
}
```

Each entry in `changes` is either a typo fix as a `from`/`to` pair, or a possibly hint: the `word`
as typed with the real names close to it.

`outcome` is `fixed`, `unchanged`, `error` or `cancelled`; an error record carries the failure's
message in `error` and the prompt as typed in `fixed`. A cancelled record carries the prompt as
typed in `fixed`, no error, and the time waited in `durationMs`. A repo with no remote records
`remote` as an empty string. Skipped prompts, slash commands, and prompts from RPC or another
extension are not logged as Fixer runs. Writing the log never stops or changes a prompt: when the
file cannot be written, the prompt still goes on.

When the Clarity note leads the main agent to ask a Question round, the Boss's next typed prompt
is its answer, and the round is appended to the same file as a Question round record. The round is
recognised by the grilling skill's `❓ **Q` marker in the agent's final reply. One line holds one
round:

```json
{
  "id": "9a1d7c2e-3f5b-4d8a-9c1e-6b0f2a4d8e13",
  "fixerRecordId": "5f0c6c1e-7a4e-4a6c-8d0e-2b3f1a9c7d10",
  "prompt": "fix the parser",
  "questions": [
    "❓ **Q1** - **Which parser?**\n\nThe repo has two parsers.\n\nShould I change the JSON parser?\n\n➡️ Yes, change the JSON parser.",
    "❓ **Q2** - **Which call site?**\n\nI found two callers.\n\nShould I change both?\n\n➡️ Yes, change both."
  ],
  "answers": "yes",
  "repoPath": "/Users/you/code/project",
  "remote": "https://github.com/you/project.git",
  "commit": "eabcbd2..."
}
```

`fixerRecordId` is the id of the Fixer record for the prompt that caused the round, so the two can
be studied together. With the Fixer off there is no such record, so that field is left out and
`prompt` holds the prompt itself. Each question keeps its body and suggested answer. A slash
command, or a prompt from RPC or another extension, is not the Boss's next typed prompt, so the
record waits for the next one. A typed prompt that starts with the Skip prefix still answers the
round: the prefix changes only how the answer is sent, so it is left out of `answers`.

## Settings

Settings live under a `prompterize` key in pi's `settings.json`, either the global file
(`~/.pi/agent/settings.json`) or a project's `.pi/settings.json`:

```json
{
  "prompterize": {
    "fixer": {
      "enabled": true,
      "model": "opencode-go/deepseek-v4.1-flash",
      "thinkingLevel": "low"
    },
    "clarity": {
      "enabled": true
    }
  }
}
```

| Setting | Default | What it means |
|---|---|---|
| `prompterize.fixer.enabled` | `true` | Whether typed prompts go to the Fixer. `false` sends them unchanged. |
| `prompterize.fixer.model` | `"opencode-go/deepseek-v4.1-flash"` | The Fixer's model, as `provider/id`. |
| `prompterize.fixer.thinkingLevel` | `"low"` | The Fixer's thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |
| `prompterize.clarity.enabled` | `true` | Whether typed prompts carry the Clarity note. `false` leaves it out while the Fixer still runs. |

An omitted setting takes its default. A thinking level pi does not offer falls back to the
default level. A model that pi cannot find sends the prompt on unchanged.

## Development

```bash
npm test
```

The tests drive the seam the Spec names: a real pi session that loads the extension, with a
test provider at the provider edge playing both the Fixer's model and the main model, under a
temporary `HOME`, `XDG_DATA_HOME` and git repo. They check what the main model received,
including the Clarity note, and what the Correction log holds, not how the extension is built.

The status line and Esc need an interactive session. Their tests run the same pi session
in-process through pi's SDK, with a stand-in at pi's UI edge that records the statuses the
footer would show and presses Esc; the provider fixture stays at the provider edge.

## Where this comes from

This work started from **pi-promptimize** by **Dimitri Tholen**
([github.com/dimitritholen/pi-promptimize](https://github.com/dimitritholen/pi-promptimize)),
a pi prompt rewriter with a model picker and a review popup, first seen in his
r/PiCodingAgent post. pi-prompterize takes a different design: no popup and no review step,
and only typos and real names change.

The rest of the design credits these projects:

- **severity1's claude-code-prompt-improver** (MIT): the Clarity note that asks the main agent
  whether a prompt is clear enough to act on.
- **tigercat1124's pi-optimize-prompt**: leaving `@` references alone and the placeholder
  guard that rejects a reply which changes protected text.
- **Matt Pocock's grilling skill**: the Question round format the main agent uses when a
  prompt is unclear.

Where text is adapted from those projects, their copyright notice is kept beside it.

## License

MIT. See [LICENSE](LICENSE).
