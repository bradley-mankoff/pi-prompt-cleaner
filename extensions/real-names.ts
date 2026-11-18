/**
 * Real-name lookup: for each word in a prompt that looks like a path or symbol, the short list of
 * real names close to it, so the Fixer's model can map a near miss to the name the repo really
 * uses. Only the close matches reach the model, never the whole list and never the conversation.
 *
 * There are two sources. Git's tracked file list answers in every repo. When the `gitnexus`
 * command lists the current repo as indexed, the symbols from that index are offered alongside
 * the paths, so a symbol typed without its underscores or capitals can find its real name. A
 * repo with no index, a missing `gitnexus`, or a failing one falls back to git's files alone.
 *
 * The match is local and fuzzy: case, underscores, hyphens and dots are ignored, and a few wrong,
 * missing or extra letters are tolerated. A real name is compared by its whole path, its file name
 * and its file name without its extension, so a word typed without a path or an extension still
 * finds the file it names.
 */
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One word from the prompt that looks like a path or symbol, with the real names close to it. */
export type RealNameMatch = { word: string; names: string[] };

/** One real name, with the forms of it that a typed word is matched against. */
type RealNameKeys = { name: string; keys: string[] };

/** How many close real names one word may carry to the Fixer's model. */
const MAX_NAMES = 5;

/** A word shorter than this is too likely to be an ordinary short word to look up. */
const MIN_WORD_LENGTH = 4;

/**
 * The graph's symbol node labels, taken from GitNexus 1.6.12's own `SYMBOL_NODE_LABELS`: the node
 * kinds it counts as a resolvable code symbol. Files and folders are left out because git already
 * lists the paths, and sections and communities are prose and clusters rather than names to type.
 */
const SYMBOL_LABELS = [
	"Function",
	"Method",
	"Class",
	"Protocol",
	"Category",
	"Interface",
	"CodeElement",
	"Struct",
	"Enum",
	"Macro",
	"Typedef",
	"Union",
	"Namespace",
	"Trait",
	"Impl",
	"TypeAlias",
	"Const",
	"Static",
	"Variable",
	"Property",
	"Record",
	"Delegate",
	"Annotation",
	"Constructor",
	"Template",
	"Module",
];

/** The query whose one column holds every symbol name in the current repo's index. */
const SYMBOL_QUERY = [
	"MATCH (n)",
	`WHERE labels(n) IN [${SYMBOL_LABELS.map((label) => `'${label}'`).join(", ")}]`,
	"AND n.name IS NOT NULL",
	"RETURN DISTINCT n.name AS name",
].join(" ");

/**
 * The close real names for every suspect word in `text`, from git's tracked files in `cwd` and,
 * when the repo is indexed, the symbols in its GitNexus index. One entry per distinct word, in the
 * order the words appear; each entry carries at most five names, nearest first. A folder git or
 * gitnexus cannot answer for offers no names of that kind rather than failing.
 */
export async function closeRealNames(pi: ExtensionAPI, cwd: string, text: string): Promise<RealNameMatch[]> {
	const words = suspectWords(text);
	if (words.length === 0) return [];
	const [tracked, symbols] = await Promise.all([trackedFileNames(pi, cwd), indexedSymbolNames(pi, cwd)]);
	const names = [...new Set([...tracked, ...symbols])];
	const realNames: RealNameKeys[] = names.map((name) => ({ name, keys: matchKeys(name) }));
	const matches: RealNameMatch[] = [];
	const seen = new Set<string>();
	for (const word of words) {
		if (seen.has(word)) continue;
		seen.add(word);
		const close = closeNamesFor(normalise(word), realNames);
		if (close.length > 0) matches.push({ word, names: close });
	}
	return matches;
}

/** The paths git tracks in `cwd`, one per line; none when git cannot list them. */
async function trackedFileNames(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const listed = await pi.exec("git", ["ls-files"], { cwd });
		if (listed.code !== 0) return [];
		return listed.stdout
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
	} catch {
		// A repo git cannot answer for is a repo with no real names to offer, never a failed Fixer.
		return [];
	}
}

/**
 * The symbols in the current repo's GitNexus index, or none when the `gitnexus` command is
 * missing or fails, or when its list of indexed repositories does not name this repo. The list is
 * what says the index answers for this repo, so a repo absent from it falls back to git's files.
 */
