//! Map of where Claude Code (and, for MCP and skills, Codex and Gemini) keeps
//! its configuration on this machine: skill folders, plugins, MCP servers,
//! hooks, project `.claude`/`.agents` directories and memory files.
//!
//! Scanning never touches agent configuration. The only file it writes is its
//! own usage history (see `usage_history`), so counts survive Claude Code
//! deleting old transcripts. MCP `env` values are never read into the result,
//! only their keys. Hook commands are shown as written, cut to 140 characters.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use crate::core::error::AppError;

/// Folders never worth descending into when looking for memory files.
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    ".cache",
    ".git",
    ".venv",
    "venv",
    "__pycache__",
    ".npm",
    ".cargo",
    ".rustup",
    "target",
    "dist",
    "build",
    ".next",
    "Android",
    "snap",
    "Library",
];
const MAX_DEPTH: usize = 6;
const MAX_MEMORY_FILES: usize = 5000;

#[derive(Debug, Serialize)]
pub struct MapSkill {
    pub name: String,
    pub description: String,
    /// "user" (~/.claude/skills), "agents" (~/.agents/skills) or "plugin".
    pub source: String,
    /// Display group: the folder, or the plugin id.
    pub group: String,
    pub path: String,
    /// Resolved target when the skill folder is a symlink.
    pub link: Option<String>,
    /// "on", "name-only", "user-invocable-only" or "off". From settings.json
    /// `skillOverrides` for personal skills; plugin skills follow their plugin.
    pub state: String,
    /// "claude", "codex" or "gemini".
    pub agent: String,
    /// Characters this skill adds to the skill listing Claude Code puts in every
    /// session: name plus description and `when_to_use`, capped per entry.
    /// Zero when the skill is not listed to Claude.
    pub listing_chars: usize,
}

/// A skill folder entry that is a symlink to something that no longer exists.
#[derive(Debug, Serialize)]
pub struct BrokenLink {
    pub path: String,
    pub target: String,
}

/// Settings that size the skill listing, as far as they can be read from disk.
#[derive(Debug, Serialize)]
pub struct ListingInfo {
    /// `skillListingMaxDescChars`, default 1536.
    pub max_desc_chars: usize,
    /// `skillListingBudgetFraction` when set; Claude Code's default is 1%.
    pub budget_fraction: Option<f64>,
    /// `SLASH_COMMAND_TOOL_CHAR_BUDGET` when set in this app's environment.
    pub char_budget: Option<u64>,
}

#[derive(Debug, Serialize)]
pub struct MapPlugin {
    pub id: String,
    pub version: String,
    pub enabled: bool,
    pub skills: Vec<String>,
    pub commands: Vec<String>,
    pub agents: Vec<String>,
    pub has_hooks: bool,
    pub has_mcp: bool,
    pub path: String,
}

#[derive(Debug, Serialize)]
pub struct MapMcpServer {
    pub name: String,
    /// "claude", "codex" or "gemini".
    pub agent: String,
    /// "user", "project", "project-file" (a `.mcp.json`) or "settings".
    pub scope: String,
    /// File (and for project scope, the project) that declares it.
    pub defined_in: String,
    pub transport: String,
    pub env_keys: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct MapHook {
    pub event: String,
    pub matcher: String,
    pub command: String,
}

#[derive(Debug, Serialize)]
pub struct MapMemoryFile {
    pub path: String,
    pub dir: String,
    pub file: String,
    pub size: u64,
    pub symlink: bool,
}

#[derive(Debug, Serialize)]
pub struct MapDotDir {
    pub path: String,
    pub kind: String,
    pub skills: usize,
    pub commands: usize,
    pub agents: usize,
    pub files: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ConfigMap {
    pub home: String,
    pub skills: Vec<MapSkill>,
    pub plugins: Vec<MapPlugin>,
    pub mcp_servers: Vec<MapMcpServer>,
    pub hooks: Vec<MapHook>,
    pub memory_files: Vec<MapMemoryFile>,
    pub dot_dirs: Vec<MapDotDir>,
    pub override_count: usize,
    /// True when the memory-file walk stopped at MAX_MEMORY_FILES.
    pub truncated: bool,
    pub usage: Usage,
    pub listing: ListingInfo,
    pub broken_links: Vec<BrokenLink>,
    /// `~/.claude.json` project entries whose folder no longer exists.
    pub stale_projects: Vec<String>,
}

#[derive(Debug, Default, Serialize)]
pub struct UsageEntry {
    pub count: u32,
    /// ISO-8601 timestamp of the latest use, as written in the transcript.
    pub last_used: String,
}

/// How often skills and MCP servers were actually used, counted from the
/// Claude Code session transcripts in `~/.claude/projects`. Only tool names and
/// timestamps are read; message text is never kept.
#[derive(Debug, Default, Serialize)]
pub struct Usage {
    /// Transcripts read in this scan.
    pub sessions: usize,
    /// Earliest timestamp in the transcripts still on disk.
    pub since: Option<String>,
    pub retention_days: u64,
    /// Sessions in the saved history, including ones whose transcript is gone.
    pub tracked_sessions: usize,
    /// Earliest timestamp in the saved history.
    pub tracked_since: Option<String>,
    /// Keyed by the name the Skill tool or slash command used.
    pub skills: BTreeMap<String, UsageEntry>,
    /// Keyed by the server segment of `mcp__<server>__<tool>`.
    pub mcp: BTreeMap<String, UsageEntry>,
    /// Skill and MCP calls per day (`YYYY-MM-DD`), over the whole history.
    pub daily: BTreeMap<String, u32>,
}

/// Counts for one name within one session.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct StoredEntry {
    count: u32,
    last: String,
    days: BTreeMap<String, u32>,
}

/// What one transcript contributed. Stored per session so a rescan replaces a
/// session's counts instead of adding them again.
#[derive(Debug, Default, Clone, Serialize, Deserialize)]
struct SessionUsage {
    first: String,
    skills: BTreeMap<String, StoredEntry>,
    mcp: BTreeMap<String, StoredEntry>,
}

impl SessionUsage {
    fn bump(map: &mut BTreeMap<String, StoredEntry>, key: &str, ts: &str) {
        let e = map.entry(key.to_string()).or_default();
        e.count += 1;
        if ts > e.last.as_str() {
            e.last = ts.to_string();
        }
        if ts.len() >= 10 {
            *e.days.entry(ts[..10].to_string()).or_default() += 1;
        }
    }

