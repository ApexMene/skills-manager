import { describe, expect, it } from "vitest";
import {
  ancestors,
  buildGraph,
  buildTree,
  dailySeries,
  daysSince,
  effectiveConfig,
  listingBudget,
  listingCost,
  mcpConflicts,
  mcpUsage,
  normalizeState,
  skillConflicts,
  skillUsage,
  treeMatches,
  unusedCount,
} from "./configMap";
import type { ConfigMap } from "./tauri";

const sample: ConfigMap = {
  home: "~",
  skills: [
    { name: "alpha", description: "", source: "user", group: "~/.claude/skills", path: "~/.claude/skills/alpha", link: "~/.agents/skills/alpha", state: "off", agent: "claude", listing_chars: 0 },
    { name: "alpha", description: "", source: "agents", group: "~/.agents/skills", path: "~/.agents/skills/alpha", link: null, state: "on", agent: "claude", listing_chars: 0 },
    { name: "beta", description: "", source: "user", group: "~/.claude/skills", path: "~/.claude/skills/beta", link: "~/src/kit/skills/beta", state: "user-invocable-only", agent: "claude", listing_chars: 0 },
    { name: "p:gamma", description: "", source: "plugin", group: "p@market", path: "~/.claude/plugins/cache/p/skills/gamma", link: null, state: "on", agent: "claude", listing_chars: 120 },
    { name: "delta", description: "", source: "user", group: "~/.claude/skills", path: "~/.claude/skills/delta", link: null, state: "name-only", agent: "claude", listing_chars: 5 },
    { name: "delta", description: "", source: "codex", group: "~/.codex/skills", path: "~/.codex/skills/delta", link: null, state: "on", agent: "codex", listing_chars: 0 },
  ],
  plugins: [{ id: "p@market", version: "1", enabled: true, skills: ["gamma"], commands: [], agents: [], has_hooks: false, has_mcp: false, path: "~/.claude/plugins/cache/p" }],
  mcp_servers: [
    { name: "srv", agent: "claude", scope: "user", defined_in: "~/.claude.json", transport: "stdio", env_keys: ["TOKEN"] },
    { name: "srv", agent: "claude", scope: "project-file", defined_in: "~/projects/app/.mcp.json", transport: "stdio", env_keys: [] },
    { name: "other", agent: "claude", scope: "project", defined_in: "~/projects/web", transport: "http", env_keys: [] },
    { name: "srv", agent: "codex", scope: "user", defined_in: "~/.codex/config.toml", transport: "stdio", env_keys: [] },
  ],
  hooks: [],
  memory_files: [
    { path: "~/.claude/CLAUDE.md", dir: "~/.claude", file: "CLAUDE.md", size: 2048, symlink: false },
    { path: "~/projects/app/CLAUDE.md", dir: "~/projects/app", file: "CLAUDE.md", size: 10, symlink: false },
    { path: "~/projects/app/GEMINI.md", dir: "~/projects/app", file: "GEMINI.md", size: 99, symlink: false },
  ],
  dot_dirs: [{ path: "~/projects/app/.claude", kind: ".claude", skills: 1, commands: 0, agents: 0, files: [] }],
  override_count: 2,
  truncated: false,
  usage: {
    sessions: 3,
    since: "2026-01-01T00:00:00Z",
    retention_days: 30,
    tracked_sessions: 5,
    tracked_since: "2025-12-01T00:00:00Z",
    skills: { alpha: { count: 2, last_used: "2026-01-05T00:00:00Z" }, "p:gamma": { count: 1, last_used: "2026-01-05T00:00:00Z" } },
    mcp: { srv: { count: 1, last_used: "2026-01-05T00:00:00Z" } },
    daily: { "2026-01-05": 3 },
  },
  listing: { max_desc_chars: 1536, budget_fraction: null, char_budget: null },
  broken_links: [],
  stale_projects: [],
};

describe("buildGraph", () => {
  const { nodes, edges } = buildGraph(sample);
  const ids = nodes.map((n) => n.id);

  it("creates one node per skill group, plugin included", () => {
    expect(ids).toContain("group:~/.claude/skills");
    expect(ids).toContain("group:~/.agents/skills");
    expect(ids).toContain("group:p@market");
  });

  it("links symlinks to a known group, and others to an external target", () => {
    expect(edges).toContainEqual(expect.objectContaining({ from: "group:~/.claude/skills", to: "group:~/.agents/skills", kind: "link" }));
    expect(ids).toContain("external:~/src/kit");
  });

  it("marks overrides and plugin state from settings", () => {
    expect(edges).toContainEqual(expect.objectContaining({ from: "settings", to: "group:~/.claude/skills", kind: "manual", label: { key: "configMap.edge.overrides", count: 3 } }));
    expect(edges).toContainEqual(expect.objectContaining({ from: "settings", to: "group:p@market", kind: "on" }));
  });

  it("groups MCP servers by where they are declared", () => {
    expect(nodes.find((n) => n.path === "~/.claude.json" && n.kind === "mcp")?.chips).toEqual(["srv"]);
  });

  it("names .mcp.json nodes after their folder and keeps other agents off .claude.json", () => {
    expect(nodes.find((n) => n.path === "~/projects/app/.mcp.json")?.title).toBe("app");
    expect(nodes.find((n) => n.path === "~/.codex/config.toml")?.title).toBe("codex · config.toml");
    const fromClaudeJson = edges.filter((e) => e.from === "claude-json").map((e) => e.to);
    expect(fromClaudeJson.some((id) => id.includes("config.toml") || id.includes(".mcp.json"))).toBe(false);
  });
});

