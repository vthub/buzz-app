use std::path::{Path, PathBuf};

#[path = "../build_env.rs"]
mod build_env;

const BUILDERLAB_URL_KEY: &str = "BUZZ_BUILDERLAB_URL";
const BUILDERLAB_API_BASE_PATH_KEY: &str = "BUZZ_BUILDERLAB_API_BASE_PATH";

fn builderlab_target(
    local: &Path,
    process: Option<String>,
) -> Result<(String, String), &'static str> {
    let values = build_env::load(local, &[BUILDERLAB_URL_KEY], |_| process.clone())?;
    let raw = values
        .get(BUILDERLAB_URL_KEY)
        .map(String::as_str)
        .unwrap_or("");
    if raw.is_empty() {
        return Ok((String::new(), String::new()));
    }
    let url = url::Url::parse(raw).map_err(|_| "Invalid Builderlab build URL")?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Builderlab build URL must use HTTPS without credentials, query, or fragment");
    }
    // Native backup handoff trusts Builderlab credentials only for this API path.
    let api_base_path = format!("{}/api/goose/", url.path().trim_end_matches('/'));
    Ok((url.origin().ascii_serialization(), api_base_path))
}

#[cfg_attr(test, allow(dead_code))]
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let local = root.join(".env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    println!("cargo:rerun-if-env-changed={BUILDERLAB_URL_KEY}");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/build_env.rs").display()
    );
    let process = match std::env::var(BUILDERLAB_URL_KEY) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    };
    let (origin, api_base_path) =
        builderlab_target(&local, process).expect("Invalid Builderlab build configuration");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGIN={origin}");
    println!("cargo:rustc-env={BUILDERLAB_API_BASE_PATH_KEY}={api_base_path}");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_url_and_process_overrides_produce_an_exact_origin_and_api_path() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (String::new(), String::new())
        );
        std::fs::write(
            &local,
            "\u{feff}export BUZZ_BUILDERLAB_URL=\"https://APP.BUILDERLAB.XYZ:443/deployment/\" # comment\n",
        )
        .unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (
                "https://app.builderlab.xyz".into(),
                "/deployment/api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some("https://login.example:8443/path/".into())).unwrap(),
            (
                "https://login.example:8443".into(),
                "/path/api/goose/".into()
            )
        );
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn invalid_configuration_fails_without_echoing_its_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        for configured in [
            "http://localhost:4318",
            "https://user:secret@login.example",
            "https://login.example?",
            "https://login.example#",
            "invalid",
        ] {
            let error = builderlab_target(&local, Some(configured.into())).unwrap_err();
            assert!(!error.contains(configured));
        }
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap_err(),
            "Invalid native build .env.local"
        );
        // Explicit process input also overrides malformed same-key assignments.
        assert_eq!(
            builderlab_target(&local, Some(String::new())).unwrap(),
            (String::new(), String::new())
        );
    }

    #[test]
    fn unrelated_syntax_is_ignored_without_promoting_multiline_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        std::fs::write(&local, "PRIVATE_VALUE='unterminated").unwrap();
        assert_eq!(
            builderlab_target(&local, None).unwrap(),
            (String::new(), String::new())
        );

        for quote in ["'", "\"", "`"] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}multiline\nBUZZ_BUILDERLAB_URL=https://hidden.example\n{quote}\nINVALID=unquoted value\nexport BUZZ_BUILDERLAB_URL=https://app.builderlab.xyz/\nTRAILING='unfinished\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                ("https://app.builderlab.xyz".into(), "/api/goose/".into())
            );
        }
        for quote in ["'", "\""] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}unfinished\nBUZZ_BUILDERLAB_URL=https://hidden.example\n"
                ),
            )
            .unwrap();
            assert_eq!(
                builderlab_target(&local, None).unwrap(),
                (String::new(), String::new())
            );
        }
    }
}