    /// Feeds one transcript line. Cheap substring checks skip the lines that
    /// cannot hold a tool call or a slash command before any JSON parsing.
    fn read_line(&mut self, line: &str) {
        let has_tool = line.contains("\"tool_use\"");
        let has_command = line.contains("<command-name>/");
        if !has_tool && !has_command {
            return;
        }
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let ts = v["timestamp"].as_str().unwrap_or("");
        if !ts.is_empty() && (self.first.is_empty() || ts < self.first.as_str()) {
            self.first = ts.to_string();
        }
        let content = &v["message"]["content"];
        if has_tool {
            for item in content.as_array().into_iter().flatten() {
                if item["type"] != "tool_use" {
                    continue;
                }
                let name = item["name"].as_str().unwrap_or("");
                if name == "Skill" {
                    if let Some(skill) = item["input"]["skill"].as_str() {
                        Self::bump(&mut self.skills, skill, ts);
                    }
                } else if let Some(rest) = name.strip_prefix("mcp__") {
                    if let Some((server, _)) = rest.split_once("__") {
                        Self::bump(&mut self.mcp, server, ts);
                    }
                }
            }
        }
        // Slash commands are only counted in what the user typed, never in assistant text.
        if has_command && v["type"] == "user" {
            let text = match content {
                Value::String(s) => s.clone(),
                Value::Array(a) => a
                    .iter()
                    .filter_map(|i| i["text"].as_str())
                    .collect::<Vec<_>>()
                    .join(""),
                _ => String::new(),
            };
            for part in text.split("<command-name>/").skip(1) {
                let Some((cmd, _)) = part.split_once("</command-name>") else {
                    continue;
                };
                let valid = !cmd.is_empty()
                    && cmd
                        .chars()
                        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '_' | '-' | '.'));
                if valid {
                    Self::bump(&mut self.skills, cmd, ts);
                }
            }
        }
    }

    fn is_empty(&self) -> bool {
        self.skills.is_empty() && self.mcp.is_empty()
    }
}

/// The saved history file: one entry per transcript, keyed by its path below
/// `~/.claude/projects`. Entries stay after Claude Code deletes the transcript.
#[derive(Debug, Default, Serialize, Deserialize)]
struct UsageHistory {
    version: u32,
    sessions: BTreeMap<String, SessionUsage>,
}

fn load_history(path: &Path) -> UsageHistory {
    let Ok(text) = std::fs::read_to_string(path) else {
        return UsageHistory::default();
    };
    match serde_json::from_str(&text) {
        Ok(h) => h,
        Err(_) => {
            // Keep the unreadable file aside instead of overwriting it.
            let _ = std::fs::rename(path, path.with_extension("json.bad"));
            UsageHistory::default()
        }
    }
}

fn save_history(path: &Path, history: &UsageHistory) {
    let Ok(json) = serde_json::to_string(history) else {
        return;
    };
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let tmp = path.with_extension("json.tmp");
    if std::fs::write(&tmp, json).is_ok() {
        let _ = std::fs::rename(&tmp, path);
    }
}

fn add_entries(into: &mut BTreeMap<String, UsageEntry>, from: &BTreeMap<String, StoredEntry>) {
    for (name, e) in from {
        let out = into.entry(name.clone()).or_default();
        out.count += e.count;
        if e.last > out.last_used {
            out.last_used = e.last.clone();
        }
    }
}