describe("buildTree", () => {
  const root = buildTree(sample);

  it("aggregates counts up to the root and skips plugin skills", () => {
    expect(root.counts.skill).toBe(5);
    expect(root.children[".claude"].children.skills.counts.skill).toBe(3);
  });

  it("filters by path or item label", () => {
    expect(treeMatches(root.children.projects, "app")).toBe(true);
    expect(treeMatches(root.children.projects, "nope")).toBe(false);
    expect(treeMatches(root.children[".agents"], "alpha")).toBe(true);
  });
});

describe("usage", () => {
  it("matches skills by name and MCP servers by sanitised name", () => {
    expect(skillUsage(sample.usage, sample.skills[0])?.count).toBe(2);
    expect(skillUsage(sample.usage, sample.skills[2])).toBeNull();
    expect(mcpUsage(sample.usage, sample.mcp_servers[0])?.count).toBe(1);
    expect(mcpUsage({ ...sample.usage, mcp: { claude_ai_Notes: { count: 4, last_used: "" } } }, { ...sample.mcp_servers[0], name: "claude.ai Notes" })?.count).toBe(4);
  });

  it("counts unused skills and days since last use", () => {
    expect(unusedCount(sample.usage, sample.skills)).toBe(3);
    expect(daysSince("2026-01-01T00:00:00Z", Date.parse("2026-01-11T12:00:00Z"))).toBe(10);
  });
});

describe("states", () => {
  it("keeps name-only apart from hidden skills", () => {
    expect(normalizeState("name-only")).toBe("name");
    expect(normalizeState("user-invocable-only")).toBe("manual");
  });
});

describe("context cost", () => {
  it("sums listed skills and splits out the unused ones", () => {
    const cost = listingCost(sample);
    expect(cost.listed.map((s) => s.name)).toEqual(["p:gamma", "delta"]);
    expect(cost.chars).toBe(125);
    expect(cost.unused.map((s) => s.name)).toEqual(["delta"]);
    expect(cost.unusedChars).toBe(5);
  });

  it("derives the budget from the window unless an override is set", () => {
    expect(listingBudget(sample.listing, 200_000)).toBe(8000);
    expect(listingBudget({ ...sample.listing, budget_fraction: 0.02 }, 200_000)).toBe(16000);
    expect(listingBudget({ ...sample.listing, char_budget: 500 }, 1_000_000)).toBe(500);
  });
});

describe("conflicts", () => {
  it("flags same-name skills at different real folders, per agent", () => {
    // alpha in ~/.claude/skills links to ~/.agents/skills/alpha: one skill. delta is per agent.
    expect(skillConflicts(sample.skills)).toEqual([]);
    const extra = { ...sample.skills[4], path: "~/projects/x/.claude/skills/delta", group: "x" };
    expect(skillConflicts([...sample.skills, extra])).toEqual([{ name: "delta", agent: "claude", places: ["~/.claude/skills/delta", "~/projects/x/.claude/skills/delta"] }]);
  });

  it("flags MCP servers declared in more than one file for the same agent", () => {
    expect(mcpConflicts(sample.mcp_servers)).toEqual([{ name: "srv", agent: "claude", places: ["~/.claude.json", "~/projects/app/.mcp.json"] }]);
  });
});

describe("effective config", () => {
  it("walks up from the folder", () => {
    expect(ancestors("~/projects/app")).toEqual(["~", "~/projects", "~/projects/app"]);
    const eff = effectiveConfig(sample, "~/projects/app");
    expect(eff.memory.map((m) => m.path)).toEqual(["~/.claude/CLAUDE.md", "~/projects/app/CLAUDE.md"]);
    expect(eff.memoryChars).toBe(2058);
    expect(eff.dotDirs.map((d) => d.path)).toEqual(["~/projects/app/.claude"]);
    expect(eff.mcp.map((s) => s.defined_in)).toEqual(["~/.claude.json", "~/projects/app/.mcp.json"]);
    expect(effectiveConfig(sample, "~/projects/web").mcp.map((s) => s.name)).toEqual(["srv", "other"]);
  });
});

describe("dailySeries", () => {
  it("fills missing days with zero", () => {
    const s = dailySeries({ "2026-01-05": 3 }, 3, Date.parse("2026-01-06T12:00:00Z"));
    expect(s).toEqual([
      { day: "2026-01-04", count: 0 },
      { day: "2026-01-05", count: 3 },
      { day: "2026-01-06", count: 0 },
    ]);
  });
});
