// Shared HTML helpers for the local UI. No scripts: the CSP blocks them.
export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const CSS = `
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#57534e;--line:#e7e5e4;--card:#fff;--accent:#1d4ed8;--warn:#b45309;--bad:#b91c1c;--good:#15803d}
@media (prefers-color-scheme:dark){:root{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--accent:#93c5fd;--warn:#fbbf24;--bad:#fca5a5;--good:#86efac}}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;background:var(--bg);color:var(--fg)}
header{display:flex;gap:16px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line)}header b{margin-right:auto}
a{color:var(--accent)}main{max-width:980px;margin:0 auto;padding:20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;margin:0 0 12px}
.row{display:flex;gap:12px;flex-wrap:wrap;align-items:baseline}.muted{color:var(--muted)}.tag{font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 8px}
.warn{color:var(--warn)}.bad{color:var(--bad)}.good{color:var(--good)}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
textarea,input[type=text]{width:100%;font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{font:inherit;padding:6px 12px;border-radius:6px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);color:var(--bg);border-color:var(--accent)}
.steps{list-style:none;padding:0}.steps li{display:flex;gap:12px;align-items:flex-start}.dot{flex:none;width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;border:1px solid var(--line);font-size:13px}.done .dot{background:var(--good);color:var(--bg);border-color:var(--good)}
label{display:block;margin:0 0 14px}label .hint{display:block;font-size:13px;color:var(--muted)}input[type=password],input[type=email],input[type=number],select{width:100%;font:inherit;padding:6px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
.card form:has(textarea){display:block!important}.big{font-size:17px;padding:10px 18px}.resume{border:1px solid var(--line);border-radius:6px;padding:16px;max-height:520px;overflow:auto;background:#fff;color:#111}
pre{white-space:pre-wrap}
@media (max-width:640px){main{padding:12px}header{flex-wrap:wrap}}`;

export function page(title: string, body: string, head = ""): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${head}<style>${CSS}</style></head>
<body><header><b>CAS</b><a href="/start">Get started</a><a href="/">Queue</a><a href="/pipeline">Pipeline</a><a href="/report">Weekly report</a></header><main>${body}</main></body></html>`;
}

