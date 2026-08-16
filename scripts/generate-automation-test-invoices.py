"""Generate fictional PDF invoices used by the automation playground."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_RIGHT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle


ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "test-data" / "automation-playground" / "Inbox"

INVOICES = [
    {
        "filename": "Invoice ACME 1042.pdf",
        "vendor": "Acme Office Supply",
        "number": "AC-1042",
        "date": "2026-08-02",
        "due": "2026-09-01",
        "status": "DUE",
        "po": "PO-8007",
        "items": [
            ("Ergonomic desk chair", "2", "$495.00", "$990.00"),
            ("Monitor arm", "2", "$89.00", "$178.00"),
        ],
        "subtotal": "$1,168.00",
        "tax": "$96.50",
        "shipping": "$20.00",
        "total": "$1,284.50",
        "category": "Office equipment",
    },
    {
        "filename": "invoice_brightline_aug.pdf",
        "vendor": "Brightline Software",
        "number": "BL-8820",
        "date": "2026-08-05",
        "due": "2026-08-28",
        "status": "DUE",
        "po": "PO-8012",
        "items": [
            ("Team plan - August 2026", "10 seats", "$29.00", "$290.00"),
            ("Priority support", "1", "$59.99", "$59.99"),
        ],
        "subtotal": "$349.99",
        "tax": "$0.00",
        "shipping": "$0.00",
        "total": "$349.99",
        "category": "Software subscription",
    },
    {
        "filename": "NORTHSTAR-7781.pdf",
        "vendor": "Northstar Consulting",
        "number": "NS-7781",
        "date": "2026-08-01",
        "due": "2026-08-10",
        "status": "PAID",
        "po": "PO-7944",
        "items": [
            ("Workflow review", "10 hours", "$175.00", "$1,750.00"),
            ("Implementation workshop", "1", "$1,000.00", "$1,000.00"),
        ],
        "subtotal": "$2,750.00",
        "tax": "$0.00",
        "shipping": "$0.00",
        "total": "$2,750.00",
        "category": "Professional services",
    },
]


def build_invoice(invoice: dict[str, object]) -> None:
    output = OUT / str(invoice["filename"])
    styles = getSampleStyleSheet()
    styles.add(
        ParagraphStyle(
            name="RightSmall",
            parent=styles["BodyText"],
            alignment=TA_RIGHT,
            fontSize=9,
            leading=13,
        )
    )
    doc = SimpleDocTemplate(
        str(output),
        pagesize=letter,
        leftMargin=0.65 * inch,
        rightMargin=0.65 * inch,
        topMargin=0.55 * inch,
        bottomMargin=0.55 * inch,
        title=f"Sample invoice {invoice['number']}",
        author="Private Pilot test fixture",
    )
    story = [
        Table(
            [[
                Paragraph(f"<b>{invoice['vendor']}</b><br/><font size=9>Fictional vendor for testing</font>", styles["Title"]),
                Paragraph("<b>SAMPLE INVOICE</b><br/>NOT A REAL BILL", styles["RightSmall"]),
            ]],
            colWidths=[4.8 * inch, 2.0 * inch],
        ),
        Spacer(1, 0.28 * inch),
    ]
    details = [
        ["Invoice number", invoice["number"], "Invoice date", invoice["date"]],
        ["Purchase order", invoice["po"], "Due date", invoice["due"]],
        ["Category", invoice["category"], "Status", invoice["status"]],
        ["Bill to", "Example Operations LLC", "Currency", "USD"],
    ]
    detail_table = Table(details, colWidths=[1.05 * inch, 2.35 * inch, 0.95 * inch, 2.45 * inch])
    detail_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), colors.HexColor("#EEF2F6")),
        ("BACKGROUND", (2, 0), (2, -1), colors.HexColor("#EEF2F6")),
        ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
        ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#C9D2DC")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 7),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ]))
    story.extend([detail_table, Spacer(1, 0.32 * inch)])

    item_rows = [["Description", "Quantity", "Unit price", "Amount"], *invoice["items"]]
    item_table = Table(item_rows, colWidths=[3.65 * inch, 1.05 * inch, 1.05 * inch, 1.05 * inch])
    item_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#14324A")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("ALIGN", (1, 1), (-1, -1), "RIGHT"),
        ("FONTSIZE", (0, 0), (-1, -1), 9),
        ("GRID", (0, 0), (-1, -1), 0.5, colors.HexColor("#C9D2DC")),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#F8FAFC")]),
        ("TOPPADDING", (0, 0), (-1, -1), 8),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 8),
    ]))
    story.extend([item_table, Spacer(1, 0.24 * inch)])

    totals = [
        ["Subtotal", invoice["subtotal"]],
        ["Tax", invoice["tax"]],
        ["Shipping", invoice["shipping"]],
        ["TOTAL", invoice["total"]],
    ]
    totals_table = Table(totals, colWidths=[1.25 * inch, 1.15 * inch], hAlign="RIGHT")
    totals_table.setStyle(TableStyle([
        ("ALIGN", (0, 0), (-1, -1), "RIGHT"),
        ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
        ("LINEABOVE", (0, -1), (-1, -1), 1.2, colors.HexColor("#14324A")),
        ("FONTSIZE", (0, 0), (-1, -1), 10),
        ("TOPPADDING", (0, 0), (-1, -1), 6),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    story.extend([
        totals_table,
        Spacer(1, 0.42 * inch),
        Paragraph(
            "This is synthetic test data created for Private Pilot automation testing. "
            "Do not pay, email, or treat it as a real business record.",
            styles["Italic"],
        ),
    ])
    doc.build(story)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for record in INVOICES:
        build_invoice(record)
    print(f"Generated {len(INVOICES)} fictional invoices in {OUT}")
