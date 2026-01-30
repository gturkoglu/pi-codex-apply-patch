import type { AgentToolUpdateCallback, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { StringEnum } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import * as fs from "node:fs/promises";
import * as path from "node:path";

// Enable Codex-style apply_patch semantics for these model IDs.
// Note: we intentionally do not gate on provider; users may route OpenAI models through proxies.
const CODEX_MODEL_IDS = new Set(["gpt-5.2", "gpt-5.2-codex"]);

// UI limits (keep tool call rendering fast and avoid flooding the TUI)
const PATCH_PREVIEW_MAX_LINES = 16;
const PATCH_PREVIEW_MAX_CHARS = 4000;

// ---------------------------------------------------------------------------
// Model gating / tool policy
// ---------------------------------------------------------------------------

function isCodexModel(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	return CODEX_MODEL_IDS.has(model.id) || model.id.includes("codex");
}

// ---------------------------------------------------------------------------
// Tool result details (for streaming progress + final summary)
// ---------------------------------------------------------------------------

type ApplyPatchOpType = "create_file" | "update_file" | "delete_file";

interface ApplyPatchOperation {
	type: ApplyPatchOpType;
	path: string;
	/** V4A diff (create_file expects full file content in create mode) */
	diff?: string;
	/** Optional rename support (not in OpenAI docs, but supported by codex freeform patches) */
	move_path?: string;
}

type ApplyPatchDetails =
	| { stage: "progress"; message: string }
	| {
			stage: "done";
			fuzz: number;
			results: Array<{ type: ApplyPatchOpType; path: string; status: "completed" | "failed"; output?: string }>;
	  };

function progress(onUpdate: AgentToolUpdateCallback<ApplyPatchDetails> | undefined, message: string): void {
	onUpdate?.({ content: [{ type: "text", text: message }], details: { stage: "progress", message } });
}

// ---------------------------------------------------------------------------
// Patch engine: V4A diff application
// ---------------------------------------------------------------------------

class DiffError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "DiffError";
	}
}

function normalizeLineEndings(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function normalizePatchPath(p: string): string {
	return p.replace(/\\/g, "/").trim();
}

function validateRelativePath(p: string): string {
	const raw = normalizePatchPath(p);
	if (!raw) throw new DiffError("Invalid path: empty");
	if (raw.includes("\u0000")) throw new DiffError("Invalid path: contains NUL");
	if (raw.startsWith("/")) throw new DiffError(`Invalid path: absolute paths are not allowed: ${raw}`);
	if (/^[A-Za-z]:\//.test(raw)) throw new DiffError(`Invalid path: absolute Windows paths are not allowed: ${raw}`);

	const normalized = path.posix.normalize(raw);
	if (normalized === ".") throw new DiffError(`Invalid path: ${raw}`);
	if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
		throw new DiffError(`Invalid path: directory traversal is not allowed: ${raw}`);
	}

	return normalized;
}

function toFsPath(cwd: string, rel: string): string {
	const abs = path.resolve(cwd, rel);
	const root = path.resolve(cwd) + path.sep;
	if (!abs.startsWith(root)) {
		throw new DiffError(`Invalid path (escapes cwd): ${rel}`);
	}
	return abs;
}

async function fileExists(p: string): Promise<boolean> {
	try {
		await fs.stat(p);
		return true;
	} catch {
		return false;
	}
}

interface Chunk {
	origIndex: number;
	delLines: string[];
	insLines: string[];
}

function peekNextSection(
	lines: string[],
	startIndex: number,
): { context: string[]; chunks: Chunk[]; nextIndex: number; eof: boolean } {
	const old: string[] = [];
	let delLines: string[] = [];
	let insLines: string[] = [];
	const chunks: Chunk[] = [];

	let mode: "keep" | "add" | "delete" = "keep";
	const origIndex = startIndex;
	let index = startIndex;

	while (index < lines.length) {
		const s0 = lines[index]!;
		if (
			s0.startsWith("@@") ||
			s0.startsWith("*** End of File") ||
			s0.startsWith("*** End Patch") ||
			s0.startsWith("*** Update File:") ||
			s0.startsWith("*** Delete File:") ||
			s0.startsWith("*** Add File:")
		) {
			break;
		}
		if (s0 === "***") break;
		if (s0.startsWith("***")) throw new DiffError(`Invalid Line: ${s0}`);

		index++;
		const lastMode = mode;
		let s = s0;
		if (s === "") s = " ";

		const prefix = s[0];
		if (prefix === "+") mode = "add";
		else if (prefix === "-") mode = "delete";
		else if (prefix === " ") mode = "keep";
		else throw new DiffError(`Invalid Line: ${s0}`);

		s = s.slice(1);

		if (mode === "keep" && lastMode !== mode) {
			if (insLines.length > 0 || delLines.length > 0) {
				chunks.push({ origIndex: old.length - delLines.length, delLines, insLines });
				delLines = [];
				insLines = [];
			}
		}

		if (mode === "delete") {
			delLines.push(s);
			old.push(s);
		} else if (mode === "add") {
			insLines.push(s);
		} else {
			old.push(s);
		}
	}

	if (insLines.length > 0 || delLines.length > 0) {
		chunks.push({ origIndex: old.length - delLines.length, delLines, insLines });
	}

	if (index < lines.length && lines[index] === "*** End of File") {
		index++;
		return { context: old, chunks, nextIndex: index, eof: true };
	}

	if (index === origIndex) {
		throw new DiffError(`Nothing in this section - index=${index} line='${lines[index] ?? ""}'`);
	}

	return { context: old, chunks, nextIndex: index, eof: false };
}

function findContextCore(lines: string[], context: string[], start: number): { index: number; fuzz: number } {
	if (context.length === 0) return { index: start, fuzz: 0 };

	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (lines[i + j] !== context[j]) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 0 };
	}

	const rstrip = (s: string) => s.replace(/\s+$/g, "");
	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (rstrip(lines[i + j]!) !== rstrip(context[j]!)) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 1 };
	}

	const strip = (s: string) => s.trim();
	for (let i = start; i <= lines.length - context.length; i++) {
		let ok = true;
		for (let j = 0; j < context.length; j++) {
			if (strip(lines[i + j]!) !== strip(context[j]!)) {
				ok = false;
				break;
			}
		}
		if (ok) return { index: i, fuzz: 100 };
	}

	return { index: -1, fuzz: 0 };
}

