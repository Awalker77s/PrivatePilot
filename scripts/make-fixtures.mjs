// Seeds the demo fixtures: three real invoice PDFs in ~/Downloads and a real
// tracking sheet in ~/Documents. Runs are never fabricated — these are the
// actual files the demo reads and writes.
import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import ExcelJS from "exceljs";

function textPdf(lines) {
  const content =
    "BT /F1 12 Tf 72 720 Td " +
    lines.map((l, i) => `(${l.replace(/[()\\]/g, "")}) Tj 0 -18 Td `).join("") +
    "ET";
  const objs = [];
  objs.push("<< /Type /Catalog /Pages 2 0 R >>");
  objs.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  objs.push(
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>"
  );
  objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  objs.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objs.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xrefAt = pdf.length;
  pdf += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return pdf;
}

const invoices = [
  {
    file: "invoice-acme-supply-aug.pdf",
    lines: [
      "INVOICE  #2026-0811",
      "Vendor: Acme Supply",
      "Date: August 11, 2026",
      "Item: Cable spools x12 ... $310.00",
      "Item: Mounting kits x4 ... $105.00",
      "Total: $415.00",
    ],
  },
  {
    file: "invoice-nordwind-labs-aug.pdf",
    lines: [
      "INVOICE  #NW-4471",
      "Vendor: Nordwind Labs",
      "Date: August 12, 2026",
      "Item: Sensor array ... $612.50",
      "Total: $612.50",
    ],
  },
  {
    file: "invoice-brightpath-media-aug.pdf",
    lines: [
      "INVOICE  #BP-208",
      "Vendor: Brightpath Media",
      "Date: August 13, 2026",
      "Item: Campaign design ... $212.50",
      "Total: $212.50",
    ],
  },
];

const dl = join(homedir(), "Downloads");
for (const inv of invoices) {
  writeFileSync(join(dl, inv.file), textPdf(inv.lines), "latin1");
  console.log("wrote", inv.file);
}

const wb = new ExcelJS.Workbook();
const ws = wb.addWorksheet("Invoices");
ws.addRow(["Date", "Vendor", "Amount"]);
ws.addRow(["2026-07-28", "Acme Supply", 258]);
ws.addRow(["2026-08-02", "Nordwind Labs", 990.25]);
await wb.xlsx.writeFile(join(homedir(), "Documents", "invoices-2026.xlsx"));
console.log("wrote invoices-2026.xlsx");
