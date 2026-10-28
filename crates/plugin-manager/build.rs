use std::path::{Path, PathBuf};

#[path = "../build_env.rs"]
mod build_env;

const BUILDERLAB_URL_KEY: &str = "BUZZ_BUILDERLAB_URL";
const BUILDERLAB_TENANTS_KEY: &str = "BUZZ_BUILDERLAB_TENANTS";
const KEYS: [&str; 2] = [BUILDERLAB_URL_KEY, BUILDERLAB_TENANTS_KEY];
/// `Manifest::validate` refuses more than 16 network origins; one is kept for
/// the build URL's Apps Platform control plane (`apps_control_plane`).
const MAX_ORIGINS: usize = 15;

fn secure_origin(raw: &str, error: &'static str) -> Result<url::Url, &'static str> {
    let url = url::Url::parse(raw).map_err(|_| error)?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(error);
    }
    Ok(url)
}

/// `BUZZ_BUILDERLAB_URL`'s origin, or empty when unconfigured.
fn builderlab_origin(raw: &str) -> Result<String, &'static str> {
    if raw.is_empty() {
        return Ok(String::new());
    }
    let url = secure_origin(
        raw,
        "Builderlab build URL must use HTTPS without credentials, query, or fragment",
    )?;
    Ok(url.origin().ascii_serialization())
}

fn valid_hostname(host: &str) -> bool {
    !host.is_empty()
        && host.len() <= 253
        && host.split('.').all(|label| {
            !label.is_empty()
                && label.len() <= 63
                && !label.starts_with('-')
                && !label.ends_with('-')
                && label
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        })
}

/// The distinct login origins of the `BUZZ_BUILDERLAB_TENANTS` rows, in order.
/// Rows follow the frontend parser's rules (`src/features/identity/builderlab-tenants.ts`):
/// `{relayHost, self?, loginOrigin}`, a lowercase hostname, an optional 64-hex
/// relay key, and a login origin that is exactly its own canonical https origin.
fn tenant_origins(raw: &str) -> Result<Vec<String>, &'static str> {
    const ERROR: &str = "Builderlab tenant table must be a JSON array of {relayHost, self?, loginOrigin} rows with unique hostnames, unique 64-hex relay keys and canonical HTTPS login origins";
    if raw.trim().is_empty() {
        return Ok(vec![]);
    }
    let rows: serde_json::Value = serde_json::from_str(raw).map_err(|_| ERROR)?;
    let rows = rows.as_array().ok_or(ERROR)?;
    let mut hosts = std::collections::HashSet::new();
    let mut keys = std::collections::HashSet::new();
    let mut origins = Vec::new();
    for row in rows {
        let row = row.as_object().ok_or(ERROR)?;
        if !row
            .keys()
            .all(|key| matches!(key.as_str(), "relayHost" | "self" | "loginOrigin"))
        {
            return Err(ERROR);
        }
        let host = row.get("relayHost").and_then(|v| v.as_str()).ok_or(ERROR)?;
        let host = host.trim().to_ascii_lowercase();
        let host = host.strip_suffix('.').unwrap_or(&host);
        if !valid_hostname(host) || !hosts.insert(host.to_owned()) {
            return Err(ERROR);
        }
        if let Some(key) = row.get("self") {
            let key = key.as_str().ok_or(ERROR)?;
            if key.len() != 64
                || !key
                    .bytes()
                    .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
                || !keys.insert(key.to_owned())
            {
                return Err(ERROR);
            }
        }
        let login = row
            .get("loginOrigin")
            .and_then(|v| v.as_str())
            .ok_or(ERROR)?;
        let origin = secure_origin(login, ERROR)?.origin().ascii_serialization();
        if origin != login {
            return Err(ERROR);
        }
        if !origins.contains(&origin) {
            origins.push(origin);
        }
    }
    Ok(origins)
}

/// Every origin the bundled Builderlab plugin may reach: the build URL's, then
/// each tenant login origin, deduplicated and comma-joined for `env!`.
fn builderlab_origins(
    local: &Path,
    process: impl Fn(&str) -> Option<String>,
) -> Result<(String, String), &'static str> {
    let values = build_env::load(local, &KEYS, process)?;
    let get = |key: &str| values.get(key).map(String::as_str).unwrap_or("");
    let origin = builderlab_origin(get(BUILDERLAB_URL_KEY))?;
    let mut origins: Vec<String> = if origin.is_empty() {
        vec![]
    } else {
        vec![origin.clone()]
    };
    for tenant in tenant_origins(get(BUILDERLAB_TENANTS_KEY))? {
        if !origins.contains(&tenant) {
            origins.push(tenant);
        }
    }
    if origins.len() > MAX_ORIGINS {
        return Err("Too many Builderlab login origins");
    }
    Ok((origin, origins.join(",")))
}

