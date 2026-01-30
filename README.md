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

## Development

This is a single-file extension. You typically don't need to build anything; Pi loads the TypeScript directly.

## License

MIT