// `Option::is_none_or` needs Rust 1.82; the crate supports 1.77.
#[allow(clippy::unnecessary_map_or)]
/// Reads every transcript, merges it into the history at `history_path` (when
/// given) and returns totals over the whole history.
fn collect_usage(home: &Path, retention_days: u64, history_path: Option<&Path>) -> Usage {
    use std::io::BufRead;
    let mut history = history_path.map(load_history).unwrap_or_default();
    history.version = 1;
    let mut usage = Usage {
        retention_days,
        ..Default::default()
    };
    let root = home.join(".claude/projects");
    for entry in walkdir::WalkDir::new(&root)
        .max_depth(4)
        .into_iter()
        .flatten()
    {
        if entry.path().extension().and_then(|x| x.to_str()) != Some("jsonl") {
            continue;
        }
        let Ok(file) = std::fs::File::open(entry.path()) else {
            continue;
        };
        usage.sessions += 1;
        let mut session = SessionUsage::default();
        for line in std::io::BufReader::new(file).lines().map_while(Result::ok) {
            session.read_line(&line);
        }
        if !session.first.is_empty()
            && usage
                .since
                .as_deref()
                .map_or(true, |s| session.first.as_str() < s)
        {
            usage.since = Some(session.first.clone());
        }
        let key = entry
            .path()
            .strip_prefix(&root)
            .unwrap_or(entry.path())
            .to_string_lossy()
            .to_string();
        if session.is_empty() {
            history.sessions.remove(&key);
        } else {
            history.sessions.insert(key, session);
        }
    }
    for s in history.sessions.values() {
        add_entries(&mut usage.skills, &s.skills);
        add_entries(&mut usage.mcp, &s.mcp);
        for e in s.skills.values().chain(s.mcp.values()) {
            for (day, n) in &e.days {
                *usage.daily.entry(day.clone()).or_default() += n;
            }
        }
        if !s.first.is_empty()
            && usage
                .tracked_since
                .as_deref()
                .map_or(true, |t| s.first.as_str() < t)
        {
            usage.tracked_since = Some(s.first.clone());
        }
    }
    usage.tracked_sessions = history.sessions.len();
    if let Some(path) = history_path {
        save_history(path, &history);
    }
    usage
}

fn tilde(home: &Path, p: &Path) -> String {
    match p.strip_prefix(home) {
        Ok(rest) if rest.as_os_str().is_empty() => "~".to_string(),
        Ok(rest) => format!("~/{}", rest.to_string_lossy()),
        Err(_) => p.to_string_lossy().to_string(),
    }
}

fn read_json(p: &Path) -> Value {
    std::fs::read_to_string(p)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or(Value::Null)
}

/// The SKILL.md front matter fields that decide what Claude sees.
#[derive(Debug, Default)]
struct Front {
    description: String,
    when_to_use: String,
    disable_model_invocation: bool,
}

/// Reads `description`, `when_to_use` and `disable-model-invocation` from a
/// SKILL.md front matter, folding multi-line values onto one line.
fn skill_front(skill_md: &Path) -> Front {
    let mut front = Front::default();
    let Ok(text) = std::fs::read_to_string(skill_md) else {
        return front;
    };
    let Some(rest) = text.strip_prefix("---") else {
        return front;
    };
    let Some(end) = rest.find("\n---") else {
        return front;
    };
    // Which field the indented continuation lines belong to.
    let mut current: Option<&mut String> = None;
    for line in rest[..end].lines() {
        if line.starts_with(' ') || line.starts_with('\t') {
            if let Some(field) = current.as_deref_mut() {
                if !field.is_empty() {
                    field.push(' ');
                }
                field.push_str(line.trim());
            }
            continue;
        }
        current = None;
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim().trim_matches(|c| c == '"' || c == '\'');
        let block = matches!(value, ">" | "|" | ">-" | "|-" | ">+" | "|+");
        match key.trim() {
            "description" | "when_to_use" => {
                let field = if key.trim() == "description" {
                    &mut front.description
                } else {
                    &mut front.when_to_use
                };
                if !block {
                    field.push_str(value);
                }
                current = Some(field);
            }
            "disable-model-invocation" => front.disable_model_invocation = value == "true",
            _ => {}
        }
    }
    front
}

/// Characters a skill adds to the listing, following the documented rules:
/// "on" lists name and description (with `when_to_use`, capped at
/// `max_desc`), "name-only" lists the name, anything else is not listed.
fn listing_chars(name: &str, front: &Front, state: &str, max_desc: usize) -> usize {
    if front.disable_model_invocation {
        return 0;
    }
    match state {
        "on" => {
            let desc = front.description.chars().count()
                + front.when_to_use.chars().count()
                + usize::from(!front.when_to_use.is_empty());
            name.chars().count() + desc.min(max_desc)
        }
        "name-only" => name.chars().count(),
        _ => 0,
    }
}

fn names_in(dir: &Path, want_md: bool) -> Vec<String> {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut out: Vec<String> = rd
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if want_md {
                (p.extension().and_then(|x| x.to_str()) == Some("md"))
                    .then(|| p.file_stem().map(|s| s.to_string_lossy().to_string()))
                    .flatten()
            } else {
                p.join("SKILL.md")
                    .is_file()
                    .then(|| e.file_name().to_string_lossy().to_string())
            }
        })
        .collect();
    out.sort();
    out
}

fn count_entries(dir: &Path) -> usize {
    std::fs::read_dir(dir).map(|rd| rd.count()).unwrap_or(0)
}

fn state_for(overrides: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    keys.iter()
        .find_map(|k| overrides.get(*k).and_then(|v| v.as_str()))
        .unwrap_or("on")
        .to_string()
}

