# Private Pilot Automation Playground

Everything in this folder is fictional test data. No person, company, account,
invoice, or payment is real.

Use `Inbox` as the source folder when Private Pilot asks which folder it may
read or change. File changes are staged in a copy first, so inspect the diff
before pressing Keep.

## What is included

- Three one-page PDF invoices with inconsistent filenames.
- A plain-text invoice that is missing a purchase order.
- Meeting notes, customer feedback, an expense CSV, and a loosely named report.
- Empty destination folders under `Sorted` and `Archive`.
- `EXPECTED_RESULTS.md`, which lets you check summaries and invoice totals.

## Quick prompts

Paste these into the desktop app. The first prompt can register the exact
existing path directly; quotes make the path boundary unambiguous.

- `Make an automation that summarizes the folder at "C:\Developer\GitHub\PrivatePilot\test-data\automation-playground".`
- `Summarize Invoice ACME 1042.pdf.`
- `Rename every PDF in Inbox to sample-invoice-{n}{ext}.`
- `Move every PDF from Inbox to Invoices.`

Summaries compile without the drafting-model wait. Rename and move execute in
the sandbox without a model call and still require a diff review before Keep.

## Reset

If an automation changes the originals, use Put it back in Private Pilot. You
can also restore this folder from Git because every source file is test data.

## Safety

Do not point a test automation at the repository root. Select this playground
folder, or one of its children, so the automation cannot touch application
source code.