async function indexedSymbolNames(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	try {
		const listed = await pi.exec("gitnexus", ["list"], { cwd });
		if (listed.code !== 0 || !listsRepo(listed.stdout, cwd)) return [];
		const queried = await pi.exec("gitnexus", ["cypher", SYMBOL_QUERY], { cwd });
		if (queried.code !== 0) return [];
		return symbolNamesIn(queried.stdout);
	} catch {
		// A missing or broken gitnexus is a repo with no index to offer, never a failed Fixer.
		return [];
	}
}

/** Whether the command's list of indexed repositories holds the repo that `cwd` sits in. */
function listsRepo(listOutput: string, cwd: string): boolean {
	const here = canonicalPath(cwd);
	return listedRepoPaths(listOutput).some((path) => {
		const inside = relative(canonicalPath(path), here);
		return inside === "" || (!inside.startsWith(`..${sep}`) && inside !== ".." && !isAbsolute(inside));
	});
}

/** The repo paths in `gitnexus list`'s output, one per `Path:` line. */
function listedRepoPaths(listOutput: string): string[] {
	return [...listOutput.matchAll(/^\s*Path:\s+(.+?)\s*$/gm)].map((match) => match[1]);
}

/** `path` with symlinks resolved, or as given when it cannot be read. */
function canonicalPath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
}

/**
 * The one column of names in the markdown table `gitnexus cypher` prints, or none when the output
 * is not that table. Its first two lines are the column name and the table's separator.
 */
function symbolNamesIn(output: string): string[] {
	const start = output.search(/[[{]/);
	if (start < 0) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(output.slice(start));
	} catch {
		return [];
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
	const markdown = (parsed as { markdown?: unknown }).markdown;
	if (typeof markdown !== "string") return [];
	return markdown
		.split("\n")
		.slice(2)
		.map((line) => line.trim())
		.filter((line) => line.startsWith("|") && line.endsWith("|"))
		.map((line) => line.slice(1, -1).trim())
		.filter((name) => name.length > 0 && !name.includes("|"));
}

/**
 * The words worth looking up: those made only of name characters, at least four letters or digits
 * long once case and separators are ignored. The edge punctuation of a sentence's word is dropped
 * first; a placeholder or any other token carrying a mark a name never has is left out.
 */
function suspectWords(text: string): string[] {
	const words: string[] = [];
	for (const raw of text.split(/\s+/)) {
		const word = raw.replace(/^[^\w./-]+/, "").replace(/[^\w./-]+$/, "");
		if (!/^[A-Za-z0-9_./-]+$/.test(word)) continue;
		if (normalise(word).length < MIN_WORD_LENGTH) continue;
		words.push(word);
	}
	return words;
}

/** The forms of `text` the match ignores: case, underscores, hyphens and dots all go. */
function normalise(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The forms of one real name a typed word may match: its path, its file name and its file stem. */
function matchKeys(name: string): string[] {
	const base = name.slice(name.lastIndexOf("/") + 1);
	const dot = base.lastIndexOf(".");
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return [...new Set([name, base, stem].map(normalise).filter((key) => key.length > 0))];
}

/**
 * How many letters one normalised word may have wrong, missing or extra: one for every four
 * characters of it, and always at least one, so a short word may still misspell a real name.
 */
function toleranceFor(query: string): number {
	return Math.max(1, Math.floor(query.length / 4));
}

/** The real names close to one normalised word, nearest first and at most `MAX_NAMES` of them. */
function closeNamesFor(query: string, realNames: RealNameKeys[]): string[] {
	const tolerance = toleranceFor(query);
	const close: { name: string; distance: number }[] = [];
	for (const { name, keys } of realNames) {
		let distance = tolerance + 1;
		for (const key of keys) distance = Math.min(distance, editDistance(query, key, tolerance));
		if (distance <= tolerance) close.push({ name, distance });
	}
	return close
		.sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
		.slice(0, MAX_NAMES)
		.map(({ name }) => name);
}

/**
 * The edit distance between two strings, or `limit + 1` when the length alone already proves the
 * distance is over `limit`. A typed word is compared with each form of a real name, so a few wrong,
 * missing or extra letters still match.
 */
function editDistance(left: string, right: string, limit: number): number {
	if (Math.abs(left.length - right.length) > limit) return limit + 1;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 1; i <= left.length; i += 1) {
		const current = [i];
		for (let j = 1; j <= right.length; j += 1) {
			const cost = left[i - 1] === right[j - 1] ? 0 : 1;
			current.push(Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost));
		}
		previous = current;
	}
	return previous[right.length];
}
