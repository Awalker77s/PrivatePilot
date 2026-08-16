# Private Pilot

**A Windows app that turns a sentence into an automation you can read — and
runs it on your own machine.** A local model compiles plain English into a
strict-JSON record; that record, not the model, decides what runs. Nothing
leaves the computer unless you flip a labelled switch.

[![verify](https://github.com/Awalker77s/PrivatePilot/actions/workflows/verify.yml/badge.svg)](https://github.com/Awalker77s/PrivatePilot/actions/workflows/verify.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

![Private Pilot — a request compiled into a readable automation, run, and answered in the chat](docs/img/chat-answer.png)

<sub>One sentence → a record you can audit → a watched run → an answer whose
every number was checked against the page it came from. No API key, no account,
no server.</sub>

<!-- After recording the demo, paste the PUBLIC video URL here as:
     > **Demo video:** https://... -->

| | |
|---|---|
| **Stack** | Tauri v2 · React 19 · TypeScript · Rust · Ollama · Featherless.ai |
| **Size** | ~26,000 lines across 100 source files |
| **Platform** | Windows 11 (WebView2) |
| **Team** | Alexander Walker · Mustapha Straton · Ryan Schlosbon |
| **License** | [MIT](LICENSE) |
| **Built** | entirely inside the 48-hour window — first commit [`54ec863`](https://github.com/Awalker77s/PrivatePilot/commit/54ec863) at 6:27 PM CST, 27 minutes after kickoff — [full history](https://github.com/Awalker77s/PrivatePilot/commits/main) |

---

## Why it exists

Automation makes you choose: wire a node graph on a server you maintain, or
hand your files and your inbox to a cloud you can't inspect. Either way you end
up trusting something you can't read.

Doing it locally isn't hard because small models are weak. It's hard because
you get no **guarantees** — a 4B model will invent a filename without
hesitating. So this app doesn't ask it to behave. It removes the option:

> **The only filenames in the model's decoding grammar are the ones actually on
> your disk.** A hallucinated path isn't discouraged, it's *unsampleable*. With
> nothing indexed, the field it would name a file in compiles to `{"not": {}}` —
> a type no string inhabits.

Three more guarantees work the same way — each one a function in the codebase
rather than a sentence in a prompt. They are the whole project:
[**How it works ↓**](#how-it-works)

---

## Quickstart

**Prerequisites:** [Node 20+](https://nodejs.org), [Ollama](https://ollama.com),
and the [Tauri v2 prerequisites](https://tauri.app/start/prerequisites/)
(Rust + VS Build Tools on Windows).

```bash
ollama pull qwen3.5:4b          # the default brain — no key, no account
npm install
npm run tauri dev
```

That's the whole setup. No API key is required for anything in the demo: the
app ships a catalog of **keyless, live-verified public data sources**, so the
first automation works on a machine that has never been configured.

<details>
<summary>Optional extras</summary>

```bash
ollama pull gemma4:12b          # better screen/image reading for "Watch me"
```

- **Cloud compute:** paste a [Featherless.ai](https://featherless.ai) key in
  **Settings → Borrow cloud compute**, then pick a cloud model. Off by
  default; the key is sealed with Windows DPAPI.
- **Packaged build:** `npm run tauri build` produces an NSIS installer and an
  MSI under `src-tauri/target/release/bundle/`.
- **PowerShell:** use `npm.cmd` if script execution is restricted.
- **First run is slow** on CPU (a minute or two while the model loads);
  everything after is much faster.

</details>

---

## Verify it works — no model, no Rust toolchain, no API key

```bash
npm install && npm run verify
```

That type-checks the whole project and runs the regression suite (**83
assertions** covering the compiler's template path, chat routing, sequence
detection and growth, schedule parsing, and the file compiler's refusals). It needs no model, no
network at test time, and none of the Tauri prerequisites — which is why
[CI runs the same command on every push](https://github.com/Awalker77s/PrivatePilot/actions/workflows/verify.yml),
green on a clean Linux runner in under 30 seconds.

**Then try these three in the app** — they exercise the three hardest paths:

| Type this | What it proves |
|---|---|
| `check the current price of bitcoin` | compile → readable record → watched run → verified answer |
| `connect Bitcoin Price Fetch and Bitcoin Morning Note` | sequences built by talking, output→input hand-off |
| `summarize everything in my Downloads folder` | sandboxed file reading, PDFs included |

---

## How it works

A sentence becomes a **record**; the record — not the model — decides what runs.

Here is a real one out of `automations.json` on the machine this was built on.
*"Fetch the current Bitcoin price from CoinGecko"* compiled to this:

```json
{
  "id": "auto-th55fia",
  "name": "Bitcoin Price Fetch",
  "sentence": "Fetch the current Bitcoin price from CoinGecko and determine if it mentions 'bitcoin'.",
  "category": "Web",
  "steps": [
    "https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd&include_24hr_change=true",
    "answer with the price and state whether it mentions 'bitcoin'"
  ],
  "inputs": [],
  "outputs": [
    { "name": "price" },
    { "name": "mentions_bitcoin" }
  ],
  "files": { "reads": [], "writes": [] },
  "sources": ["api.coingecko.com"],
  "apps": [],
  "tools": [],
  "knowledge": [],
  "delivers": "answer",
  "schedule": { "trigger": "manual" },
  "model": "qwen3.5:4b",
  "effort": "quick",
  "compiledBy": "qwen3.5:4b",
  "permissions": {
    "filesystem": { "mode": "none", "reads": [], "writes": [] },
    "network": { "hosts": ["api.coingecko.com"] },
    "commands": [],
    "applications": [],
    "capabilities": []
  },
  "lastRun": {
    "at": 1786847506986,
    "status": "ok",
    "summary": "Bitcoin is $63,058. It is up 0.02% over 24 hours."
  },
  "revision": {
    "id": "rev-auto-th55fia-6-08ehie5",
    "number": 6,
    "contentHash": "08ehie5",
    "status": "published"
  }
}
```

<sub>Formatting only — object literals collapsed onto single lines, and
`origin`/`library` (timestamps and tags) dropped. No field values changed.</sub>

That document *is* the security model, and every field in it is load-bearing:

- **`sources`** is the fence. `fenceAllows()`
  ([src/runner/fetchPage.ts:32](src/runner/fetchPage.ts#L32)) checks every
  outbound request against this list, matching a host or a subdomain of it — so
  `evil-coingecko.com` fails the suffix test rather than sneaking through.
- **`files.reads` / `files.writes` are empty**, so no sandbox is staged, and
  `bindTools()` never puts `read_file` or `write_file` in front of the model at
  all ([src/runner/loop.ts:143](src/runner/loop.ts#L143)). It cannot misuse a
  tool it was never handed.
- **`permissions`** is the declared manifest the approval UI reads: changing
  what an automation is allowed to touch is a visible edit, not a silent one.
- **`compiledBy`** records which model wrote this, and **`revision.contentHash`**
  is what makes a changed automation re-earn its approval.

A person can read all of it before it ever runs — and so can a reviewer.

![The compile-and-run pipeline: plain English through a closed catalog, constrained drafting and a validator loop into a readable automation record, then a fenced tool loop and grounded verification](docs/img/architecture.png)

<details>
<summary>Diagram source (Mermaid)</summary>

```mermaid
flowchart LR
    A["Plain English"] --> B["Closed catalog<br/>real files + hosts"]
    B --> C["Schema-constrained draft<br/>JSON Schema → grammar"]
    C --> D["Validator loop ×3<br/>catalog + shape checks"]
    D --> E[("Automation record<br/>strict JSON, human-readable")]
    E --> F["Agentic tool loop<br/>tools bound per record"]
    F --> G["Fence: hosts + sandbox copy"]
    G --> H["Grounded verification<br/>every number vs source"]
    H --> I["Answer + run receipt"]
    C -.-> M(["Ollama local · Featherless cloud"])
    F -.-> M
```

</details>

Four ideas do the work:

1. **A closed catalog.** Before the model is asked anything, the app lists the
   real folders, files and existing automations and bakes them into the JSON
   schema as enums. The model isn't *asked* to avoid inventing a filename — it
   is structurally unable to emit one. This is the schema the model actually
   receives, generated by `wireJsonSchema()`:

   ```json
   "reads": {
     "type": "array",
     "items": { "type": "string", "enum": ["~/Downloads", "~/Downloads/invoice-jan.pdf"] }
   }
   ```

   Two real paths, and no way to sample a third. With nothing indexed, the same
   field compiles to `"items": { "not": {} }` — a type inhabited by no string at
   all, so the grammar cannot produce a filename because none exists.
2. **Constrained decoding, then correction.** The schema is sent as Ollama's
   `format`, which llama.cpp compiles into a decoding grammar, so malformed
   JSON is unrepresentable. A zod validator then re-checks meaning and hands
   the model exactly what was wrong, up to three passes, with an escape hatch
   that lets it reason in plain words and transcribes the result.
3. **The fence is a function.** `fenceAllows()` compares a request's hostname
   to the record's own `sources` before anything leaves the app; file work
   happens on a sandbox copy with a diff and a **Keep** button.
4. **Numbers are checked against the source.** Every figure in an answer is
   looked for in the data that was actually fetched (allowing honest rounding
   and sums). A number that appears nowhere stops the run.

**Full architecture, with sequence diagrams and a file map:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).**

---

## The engineering worth reading

- **An inference pipeline, not a prompt.** Four compile paths race by cost:
  verified templates (no model, ~1s) → a compact single-job drafter → the full
  schema-constrained compiler → a plan-then-transcribe escape hatch. Bad
  drafts are corrected, and rules a small model can't always satisfy degrade
  to a nudge instead of dead-ending a draft.
- **Blocked is not an answer.** When a site pushes back, a run walks a ladder:
  the same page in a real cloaked offscreen browser → a curated same-fact
  alternative (CoinGecko ↔ Coinbase ↔ Kraken, Nasdaq ↔ Yahoo, Google News ↔
  HN/BBC) → only then a sentence naming every host tried. Substitutions come
  from a hand-written table, never a search result, and are logged into the run.
- **Sequences you can say out loud.** "connect these two", "a sequence of the
  meta price and the orlando weather" — the second builds *both* automations
  and the link between them from one sentence.
- **Reads pages like a person when it must.** A real WebView2 window, kept
  invisible with DWM cloaking, runs the page's JavaScript; if the answer only
  exists as pixels, a local vision model reads it twice and must agree.
- **Your documents, answered with citations.** OCR (Tesseract + pdfium) →
  local embeddings → a plain-file vector store, answering only from your files
  or saying it couldn't find it.
- **Never silent.** Every failure is a designed sentence in one of three
  families: stopped on purpose (gray), needs you (amber), broke (red). A
  rate-limited API says "asked us to slow down" — never a price of 0.

---

## Cloud compute: Featherless.ai (opt-in)

The same pipeline runs against either brain. `src/providers/index.ts` is the
single source of truth, and **"cloud is on" is defined as "a Featherless model
is the current brain"** — there is no second toggle that can drift out of sync
with the model picker.

- OpenAI-compatible chat completions with the same structured-output contract
  the local path uses, so one compiler serves both.
- **Five cloud models, each with a declared role** (`CLOUD_MODELS`,
  [`featherless.ts:23`](src/providers/featherless.ts)) — so picking a brain is
  a choice with a stated reason, not a dropdown of opaque IDs:

  | Model | Role |
  |---|---|
  | `Qwen/Qwen3-32B` | cloud default — native tool calling |
  | `zai-org/GLM-4.7-Flash` | long-context thorough mode (202k) — a corpus the local 4B physically cannot hold |
  | `Qwen/Qwen3-VL-8B-Instruct` | vision |
  | `Qwen/Qwen2.5-7B-Instruct` | the mirror — same weights as the local model, which isolates *compute* from *behaviour* when comparing |
  | `moonshotai/Kimi-K2.6` | showcase (262k context) |

- **The providers are not equally capable, and the pipeline knows it.**
  Ollama compiles a JSON Schema into a decoding grammar; Featherless offers
  `response_format: json_object` but not `json_schema`. So
  `supportsSchemaFormat()` returns `false` for cloud
  ([`featherless.ts:100`](src/providers/featherless.ts)), the request degrades
  to `json_object`, and the **validator loop becomes the primary shape defense
  in the cloud** instead of the grammar. Same compiler, different guarantee —
  declared in code rather than hoped for.
- The key is sealed with **Windows DPAPI** (`src-tauri/src/secrets.rs`) — it
  never sits in a config file in plaintext.
- Concurrency-aware queueing matched to Featherless's plan model.
- Every run record stores `ranOn`, so Activity can always answer *"did this
  leave my computer?"* after the fact.

![The Activity tab: 238 delivered results, an amber card holding 26 jobs that paused before producing an answer, and a footer accounting for which runs used cloud compute](docs/img/activity.png)

That footer — *"19 runs borrowed cloud compute (Featherless) — the rest ran on
this computer"* — is the receipt. So is the amber card: 26 jobs **paused before
producing a result, and nothing was changed or sent**. They aren't hidden to
keep the screenshot clean, because a tool that only shows you its successes is
the thing this project was built against. The red banner is the same principle:
a run that died when the app closed says so, in a sentence, until you deal
with it.

---

## What it can do

- **Tell it** — plain English becomes a strict-JSON record drawn from a
  live-verified catalog of keyless APIs (crypto, stocks, weather, alerts,
  earthquakes, air quality, FX, news from five publishers, Wikipedia,
  dictionary, holidays, recipes, package registries, service status).
- **Watch me** — do the task once while narrating; local speech (whisper.cpp)
  and a local vision model compile the same kind of readable skill. No video
  is kept, and the UI shows the frames being deleted.
- **Sequences & watchers** — named outputs map to named inputs with the baton
  shown crossing each hand-off; "email me when it drops below $75" is a
  latched crossing that fires once and re-arms only after it crosses back.
- **Files, safely** — bulk rename, archives, OCR into searchable PDFs, all on
  a sandbox copy with a diff and Keep (undoable via `.pilot-versions`).
- **Your apps, locally** — Outlook, Gmail (IMAP app password), Spotify, and
  any open window through Windows' accessibility tree. Reading is the default;
  the only writes are a **draft** you send yourself.
- **Editable in words** — "make it 7am" renders a before→after card with
  **Change it / Cancel** and ten versions of history.

![The Automations tab: saved automations and sequences with their last results](docs/img/automations.png)

---

## Project layout

```
src/
  pipeline/     compile: catalog → draft → validate → record
  runner/       run: tool loop, fence, sandbox, verification, fallback ladder
  providers/    Ollama + Featherless, one contract, one router
  storage/      three atomic JSON stores + revisions
  dispatcher/   sequences, watchers, latched crossings
  heavy/        OCR, rename, archives — validated blanks, never shell strings
  rag/          embeddings, vector store, cited answers
  ui/           React surfaces rendered from records, never raw model prose
  connectors/   Outlook, Gmail, Spotify, any open window
src-tauri/      Rust: window cloaking, DPAPI, rasterization, job objects
scripts/        regression suite
docs/           architecture, file-safety model, terminal plan, screenshots
```

## Tests

```bash
npm run verify        # tsc --noEmit + 83 regression assertions
npm run test:quick    # the suite alone
```

The suite runs the real modules through Vite's SSR loader — the compiler's
template path, chat routing, sequence phrasings, schedule parsing, and the
file compiler are all exercised against the actual code, not mocks.

## Docs

- [Architecture](docs/ARCHITECTURE.md) — diagrams, the compile and run paths,
  where every decision lives in the code
- [Heavy tools & documents](docs/heavy-tools-and-documents.md) — the safety
  model for file work and OCR
- [Terminal access plan](docs/terminal-access-plan.md) — why this is not a
  shell, and what it is instead
- [NOTES.md](NOTES.md) — build log and decisions

---

## Citations

**Runtime & libraries**
- [Ollama API](https://docs.ollama.com/api) — structured outputs (`format`),
  `keep_alive`, `num_ctx`, tool calling
- [Featherless.ai](https://docs.featherless.ai) — OpenAI-compatible API,
  concurrency-based plans, model catalog
- [Qwen](https://ollama.com/library/qwen3.5) · [Gemma](https://ollama.com/library/gemma4)
  — local models
- [Tauri v2](https://tauri.app) · [React](https://react.dev) ·
  [Vite](https://vite.dev) · [zod v4](https://zod.dev) (`z.toJSONSchema`)
- [jsdiff](https://github.com/kpdecker/jsdiff) ·
  [dir-compare](https://github.com/gliviu/dir-compare) — diffs and sandbox
  comparison
- [defuddle](https://github.com/kepano/defuddle) +
  [linkedom](https://github.com/WebReflection/linkedom) — page → clean text
- [unpdf](https://github.com/unjs/unpdf) · [exceljs](https://github.com/exceljs/exceljs)
  · [Tesseract](https://github.com/tesseract-ocr/tesseract) ·
  [pdfium](https://pdfium.googlesource.com/pdfium/) — documents
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) — local speech
- [nomic-embed-text](https://ollama.com/library/nomic-embed-text) — embeddings

**Data sources** (all keyless, all live-verified before being baked in — a
sweep of 54 candidates through the app's own fetch path, 53 answering)
- [CoinGecko](https://www.coingecko.com/en/api) ·
  [Coinbase](https://docs.cdp.coinbase.com/) · [Kraken](https://docs.kraken.com/rest/)
- [Nasdaq](https://www.nasdaq.com/) · Yahoo Finance chart API ·
  [frankfurter.dev](https://frankfurter.dev/) · [ECB](https://data.ecb.europa.eu/)
- [Open-Meteo](https://open-meteo.com/) · [NWS/weather.gov](https://www.weather.gov/documentation/services-web-api)
  · [USGS earthquakes](https://earthquake.usgs.gov/fdsnws/event/1/)
- [Google News RSS](https://news.google.com/) · BBC · Guardian · NYT · NPR ·
  Al Jazeera · [HN Algolia](https://hn.algolia.com/api)
- [Wikipedia REST](https://en.wikipedia.org/api/rest_v1/) ·
  [dictionaryapi.dev](https://dictionaryapi.dev/) ·
  [REST Countries](https://restcountries.com/) · [Nager.Date](https://date.nager.at/)
  · [openFDA](https://open.fda.gov/apis/) · [Open Library](https://openlibrary.org/developers/api)
- [TheSportsDB](https://www.thesportsdb.com/api.php) ·
  [TheMealDB](https://www.themealdb.com/api.php) · Statuspage `status.json`

**Prior art this argues with:** n8n's self-hosting docs and community forum
(silent failure, hours to a first workflow) and Zapier's run history (tells you
a Zap *succeeded*, not what it *found*).

---

## Team

Built by **Alexander Walker**, **Mustapha Straton**, and **Ryan Schlosbon**.

## License

[MIT](LICENSE) © 2026 Alexander Walker, Mustapha Straton, and Ryan Schlosbon
