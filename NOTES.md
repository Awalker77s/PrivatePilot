# NOTES — an honest running log

What was hard, what we decided, and why. Newest entries at the bottom of each
day. This becomes the writeup.

## 2026-08-14 — setup + step 1 (the shell)

- **The machine wasn't prepped.** The pack's compliance list assumes Rust + VS
  Build Tools before kickoff; this machine had neither. Installed rustup
  (stable-msvc 1.97.1) and VS Build Tools 2022 with the VC++ workload via
  winget, and pulled `qwen3.5:9b` (6.6 GB) — the exact local default the pack
  pins. `qwen2.5:7b` was already present, which is the pack's own compatibility
  fallback, so we had a floor either way.
- **Two Rust commands, not zero.** The baseline is zero custom Rust, but two
  gaps are exactly the escape hatches the pack sanctions: (1) dialog-picked
  folders are NOT auto-added to the fs scope — `allow_folder`/`allow_file`
  call `fs_scope().allow_directory/allow_file` at pick time; (2) plugin-fs
  exposes no fsync, and the atomic-write spec demands temp → **fsync** →
  rename — `atomic_write` does one attempt in Rust (`File::sync_all`), while
  the Defender/indexer EPERM backoff retry stays in TypeScript where its
  failure state is designed UI.
- **The PDF's CSS isn't extractable as text** (the build pack is a rendered
  PDF; its stylesheet styled the document itself). Recreated the tokens file
  from A2's explicit values (all hex colors, type scale, radii, glyph spec)
  and matched the four mockups by eye. The seven category gradients are named
  documents / email / web / notes / money / watch / files to cover the
  categories the mockups show.
- **A trap the pack didn't list: Tauri's http scope ignores ports in `**`
  patterns.** `{"url": "http://**"}` silently fails to match
  `http://127.0.0.1:11434` — the URLPattern port defaults to 80. Every call to
  Ollama died with "url not allowed on the configured scope" until the
  capability gained explicit `http://*:*/**` port-wildcard entries. Found by
  probing the real webview over CDP, which is now the build's verification
  harness (dev-only `window.__pp` hook; see devhook.ts).
- **Verification harness: CDP into the real app.** The permission-gated
  screen-control path couldn't see the dev-mode window, so the app is driven
  through WebView2's `--remote-debugging-port` instead — real IPC, real fs,
  real Ollama, and the UI itself clicked by script. Every step's "done when"
  is checked in the actually-running app this way.
- **Step 4 fought back four ways, all instructive:**
  1. *The think channel ate the draft.* qwen3.5 is a thinking model — with
     `format:` set, the entire first response went into thinking and content
     came back empty. `think: false` on every drafting call fixed it. (The
     validator loop caught it meanwhile — "Draft 1 — not valid JSON (empty
     response)" — exactly the honesty it was built for.)
  2. *The prompt was silently truncating the draft.* The catalog lived twice
     in the call (schema enums + a prompt file list) and blew the 16k drafting
     context, cutting the JSON mid-array; the "fix only the fields listed"
     pass then faithfully preserved the wrong single-automation shape. Cut the
     duplicate list, capped the catalog at 150 files. 199s → 14–29s per draft.
  3. *Downloads starved Documents.* A flat global cap filled entirely from
     the first folder, so invoices-2026.xlsx wasn't in the enum and the
     matcher couldn't offer it. Round-robin allocation across folders.
  4. *The 9B wouldn't split "then email me" into a second automation* until
     the few-shot example mirrored the exact structure (read+write = one job,
     recap = second, chain mapping named outputs). Rules alone didn't land;
     one structurally-identical example did. Validator refinements now also
     require 2+ automations to be chain-connected.
- **Aliases and picked folders live in settings.json** (config, not data) —
  the three-JSON-file rule covers the data model; ask-once-remember-forever
  memory and the Featherless key need somewhere local to live.
- **Version history lives inside automations.json** as a `versions` map next
  to `records` — still exactly three data files, records verbatim A5.
- **The runner's fights, and what won:**
  1. *The think channel struck again* — in the tool loop this time: after
     reading everything, the model spent a whole turn thinking and emitted
     empty content, which read as "no answer". `think: false` on loop calls,
     plus an honestly-logged one-time nudge ("An empty turn — asked it to
     answer in words").
  2. *Grounded verification was too honest.* The sum $1,240 appears in no
     source file, and the 9B's arithmetic check only tried pairwise sums, so
     the run blocked on a correct number. Stage 5 now does what A4 literally
     says — "plain code + one temp-0 check": a subset-sum in code proves
     derivability deterministically (1240 = 415 + 612.5 + 212.5 · checked in
     code), with the model check as fallback for anything code can't derive.
  3. *Spreadsheets diff as tables, not bytes* — write_file to .xlsx takes CSV
     and becomes a real workbook via exceljs, and the diff card extracts both
     sides back to rows, so "what changed" is three green + lines, not
     "binary changed".
  4. *dir-compare and linkedom can't run in a webview* (Node fs / no-DOM
     environments). The diff walk implements dir-compare's semantics
     (compareSize → compareContent) over plugin-fs; defuddle runs on the
     webview's own DOMParser with readability as the pinned fallback. Both
     pinned packages stay in package.json as the spec's stack.
  5. *MVP verified with file hashes*: the tracking sheet's SHA256 was
     identical through build + run + diff; changed only at Keep; the
     .pilot-versions restore brought back the exact original hash.
- **Mid-build pivot (owner direction): online-first.** Automations now
  default to fetching the web and answering in the app; files are a
  background capability with the sandbox/Keep story intact. A four-agent
  research pass live-verified a keyless endpoint catalog (CoinGecko, Yahoo
  v8 chart, Open-Meteo, frankfurter.dev — note: .app is dead, moved to
  .dev/v1 — Google News RSS, HN Algolia, statuspages, TheSportsDB) and
  flagged the broken ones (Stooq now serves a JS proof-of-work wall, Binance
  geo-blocks US IPs with 451, Reddit JSON 403s). endpoints.ts is the single
  source of truth: the drafting prompt's menu is generated from it.
- **Verification kept blocking honest rounding** — the model says "-0.78%"
  for a source value of -0.7789 and subset-sum can't derive rounding, so
  stage 5 gained a precision-aware match (a claim verifies if a source
  number rounds to it at the claim's own precision).
- **"Send email" made the 9B ramble about its missing tools** mid-answer.
  One loop-prompt rule fixed it: a drafting job's final answer IS the
  message; the app owns the Send button (mailto: opens the user's own mail
  client — nothing sends itself).
- **The starter gallery doubles as the empty state** — eight hand-written,
  guaranteed-valid records (one fenced hostname each); Try it saves and runs
  in one click, so the first result card lands in seconds. Curated records
  skip earned-Save: that rule guards model drafts, not vetted ones.
- **exceljs over SheetJS-from-CDN.** The pack allows either for .xlsx reads
  (the npm `xlsx` package is frozen at 0.18.5 with two known CVEs — avoided).
  exceljs installs from npm and audits clean, so the lockfile stays honest.
