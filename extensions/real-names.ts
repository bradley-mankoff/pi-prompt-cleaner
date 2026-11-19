/**
 * Real-name lookup: for each word in a prompt that looks like a path or symbol, the short list of
 * real names close to it, so the Fixer's model can map a near miss to the name the repo really
 * uses. Only the close matches reach the model, never the whole list and never the conversation.
 *
 * There are two sources, both inside a git working tree. Git's file list answers, and it includes
 * untracked files, so a file the agent just wrote counts. Ripgrep harvests declarations from the
 * working tree in this process: functions, classes, interfaces, types, constants, class members,
 * object-literal methods and properties, Python functions, classes, attributes and dict keys, and
 * Swift types, functions and properties. The harvest reads the files as they are, so it needs no
 * index, never goes stale, and answers in a git worktree as it does in the main checkout. A repo
 * with no `rg`, or a failing one, falls back to git's files alone.
 *
 * A folder outside a git repo has no working tree to read, so it offers no real names and nothing
 * scans it: a home folder can hold gigabytes, and no symbol in it is a real name for the Fixer.
 * Inside a repo the harvest reads only files under a megabyte and stops after two seconds, so a
 * large generated file or a very large tree cannot hang a prompt.
 *
 * The harvest reads declarations by their line, so a signature split across lines is not harvested,
 * and a line that only looks like a declaration inside a comment or string is not matched because
 * every pattern starts at the line's first non-space character.
 *
 * The match is local and fuzzy: case, underscores, hyphens and dots are ignored, and a few wrong,
 * missing or extra letters are tolerated. A real name is compared by its whole path, its file name
 * and its file name without its extension, so a word typed without a path or an extension still
 * finds the file it names.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One word from the prompt that looks like a path or symbol, with the real names close to it. */
export type RealNameMatch = { word: string; names: string[] };

/** One real name, with the forms of it that a typed word is matched against. */
type RealNameKeys = { name: string; keys: string[] };

/** How many close real names one word may carry to the Fixer's model. */
const MAX_NAMES = 5;

/** A word shorter than this is too likely to be an ordinary short word to look up. */
const MIN_WORD_LENGTH = 4;

/** The file types ripgrep is asked for, the languages the declaration patterns understand. */
const SOURCE_TYPES = ["--type", "ts", "--type", "js", "--type", "py", "--type", "swift"];

/** The largest file the harvest reads: a bigger one is generated or minified, not hand-written. */
const MAX_HARVEST_FILE_SIZE = "1M";

/** How long ripgrep may run before the harvest gives up on it, in milliseconds. */
const HARVEST_TIMEOUT_MS = 2000;

/** The extensions whose declarations the TypeScript/JavaScript patterns read. */
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".vue"]);

/** The extensions whose declarations the Python patterns read. */
const PYTHON_EXTENSIONS = new Set([".py", ".pyi"]);

/**
 * The lines worth reading from a source file, as a fast ripgrep pre-filter: a line that starts
 * with a declaration keyword or modifier, a name and a type annotation, a member signature, a
 * quoted object key, or a name and an assignment. The patterns below decide what each line
 * declares; this one only keeps ripgrep from printing the rest of the file.
 */
const DECLARATION_LINE = String.raw`^\s*(?:(?:@\w+(?:\([^)\n]*\))?\s+)*(?:export|default|declare|abstract|async|public|private|protected|static|readonly|override|final|open|internal|fileprivate|mutating|nonmutating|convenience|required|indirect|lazy|weak|unowned|get|set|const|let|var|function|func|class|interface|type|typealias|enum|namespace|module|struct|protocol|extension|actor|trait|impl|def|fn|record|val)\b|^\s+[A-Za-z_$][A-Za-z0-9_$]*\s*\??\s*:|^\s+[A-Za-z_$][A-Za-z0-9_$]*\s*(?:<[^()\n]*>)?\s*\(|^\s*[A-Za-z_][A-Za-z0-9_.]*\s*(?::[^=\n]+)?=|^\s*["'][^"']+["']\s*:)`;

/** A TypeScript/JavaScript declaration keyword followed by the name it declares. */
const TYPESCRIPT_DECLARATION =
	/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\s*\*?|class|interface|type|enum|namespace|const\s+enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

/** A top-level TypeScript/JavaScript binding, which is the only place a const/let/var is real. */
const TYPESCRIPT_BINDING = /^(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)/;

