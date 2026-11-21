import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Activity,
  ChevronRight,
  FileText,
  Folder,
  FolderTree,
  Gauge,
  Loader2,
  Map as MapIcon,
  Maximize2,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Server,
  Webhook,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../utils";
import { getConfigMap, removeStaleProjects, setConfigSkillStates, type ConfigMap as ConfigMapData } from "../lib/tauri";
import {
  buildGraph,
  buildTree,
  dailySeries,
  daysSince,
  effectiveConfig,
  groupBy,
  listingBudget,
  listingCost,
  mcpConflicts,
  mcpUsage,
  skillConflicts,
  skillUsage,
  tokens,
  unusedCount,
  normalizeState,
  SKILL_STATES,
  stateCounts,
  treeMatches,
  type EdgeKind,
  type MapNode,
  type NodeKind,
  type TreeItemType,
  type TreeNode,
} from "../lib/configMap";
import type { MapSkill, Usage } from "../lib/tauri";

type Tab = "map" | "usage" | "context" | "cleanup" | "tree" | "mcp" | "memory" | "hooks";
const TABS: Array<{ id: Tab; icon: LucideIcon }> = [
  { id: "map", icon: MapIcon },
  { id: "usage", icon: Activity },
  { id: "context", icon: Gauge },
  { id: "cleanup", icon: Wrench },
  { id: "tree", icon: FolderTree },
  { id: "mcp", icon: Server },
  { id: "memory", icon: FileText },
  { id: "hooks", icon: Webhook },
];

const ICON_BUTTON =
  "rounded-md p-1.5 text-muted transition-colors outline-none hover:bg-surface-hover hover:text-secondary";

const NODE_ACCENT: Record<NodeKind, string> = {
  config: "bg-sky-500",
  skills: "bg-emerald-500",
  plugin: "bg-violet-500",
  mcp: "bg-amber-500",
  external: "bg-zinc-400",
  project: "bg-teal-500",
  memory: "bg-rose-500",
};

const EDGE_STROKE: Record<EdgeKind, string> = {
  on: "stroke-emerald-500",
  off: "stroke-zinc-400",
  manual: "stroke-amber-500",
  link: "stroke-violet-500",
  mcp: "stroke-sky-500",
};

const STATE_PILL: Record<string, string> = {
  on: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  name: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  manual: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  off: "bg-surface-hover text-muted",
};

const ITEM_PILL: Record<TreeItemType, string> = {
  skill: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  claude: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
  agents: "bg-sky-500/10 text-sky-600 dark:text-sky-400",
  dotdir: "bg-teal-500/10 text-teal-600 dark:text-teal-400",
  mcp: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  plugin: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
};

