#!/usr/bin/env bun
/**
 * ez-sandbox — one command to put Claude Code's Bash tool in an OS-level sandbox.
 *
 * It enables Claude Code's built-in sandbox (Seatbelt on macOS, bubblewrap+socat on
 * Linux/WSL2), installs the Linux dependencies if needed, and writes sensible
 * filesystem protections (deny reads of ~/.ssh, ~/.aws, etc.) into ~/.claude/settings.json
 * without clobbering your existing config.
 *
 * Network policy is left at Claude Code's default (prompt-on-new-domain) so nothing
 * silently breaks — pass --network=lockdown to switch to a strict egress allowlist.
 *
 * Docs: https://code.claude.com/docs/en/sandboxing
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

type NetworkMode = "default" | "lockdown";

interface Options {
  dryRun: boolean;
  check: boolean;
  print: boolean;
  strict: boolean; // failIfUnavailable: refuse to start unsandboxed
  network: NetworkMode;
  yes: boolean; // skip the Linux dependency-install prompt
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    check: false,
    print: false,
    strict: false,
    network: "default",
    yes: false,
    help: false,
  };
  for (const arg of argv) {
    switch (arg) {
      case "-h":
      case "--help":
        opts.help = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        break;
      case "--check":
        opts.check = true;
        break;
      case "--print":
        opts.print = true;
        break;
      case "--strict":
        opts.strict = true;
        break;
      case "-y":
      case "--yes":
        opts.yes = true;
        break;
      case "--network=default":
        opts.network = "default";
        break;
      case "--network=lockdown":
        opts.network = "lockdown";
        break;
      default:
        fail(`Unknown argument: ${arg}\nRun \`ez-sandbox --help\` for usage.`);
    }
  }
  return opts;
}

const HELP = `ez-sandbox — sandbox Claude Code's Bash tool in one command

Usage:
  ez-sandbox [options]

What it does:
  • Enables Claude Code's built-in OS sandbox (sandbox.enabled = true)
  • macOS: nothing to install (uses the built-in Seatbelt framework)
  • Linux/WSL2: installs bubblewrap + socat (needs sudo) if missing
  • Denies sandboxed Bash from reading secrets (~/.ssh, ~/.aws, ~/.gnupg, ...)
  • Merges into ~/.claude/settings.json without touching your other settings

Options:
  --check            Report current sandbox status and exit (no changes)
  --print            Print the sandbox config that would be written, then exit
  --dry-run          Show what would change without writing or installing
  --network=default  Keep Claude Code's prompt-on-new-domain behavior (default)
  --network=lockdown Block egress except Anthropic + common package registries
  --strict           Refuse to start Claude Code if the sandbox is unavailable
  -y, --yes          Don't prompt before installing Linux dependencies
  -h, --help         Show this help

Docs: https://code.claude.com/docs/en/sandboxing
`;

// ---------------------------------------------------------------------------
// Small terminal helpers
// ---------------------------------------------------------------------------

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code: string, s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = (s: string) => c("1", s);
const dim = (s: string) => c("2", s);
const green = (s: string) => c("32", s);
const yellow = (s: string) => c("33", s);
const red = (s: string) => c("31", s);
const cyan = (s: string) => c("36", s);

const ok = (s: string) => console.log(`${green("✓")} ${s}`);
const info = (s: string) => console.log(`${cyan("•")} ${s}`);
const warn = (s: string) => console.log(`${yellow("!")} ${s}`);

function fail(msg: string): never {
  console.error(`${red("✗")} ${msg}`);
  process.exit(1);
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  process.stdout.write(`${question} ${dim("[y/N]")} `);
  for await (const line of console) {
    return /^y(es)?$/i.test(line.trim());
  }
  return false;
}

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

type OS = "macos" | "linux" | "wsl" | "windows" | "other";

async function detectOS(): Promise<OS> {
  const p = platform();
  if (p === "darwin") return "macos";
  if (p === "win32") return "windows";
  if (p === "linux") {
    // WSL reports linux but exposes "microsoft" in /proc/version.
    try {
      const v = await Bun.file("/proc/version").text();
      if (/microsoft/i.test(v)) return "wsl";
    } catch {
      /* ignore */
    }
    return "linux";
  }
  return "other";
}

async function which(bin: string): Promise<boolean> {
  return (await Bun.$`command -v ${bin}`.quiet().nothrow()).exitCode === 0;
}

// ---------------------------------------------------------------------------
// The sandbox config we write
// ---------------------------------------------------------------------------

// Paths we never want sandboxed Bash commands to read. ~ is expanded by Claude Code.
const DENY_READ = [
  "~/.ssh",
  "~/.aws",
  "~/.gnupg",
  "~/.config/gh",
  "~/.netrc",
  "~/.npmrc",
  "~/.docker/config.json",
  "~/.kube/config",
];

