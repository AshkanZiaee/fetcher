"use client";

import { useEffect, useMemo, useState } from "react";
import {
  RefreshCw,
  Star,
  Check,
  X,
  StickyNote,
  PenLine,
  Clock,
  ExternalLink,
  Copy,
  Sparkles,
  Languages,
} from "lucide-react";
import type { Analysis, AppStatus, Draft, JobState, RawJob, StoredJob } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";

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
  /** True if this job had no saved state at fetch time → unseen until now. */
  isNew: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  linkedin: "LinkedIn",
  stepstone: "StepStone",
  xing: "Xing",
  indeed: "Indeed",
  career: "Career page",
};
const SOURCE_COLOR: Record<string, string> = {
  linkedin: "bg-[#0a66c2] text-white",
  stepstone: "bg-[#0b4d6b] text-cyan-100",
  xing: "bg-[#0d4f4a] text-emerald-100",
  indeed: "bg-[#2557a7] text-white",
  career: "bg-[#3a2f57] text-violet-100",
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

const scoreRing: Record<string, string> = {
  apply: "border-[var(--green)] text-[var(--green)]",
  maybe: "border-[var(--amber)] text-[var(--amber)]",
  skip: "border-border text-muted-foreground",
  pending: "border-border text-muted-foreground",
  err: "border-destructive text-destructive",
};

export default function Home() {
  const [view, setView] = useState<"today" | "pipeline">("today");
  const [jobs, setJobs] = useState<ClientJob[]>([]);
  const [meta, setMeta] = useState<ListResponse | null>(null);
  const [phase, setPhase] = useState<"idle" | "listing" | "analyzing" | "done">("idle");
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<"toapply" | "new" | "all" | "saved">("toapply");
  const [sourceFilter, setSourceFilter] = useState("all");
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
        isNew: !j.state, // no stored state = not seen/processed before
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
    if (filter === "new") v = v.filter((j) => j.isNew);
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
    if (phase === "done")
      v = [...v].sort((a, b) => (b.analysis?.matchScore ?? -1) - (a.analysis?.matchScore ?? -1));
    return v;
  }, [jobs, filter, sourceFilter, query, phase]);

  const analyzed = jobs.filter((j) => j.ui === "done" || j.ui === "error").length;
  const applyCount = jobs.filter((j) => j.analysis?.recommend === "apply").length;
  const maybeCount = jobs.filter((j) => j.analysis?.recommend === "maybe").length;
  const newCount = jobs.filter((j) => j.isNew).length;
  const busy = phase === "listing" || phase === "analyzing";

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 pb-24 sm:px-5 sm:py-8">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight sm:text-[28px]">
            job<span className="text-primary">now</span>
          </h1>
          <p className="mt-0.5 text-[13px] text-muted-foreground">
            Personal application cockpit · Hessen &amp; Rheinland-Pfalz
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Tabs value={view} onValueChange={(v) => setView(v as "today" | "pipeline")}>
            <TabsList>
              <TabsTrigger value="today">Today</TabsTrigger>
              <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
            </TabsList>
          </Tabs>
          {view === "today" && (
            <Button onClick={run} disabled={busy}>
              {phase === "listing" ? (
                <>
                  <RefreshCw className="animate-spin" /> Fetching…
                </>
              ) : phase === "analyzing" ? (
                <>
                  <RefreshCw className="animate-spin" /> Scoring {analyzed}/{jobs.length}
                </>
              ) : (
                <>
                  <RefreshCw /> Check today&apos;s jobs
                </>
              )}
            </Button>
          )}
        </div>
      </header>

      {err && (
        <div className="mt-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-[oklch(0.75_0.16_20)]">
          ⚠ {err}
        </div>
      )}

      {view === "pipeline" ? (
        <Pipeline />
      ) : (
        meta && (
          <div className="mt-5">
            <div className="flex flex-wrap gap-6 text-[13px] text-muted-foreground">
              <Stat n={meta.totalFound} label={`found · ${meta.windowHours}h`} />
              <Stat n={`${analyzed}/${jobs.length}`} label="scored" />
              <Stat n={newCount} label="new" accent />
              <Stat n={applyCount} label="worth applying" accent />
              <Stat n={maybeCount} label="maybe" />
            </div>

            {phase === "analyzing" && (
              <div className="mt-4 h-1 w-full overflow-hidden rounded bg-secondary">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${jobs.length ? (analyzed / jobs.length) * 100 : 0}%` }}
                />
              </div>
            )}

            <div className="mt-5 flex flex-wrap items-center gap-2.5">
              <Tabs value={filter} onValueChange={(v) => setFilter(v as any)}>
                <TabsList>
                  <TabsTrigger value="toapply">To apply</TabsTrigger>
                  <TabsTrigger value="new">🆕 New</TabsTrigger>
                  <TabsTrigger value="all">All</TabsTrigger>
                  <TabsTrigger value="saved">★ Saved</TabsTrigger>
                </TabsList>
              </Tabs>
              <Select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value)}>
                <option value="all">All sources</option>
                <option value="linkedin">LinkedIn</option>
                <option value="stepstone">StepStone</option>
                <option value="xing">Xing</option>
                <option value="indeed">Indeed</option>
                <option value="career">Career pages</option>
              </Select>
              <Input
                placeholder="Search title, company, tag…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="min-w-[160px] flex-1"
              />
              <span className="text-xs text-muted-foreground">{visible.length} shown</span>
            </div>

            <div className="mt-4 space-y-3">
              {visible.map((job) => (
                <JobCard key={job.id} job={job} patch={patch} />
              ))}
            </div>

            {meta.errors.length > 0 && (
              <details className="mt-7 text-xs text-muted-foreground">
                <summary className="cursor-pointer">{meta.errors.length} source query/queries had issues</summary>
                <ul className="mt-2 space-y-1">
                  {meta.errors.map((e, i) => (
                    <li key={i}>
                      <b>{e.source}</b>: {e.error}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <p className="mt-6 text-xs text-muted-foreground">
              run <code className="text-foreground">{meta.runId}</code>
              {meta.timings && ` · fetched in ${(meta.timings.listMs / 1000).toFixed(1)}s`} ·{" "}
              <a className="text-primary hover:underline" href="/api/logs?lines=400" target="_blank" rel="noreferrer">
                view logs
              </a>
            </p>
          </div>
        )
      )}

      {view === "today" && !meta && !busy && !err && (
        <div className="mt-16 text-center text-muted-foreground">
          <Sparkles className="mx-auto mb-3 size-7 opacity-50" />
          Hit <b className="text-foreground">Check today&apos;s jobs</b> to scan LinkedIn, StepStone, Xing &amp; career pages.
        </div>
      )}
    </div>
  );
}

function Stat({ n, label, accent }: { n: React.ReactNode; label: string; accent?: boolean }) {
  return (
    <div>
      <div className={cn("text-xl font-semibold leading-tight", accent ? "text-[var(--green)]" : "text-foreground")}>
        {n}
      </div>
      <div>{label}</div>
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
  const ring = a ? a.recommend : job.ui === "error" ? "err" : "pending";
  const ago = timeAgo(job.postedAt);

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

  const stripe =
    job.status === "saved"
      ? "border-l-[3px] border-l-[var(--amber)]"
      : job.status === "applied"
        ? "border-l-[3px] border-l-primary"
        : job.status === "interviewing"
          ? "border-l-[3px] border-l-violet-400"
          : job.status === "offer"
            ? "border-l-[3px] border-l-[var(--green)]"
            : job.status === "rejected"
              ? "border-l-[3px] border-l-destructive"
              : "";

  return (
    <Card className={cn(stripe, !a && "opacity-80")}>
      <CardContent className="grid grid-cols-[44px_1fr] gap-3 sm:grid-cols-[56px_1fr_auto] sm:gap-4">
        <div
          className={cn(
            "grid size-11 place-items-center rounded-full border-[2.5px] text-base font-bold sm:size-14 sm:text-xl",
            scoreRing[ring]
          )}
        >
          {a ? a.matchScore : job.ui === "error" ? "!" : <RefreshCw className="size-4 animate-spin" />}
        </div>

        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-[15px] font-semibold leading-snug sm:text-[17px]">
            {job.isNew && <Badge variant="good" className="shrink-0">🆕 New</Badge>}
            <a href={job.url} target="_blank" rel="noreferrer" className="hover:text-primary">
              {job.title}
            </a>
          </h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-muted-foreground">
            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", SOURCE_COLOR[job.source])}>
              {SOURCE_LABEL[job.source] ?? job.source}
            </span>
            <span>· {job.company} · {job.location}</span>
            {job.region && job.region !== job.location && <span>· {job.region}</span>}
            {ago ? (
              <span
                className={cn("inline-flex items-center gap-0.5", ago.fresh && "font-semibold text-[var(--green)]")}
                title={`Posted ${ago.title}`}
              >
                · <Clock className="size-3" /> {ago.label}
              </span>
            ) : (
              <span>· ⚑ date unknown</span>
            )}
          </div>

          {a ? (
            <>
              <p className="mt-2 text-sm text-foreground/90">{a.matchReason}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {a.language && (
                  <Badge variant="default" className="gap-1">
                    <Languages className="size-3" /> {a.language}
                  </Badge>
                )}
                {a.tags.map((t, i) => (
                  <Badge key={`t${i}`} variant="accent">
                    {t}
                  </Badge>
                ))}
                {a.salary && <Badge variant="good">💶 {a.salary}</Badge>}
                <Badge variant={a.coverLetterNeeded === "no" ? "good" : a.coverLetterNeeded === "yes" ? "warn" : "default"}>
                  cover letter: {a.coverLetterNeeded}
                </Badge>
                {a.quickApply === "yes" && <Badge variant="good">⚡ quick apply</Badge>}
                {a.redFlags.map((f, i) => (
                  <Badge key={`r${i}`} variant="warn">
                    ⚠ {f}
                  </Badge>
                ))}
              </div>
              {a.keyRequirements.length > 0 && (
                <p className="mt-2 text-[12.5px] text-muted-foreground">Needs: {a.keyRequirements.join(" · ")}</p>
              )}
            </>
          ) : (
            <p className="mt-2 text-sm italic text-muted-foreground">
              {job.ui === "error" ? "couldn’t score this one (see logs)" : "scoring…"}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button size="sm" onClick={() => makeDraft()}>
              <PenLine /> Draft
            </Button>
            <Button size="sm" variant={job.status === "saved" ? "success" : "secondary"} onClick={() => changeStatus("saved")}>
              <Star /> Save
            </Button>
            <Button size="sm" variant={job.status === "applied" ? "success" : "secondary"} onClick={() => changeStatus("applied")}>
              <Check /> Applied
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setNotesOpen((o) => !o)}>
              <StickyNote /> Notes{job.notes ? " •" : ""}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => changeStatus("dismissed")}>
              <X /> Dismiss
            </Button>
            {job.appliedAt && (
              <span className="ml-auto text-xs text-muted-foreground">applied {job.appliedAt.slice(0, 10)}</span>
            )}
          </div>

          {notesOpen && (
            <Textarea
              className="mt-2.5"
              placeholder="Notes — recruiter name, salary asked, follow-up…"
              defaultValue={job.notes}
              onBlur={(e) => saveNotes(e.target.value)}
            />
          )}

          {draftOpen && (
            <div className="mt-3 rounded-lg border border-border bg-background/40 p-3.5">
              {draftLoading && !job.draft ? (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <RefreshCw className="size-4 animate-spin" /> Writing a tailored application…
                </p>
              ) : job.draft ? (
                <DraftView draft={job.draft} onRegen={() => makeDraft(true)} loading={draftLoading} />
              ) : (
                <p className="text-sm text-muted-foreground">No draft.</p>
              )}
            </div>
          )}
        </div>

        <div className="col-span-2 flex flex-row items-center gap-2 border-t border-border pt-3 sm:col-span-1 sm:flex-col sm:items-end sm:border-0 sm:pt-0">
          {a && (
            <Badge
              variant={a.recommend === "apply" ? "good" : a.recommend === "maybe" ? "warn" : "default"}
              className="order-2 sm:order-1"
            >
              {a.recommend.toUpperCase()}
            </Badge>
          )}
          <Button asChild size="sm" variant="outline" className="order-1 flex-1 sm:order-2 sm:flex-none">
            <a href={job.url} target="_blank" rel="noreferrer">
              Open <ExternalLink />
            </a>
          </Button>
          <Select
            className="order-3 max-w-[150px] flex-1 text-[11.5px] sm:flex-none"
            value={job.status}
            onChange={(e) => changeStatus(e.target.value as AppStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>
        </div>
      </CardContent>
    </Card>
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
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <Badge variant="accent">{draft.language}</Badge>
        <Button size="sm" variant="secondary" onClick={() => copy(draft.coverLetter, "letter")}>
          <Copy /> {copied === "letter" ? "Copied!" : "Copy letter"}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => copy(draft.shortMessage, "msg")}>
          <Copy /> {copied === "msg" ? "Copied!" : "Quick-apply msg"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onRegen} disabled={loading}>
          <RefreshCw className={loading ? "animate-spin" : ""} /> Regenerate
        </Button>
      </div>
      <pre className="mb-3 whitespace-pre-wrap rounded-md border border-border bg-card p-3 font-sans text-[13px] leading-relaxed text-foreground/90">
        {draft.coverLetter}
      </pre>
      <div className="mb-3">
        <b className="text-[13px]">Why I fit:</b>
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-foreground/90">
          {draft.bullets.map((b, i) => (
            <li key={i}>{b}</li>
          ))}
        </ul>
      </div>
      <div>
        <b className="text-[13px]">Quick-apply message:</b>
        <p className="mt-1.5 text-[13px] italic text-muted-foreground">{draft.shortMessage}</p>
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

  if (!data) return <p className="mt-16 text-center text-muted-foreground">Loading pipeline…</p>;
  if (data.jobs.length === 0)
    return (
      <p className="mt-16 text-center text-muted-foreground">
        Nothing tracked yet. On the <b className="text-foreground">Today</b> tab, hit ★ Save or ✓ Applied to build your pipeline.
      </p>
    );

  const groups: AppStatus[] = ["saved", "applied", "interviewing", "offer", "rejected"];
  return (
    <div className="mt-5">
      <div className="flex flex-wrap gap-6 text-[13px] text-muted-foreground">
        {groups.map((g) => (
          <Stat key={g} n={data.counts[g] ?? 0} label={g} />
        ))}
      </div>
      {groups
        .filter((g) => data.jobs.some((j) => j.state.status === g))
        .map((g) => (
          <div key={g} className="mt-6">
            <h2 className="mb-2 border-b border-border pb-1.5 text-[15px] text-muted-foreground">{STATUS_LABEL[g]}</h2>
            <div className="space-y-3">
              {data.jobs
                .filter((j) => j.state.status === g)
                .map((rec) => {
                  const ago = timeAgo(rec.job.postedAt);
                  return (
                    <Card key={rec.job.id}>
                      <CardContent className="flex items-start gap-3">
                        <div
                          className={cn(
                            "grid size-11 shrink-0 place-items-center rounded-full border-[2.5px] text-base font-bold",
                            scoreRing[rec.analysis?.recommend ?? "pending"]
                          )}
                        >
                          {rec.analysis?.matchScore ?? "—"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-[15px] font-semibold sm:text-[17px]">
                            <a href={rec.job.url} target="_blank" rel="noreferrer" className="hover:text-primary">
                              {rec.job.title}
                            </a>
                          </h3>
                          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
                            <span className={cn("rounded px-1.5 py-0.5 text-[11px] font-bold", SOURCE_COLOR[rec.job.source])}>
                              {SOURCE_LABEL[rec.job.source] ?? rec.job.source}
                            </span>
                            <span>· {rec.job.company} · {rec.job.location}</span>
                            {ago && (
                              <span className="inline-flex items-center gap-0.5">
                                · <Clock className="size-3" /> {ago.label}
                              </span>
                            )}
                            {rec.state.appliedAt && <span>· applied {rec.state.appliedAt.slice(0, 10)}</span>}
                          </div>
                          {rec.state.notes && (
                            <p className="mt-1.5 text-[12.5px] text-muted-foreground">📝 {rec.state.notes}</p>
                          )}
                        </div>
                        <Button asChild size="sm" variant="outline">
                          <a href={rec.job.url} target="_blank" rel="noreferrer">
                            Open <ExternalLink />
                          </a>
                        </Button>
                      </CardContent>
                    </Card>
                  );
                })}
            </div>
          </div>
        ))}
    </div>
  );
}