function findContext(lines: string[], context: string[], start: number, eof: boolean): { index: number; fuzz: number } {
	if (eof) {
		const atEof = findContextCore(lines, context, Math.max(0, lines.length - context.length));
		if (atEof.index !== -1) return atEof;
		const fallback = findContextCore(lines, context, start);
		return { index: fallback.index, fuzz: fallback.fuzz + 10000 };
	}
	return findContextCore(lines, context, start);
}

function applyV4AUpdate(input: string, diff: string): { output: string; fuzz: number } {
	// IMPORTANT: do NOT trim() here. V4A diff lines may start with a leading space (context lines).
	const normalizedDiff = normalizeLineEndings(diff);
	const patchLines = normalizedDiff.split("\n");
	// Drop a single trailing newline to avoid creating an extra empty diff line.
	if (patchLines.length > 0 && patchLines[patchLines.length - 1] === "") patchLines.pop();

	const fileLines = normalizeLineEndings(input).split("\n");

	let fuzz = 0;
	const chunks: Chunk[] = [];
	let patchIndex = 0;
	let fileIndex = 0;

	while (patchIndex < patchLines.length) {
		// Section marker
		const line = patchLines[patchIndex] ?? "";
		let defStr = "";
		if (line.startsWith("@@ ")) {
			defStr = line.slice(3);
			patchIndex++;
		} else if (line === "@@") {
			patchIndex++;
		} else if (patchIndex === 0) {
			// Allow diffs without leading @@ (common in some examples)
		} else {
			throw new DiffError(`Invalid diff (expected @@ section): ${line}`);
		}

		if (defStr.trim()) {
			let found = false;
			if (!fileLines.slice(0, fileIndex).some((s) => s === defStr)) {
				for (let i = fileIndex; i < fileLines.length; i++) {
					if (fileLines[i] === defStr) {
						fileIndex = i + 1;
						found = true;
						break;
					}
				}
				if (!found && !fileLines.slice(0, fileIndex).some((s) => s.trim() === defStr.trim())) {
					for (let i = fileIndex; i < fileLines.length; i++) {
						if (fileLines[i]!.trim() === defStr.trim()) {
							fileIndex = i + 1;
							fuzz += 1;
							found = true;
							break;
						}
					}
				}
			}
		}

		const { context, chunks: sectionChunks, nextIndex, eof } = peekNextSection(patchLines, patchIndex);
		const nextChunkText = context.join("\n");
		const found = findContext(fileLines, context, fileIndex, eof);
		if (found.index === -1) {
			if (eof) throw new DiffError(`Invalid EOF Context ${fileIndex}:\n${nextChunkText}`);
			throw new DiffError(`Invalid Context ${fileIndex}:\n${nextChunkText}`);
		}

		fuzz += found.fuzz;
		for (const ch of sectionChunks) {
			chunks.push({
				origIndex: ch.origIndex + found.index,
				delLines: ch.delLines,
				insLines: ch.insLines,
			});
		}

		fileIndex = found.index + context.length;
		patchIndex = nextIndex;
	}

	// Apply chunks
	const dest: string[] = [];
	let origIndex = 0;
	for (const chunk of chunks) {
		if (origIndex > chunk.origIndex) {
			throw new DiffError(`applyDiff: origIndex ${origIndex} > chunk.origIndex ${chunk.origIndex}`);
		}

		dest.push(...fileLines.slice(origIndex, chunk.origIndex));
		origIndex = chunk.origIndex;

		const expected = chunk.delLines;
		const actual = fileLines.slice(origIndex, origIndex + expected.length);
		const same = expected.length === actual.length && expected.every((l, i) => l === actual[i]);
		if (!same) {
			throw new DiffError(
				`Patch conflict at line ${origIndex + 1}. Expected:\n${expected.join("\n")}\n\nActual:\n${actual.join("\n")}`,
			);
		}

		dest.push(...chunk.insLines);
		origIndex += expected.length;
	}
	// Tail
	dest.push(...fileLines.slice(origIndex));
	return { output: dest.join("\n"), fuzz };
}

