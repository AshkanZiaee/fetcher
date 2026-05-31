"use client";

import { useEffect, useMemo, useState } from "react";
import type { Analysis, AppStatus, Draft, JobState, RawJob, StoredJob } from "@/lib/types";

interface ListJob extends RawJob {
  postedAtKnown: boolean;
  state: JobState | null;
}
interface ListResponse {
  runId: string;
  windowHours: number;
  totalFound: number;
  cappedAt: number | null;
  timings?: { listMs: number };
  jobs: ListJob[];
  errors: { source: string; error: string }[];
}

type UiStatus = "pending" | "analyzing" | "done" | "error";
interface ClientJob extends ListJob {
  analysis: Analysis | null;
  ui: UiStatus;
  status: AppStatus;
  notes: string;
  appliedAt: string | null;
  draft: Draft | null;
}

const SOURCE_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  stepstone: "StepStone",
  xing: "Xing",
  career: "Career page",
};
const STATUSES: AppStatus[] = ["new", "saved", "applied", "interviewing", "offer", "rejected", "dismissed"];
const STATUS_LABEL: Record<AppStatus, string> = {
  new: "— set status —",
  saved: "★ Saved",
  applied: "✓ Applied",
  interviewing: "💬 Interviewing",
  offer: "🎉 Offer",
  rejected: "✕ Rejected",
  dismissed: "🗑 Dismissed",
};

/** Human "posted X ago" from an ISO date. */
function timeAgo(iso: string | null): { label: string; title: string; fresh: boolean } | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (isNaN(t)) return null;
  const title = new Date(t).toLocaleString();
  const mins = (Date.now() - t) / 60000;
  const fresh = mins < 24 * 60;
  if (mins < 60) return { label: "just now", title, fresh };
  const h = mins / 60;
  if (h < 24) return { label: `${Math.round(h)}h ago`, title, fresh };
  const d = h / 24;
  if (d < 14) return { label: `${Math.round(d)}d ago`, title, fresh };
  return { label: new Date(t).toLocaleDateString(), title, fresh };
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