/** A TypeScript/JavaScript class field, interface member or object property written as `name:`. */
const TYPESCRIPT_PROPERTY =
	/^\s+(?:(?:public|private|protected|static|readonly|override|abstract|declare|async|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\??\s*:/;

/** A TypeScript/JavaScript class field or object property whose type is inferred from `=`. */
const TYPESCRIPT_FIELD =
	/^\s+(?:(?:public|private|protected|static|readonly|override|abstract|declare)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::[^=]+)?=\s*/;

/** A TypeScript/JavaScript class or object method whose whole signature sits on one line. */
const TYPESCRIPT_METHOD =
	/^\s+(?:(?:public|private|protected|static|readonly|override|abstract|declare|async|get|set)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^()]*>)?\s*\([^)]*\)\s*(?::\s*[^;={]+)?\s*\{\s*$/;

/** A TypeScript/JavaScript interface or type-literal method signature, which ends in a semicolon. */
const TYPESCRIPT_SIGNATURE =
	/^\s+(?:(?:readonly|new)\s+)*([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^()]*>)?\s*\([^)]*\)\s*(?::\s*[^;{}]+)?;\s*$/;

/** A quoted object key, such as a key of a JavaScript object or a TypeScript type literal. */
const TYPESCRIPT_QUOTED_KEY = /^\s+["']([^"']+)["']\s*:/;

/** The words a one-line method pattern would otherwise read as a name. */
const TYPESCRIPT_METHOD_KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "with", "constructor"]);

/** The words a member pattern would otherwise read as an object key. */
const TYPESCRIPT_PROPERTY_KEYWORDS = new Set(["default", "case", "else"]);

/** A Python function or method, with or without `async`, and the name it declares. */
const PYTHON_FUNCTION = /^\s*(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** A Python class and the name it declares. */
const PYTHON_CLASS = /^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** A Python module-level binding, the only place a top-level name is declared by assignment. */
const PYTHON_MODULE_BINDING = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/;

/** A Python attribute assigned through `self`, which declares an instance attribute. */
const PYTHON_SELF_BINDING = /^\s+self\.([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/;

/** A Python assignment inside a class body, which declares a class attribute. */
const PYTHON_CLASS_BINDING = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=/;

/** A Python dict key, the language's object-literal property. */
const PYTHON_QUOTED_KEY = /^\s*["']([^"']+)["']\s*:/;

/** A Swift function or method, with its access and mutation modifiers, and the name it declares. */
const SWIFT_FUNCTION =
	/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|static|class|final|mutating|nonmutating|override|convenience|required|indirect|lazy|weak|unowned)\s+)*func\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** A Swift type declaration and the name it declares. */
const SWIFT_TYPE =
	/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(?:class|struct|protocol|enum|actor|extension|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)/;

/** A Swift stored property or constant, which must be in a type's body to be a property. */
const SWIFT_PROPERTY =
	/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|static|final|lazy|weak|unowned|override|required)\s+)*(?:var|let)\s+([A-Za-z_][A-Za-z0-9_]*)\s*[:=]/;

/**
 * The close real names for every suspect word in `text`, from git's tracked and untracked files in
 * `cwd` and from the declarations ripgrep harvests out of those files. One entry per distinct word,
 * in the order the words appear; each entry carries at most five names, nearest first. A folder
 * outside a git working tree has no names to offer, and a source that cannot answer subtracts
 * itself rather than failing the Fixer.
 */