function applyV4ACreate(diff: string): string {
	const lines = normalizeLineEndings(diff).split("\n");
	// Drop trailing empty line to avoid an extra empty content line.
	if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

	const out: string[] = [];
	for (const line of lines) {
		if (!line.startsWith("+")) {
			throw new DiffError(`Invalid create_file diff line (must start with '+'): ${line}`);
		}
		out.push(line.slice(1));
	}
	return out.join("\n");
}

async function writeFileAtomic(abs: string, content: string, mode?: number): Promise<void> {
	const dir = path.dirname(abs);
	const base = path.basename(abs);
	const tmp = path.join(dir, `.${base}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`);

	await fs.writeFile(tmp, content, "utf8");
	if (typeof mode === "number") {
		try {
			await fs.chmod(tmp, mode);
		} catch {
			// ignore (best effort)
		}
	}

	try {
		await fs.rename(tmp, abs);
	} catch (err) {
		// Windows can fail rename() if the target exists.
		try {
			await fs.unlink(abs);
			await fs.rename(tmp, abs);
		} catch {
			try {
				await fs.unlink(tmp);
			} catch {
				// ignore
			}
			throw err;
		}
	}
}

async function applyOperations(
	operations: ApplyPatchOperation[],
	cwd: string,
	signal?: AbortSignal,
	onProgress?: (message: string) => void,
): Promise<{ fuzz: number; results: Array<{ type: ApplyPatchOpType; path: string; status: "completed" | "failed"; output?: string }> }> {
	const results: Array<{ type: ApplyPatchOpType; path: string; status: "completed" | "failed"; output?: string }> = [];
	let fuzzTotal = 0;

	onProgress?.(`Applying ${operations.length} operation(s)...`);

	for (let i = 0; i < operations.length; i++) {
		if (signal?.aborted) throw new Error("Aborted");

		const op = operations[i]!;
		const type = op.type;

		let rel: string;
		let abs: string;
		try {
			rel = validateRelativePath(op.path);
			abs = toFsPath(cwd, rel);
		} catch (err) {
			results.push({
				type,
				path: typeof op.path === "string" ? op.path : "(invalid)",
				status: "failed",
				output: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		onProgress?.(`${i + 1}/${operations.length} ${type} ${rel}`);

		try {
			if (type === "create_file") {
				if (typeof op.diff !== "string") throw new DiffError(`create_file missing diff for ${rel}`);
				if (await fileExists(abs)) throw new DiffError(`File already exists at path '${rel}'`);

				const content = applyV4ACreate(op.diff);
				await fs.mkdir(path.dirname(abs), { recursive: true });
				await writeFileAtomic(abs, content);
				results.push({ type, path: rel, status: "completed" });
				continue;
			}

			if (type === "update_file") {
				if (typeof op.diff !== "string") throw new DiffError(`update_file missing diff for ${rel}`);
				if (!(await fileExists(abs))) throw new DiffError(`File not found at path '${rel}'`);

				const st = await fs.stat(abs);
				const current = await fs.readFile(abs, "utf8");
				const { output, fuzz } = applyV4AUpdate(current, op.diff);
				fuzzTotal += fuzz;

				if (op.move_path) {
					const relTo = validateRelativePath(op.move_path);
					const absTo = toFsPath(cwd, relTo);
					if (await fileExists(absTo)) throw new DiffError(`Target already exists at path '${relTo}'`);

					await fs.mkdir(path.dirname(absTo), { recursive: true });
					await writeFileAtomic(absTo, output, st.mode);
					await fs.unlink(abs);
					results.push({ type, path: relTo, status: "completed", output: `Moved from ${rel}` });
				} else {
					await fs.mkdir(path.dirname(abs), { recursive: true });
					await writeFileAtomic(abs, output, st.mode);
					results.push({ type, path: rel, status: "completed" });
				}
				continue;
			}

			// delete_file
			if (!(await fileExists(abs))) throw new DiffError(`File not found at path '${rel}'`);
			await fs.unlink(abs);
			results.push({ type, path: rel, status: "completed" });
		} catch (err) {
			results.push({
				type,
				path: rel,
				status: "failed",
				output: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { fuzz: fuzzTotal, results };
}

// ---------------------------------------------------------------------------
// UI helpers (for showing live tool args + results)
// ---------------------------------------------------------------------------

function countNewlines(text: string, maxScanChars = 200_000): number {
	const s = text.length > maxScanChars ? text.slice(0, maxScanChars) : text;
	let n = 0;
	for (let i = 0; i < s.length; i++) {
		if (s.charCodeAt(i) === 10) n++;
	}
	return n;
}

function extractPathsFromOperations(ops: unknown): string[] {
	if (!Array.isArray(ops)) return [];
	const out: string[] = [];
	for (const o of ops) {
		if (!o || typeof o !== "object") continue;
		const p = (o as { path?: unknown }).path;
		if (typeof p !== "string") continue;
		try {
			out.push(validateRelativePath(p));
		} catch {
			// ignore
		}
	}
	return [...new Set(out)].slice(0, 20);
}

function makeDiffPreview(diff: string, maxLines = PATCH_PREVIEW_MAX_LINES, maxChars = PATCH_PREVIEW_MAX_CHARS): string {
	const text = normalizeLineEndings(diff);
	if (text.length <= maxChars && countNewlines(text, maxChars) + 1 <= maxLines) return text;

	const headCount = Math.max(6, Math.floor(maxLines / 2));
	const tailCount = Math.max(6, maxLines - headCount);
	const bigCutoff = maxChars * 8;
	const startSlice = text.length > bigCutoff ? text.slice(0, maxChars * 3) : text;
	const endSlice = text.length > bigCutoff ? text.slice(-maxChars * 3) : text;

	const headLines = startSlice.split("\n").slice(0, headCount);
	const tailLines = endSlice.split("\n");
	const tail = tailLines.slice(Math.max(0, tailLines.length - tailCount));

	let preview = [...headLines, "…", ...tail].join("\n");
	if (preview.length > maxChars) {
		preview = preview.slice(0, maxChars).trimEnd() + "\n…";
	}
	return preview;
}

function summarizeOperationsArgs(args: unknown): { opCount: number; approxBytes: number; paths: string[]; preview?: string } {
	const ops = (args as { operations?: unknown })?.operations;
	if (!Array.isArray(ops)) return { opCount: 0, approxBytes: 0, paths: [] };

	let bytes = 0;
	let firstDiff = "";
	for (const o of ops) {
		if (!o || typeof o !== "object") continue;
		const diff = (o as { diff?: unknown }).diff;
		if (typeof diff === "string") {
			bytes += Buffer.byteLength(diff, "utf8");
			if (!firstDiff) firstDiff = diff;
		}
	}

	const paths = extractPathsFromOperations(ops);
	const preview = firstDiff ? makeDiffPreview(firstDiff) : undefined;
	return { opCount: ops.length, approxBytes: bytes, paths, preview };
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let baselineTools: string[] | null = null;

	function applyToolPolicy(ctx: ExtensionContext): void {
		if (!baselineTools) baselineTools = pi.getActiveTools();

		if (isCodexModel(ctx)) {
			const next = new Set(baselineTools);
			next.delete("edit");
			next.delete("write");
			next.add("apply_patch");
			pi.setActiveTools([...next]);
			return;
		}

		pi.setActiveTools(baselineTools.filter((t) => t !== "apply_patch"));
	}

	pi.registerTool({
		name: "apply_patch",
		label: "apply_patch",
		description:
			"Apply structured patch operations (create_file, update_file, delete_file) using V4A diffs (Codex-style).",
		parameters: Type.Object({
			operations: Type.Array(
				Type.Object({
					type: StringEnum(["create_file", "update_file", "delete_file"] as const),
					path: Type.String(),
					diff: Type.Optional(Type.String()),
					move_path: Type.Optional(Type.String()),
				}),
			),
		}),

		renderCall(args, theme) {
			const { opCount, approxBytes, paths, preview } = summarizeOperationsArgs(args);
			let out = theme.fg("toolTitle", theme.bold("apply_patch"));
			out += theme.fg("muted", ` (${opCount} op(s), ~${approxBytes} diff bytes)`);

			if (paths.length > 0) {
				const shown = paths.slice(0, 8);
				const more = paths.length > shown.length ? ` (+${paths.length - shown.length} more)` : "";
				out += "\n" + theme.fg("muted", `Paths: ${shown.join(", ")}${more}`);
			}

			if (preview) {
				out += "\n\n" + theme.fg("toolOutput", preview);
			} else {
				out += "\n" + theme.fg("muted", "(waiting for operations / diff)");
			}

			return new Text(out, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as ApplyPatchDetails | undefined;
			if (isPartial) {
				const msg = details?.stage === "progress" ? details.message : "Working...";
				return new Text(theme.fg("warning", msg), 0, 0);
			}

			if (details?.stage === "done") {
				const completed = details.results.filter((r) => r.status === "completed").length;
				const failed = details.results.filter((r) => r.status === "failed").length;
				let header = theme.fg("success", `✓ Done (fuzz=${details.fuzz})`);
				header += theme.fg("muted", ` — ${completed} completed, ${failed} failed`);

				if (!expanded) return new Text(header, 0, 0);

				const lines = details.results
					.map((r) => {
						const prefix = r.status === "completed" ? theme.fg("success", "✓") : theme.fg("error", "✗");
						const base = `${prefix} ${r.type} ${r.path}`;
						return r.output ? base + theme.fg("muted", ` — ${r.output}`) : base;
					})
					.join("\n");
				return new Text(header + "\n" + lines, 0, 0);
			}

			// Fallback
			let output = "";
			for (const c of result.content ?? []) {
				if (c && typeof c === "object" && (c as { type?: unknown }).type === "text") {
					const t = (c as { text?: unknown }).text;
					if (typeof t === "string" && t) output += (output ? "\n" : "") + t;
				}
			}
			return new Text(output ? theme.fg("toolOutput", output) : theme.fg("muted", "(no output)"), 0, 0);
		},

		async execute(_toolCallId, params, onUpdate, ctx, signal) {
			const update = onUpdate as AgentToolUpdateCallback<ApplyPatchDetails> | undefined;

			progress(update, "Applying patch operations...");

			try {
				const ops = params.operations as ApplyPatchOperation[];
				const { fuzz, results } = await applyOperations(ops, ctx.cwd, signal, (msg) => progress(update, msg));

				const summaryLines = results
					.map((r) => `${r.status === "completed" ? "✓" : "✗"} ${r.type} ${r.path}${r.output ? ` — ${r.output}` : ""}`)
					.join("\n");
				return {
					content: [{ type: "text", text: `Done. Fuzz=${fuzz}.\n${summaryLines}` }],
					details: { stage: "done", fuzz, results },
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text", text: msg }],
					details: {
						stage: "done",
						fuzz: 0,
						results: [{ type: "update_file", path: "(unknown)", status: "failed", output: msg }],
					},
				};
			}
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		baselineTools = pi.getActiveTools();
		applyToolPolicy(ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		applyToolPolicy(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		applyToolPolicy(ctx);
		if (!isCodexModel(ctx)) return;

		return {
			systemPrompt:
				event.systemPrompt +
				"\n\n# apply_patch (Codex)\n" +
				"- Use the apply_patch tool for file edits.\n" +
				"- Use operations with type: create_file | update_file | delete_file.\n" +
				"- For create_file: diff is full file content in V4A create mode (every line starts with '+').\n" +
				"- For update_file: diff is a V4A diff with @@ sections and +/-/space lines.\n" +
				"- For delete_file: no diff.\n",
		};
	});
}
