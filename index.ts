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

// How aggressively to reduce permission prompts (sets permissions.defaultMode).
//   none        → leave defaultMode alone; sandbox still auto-allows Bash, but
//                 file edits/writes prompt as usual.
//   acceptEdits → auto-accept edits/writes in the working dir. Near prompt-free
//                 with the sandbox. No version/model requirements.
//   auto        → Anthropic's classifier-gated mode — the official safe stand-in
//                 for --dangerously-skip-permissions. Needs a recent Claude Code
//                 (≥ v2.1.83) and Opus 4.6+/Sonnet 4.6.
// `undefined` means "not specified on the CLI" → ask interactively (or fall back
// to "none" when running non-interactively / with -y).
type PromptsMode = "none" | "acceptEdits" | "auto";

interface Options {
  dryRun: boolean;
  check: boolean;
  print: boolean;
  strict: boolean; // failIfUnavailable: refuse to start unsandboxed
  network: NetworkMode;
  prompts: PromptsMode | undefined;
  yes: boolean; // skip the Linux dependency-install prompt
  uninstall: boolean; // remove what ez-sandbox added
  help: boolean;
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    dryRun: false,
    check: false,
    print: false,
    strict: false,
    network: "default",
    prompts: undefined,
    yes: false,
    uninstall: false,
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
      case "--uninstall":
        opts.uninstall = true;
        break;
      case "--network=default":
        opts.network = "default";
        break;
      case "--network=lockdown":
        opts.network = "lockdown";
        break;
      case "--auto":
      case "--prompts=auto":
        opts.prompts = "auto";
        break;
      case "--accept-edits":
      case "--prompts=accept-edits":
        opts.prompts = "acceptEdits";
        break;
      case "--prompts=none":
        opts.prompts = "none";
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
  • Optionally reduces permission prompts safely (sandbox replaces the Bash
    prompt; choose how file edits are handled — see --prompts below)
  • Merges into ~/.claude/settings.json without touching your other settings

Options:
  --check            Report current sandbox status and exit (no changes)
  --print            Print the config that would be written, then exit
  --dry-run          Show what would change without writing or installing
  --network=default  Keep Claude Code's prompt-on-new-domain behavior (default)
  --network=lockdown Block egress except Anthropic + common package registries

  Fewer prompts (the safe alternative to --dangerously-skip-permissions):
  --auto             Use Claude Code's classifier-gated 'auto' mode — its
                     official safe stand-in for --dangerously-skip-permissions.
                     Needs Claude Code ≥ v2.1.83 and Opus 4.6+/Sonnet 4.6.
  --accept-edits     Auto-accept file edits/writes in the working dir. Works
                     everywhere; combined with the sandbox it's near prompt-free.
  --prompts=none     Don't touch permission mode (sandbox still auto-allows Bash).
                     If you pass none of these, ez-sandbox asks interactively.