// When the user opts into --network=lockdown, allow only these. Anything else
// prompts (or is blocked). Kept deliberately small and editable afterwards.
const LOCKDOWN_DOMAINS = [
  "api.anthropic.com",
  "statsig.anthropic.com",
  "sentry.io",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "*.githubusercontent.com",
];

function buildSandboxConfig(opts: Options): Record<string, unknown> {
  const network: Record<string, unknown> = {
    allowLocalBinding: true, // let dev servers bind local ports
  };
  if (opts.network === "lockdown") {
    network.allowedDomains = LOCKDOWN_DOMAINS;
  }
  return {
    enabled: true,
    failIfUnavailable: opts.strict,
    autoAllowBashIfSandboxed: true, // fewer prompts once safely sandboxed
    filesystem: {
      denyRead: DENY_READ,
    },
    network,
  };
}

// ---------------------------------------------------------------------------
// settings.json read / merge / write
// ---------------------------------------------------------------------------

const SETTINGS_DIR = join(homedir(), ".claude");
const SETTINGS_PATH = join(SETTINGS_DIR, "settings.json");

async function readSettings(): Promise<Record<string, unknown>> {
  const file = Bun.file(SETTINGS_PATH);
  if (!(await file.exists())) return {};
  const text = (await file.text()).trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      fail(`${SETTINGS_PATH} is not a JSON object. Refusing to overwrite it.`);
    }
    return parsed as Record<string, unknown>;
  } catch (e) {
    fail(
      `${SETTINGS_PATH} contains invalid JSON, so I won't touch it.\n` +
        `  Fix or remove it, then re-run. (${(e as Error).message})`,
    );
  }
}

async function writeSettings(settings: Record<string, unknown>): Promise<void> {
  // Back up an existing file once, the first time we change it.
  const existing = Bun.file(SETTINGS_PATH);
  if (await existing.exists()) {
    const backup = `${SETTINGS_PATH}.ez-sandbox.bak`;
    if (!(await Bun.file(backup).exists())) {
      await Bun.write(backup, existing);
      info(`Backed up existing settings to ${dim(backup)}`);
    }
  }
  await Bun.$`mkdir -p ${SETTINGS_DIR}`.quiet();
  await Bun.write(SETTINGS_PATH, JSON.stringify(settings, null, 2) + "\n");
}

// ---------------------------------------------------------------------------
// Linux/WSL dependency install
// ---------------------------------------------------------------------------

interface DepStatus {
  bubblewrap: boolean;
  socat: boolean;
}

async function checkLinuxDeps(): Promise<DepStatus> {
  return {
    bubblewrap: (await which("bwrap")) || (await which("bubblewrap")),
    socat: await which("socat"),
  };
}

function detectPackageManager(): { mgr: string; install: string[] } | null {
  // Ordered by prevalence; first one found wins.
  const candidates: Array<{ bin: string; mgr: string; install: string[] }> = [
    { bin: "apt-get", mgr: "apt-get", install: ["apt-get", "install", "-y"] },
    { bin: "dnf", mgr: "dnf", install: ["dnf", "install", "-y"] },
    { bin: "pacman", mgr: "pacman", install: ["pacman", "-S", "--noconfirm"] },
    { bin: "zypper", mgr: "zypper", install: ["zypper", "install", "-y"] },
    { bin: "apk", mgr: "apk", install: ["apk", "add"] },
  ];
  for (const cand of candidates) {
    // Bun.which is sync and avoids a subprocess here.
    if (Bun.which(cand.bin)) return { mgr: cand.mgr, install: cand.install };
  }
  return null;
}

async function installLinuxDeps(opts: Options, deps: DepStatus): Promise<boolean> {
  const missing: string[] = [];
  if (!deps.bubblewrap) missing.push("bubblewrap");
  if (!deps.socat) missing.push("socat");
  if (missing.length === 0) {
    ok("Linux sandbox dependencies present: bubblewrap, socat");
    return true;
  }

  const pm = detectPackageManager();
  if (!pm) {
    warn(
      `Missing ${missing.join(", ")} and no known package manager found.\n` +
        `  Install them manually, e.g.: ${cyan("sudo apt-get install bubblewrap socat")}`,
    );
    return false;
  }

  const cmd = `sudo ${[...pm.install, ...missing].join(" ")}`;
  info(`Need to install: ${bold(missing.join(", "))}`);
  console.log(`  ${dim("→")} ${cyan(cmd)}`);

  if (opts.dryRun) {
    info("(dry-run) skipping install");
    return false;
  }

  if (!opts.yes) {
    const proceed = await confirm("Run this install command now?");
    if (!proceed) {
      warn(`Skipped. Run it yourself, then re-run ez-sandbox:\n  ${cyan(cmd)}`);
      return false;
    }
  }

  const res = await Bun.$`sudo ${pm.install} ${missing}`.nothrow();
  if (res.exitCode !== 0) {
    warn(`Install command exited ${res.exitCode}. Try manually:\n  ${cyan(cmd)}`);
    return false;
  }
  ok(`Installed ${missing.join(", ")}`);
  return true;
}