export async function closeRealNames(pi: ExtensionAPI, cwd: string, text: string): Promise<RealNameMatch[]> {
	const words = suspectWords(text);
	if (words.length === 0) return [];
	const files = await gitFileNames(pi, cwd);
	// No working tree means no real names: a scan of a folder outside a repo is unbounded and
	// offers the Fixer nothing, so it is never started.
	if (files === null) return [];
	const symbols = await harvestedSymbolNames(pi, cwd);
	const names = [...new Set([...files, ...symbols])];
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

/**
 * The standard output of `command` run with `args` in `cwd`, or null when the command is missing,
 * cannot start or exits non-zero. A lookup that cannot answer offers nothing rather than failing
 * the Fixer.
 */
async function commandOutput(
	pi: ExtensionAPI,
	command: string,
	args: string[],
	cwd: string,
): Promise<string | null> {
	try {
		const result = await pi.exec(command, args, { cwd });
		return result.code === 0 ? result.stdout : null;
	} catch {
		return null;
	}
}

/**
 * The standard output of ripgrep, or null when the command is missing, cannot start or fails.
 * Ripgrep exits 1 when it finds no match, which is an answer rather than a failure, so that code
 * comes back as an empty output. It exits 2 when some files could not be read but still prints
 * every match from the files it could, so its output is used instead of thrown away over one
 * unreadable file. A run stopped at the harvest's timeout still carries the matches printed so far.
 */
async function ripgrepOutput(pi: ExtensionAPI, args: string[], cwd: string): Promise<string | null> {
	try {
		const result = await pi.exec("rg", args, { cwd, timeout: HARVEST_TIMEOUT_MS });
		if (result.code === 0 || result.code === 2) return result.stdout;
		return result.code === 1 ? "" : null;
	} catch {
		return null;
	}
}

/**
 * The paths git tracks or leaves untracked in `cwd`, one per line, with ignored files left out;
 * null when git cannot list them, which is how a folder outside a git working tree answers.
 * `--others` is what makes a file the agent just wrote count.
 */
async function gitFileNames(pi: ExtensionAPI, cwd: string): Promise<string[] | null> {
	const listed = await commandOutput(pi, "git", ["ls-files", "--cached", "--others", "--exclude-standard"], cwd);
	return listed === null ? null : nonEmptyLines(listed);
}

/** The lines of `output` that hold something, trimmed. */
function nonEmptyLines(output: string): string[] {
	return output
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

/**
 * The declaration names in the working tree under `cwd`, harvested by one ripgrep pass and read
 * from the lines it matched. The pass reads only files under a megabyte and gives up after two
 * seconds. A file that has disappeared since ripgrep read it offers nothing, and a repo with no
 * declarations answers with an empty list.
 */
async function harvestedSymbolNames(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const output = await ripgrepOutput(
		pi,
		[
			"--json",
			"--no-messages",
			...SOURCE_TYPES,
			"--max-filesize",
			MAX_HARVEST_FILE_SIZE,
			"-e",
			DECLARATION_LINE,
			".",
		],
		cwd,
	);
	if (output === null) return [];
	const names = new Set<string>();
	for (const [path, lineNumbers] of matchedLines(output)) {
		let text: string;
		try {
			text = readFileSync(join(cwd, path), "utf8");
		} catch {
			continue;
		}
		const lines = text.split("\n");
		const extension = extensionOf(path);
		for (const lineNumber of lineNumbers) {
			const name = declaredNameAt(extension, lines, lineNumber - 1);
			// A name too short to be a suspect word can never be matched, and only adds noise.
			if (name !== undefined && normalise(name).length >= MIN_WORD_LENGTH) names.add(name);
		}
	}
	return [...names];
}

/** The line numbers ripgrep matched, grouped by the file they are in. */
function matchedLines(output: string): Map<string, number[]> {
	const byPath = new Map<string, number[]>();
	for (const line of output.split("\n")) {
		if (line.length === 0) continue;
		let event: unknown;
		try {
			event = JSON.parse(line);
		} catch {
			continue;
		}
		if (typeof event !== "object" || event === null) continue;
		const { type, data } = event as { type?: unknown; data?: { path?: { text?: unknown }; line_number?: unknown } };
		if (type !== "match" || typeof data?.path?.text !== "string" || typeof data.line_number !== "number") continue;
		const numbers = byPath.get(data.path.text) ?? [];
		numbers.push(data.line_number);
		byPath.set(data.path.text, numbers);
	}
	return byPath;
}

/** The file extension of `path`, in lower case, or the whole path when it has none. */
function extensionOf(path: string): string {
	const dot = path.lastIndexOf(".");
	return dot < 0 ? path : path.slice(dot).toLowerCase();
}

/** The name the line at `index` declares in a file of `extension`, or none when it declares one. */
function declaredNameAt(extension: string, lines: string[], index: number): string | undefined {
	const line = lines[index];
	if (line === undefined) return undefined;
	if (TYPESCRIPT_EXTENSIONS.has(extension)) return typescriptNameAt(line, lines, index);
	if (PYTHON_EXTENSIONS.has(extension)) return pythonNameAt(line, lines, index);
	if (extension === ".swift") return swiftNameAt(line, lines, index);
	return undefined;
}

/** The name one TypeScript or JavaScript line declares, or none. */
function typescriptNameAt(line: string, lines: string[], index: number): string | undefined {
	const declaration = TYPESCRIPT_DECLARATION.exec(line) ?? TYPESCRIPT_BINDING.exec(line);
	if (declaration !== null) return declaration[1];
	// A member is only a member when the block around it holds members. This is what keeps a
	// function's parameters, which are `name: Type` lines too, out of the symbol list.
	if (!opensObjectBody(enclosingOpener(lines, index))) return undefined;
	const property = TYPESCRIPT_PROPERTY.exec(line);
	if (property !== null && !TYPESCRIPT_PROPERTY_KEYWORDS.has(property[1])) return property[1];
	const field = TYPESCRIPT_FIELD.exec(line);
	if (field !== null && !TYPESCRIPT_PROPERTY_KEYWORDS.has(field[1])) return field[1];
	const method = TYPESCRIPT_METHOD.exec(line);
	if (method !== null && !TYPESCRIPT_METHOD_KEYWORDS.has(method[1])) return method[1];
	const signature = TYPESCRIPT_SIGNATURE.exec(line);
	if (signature !== null && !TYPESCRIPT_METHOD_KEYWORDS.has(signature[1])) return signature[1];
	return TYPESCRIPT_QUOTED_KEY.exec(line)?.[1];
}

/** The name one Python line declares, or none. */
function pythonNameAt(line: string, lines: string[], index: number): string | undefined {
	const declaration = PYTHON_FUNCTION.exec(line) ?? PYTHON_CLASS.exec(line);
	if (declaration !== null) return declaration[1];
	if (indentationOf(line) === 0) {
		const binding = PYTHON_MODULE_BINDING.exec(line);
		if (binding !== null) return binding[1];
	}
	const selfBinding = PYTHON_SELF_BINDING.exec(line);
	if (selfBinding !== null) return selfBinding[1];
	// An assignment inside a class body is a class attribute; one inside a function or a module's
	// block is a local, so the block above the line decides.
	const classBinding = PYTHON_CLASS_BINDING.exec(line);
	if (classBinding !== null && opensPythonClassBody(enclosingOpener(lines, index))) return classBinding[1];
	return PYTHON_QUOTED_KEY.exec(line)?.[1];
}

/** The name one Swift line declares, or none. */
function swiftNameAt(line: string, lines: string[], index: number): string | undefined {
	const declaration = SWIFT_FUNCTION.exec(line) ?? SWIFT_TYPE.exec(line);
	if (declaration !== null) return declaration[1];
	// A var or let inside a function is a local; inside a type's body it is a property.
	const property = SWIFT_PROPERTY.exec(line);
	if (property !== null && (indentationOf(line) === 0 || opensSwiftTypeBody(enclosingOpener(lines, index)))) {
		return property[1];
	}
	return undefined;
}

/** The number of leading spaces and tabs on `line`, which is how nested blocks are told apart. */
function indentationOf(line: string): number {
	return line.length - line.trimStart().length;
}

/** The nearest line above `index` with a smaller indentation, which opened its block, or none. */
function enclosingOpener(lines: string[], index: number): string | undefined {
	const indentation = indentationOf(lines[index]);
	for (let above = index - 1; above >= 0; above -= 1) {
		if (lines[above].trim().length === 0) continue;
		if (indentationOf(lines[above]) < indentation) return lines[above].trim();
	}
	return undefined;
}

/**
 * Whether `line` opens a block that holds class, interface, type or object members rather than
 * statements: `class X {`, `interface X {`, `type X = {`, `const x = {`, `foo({`, `return {`.
 * A function, method, arrow or control block holds statements, so a `name: Type` line in it is a
 * parameter or a label rather than a member.
 */
function opensObjectBody(line: string | undefined): boolean {
	if (line === undefined) return true;
	const body = line.trimEnd();
	if (!body.endsWith("{")) return false;
	const before = body.slice(0, -1).trimEnd();
	if (/\b(?:class|interface|type|enum|namespace)\b/.test(before)) return true;
	if (before === "" || before.endsWith("(") || before.endsWith("[") || before.endsWith(",")) return true;
	if (before.endsWith("=") || before.endsWith(":") || /\breturn$/.test(before)) return true;
	if (before.includes("=>") || before.endsWith(")")) return false;
	if (/^(?:if|for|while|switch|catch|try|else|do|finally|function)\b/.test(before)) return false;
	return true;
}

/** Whether `line` opens a Swift type's body, which is where a var or let is a property. */
function opensSwiftTypeBody(line: string | undefined): boolean {
	if (line === undefined || !line.endsWith("{")) return false;
	return /^(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|fileprivate|internal|open|final|indirect)\s+)*(?:class|struct|protocol|enum|extension|actor)\b/.test(
		line,
	);
}

/** Whether `line` opens a Python class's body, which is where an assignment is a class attribute. */
function opensPythonClassBody(line: string | undefined): boolean {
	return line !== undefined && /^class\b/.test(line);
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
