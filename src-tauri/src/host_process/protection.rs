//! Read-only host controls and private approval state for a protected worker.
//! Ordinary workspace and runtime-state writes retain the user's access.
use serde::Deserialize;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProcessProtection {
    pub read_only_paths: Vec<PathBuf>,
    pub hidden_paths: Vec<PathBuf>,
}
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
impl ProcessProtection {
    pub(crate) fn profile(&self, controls: &[PathBuf]) -> Result<String, String> {
        let paths = self
            .read_only_paths
            .iter()
            .chain(&self.hidden_paths)
            .chain(controls);
        let mut roots = BTreeSet::new();
        let mut ancestors = BTreeSet::new();
        if self.read_only_paths.len() + self.hidden_paths.len() > 128 {
            return Err("Too many protection paths".into());
        }
        for path in paths {
            if !path.is_absolute() || path.as_os_str().len() > 4096 {
                return Err("Protection paths must be absolute".into());
            }
            let original = path.clone();
            let path = path
                .canonicalize()
                .map_err(|_| "Protection path is unavailable")?;
            for parent in path.ancestors().skip(1).filter(|p| *p != Path::new("/")) {
                ancestors.insert(parent.to_path_buf());
            }
            for parent in original
                .ancestors()
                .skip(1)
                .filter(|p| *p != Path::new("/"))
            {
                ancestors.insert(parent.to_path_buf());
            }
            roots.insert(original);
            roots.insert(path);
        }
        let quote = |p: &Path| {
            serde_json::to_string(p.to_str().ok_or("Invalid protection path")?)
                .map_err(|_| "Invalid protection path")
        };
        let mut writes = Vec::new();
        for path in roots {
            writes.push(format!("(subpath {})", quote(&path)?));
        }
        for path in ancestors {
            writes.push(format!("(literal {})", quote(&path)?));
        }
        let mut reads = Vec::new();
        for path in &self.hidden_paths {
            reads.push(format!(
                "(subpath {})",
                quote(
                    &path
                        .canonicalize()
                        .map_err(|_| "Private storage is unavailable")?
                )?
            ));
        }
        Ok(format!("(version 1)\n(allow default)\n(deny appleevent-send)\n(deny mach-lookup (global-name \"com.apple.coreservices.appleevents\"))\n(deny file-write* {})\n{}", writes.join(" "),
            if reads.is_empty() { String::new() } else { format!("(deny file-read* {})\n", reads.join(" ")) }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_relative_missing_and_excessive_paths() {
        let mut protection = ProcessProtection {
            read_only_paths: vec![PathBuf::from("relative")],
            hidden_paths: vec![],
        };
        assert!(protection.profile(&[]).is_err());
        protection.read_only_paths = vec![PathBuf::from("/path-that-does-not-exist-buzz-security")];
        assert!(protection.profile(&[]).is_err());
        protection.read_only_paths = vec![std::env::temp_dir(); 129];
        assert!(protection.profile(&[]).is_err());
    }
    #[test]
    #[cfg(target_os = "macos")]
    fn kernel_denies_control_writes_and_private_reads_while_workspace_remains_writable() {
        let dir = tempfile::tempdir().unwrap();
        let controls = dir.path().join("controls");
        let private = dir.path().join("private");
        let workspace = dir.path().join("workspace");
        for path in [&controls, &private, &workspace] {
            std::fs::create_dir(path).unwrap();
        }
        let secret = private.join("decision");
        std::fs::write(&secret, "private").unwrap();
        let profile = ProcessProtection {
            read_only_paths: vec![],
            hidden_paths: vec![private],
        }
        .profile(std::slice::from_ref(&controls))
        .unwrap();
        let run = |script: &str, path: &Path| {
            std::process::Command::new("/usr/bin/sandbox-exec")
                .args(["-p", &profile, "/bin/sh", "-c", script, "sandbox-test"])
                .arg(path)
                .output()
                .unwrap()
        };
        assert!(run("printf allowed > \"$1\"", &workspace.join("note"))
            .status
            .success());
        assert!(!run("printf denied > \"$1\"", &controls.join("policy"))
            .status
            .success());
        let denied = run("cat \"$1\"", &secret);
        assert!(!denied.status.success());
        assert!(denied.stdout.is_empty());
        assert_eq!(std::fs::read_to_string(secret).unwrap(), "private");
        assert_eq!(
            std::fs::read_to_string(workspace.join("note")).unwrap(),
            "allowed"
        );
    }
}
