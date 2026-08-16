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
| **Team** | Alexander Walker · Mustapha Strachan · Ryan Schlosbon |
| **License** | [MIT](LICENSE) |
| **Built** | entirely inside the 48-hour window — first commit [`54ec863`](https://github.com/Awalker77s/PrivatePilot/commit/54ec863) at 6:27 PM CST, 27 minutes after kickoff — [full history](https://github.com/Awalker77s/PrivatePilot/commits/main) |

---

## What you actually do with it

You type a sentence. You get back a small card describing a job — in plain
English, with the exact websites and files it will touch — and a button to run
it. Keep it, and it becomes an automation you can schedule, edit by talking to
it, or chain onto others.

| You say | You get |
|---|---|
| *"check the current price of bitcoin"* | a live answer, with every number checked against the page it came from |
| *"every morning at 8, give me the top tech news"* | a scheduled job that greets you with a briefing |
| *"email me when solana drops below $75"* | a watcher that fires **once** at the crossing, then re-arms when it crosses back |
| *"summarize everything in my Downloads folder"* | PDFs, spreadsheets and documents read and summarised — on a copy, never the originals |
| *"make a sequence of the bitcoin price and the weather in orlando"* | two automations **and** the hand-off between them, from one sentence |
| *"actually make it 7am"* | a before → after card with **Change it** and **Cancel** |

Six things it can do, in one line each:

- **Read the web** — a catalog of live-verified, keyless public sources: crypto,
  stocks, weather, earthquakes, air quality, currencies, news from five
  publishers, Wikipedia, holidays, package registries, service status.
- **Read your documents** — ask questions about a folder and get answers with
  citations, including scans, which it OCRs into searchable PDFs first.
- **Handle files safely** — rename in bulk, zip, convert. Always on a copy, with
  a diff and a **Keep** button, so a mistake costs a click.
- **Watch and wait** — schedules from a minute upward, and threshold alerts that
  don't spam you.
- **Reach your apps** — Gmail over IMAP and any open window on the machine.
  Reading is the default; the only write is a draft you send yourself.
- **Learn by watching** — do the task once while narrating, and it compiles what
  you did into the same kind of readable automation.

![The Automations tab: saved automations and sequences with their last results](docs/img/automations.png)

---

## Why it exists

Automation makes you choose: wire a node graph on a server you maintain, or hand
your files and your inbox to a cloud you can't inspect. Either way you end up
trusting something you can't read.

Running the model on your own machine solves the privacy half. The hard half is
**trust**: a small model will happily invent a filename that doesn't exist. So
this app doesn't ask it to behave — it removes the option.

> **The only filenames the model can produce are the ones actually on your
> disk.** Not "discouraged from inventing" — *unable to*. The list of real files
> is compiled into the grammar it writes with, so a made-up path is not a
> mistake it might make; it is a sentence it cannot form.

Three more guarantees work that way, each one a function in the codebase rather
than a line in a prompt. That is the whole project:
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
  default, and the key stays in local settings on this machine.
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

**Then try these in the app** — they exercise the hardest paths:

| Type this | What it proves |
|---|---|
| `check the current price of bitcoin` | compile → readable record → watched run → verified answer (instant — a verified template, no model turn) |
| `make a sequence of the bitcoin price and the weather in orlando` | two automations *and* the link between them, from one sentence |
| `connect Bitcoin Price Fetch and Bitcoin Morning Note` | connecting saved automations — deterministic, no model call |
| `summarize everything in my Downloads folder` | sandboxed file reading, PDFs included |

---

## How it works

A sentence becomes a **record** — a short, strict document listing what the job
does, which websites it may reach, and which files it may touch. From then on
the *record* decides what runs, not the model. The model's only job was writing
it down, and you can read what it wrote before anything happens.

That one design choice is what makes the rest possible: an automation can be
checked, edited, versioned, scheduled and chained, because it's a document
rather than a prompt.

<details>
<summary><b>See a real record</b> — "fetch the current Bitcoin price from CoinGecko", straight out of <code>automations.json</code></summary>

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

</details>

That document *is* the security model. Four fields carry it:

- **`sources`** is the fence — the only websites this job may reach. Every
  request is checked against it in code before it leaves the app, and a
  lookalike host like `evil-coingecko.com` fails the check
  ([`fetchPage.ts:32`](src/runner/fetchPage.ts#L32)).
- **`files`** is empty here, so the file tools are **never handed to the model
  at all** ([`loop.ts:143`](src/runner/loop.ts#L143)). It can't misuse a tool it
  was never given.
- **`permissions`** is the plain-language list you approve, so changing what an
  automation may touch is always a visible edit.
- **`revision.contentHash`** changes whenever the automation does — which is how
  an edited automation has to re-earn its approval, and how a sequence pins the
  exact version it was tested against.

A person can read all of that before anything runs. So can a reviewer.

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

**1 · It can only name things that exist.** Before the model is asked anything,
the app takes an inventory of your real folders, files and automations, and
builds those names *into the grammar the model writes with*. Picking a filename
becomes multiple-choice over things that are actually there.

<details>
<summary>What that looks like in the schema</summary>

```json
"reads": {
  "type": "array",
  "items": { "type": "string", "enum": ["~/Downloads", "~/Downloads/invoice-jan.pdf"] }
}
```

Two real paths and no way to write a third. With nothing indexed, the same field
compiles to `"items": { "not": {} }` — a type no string satisfies — so the model
cannot name a file because there is no file to name.

</details>

**2 · It gets corrected, not trusted.** The record has to survive a validator
that re-checks meaning, and it gets up to three tries with the exact problems
handed back to it. Slips the app can safely fix itself — a full web address
where a site name belongs, a hand-off naming a value the next job doesn't take —
are repaired outright rather than bounced. If the meaning is genuinely unclear,
it asks you instead of guessing.

**3 · The fence is code, not instructions.** A prompt saying "only visit these
sites" is a suggestion. Here, every outbound request is compared against the
record's own list *before it leaves the app* — and file work happens on a copy,
so you approve a diff before anything real changes.

**4 · Numbers have to come from somewhere.** Every figure in an answer is looked
for in the data actually fetched, allowing honest rounding and sums. A number
that appears nowhere stops the run instead of reaching you. This is the
difference between an automation that reports and one that guesses.

**Full architecture, with sequence diagrams and a file map:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).**

---

## Chaining: automations that keep growing

A sequence is a flat list of steps — the same shape GitHub Actions uses. Each
step names what it runs `after`, whether it `needs` **all** or **any** of those,
and the outcome that lets it fire (`ran` · `held` · `broke` · `failed`), plus
optional `ifAnswerContains` / `ifAnswerLacks` predicates. Data crosses on a
**baton**: outputs map to the next step's inputs *by name*, and a name that
matches nothing is dropped rather than invented.

- **Chains run as long as you need.** Up to 25 steps on either shape, with the
  cap acting purely as a runaway guard — every chain is separately bounded by
  its own `timeoutMinutes`.
- **Sequences grow after the fact.** `appendToSequence()` extends one you
  already have: it attaches at the tail, joins several branch ends with
  `needs: "any"`, skips members already present rather than building a cycle,
  and **keeps the chain's id**, so its version history and pinned member
  revisions carry straight over instead of leaving a near-duplicate behind.
- **Watch as often as a minute.** "Check every 2 minutes" means two minutes.

**Loops are not back-edges.** "Keep checking until an email arrives, then stop"
is a re-arm on a schedule, not a cycle in the graph — the same conclusion
Temporal reaches with Continue-As-New and Airflow enforces by making DAGs
acyclic. So cycle-checking (Kahn's toposort, which refuses a loop *by name*)
stays strict, and repetition is expressed as a watcher. That is exactly what
the compiler does with *"check my gmail every 2 minutes, summarize anything
new"*: one watcher, not a ring of steps.

**Two ways to build one.** Connecting automations you already have is
deterministic — no model call, no re-drafting, instant:

```
connect Bitcoin Price Fetch and Bitcoin Morning Note
```

Or describe both jobs and the link in a single sentence, and the compiler
builds all three. Each of these produces two automations *and* the hand-off
between them:

```
make a sequence of the bitcoin price and the weather in orlando
watch solana and tell me if it drops below 75
connect the tesla price and the top tech news
```

That works because the validator **repairs what the model got right in the
wrong shape** rather than spending a pass to complain about it: a full URL
where a bare hostname belongs, a link missing the `map` or `onlyWhen` the
strict schema requires, a baton name the next job doesn't accept. A 4B model
is a compiler, not an oracle — meeting it halfway on formatting is what turns
one sentence into a working multi-step workflow.

---

## The engineering worth reading

For anyone who wants the parts under the surface.

**A blocked website doesn't end the run.** Plenty of sites turn away anything
that looks automated. So when one pushes back, the run climbs a ladder: load the
page in a real browser window kept invisible off-screen, then try a *curated
alternative that carries the same fact* — CoinGecko ↔ Coinbase ↔ Kraken, Nasdaq
↔ Yahoo, Google News ↔ HN/BBC. Only after all of that does it come back and tell
you every source it tried. The alternatives come from a hand-written table,
never from a search result, and every substitution is written into the run so
you know where the number came from.

**It reads pages the way you do, when it has to.** Some pages are empty until
their JavaScript runs. Those load in a real browser window — cloaked off-screen
so nothing flashes on your desktop — and if the answer exists only as pixels, a
local vision model reads it *twice* and the readings must match.

**Four ways to compile, cheapest first.** Common requests match verified
templates and finish in about a second with no model call at all. Only the
unusual ones pay for the full compiler, and there's a fallback where the model
thinks in plain sentences first and the structure is added afterwards.

**Your documents, answered with citations.** Scans get OCR'd, everything is
indexed locally, and answers come with the passage they came from — or an honest
"I couldn't find that in your documents."

**It is never silent.** Every failure is a written sentence in one of three
tones: stopped on purpose, needs you, or broke. A rate-limited API says *"asked
us to slow down"*. It never quietly reports a price of $0.

---

## Which brain, and why it matters

By default the AI runs on your computer, and that's the whole product. Cloud is
there for the rare job that genuinely needs a bigger model — and it's a switch
you flip, per model, knowingly.

One pipeline serves both. Every part of the app asks for "the model" and never
knows or cares which one answered, so the two paths can't drift apart.

### The default was chosen by measurement

Five local models, the **same eight jobs**, run through the app's own compiler
and scored by its own rules. On this machine — Intel Core Ultra 9 185H, 31 GB
RAM, RTX 3500 Ada:

| Model | Median draft | Structural checks | Valid JSON |
|---|---|---|---|
| qwen3.5:2b | 6.3s | 21/25 | 6/8 |
| **qwen3.5:4b** ← default | **12.6s** | **25/25** | **7/8** |
| qwen3.5:9b | 15.0s | 23/25 | 7/8 |
| gemma4:12b | 28.8s | 25/25 | 6/8 |
| ministral-3:14b | 58.1s | 25/25 | 8/8 |

4b is the only model that took every structural check in under 15 seconds. 2b
is twice as fast and drops four. **9b is slower *and* less accurate**, which is
the result that settled it — more local parameters did not buy drafting
quality. 14b has the best JSON validity and costs 4.6× the latency.

### What running locally actually buys you

- **Nothing to sign up for, and nothing metered.** This is the one that
  compounds. An automation checking something every two minutes is roughly 720
  model calls a day, forever — and agentic work is the expensive shape when
  billed per token, because each run is many turns. Here the 721st run costs
  electricity.
- **Some things simply cannot leave.** Screen reading and document indexing have
  no cloud path in the code at all — not a setting that defaults to off, but no
  route out of the machine. Your screenshots and the index of your documents
  stay put whatever else you turn on.
- **A stronger guarantee on the output.** Locally, the shape of the answer is
  enforced while the model writes, so malformed output isn't just unlikely, it's
  impossible. Cloud APIs can only promise "valid JSON of some kind", so there
  the validator does that work instead — and the run log says which one you got,
  when you got it.
- **It works when the internet doesn't.** The thinking part, anyway. A job that
  fetches a website still needs a website.

### What cloud is genuinely better at

- **Far more context** — a pile of documents too large for a small local model
  still has somewhere to go.
- **Room past the local time limit** on a heavy request. And if a local run does
  hit that limit, it tells you to split the job rather than hanging.
- **A fair comparison.** One cloud option runs the *same weights* as a local
  model, so you can tell the difference between "a bigger computer helped" and
  "a bigger model helped".

### Designed around what a small model is good at

A 4B model is a superb compiler and a poor calculator, so the architecture
gives it only the first job. Each of these is a deliberate boundary, and each
one is enforced in code:

- **Arithmetic belongs to the code, never the model.** Number-checking is a
  subset-sum, and document totals are extract-then-sum-in-TypeScript. The model
  identifies the figures; the machine adds them.
- **Vision reads twice and must agree.** Every screen read runs at two scales
  and the numbers have to match exactly — the app would rather tell you it
  couldn't confirm a digit than deliver a coin flip.
- **Structure is taught by example.** Splitting *"…and then email me"* into a
  second automation is carried by a worked example in the prompt, which lands
  where a rule alone does not.
- **Context is sized to the job.** Drafting runs at the window the prompt
  actually needs, keeping simple requests fast instead of paying for KV cache
  nothing will use.

**Every run stamps `ranOn`** — `local` or `featherless:<model>` — at record
creation. That is what makes "did this leave my computer?" a checkable fact
after the fact instead of a promise in a README.

---

### Turning cloud on is one decision, not a hidden setting

Paste a [Featherless.ai](https://featherless.ai) key and pick a cloud model —
that *is* the switch. There's no second toggle that can drift out of sync with
the picker, because choosing the brain and choosing where compute happens were
always the same choice. Each cloud model is listed with the reason it's there,
rather than as a dropdown of opaque IDs: a tool-calling default, a long-context
option, a vision option, and a same-weights mirror of a local model for
comparing the two paths honestly.

**Every run records where it ran.** Which is what turns "nothing leaves your
computer" from a promise into something you can check afterwards:

![The Activity tab: delivered results, an amber card holding jobs that paused before producing an answer, and a footer accounting for which runs used cloud compute](docs/img/activity.png)

That footer — *"19 runs borrowed cloud compute (Featherless) — the rest ran on
this computer"* — is the receipt. So is the amber card: jobs that **paused
before producing a result, changing and sending nothing**. They're shown rather
than tidied away, because a tool that only displays its successes is the thing
this was built against.

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
  connectors/   Gmail, any open window (one registry, bound per record)
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
- [jsdiff](https://github.com/kpdecker/jsdiff) — text diffs. Folder comparison
  is our own (size, then byte-by-byte) in
  [`diff.ts:64`](src/runner/diff.ts#L64), so a sandbox diff is exact.
- [defuddle](https://github.com/kepano/defuddle) — page → clean text, parsed
  with the webview's own `DOMParser`
- [unpdf](https://github.com/unjs/unpdf) · [exceljs](https://github.com/exceljs/exceljs)
  · [Tesseract](https://github.com/tesseract-ocr/tesseract) ·
  [pdfium](https://pdfium.googlesource.com/pdfium/) — documents
- [whisper.cpp](https://github.com/ggerganov/whisper.cpp) and
  [NVIDIA Parakeet TDT 0.6b v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
  (CC-BY-4.0) — local speech, both running on this machine
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

Built by **Alexander Walker**, **Mustapha Strachan**, and **Ryan Schlosbon**.

## License

[MIT](LICENSE) © 2026 Alexander Walker, Mustapha Strachan, and Ryan Schlosbon
