import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Minimal Markdown -> HTML for the resume format we render (headings, bullets, paragraphs). */
export function resumeHtml(md: string): string {
  const out: string[] = [];
  let inList = false;
  for (const line of md.split("\n")) {
    const close = () => {
      if (inList) out.push("</ul>");
      inList = false;
    };
    if (/^# /.test(line)) {
      close();
      out.push(`<h1>${esc(line.slice(2))}</h1>`);
    } else if (/^## /.test(line)) {
      close();
      out.push(`<h2>${esc(line.slice(3))}</h2>`);
    } else if (/^### /.test(line)) {
      close();
      out.push(`<h3>${esc(line.slice(4))}</h3>`);
    } else if (/^- /.test(line)) {
      if (!inList) out.push("<ul>");
      inList = true;
      out.push(`<li>${esc(line.slice(2))}</li>`);
    } else if (line.trim()) {
      close();
      out.push(`<p>${esc(line)}</p>`);
    } else close();
  }
  if (inList) out.push("</ul>");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    @page { size: Letter; margin: 0.55in 0.6in; }
    body { font-family: "Helvetica Neue", Arial, sans-serif; font-size: 10pt; line-height: 1.35; color: #111; }
    h1 { font-size: 18pt; margin: 0 0 2pt; }
    h1 + p { margin: 0 0 8pt; color: #333; font-size: 9pt; }
    h2 { font-size: 10.5pt; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #999; margin: 10pt 0 4pt; padding-bottom: 1pt; }
    h3 { font-size: 10pt; margin: 6pt 0 2pt; }
    ul { margin: 0 0 4pt 14pt; padding: 0; }
    li { margin: 0 0 1.5pt; }
    p { margin: 0 0 4pt; }
  </style></head><body>${out.join("\n")}</body></html>`;
}

export async function renderPdf(md: string, outPath: string): Promise<string> {
  mkdirSync(path.dirname(outPath), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(resumeHtml(md), { waitUntil: "load" });
    await page.pdf({ path: outPath, format: "Letter", printBackground: false });
    return outPath;
  } finally {
    await browser.close();
  }
}
