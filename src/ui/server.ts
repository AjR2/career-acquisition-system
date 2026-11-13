import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { PROJECT_ROOT } from "../config/env.js";
import type { DB } from "../db/index.js";
import { approve, defer, DecisionError, latestValidated, planFor, reject, release, requestRevision, resolveUncertain, updateStatus, withdrawApproval, type DecisionContext } from "../apply/decide.js";
import { resumeHtml } from "../apply/pdf.js";
import { assistedSubmit, AuthorizationError, authorize } from "../apply/submit.js";
import type { EligibilityResult } from "../eligibility/rules.js";
import type { Suitability } from "../suitability/score.js";
import type { ResumeDraft } from "../drafting/schemas.js";
import { isApprovedWording, loadApprovedWording } from "../evidence/wording.js";
import { log } from "../log.js";
import type { State } from "../pipeline/states.js";
import { esc, page } from "./html.js";
import { makeSetupPages, type SetupDeps } from "./setup.js";
import { politeFetcher } from "../discovery/http.js";

const money = (n: number | null | undefined) => (n == null ? "unknown" : `$${Math.round(n).toLocaleString("en-US")}`);

/**
 * Reads the approve form's question/answer pairs. Browsers submit line breaks as CRLF, so a question
 * label containing a line break would no longer match the plan (bug 2026-10-27, Vercel form).
 */
export function formAnswers(f: URLSearchParams): Record<string, string> {
  const answers: Record<string, string> = {};
  for (let i = 0; f.has(`q${i}`); i++) answers[f.get(`q${i}`)!.replace(/\r\n?/g, "\n")] = (f.get(`a${i}`) ?? "").replace(/\r\n?/g, "\n");
  return answers;
}

export interface UiDeps {
  db: DB;
  ctx: () => DecisionContext;
  /** Headless only in tests. */
  submitOptions?: Parameters<typeof assistedSubmit>[3];
  /** Getting-started pages: injectable for tests. */
  setup?: Partial<Pick<SetupDeps, "fetcher" | "llm" | "installSchedule" | "files">>;
}

