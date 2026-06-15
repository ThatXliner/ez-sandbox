# ez-sandbox

One command to put **Claude Code's Bash tool in an OS-level sandbox** — so an agent
running `rm -rf`, exfiltrating `~/.ssh`, or curling somewhere it shouldn't is stopped
by the operating system, not just by a permission prompt you might click through.

It enables [Claude Code's built-in sandbox](https://code.claude.com/docs/en/sandboxing)
(Seatbelt on macOS, bubblewrap + socat on Linux/WSL2), installs the Linux dependencies
for you, and merges a sane config into `~/.claude/settings.json` **without clobbering
your existing settings**.

## Usage

You don't need to keep this repo around — clone it, run it once, delete it. The
config it writes lives in `~/.claude/settings.json`, which sticks around after the
clone is gone.

```bash
git clone https://github.com/ThatXliner/ez-sandbox.git
cd ez-sandbox
bun install
bun run index.ts
cd .. && rm -rf ez-sandbox
```

On macOS there's nothing to install — it uses the built-in Seatbelt framework. On
Linux/WSL2 it offers to `sudo`-install `bubblewrap` and `socat`. During setup it
asks one question: how much you want to cut down on permission prompts (see below).

> If you'd rather keep it installed as a reusable `ez-sandbox` command (e.g. to
> re-run `ez-sandbox --check` or `ez-sandbox --uninstall`), run `bun link` instead
> of deleting the clone.

### Fewer prompts, safely

Normally Claude Code asks before every Bash command and file edit. The dangerous
escape hatch is `--dangerously-skip-permissions`, which removes *all* safety. This
tool gives you the safe middle ground, because two things silence prompts:

- **The sandbox** auto-runs Bash commands without prompting — the OS boundary is
  what keeps them safe, so you don't need to approve each one. (This is on by default.)
- **The permission mode** controls whether *file edits* also stop prompting. Setup
  asks which you want:
  - **Auto mode** (`--auto`) — Claude Code's classifier-gated [`auto` mode](https://www.anthropic.com/engineering/claude-code-auto-mode),
    the official safe replacement for `--dangerously-skip-permissions`. Fewest
    prompts. Needs Claude Code ≥ v2.1.83 and Opus 4.6+/Sonnet 4.6.
  - **Accept edits** (`--accept-edits`) — auto-accepts file edits in your project.
    Works on any version; combined with the sandbox it's near prompt-free.
  - **Keep prompting** (`--prompts=none`) — only Bash auto-runs; edits still ask.

Pass any of those flags to skip the question (handy for scripting). With `-y` and no
flag, it defaults to `--prompts=none` (the cautious choice).

### What it writes

To `~/.claude/settings.json`:

- `sandbox.enabled: true` — the OS sandbox for Bash commands
- `sandbox.filesystem.denyRead` — a large list (~70 paths) of credential/secret
  stores sandboxed Bash can't read: SSH/GPG keys, AWS/GCP/Azure creds, kube/docker
  auth, npm/cargo/gem tokens, gh/vercel/netlify/wrangler/etc. CLI tokens, database
  passwords, password managers, OS/browser keychains, crypto wallets, shell history,
  and the agents' own credential files. (Claude Code's defaults expose these unless
  you deny them explicitly.) Both macOS and Linux path variants are included.
- `permissions.deny` — glob `Read()` rules for secrets that can live anywhere:
  `.env` files, `*.pem`/`*.key`/`*.p12`/`*.pfx`/`*.ppk`, `*.kdbx`.
- `permissions.defaultMode` — only if you chose auto / accept-edits.
- `sandbox.network.allowLocalBinding: true` — so local dev servers still work.
- Network egress stays at Claude Code's **prompt-on-new-domain** default, so nothing
  silently breaks.

The first run backs up any existing `settings.json` to
`settings.json.ez-sandbox.bak`. Re-running is idempotent. To remove everything this
tool added (and nothing else), run `ez-sandbox --uninstall`.

> **What's *not* on the deny list, on purpose:** files that mix secrets with config
> the agent legitimately needs — `~/.npmrc`, `~/.gradle/gradle.properties`,
> `~/.m2/settings.xml`, `pip.conf`. Denying those breaks installs/builds; scrub
> their tokens via env vars instead.

## Options

```
--check            Report current sandbox status and exit (no changes)
--print            Print the config that would be written, then exit
--dry-run          Show what would change without writing or installing
--network=default  Keep Claude Code's prompt-on-new-domain behavior (default)
--network=lockdown Block egress except Anthropic + common package registries
--auto             Use Claude Code's safe 'auto' permission mode (fewest prompts)
--accept-edits     Auto-accept file edits in the working dir (works everywhere)
--prompts=none     Leave permission mode alone (sandbox still auto-runs Bash)
--strict           Refuse to start Claude Code if the sandbox is unavailable
--uninstall        Remove everything ez-sandbox added (keeps your other settings)
-y, --yes          Skip confirmation prompts (defaults to --prompts=none)
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