#[cfg_attr(test, allow(dead_code))]
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    let local = root.join(".env.local");
    println!("cargo:rerun-if-changed={}", local.display());
    for key in KEYS {
        println!("cargo:rerun-if-env-changed={key}");
    }
    println!(
        "cargo:rerun-if-changed={}",
        root.join("crates/build_env.rs").display()
    );
    let process = |key: &str| match std::env::var(key) {
        Ok(value) => Some(value),
        Err(std::env::VarError::NotPresent) => None,
        Err(std::env::VarError::NotUnicode(_)) => panic!("Native build inputs must be UTF-8"),
    };
    let (origin, origins) =
        builderlab_origins(&local, process).expect("Invalid Builderlab build configuration");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGIN={origin}");
    println!("cargo:rustc-env=BUZZ_BUILDERLAB_ORIGINS={origins}");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_url(local: &Path, url: Option<&str>) -> Result<String, &'static str> {
        let url = url.map(str::to_owned);
        builderlab_origins(local, |key| {
            (key == BUILDERLAB_URL_KEY).then(|| url.clone()).flatten()
        })
        .map(|(origin, _)| origin)
    }

    #[test]
    fn local_url_and_process_overrides_produce_an_exact_origin() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        assert_eq!(with_url(&local, None).unwrap(), "");
        std::fs::write(
            &local,
            "\u{feff}export BUZZ_BUILDERLAB_URL=\"https://APP.BUILDERLAB.XYZ:443/deployment/\" # comment\n",
        )
        .unwrap();
        assert_eq!(
            with_url(&local, None).unwrap(),
            "https://app.builderlab.xyz"
        );
        assert_eq!(
            with_url(&local, Some("https://login.example:8443/path/")).unwrap(),
            "https://login.example:8443"
        );
        assert_eq!(with_url(&local, Some("")).unwrap(), "");
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
            let error = with_url(&local, Some(configured)).unwrap_err();
            assert!(!error.contains(configured));
        }
        std::fs::write(&local, "BUZZ_BUILDERLAB_URL='unterminated").unwrap();
        assert_eq!(
            with_url(&local, None).unwrap_err(),
            "Invalid native build .env.local"
        );
        // Explicit process input also overrides malformed same-key assignments.
        assert_eq!(with_url(&local, Some("")).unwrap(), "");
    }

    #[test]
    fn unrelated_syntax_is_ignored_without_promoting_multiline_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        std::fs::write(&local, "PRIVATE_VALUE='unterminated").unwrap();
        assert_eq!(with_url(&local, None).unwrap(), "");

        for quote in ["'", "\"", "`"] {
            std::fs::write(
                &local,
                format!(
                    "PRIVATE_VALUE={quote}multiline\nBUZZ_BUILDERLAB_URL=https://hidden.example\n{quote}\nINVALID=unquoted value\nexport BUZZ_BUILDERLAB_URL=https://app.builderlab.xyz/\nTRAILING='unfinished\n"
                ),
            )
            .unwrap();
            assert_eq!(
                with_url(&local, None).unwrap(),
                "https://app.builderlab.xyz"
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
            assert_eq!(with_url(&local, None).unwrap(), "");
        }
    }

    const TENANTS: &str = r#"[
      {"relayHost":"communities.buzz.xyz","self":"12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3","loginOrigin":"https://app.builderlab.xyz"},
      {"relayHost":"block.builderlab.xyz","self":"76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01","loginOrigin":"https://block.builderlab.xyz"},
      {"relayHost":"test.blockstaging.build","self":"f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1","loginOrigin":"https://test.blockstaging.build"}
    ]"#;

    #[test]
    fn tenant_table_widens_the_grant_to_every_distinct_login_origin() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        let inputs = |url: &str, tenants: &str| {
            let (url, tenants) = (url.to_owned(), tenants.to_owned());
            builderlab_origins(&local, move |key| {
                Some(if key == BUILDERLAB_URL_KEY {
                    url.clone()
                } else {
                    tenants.clone()
                })
            })
        };
        assert_eq!(
            inputs("https://app.builderlab.xyz/", TENANTS).unwrap(),
            (
                "https://app.builderlab.xyz".to_owned(),
                "https://app.builderlab.xyz,https://block.builderlab.xyz,https://test.blockstaging.build".to_owned()
            )
        );
        // Without the build URL the tenants alone are granted; without rows nothing changes.
        assert_eq!(
            inputs(
                "",
                r#"[{"relayHost":"Relay.Example.","loginOrigin":"https://login.example"}]"#
            )
            .unwrap(),
            (String::new(), "https://login.example".to_owned())
        );
        assert_eq!(inputs("", " ").unwrap(), (String::new(), String::new()));
        // The file supplies the table when the process does not.
        std::fs::write(
            &local,
            format!("BUZZ_BUILDERLAB_TENANTS='{}'\n", TENANTS.replace('\n', "")),
        )
        .unwrap();
        let (_, origins) = builderlab_origins(&local, |_| None).unwrap();
        assert_eq!(
            origins,
            "https://app.builderlab.xyz,https://block.builderlab.xyz,https://test.blockstaging.build"
        );
    }

    #[test]
    fn malformed_tenant_rows_fail_without_echoing_their_contents() {
        let directory = tempfile::tempdir().unwrap();
        let local = directory.path().join(".env.local");
        for tenants in [
            "{",
            r#"{"relayHost":"a.example","loginOrigin":"https://a.example"}"#,
            r#"[{"relayHost":"a.example","loginOrigin":"http://secret.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://user:secret@a.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example/path"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example:443"}]"#,
            r#"[{"relayHost":"https://a.example","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"*.a.example","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example:8443","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example","self":"ABCD","loginOrigin":"https://a.example"}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example","extra":1}]"#,
            r#"[{"relayHost":"a.example","loginOrigin":"https://a.example"},{"relayHost":"A.example","loginOrigin":"https://b.example"}]"#,
        ] {
            let error = builderlab_origins(&local, |key| {
                (key == BUILDERLAB_TENANTS_KEY).then(|| tenants.to_owned())
            })
            .unwrap_err();
            assert!(!error.contains("secret"), "{error}");
            assert!(!error.contains("a.example"), "{error}");
        }
    }
}