export default function Home() {
  const [view, setView] = useState<"today" | "pipeline">("today");
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [meta, setMeta] = useState<ListResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "listing" | "analyzing" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"toapply" | "all" | "saved">("toapply");
  const [sourceFilter, setSourceFilter] = useState<string>("all");
  const [query, setQuery] = useState("");

  function patch(id: string, p: Partial<ClientJob>) {
    setJobs((prev) => prev.map((j) => (j.id === id ? { ...j, ...p } : j)));
  }

  async function run() {
    setErr(null);
    setJobs([]);
    setMeta(null);
    setPhase("listing");
    try {
      const res = await fetch("/api/jobs/list");
      const data: ListResponse = await res.json();
      if (!res.ok) throw new Error((data as any).error ?? "list failed");
      setMeta(data);
      const initial: ClientJob[] = data.jobs.map((j) => ({
        ...j,
        analysis: null,
        ui: "pending",
        status: j.state?.status ?? "new",
        notes: j.state?.notes ?? "",
        appliedAt: j.state?.appliedAt ?? null,
        draft: null,
      }));
      setJobs(initial);
      setPhase("analyzing");
      await pool(initial, 3, async (job) => {
        patch(job.id, { ui: "analyzing" });
        try {
          const r = await fetch("/api/jobs/analyze", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ job }),
          });
          const jr = await r.json();
          if (!r.ok || jr.error) throw new Error(jr.error ?? "analyze failed");
          patch(job.id, { analysis: jr.analysis, ui: "done" });
        } catch {
          patch(job.id, { ui: "error" });
        }
      });
      setPhase("done");
    } catch (e: any) {
      setErr(e.message ?? String(e));
      setPhase("idle");
    }
  }

  const visible = useMemo(() => {
    let v = jobs.filter((j) => j.status !== "dismissed");
    if (filter === "toapply")
      v = v.filter((j) => !j.analysis || j.analysis.recommend !== "skip" || j.status === "saved");
    if (filter === "saved") v = v.filter((j) => j.status === "saved");
    if (sourceFilter !== "all") v = v.filter((j) => j.source === sourceFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      v = v.filter(
        (j) =>
          j.title.toLowerCase().includes(q) ||
          j.company.toLowerCase().includes(q) ||
          (j.analysis?.tags ?? []).some((t) => t.toLowerCase().includes(q))
      );
    }
    if (phase === "done") v = [...v].sort((a, b) => (b.analysis?.matchScore ?? -1) - (a.analysis?.matchScore ?? -1));
    return v;
  }, [jobs, filter, sourceFilter, query, phase]);

  const analyzed = jobs.filter((j) => j.ui === "done" || j.ui === "error").length;
  const applyCount = jobs.filter((j) => j.analysis?.recommend === "apply").length;
  const busy = phase === "listing" || phase === "analyzing";

  return (
    <div className="wrap">
      <header className="top">
        <div>
          <h1>
            job<span>now</span>
          </h1>
          <p className="sub">Your personal application cockpit · Hessen &amp; Rheinland-Pfalz</p>
        </div>
        <div className="tabs">
          <button className={view === "today" ? "tab on" : "tab"} onClick={() => setView("today")}>
            Today
          </button>
          <button className={view === "pipeline" ? "tab on" : "tab"} onClick={() => setView("pipeline")}>
            Pipeline
          </button>
        </div>
        {view === "today" && (
          <button className="refresh" onClick={run} disabled={busy}>
            {phase === "listing" ? (
              <>
                <span className="spinner">↻</span> Fetching…
              </>
            ) : phase === "analyzing" ? (
              <>
                <span className="spinner">↻</span> Scoring {analyzed}/{jobs.length}
              </>
            ) : (
              "↻ Check today's jobs"
            )}
          </button>
        )}
      </header>

      {err && <div className="errbox">⚠ {err}</div>}

      {view === "pipeline" ? (
        <Pipeline />
      ) : (
        <>
          {meta && (
            <>
              <div className="stats">
                <div>
                  <b>{meta.totalFound}</b> found · {meta.windowHours}h
                </div>
                <div>
                  <b>
                    {analyzed}/{jobs.length}
                  </b>{" "}
                  scored
                </div>
                <div>
                  <b>{applyCount}</b> worth applying
                </div>
              </div>

              {phase === "analyzing" && (
                <div className="progress">
                  <div className="bar" style={{ width: `${jobs.length ? (analyzed / jobs.length) * 100 : 0}%` }} />
                </div>
              )}

              <div className="filterbar">
                <div className="seg">
                  {(["toapply", "all", "saved"] as const).map((f) => (
                    <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
                      {f === "toapply" ? "To apply" : f === "all" ? "All" : "★ Saved"}
                    </button>
                  ))}
                </div>
                <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                  <option value="all">All sources</option>
                  <option value="linkedin">LinkedIn</option>
                  <option value="stepstone">StepStone</option>
                  <option value="career">Career pages</option>
                </select>
                <input
                  placeholder="Search title, company, tag…"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                <span className="count">{visible.length} shown</span>
              </div>

              {visible.map((job) => (
                <JobCard key={job.id} job={job} patch={patch} />
              ))}

              {meta.errors.length > 0 && (
                <details className="errors">
                  <summary>{meta.errors.length} source query/queries had issues</summary>
                  <ul>
                    {meta.errors.map((e, i) => (
                      <li key={i}>
                        <b>{e.source}</b>: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="runmeta">
                run <code>{meta.runId}</code>
                {meta.timings && ` · fetched in ${(meta.timings.listMs / 1000).toFixed(1)}s`} ·{" "}
                <a href="/api/logs?lines=400" target="_blank" rel="noreferrer">
                  view logs →
                </a>
              </p>
            </>
          )}
          {!meta && !busy && !err && (
            <p className="empty">Hit “Check today&apos;s jobs” to scan LinkedIn, StepStone &amp; career pages.</p>
          )}
        </>
      )}
    </div>
  );
}

function setStatus(id: string, status: AppStatus) {
  return fetch("/api/jobs/state", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, status }),
  }).then((r) => r.json());
}

function JobCard({ job, patch }: { job: ClientJob; patch: (id: string, p: Partial<ClientJob>) => void }) {
  const a = job.analysis;
  const [notesOpen, setNotesOpen] = useState(false);
  const [draftOpen, setDraftOpen] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const scoreClass = a ? a.recommend : job.ui === "error" ? "err" : "pending";

  async function changeStatus(status: AppStatus) {
    patch(job.id, { status });
    const r = await setStatus(job.id, status);
    if (r?.state) patch(job.id, { appliedAt: r.state.appliedAt });
  }

  async function saveNotes(notes: string) {
    patch(job.id, { notes });
    await fetch("/api/jobs/state", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: job.id, notes }),
    });
  }

  async function makeDraft(force = false) {
    setDraftOpen(true);
    if (job.draft && !force) return;
    setDraftLoading(true);
    try {
      const r = await fetch("/api/jobs/draft", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: job.id, job, force }),
      });
      const jr = await r.json();
      if (jr.draft) patch(job.id, { draft: jr.draft });
    } finally {
      setDraftLoading(false);
    }
  }

  return (
    <div className={`job ${!a ? "unscored" : ""} ${job.status !== "new" ? "tracked s-" + job.status : ""}`}>
      <div className={`score ${scoreClass}`}>
        {a ? a.matchScore : job.ui === "error" ? "!" : <span className="spinner">↻</span>}
      </div>
      <div>
        <h3>
          <a href={job.url} target="_blank" rel="noreferrer">
            {job.title}
          </a>
        </h3>
        <div className="company">
          <span className={`src src-${job.source}`}>{SOURCE_LABEL[job.source] ?? job.source}</span>
          {" · "}
          {job.company} · {job.location}
          {job.region && job.region !== job.location && ` · ${job.region}`}
          {(() => {
            const ago = timeAgo(job.postedAt);
            return ago ? (
              <span className={`posted ${ago.fresh ? "fresh" : ""}`} title={`Posted ${ago.title}`}>
                {" · 🕒 "}
                {ago.label}
              </span>
            ) : (
              " · ⚑ date unknown"
            );
          })()}
        </div>

        {a ? (
          <>
            <p className="reason">{a.matchReason}</p>
            <div className="tags">
              {a.tags.map((t, i) => (
                <span key={`t${i}`} className="tag chip">
                  {t}
                </span>
              ))}
              {a.salary && <span className="tag good">💶 {a.salary}</span>}
              <span className={`tag ${a.coverLetterNeeded === "no" ? "good" : a.coverLetterNeeded === "yes" ? "warn" : ""}`}>
                cover letter: {a.coverLetterNeeded}
              </span>
              {a.quickApply === "yes" && <span className="tag good">⚡ quick apply</span>}
              {a.redFlags.map((f, i) => (
                <span key={`r${i}`} className="tag warn">
                  ⚠ {f}
                </span>
              ))}
            </div>
            {a.keyRequirements.length > 0 && <p className="req">Needs: {a.keyRequirements.join(" · ")}</p>}
          </>
        ) : (
          <p className="reason muted">{job.ui === "error" ? "couldn’t score this one (see logs)" : "scoring…"}</p>
        )}

        <div className="actions">
          <button className="act primary" onClick={() => makeDraft()}>
            ✍ Draft application
          </button>
          <button className={`act ${job.status === "saved" ? "active" : ""}`} onClick={() => changeStatus("saved")}>
            ★ Save
          </button>
          <button className={`act ${job.status === "applied" ? "active" : ""}`} onClick={() => changeStatus("applied")}>
            ✓ Applied
          </button>
          <button className="act" onClick={() => setNotesOpen((o) => !o)}>
            📝 Notes{job.notes ? " •" : ""}
          </button>
          <button className="act ghost" onClick={() => changeStatus("dismissed")}>
            ✕ Dismiss
          </button>
          {job.appliedAt && <span className="applied-on">applied {job.appliedAt.slice(0, 10)}</span>}
        </div>

        {notesOpen && (
          <textarea
            className="notes"
            placeholder="Notes — recruiter name, salary asked, follow-up…"
            defaultValue={job.notes}
            onBlur={(e) => saveNotes(e.target.value)}
          />
        )}

        {draftOpen && (
          <div className="draft">
            {draftLoading && !job.draft ? (
              <p className="muted">
                <span className="spinner">↻</span> Writing a tailored application…
              </p>
            ) : job.draft ? (
              <DraftView draft={job.draft} onRegen={() => makeDraft(true)} loading={draftLoading} />
            ) : (
              <p className="muted">No draft.</p>
            )}
          </div>
        )}
      </div>
      <div className="right">
        {a && <span className="pill">{a.recommend.toUpperCase()}</span>}
        <a className="apply-btn" href={job.url} target="_blank" rel="noreferrer">
          Open →
        </a>
        <select className="statussel" value={job.status} onChange={(e) => changeStatus(e.target.value as AppStatus)}>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

function DraftView({ draft, onRegen, loading }: { draft: Draft; onRegen: () => void; loading: boolean }) {
  const [copied, setCopied] = useState("");
  function copy(text: string, what: string) {
    navigator.clipboard.writeText(text);
    setCopied(what);
    setTimeout(() => setCopied(""), 1500);
  }
  return (
    <div>
      <div className="draft-head">
        <span className="tag chip">{draft.language}</span>
        <button className="act" onClick={() => copy(draft.coverLetter, "letter")}>
          {copied === "letter" ? "Copied!" : "Copy letter"}
        </button>
        <button className="act" onClick={() => copy(draft.shortMessage, "msg")}>
          {copied === "msg" ? "Copied!" : "Copy quick-apply msg"}
        </button>
        <button className="act ghost" onClick={onRegen} disabled={loading}>
          {loading ? "…" : "↻ Regenerate"}
        </button>
      </div>
      <pre className="letter">{draft.coverLetter}</pre>
      <div className="why">
        <b>Why I fit:</b>
        <ul>
          {draft.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      </div>
      <div className="shortmsg">
        <b>Quick-apply message:</b>
        <p>{draft.shortMessage}</p>
      </div>
    </div>
  );
}

function Pipeline() {
  const [data, setData] = useState<{ jobs: StoredJob[]; counts: Record<string, number>; total: number } | null>(null);
  useEffect(() => {
    fetch("/api/pipeline")
      .then((r) => r.json())
      .then(setData)
      .catch(() => setData({ jobs: [], counts: {}, total: 0 }));
  }, []);

  if (!data) return <p className="empty">Loading pipeline…</p>;
  if (data.jobs.length === 0)
    return (
      <p className="empty">
        Nothing tracked yet. On the <b>Today</b> tab, hit ★ Save or ✓ Applied on jobs to build your pipeline.
      </p>
    );

  const groups: AppStatus[] = ["saved", "applied", "interviewing", "offer", "rejected"];
  return (
    <>
      <div className="stats">
        {groups.map((g) => (
          <div key={g}>
            <b>{data.counts[g] ?? 0}</b> {g}
          </div>
        ))}
      </div>
      {groups
        .filter((g) => data.jobs.some((j) => j.state.status === g))
        .map((g) => (
          <div key={g}>
            <h2 className="grouphdr">{STATUS_LABEL[g]}</h2>
            {data.jobs
              .filter((j) => j.state.status === g)
              .map((rec) => (
                <div className={`job tracked s-${g}`} key={rec.job.id}>
                  <div className={`score ${rec.analysis?.recommend ?? "pending"}`}>
                    {rec.analysis?.matchScore ?? "—"}
                  </div>
                  <div>
                    <h3>
                      <a href={rec.job.url} target="_blank" rel="noreferrer">
                        {rec.job.title}
                      </a>
                    </h3>
                    <div className="company">
                      <span className={`src src-${rec.job.source}`}>
                        {SOURCE_LABEL[rec.job.source] ?? rec.job.source}
                      </span>
                      {" · "}
                      {rec.job.company} · {rec.job.location}
                      {(() => {
                        const ago = timeAgo(rec.job.postedAt);
                        return ago ? <span className="posted" title={`Posted ${ago.title}`}>{" · 🕒 "}{ago.label}</span> : null;
                      })()}
                      {rec.state.appliedAt && ` · applied ${rec.state.appliedAt.slice(0, 10)}`}
                    </div>
                    {rec.state.notes && <p className="req">📝 {rec.state.notes}</p>}
                  </div>
                  <div className="right">
                    <a className="apply-btn" href={rec.job.url} target="_blank" rel="noreferrer">
                      Open →
                    </a>
                  </div>
                </div>
              ))}
          </div>
        ))}
    </>
  );
}
