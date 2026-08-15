# Heavy tools & documents — what shipped, how to use it

**Branch:** `local-models` · built 2026-08-15

Two capabilities, both riding the rails that already exist (the per-record
tool loop, the copy-sandbox → diff → **Keep** gate, the closed fences):

1. **Heavy tools** — real file work through vetted, bundled binaries. The model
   fills validated blanks; the app builds the command line; nothing is ever a
   shell string. Runs in the sandbox; nothing touches real files until Keep.
2. **Documents (OCR + RAG)** — turn dirty scans into searchable files, file
   them into a named **knowledge base**, and ask questions answered *from your
   documents* with citations.

## Turn it on

Settings → **Heavy tasks** → **Allow**. (Off by default; nothing runs a file
tool until you allow it.)

The binaries live in `%APPDATA%/com.privatepilot.app/tools/`:
- `7za.exe` (7-Zip, LGPL) — archives
- `tesseract/` (Tesseract 5.4.0 + eng data, Apache-2.0 / Leptonica BSD) — OCR

(These are dev-installed today; the installer will bundle them from
`resources/binaries/` like `whisper-cli.exe`.)

## What you can say

**File work** — everything happens in a copy; you press Keep to apply:
- "rename every IMG file in my Downloads to vacation-{n}"
- "zip up the invoices in my Documents into an archive"
- "unpack every zip in Downloads"

**Documents** — the flagship flow:
- "clean up the scanned receipts in my Downloads folder and file them into a
  **Receipts** knowledge base" → OCRs each scan into a **searchable PDF + text**,
  shows the diff, and on **Keep** indexes the text into *Receipts*.
- "ask my **Receipts** what I spent in total" / "which receipt has the highest
  tax?" → answered **only from your documents**, with `[1]` citations to the
  exact receipt. If the answer isn't in your documents, it says so.

## The safety model (why this isn't "a terminal")

- **No string channel.** No tool takes a command line. `run_tool` (Rust) spawns
  `exe + argv[]` directly, so `&&`, `;`, `|`, backticks are inert bytes.
- **Job object** on every child: kill-on-close, active-process + 4 GB caps,
  wall-clock timeout, output caps. The `.exe` must be a real executable under
  our own dirs (never `.bat`/`.cmd`), and every path argument must resolve
  inside the sandbox — Rust re-checks what TypeScript promised.
- **Fences.** A record's `tools` fence (a closed enum) is the only heavy tools
  it may run; its `files` fence is the only folders; its `knowledge` fence is
  the only KBs. Watchers may **never** run a heavy tool.
- **Keep gate.** Every output stages into a sandbox copy → diff card → Keep;
  Keep is undoable via `.pilot-versions`.
- **Grounded answers.** RAG answers cite their sources; an answer with no valid
  citation becomes "I couldn't find that in your documents." Numbers are still
  checked against the retrieved text by the existing verification stage.

## How the RAG works (local, no cloud)

- **Embeddings:** Ollama `/api/embed` with `nomic-embed-text` (already
  installed), 768-dim, with the required `search_document:` / `search_query:`
  task prefixes and `num_ctx: 8192` (the two classic local-RAG bugs), L2-
  normalized.
- **Store:** per KB under `%APPDATA%/com.privatepilot.app/kb/<slug>/` — a
  `kb.json` manifest + `vectors.json` (base64 Float32 vectors). Dedup on the
  content SHA-256. Plain-TS cosine retrieval (top-6 dense ∪ keyword). Honest
  ceiling: migrate to sqlite-vec past ~30k chunks.
- **Answer:** the retrieved passages become the runner's corpus; the model
  answers grounded, cites `[n]`, or refuses.

## Verified end-to-end (real documents)

Three real scanned SROIE receipts (150-DPI ScanSnap scans — genuinely dirty):
- OCR recovered the text ("tan woon yann / BOOK TAK … / CASH BILL").
- "clean … into a Groceries KB" → 9 staged outputs → Keep applied + "Indexed 3
  documents (3 passages) into Groceries".
- "what was each total?" → "Yongfatt RM 80.91 [1], Indah Gift RM 65.90 [3],
  Book Tak RM 9.60 [2]" — cited.
- "capital of France?" → "I couldn't find that in your documents."

## Built since v1

- **Scanned PDF input** — `ocr_pdf` now takes PDFs too. A PDF that already has
  a text layer (checked with unpdf) is indexed as-is, no OCR. An image-only
  scan goes through pdfium (`ocr_raster.rs::rasterize_pdf`, the Chromium PDF
  engine, bound once per process from `tools/pdfium.dll`) at 300 DPI to page
  PNGs, then Tesseract reads the page list into ONE multi-page searchable PDF
  + text. Verified with a real image-only receipt PDF.
- **Attachments from email** — `gmail_save_attachment{id, name?}` pulls an
  attachment (MIME-walked, 25 MB cap) from a listed message into the run's
  sandbox write folder, so "clean the invoice from this email" flows straight
  into `ocr_pdf` → Keep → the knowledge base. Reads only; nothing is sent or
  marked. Verified against a real inbox message (790 KB PDF, valid header).
- **Code-summed totals** — a total/sum question makes the model EXTRACT each
  document's final amount (strict-JSON, its strength) while the SUM is
  computed in `rag/totals.ts` (its weakness — a 4B model added 3 receipts to
  190.51 instead of 156.41 in testing). The verified line lands in the corpus,
  so number-verification accepts the derived figure. Both `answerFromKb` and
  the runner's `rag_ask` use it; verified end-to-end: "RM 156.41" with the
  right per-receipt breakdown.

## What's next (documented, not built)

- **`convert_media`** (ffmpeg) — held until the AppContainer OS sandbox lands
  (it's the one injectable, network-capable binary); see
  `terminal-access-plan.md`.
- **Receipt fields** (`.fields.json` with subtotal/tax/total) for richer
  code-verified spend queries (per-month, per-store).
- **A Documents/Knowledge surface** — today KBs are created by filing into a
  name and listed in the drafter; a browse/manage UI is a follow-up.
