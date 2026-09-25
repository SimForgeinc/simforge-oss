//! `path.resolve`: absolute, lexically normalised (`.` dropped, `..` applied),
//! symlinks untouched, so a reported path is the one the user meant.

use std::path::{Component, Path, PathBuf};

pub fn resolve(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|cwd| cwd.join(path))
            .unwrap_or_else(|_| path.to_path_buf())
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// `path.join(...parts)` (POSIX): joined with `/` and normalised lexically
/// (`.` dropped, `..` applied, repeated separators collapsed), relative stays
/// relative. The string a TS command printed for a path it built.
pub fn join(parts: &[&str]) -> String {
    let joined = parts
        .iter()
        .filter(|p| !p.is_empty())
        .copied()
        .collect::<Vec<_>>()
        .join("/");
    normalize(&joined)
}

/// `path.normalize` (POSIX) without the trailing-separator rule.
pub fn normalize(path: &str) -> String {
    if path.is_empty() {
        return ".".to_owned();
    }
    let absolute = path.starts_with('/');
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                if matches!(out.last(), Some(last) if *last != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            other => out.push(other),
        }
    }
    let body = out.join("/");
    match (absolute, body.is_empty()) {
        (true, _) => format!("/{body}"),
        (false, true) => ".".to_owned(),
        (false, false) => body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_like_node() {
        assert_eq!(join(&["./out/", "m", "s", "draw-000.result.json"]), "out/m/s/draw-000.result.json");
        assert_eq!(join(&["/a//b", "../c"]), "/a/c");
        assert_eq!(join(&["..", "x"]), "../x");
        assert_eq!(join(&["out", ".."]), ".");
    }

    #[test]
    fn normalises_like_node() {
        assert_eq!(resolve(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
        assert_eq!(resolve(Path::new("/../x")), PathBuf::from("/x"));
    }
}