  --strict           Refuse to start Claude Code if the sandbox is unavailable
  --uninstall        Remove the config ez-sandbox added (leaves your other
                     settings untouched)
  -y, --yes          Skip confirmation prompts (defaults to --prompts=none)
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

// Single-select numbered prompt. Returns the chosen choice's `value`, or the
// choice marked `default: true` if input is empty / not a TTY.
async function select<T>(
  question: string,
  choices: Array<{ label: string; hint?: string; value: T; default?: boolean }>,
): Promise<T> {
  const fallback = choices.find((ch) => ch.default) ?? choices[0]!;
  if (!process.stdin.isTTY) return fallback.value;

  console.log(`\n${bold(question)}`);
  choices.forEach((ch, i) => {
    const tag = ch.default ? dim(" (default)") : "";
    const hint = ch.hint ? `  ${dim(ch.hint)}` : "";
    console.log(`  ${cyan(String(i + 1))}) ${ch.label}${tag}${hint}`);
  });
  process.stdout.write(`Choose ${dim(`[1-${choices.length}, Enter=default]`)} `);

  for await (const line of console) {
    const trimmed = line.trim();
    if (trimmed === "") return fallback.value;
    const n = Number(trimmed);
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) {
      return choices[n - 1]!.value;
    }
    process.stdout.write(`${yellow("Enter a number 1-" + choices.length + ":")} `);
  }
  return fallback.value;
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

// Paths we never want sandboxed Bash commands (or their child processes) to read.
// `~/` is expanded by Claude Code; OS-level enforcement covers a Python/Node script
// reading the file, not just `cat`. Listing a path that doesn't exist is harmless,
// so we ship both macOS (~/Library/...) and Linux (~/.config, ~/.local/share) variants.
//
// Sourced from Anthropic's sandboxing docs (which only name ~/.aws and ~/.ssh),
// secret-scanner rule sets (gitleaks, trufflehog, detect-secrets), and each tool's
// official credential-path docs. See README for the "why these and not others" notes.
//
// Whole-directory entries are deliberate: filenames vary and neighboring files leak
// too. Single-FILE entries (e.g. ~/.docker/config.json) are used where the parent
// dir holds non-secret config the agent legitimately needs.
//
// NOTE: mixed secret+config files (~/.npmrc, ~/.gradle/gradle.properties,
// ~/.m2/settings.xml, ~/.config/pip/pip.conf) are intentionally NOT denied here —
// blocking them breaks installs/builds. Scrub those via env vars instead.
const DENY_READ = [
  // ── SSH / GPG / generic auth ──
  "~/.ssh",
  "~/.gnupg",
  "~/.netrc",
  "~/.authinfo",
  "~/.authinfo.gpg",
  "~/.git-credentials",
  "~/.config/git/credentials",
  "~/.envrc", // direnv exports
  "~/.password-store", // pass(1)

  // ── Cloud providers ──
  "~/.aws",
  "~/.config/gcloud", // GCP (Linux + macOS)
  "~/.azure",
  "~/.oci", // Oracle Cloud
  "~/.config/doctl", // DigitalOcean (Linux)
  "~/Library/Application Support/doctl", // DigitalOcean (macOS)
  "~/.config/hcloud", // Hetzner
  "~/.fly", // Fly.io
  "~/.config/linode-cli",
  "~/.ibmcloud",
  "~/.boto", // AWS/GCS boto
  "~/.s3cfg", // s3cmd
  "~/.terraform.d/credentials.tfrc.json",

  // ── Kubernetes / containers ──
  "~/.kube", // kubeconfig dir
  "~/.docker/config.json", // file only — rest of ~/.docker is fine
  "~/.config/containers/auth.json",
  "~/.config/helm", // Linux
  "~/Library/Preferences/helm", // macOS

  // ── Package / registry tokens (secret-only files) ──
  "~/.cargo/credentials",
  "~/.cargo/credentials.toml",
  "~/.gem/credentials",
  "~/.local/share/gem/credentials",
  "~/.pypirc",
  "~/.composer/auth.json", // macOS
  "~/.config/composer/auth.json", // Linux
  "~/.config/pypoetry/auth.toml", // Linux
  "~/Library/Application Support/pypoetry/auth.toml", // macOS

  // ── Dev-platform CLI tokens ──
  "~/.config/gh/hosts.yml", // GitHub CLI (plaintext fallback)
  "~/.config/glab-cli/config.yml", // GitLab CLI
  "~/.local/share/com.vercel.cli/auth.json", // Vercel (Linux)
  "~/Library/Application Support/com.vercel.cli/auth.json", // Vercel (macOS)
  "~/.config/netlify/config.json", // Netlify (Linux)
  "~/Library/Preferences/netlify/config.json", // Netlify (macOS)
  "~/.wrangler", // Cloudflare Wrangler (legacy)
  "~/.config/.wrangler", // Cloudflare Wrangler (Linux XDG)
  "~/.config/heroku", // (Heroku token also lives in ~/.netrc, denied above)
  "~/.databrickscfg",
  "~/.snowflake",
  "~/.config/stripe/config.toml", // Stripe CLI (both OSes)
  "~/.sentryclirc",
  "~/.supabase/access-token",
  "~/.railway/config.json", // Railway (both OSes)
  "~/.terraformrc",

  // ── Databases ──
  "~/.pgpass",
  "~/.pg_service.conf",
  "~/.mylogin.cnf", // MySQL obfuscated login
  "~/.mongorc.js",

  // ── Password managers / secret CLIs ──
  "~/.config/op", // 1Password CLI
  "~/.op",
  "~/Library/Group Containers/2BUA8C4S2C.com.1password", // 1Password (macOS)
  "~/.config/gopass",
  "~/.local/share/gopass",
  "~/.config/Bitwarden CLI", // Bitwarden CLI (Linux)
  "~/Library/Application Support/Bitwarden CLI", // Bitwarden CLI (macOS)
  "~/.vault-token", // HashiCorp Vault

  // ── OS / browser keychains & login stores ──
  "~/Library/Keychains", // macOS Keychain
  "~/.local/share/keyrings", // GNOME keyring (Linux)
  "~/.local/share/kwalletd", // KWallet (Linux)
  "~/.mozilla/firefox", // Firefox logins.json + key4.db (Linux)
  "~/Library/Application Support/Firefox/Profiles", // Firefox (macOS)
  "~/.config/google-chrome", // Chrome (Linux)
  "~/.config/chromium",
  "~/Library/Application Support/Google/Chrome", // Chrome (macOS)

  // ── Crypto wallets ──
  "~/.ethereum/keystore", // geth (Linux)
  "~/Library/Ethereum/keystore", // geth (macOS)
  "~/.bitcoin", // Bitcoin Core (Linux)
  "~/Library/Application Support/Bitcoin", // Bitcoin Core (macOS)
  "~/.config/solana/id.json", // Solana keypair (both OSes)
  "~/.electrum",

  // ── Shell / REPL history (leak inline-typed secrets) ──
  "~/.bash_history",
  "~/.zsh_history",
  "~/.sh_history",
  "~/.history",
  "~/.python_history",
  "~/.node_repl_history",
  "~/.psql_history",
  "~/.mysql_history",
  "~/.rediscli_history",
  "~/.sqlite_history",
  "~/.local/share/fish/fish_history",

  // ── AI coding agents' own credentials ──
  "~/.claude/.credentials.json", // Claude Code (Linux/Windows; macOS uses Keychain)
  "~/.codex/auth.json", // OpenAI Codex CLI (note: ~/.codex, not ~/.config/codex)
  "~/.config/github-copilot",
  "~/.gemini/oauth_creds.json",
  "~/.cursor/cli-config.json",
  "~/.aider.conf.yml",
];

// Filesystem-wide secret patterns the sandbox's path-based denyRead can't express
// (it has no glob support). These go into permissions.deny as Read(...) rules, which
// DO support gitignore-style globs — defense-in-depth for the built-in file tools.
const DENY_READ_GLOBS = [
  "Read(//**/.env)", // any .env anywhere
  "Read(//**/.env.*)",
  "Read(~/**/*.pem)",
  "Read(~/**/*.key)",
  "Read(~/**/*.p12)",
  "Read(~/**/*.pfx)",
  "Read(~/**/*.ppk)",
  "Read(~/**/*.kdbx)", // KeePass databases
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

// permissions.defaultMode values we set for each prompt level. "none" leaves the
// key untouched. These are the only two values we'll remove on uninstall, so we
// never clobber a defaultMode the user chose themselves.
const PROMPTS_TO_MODE: Record<Exclude<PromptsMode, "none">, string> = {
  acceptEdits: "acceptEdits",
  auto: "auto",
};

// Merge our config into the settings object in place: replace the `sandbox` block,
// add our glob Read() deny rules to permissions.deny, and (unless prompts==none)
// set permissions.defaultMode — without dropping the user's own rules or dupes.
function applyConfig(settings: Record<string, unknown>, opts: Options): void {
  settings.sandbox = buildSandboxConfig(opts);

  const permissions = (settings.permissions ??= {}) as Record<string, unknown>;
  const deny = (permissions.deny ??= []) as unknown[];
  for (const rule of DENY_READ_GLOBS) {
    if (!deny.includes(rule)) deny.push(rule);
  }

  const mode = opts.prompts ?? "none";
  if (mode !== "none") {
    permissions.defaultMode = PROMPTS_TO_MODE[mode];
  }
}

// Reverse of applyConfig: remove the `sandbox` block, our glob deny rules, and a
// defaultMode we set — pruning now-empty containers. Returns true if anything was
// actually removed.
function removeConfig(settings: Record<string, unknown>): boolean {
  let changed = false;

  if ("sandbox" in settings) {
    delete settings.sandbox;
    changed = true;
  }

  const permissions = settings.permissions as Record<string, unknown> | undefined;
  if (permissions) {
    const deny = permissions.deny as unknown[] | undefined;
    if (Array.isArray(deny)) {
      const filtered = deny.filter((r) => !DENY_READ_GLOBS.includes(r as string));
      if (filtered.length !== deny.length) {
        changed = true;
        if (filtered.length === 0) delete permissions.deny;
        else permissions.deny = filtered;
      }
    }

    // Only remove defaultMode if it's one of the values WE set, so we don't wipe
    // a mode the user configured independently.
    const ourModes = Object.values(PROMPTS_TO_MODE);
    if (ourModes.includes(permissions.defaultMode as string)) {
      delete permissions.defaultMode;
      changed = true;
    }

    // Drop permissions entirely if it's now an empty object we can safely remove.
    if (Object.keys(permissions).length === 0) {
      delete settings.permissions;
    }
  }

  return changed;
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
// Uninstall
// ---------------------------------------------------------------------------

async function runUninstall(opts: Options): Promise<void> {
  console.log(bold("Removing the ez-sandbox config\n"));

  const file = Bun.file(SETTINGS_PATH);
  if (!(await file.exists())) {
    ok(`Nothing to do — ${dim(SETTINGS_PATH)} doesn't exist`);
    return;
  }

  const settings = await readSettings();
  // Work on a copy so we can show a diff / honor dry-run before committing.
  const next = structuredClone(settings);
  const changed = removeConfig(next);

  if (!changed) {
    ok("No ez-sandbox config found in settings.json — nothing to remove");
    return;
  }

  if (opts.dryRun) {
    info("(dry-run) would remove the `sandbox` block and our Read() deny rules.");
    info("Resulting settings.json:");
    console.log(JSON.stringify(next, null, 2));
    return;
  }

  if (!opts.yes) {
    warn("This removes the `sandbox` block and ez-sandbox's Read() deny rules.");
    warn("Your other Claude Code settings are left untouched.");
    const proceed = await confirm("Proceed?");
    if (!proceed) {
      info("Aborted — nothing changed.");
      return;
    }
  }

  await writeSettings(next);
  ok(`Removed ez-sandbox config from ${dim(SETTINGS_PATH)}`);

  const backup = `${SETTINGS_PATH}.ez-sandbox.bak`;
  if (await Bun.file(backup).exists()) {
    info(`Your pre-install settings backup is still at ${dim(backup)}`);
  }
  console.log();
  console.log(dim("On Linux, bubblewrap and socat were left installed (harmless)."));
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
    const preview: Record<string, unknown> = {};
    applyConfig(preview, opts);
    console.log(JSON.stringify(preview, null, 2));
    return;
  }

  if (opts.check) {
    await printStatus(os);
    return;
  }

  if (opts.uninstall) {
    await runUninstall(opts);
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

  // 2. Decide how aggressively to reduce permission prompts. If the user didn't
  //    pass --auto/--accept-edits/--prompts, ask interactively (non-interactive
  //    runs fall back to "none" — the safe, prompt-preserving default).
  opts.prompts = await resolvePrompts(opts);

  // 3. Merge sandbox config into settings.json.
  const settings = await readSettings();
  const before = JSON.stringify(settings);
  applyConfig(settings, opts);
  const after = JSON.stringify(settings);

  if (opts.dryRun) {
    console.log();
    info("(dry-run) would write this to " + dim(SETTINGS_PATH) + ":");
    console.log(after === before ? "(no changes)" : JSON.stringify(settings, null, 2));
    return;
  }

  if (before === after) {
    ok("settings.json already has this exact sandbox config — nothing to change");
  } else {
    await writeSettings(settings);
    ok(`Wrote sandbox config to ${dim(SETTINGS_PATH)}`);
  }

  // 4. Friendly summary.
  console.log();
  console.log(bold("Done. Your Claude Code Bash tool is now sandboxed."));
  console.log(`  ${green("•")} Sandboxed Bash can't read your secrets ${dim(`(${DENY_READ.length} paths)`)}`);
  if (opts.network === "lockdown") {
    console.log(`  ${green("•")} Network locked to: ${dim(LOCKDOWN_DOMAINS.join(", "))}`);
  } else {
    console.log(
      `  ${green("•")} Network: Claude Code prompts on each new domain ${dim("(--network=lockdown for a strict allowlist)")}`,
    );
  }
  if (opts.prompts === "auto") {
    console.log(
      `  ${green("•")} Permission mode: ${bold("auto")} — Claude runs with background safety checks, far fewer prompts`,
    );
    console.log(
      dim("    (needs Claude Code ≥ v2.1.83 and Opus 4.6+/Sonnet 4.6; otherwise it falls back to prompting)"),
    );
  } else if (opts.prompts === "acceptEdits") {
    console.log(
      `  ${green("•")} Permission mode: ${bold("acceptEdits")} — file edits in your project auto-accept; sandboxed Bash auto-runs`,
    );
  } else {
    console.log(
      `  ${green("•")} Permission mode: unchanged — sandboxed Bash auto-runs, but file edits still prompt`,
    );
    console.log(dim("    (re-run with --auto or --accept-edits for fewer prompts)"));
  }
  console.log(
    dim(
      "\nNote: the sandbox covers Bash commands only — file edits, MCP servers, and\n" +
        "hooks run on the host. 'auto'/'acceptEdits' control whether those file edits\n" +
        "prompt; the sandbox controls what a Bash command can touch.",
    ),
  );
  console.log(
    dim("Verify any time with: ") +
      cyan("ez-sandbox --check") +
      dim("  ·  undo with ") +
      cyan("ez-sandbox --uninstall"),
  );
}

// Resolve the prompt-reduction level. Explicit flag wins; otherwise ask (TTY) or
// default to "none" (non-interactive / -y).
async function resolvePrompts(opts: Options): Promise<PromptsMode> {
  if (opts.prompts !== undefined) return opts.prompts;
  if (opts.yes || !process.stdin.isTTY) return "none";

  return select<PromptsMode>(
    "Reduce permission prompts? The sandbox already lets Bash run without prompts —\n" +
      "this controls whether Claude's file edits also stop asking.",
    [
      {
        label: "Auto mode",
        hint: "fewest prompts; classifier-checked. Safe replacement for --dangerously-skip-permissions. Needs recent Claude Code + Opus/Sonnet 4.6.",
        value: "auto",
      },
      {
        label: "Accept edits",
        hint: "auto-accept file edits in your project. Works everywhere; near prompt-free with the sandbox.",
        value: "acceptEdits",
        default: true,
      },
      {
        label: "Keep prompting for edits",
        hint: "only Bash auto-runs (sandboxed); file edits still ask. Most cautious.",
        value: "none",
      },
    ],
  );
}

main().catch((e) => fail((e as Error).stack ?? String(e)));
