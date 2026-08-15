# NOTES — an honest running log

**Demo-sentence status (all verified in the running app, never fabricated):**

1. **MVP** — "I typed a sentence, it built an automation, I watched it run,
   and nothing touched my files until I said Keep." TRUE — proven with
   SHA256 hashes: identical through build/run/diff, changed only at Keep,
   restored byte-exact by Put it back.
2. **Core** — "I said 'then email me a summary' and it chained two
   automations — watch the real values hand off." TRUE — the baton
   (price = 62953 · change_pct = -0.83) rendered crossing the hand-off in
   chat, on the strip, and in Activity; Save both earned by the watched run.
3. **Stretch** — "It watched the price while I demoed, and fired exactly
   once when it crossed." TRUE — latch armed at 75.51–75.52 above the
   75.50 line, SOL dipped to 75.49 on Coinbase, fired once, post-fire tick
   stayed at one fire.

The packaged NSIS build was verified from its own origin
(http://tauri.localhost): records load, the model doctor round-trips Ollama
("Qwen 9B · 32k memory · your graphics card"), and a full automation run
completed — the #1 CORS trap never got a chance.

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
- **The watcher saga (step 9) was a compressed tour of real-world ops:**
  a hung Ollama request (no per-call timeout) froze the heartbeat's ticking
  guard; CoinGecko's keyless tier rate-limited a demo-heavy afternoon into
  oblivion; the 9B reported "price = 0" for a failed fetch until told never
  to invent values; and the latch then dutifully treated 0 as "already below
  the line". Fixes, in order: per-call timeouts with designed sentences, the
  no-invented-values loop rule, unreadable-value guard (≤0/NaN = "I can't
  read the price any more — fix ›", never data), and the Coinbase fallback
  endpoint from the research catalog (10k/hr where CoinGecko is ~10/min).
  Every failure along the way surfaced as its designed sentence — the
  honesty system debugged its own product.
- **Watch me (branch watch-me), research-first and narration-first.** A
  five-agent research pass settled every layer before code: getDisplayMedia/
  getUserMedia work in WebView2 (the in-window picker IS the consent moment;
  window must be ≥800×600 or the picker crops); whisper.cpp v1.9.2 prebuilt
  whisper-cli + ggml-base.en-q5_1 (59.7 MB — the spec's "74MB base.en" was
  actually 148 MB full) runs as a resource-dir binary behind one Rust
  command; audio goes MediaRecorder webm/opus → decodeAudioData →
  OfflineAudioContext 16k mono → hand-rolled WAV, deleted in finally.
  Two vision traps dodged by design: Ollama silently fuses consecutive
  same-size images into "video frames" (every keyframe gets an interleaved
  text label), and some VL stacks return empty on multi-image (a one-time
  two-square probe gates enrichment). Keyframes: dHash dedupe ≥8 hamming,
  cap 10 with smallest-transition eviction, 1280px JPEG.
  Watch-me is an input adapter, not a second pipeline: transcript (the
  authority) + condensed screen evidence feed the SAME stage-1 compile;
  demo values become fill-ins with the demoed value as example; provenance
  (origin: watched · frames · words) is app-written after validation, never
  sampled. Verified end-to-end with a TTS fixture: 3 frames → consent strip
  → dropped one → real whisper transcript → real vision read → visible burn
  ("Recording deleted — 2 frames and the narration are gone") → "Solana
  Morning Check" compiled with the exact CoinGecko URL, fenced, daily@8 —
  and its watched run fetched a live $75.47 answer. The no-narration rung
  honestly degrades to "type what you did instead" and still compiles.
- **Chat edits now re-validate.** The research pass found the hole: a merge
  patch applied without grounding. Edits now re-run the compiler's schema +
  referential lints (step hostnames ⊆ sources, {tokens} ⊆ inputs, unused
  fill-ins flagged) — a consistent fence change sails through with the
  before/after card as consent; an inconsistent one is refused with the
  exact sentence naming the fix.
- **Voice round two (owner feedback): mic ≠ Watch me, and "nanospark" =
  NVIDIA Parakeet.** A second research pass (Grok/ChatGPT/Wispr/superwhisper
  teardowns + the Open ASR leaderboard) set the grammar: the mic is an
  icon-only DICTATION control in the composer's right rail — tap and you're
  live instantly (optimistic start), the rail becomes waveform · elapsed ·
  ✕ · ✓, hold >300ms is push-to-talk, silence never auto-stops (Windows
  voice typing's most-hated move — we hint instead), and the transcript
  lands IN THE BOX, editable, never auto-sent. Watch me is the labeled
  SESSION control that toggles to Stop while live — Grok's one-tap-you're-
  already-recording feel. STT upgraded to Parakeet TDT 0.6b v3 (the
  leaderboard's speed/accuracy sweet spot, CC-BY-4.0) on the SAME
  whisper.cpp runtime we already ship (parakeet-cli was in the zip all
  along): word-perfect on the fixture in 2.8-3.5s where base.en took ~8s
  with one error. Auto-used when downloaded; base.en stays the 60 MB
  instant default; a failed session keeps its narration for "Listen again"
  — never lose a recording to a processing error (the #1 documented flaw
  in competing dictation flows).
- **ASR verdict re-verified (owner asked "are you sure it's parakeet?").**
  A 4-agent verification pass pulled the Open ASR Leaderboard's own backing
  CSV (updated 2026-07-31): no model named "nanospark" exists anywhere (HF
  full-text: zero results) — it's almost certainly a blend of NVIDIA's
  "Nemotron Nano" LLMs × "DGX Spark" hardware × Spark-TTS (a text-to-speech,
  wrong direction). NVIDIA's actual 2026 ASR release (Nemotron Speech
  Streaming 0.6b) is a voice-agent streaming model at 7.2-7.8% WER — worse
  for offline narration, NeMo/GPU only. Our stack is confirmed: whisper.cpp
  v1.9.0 added official Parakeet TDT support (PR #3735, measured conversion
  parity: 1.96% LibriSpeech), and our q8_0 artifact matches the official
  ggml-org/parakeet-GGUF repo — the only Parakeet ggml in existence.
  Everything ranked above Parakeet today is a proprietary API or a 1-3B
  LLM-decoder with no Windows-CPU runtime. Local hard-fixture A/B: base.en
  turned "append the rows" into "append the rose"; Parakeet got every
  meaning-bearing token right. WATCHLIST for a future swap: (1) a
  parakeet-v2 ggml appears (+0.3pt English, drop-in); (2) llama.cpp fixes
  the >2min mtmd audio bug and Qwen3-ASR-1.7B (5.76% WER, 2.17GB, official
  GGUF) gets a real CPU benchmark — then offer it as an optional accuracy
  mode; (3) Moonshine v2 Medium (ONNX, 258ms) if we ever add live captions;
  (4) an NVIDIA GPU appears — canary-qwen-2.5b becomes king.
- **First real user recording found the intent-vs-imitation gap.** The owner
  demonstrated "search Bing for Tesla stock" — capture, transcription, and
  vision all worked, but the compiler copied the HUMAN's method (a Bing
  search) instead of the goal, and programs can't read search results pages;
  the runner then tried a Yahoo web page (JS-walled) and even fetched the
  literal phrase "google com finance quote tsla" (punycoded into gibberish,
  correctly refused by the fence). Three-layer fix: (1) drafting rule — a
  demonstration shows WHAT, not HOW; goals matching a known-good endpoint
  must use the endpoint even when demoed via a search engine, and search
  engines are banned from sources/steps; (2) fetch_page guards — phrases
  aren't URLs, and search-engine hosts get a redirect-to-the-data-source
  sentence the model can act on mid-run; (3) honesty — a run that reached
  none of its sources finishes "Held back — nothing real to answer with"
  and does NOT earn Save. Verified with an exact repro: the same Bing demo
  context now compiles to query1.finance.yahoo.com and a live run answered
  $342.27 — and the demo's own stale on-screen price did not leak into the
  answer.
- **Render-and-read (owner ask: "make it see the answer on the screen").**
  A 4-agent research pass + a live probe settled the architecture, and the
  research caught a trap that would have sunk a naive build: WebView2's
  CapturePreview NEVER completes on hidden webviews (WebView2Feedback #579)
  — so the render window is visible-but-parked at -32000px with Chromium's
  occlusion throttling disabled at startup. The new read_page tool opens the
  page in a real offscreen InPrivate browser window (fresh cookie jar every
  visit — "it never carries your logins" is true by construction), cancels
  every off-fence top-level navigation including redirects (a hole raw
  fetch never closed), waits for the page to settle with HOST-driven polling
  (page timers throttle when occluded), then reads: rendered text first
  (recursive walker through shadow DOM + same-origin iframes), pixels +
  the local vision model only when text can't carry it — two reads at two
  scales, numbers must agree, "I don't deliver a coin flip." ExecuteScript
  runs host-side with zero IPC exposure to the fenced page — the
  remote-domain IPC capability is never granted. Every rendered read logs
  the helper truth ("pages pull in helpers from other sites — Private Pilot
  only ever steered inside this automation's sources"). Verified live: the
  Bing answer box that started this whole thread reads in 2.0s (342.27 USD
  in rendered text, agreeing with the Yahoo API to the cent), and a full
  model-driven run called read_page and answered $342.27 in 7s, verified
  against the rendered corpus. Search-engine fetches now reroute ("only
  answers in a real browser — use read_page") and the compiler still
  prefers APIs when one covers the goal; watchers stay on API sources
  (rendering is too slow to poll).
- **exceljs over SheetJS-from-CDN.** The pack allows either for .xlsx reads
  (the npm `xlsx` package is frozen at 0.18.5 with two known CVEs — avoided).
  exceljs installs from npm and audits clean, so the lockfile stays honest.