/// Where a skill folder sits and whether Claude Code lists its skills.
struct SkillSource<'a> {
    source: &'a str,
    agent: &'a str,
    /// Only `~/.claude/skills` is read by Claude Code itself.
    listed: bool,
}

fn collect_skill_dir(
    home: &Path,
    dir: &Path,
    src: &SkillSource,
    overrides: &serde_json::Map<String, Value>,
    max_desc: usize,
    out: &mut Vec<MapSkill>,
    broken: &mut Vec<BrokenLink>,
) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
    entries.sort();
    for p in entries {
        let is_link = std::fs::symlink_metadata(&p)
            .map(|m| m.file_type().is_symlink())
            .unwrap_or(false);
        if !p.is_dir() {
            if is_link && !p.exists() {
                broken.push(BrokenLink {
                    path: tilde(home, &p),
                    target: std::fs::read_link(&p)
                        .map(|t| tilde(home, &t))
                        .unwrap_or_default(),
                });
            }
            continue;
        }
        let name = p
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .to_string();
        let link = is_link
            .then(|| std::fs::canonicalize(&p).ok())
            .flatten()
            .map(|t| tilde(home, &t));
        let front = skill_front(&p.join("SKILL.md"));
        let state = if src.agent == "claude" {
            state_for(overrides, &[&name])
        } else {
            "on".to_string()
        };
        out.push(MapSkill {
            description: front.description.chars().take(300).collect(),
            listing_chars: if src.listed {
                listing_chars(&name, &front, &state, max_desc)
            } else {
                0
            },
            state,
            agent: src.agent.to_string(),
            source: src.source.to_string(),
            group: tilde(home, dir),
            path: tilde(home, &p),
            link,
            name,
        });
    }
}

fn transport(cfg: &Value) -> String {
    cfg.get("type")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| {
            if cfg.get("command").is_some() {
                "stdio".into()
            } else if cfg.get("url").is_some() {
                "http".into()
            } else {
                "unknown".into()
            }
        })
}

fn push_mcp(
    out: &mut Vec<MapMcpServer>,
    servers: &Value,
    agent: &str,
    scope: &str,
    defined_in: String,
) {
    let Some(map) = servers.as_object() else {
        return;
    };
    for (name, cfg) in map {
        let mut env_keys: Vec<String> = cfg
            .get("env")
            .and_then(|e| e.as_object())
            .map(|e| e.keys().cloned().collect())
            .unwrap_or_default();
        env_keys.sort();
        out.push(MapMcpServer {
            name: name.clone(),
            agent: agent.to_string(),
            scope: scope.to_string(),
            defined_in: defined_in.clone(),
            transport: transport(cfg),
            env_keys,
        });
    }
}

/// MCP servers from Codex's `config.toml`: `[mcp_servers.<name>]` tables with
/// `command` or `url`, and env keys from `[mcp_servers.<name>.env]` or an
/// inline `env = { ... }`. Only names are kept, never values. A small line
/// parser is enough for this shape and avoids a TOML dependency.
fn codex_mcp(home: &Path, text: &str, out: &mut Vec<MapMcpServer>) {
    let mut servers: BTreeMap<String, (String, Vec<String>)> = BTreeMap::new();
    let mut current: Option<(String, bool)> = None; // (server, in env table)
    for raw in text.lines() {
        let line = raw.trim();
        if line.starts_with('[') {
            current = None;
            let header = line.trim_start_matches('[').trim_end_matches(']').trim();
            if let Some(rest) = header.strip_prefix("mcp_servers.") {
                let (name, tail) = split_toml_key(rest);
                if !name.is_empty() {
                    let env = tail == ".env";
                    if tail.is_empty() || env {
                        servers.entry(name.clone()).or_default();
                        current = Some((name, env));
                    }
                }
            }
            continue;
        }
        let Some((server, in_env)) = current.as_ref() else {
            continue;
        };
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().trim_matches('"').to_string();
        let entry = servers.entry(server.clone()).or_default();
        if *in_env {
            entry.1.push(key);
        } else if key == "command" {
            entry.0 = "stdio".into();
        } else if key == "url" && entry.0.is_empty() {
            entry.0 = "http".into();
        } else if key == "env" {
            let inner = value.trim().trim_start_matches('{').trim_end_matches('}');
            for pair in inner.split(',') {
                if let Some((k, _)) = pair.split_once('=') {
                    entry.1.push(k.trim().trim_matches('"').to_string());
                }
            }
        }
    }
    let defined_in = tilde(home, &home.join(".codex/config.toml"));
    for (name, (transport, mut env_keys)) in servers {
        env_keys.sort();
        env_keys.dedup();
        out.push(MapMcpServer {
            name,
            agent: "codex".into(),
            scope: "user".into(),
            defined_in: defined_in.clone(),
            transport: if transport.is_empty() {
                "unknown".into()
            } else {
                transport
            },
            env_keys,
        });
    }
}

