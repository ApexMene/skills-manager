//! The few writes the Config Map page can make to agent configuration:
//! changing `skillOverrides` in `~/.claude/settings.json` and dropping
//! `~/.claude.json` project entries whose folder no longer exists.
//!
//! Every write copies the file to a timestamped backup first, re-reads it just
//! before changing it, keeps every other key in its original order and text,
//! and replaces the file atomically (through a symlink, the target is written).

use serde::de::{Deserializer, MapAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use std::fmt;
use std::path::{Path, PathBuf};

use crate::core::error::AppError;

/// A JSON object whose keys keep their order and whose values keep their
/// original text. serde_json is built without `preserve_order` here, so a
/// plain `Value` would sort every key of the user's file.
#[derive(Debug, Default)]
struct OrderedObject(Vec<(String, Box<RawValue>)>);

impl<'de> Deserialize<'de> for OrderedObject {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct V;
        impl<'de> Visitor<'de> for V {
            type Value = OrderedObject;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut m: A) -> Result<OrderedObject, A::Error> {
                let mut out = Vec::new();
                while let Some((k, v)) = m.next_entry::<String, Box<RawValue>>()? {
                    out.push((k, v));
                }
                Ok(OrderedObject(out))
            }
        }
        d.deserialize_map(V)
    }
}

impl OrderedObject {
    fn parse(text: &str) -> Result<Self, AppError> {
        if text.trim().is_empty() {
            return Ok(Self::default());
        }
        serde_json::from_str(text).map_err(|e| AppError::io(format!("invalid JSON: {e}")))
    }

    fn get(&self, key: &str) -> Option<&RawValue> {
        self.0
            .iter()
            .find(|(k, _)| k == key)
            .map(|(_, v)| v.as_ref())
    }

    fn set(&mut self, key: &str, value: Box<RawValue>) {
        match self.0.iter_mut().find(|(k, _)| k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key.to_string(), value)),
        }
    }

    fn remove(&mut self, key: &str) -> bool {
        let before = self.0.len();
        self.0.retain(|(k, _)| k != key);
        self.0.len() != before
    }

    /// Pretty JSON with two-space indent, the format Claude Code writes, for
    /// an object sitting `depth` levels deep. Values are copied verbatim:
    /// untouched ones already carry their indentation from the original file.
    fn to_pretty(&self, depth: usize) -> Result<String, AppError> {
        if self.0.is_empty() {
            return Ok("{}".into());
        }
        let pad = "  ".repeat(depth);
        let mut lines = Vec::with_capacity(self.0.len());
        for (k, v) in &self.0 {
            let key = serde_json::to_string(k).map_err(|e| AppError::io(e.to_string()))?;
            lines.push(format!("{pad}  {key}: {}", v.get()));
        }
        Ok(format!("{{\n{}\n{pad}}}", lines.join(",\n")))
    }

    fn child(&self, key: &str) -> Result<OrderedObject, AppError> {
        match self.get(key) {
            Some(v) => OrderedObject::parse(v.get()),
            None => Ok(OrderedObject::default()),
        }
    }

    fn set_child(&mut self, key: &str, child: &OrderedObject) -> Result<(), AppError> {
        let text = child.to_pretty(1)?;
        let raw = RawValue::from_string(text).map_err(|e| AppError::io(e.to_string()))?;
        self.set(key, raw);
        Ok(())
    }
}

fn raw_string(s: &str) -> Result<Box<RawValue>, AppError> {
    RawValue::from_string(serde_json::to_string(s).map_err(|e| AppError::io(e.to_string()))?)
        .map_err(|e| AppError::io(e.to_string()))
}

/// Resolves a symlinked config file to the file it points at, so the link
/// itself is never replaced by a regular file.
fn real_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Copies `path` into `backup_dir` (created on demand) and returns the copy.
fn backup(path: &Path, backup_dir: &Path) -> Result<Option<PathBuf>, AppError> {
    if !path.exists() {
        return Ok(None);
    }
    std::fs::create_dir_all(backup_dir)?;
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "config.json".into());
    let dest = backup_dir.join(name);
    std::fs::copy(path, &dest)?;
    Ok(Some(dest))
}