// ---------------------------------------------------------------------------
// Status / check
// ---------------------------------------------------------------------------

async function printStatus(os: OS): Promise<void> {
  console.log(bold("Claude Code sandbox status\n"));

  const claudeInstalled = await which("claude");
  console.log(
    `  Claude Code CLI:   ${claudeInstalled ? green("installed") : yellow("not found on PATH")}`,
  );

  const settings = await readSettings();
  const sandbox = settings.sandbox as Record<string, unknown> | undefined;
  const enabled = sandbox?.enabled === true;
  console.log(
    `  sandbox.enabled:   ${enabled ? green("true") : red("false / unset")} ${dim(`(${SETTINGS_PATH})`)}`,
  );

  console.log(`  Platform:          ${os}`);
  if (os === "macos") {
    ok("  macOS uses the built-in Seatbelt framework — no dependencies needed");
  } else if (os === "linux" || os === "wsl") {
    const deps = await checkLinuxDeps();
    console.log(`  bubblewrap:        ${deps.bubblewrap ? green("present") : red("missing")}`);
    console.log(`  socat:             ${deps.socat ? green("present") : red("missing")}`);
  } else if (os === "windows") {
    warn("  Native Windows isn't supported — run Claude Code inside WSL2");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.help) {
    console.log(HELP);
    return;
  }

  const os = await detectOS();

  if (opts.print) {
    console.log(JSON.stringify({ sandbox: buildSandboxConfig(opts) }, null, 2));
    return;
  }

  if (opts.check) {
    await printStatus(os);
    return;
  }

  console.log(bold("Setting up the Claude Code sandbox\n"));

  if (os === "windows") {
    fail(
      "Native Windows isn't supported by Claude Code's sandbox.\n" +
        "  Install WSL2 and run ez-sandbox inside it.",
    );
  }
  if (os === "other") {
    warn("Unrecognized platform — proceeding, but the sandbox may not be available.");
  }

  // 1. Platform dependencies.
  if (os === "macos") {
    ok("macOS detected — Seatbelt is built in, nothing to install");
  } else if (os === "linux" || os === "wsl") {
    info(`${os === "wsl" ? "WSL2" : "Linux"} detected — checking sandbox dependencies`);
    const deps = await checkLinuxDeps();
    const depsOk = await installLinuxDeps(opts, deps);
    if (!depsOk && opts.strict) {
      fail(
        "Dependencies missing and --strict was requested.\n" +
          "  Install bubblewrap + socat, then re-run.",
      );
    }
    if (!depsOk) {
      warn(
        "Continuing, but the sandbox stays inactive on Linux until bubblewrap + socat exist.",
      );
    }
  }

  // 2. Merge sandbox config into settings.json.
  const settings = await readSettings();
  const newSandbox = buildSandboxConfig(opts);
  const before = JSON.stringify(settings.sandbox ?? null);
  const after = JSON.stringify(newSandbox);
  settings.sandbox = newSandbox;

  if (opts.dryRun) {
    console.log();
    info("(dry-run) would write this to " + dim(SETTINGS_PATH) + ":");
    console.log(JSON.stringify({ sandbox: newSandbox }, null, 2));
    return;
  }

  if (before === after) {
    ok("settings.json already has this exact sandbox config — nothing to change");
  } else {
    await writeSettings(settings);
    ok(`Wrote sandbox config to ${dim(SETTINGS_PATH)}`);
  }

  // 3. Friendly summary.
  console.log();
  console.log(bold("Done. Your Claude Code Bash tool is now sandboxed."));
  console.log(`  ${green("•")} Sandboxed Bash can't read: ${dim(DENY_READ.join(", "))}`);
  if (opts.network === "lockdown") {
    console.log(`  ${green("•")} Network locked to: ${dim(LOCKDOWN_DOMAINS.join(", "))}`);
  } else {
    console.log(
      `  ${green("•")} Network: Claude Code prompts on each new domain ${dim("(--network=lockdown for a strict allowlist)")}`,
    );
  }
  console.log(
    dim(
      "\nNote: this sandboxes Bash commands only — file edits, MCP servers, and hooks\n" +
        "still run on the host. For fully unattended / --dangerously-skip-permissions\n" +
        "runs, use a devcontainer or `npx @anthropic-ai/sandbox-runtime claude`.",
    ),
  );
  console.log(dim("Verify any time with: ") + cyan("ez-sandbox --check"));
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