export function startServer(deps: UiDeps, port: number, host = "127.0.0.1") {
  const token = randomBytes(24).toString("hex");
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const running = new Set<number>();
  const { db } = deps;

  const send = (res: ServerResponse, code: number, html: string) => {
    res.writeHead(code, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "same-origin", // "no-referrer" makes Chrome send Origin: null on form posts (incident 2026-10-22)
    });
    res.end(html);
  };
  const redirect = (res: ServerResponse, to: string) => {
    res.writeHead(303, { Location: to });
    res.end();
  };
  const form = (action: string, inner: string, label: string, cls = "") =>
    `<form method="post" action="${esc(action)}" style="display:inline-block;margin:4px 6px 4px 0"><input type="hidden" name="csrf" value="${token}">${inner}<button class="${cls}">${esc(label)}</button></form>`;
  const setup = makeSetupPages({ db, form, fetcher: deps.setup?.fetcher ?? politeFetcher({ timeoutMs: 20000, retries: 1 }), llm: deps.setup?.llm, installSchedule: deps.setup?.installSchedule, files: deps.setup?.files });

  function queue(): string {
    const rows = db
      .prepare(
        `SELECT id, company_name, title, state, suitability_score, comp_json, location_json, flags_json, attention_reason, ai_policy_text,
                (SELECT max(at) FROM events e WHERE e.posting_id = p.id AND e.kind = 'state_change') AS since
         FROM postings p WHERE state IN ('READY_FOR_REVIEW','NEEDS_ATTENTION','APPROVED','SUBMISSION_UNCERTAIN','DEFERRED','DRAFTING') AND closed_at IS NULL
         ORDER BY CASE state WHEN 'SUBMISSION_UNCERTAIN' THEN 0 WHEN 'APPROVED' THEN 1 WHEN 'READY_FOR_REVIEW' THEN 2 WHEN 'NEEDS_ATTENTION' THEN 3 ELSE 4 END, suitability_score DESC`,
      )
      .all() as Record<string, string | number | null>[];
    const card = (r: Record<string, string | number | null>) => {
      const comp = r.comp_json ? JSON.parse(String(r.comp_json)) : null;
      const loc = r.location_json ? JSON.parse(String(r.location_json)) : null;
      const flags = r.flags_json ? (JSON.parse(String(r.flags_json)) as { code: string }[]).map((f) => f.code) : [];
      const why = r.attention_reason ? esc(r.attention_reason) : r.ai_policy_text ? "Employer AI-use policy: your decision" : "";
      return `<div class="card"><div class="row"><a href="/p/${r.id}"><b>${esc(r.company_name)}</b>: ${esc(r.title)}</a><span class="tag">${esc(r.state)}</span>
        <span class="muted">score ${r.suitability_score == null ? "n/a" : Math.round(Number(r.suitability_score) * 100)}</span>
        <span class="muted">base ${comp?.status === "BASE_KNOWN" ? `up to ${money(comp.baseMax)}` : "unknown"}</span>
        <span class="muted">${esc(loc?.classification ?? "")}${loc?.officeDays ? `, ${loc.officeDays.days} office days/wk` : ""}</span></div>
        ${why ? `<div class="warn">${why}</div>` : ""}${flags.length ? `<div class="muted" style="font-size:13px">${flags.map(esc).join(" · ")}</div>` : ""}</div>`;
    };
    const st = setup.status();
    const banner = st.target && st.confirmedClaims >= 5 && st.key ? "" : `<div class="card warn">Setup is not finished. <a href="/start">Go to Get started</a>.</div>`;
    return page("CAS queue", `${banner}<h1>Queue</h1><p class="muted">${rows.length} item(s). Silence is never approval: nothing is sent until you act.</p>${rows.map(card).join("") || "<p>Nothing waiting.</p>"}`);
  }

  function detail(id: number, flash = ""): string {
    const p = db.prepare("SELECT * FROM postings WHERE id = ?").get(id) as Record<string, string | number | null> | undefined;
    if (!p) return page("Not found", "<p>Not found.</p>");
    const e = p.eligibility_json ? (JSON.parse(String(p.eligibility_json)) as EligibilityResult) : null;
    const s = p.suitability_json ? (JSON.parse(String(p.suitability_json)) as Suitability) : null;
    const m = latestValidated(db, id);
    const ctx = deps.ctx();
    const plan = planFor(db, id, ctx);
    const draft = m ? (JSON.parse(m.content_json) as ResumeDraft) : null;
    const cited = draft ? [...new Set([...draft.summary, ...[...draft.experience, ...(draft.projects ?? [])].flatMap((x) => x.bullets), draft.skills].flatMap((b) => b.claim_ids).concat([...draft.experience, ...(draft.projects ?? [])].flatMap((x) => x.heading_claim_ids)))] : [];
    const claimById = new Map(ctx.claims.map((c) => [c.id, c]));
    // Only lines the user has not approved before need reading; the rest reuse approved wording.
    const wording = loadApprovedWording(db, ctx.claims);
    const bullets = draft ? [...draft.experience, ...(draft.projects ?? [])].flatMap((e) => e.bullets) : [];
    const freshLines = draft ? [...draft.summary.map((b) => b.text), ...bullets.filter((b) => !isApprovedWording(b.text, b.claim_ids, wording)).map((b) => b.text)] : [];
    const reusedCount = bullets.length - (freshLines.length - (draft?.summary.length ?? 0));
    const reviewCard = draft
      ? `<div class="card"><h3>New wording to review (${freshLines.length})</h3><p class="muted">${reusedCount} bullet(s) reuse wording you already approved. Approving this resume approves its bullets for reuse.</p><ul>${freshLines.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`
      : "";
    const state = String(p.state) as State;

    const facts = `<table>
      <tr><th>Base salary</th><td>${e?.comp.status === "BASE_KNOWN" ? `${money(e.comp.baseMin)} to ${money(e.comp.baseMax)} (base)` : esc(e?.comp.reason ?? "unknown")}</td></tr>
      <tr><th>Location</th><td>${esc(e?.location.classification)} ${e?.location.remoteMode ? `(${esc(e.location.remoteMode)})` : ""}<br><span class="muted">${esc(p.location_raw)}</span></td></tr>
      <tr><th>Office days</th><td>${e?.location.officeDays ? `<span class="${e.location.officeDays.days >= 4 ? "warn" : ""}">${e.location.officeDays.days} per week</span>: <span class="muted">"${esc(e.location.officeDays.evidence)}"</span>` : "not stated"}</td></tr>
      <tr><th>Employment</th><td>${esc(e?.employment.type)} · lane ${esc(e?.lane)}</td></tr>
      <tr><th>Flags</th><td>${(e?.flags ?? []).map((f) => `<div><b>${esc(f.code)}</b> <span class="muted">${esc(f.detail.slice(0, 220))}</span></div>`).join("") || "none"}</td></tr>
    </table>`;

    const needs = plan.needsUser;
    const answersForm = needs.map((q, i) => `<label><b>${esc(q.label)}</b> <span class="muted">${esc(q.reason ?? "")}${q.options?.length ? ` · options: ${esc(q.options.join(" / "))}` : ""}</span>
        <input type="hidden" name="q${i}" value="${esc(q.label)}"><textarea name="a${i}" rows="2" required></textarea></label>`).join("");

    const actions: string[] = [];
    if (state === "READY_FOR_REVIEW") {
      actions.push(`<div class="card"><h3>Approve</h3><p class="muted">Approving lets CAS open the application in a browser, ${plan.known ? `fill ${plan.items.filter((x) => x.value || x.source === "resume_file").length} field(s) from approved data,` : "fill the basic fields it can find (this job board does not publish its questions),"} and upload this resume. You review the form, finish anything left, and click submit yourself.</p>
        ${form(`/p/${id}/approve`, answersForm, "Approve", "primary")}</div>`);
      actions.push(form(`/p/${id}/reject`, "", "Reject"), form(`/p/${id}/defer`, "", "Defer"));
      actions.push(`<div class="card">${form(`/p/${id}/revise`, `<textarea name="note" rows="2" placeholder="What should change?" required></textarea>`, "Request revision")}</div>`);
    }
    if (state === "NEEDS_ATTENTION") {
      actions.push(`<div class="card"><h3>Held for your decision</h3><p class="warn">${esc(p.attention_reason ?? "")}</p>${p.ai_policy_text ? `<pre>${esc(p.ai_policy_text)}</pre>` : ""}
        ${form(`/p/${id}/release`, `<textarea name="note" rows="2" placeholder="Why proceed (recorded)" required></textarea>`, "Proceed: queue for drafting")} ${form(`/p/${id}/reject`, "", "Skip this posting")}</div>`);
    }
    if (state === "DEFERRED") actions.push(form(`/p/${id}/reject`, "", "Reject"));
    if (state === "APPROVED") {
      actions.push(`<div class="card"><h3>Ready to apply</h3><p>CAS will open <b>${esc(p.company_name)}</b>'s form in a visible browser, fill approved fields, and upload the resume. It stops before submit, attestations, CAPTCHAs, and demographic questions.</p>
        ${running.has(id) ? `<p class="warn">Browser is open. Review the form and click submit there.</p>` : form(`/p/${id}/submit`, "", "Open application in browser", "primary")}</div>`);
      if (!running.has(id))
        actions.push(`<div class="card"><h3>Withdraw approval</h3><p class="muted">Rejects this posting without applying. Nothing is sent to the employer.</p>
        ${form(`/p/${id}/withdraw`, `<input type="text" name="note" placeholder="Reason (optional, recorded)">`, "Withdraw approval")}</div>`);
    }
    if (state === "SUBMISSION_UNCERTAIN") {
      actions.push(`<div class="card"><h3>Submission uncertain</h3><p>No confirmation page was detected. Check your email or the employer site.</p>
        ${form(`/p/${id}/resolve`, `<input type="hidden" name="outcome" value="submitted"><textarea name="evidence" rows="3" placeholder="Paste the confirmation email or page text" required></textarea>`, "It was submitted")}
        ${form(`/p/${id}/resolve`, `<input type="hidden" name="outcome" value="not_sent"><input type="hidden" name="evidence" value="user says not sent">`, "It was not sent")}</div>`);
      actions.push(`<div class="card"><h3>Withdraw approval</h3><p class="muted">Only if the application was <b>not</b> sent: rejects this posting instead of trying again. If it was sent, use "It was submitted" above.</p>
        ${form(`/p/${id}/withdraw`, `<label><input type="checkbox" name="confirm_not_sent" value="yes" required> I confirm this application was not sent</label> <input type="text" name="note" placeholder="Reason (optional, recorded)">`, "Withdraw approval")}</div>`);
    }

    const sub = db.prepare("SELECT status, filled_json, confirmation_json, evidence_path FROM submissions WHERE posting_id = ? ORDER BY id DESC LIMIT 1").get(id) as
      | { status: string; filled_json: string | null; confirmation_json: string | null; evidence_path: string | null }
      | undefined;
    if (sub) {
      const f = sub.filled_json ? (JSON.parse(sub.filled_json) as { filled: string[]; leftForUser: { label: string; reason: string }[]; resumeUploaded: boolean; pdfPath?: string }) : null;
      actions.push(`<div class="card"><h3>Submission: ${esc(sub.status)}</h3>
        ${f ? `<p class="${f.resumeUploaded ? "good" : "bad"}">Resume ${f.resumeUploaded ? "attached by CAS" : "NOT attached by CAS"}${f.pdfPath ? `: <code>${esc(f.pdfPath)}</code>` : ""}</p>
        <p class="muted">Filled ${f.filled.length} field(s). Left for you: ${f.leftForUser.map((l) => esc(l.label)).join("; ") || "none"}</p>` : ""}
        ${sub.confirmation_json ? `<p class="muted">Confirmation: ${esc(JSON.parse(sub.confirmation_json).text ?? "")}</p>` : ""}</div>`);
    }
    const events = db.prepare("SELECT at, kind, from_state, to_state, actor FROM events WHERE posting_id = ? ORDER BY id DESC LIMIT 15").all(id) as Record<string, string>[];
    const body = `${flash}<h1>${esc(p.company_name)}: ${esc(p.title)}</h1>
      <p class="row"><span class="tag">${esc(state)}</span>${/^https:\/\//.test(String(p.url)) ? `<a href="${esc(p.url)}" rel="noreferrer noopener" target="_blank">Posting</a>` : ""}<span class="muted">first seen ${esc(String(p.first_seen_at).slice(0, 10))}</span></p>
      ${actions.join("")}
      <div class="card"><h3>Facts</h3>${facts}</div>
      ${s ? `<div class="card"><h3>Suitability ${Math.round(s.score * 100)}/100</h3><pre>${esc(s.explanation)}</pre></div>` : ""}
      ${reviewCard}
      ${m ? `<div class="card"><h3>Resume (version ${m.version})</h3><div class="resume">${resumeHtml(m.rendered_md).replace(/^[\s\S]*<body>|<\/body>[\s\S]*$/g, "")}</div></div>` : ""}
      ${cited.length ? `<div class="card"><h3>Claims this resume relies on</h3><table>${cited.map((c) => `<tr><td><code>${esc(c)}</code></td><td>${esc(claimById.get(c)?.status)}</td><td>${esc(claimById.get(c)?.claim_text)}</td></tr>`).join("")}</table></div>` : ""}
      ${plan.known ? `<div class="card"><h3>Application form plan</h3><table>${plan.items.map((i) => `<tr><td>${i.required ? "*" : ""} ${esc(i.label)}</td><td><span class="tag">${esc(i.source)}</span></td><td class="muted">${esc(i.value ?? i.reason ?? "")}</td></tr>`).join("")}</table>
        ${plan.declarations.length ? `<p class="warn">Required declarations you complete in the browser: ${plan.declarations.map((d) => esc(d.label)).join("; ")}</p>` : ""}</div>` : `<div class="card"><p class="muted">This job board does not publish its questions. CAS fills basic fields it can find; you complete the rest in the browser.</p></div>`}
      <div class="card"><h3>History</h3><table>${events.map((ev) => `<tr><td class="muted">${esc((ev.at ?? "").slice(0, 16).replace("T", " "))}</td><td>${esc(ev.kind)}</td><td>${esc(ev.from_state ?? "")} → ${esc(ev.to_state ?? "")}</td><td class="muted">${esc(ev.actor)}</td></tr>`).join("")}</table></div>`;
    return page(`${p.company_name}: ${p.title}`, body);
  }

  function pipeline(): string {
    const rows = db
      .prepare(
        `SELECT p.id, p.company_name, p.title, p.state, s.finished_at, s.status AS sub_status FROM postings p LEFT JOIN submissions s ON s.posting_id = p.id
         WHERE p.state IN ('SUBMITTED','RECRUITER_RESPONSE','INTERVIEW_REQUESTED','INTERVIEWING','REJECTED','OFFER','WITHDRAWN','SUBMISSION_UNCERTAIN') ORDER BY s.finished_at DESC`,
      )
      .all() as Record<string, string>[];
    const opts = ["RECRUITER_RESPONSE", "INTERVIEW_REQUESTED", "INTERVIEWING", "REJECTED", "OFFER", "WITHDRAWN", "CLOSED"];
    const counts = db.prepare("SELECT state, count(*) AS n FROM postings GROUP BY state").all() as { state: string; n: number }[];
    return page(
      "CAS pipeline",
      `<h1>Pipeline</h1><p class="muted">${counts.map((c) => `${esc(c.state)} ${c.n}`).join(" · ")}</p>
       <table><tr><th>Company</th><th>Role</th><th>State</th><th>Submitted</th><th>Update</th></tr>${rows
         .map(
           (r) => `<tr><td>${esc(r.company_name)}</td><td><a href="/p/${r.id}">${esc(r.title)}</a></td><td>${esc(r.state)}</td><td class="muted">${esc((r.finished_at ?? "").slice(0, 10))}</td>
           <td>${r.state === "SUBMISSION_UNCERTAIN" ? `<a href="/p/${r.id}">resolve</a>` : form(`/p/${r.id}/status`, `<select name="to">${opts.map((o) => `<option>${o}</option>`).join("")}</select> <input type="text" name="note" placeholder="note" style="width:140px">`, "Set")}</td></tr>`,
         )
         .join("")}</table>`,
    );
  }

  function report(): string {
    const dir = path.join(PROJECT_ROOT, "data", "reports");
    const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).sort() : [];
    const latest = files[files.length - 1];
    return page("CAS weekly report", latest ? `<p class="muted">${esc(latest)}</p><pre>${esc(readFileSync(path.join(dir, latest), "utf8"))}</pre>` : "<p>No report yet. Run <code>npm run cas -- report</code>.</p>");
  }

  async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 200_000) throw new Error("form too large");
    }
    return new URLSearchParams(body);
  }

  const server = createServer(async (req, res) => {
    try {
      // DNS-rebinding and cross-site protection: only our own host, and same-origin form posts.
      if (!allowedHosts.has(req.headers.host ?? "")) return send(res, 421, "wrong host");
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      if (req.method === "GET") {
        if (url.pathname === "/") return send(res, 200, queue());
        if (url.pathname.startsWith("/start")) {
          const html = setup.get(url.pathname);
          if (html) return send(res, 200, html);
        }
        if (url.pathname === "/pipeline") return send(res, 200, pipeline());
        if (url.pathname === "/report") return send(res, 200, report());
        const m = url.pathname.match(/^\/p\/(\d+)$/);
        if (m) return send(res, 200, detail(Number(m[1])));
        return send(res, 404, page("Not found", "<p>Not found.</p>"));
      }
      if (req.method !== "POST") return send(res, 405, "method not allowed");
      const origin = req.headers.origin;
      if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ""))) return send(res, 403, "cross-origin request refused");
      const f = await readForm(req);
      if (f.get("csrf") !== token) return send(res, 403, "invalid form token; reload the page");
      if (url.pathname.startsWith("/start")) {
        const r = await setup.post(url.pathname, f);
        if (r) return "redirect" in r ? redirect(res, r.redirect) : send(res, r.code ?? 200, r.html);
      }
      const m = url.pathname.match(/^\/p\/(\d+)\/(approve|reject|defer|revise|release|submit|resolve|status|withdraw)$/);
      if (!m) return send(res, 404, "not found");
      const id = Number(m[1]);
      const action = m[2];
      try {
        if (action === "approve") {
          approve(db, id, deps.ctx(), formAnswers(f));
        } else if (action === "reject") reject(db, id, f.get("note") ?? undefined);
        else if (action === "defer") defer(db, id);
        else if (action === "revise") requestRevision(db, id, f.get("note") ?? "");
        else if (action === "release") release(db, id, f.get("note") ?? "");
        else if (action === "resolve") resolveUncertain(db, id, f.get("outcome") === "submitted" ? "submitted" : "not_sent", f.get("evidence") ?? "");
        else if (action === "withdraw") {
          if (running.has(id)) throw new DecisionError("the application browser is open; close it first");
          withdrawApproval(db, id, { confirmedNotSent: f.get("confirm_not_sent") === "yes", note: f.get("note") ?? undefined });
        } else if (action === "status") updateStatus(db, id, (f.get("to") ?? "") as State, f.get("note") ?? undefined);
        else if (action === "submit") {
          if (running.has(id)) return redirect(res, `/p/${id}`);
          // Check the gate here, synchronously, so a refusal throws into the catch below and is shown
          // on the page (incident 2026-11-13: refusals inside the background task were only logged).
          // assistedSubmit checks it again before anything is opened.
          authorize(db, id, deps.ctx());
          running.add(id);
          assistedSubmit(db, id, deps.ctx(), deps.submitOptions)
            .then((r) => log.info({ id, status: r.status }, "assisted submission finished"))
            .catch((e) => log.warn({ id, err: (e as Error).message }, "assisted submission refused"))
            .finally(() => running.delete(id));
        }
      } catch (e) {
        if (e instanceof DecisionError || e instanceof AuthorizationError) return send(res, 400, detail(id, `<div class="card bad">${esc(e.message)}</div>`));
        throw e;
      }
      return redirect(res, `/p/${id}`);
    } catch (e) {
      log.error({ err: (e as Error).message }, "ui error");
      return send(res, 500, page("Error", `<p class="bad">${esc((e as Error).message)}</p>`));
    }
  });
  server.listen(port, host);
  return { server, token };
}