/// Writes through a temp file in the same folder, keeps the original
/// permissions (`~/.claude.json` is private), then renames over the file.
fn write_atomic(path: &Path, text: &str) -> Result<(), AppError> {
    let dir = path.parent().unwrap_or(Path::new("."));
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join(format!(
        ".{}.config-map.tmp",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    std::fs::write(&tmp, text)?;
    if let Ok(meta) = std::fs::metadata(path) {
        std::fs::set_permissions(&tmp, meta.permissions())?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

fn with_newline(original: &str, mut text: String) -> String {
    if original.ends_with('\n') || original.is_empty() {
        text.push('\n');
    }
    text
}

#[derive(Debug, Deserialize)]
pub struct SkillStateChange {
    pub name: String,
    /// "on" removes the override (absent means on); anything else is written.
    pub state: String,
}

const STATES: &[&str] = &["on", "name-only", "user-invocable-only", "off"];

/// Applies `changes` to `skillOverrides` in `settings`, after a backup.
pub fn set_skill_states(
    settings: &Path,
    backup_dir: &Path,
    changes: &[SkillStateChange],
) -> Result<Option<PathBuf>, AppError> {
    if let Some(bad) = changes.iter().find(|c| !STATES.contains(&c.state.as_str())) {
        return Err(AppError::io(format!("unknown skill state: {}", bad.state)));
    }
    let path = real_path(settings);
    let original = std::fs::read_to_string(&path).unwrap_or_default();
    let mut root = OrderedObject::parse(&original)?;
    let mut overrides = root.child("skillOverrides")?;
    for c in changes {
        if c.state == "on" {
            overrides.remove(&c.name);
        } else {
            overrides.set(&c.name, raw_string(&c.state)?);
        }
    }
    let copy = backup(&path, backup_dir)?;
    if overrides.0.is_empty() {
        root.remove("skillOverrides");
    } else {
        root.set_child("skillOverrides", &overrides)?;
    }
    write_atomic(&path, &with_newline(&original, root.to_pretty(0)?))?;
    Ok(copy)
}

/// Drops `projects` entries from `claude_json`, only those whose folder is
/// still missing at the moment of writing. Returns the backup and the entries
/// actually removed.
pub fn remove_stale_projects(
    claude_json: &Path,
    backup_dir: &Path,
    projects: &[String],
) -> Result<(Option<PathBuf>, Vec<String>), AppError> {
    let path = real_path(claude_json);
    // Claude Code rewrites this file often: read it as late as possible.
    let original = std::fs::read_to_string(&path)?;
    let mut root = OrderedObject::parse(&original)?;
    let mut entries = root.child("projects")?;
    let removed: Vec<String> = projects
        .iter()
        .filter(|p| !Path::new(p.as_str()).exists())
        .filter(|p| entries.remove(p))
        .cloned()
        .collect();
    if removed.is_empty() {
        return Ok((None, removed));
    }
    let copy = backup(&path, backup_dir)?;
    root.set_child("projects", &entries)?;
    write_atomic(&path, &with_newline(&original, root.to_pretty(0)?))?;
    Ok((copy, removed))
}

fn backup_dir() -> PathBuf {
    let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    crate::core::central_repo::base_dir()
        .join("config-map-backups")
        .join(stamp.to_string())
}

fn home() -> Result<PathBuf, AppError> {
    dirs::home_dir().ok_or_else(|| AppError::io("home directory not found"))
}

#[derive(Debug, Serialize)]
pub struct EditResult {
    /// Where the previous version was copied, when there was one.
    pub backup: Option<String>,
    pub changed: Vec<String>,
}

#[tauri::command]
pub async fn config_map_set_skill_states(
    changes: Vec<SkillStateChange>,
) -> Result<EditResult, AppError> {
    let settings = home()?.join(".claude/settings.json");
    let changed = changes.iter().map(|c| c.name.clone()).collect();
    let copy = tauri::async_runtime::spawn_blocking(move || {
        set_skill_states(&settings, &backup_dir(), &changes)
    })
    .await??;
    Ok(EditResult {
        backup: copy.map(|p| p.to_string_lossy().to_string()),
        changed,
    })
}

#[tauri::command]
pub async fn config_map_remove_stale_projects(
    projects: Vec<String>,
) -> Result<EditResult, AppError> {
    let file = home()?.join(".claude.json");
    let (copy, changed) = tauri::async_runtime::spawn_blocking(move || {
        remove_stale_projects(&file, &backup_dir(), &projects)
    })
    .await??;
    Ok(EditResult {
        backup: copy.map(|p| p.to_string_lossy().to_string()),
        changed,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    const SETTINGS: &str = r#"{
  "zeta": 1,
  "skillOverrides": {
    "keep": "off",
    "drop": "off"
  },
  "alpha": {
    "nested": [1, 2],
    "b": true
  }
}
"#;

    #[test]
    fn changes_only_skill_overrides_and_keeps_order_and_text() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = tmp.path().join("settings.json");
        fs::write(&settings, SETTINGS).unwrap();
        let backups = tmp.path().join("backups");
        let copy = set_skill_states(
            &settings,
            &backups,
            &[
                SkillStateChange {
                    name: "drop".into(),
                    state: "on".into(),
                },
                SkillStateChange {
                    name: "new".into(),
                    state: "name-only".into(),
                },
            ],
        )
        .unwrap()
        .unwrap();
        assert_eq!(fs::read_to_string(copy).unwrap(), SETTINGS);
        let out = fs::read_to_string(&settings).unwrap();
        assert_eq!(
            out,
            "{\n  \"zeta\": 1,\n  \"skillOverrides\": {\n    \"keep\": \"off\",\n    \"new\": \"name-only\"\n  },\n  \"alpha\": {\n    \"nested\": [1, 2],\n    \"b\": true\n  }\n}\n"
        );
    }

    #[test]
    fn rejects_unknown_states_and_creates_missing_settings() {
        let tmp = tempfile::tempdir().unwrap();
        let settings = tmp.path().join("settings.json");
        let bad = set_skill_states(
            &settings,
            tmp.path(),
            &[SkillStateChange {
                name: "x".into(),
                state: "maybe".into(),
            }],
        );
        assert!(bad.is_err());
        assert!(!settings.exists());
        let copy = set_skill_states(
            &settings,
            tmp.path(),
            &[SkillStateChange {
                name: "x".into(),
                state: "off".into(),
            }],
        )
        .unwrap();
        assert!(copy.is_none());
        let v: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings).unwrap()).unwrap();
        assert_eq!(v["skillOverrides"]["x"], "off");
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_symlinks_and_keeps_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let real = tmp.path().join("vault/settings.json");
        fs::create_dir_all(real.parent().unwrap()).unwrap();
        fs::write(&real, "{}").unwrap();
        fs::set_permissions(&real, fs::Permissions::from_mode(0o600)).unwrap();
        let link = tmp.path().join("settings.json");
        std::os::unix::fs::symlink(&real, &link).unwrap();
        set_skill_states(
            &link,
            &tmp.path().join("b"),
            &[SkillStateChange {
                name: "x".into(),
                state: "off".into(),
            }],
        )
        .unwrap();
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(fs::read_to_string(&real)
            .unwrap()
            .contains("\"x\": \"off\""));
        assert_eq!(
            fs::metadata(&real).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn removes_only_projects_that_are_still_missing() {
        let tmp = tempfile::tempdir().unwrap();
        let alive = tmp.path().join("alive");
        fs::create_dir_all(&alive).unwrap();
        let gone = tmp.path().join("gone").to_string_lossy().to_string();
        let alive = alive.to_string_lossy().to_string();
        let file = tmp.path().join(".claude.json");
        let text = format!(
            "{{\n  \"numStartups\": 3,\n  \"projects\": {{\n    {}: {{\n      \"x\": 1\n    }},\n    {}: {{}}\n  }},\n  \"after\": true\n}}",
            serde_json::to_string(&gone).unwrap(),
            serde_json::to_string(&alive).unwrap()
        );
        fs::write(&file, &text).unwrap();
        let (copy, removed) =
            remove_stale_projects(&file, &tmp.path().join("b"), &[gone.clone(), alive.clone()])
                .unwrap();
        assert_eq!(removed, vec![gone.clone()]);
        assert_eq!(fs::read_to_string(copy.unwrap()).unwrap(), text);
        let out = fs::read_to_string(&file).unwrap();
        assert_eq!(
            out,
            format!(
                "{{\n  \"numStartups\": 3,\n  \"projects\": {{\n    {}: {{}}\n  }},\n  \"after\": true\n}}",
                serde_json::to_string(&alive).unwrap()
            )
        );
        // Nothing left to remove: no backup, no write.
        let (copy, removed) = remove_stale_projects(&file, &tmp.path().join("c"), &[gone]).unwrap();
        assert!(copy.is_none() && removed.is_empty());
    }
}
