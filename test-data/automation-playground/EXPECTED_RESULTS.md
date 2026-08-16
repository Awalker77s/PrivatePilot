# Expected results

All values below are fictional and exist only for automation testing.

## Invoice facts

| Invoice | Vendor | Invoice number | Date | Due date | Status | Total |
| --- | --- | --- | --- | --- | --- | ---: |
| Invoice ACME 1042.pdf | Acme Office Supply | AC-1042 | 2026-08-02 | 2026-09-01 | Due | $1,284.50 |
| invoice_brightline_aug.pdf | Brightline Software | BL-8820 | 2026-08-05 | 2026-08-28 | Due | $349.99 |
| NORTHSTAR-7781.pdf | Northstar Consulting | NS-7781 | 2026-08-01 | 2026-08-10 | Paid | $2,750.00 |
| invoice-email-copy.txt | Harbor Print Studio | HP-3105 | 2026-08-12 | 2026-09-11 | Due; missing PO | $517.25 |

- Total of all four invoices: **$4,901.74**
- Outstanding total: **$2,151.74**
- Paid total: **$2,750.00**
- Outstanding invoices: AC-1042, BL-8820, and HP-3105
- Highest invoice: NS-7781 at $2,750.00
- Missing purchase order: HP-3105

## Other expected summaries

- Project Phoenix launch target: September 18, 2026.
- Project Phoenix blocker: final legal approval for the privacy notice.
- Feedback themes: export clarity, watcher status visibility, and dark-mode contrast.
- August expense CSV total: $856.67.
- The loosely named report recommends keeping onboarding under three minutes.

## Suggested normalized invoice filenames

- `2026-08-01_Northstar-Consulting_NS-7781_PAID.pdf`
- `2026-08-02_Acme-Office-Supply_AC-1042_DUE.pdf`
- `2026-08-05_Brightline-Software_BL-8820_DUE.pdf`
- `2026-08-12_Harbor-Print-Studio_HP-3105_DUE.txt`
