# ez-sandbox

One command to put **Claude Code's Bash tool in an OS-level sandbox** — so an agent
running `rm -rf`, exfiltrating `~/.ssh`, or curling somewhere it shouldn't is stopped
by the operating system, not just by a permission prompt you might click through.

It enables [Claude Code's built-in sandbox](https://code.claude.com/docs/en/sandboxing)
(Seatbelt on macOS, bubblewrap + socat on Linux/WSL2), installs the Linux dependencies
for you, and merges a sane config into `~/.claude/settings.json` **without clobbering
your existing settings**.

## Usage

```bash
# Set it up (run this once)
bun run index.ts

# or, after `bun link`:
ez-sandbox
```

That's it. On macOS there's nothing to install — it uses the built-in Seatbelt
framework. On Linux/WSL2 it offers to `sudo`-install `bubblewrap` and `socat`.

### What it writes

A `sandbox` block in `~/.claude/settings.json`:

- `enabled: true` — turns on the OS sandbox for Bash commands
- `filesystem.denyRead` — sandboxed Bash can't read `~/.ssh`, `~/.aws`, `~/.gnupg`,
  `~/.config/gh`, `~/.netrc`, `~/.npmrc`, `~/.docker/config.json`, `~/.kube/config`
  (Claude Code's defaults still expose these unless you deny them explicitly)
- `network.allowLocalBinding: true` — so local dev servers still work
- Network egress stays at Claude Code's **prompt-on-new-domain** default, so nothing
  silently breaks

The first run backs up any existing `settings.json` to
`settings.json.ez-sandbox.bak`. Re-running is idempotent.

## Options

```
--check            Report current sandbox status and exit (no changes)
--print            Print the sandbox config that would be written, then exit
--dry-run          Show what would change without writing or installing
--network=default  Keep Claude Code's prompt-on-new-domain behavior (default)
--network=lockdown Block egress except Anthropic + common package registries
--strict           Refuse to start Claude Code if the sandbox is unavailable
-y, --yes          Don't prompt before installing Linux dependencies
-h, --help         Show this help
```

Locked-down network mode allows only `api.anthropic.com`, `statsig.anthropic.com`,
`sentry.io`, `registry.npmjs.org`, `pypi.org`, `files.pythonhosted.org`, `github.com`,
and `*.githubusercontent.com`. Edit `~/.claude/settings.json` afterward to add more.

## Scope & limits

This sandboxes **Bash commands and their children only**. Claude Code's file
edit/read/write tools, MCP servers, and hooks still run on the host. That's enough
to neutralize the most common "the agent ran a bad shell command" risk.

For fully unattended runs (`--dangerously-skip-permissions`) you want the whole
process boxed in — use a [devcontainer](https://code.claude.com/docs/en/devcontainer)
or wrap the entire CLI with `npx @anthropic-ai/sandbox-runtime claude`.

Native Windows isn't supported by the sandbox — run Claude Code inside WSL2.

## Requirements

- [Bun](https://bun.com) (the runtime this CLI is written for)
- macOS, Linux, or WSL2