export function ConfigMap() {
  const { t } = useTranslation();
  const [data, setData] = useState<ConfigMapData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<Tab>("map");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getConfigMap());
    } catch (e) {
      setError(e && typeof e === "object" && "message" in e ? String(e.message) : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="app-page gap-4">
      <div className="app-page-header border-b-0 pb-0">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h1 className="app-page-title">{t("configMap.title")}</h1>
            <p className="mt-1 text-[13px] text-muted">
              {data
                ? t("configMap.summary", {
                    skills: data.skills.length,
                    plugins: data.plugins.length,
                    mcp: data.mcp_servers.length,
                    memory: data.memory_files.length,
                  })
                : t("configMap.subtitle")}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 text-[13px] font-medium text-tertiary transition-colors hover:bg-surface-hover disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
            {t("configMap.rescan")}
          </button>
        </div>
        <div className="flex gap-1 border-b border-border-subtle">
          {TABS.map(({ id, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setTab(id)}
              className={cn(
                "mr-4 flex items-center gap-1.5 border-b-2 px-1 pb-1.5 text-[13px] font-medium transition-colors outline-none",
                tab === id ? "border-accent text-accent" : "border-transparent text-muted hover:text-tertiary",
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t(`configMap.tabs.${id}`)}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="app-panel px-4 py-3 text-[13px] text-danger">{error}</div>}
      {!data && !error && (
        <div className="app-panel flex items-center gap-2 px-4 py-6 text-[13px] text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          {t("configMap.scanning")}
        </div>
      )}
      {data?.truncated && <p className="text-[12px] text-muted">{t("configMap.truncated")}</p>}

      {data && tab === "map" && <MapView data={data} />}
      {data && tab === "usage" && <UsageView data={data} />}
      {data && tab === "context" && <ContextView data={data} />}
      {data && tab === "cleanup" && <CleanupView data={data} onChanged={load} />}
      {data && tab === "tree" && <TreeView data={data} />}
      {data && tab === "mcp" && <McpView data={data} />}
      {data && tab === "memory" && <MemoryView data={data} />}
      {data && tab === "hooks" && <HooksView data={data} />}
    </div>
  );
}

// ── Map ──

interface EdgePath {
  d: string;
  kind: EdgeKind;
  label?: string;
  x: number;
  y: number;
  end: boolean;
}

function MapView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const graph = useMemo(() => buildGraph(data), [data]);
  const [selected, setSelected] = useState<MapNode | null>(null);
  const [view, setView] = useState({ x: 24, y: 24, k: 1 });
  const [paths, setPaths] = useState<EdgePath[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const viewportRef = useRef<HTMLDivElement>(null);
  const planeRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{ x: number; y: number } | null>(null);

  const columns = useMemo(() => {
    const cols: MapNode[][] = [[], [], [], []];
    for (const n of graph.nodes) cols[n.column].push(n);
    return cols;
  }, [graph]);

  // Edges are laid out in plane coordinates, so pan and zoom never re-measure.
  const measure = useCallback(() => {
    const plane = planeRef.current;
    if (!plane) return;
    const pick = (id: string) => {
      const el = nodeRefs.current.get(id);
      return el ? { x: el.offsetLeft + (el.offsetParent as HTMLElement).offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight } : null;
    };
    const next: EdgePath[] = [];
    for (const e of graph.edges) {
      const a = pick(e.from);
      const b = pick(e.to);
      if (!a || !b) continue;
      const forward = b.x >= a.x + a.w;
      const x1 = forward ? a.x + a.w : a.x;
      const x2 = forward ? b.x : b.x + b.w;
      const y1 = a.y + a.h / 2;
      const y2 = b.y + b.h / 2;
      const sameColumn = Math.abs(a.x - b.x) < 4;
      const bend = sameColumn ? -60 : (x2 - x1) / 2;
      const d = sameColumn
        ? `M${a.x},${y1} C${a.x + bend},${y1} ${b.x + bend},${y2} ${b.x},${y2}`
        : `M${x1},${y1} C${x1 + bend},${y1} ${x2 - bend},${y2} ${x2},${y2}`;
      next.push({
        d,
        kind: e.kind,
        label: e.label ? t(e.label.key, { count: e.label.count }) : undefined,
        // Labels sit just before the target, so ones that skip a column never land on a card.
        x: sameColumn ? a.x - 40 : x2 - 10,
        y: sameColumn ? (y1 + y2) / 2 : y2,
        end: !sameColumn,
      });
    }
    setPaths(next);
    setSize({ w: plane.scrollWidth, h: plane.scrollHeight });
  }, [graph, t]);

  useLayoutEffect(() => {
    // ResizeObserver fires once on observe, which does the first measure.
    const ro = new ResizeObserver(measure);
    if (planeRef.current) ro.observe(planeRef.current);
    return () => ro.disconnect();
  }, [measure]);

  // React's wheel listener is passive, so zoom needs a native one to stop page scroll.
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = el.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      setView((v) => {
        const k = Math.min(2, Math.max(0.3, v.k * (ev.deltaY < 0 ? 1.1 : 1 / 1.1)));
        return { k, x: px - ((px - v.x) * k) / v.k, y: py - ((py - v.y) * k) / v.k };
      });
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const zoomBy = (f: number) => setView((v) => ({ ...v, k: Math.min(2, Math.max(0.3, v.k * f)) }));
  const headers = [t("configMap.columns.config"), t("configMap.columns.skills"), t("configMap.columns.targets"), t("configMap.columns.projects")];

  return (
    <div className="flex gap-3 min-h-0">
      <div
        ref={viewportRef}
        className="app-panel relative flex-1 h-[640px] overflow-hidden cursor-grab active:cursor-grabbing select-none bg-bg-secondary"
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("[data-node]")) return;
          drag.current = { x: e.clientX - view.x, y: e.clientY - view.y };
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (drag.current) setView((v) => ({ ...v, x: e.clientX - drag.current!.x, y: e.clientY - drag.current!.y }));
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <div
          ref={planeRef}
          className="absolute left-0 top-0 origin-top-left flex gap-28"
          style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}
        >
          <svg className="absolute left-0 top-0 pointer-events-none overflow-visible" width={size.w} height={size.h}>
            {paths.map((p, i) => (
              <path key={i} d={p.d} fill="none" strokeWidth={1.5} className={`${EDGE_STROKE[p.kind]} opacity-70`} strokeDasharray={p.kind === "off" ? "4 4" : undefined} />
            ))}
          </svg>
          {columns.map((nodes, ci) => (
            <div key={ci} className="relative flex flex-col gap-3 w-60">
              <p className="app-section-title">{headers[ci]}</p>
              {nodes.map((n) => (
                <MapCard
                  key={n.id}
                  node={n}
                  usage={data.usage}
                  active={selected?.id === n.id}
                  onSelect={() => setSelected(n)}
                  refFn={(el) => (el ? nodeRefs.current.set(n.id, el) : nodeRefs.current.delete(n.id))}
                />
              ))}
            </div>
          ))}
          {paths.map((p, i) =>
            p.label ? (
              <span
                key={`l${i}`}
                className={cn("absolute -translate-y-1/2 pointer-events-none", p.end ? "-translate-x-full" : "-translate-x-1/2", " text-[11px] px-1.5 py-px rounded-full bg-surface border border-border-subtle text-muted whitespace-nowrap")}
                style={{ left: p.x, top: p.y }}
              >
                {p.label}
              </span>
            ) : null,
          )}
        </div>
        <div className="absolute right-3 bottom-3 flex gap-0.5 rounded-lg border border-border-subtle bg-surface p-0.5 shadow-sm">
          <button type="button" className={ICON_BUTTON} onClick={() => zoomBy(1 / 1.2)} aria-label={t("configMap.zoomOut")}><Minus className="h-3.5 w-3.5" /></button>
          <button type="button" className={ICON_BUTTON} onClick={() => setView({ x: 24, y: 24, k: 1 })} aria-label={t("configMap.resetView")}><Maximize2 className="h-3.5 w-3.5" /></button>
          <button type="button" className={ICON_BUTTON} onClick={() => zoomBy(1.2)} aria-label={t("configMap.zoomIn")}><Plus className="h-3.5 w-3.5" /></button>
        </div>
      </div>
      {selected && <NodeDetail node={selected} usage={data.usage} onClose={() => setSelected(null)} />}
    </div>
  );
}

function MapCard({ node, usage, active, onSelect, refFn }: { node: MapNode; usage: Usage; active: boolean; onSelect: () => void; refFn: (el: HTMLDivElement | null) => void }) {
  const { t } = useTranslation();
  const counts = node.skills ? stateCounts(node.skills) : null;
  const unused = node.skills ? unusedCount(usage, node.skills) : 0;
  const tracked = node.skills?.[0]?.agent === "claude";
  return (
    <div
      ref={refFn}
      data-node
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onSelect()}
      className={`rounded-xl border border-border bg-surface px-3 py-2.5 cursor-pointer transition-colors hover:bg-surface-hover ${active ? "ring-2 ring-accent" : ""}`}
    >
      <p className="flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted">
        <span className={`w-1.5 h-1.5 rounded-full ${NODE_ACCENT[node.kind]}`} />
        {t(`configMap.kinds.${node.kind}`)}
      </p>
      <p className="text-[13px] font-medium text-primary truncate" title={node.path}>{node.title}</p>
      {counts && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {SKILL_STATES.map((s) =>
            counts[s] > 0 ? (
              <span key={s} className={`whitespace-nowrap text-[11px] px-1.5 py-px rounded-full ${STATE_PILL[s]}`}>
                {counts[s]} {t(`configMap.state.${s}`)}
              </span>
            ) : null,
          )}
          {/* Usage is its own axis: "x/y used", so it never reads against the on/off counts. */}
          {tracked && <span
            className={cn(
              "whitespace-nowrap text-[11px] px-1.5 py-px rounded-full",
              unused === node.skills!.length ? "bg-rose-500/10 text-rose-600 dark:text-rose-400" : "bg-surface-hover text-muted",
            )}
          >
            {t("configMap.usage.usedOf", { used: node.skills!.length - unused, total: node.skills!.length })}
          </span>}
        </div>
      )}
      {node.stats?.map(([k, v]) => (
        <p key={k} className="text-[12px] text-muted flex justify-between gap-2">
          <span>{t(`configMap.stats.${k}`)}</span>
          <span className="text-secondary">{v}</span>
        </p>
      ))}
      {node.chips && node.chips.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {node.chips.slice(0, 6).map((c) => (
            <span key={c} className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-secondary border border-border-subtle">{c}</span>
          ))}
          {node.chips.length > 6 && <span className="text-[11px] text-muted">+{node.chips.length - 6}</span>}
        </div>
      )}
    </div>
  );
}

