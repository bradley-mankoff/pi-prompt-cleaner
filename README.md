# pi-prompterize

Prepares each prompt you type into pi before the main agent reads it. Today that means the
Fixer: a cheap, fast model that silently fixes the typos in a typed prompt, so you can type
fast without correcting every word yourself. The main agent receives the fixed text, with no
note of what changed.

Later versions add real-name lookup for symbols and file paths, and a Clarity note that lets
the main agent ask when a prompt is unclear. See the project's Beads for that work.

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

### Skip prefix

Start a typed prompt with `*` to send it without the Fixer (and, later, without the Clarity
note). The `*` is stripped before the prompt goes on:

```text
*please leave this exactly as i typed it
```

The main agent receives `please leave this exactly as i typed it`.

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
  "original": "pleas fix teh parser",
  "fixed": "Please fix the parser.",
  "changes": [
    { "from": "pleas", "to": "Please" },
    { "from": "teh", "to": "the" }
  ]
}
```

`outcome` is `fixed`, `unchanged` or `error`; an error record carries the failure's message in
`error` and the prompt as typed in `fixed`. A repo with no remote records `remote` as an empty
string. Skipped prompts, slash commands, and prompts from RPC or another extension are not
logged. Writing the log never stops or changes a prompt: when the file cannot be written, the
prompt still goes on.

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
    }
  }
}
```

| Setting | Default | What it means |
|---|---|---|
| `prompterize.fixer.enabled` | `true` | Whether typed prompts go to the Fixer. `false` sends them unchanged. |
| `prompterize.fixer.model` | `"opencode-go/deepseek-v4.1-flash"` | The Fixer's model, as `provider/id`. |
| `prompterize.fixer.thinkingLevel` | `"low"` | The Fixer's thinking level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`. |

An omitted setting takes its default. A thinking level pi does not offer falls back to the
default level. A model that pi cannot find sends the prompt on unchanged.

## Development

```bash
npm test
```

The tests drive the seam the Spec names: a real pi session that loads the extension, with a
test provider at the provider edge playing both the Fixer's model and the main model, under a
temporary `HOME`, `XDG_DATA_HOME` and git repo. They check what the main model received and
what the Correction log holds, not how the extension is built.

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
