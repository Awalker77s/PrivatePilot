# Submission kit

Everything here is meant to be **copied into the Devpost form**. Two facts
shape all of it:

- Judges average roughly **four minutes per project**. The Devpost page may be
  the only thing they read — the repo is one click away and often never
  opened. So the page has to carry the architecture, not just point at it.
- **Devpost's story field renders Markdown, not Mermaid.** The diagrams in
  [ARCHITECTURE.md](ARCHITECTURE.md) show up as raw code there, so a plain
  fallback diagram is included below.

---

## 1 · Technical writeup (paste into the Devpost form)

> 372 words — inside the 200–400 requirement. Every specific in it is
> checkable in the repo in under a minute, which is the difference between a
> claim and a boast.

**Problem.** Desktop automation makes you choose: wire a node graph on a
server you maintain, or hand your files and your inbox to somebody else's
cloud. Private Pilot is a Windows app where a plain-English sentence compiles
into a strict-JSON automation record you can read, and runs on your machine.

**Stack.** Tauri v2 (Rust shell, fifteen narrow mechanism-only commands),
React + TypeScript, ~26k lines across 100 files. Ollama for local inference
(qwen3.5:4b default), Featherless.ai as opt-in cloud compute, zod for schemas,
whisper.cpp for speech, Tesseract + pdfium for OCR, nomic-embed-text for local
RAG.

**Decisions and tradeoffs.** A small local model is a compiler, not an oracle.
Drafting runs under Ollama's `format` field — a JSON schema compiled to a
llama.cpp grammar — at temperature 0, and the schema's enums are a closed
catalog of files and automations that actually exist, so a hallucinated path
is literally unsampleable rather than merely discouraged. Grammar buys shape,
not sense, so a validator loop zod-checks the draft and re-prompts with the
exact violations for at most three passes, then raises a question card instead
of failing. That argument with the model is rendered in the UI.

Featherless.ai exposes `response_format: json_object` but not `json_schema`.
So the provider declares `supportsSchemaFormat: false` and the same validator
loop becomes the primary shape defense in the cloud — capabilities are flags
on the provider, not conditionals scattered at call sites. One compiler, two
brains, different guarantees, stated in code.

Invented numbers are the failure users cannot catch, so every figure in an
answer must appear in the text actually fetched — precision-aware matching
plus subset-sum for computed totals — or the run stops with "I couldn't
confirm that number." A throttled API once yielded a price of 0; zero is an
error state now, never a reading.

The model never drives a screen. It fills validated blanks and the app builds
the command; file work happens on a sandbox copy with a diff card, and nothing
touches real files until you press Keep. When a site blocks a fetch, the run
retries in a real cloaked browser, then a curated same-fact source, and says
which it used.

The cost is latency and a lower ceiling than a hosted agent. The trade is that
nothing leaves the computer unless you flip a labelled switch.

---

## 2 · Architecture diagram for Devpost (plain text — renders anywhere)

```
        plain English
              |
              v
   +----------------------+   the app lists REAL files, folders and
   |   closed catalog     |   automations and bakes them into the
   +----------------------+   schema as enums
              |
              v
   +----------------------+   JSON Schema -> llama.cpp grammar,
   | constrained drafting |   temperature 0.  Malformed JSON is
   +----------------------+   unrepresentable, not discouraged
              |
              v
   +----------------------+   zod re-checks MEANING; re-prompts with
   |  validator loop x3   |   the exact violations; escape hatch lets
   +----------------------+   the model plan in prose, then transcribe
              |
              v
   [  AUTOMATION RECORD  ]  <- strict JSON a person can read
              |
              v
   +----------------------+   tools bound per record: no files named,
   |   agentic tool loop  |   no file tools.  Fence checked in code
   +----------------------+   BEFORE any request leaves the app
              |
        +-----+------+-------------+
        v            v             v
   web reads    sandbox copy   local RAG / OCR
   (+ fallback   (diff, then    (answers cited
    ladder)       Keep)          from your files)
        \            |             /
         +-----------+------------+
                     v
        +--------------------------+   every number in the answer must
        |  grounded verification   |   appear in what was fetched, or
        +--------------------------+   the run stops
                     |
                     v
           answer + run receipt
        (records where it ran: local or cloud)

   Inference: Ollama (local, default)  |  Featherless.ai (cloud, opt-in)
   One compiler serves both; the cloud provider declares it cannot do
   json_schema, so the validator loop is the shape defense there.
```

---

## 3 · Devpost "Built With"

`tauri` · `rust` · `react` · `typescript` · `vite` · `ollama` · `featherless.ai`
· `zod` · `whisper.cpp` · `tesseract` · `pdfium` · `webview2` · `sqlite-free
json stores`

---

## 4 · Pre-submit checklist

The organisers state it plainly: *projects with non-working links, empty
repositories, or private video links will not be evaluated.* Every line below
is a zero if it's wrong, regardless of how good the code is.

- [ ] **Eligibility** — students only, ≤4 people, everyone claiming a prize is
      on the Devpost roster
- [ ] **Repo is public** — open the URL in a private window and confirm
- [ ] **Video is public** — open the link in a private window. Not "private",
      not "requires sign-in". Under 3:00 in the *exported* file
- [ ] **Video link pasted into the README** (replace the placeholder near the
      top) and into Devpost
- [ ] **Writeup pasted** — all three parts present: problem, stack, decisions
      and tradeoffs
- [ ] **README renders on github.com** — check the diagrams and screenshots
      actually appear on the site, not just locally
- [ ] `npm install && npm run verify` passes on a clean clone
- [ ] Submitted **before 6:00 PM CST Sunday** — not at 5:59

---

## 5 · If a judge only has four minutes

Point them at these three things, in this order:

1. **[ARCHITECTURE.md](ARCHITECTURE.md)** — the diagram plus "why the model
   can't invent a file"
2. **`src/pipeline/validate/index.ts`** — the loop that argues with the model,
   with the escape hatch and the lenient final pass
3. **`src/runner/verify.ts`** — the check that stops a run rather than report
   a number nobody can source

Those three files are the project's actual thesis: the model proposes, the
app disposes, and the person can read the difference.