/// Splits `name.rest` or `"quoted.name".rest` into the first key and the rest.
fn split_toml_key(s: &str) -> (String, &str) {
    if let Some(q) = s.strip_prefix('"') {
        match q.find('"') {
            Some(end) => (q[..end].to_string(), &q[end + 1..]),
            None => (String::new(), ""),
        }
    } else {
        match s.find('.') {
            Some(dot) => (s[..dot].trim().to_string(), &s[dot..]),
            None => (s.trim().to_string(), ""),
        }
    }
}

fn walk_home(
    home: &Path,
    memory: &mut Vec<MapMemoryFile>,
    dots: &mut Vec<MapDotDir>,
    mcp_files: &mut Vec<PathBuf>,
) -> bool {
    let claude_root = home.join(".claude");
    let mut truncated = false;
    let walker = walkdir::WalkDir::new(home)
        .max_depth(MAX_DEPTH)
        .follow_links(false)
        .into_iter()
        .filter_entry(|e| {
            if e.depth() == 0 {
                return true;
            }
            let name = e.file_name().to_string_lossy();
            if e.file_type().is_dir() {
                if SKIP_DIRS.contains(&name.as_ref()) {
                    return false;
                }
                // Hidden folders are skipped, except the ones that hold agent config.
                if name.starts_with('.') && name != ".claude" && name != ".agents" {
                    return false;
                }
                // Inside ~/.claude, plugin caches and session logs are not config.
                if e.path().starts_with(&claude_root)
                    && (name == "plugins" || name == "projects" || name == "file-history")
                {
                    return false;
                }
            }
            true
        });
    for entry in walker.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let path = entry.path();
        if entry.file_type().is_dir() && (name == ".claude" || name == ".agents") {
            let files = [
                "settings.json",
                "settings.local.json",
                "CLAUDE.md",
                ".mcp.json",
            ]
            .iter()
            .filter(|f| path.join(f).exists())
            .map(|f| f.to_string())
            .collect();
            dots.push(MapDotDir {
                path: tilde(home, path),
                kind: name.clone(),
                skills: count_entries(&path.join("skills")),
                commands: count_entries(&path.join("commands")),
                agents: count_entries(&path.join("agents")),
                files,
            });
            continue;
        }
        if name == ".mcp.json" && entry.file_type().is_file() {
            mcp_files.push(path.to_path_buf());
            continue;
        }
        if matches!(
            name.as_str(),
            "CLAUDE.md" | "AGENTS.md" | "CLAUDE.local.md" | "GEMINI.md"
        ) {
            if memory.len() >= MAX_MEMORY_FILES {
                truncated = true;
                break;
            }
            let symlink = entry.path_is_symlink();
            let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
            memory.push(MapMemoryFile {
                path: tilde(home, path),
                dir: tilde(home, path.parent().unwrap_or(home)),
                file: name,
                size,
                symlink,
            });
        }
    }
    memory.sort_by(|a, b| a.path.cmp(&b.path));
    truncated
}