function NodeDetail({ node, usage, onClose }: { node: MapNode; usage: Usage; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <aside className="app-panel w-80 shrink-0 h-[640px] overflow-y-auto px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted">{t(`configMap.kinds.${node.kind}`)}</p>
          <h3 className="text-[14px] font-semibold text-primary break-words">{node.title}</h3>
          <p className="text-[12px] text-muted break-all">{node.path}</p>
        </div>
        <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={t("configMap.close")}><X className="w-4 h-4" /></button>
      </div>
      {node.stats && (
        <div className="mt-3 space-y-1">
          {node.stats.map(([k, v]) => (
            <p key={k} className="text-[13px] text-muted flex justify-between"><span>{t(`configMap.stats.${k}`)}</span><span className="text-secondary">{v}</span></p>
          ))}
        </div>
      )}
      {node.chips && (
        <div className="mt-3 flex flex-wrap gap-1">
          {node.chips.map((c) => <span key={c} className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-secondary border border-border-subtle">{c}</span>)}
        </div>
      )}
      {node.skills && (
        <ul className="mt-3 divide-y divide-border-subtle">
          {node.skills.map((s) => {
            const state = normalizeState(s.state);
            return (
              <li key={s.path} className="py-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[13px] text-primary truncate">{s.name}</span>
                  <span className={`text-[11px] px-1.5 py-px rounded-full shrink-0 ${STATE_PILL[state]}`}>{t(`configMap.state.${state}`)}</span>
                </div>
                {s.description && <p className="text-[12px] text-muted line-clamp-2">{s.description}</p>}
                <UsageLine usage={usage} skill={s} />
                {s.link && <p className="text-[11px] text-muted break-all">→ {s.link}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}

// ── Usage ──

function UsageLine({ usage, skill }: { usage: Usage; skill: MapSkill }) {
  const { t } = useTranslation();
  const entry = skillUsage(usage, skill);
  return (
    <p className={`text-[11px] ${entry ? "text-muted" : "text-rose-600 dark:text-rose-400"}`}>
      {entry
        ? t("configMap.usage.usedLine", { count: entry.count, days: daysSince(entry.last_used) })
        : t("configMap.usage.never")}
    </p>
  );
}

function McpUsagePill({ entry }: { entry: ReturnType<typeof mcpUsage> }) {
  const { t } = useTranslation();
  return entry ? (
    <span className="text-[11px] px-1.5 py-px rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
      {t("configMap.usage.calls", { count: entry.count })}
    </span>
  ) : (
    <span className="text-[11px] px-1.5 py-px rounded-full bg-rose-500/10 text-rose-600 dark:text-rose-400">{t("configMap.usage.never")}</span>
  );
}

type UsageFilter = "all" | "used" | "unused";

function UsageView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<UsageFilter>("unused");
  const { usage } = data;
  const rows = useMemo(
    () =>
      // A skill linked from ~/.claude/skills into ~/.agents/skills is one skill, not two.
      // Usage comes from Claude Code transcripts, so other agents' skills have none to show.
      Object.values(groupBy(data.skills.filter((s) => s.agent === "claude"), (s) => s.name))
        .map((same) => same.find((s) => !s.link) ?? same[0])
        .map((s) => ({ skill: s, entry: skillUsage(usage, s) }))
        .sort((a, b) => (b.entry?.count ?? 0) - (a.entry?.count ?? 0) || a.skill.name.localeCompare(b.skill.name)),
    [data.skills, usage],
  );
  const used = rows.filter((r) => r.entry).length;
  const shown = rows.filter((r) => filter === "all" || (filter === "used" ? r.entry : !r.entry));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-3 gap-3.5">
        {[
          [t("configMap.usage.sessions"), String(usage.sessions)],
          [t("configMap.usage.usedSkills"), `${used}/${rows.length}`],
          [t("configMap.usage.neverUsed"), String(rows.length - used)],
        ].map(([label, value]) => (
          <div key={label} className="app-panel px-4 py-3">
            <p className="app-section-title mb-1">{label}</p>
            <p className="text-[17px] font-semibold text-primary leading-none">{value}</p>
          </div>
        ))}
      </div>
      <p className="text-[12px] text-muted">
        {usage.since
          ? t("configMap.usage.window", { date: new Date(usage.since).toLocaleDateString(), days: usage.retention_days })
          : t("configMap.usage.noTranscripts")}
        {usage.tracked_since && " "}
        {usage.tracked_since &&
          t("configMap.usage.tracked", { date: new Date(usage.tracked_since).toLocaleDateString(), count: usage.tracked_sessions })}
      </p>
      <DailyChart daily={usage.daily} />
      <div className="app-segmented w-fit bg-background">
        {(["unused", "used", "all"] as const).map((f) => (
          <button key={f} type="button" className={cn("app-segmented-button", filter === f && "app-segmented-button-active")} onClick={() => setFilter(f)}>
            {t(`configMap.usage.filter.${f}`)}
          </button>
        ))}
      </div>
      <div className="app-panel divide-y divide-border-subtle">
        {shown.map(({ skill, entry }) => {
          const state = normalizeState(skill.state);
          return (
            <div key={skill.path} className="flex items-center justify-between gap-3 px-3.5 py-2">
              <div className="min-w-0">
                <p className="text-[13px] text-primary truncate">{skill.name}</p>
                <p className="text-[11px] text-muted truncate" title={skill.path}>{skill.group}</p>
              </div>
              <span className="flex items-center gap-1.5 shrink-0">
                <span className={`text-[11px] px-1.5 py-px rounded-full ${STATE_PILL[state]}`}>{t(`configMap.state.${state}`)}</span>
                <span className={`text-[12px] ${entry ? "text-secondary" : "text-rose-600 dark:text-rose-400"}`}>
                  {entry ? t("configMap.usage.usedLine", { count: entry.count, days: daysSince(entry.last_used) }) : t("configMap.usage.never")}
                </span>
              </span>
            </div>
          );
        })}
        {shown.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">{t("configMap.empty")}</p>}
      </div>
    </div>
  );
}

// ── Tree ──

const ITEM_TYPES: TreeItemType[] = ["skill", "claude", "agents", "dotdir", "plugin"];

function TreeView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const root = useMemo(() => buildTree(data), [data]);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState<Set<string>>(() => new Set(["~"]));
  const [folder, setFolder] = useState<string | null>(null);
  const toggle = (path: string) => {
    setFolder(path);
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };

  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input type="text" className="app-input w-full pl-9" placeholder={t("configMap.treeSearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-1.5">
        {ITEM_TYPES.map((type) => (
          <span key={type} className={`text-[11px] px-2 py-px rounded-full ${ITEM_PILL[type]}`}>
            {t(`configMap.items.${type}`)} · {root.counts[type] ?? 0}
          </span>
        ))}
      </div>
      <p className="text-[12px] text-muted">{t("configMap.effective.hint")}</p>
      <div className="flex gap-3 items-start">
        <div className="app-panel flex-1 min-w-0 px-2 py-2 font-mono">
          <TreeRow node={root} depth={0} query={query} open={open} toggle={toggle} selected={folder} />
        </div>
        {folder && <EffectivePanel data={data} folder={folder} onClose={() => setFolder(null)} />}
      </div>
    </div>
  );
}

function TreeRow({ node, depth, query, open, toggle, selected }: { node: TreeNode; depth: number; query: string; open: Set<string>; toggle: (p: string) => void; selected: string | null }) {
  const children = Object.values(node.children)
    .filter((c) => treeMatches(c, query))
    .sort((a, b) => a.name.localeCompare(b.name));
  const expanded = query ? true : open.has(node.path);
  const hasChildren = children.length > 0;
  return (
    <div>
      <div
        role="button"
        tabIndex={0}
        onClick={() => toggle(node.path)}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && toggle(node.path)}
        className={cn("flex items-center gap-1.5 rounded-md px-1.5 py-1 hover:bg-surface-hover cursor-pointer", selected === node.path && "bg-surface-hover")}
        style={{ paddingLeft: depth * 14 + 6 }}
      >
        <ChevronRight className={`w-3.5 h-3.5 text-muted transition-transform ${expanded ? "rotate-90" : ""} ${hasChildren ? "" : "invisible"}`} />
        <Folder className="w-3.5 h-3.5 text-muted" />
        <span className="text-[13px] text-secondary">{node.name}</span>
        {ITEM_TYPES.map((type) =>
          node.counts[type] ? (
            <span key={type} className={`text-[11px] px-1.5 rounded-full ${ITEM_PILL[type]}`}>{node.counts[type]}</span>
          ) : null,
        )}
      </div>
      {expanded && (
        <>
          {node.items.map((item, i) => (
            <div key={i} className="flex items-center gap-1.5 py-0.5" style={{ paddingLeft: (depth + 1) * 14 + 26 }}>
              <span className={`text-[11px] px-1.5 rounded-full ${ITEM_PILL[item.type]}`}>{item.label}</span>
            </div>
          ))}
          {children.map((c) => (
            <TreeRow key={c.path} node={c} depth={depth + 1} query={query} open={open} toggle={toggle} selected={selected} />
          ))}
        </>
      )}
    </div>
  );
}

// ── Lists ──

function McpView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const groups = groupBy(data.mcp_servers, (m) => m.defined_in);
  // Servers that show up in transcripts but in no config file: built-ins, plugins, claude.ai connectors.
  const configured = new Set(data.mcp_servers.map((s) => s.name.replace(/[^A-Za-z0-9_-]/g, "_")));
  const elsewhere = Object.entries(data.usage.mcp)
    .filter(([name]) => !configured.has(name))
    .sort((a, b) => b[1].count - a[1].count);
  if (data.mcp_servers.length === 0 && elsewhere.length === 0) return <p className="text-[13px] text-muted">{t("configMap.empty")}</p>;
  return (
    <div className="space-y-3">
      {elsewhere.length > 0 && (
        <div>
          <h2 className="app-section-title mb-1.5">{t("configMap.usage.elsewhere")}</h2>
          <div className="app-panel divide-y divide-border-subtle">
            {elsewhere.map(([name, entry]) => (
              <div key={name} className="flex items-center justify-between gap-3 px-3.5 py-2">
                <span className="text-[13px] text-primary">{name}</span>
                <span className="flex items-center gap-1.5">
                  <span className="text-[12px] text-muted">{t("configMap.usage.daysAgo", { count: daysSince(entry.last_used) })}</span>
                  <McpUsagePill entry={entry} />
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
      {Object.entries(groups).map(([where, servers]) => (
        <div key={where}>
          <h2 className="app-section-title mb-1.5">
            {where} · {servers[0].agent !== "claude" && `${servers[0].agent} · `}
            {t(`configMap.scope.${servers[0].scope}`)}
          </h2>
          <div className="app-panel divide-y divide-border-subtle">
            {servers.map((s) => (
              <div key={s.name} className="flex items-center justify-between gap-3 px-3.5 py-2">
                <span className="text-[13px] text-primary">{s.name}</span>
                <span className="flex items-center gap-1.5">
                  {s.agent === "claude" && <McpUsagePill entry={mcpUsage(data.usage, s)} />}
                  {s.env_keys.map((k) => <span key={k} className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-muted border border-border-subtle font-mono">{k}</span>)}
                  <span className="text-[11px] px-1.5 py-px rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">{s.transport}</span>
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function MemoryView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const files = data.memory_files.filter((f) => f.path.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="space-y-3">
      <div className="relative max-w-md">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
        <input type="text" className="app-input w-full pl-9" placeholder={t("configMap.memorySearch")} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      <div className="app-panel divide-y divide-border-subtle">
        {files.slice(0, 500).map((f) => (
          <div key={f.path} className="flex items-center justify-between gap-3 px-3.5 py-1.5">
            <span className="text-[13px] text-secondary font-mono truncate" title={f.path}>{f.path}</span>
            <span className="flex items-center gap-1.5 shrink-0">
              {f.symlink && <span className="text-[11px] px-1.5 py-px rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">{t("configMap.symlink")}</span>}
              <span className="text-[12px] text-muted">{(f.size / 1024).toFixed(1)} kB</span>
            </span>
          </div>
        ))}
      </div>
      {files.length > 500 && <p className="text-[12px] text-muted">{t("configMap.moreResults", { count: files.length - 500 })}</p>}
    </div>
  );
}

function HooksView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  if (data.hooks.length === 0) return <p className="text-[13px] text-muted">{t("configMap.empty")}</p>;
  return (
    <div className="app-panel divide-y divide-border-subtle">
      {data.hooks.map((h, i) => (
        <div key={i} className="px-3.5 py-2">
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] px-1.5 py-px rounded-full bg-sky-500/10 text-sky-600 dark:text-sky-400">{h.event}</span>
            {h.matcher && <span className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-muted border border-border-subtle">{h.matcher}</span>}
          </div>
          <p className="mt-1 text-[12px] text-secondary font-mono break-all">{h.command}</p>
        </div>
      ))}
    </div>
  );
}

// ── Usage over time ──

function DailyChart({ daily }: { daily: Record<string, number> }) {
  const { t } = useTranslation();
  const series = useMemo(() => dailySeries(daily, 60), [daily]);
  const max = Math.max(1, ...series.map((d) => d.count));
  return (
    <div className="app-panel px-4 py-3">
      <p className="app-section-title mb-2">{t("configMap.usage.perDay")}</p>
      <div className="flex h-16 items-end gap-px">
        {series.map((d) => (
          <div
            key={d.day}
            title={`${d.day} · ${d.count}`}
            className={cn("flex-1", d.count ? "bg-accent" : "bg-surface-hover")}
            style={{ height: d.count ? `${Math.max(8, (d.count / max) * 100)}%` : "2px" }}
          />
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-muted">
        <span>{series[0].day}</span>
        <span>{series[series.length - 1].day}</span>
      </div>
    </div>
  );
}

// ── Context cost ──

const WINDOWS = [200_000, 1_000_000];

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="app-panel px-4 py-3">
      <p className="app-section-title mb-1">{label}</p>
      <p className="text-[17px] font-semibold text-primary leading-none">{value}</p>
      {hint && <p className="mt-1 text-[12px] text-muted">{hint}</p>}
    </div>
  );
}

function ContextView({ data }: { data: ConfigMapData }) {
  const { t } = useTranslation();
  const cost = useMemo(() => listingCost(data), [data]);
  const [all, setAll] = useState(false);
  const global = data.memory_files.find((m) => m.path === "~/.claude/CLAUDE.md");
  const rows = all ? cost.listed : cost.listed.slice(0, 25);
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-muted">{t("configMap.context.intro")}</p>
      <div className="grid grid-cols-4 gap-3.5">
        <Stat label={t("configMap.context.listed")} value={String(cost.listed.length)} />
        <Stat label={t("configMap.context.listing")} value={t("configMap.context.tokens", { count: tokens(cost.chars) })} hint={t("configMap.context.chars", { count: cost.chars })} />
        <Stat
          label={t("configMap.context.unused")}
          value={t("configMap.context.tokens", { count: tokens(cost.unusedChars) })}
          hint={t("configMap.context.unusedHint", { count: cost.unused.length })}
        />
        <Stat label={t("configMap.context.globalMemory")} value={global ? t("configMap.context.tokens", { count: tokens(global.size) }) : "—"} hint="~/.claude/CLAUDE.md" />
      </div>
      <div className="app-panel space-y-2.5 px-4 py-3">
        <p className="app-section-title">{t("configMap.context.budget")}</p>
        {WINDOWS.map((w) => {
          const budget = listingBudget(data.listing, w);
          const share = cost.chars / budget;
          return (
            <div key={w}>
              <div className="flex justify-between text-[12px]">
                <span className="text-secondary">{t("configMap.context.window", { count: w / 1000 })}</span>
                <span className={share > 1 ? "text-amber-600 dark:text-amber-400" : "text-muted"}>
                  {t("configMap.context.ofBudget", { used: cost.chars.toLocaleString(), budget: budget.toLocaleString(), pct: Math.round(share * 100) })}
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded-full bg-surface-hover overflow-hidden">
                <div className={cn("h-full rounded-full", share > 1 ? "bg-amber-500" : "bg-emerald-500")} style={{ width: `${Math.min(100, share * 100)}%` }} />
              </div>
            </div>
          );
        })}
        {cost.chars > listingBudget(data.listing, WINDOWS[0]) && <p className="text-[12px] text-muted">{t("configMap.context.over")}</p>}
      </div>
      <div className="app-panel divide-y divide-border-subtle">
        {rows.map((s) => {
          const entry = skillUsage(data.usage, s);
          const state = normalizeState(s.state);
          return (
            <div key={s.path} className="flex items-center justify-between gap-3 px-3.5 py-2">
              <div className="min-w-0">
                <p className="text-[13px] text-primary truncate">{s.name}</p>
                <p className="text-[11px] text-muted truncate" title={s.path}>{s.group}</p>
              </div>
              <span className="flex items-center gap-1.5 shrink-0">
                <span className={`text-[11px] px-1.5 py-px rounded-full ${STATE_PILL[state]}`}>{t(`configMap.state.${state}`)}</span>
                <span className={`text-[12px] ${entry ? "text-muted" : "text-rose-600 dark:text-rose-400"}`}>
                  {entry ? t("configMap.usage.calls", { count: entry.count }) : t("configMap.usage.never")}
                </span>
                <span className="w-16 text-right text-[12px] text-secondary">{t("configMap.context.tokens", { count: tokens(s.listing_chars) })}</span>
              </span>
            </div>
          );
        })}
      </div>
      {!all && cost.listed.length > rows.length && (
        <button type="button" className="app-button-secondary" onClick={() => setAll(true)}>
          {t("configMap.context.showAll", { count: cost.listed.length })}
        </button>
      )}
    </div>
  );
}

// ── Cleanup ──

type Pending = { kind: "skills" | "projects" } | null;

function CleanupView({ data, onChanged }: { data: ConfigMapData; onChanged: () => Promise<void> }) {
  const { t } = useTranslation();
  const cost = useMemo(() => listingCost(data), [data]);
  // Plugin skills follow their plugin: skillOverrides cannot turn them off.
  const candidates = cost.unused.filter((s) => s.source !== "plugin");
  const pluginUnused = cost.unused.length - candidates.length;
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState<"name-only" | "off">("name-only");
  const [stale, setStale] = useState<Set<string>>(() => new Set(data.stale_projects));
  const [pending, setPending] = useState<Pending>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ text: string; error: boolean } | null>(null);
  const skillConf = useMemo(() => skillConflicts(data.skills), [data.skills]);
  const mcpConf = useMemo(() => mcpConflicts(data.mcp_servers), [data.mcp_servers]);

  const chosen = candidates.filter((s) => picked.has(s.name));
  const saved = chosen.reduce((n, s) => n + (target === "off" ? s.listing_chars : s.listing_chars - s.name.length), 0);
  const flip = (set: Set<string>, key: string) => {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  };

  const apply = async () => {
    if (!pending) return;
    setBusy(true);
    setResult(null);
    try {
      const r =
        pending.kind === "skills"
          ? await setConfigSkillStates(chosen.map((s) => ({ name: s.name, state: target })))
          : await removeStaleProjects([...stale]);
      setResult({ text: t("configMap.cleanup.done", { count: r.changed.length, backup: r.backup ?? "—" }), error: false });
      setPicked(new Set());
      setPending(null);
      await onChanged();
    } catch (e) {
      setResult({ text: e && typeof e === "object" && "message" in e ? String(e.message) : String(e), error: true });
    } finally {
      setBusy(false);
    }
  };

  const preview =
    pending?.kind === "skills"
      ? { file: "~/.claude/settings.json", lines: chosen.map((s) => `skillOverrides.${s.name} = "${target}"`) }
      : pending?.kind === "projects"
        ? { file: "~/.claude.json", lines: [...stale].map((p) => `projects["${p}"]`) }
        : null;

  return (
    <div className="space-y-4">
      <p className="text-[12px] text-muted">{t("configMap.cleanup.intro")}</p>
      {result && <div className={cn("app-panel px-4 py-3 text-[13px] break-all", result.error ? "text-danger" : "text-secondary")}>{result.text}</div>}

      {preview && (
        <div className="app-panel space-y-2 px-4 py-3">
          <p className="text-[13px] font-medium text-primary">{t("configMap.cleanup.previewTitle", { file: preview.file })}</p>
          <ul className="max-h-48 overflow-y-auto text-[12px] text-secondary font-mono">
            {preview.lines.map((l) => (
              <li key={l} className="break-all">{pending?.kind === "projects" ? "− " : "± "}{l}</li>
            ))}
          </ul>
          <p className="text-[12px] text-muted">{t("configMap.cleanup.backupNote")}</p>
          <div className="flex gap-2">
            <button type="button" className="app-button-primary" disabled={busy} onClick={() => void apply()}>
              {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              {t("configMap.cleanup.confirm")}
            </button>
            <button type="button" className="app-button-secondary" disabled={busy} onClick={() => setPending(null)}>
              {t("configMap.cleanup.cancel")}
            </button>
          </div>
        </div>
      )}

      <section>
        <h2 className="app-section-title mb-1.5">{t("configMap.cleanup.unusedTitle", { count: candidates.length })}</h2>
        <p className="mb-2 text-[12px] text-muted">{t("configMap.cleanup.unusedHint", { days: data.usage.retention_days })}</p>
        {pluginUnused > 0 && <p className="mb-2 text-[12px] text-muted">{t("configMap.cleanup.pluginNote", { count: pluginUnused })}</p>}
        {candidates.length > 0 && (
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <div className="app-segmented w-fit bg-background">
              {(["name-only", "off"] as const).map((s) => (
                <button key={s} type="button" className={cn("app-segmented-button", target === s && "app-segmented-button-active")} onClick={() => setTarget(s)}>
                  {t(`configMap.cleanup.to.${s}`)}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="app-button-secondary"
              onClick={() => setPicked(picked.size === candidates.length ? new Set() : new Set(candidates.map((s) => s.name)))}
            >
              {picked.size === candidates.length ? t("configMap.cleanup.selectNone") : t("configMap.cleanup.selectAll")}
            </button>
            <button type="button" className="app-button-primary" disabled={chosen.length === 0 || busy} onClick={() => setPending({ kind: "skills" })}>
              {t("configMap.cleanup.applySkills", { count: chosen.length, tokens: tokens(saved) })}
            </button>
          </div>
        )}
        <div className="app-panel divide-y divide-border-subtle">
          {candidates.map((s) => (
            <label key={s.path} className="flex items-center gap-2.5 px-3.5 py-2 cursor-pointer hover:bg-surface-hover">
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={picked.has(s.name)} onChange={() => setPicked(flip(picked, s.name))} />
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] text-primary truncate">{s.name}</span>
                <span className="block text-[11px] text-muted truncate">{s.description}</span>
              </span>
              <span className="shrink-0 text-[12px] text-secondary">{t("configMap.context.tokens", { count: tokens(s.listing_chars) })}</span>
            </label>
          ))}
          {candidates.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">{t("configMap.empty")}</p>}
        </div>
      </section>

      <section>
        <h2 className="app-section-title mb-1.5">{t("configMap.cleanup.staleTitle", { count: data.stale_projects.length })}</h2>
        <p className="mb-2 text-[12px] text-muted">{t("configMap.cleanup.staleHint")}</p>
        {data.stale_projects.length > 0 && (
          <button type="button" className="app-button-primary mb-2" disabled={stale.size === 0 || busy} onClick={() => setPending({ kind: "projects" })}>
            {t("configMap.cleanup.applyProjects", { count: stale.size })}
          </button>
        )}
        <div className="app-panel divide-y divide-border-subtle">
          {data.stale_projects.map((p) => (
            <label key={p} className="flex items-center gap-2.5 px-3.5 py-2 cursor-pointer hover:bg-surface-hover">
              <input type="checkbox" className="h-4 w-4 shrink-0 accent-accent" checked={stale.has(p)} onChange={() => setStale(flip(stale, p))} />
              <span className="text-[13px] text-secondary font-mono break-all">{p}</span>
            </label>
          ))}
          {data.stale_projects.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">{t("configMap.empty")}</p>}
        </div>
      </section>

      <section>
        <h2 className="app-section-title mb-1.5">{t("configMap.cleanup.brokenTitle", { count: data.broken_links.length })}</h2>
        <p className="mb-2 text-[12px] text-muted">{t("configMap.cleanup.brokenHint")}</p>
        <div className="app-panel divide-y divide-border-subtle">
          {data.broken_links.map((b) => (
            <div key={b.path} className="px-3.5 py-2 font-mono text-[12px]">
              <p className="text-primary break-all">{b.path}</p>
              <p className="text-muted break-all">→ {b.target}</p>
            </div>
          ))}
          {data.broken_links.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">{t("configMap.empty")}</p>}
        </div>
      </section>

      <section>
        <h2 className="app-section-title mb-1.5">{t("configMap.cleanup.conflictsTitle", { count: skillConf.length + mcpConf.length })}</h2>
        <p className="mb-2 text-[12px] text-muted">{t("configMap.cleanup.conflictsHint")}</p>
        <div className="app-panel divide-y divide-border-subtle">
          {[...skillConf.map((c) => ({ ...c, kind: "skill" as const })), ...mcpConf.map((c) => ({ ...c, kind: "mcp" as const }))].map((c) => (
            <div key={`${c.kind}:${c.agent}:${c.name}`} className="px-3.5 py-2">
              <p className="flex items-center gap-1.5">
                <span className={`text-[11px] px-1.5 py-px rounded-full ${c.kind === "skill" ? ITEM_PILL.skill : ITEM_PILL.mcp}`}>{t(`configMap.cleanup.kind.${c.kind}`)}</span>
                {c.agent !== "claude" && <span className="text-[11px] px-1.5 py-px rounded-full bg-surface-hover text-muted border border-border-subtle">{c.agent}</span>}
                <span className="text-[13px] text-primary">{c.name}</span>
              </p>
              {c.places.map((pl) => (
                <p key={pl} className="text-[12px] text-muted font-mono break-all">{pl}</p>
              ))}
            </div>
          ))}
          {skillConf.length + mcpConf.length === 0 && <p className="px-3.5 py-3 text-[13px] text-muted">{t("configMap.empty")}</p>}
        </div>
      </section>
    </div>
  );
}

// ── Effective config for a folder ──

function EffectivePanel({ data, folder, onClose }: { data: ConfigMapData; folder: string; onClose: () => void }) {
  const { t } = useTranslation();
  const eff = useMemo(() => effectiveConfig(data, folder), [data, folder]);
  return (
    <aside className="app-panel sticky top-0 w-80 shrink-0 space-y-3 px-4 py-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[11px] uppercase tracking-wide text-muted">{t("configMap.effective.title")}</p>
          <p className="text-[13px] font-medium text-primary break-all">{folder}</p>
        </div>
        <button type="button" className={ICON_BUTTON} onClick={onClose} aria-label={t("configMap.close")}><X className="w-4 h-4" /></button>
      </div>
      <div className="space-y-1 text-[13px]">
        <p className="flex justify-between text-muted"><span>{t("configMap.effective.skills")}</span><span className="text-secondary">{eff.skills}</span></p>
        <p className="flex justify-between text-muted"><span>{t("configMap.effective.mcp")}</span><span className="text-secondary">{eff.mcp.length}</span></p>
        <p className="flex justify-between text-muted"><span>{t("configMap.effective.memory")}</span><span className="text-secondary">{t("configMap.context.tokens", { count: tokens(eff.memoryChars) })}</span></p>
      </div>
      <div>
        <p className="app-section-title mb-1">{t("configMap.effective.memoryFiles")}</p>
        {eff.memory.map((m) => (
          <p key={m.path} className="flex justify-between gap-2 text-[12px]">
            <span className="text-secondary font-mono truncate" title={m.path}>{m.path}</span>
            <span className="flex shrink-0 items-center gap-1 text-muted">
              {m.symlink && <span className="text-[11px] px-1.5 py-px rounded-full bg-violet-500/10 text-violet-600 dark:text-violet-400">{t("configMap.symlink")}</span>}
              {t("configMap.context.tokens", { count: tokens(m.size) })}
            </span>
          </p>
        ))}
      </div>
      {eff.dotDirs.length > 0 && (
        <div>
          <p className="app-section-title mb-1">{t("configMap.effective.projectDirs")}</p>
          {eff.dotDirs.map((d) => (
            <p key={d.path} className="text-[12px] text-secondary font-mono break-all">{d.path} · {d.skills}</p>
          ))}
        </div>
      )}
      <div>
        <p className="app-section-title mb-1">{t("configMap.effective.mcpList")}</p>
        <div className="flex flex-wrap gap-1">
          {eff.mcp.map((s) => (
            <span key={`${s.defined_in}:${s.name}`} title={s.defined_in} className="text-[11px] px-1.5 py-px rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">{s.name}</span>
          ))}
        </div>
      </div>
      <p className="text-[11px] text-muted">{t("configMap.effective.note")}</p>
    </aside>
  );
}
