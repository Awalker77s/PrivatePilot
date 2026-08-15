# Terminal access — the plan

**Status:** decision-ready · 2026-08-15 · branch `local-models`
**Author:** research fleet (4 lenses) → architect → adversarial critic, merged.

## Verdict up front

**Private Pilot never ships a terminal.** It ships a **fourth fence** — `tools` — carrying
typed heavy-task tools whose command lines are built by *our code*, never sampled from the
model. The model fills blanks in a command we wrote; it never types a command.

The incident record says the quiet part out loud: every agent-shell disaster of 2025–26
(Cursor's README-injection exfil, the Amazon Q wiper, Claude Code allowlist-bypass CVEs,
Gemini CLI's `move *` that ate a directory) crossed a boundary that existed **only as words**.
Our boundaries are closed enums in Rust and zod. That stays true here.

Grounded against the code as of this branch: `src/runner/loop.ts` (per-record `bindTools`,
one call/turn, zod `safeParse` on tool args, `heldBack`), `src/runner/run.ts` + `sandbox.ts`
+ `diff.ts` (copy-based sandbox → diff card → **Keep** → `.pilot-versions` undo),
`src/pipeline/draft/schema.ts` (fences as closed `z.enum`s + `superRefine` lints),
`src/connectors/registry.ts` (the `ToolSpec` manifest pattern), `src/storage/settings.ts`
(consent flags, absent = off), `src-tauri/src/lib.rs` + `outlook_classic.rs` (how Rust spawns
vetted processes today: absolute path, `CREATE_NO_WINDOW`, drained pipes, hard timeout).

---

## A. Goals and non-goals

**What "heavier tasks" means, ranked by real demand** (8 of the top 10 fit closed typed-tool
vocabularies — freeform shell is the wrong tool for almost all of it):

| # | Task | Shape | Binary? |
|---|------|-------|---------|
| 1 | Bulk image resize / convert | **typed tool** | ffmpeg |
| 2 | Bulk rename (regex, numbering, case) | **typed tool** | none — pure Rust, diff-native |
| 3 | Bulk video/audio convert + trim | **typed tool** | ffmpeg |
| 4 | Zip / unzip / archive | **typed tool** | 7za (~2 MB) |
| 5 | Folder mirror / backup | **typed tool** | robocopy / Rust |
| 6 | OCR → searchable PDF | **typed tool** | tesseract |
| 7 | Disk cleanup / duplicates | **typed tool** | none — pure Rust |
| 8 | Doc conversion (md/docx/html) | **typed tool** | pandoc |
| 9 | Python on CSVs | *scripted (Tier 2)* | bundled CPython |
| 10 | Git for tinkerers | read-only subset, later | git if present |

**Goals:** a `tools` fence in the record (closed enum, exactly like `apps`); a Rust `run_tool`
command (argv arrays, job object, kill + timeout + output caps); the three highest-demand
typed tools running inside the existing sandbox → diff → **Keep** machinery; a Settings
consent card; every new failure a designed sentence in the existing three families.

**Non-goals (each with its honest sentence):**
- **Freeform interactive shell** — never. Per-command y/n on raw PowerShell is consent theater
  for people who can't read PowerShell. Soul rule: *"Private Pilot never gives the model a terminal."*
- **Installing things** (winget/pip/npm) — *"That needs installing software, which Private Pilot
  doesn't do — it only runs its own vetted tools."*
- **Admin / elevation** — the machine promises us nothing; the design must not either.
- **yt-dlp / media downloading** — legal gray, brand poison; an amber card explaining why.
- **Denylists** — Cursor's was bypassed four ways then deprecated. We allowlist only.

---

## B. Threat model

The specific shape of our problem: **a 7–14B local model reads untrusted bytes (web via
`fetch_page`/`read_page`, mail via gmail/outlook, app windows via `read_app`) inside the same
loop that would drive heavy tasks.** Small open models are worst-in-class at instruction
hierarchy; injected-content→shell-execution succeeds most of the time against agentic tools. So
the design assumption is not "the model might be tricked" — it is **"the model, mid-run, is
cooperating with the attacker."** Every control is enforced in TypeScript/Rust, not in a prompt.

| # | Attack | Control (and where it lives) |
|---|--------|------------------------------|
| 1 | Text says "run this command" → model emits a shell string | **There is no string channel.** No tool accepts a command line. TS builds argv; Rust spawns `exe + argv[]` directly — `&&`, `;`, `\|`, backticks are inert bytes. |
| 2 | Injection steers *arguments* (convert "into" `C:\Windows`, zip `~/Documents`) | Paths validated via existing `toSandboxPath`; outside the `files` fence → refusal sentence. All writes → sandbox copy; diff + **Keep** is a human gate the attacker can't cross. |
| 3 | **Exfiltration** — child opens a socket | No-network shell (see §C egress). Baseline: hardened operand validator + ffmpeg `-protocol_whitelist file,pipe -nostdin` + scrubbed env. **Enforced (slice 2): AppContainer without `internetClient`** — WFP default-denies every socket, no admin. |
| 4 | **Argument injection** into a vetted binary (`git -c core.pager`, `find -exec`, ffmpeg protocols) | The model never supplies flags. Each tool's `build()` emits a **fixed flag skeleton**; model fills only operand slots, validated (see the hardened validator in §C). |
| 5 | Model-authored edits raise capability | Capability lives in the record's `tools` fence + Settings consent — outside anything the model reads or writes mid-run. Edits re-validate through the same closed-enum schema; the card re-renders chips before Save. |
| 6 | Runaway (transcode forever, zip bomb, fork bomb, 60 GB output) | Job object: `KILL_ON_JOB_CLOSE`, no `BREAKAWAY_OK`, active-process cap, memory cap, user-time cap; wall-clock `TerminateJobObject`; output caps; disk-quota check. Cost card gates big jobs. |
| 7 | Hostile filenames (`--delete-after.mp4`, reserved device names) | argv makes metacharacters inert; leading-`-`/`@` rule catches flag/response-file names; Rust rejects `CON`/`NUL`/…, ADS, and any path normalizing outside the sandbox (zip-slip check on every extracted entry). |
| 8 | ANSI/control-char injection hiding the action | Nothing renders in a terminal. Cost/diff/Approve cards render in React with control chars stripped. |
| 9 | Sandbox-directory escape (traversal, symlinks) | cwd = the run's sandbox base; outputs built by TS inside it; `copy_dir` skips symlinks; Rust canonicalizes + verifies containment before and after. AppContainer adds ACE grants on sandbox dirs only. |
| 10 | Unattended escalation (a watcher quietly transcoding) | **Watchers never shell** — `trigger:"watch"` + non-empty `tools` is a validator error and a runner `heldBack`. Daily heavy runs may *stage* but end at the diff/Keep card — an unattended run can stage, never apply. |
| 11 | Supply chain on the binaries | Bundled binaries ride the installer (absolute path, no PATH search). Fetched binaries: pinned SHA-256 verified in Rust, downloaded to an app-only-writable dir, before the file is executable. An automation can never trigger a fetch — only the person, from an amber card. |
| 12 | Secrets reachable by the child (Gmail password, settings.json) | The child's grants are the sandbox only; env scrubbed. **Fix required (see §F): the Gmail DPAPI seal currently uses no entropy — a same-user child could decrypt it.** Under AppContainer default-deny FS this becomes structural. |

The kill chain we sever, named: **untrusted text → model → command string → interpreter →
network.** Rows 1, 3, 4 each cut a different link; the sandbox + Keep (2, 9, 10) make a
surviving attack un-actionable. One inherited strength: the Gemini `move *` disaster is
**already impossible here** — heavy tools run in a copy, and Keep moves originals to
`.pilot-versions/<runId>/`.

---

## C. The design — a capability ladder

- **Tier 0** (exists): typed read tools + `write_file` into the sandbox. Unchanged.
- **Tier 1 — Heavy tools:** typed verbs, our argv, vetted binaries, existing sandbox, new
  `run_tool`. *The model fills blanks in a command we wrote.*
- **Tier 2 — Scripted tasks:** a Python script authored **at compile time from the user's own
  words**, hash-pinned in the record, consented by its **effect** (a dry-run diff), executed
  under AppContainer. Off by default; **does not ship until AppContainer exists.**
- **Tier 3 — Not now:** freeform shell, installs, admin. (§A.)

### Tier 1 contract (concrete to this codebase)

`src/heavy/registry.ts` mirrors `src/connectors/registry.ts`:

```ts
interface HeavyToolSpec {
  def: ToolDef;                 // what the model sees
  params: z.ZodTypeAny;         // safeParse before anything runs (same as connectors)
  build: (args, sandbox) => Promise<HeavyPlan | HonestRefusal>;  // TS owns the command line
  estimate: (args, sandbox) => Promise<CostEstimate>;            // files, bytes, ~minutes
  sentences: {...};             // designed failures, all three families
}
interface HeavyPlan {
  exe: string;        // ABSOLUTE path to a bundled/verified .exe — no PATH search, ever
  argv: string[];     // fixed skeleton + validated operands; no cmd.exe, no pwsh
  cwd: string;        // sandbox.base — always
  timeoutMs: number;  // set by TS, never by the model
  maxOutputBytes: number;
  outputs: string[];  // paths the tool promises to create (checked after)
}
```

`src-tauri/src/heavy.rs` — one command, `run_tool(plan)`, the only spawn path:
child created **suspended** → assigned to a fresh **job object** (kill-on-close, no breakaway,
process/memory/time caps) → resumed; wall-clock timeout → `TerminateJobObject`; env scrubbed
to `{SystemRoot, TEMP→sandbox tmp}`; verifies `exe` is under `resource_dir/binaries` or
`$APPDATA/tools/` **and ends in `.exe`** (never `.bat`/`.cmd` — those re-parse through
`cmd.exe` and reopen metacharacter injection, BatBadBut/CVE-2024-24576); every argv path
element canonicalized inside the sandbox base; exit-code + missing-promised-output checks are
the tool contract, not model diligence.

**The hardened operand validator** (load-bearing — this is where argument injection lives). For
every model-supplied operand: reject leading `-`, reject leading `@` (ffmpeg/7za response
files), reject **any `:` except a single drive-letter colon at index 1** (kills `concat:`,
`subfile:`, `http:`, and NTFS `name:stream`), reject `::$DATA`, reject trailing dots/spaces.
For **ffmpeg specifically**: assert `-protocol_whitelist file,pipe -nostdin` **precedes** `-i`
(placement is load-bearing), and select the hardware H.264 encoder per GPU
(NVENC→AMF→QSV) with an honest amber when none is present. For **7za**: the fixed skeleton
bans `-sfx` (self-extracting archives are an exec/persist vector).

**The three that ship first, in build order (risk ladder):**
1. **`bulk_rename`** — pure Rust/TS, **no binary**: pattern + numbering, executed as renames in
   the sandbox copy so the diff card previews every old→new name. Zero network, no injection
   surface. Ships first.
2. **`zip_folder` / `unzip`** — 7za (bundled, ~2 MB). Zip-slip containment on every entry.
   Zero network.
3. **`convert_media`** — ffmpeg. TS maps a `quality` enum → a fixed preset table (the model
   never sees an ffmpeg flag). **This is the one injectable, network-capable binary** — see the
   ordering decision in §E.

**Staged-outputs sandbox mode:** copying 40 videos before work starts is absurd, so
`buildSandbox` gains a per-root mode for media-scale jobs — **inputs opened read-only *at the
OS level* from the real folder** (open `GENERIC_READ`/`FILE_SHARE_READ`, or AppContainer
read-only ACE — never a convention that "we only pass it as `-i`"), outputs write to the
staging dir, nothing pre-copied. The Keep card shows added files + before/after sizes +
thumbnails; Keep moves originals to `.pilot-versions`. Soul rule preserved: nothing touches
real files until Keep, Keep stays undoable.

`bindTools` grows one clause, symmetric with connectors: heavy tools bind only when
`record.tools?.length > 0` **and** the Settings consent flag is on **and** `sandbox !== null`.

### Network egress policy, per tier

| Tier | Policy | Enforcement |
|------|--------|-------------|
| 1 | **No network — by argument discipline in v1, OS-enforced under AppContainer in slice 2.** (Honest labeling: not "egress-zero by construction" — the v1 baseline has *no OS boundary*; it holds because the shipping binaries have fixed argv and can't be steered to a socket. The run log says which is true.) | v1: hardened validator + ffmpeg protocol whitelist + scrubbed env. Slice 2: AppContainer without `internetClient` (WFP socket default-deny, no admin) **together with** execute-deny FS outside the sandbox (Project Zero: WFP permit filters can match on exe path and ignore the package SID, so network-deny is load-bearing only when the child also can't launch a system binary). |
| 2 | **No network, enforced.** | AppContainer mandatory — a precondition, not an option. |
| any | "needs the web mid-task" | Route through the hostname-fenced `fetch_page` before/after the heavy step, or park amber: *"This needs the web mid-task, which heavy tools can't touch — I fetch first, work offline second."* No fenced-proxy build in v1. |

### How records encode it

```ts
// storage/types.ts — one new fence, absent on old records (like apps):
tools?: string[];   // closed enum: "bulk_rename" | "zip_folder" | "convert_media" | …
```

- **Wire schema:** `tools: z.array(z.enum(HEAVY_TOOL_IDS))` — a nonexistent tool is unsampleable
  (same trick as `apps`).
- **Validator rules** (mirroring the app lints): a step naming a heavy tool requires it in
  `tools`; `tools.length > 0` requires a non-empty `files` fence; **`trigger:"watch"` +
  `tools.length > 0` is an error** (*"Watchers check values — they never run heavy tools."*).
- **Drafter menu:** one line per tool with live availability + rules ("an automation that uses a
  heavy tool MUST list it in `tools` and name real folders in `files` — heavy tools never touch
  the web, and watchers never use them"; "if the person asks to install software, download
  videos, or run commands, say Private Pilot doesn't do that — never improvise it").
- **Card chips:** the built card renders the `tools` fence as capability chips, so a chat edit
  that adds one is visible before Save.

### The new honest sentences (selection)

- Amber: *"Heavy tasks are off — Settings → Heavy tasks → Allow file & media tools."*
- Amber (cost, attended): *"This would re-encode 4 hours of video — about 40 minutes of fan
  noise. Run it?"*
- Amber (cost, unattended): *"Held back — this run wants to convert 212 files, which needs you
  present. Open it and press Run."*
- Amber (blocked program): *"This wants to run 'curl', which isn't one of Private Pilot's vetted
  tools — it stopped and touched nothing."*
- Amber (**injection-suspect**): *"The page you read asked me to run something — I don't take
  orders from pages. I finished your job and ignored theirs."* (sibling copy for mail / windows)
- Red: *"ffmpeg stopped partway (file 12 of 40) — your originals are untouched, and nothing
  half-done was kept."*
- Red: *"The tool tried to write outside its sandbox — run stopped, everything discarded."*

### Settings — the third card

`HeavyTasksCard` beside Connected apps: *"Let automations do real work on your files — convert
videos and photos, rename in bulk, pack archives. Everything runs on this computer, in a copy of
your folders, with no internet — you see every change and keep only what you approve."* One
**File & media tools** `[Allow]` row. (A **Scripts** row stays hidden until Tier 2 exists.)

---

## D. Build plan (honest hours, incl. verification in the running app)

**Slice 1 — Tier 1 core: `run_tool` + three tools (~28–34 h).** `heavy.rs` (job object +
timeout + env scrub + path re-checks + progress events) 6–8 h; binary provisioning (bundle 7za,
`tool_fetch` with pinned hash for ffmpeg) 3–4 h; registry + three specs 7–9 h; loop bind +
dispatch + sentences 2–3 h; `tools` fence (schema + drafter + types) 2–3 h; staged-outputs
sandbox + media Keep card 5–6 h; Settings card + chips 2–3 h; cost card + progress + cancel 3–4 h.
**Ships:** "shrink these 40 videos for email", "rename every IMG_ to Sicily-{n}", "zip last
month's invoices" — sandbox-true, no-network-by-discipline, every failure designed.

**Slice 2 — enforcement (before any Tier 2; ~18–26 h).** AppContainer/LPAC spawn path in
`heavy.rs` (profile create, hand-rolled `CreateProcessW` + `SECURITY_CAPABILITIES` — the
`windows` crate won't carry the attribute on stable Rust; reference crate **`rappct`**, which
covers AC+LPAC launch, capabilities, SIDs, ACLs), ACE grants on sandbox dirs, honest fallback
to baseline when container creation fails on locked-down enterprise images; then flip Tier 1 to
AppContainer-by-default and upgrade the run-log line to "no internet — enforced by Windows".
Plus `ocr_pdf`, `find_duplicates`. **Budget the full 2–3 days — the plumbing is known-fiddly.**

**Slice 3 — Tier 2, only if E4 says ship (~22–30 h).** Compile-step script authoring +
**effect-consent** (run the script as a dry-run in the sandbox and let the user approve the
resulting *diff*, never the code — the only honest consent for people who can't read code);
`script` field + hash pinning; CPython embeddable; import-scan tripwire (a courtesy check, not a
boundary — CPython self-sandboxing is a solved-negative; AppContainer is the boundary). **Hard
precondition: slice 2 proven on real machines.**

---

## E. Decisions for you (recommendation on each)

1. **Bundle ffmpeg/7z or fetch-on-demand + hash?** → **Hybrid.** Bundle 7za (~2 MB, invisible);
   fetch ffmpeg on first media task with a pinned SHA-256 + an announce card. **Correction the
   research forced:** there is **no "official" FFmpeg binary**; the common Windows builds are
   **GPLv3** (can't bundle with a closed app); use a **self-built or BtbN `-lgpl`** build — which
   has *no software H.264*, so mp4 depends on a hardware encoder (NVENC on your NVIDIA laptop
   works; a machine without one gets an honest amber, never silent failure). Add a **Licenses
   screen with the LGPL notice + a written offer for source** ("kept on this machine" doesn't
   discharge LGPL).
2. **Which 3 tools first?** → **`bulk_rename` → `zip_folder` → `convert_media`.** This order is
   the injection-surface ladder: no-binary/no-network → tiny-binary/no-network → the one
   injectable, network-capable binary last. It also means **"sandbox = real jail" can be true
   (AppContainer) before the one dangerous binary ships** — consider holding `convert_media`'s
   default-on until slice 2, or ship it labeled honestly as resting on ffmpeg's own protocol
   whitelist.
3. **AppContainer now or later?** → **Slice 2, immediately after Tier 1.** The v1 baseline is a
   *strong* baseline (no string channel to inject into), so shipping a weekend earlier is worth
   it — but exfil isn't OS-enforced until AppContainer, it's the flip that makes the marketing
   line literally true, and Tier 2 is dead-gated on it.
4. **Does Tier 2 (scripts) ship at all?** → **No, not in the default build — keep the design,
   defer the decision.** 8 of 10 heavy tasks never need it, and asking a non-coder to approve
   Python is consent theater. Ship Tier 1, watch which amber sentences actually fire; if the
   "wants a script" tail is real, build Tier 2 with **effect-consent** (dry-run diff) behind an
   off-by-default toggle worded for people who read code. **"Private Pilot never gives the model
   a terminal"** survives either way — a pinned, pre-approved script is not a terminal.
5. **Daily-scheduled heavy runs from day one?** → **Yes.** They can only stage into the sandbox
   and park at the Keep card, so "every night, shrink yesterday's screen recordings" wakes you to
   a diff, not to fan noise. Watchers stay banned (validator + runner).

## F. Fix to make now, regardless (found by the critic in existing code)

`src-tauri/src/secrets.rs` seals with `CryptProtectData(..., None /* entropy */, ...)`. DPAPI
without entropy is a **per-user**, not per-process, boundary — any same-user process (including a
future sandbox child) can decrypt the Gmail app password from its `%APPDATA%` blob. **Add
per-install entropy** to the protect/unprotect calls. Small change, closes a real gap, and it's a
precondition for the whole terminal-access threat model to hold. (Also ring-fence the
`outlook_classic.rs` `-ExecutionPolicy Bypass -EncodedCommand` pattern in a comment as
"connectors only, const scripts only" so no future heavy tool copies it.)