/// Scans `home`. When `history` is given, usage counts are merged into that
/// file and totals cover every session ever seen, not only the transcripts
/// still on disk.
pub fn build_config_map(home: &Path, history: Option<&Path>) -> ConfigMap {
    let settings = read_json(&home.join(".claude/settings.json"));
    let empty = serde_json::Map::new();
    let overrides = settings
        .get("skillOverrides")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let enabled = settings.get("enabledPlugins").and_then(|v| v.as_object());
    let listing = ListingInfo {
        max_desc_chars: settings["skillListingMaxDescChars"]
            .as_u64()
            .map(|n| n as usize)
            .unwrap_or(1536),
        budget_fraction: settings["skillListingBudgetFraction"].as_f64(),
        char_budget: std::env::var("SLASH_COMMAND_TOOL_CHAR_BUDGET")
            .ok()
            .and_then(|v| v.parse().ok()),
    };
    let max_desc = listing.max_desc_chars;

    let mut skills = Vec::new();
    let mut broken_links = Vec::new();
    for (dir, src) in [
        (
            ".claude/skills",
            SkillSource {
                source: "user",
                agent: "claude",
                listed: true,
            },
        ),
        (
            ".agents/skills",
            SkillSource {
                source: "agents",
                agent: "claude",
                listed: false,
            },
        ),
        (
            ".codex/skills",
            SkillSource {
                source: "codex",
                agent: "codex",
                listed: false,
            },
        ),
    ] {
        collect_skill_dir(
            home,
            &home.join(dir),
            &src,
            overrides,
            max_desc,
            &mut skills,
            &mut broken_links,
        );
    }

    let mut plugins = Vec::new();
    let installed = read_json(&home.join(".claude/plugins/installed_plugins.json"));
    if let Some(map) = installed.get("plugins").and_then(|v| v.as_object()) {
        let sorted: BTreeMap<_, _> = map.iter().collect();
        for (id, versions) in sorted {
            let first = versions.as_array().and_then(|a| a.first());
            let install_path = first
                .and_then(|v| v.get("installPath"))
                .and_then(|v| v.as_str())
                .map(PathBuf::from)
                .unwrap_or_default();
            let plugin_name = id.split('@').next().unwrap_or(id);
            let plugin_enabled = enabled
                .and_then(|e| e.get(id))
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let skill_names = names_in(&install_path.join("skills"), false);
            for s in &skill_names {
                let dir = install_path.join("skills").join(s);
                let front = skill_front(&dir.join("SKILL.md"));
                let name = format!("{plugin_name}:{s}");
                let state: String = if plugin_enabled { "on" } else { "off" }.into();
                skills.push(MapSkill {
                    listing_chars: listing_chars(&name, &front, &state, max_desc),
                    description: front.description.chars().take(300).collect(),
                    name,
                    agent: "claude".into(),
                    source: "plugin".into(),
                    group: id.clone(),
                    path: tilde(home, &dir),
                    link: None,
                    // `skillOverrides` does not apply to plugin skills: they follow the plugin.
                    state,
                });
            }
            plugins.push(MapPlugin {
                id: id.clone(),
                version: first
                    .and_then(|v| v.get("version"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
                enabled: plugin_enabled,
                skills: skill_names,
                commands: names_in(&install_path.join("commands"), true),
                agents: names_in(&install_path.join("agents"), true),
                has_hooks: install_path.join("hooks").exists(),
                has_mcp: install_path.join(".mcp.json").exists(),
                path: tilde(home, &install_path),
            });
        }
    }

    let mut mcp_servers = Vec::new();
    let claude_json = read_json(&home.join(".claude.json"));
    push_mcp(
        &mut mcp_servers,
        &claude_json["mcpServers"],
        "claude",
        "user",
        "~/.claude.json".into(),
    );
    if let Some(projects) = claude_json.get("projects").and_then(|v| v.as_object()) {
        for (proj, v) in projects {
            push_mcp(
                &mut mcp_servers,
                &v["mcpServers"],
                "claude",
                "project",
                tilde(home, Path::new(proj)),
            );
        }
    }
    push_mcp(
        &mut mcp_servers,
        &settings["mcpServers"],
        "claude",
        "settings",
        "~/.claude/settings.json".into(),
    );

    let mut hooks = Vec::new();
    if let Some(events) = settings.get("hooks").and_then(|v| v.as_object()) {
        for (event, entries) in events {
            for entry in entries.as_array().into_iter().flatten() {
                let matcher = entry["matcher"].as_str().unwrap_or("").to_string();
                for h in entry["hooks"].as_array().into_iter().flatten() {
                    let command = h["command"]
                        .as_str()
                        .or_else(|| h["type"].as_str())
                        .unwrap_or("")
                        .chars()
                        .take(140)
                        .collect();
                    hooks.push(MapHook {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        command,
                    });
                }
            }
        }
    }

    let mut memory_files = Vec::new();
    let mut dot_dirs = Vec::new();
    let mut mcp_files = Vec::new();
    let truncated = walk_home(home, &mut memory_files, &mut dot_dirs, &mut mcp_files);
    for f in &mcp_files {
        push_mcp(
            &mut mcp_servers,
            &read_json(f)["mcpServers"],
            "claude",
            "project-file",
            tilde(home, f),
        );
    }
    if let Ok(text) = std::fs::read_to_string(home.join(".codex/config.toml")) {
        codex_mcp(home, &text, &mut mcp_servers);
    }
    push_mcp(
        &mut mcp_servers,
        &read_json(&home.join(".gemini/settings.json"))["mcpServers"],
        "gemini",
        "user",
        "~/.gemini/settings.json".into(),
    );

    let mut stale_projects: Vec<String> = claude_json
        .get("projects")
        .and_then(|v| v.as_object())
        .map(|p| {
            p.keys()
                .filter(|k| !Path::new(k.as_str()).exists())
                .cloned()
                .collect()
        })
        .unwrap_or_default();
    stale_projects.sort();

    // Claude Code's documented default for `cleanupPeriodDays` is 30.
    let retention_days = settings["cleanupPeriodDays"].as_u64().unwrap_or(30);
    let usage = collect_usage(home, retention_days, history);

    ConfigMap {
        home: "~".into(),
        override_count: overrides.len(),
        skills,
        plugins,
        mcp_servers,
        hooks,
        memory_files,
        dot_dirs,
        truncated,
        usage,
        listing,
        broken_links,
        stale_projects,
    }
}

#[tauri::command]
pub async fn get_config_map() -> Result<ConfigMap, AppError> {
    let home = dirs::home_dir().ok_or_else(|| AppError::io("home directory not found"))?;
    let history = crate::core::central_repo::base_dir().join("config-map-usage.json");
    Ok(
        tauri::async_runtime::spawn_blocking(move || build_config_map(&home, Some(&history)))
            .await?,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn maps_skills_plugins_mcp_and_memory_without_env_values() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fs::create_dir_all(home.join(".claude/skills/alpha")).unwrap();
        fs::write(
            home.join(".claude/skills/alpha/SKILL.md"),
            "---\nname: alpha\ndescription: First skill\n---\nbody",
        )
        .unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"skillOverrides":{"alpha":"off","beta":"off"},"enabledPlugins":{"kit@m":true},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"echo hi"}]}]}}"#,
        )
        .unwrap();
        fs::write(
            home.join(".claude.json"),
            r#"{"mcpServers":{"srv":{"command":"x","env":{"API_TOKEN":"secret-value"}}}}"#,
        )
        .unwrap();
        let plugin = home.join(".claude/plugins/cache/kit");
        fs::create_dir_all(plugin.join("skills/beta")).unwrap();
        fs::write(
            plugin.join("skills/beta/SKILL.md"),
            "---\nname: beta\n---\n",
        )
        .unwrap();
        fs::write(
            home.join(".claude/plugins/installed_plugins.json"),
            format!(
                r#"{{"plugins":{{"kit@m":[{{"installPath":{},"version":"1"}}]}}}}"#,
                serde_json::to_string(&plugin.to_string_lossy()).unwrap()
            ),
        )
        .unwrap();
        fs::create_dir_all(home.join("proj/.claude")).unwrap();
        fs::write(home.join("proj/CLAUDE.md"), "# p").unwrap();
        fs::create_dir_all(home.join("node_modules/x")).unwrap();
        fs::write(home.join("node_modules/x/CLAUDE.md"), "ignored").unwrap();

        let map = build_config_map(home, None);
        assert_eq!(map.skills.len(), 2);
        assert_eq!(map.skills[0].state, "off");
        // Overrides do not reach plugin skills: they follow the enabled plugin.
        assert_eq!(map.skills[1].name, "kit:beta");
        assert_eq!(map.skills[1].state, "on");
        assert_eq!(map.skills[0].description, "First skill");
        assert_eq!(map.mcp_servers[0].env_keys, vec!["API_TOKEN".to_string()]);
        assert_eq!(map.hooks[0].command, "echo hi");
        assert!(map
            .memory_files
            .iter()
            .any(|m| m.path == "~/proj/CLAUDE.md"));
        assert!(!map
            .memory_files
            .iter()
            .any(|m| m.path.contains("node_modules")));
        assert!(map.dot_dirs.iter().any(|d| d.path == "~/proj/.claude"));
        let json = serde_json::to_string(&map).unwrap();
        assert_eq!(map.usage.sessions, 0);
        assert!(!json.contains("secret-value"));
    }

    #[test]
    fn counts_skill_mcp_and_slash_usage_from_transcripts() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let dir = home.join(".claude/projects/-proj");
        fs::create_dir_all(dir.join("sub/subagents")).unwrap();
        let lines = [
            r#"{"timestamp":"2026-01-02T00:00:00Z","message":{"content":[{"type":"tool_use","name":"Skill","input":{"skill":"alpha"}}]}}"#,
            r#"{"timestamp":"2026-01-05T00:00:00Z","message":{"content":[{"type":"tool_use","name":"mcp__notes__search","input":{}},{"type":"tool_use","name":"Skill","input":{"skill":"alpha"}}]}}"#,
            r#"{"type":"user","timestamp":"2026-01-01T00:00:00Z","message":{"content":"<command-name>/beta</command-name> secret text"}}"#,
            r#"{"type":"assistant","timestamp":"2026-01-06T00:00:00Z","message":{"content":[{"type":"text","text":"<command-name>/gamma</command-name>"}]}}"#,
            r#"{"type":"user","timestamp":"2026-01-06T00:00:00Z","message":{"content":"<command-name>/not a skill</command-name>"}}"#,
            r#"{"timestamp":"2026-01-03T00:00:00Z","message":{"content":"plain text, nothing to count"}}"#,
            "not json",
        ];
        fs::write(dir.join("a.jsonl"), lines.join("\n")).unwrap();
        fs::write(
            dir.join("sub/subagents/b.jsonl"),
            r#"{"timestamp":"2026-01-04T00:00:00Z","message":{"content":[{"type":"tool_use","name":"mcp__notes__read","input":{}}]}}"#,
        )
        .unwrap();

        let usage = collect_usage(home, 30, None);
        assert_eq!(usage.sessions, 2);
        assert_eq!(usage.skills["alpha"].count, 2);
        assert_eq!(usage.skills["alpha"].last_used, "2026-01-05T00:00:00Z");
        assert_eq!(usage.skills["beta"].count, 1);
        assert_eq!(usage.mcp["notes"].count, 2);
        assert!(!usage.skills.contains_key("gamma"));
        assert_eq!(usage.skills.len(), 2);
        assert_eq!(usage.since.as_deref(), Some("2026-01-01T00:00:00Z"));
        let json = serde_json::to_string(&usage).unwrap();
        assert!(!json.contains("secret text"));
        assert_eq!(usage.daily["2026-01-02"], 1);
        assert_eq!(usage.daily["2026-01-05"], 2);
    }

    #[test]
    fn history_survives_rescans_and_deleted_transcripts() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        let history = home.join("state/usage.json");
        let dir = home.join(".claude/projects/-proj");
        fs::create_dir_all(&dir).unwrap();
        let skill = |ts: &str| {
            format!(
                r#"{{"timestamp":"{ts}","message":{{"content":[{{"type":"tool_use","name":"Skill","input":{{"skill":"alpha"}}}}]}}}}"#
            )
        };
        fs::write(dir.join("old.jsonl"), skill("2026-01-01T00:00:00Z")).unwrap();
        fs::write(
            dir.join("new.jsonl"),
            format!(
                "{}\n{}",
                skill("2026-02-01T00:00:00Z"),
                r#"{"type":"user","timestamp":"2026-02-01T00:00:01Z","message":{"content":"<command-name>/beta</command-name> private words"}}"#
            ),
        )
        .unwrap();

        let first = collect_usage(home, 30, Some(&history));
        let second = collect_usage(home, 30, Some(&history));
        assert_eq!(first.skills["alpha"].count, 2);
        assert_eq!(
            second.skills["alpha"].count, 2,
            "a rescan must not add again"
        );

        // A live session grows: its entry is replaced, not added to.
        fs::write(
            dir.join("new.jsonl"),
            format!(
                "{}\n{}",
                skill("2026-02-01T00:00:00Z"),
                skill("2026-02-02T00:00:00Z")
            ),
        )
        .unwrap();
        let grown = collect_usage(home, 30, Some(&history));
        assert_eq!(grown.skills["alpha"].count, 3);

        // Claude Code deletes the old transcript: its counts stay in the history.
        fs::remove_file(dir.join("old.jsonl")).unwrap();
        let after = collect_usage(home, 30, Some(&history));
        assert_eq!(after.sessions, 1);
        assert_eq!(after.skills["alpha"].count, 3);
        assert_eq!(after.tracked_sessions, 2);
        assert_eq!(after.tracked_since.as_deref(), Some("2026-01-01T00:00:00Z"));
        assert_eq!(after.since.as_deref(), Some("2026-02-01T00:00:00Z"));
        assert!(!fs::read_to_string(&history)
            .unwrap()
            .contains("private words"));
    }

    #[test]
    fn listing_cost_follows_state_and_front_matter() {
        let tmp = tempfile::tempdir().unwrap();
        let md = tmp.path().join("SKILL.md");
        fs::write(
            &md,
            "---\nname: x\ndescription: >\n  Twelve chars\n  more\nwhen_to_use: \"abc\"\n---\nbody",
        )
        .unwrap();
        let front = skill_front(&md);
        assert_eq!(front.description, "Twelve chars more");
        assert_eq!(front.when_to_use, "abc");
        // name (1) + description (17) + space + when_to_use (3)
        assert_eq!(listing_chars("x", &front, "on", 1536), 22);
        assert_eq!(listing_chars("x", &front, "on", 5), 6);
        assert_eq!(listing_chars("x", &front, "name-only", 1536), 1);
        assert_eq!(listing_chars("x", &front, "user-invocable-only", 1536), 0);
        assert_eq!(listing_chars("x", &front, "off", 1536), 0);
        fs::write(
            &md,
            "---\ndescription: d\ndisable-model-invocation: true\n---\n",
        )
        .unwrap();
        assert_eq!(listing_chars("x", &skill_front(&md), "on", 1536), 0);
    }

    #[test]
    fn reads_codex_gemini_project_mcp_and_finds_stale_entries() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path();
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "model = \"x\"\n[mcp_servers.tasks]\ncommand = \"npx\"\nargs = [\"a\"]\n\n[mcp_servers.tasks.env]\nTOKEN = \"codex-secret\"\n\n[mcp_servers.\"web.search\"]\nurl = \"https://example.test\"\nenv = { KEY = \"v\", OTHER = \"w\" }\n\n[projects.\"/x\"]\ntrust_level = \"trusted\"\n",
        )
        .unwrap();
        fs::create_dir_all(home.join(".gemini")).unwrap();
        fs::write(
            home.join(".gemini/settings.json"),
            r#"{"mcpServers":{"gem":{"httpUrl":"https://example.test"}}}"#,
        )
        .unwrap();
        fs::create_dir_all(home.join("app")).unwrap();
        fs::write(
            home.join("app/.mcp.json"),
            r#"{"mcpServers":{"local":{"command":"x","env":{"PW":"file-secret"}}}}"#,
        )
        .unwrap();
        let gone = home.join("deleted-project");
        fs::write(
            home.join(".claude.json"),
            serde_json::json!({ "projects": { gone.to_string_lossy(): {}, home.join("app").to_string_lossy(): {} } })
                .to_string(),
        )
        .unwrap();
        fs::create_dir_all(home.join(".claude/skills")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(home.join("nowhere"), home.join(".claude/skills/dead")).unwrap();

        let map = build_config_map(home, None);
        let find = |n: &str| map.mcp_servers.iter().find(|m| m.name == n).unwrap();
        assert_eq!(find("tasks").agent, "codex");
        assert_eq!(find("tasks").transport, "stdio");
        assert_eq!(find("tasks").env_keys, vec!["TOKEN".to_string()]);
        assert_eq!(find("web.search").transport, "http");
        assert_eq!(
            find("web.search").env_keys,
            vec!["KEY".to_string(), "OTHER".to_string()]
        );
        assert_eq!(find("gem").agent, "gemini");
        assert_eq!(find("local").scope, "project-file");
        assert_eq!(find("local").defined_in, "~/app/.mcp.json");
        assert_eq!(map.stale_projects, vec![gone.to_string_lossy().to_string()]);
        #[cfg(unix)]
        assert_eq!(map.broken_links[0].path, "~/.claude/skills/dead");
        let json = serde_json::to_string(&map).unwrap();
        assert!(!json.contains("codex-secret") && !json.contains("file-secret"));
    }
}
