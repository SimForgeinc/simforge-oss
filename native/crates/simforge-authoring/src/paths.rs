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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_like_node() {
        assert_eq!(resolve(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
        assert_eq!(resolve(Path::new("/../x")), PathBuf::from("/x"));
    }
}
