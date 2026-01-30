# pi-codex-apply-patch

A Pi coding-agent extension that adds an `apply_patch` tool and a V4A patch harness so GPT-5.2 / GPT-5.2-Codex can propose structured diffs which Pi applies.

This follows the OpenAI Apply Patch / V4A diff flow:
- The model calls `apply_patch` with a list of operations
- Each operation is one of: `create_file`, `update_file`, `delete_file`
- The diff format is V4A (context/add/delete lines)

## What you get

- A Pi tool named **`apply_patch`**
- Path validation (prevents directory traversal)
- Atomic writes
- Streaming progress updates in the Pi TUI
- A self-test command: **`/codex_patch_selftest`**

## Install

### Option A: Copy into Pi extensions directory

```bash
mkdir -p ~/.pi/agent/extensions
cp ./codex-apply-patch.ts ~/.pi/agent/extensions/codex-apply-patch.ts
```

Then start Pi normally.

### Option B: Load the extension explicitly

```bash
pi -e /absolute/path/to/codex-apply-patch.ts
```

## Usage

When the active model is `gpt-5.2` or `gpt-5.2-codex`, the extension:
- enables the `apply_patch` tool
- disables Pi's built-in `edit`/`write` tools (so the model must use structured patches)

### Self-test

Inside Pi:

```
/codex_patch_selftest
```

## Tool schema

`apply_patch` expects:

```json
{
  "operations": [
    { "type": "create_file", "path": "...", "diff": "..." },
    { "type": "update_file", "path": "...", "diff": "..." },
    { "type": "delete_file", "path": "..." }
  ]
}
```

Notes:
- `create_file.diff`: full file content in V4A create mode (each line starts with `+`)
- `update_file.diff`: V4A diff using `@@` sections and `+`/`-`/` ` lines
- `delete_file`: no `diff`

## Benchmarks & quality notes (informal)

These are notes from local A/B runs to understand how “forced apply_patch” behaves vs Pi’s normal `edit`/`write` flow.

- **baseline** = Pi built-in `edit`/`write`
- **apply_patch** = this extension (forces structured diffs)
- Each number below is the **mean of 10 runs** on the same repo snapshot and prompt.
- **Cost** is taken from Pi’s JSONL `usage.cost.total`.

### Small change (single-file fix)

In a tiny one-file fix, forcing apply_patch was usually slower and more expensive.

- `gpt-5.2`: baseline **$0.0467 / 44.6s** vs apply_patch **$0.0587 / 50.1s**
- `gpt-5.2-codex`: baseline **$0.0291 / 22.6s** vs apply_patch **$0.0405 / 33.1s**

### Multi-file change (feature across a few files)

In a multi-file fix (3–5 files), results depended on the model:

- `gpt-5.2`: baseline **$0.1557 / 136.4s** vs apply_patch **$0.1470 / 129.7s**
- `gpt-5.2-codex`: baseline **$0.1002 / 82.6s** vs apply_patch **$0.1180 / 95.0s**

Tool reliability note (10-run totals): on `gpt-5.2-codex`, forcing apply_patch reduced tool errors (**34 → 17**), but it cost more and took longer.

### Code-quality observations from diffs

- apply_patch gives a nice **audit trail** (explicit file ops + diffs). That’s the main “quality” win.
- It doesn’t automatically guarantee cleaner code. In a few runs, models used shortcuts to get tests green (e.g. adding a hidden field like `__timesLeft` or escaping types with `any`).
- Some runs also touched unrelated files (import specifier changes, etc.). That’s not always wrong, but it adds churn.

Practical takeaway: if your priority is reviewability/reproducibility, forcing apply_patch is a good default. If you optimize for tiny one-line fixes, baseline tooling is often cheaper.

## Development

This is a single-file extension. You typically don't need to build anything; Pi loads the TypeScript directly.

## License

MIT
