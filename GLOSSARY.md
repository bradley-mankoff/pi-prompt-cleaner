# pi-prompterize

A pi package that prepares each prompt the Boss types before the main agent reads it: it fixes typing, and it lets the agent ask when the prompt is unclear.

## Language

**Typed prompt**:
A prompt the Boss types into an interactive pi session. Prompts written by a Factory node, an extension or RPC are not typed prompts.
_Avoid_: user input, message

**Fixer**:
The part that sends a typed prompt to a cheap, fast model and silently replaces typos and near-miss symbol names before the main agent sees it.
_Avoid_: rewriter, enhancer, optimizer

**Real name**:
A symbol from the repo's GitNexus index, or a file path from git's file list when the repo has no index, that the Fixer may map a typed word to.
_Avoid_: identifier, candidate

**Protected span**:
Text the Boss wrote or chose on purpose, which the Fixer may never change: a code fence, inline code, a blockquote line, a URL or an `@` reference.
_Avoid_: ignored text, skip region, mask

**Placeholder**:
An opaque token, random to one Fixer request, that stands in for one protected span in the prompt the Fixer's model sees and is swapped back for that span after the reply passes the guard.
_Avoid_: marker, sentinel

**Possibly hint**:
The words "(possibly `A` or `B`)" the Fixer adds after a word it cannot map with confidence, leaving the word itself unchanged so the main agent checks for itself.
_Avoid_: likely hint, suggestion

**Clarity note**:
A short instruction, adapted from severity1's claude-code-prompt-improver, added to each typed prompt; it asks the main agent to judge whether the prompt is clear enough to act on.
_Avoid_: gate, wrapper, nudge

**Question round**:
The one round of numbered questions, each with a suggested answer, in the grilling skill's format, that the main agent asks when the Clarity note finds a prompt unclear.
_Avoid_: interview, clarification

**Correction log**:
The one JSONL file outside every repo where each Fixer run and each Question round is recorded for later study by a smarter, slower model.
_Avoid_: history, audit log

**Skip prefix**:
A leading `*` on a typed prompt, which sends it with neither the Fixer nor the Clarity note.
_Avoid_: bypass
