//! Nonsecret, native-authoritative deployment descriptor. Also compiled by build.rs.
use serde::{Deserialize, Serialize};
use url::{Host, Url};

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Config {
    pub(crate) version: u8,
    pub(crate) id: String,
    pub(crate) identity_origin: String,
    pub(crate) community_hosts: Vec<String>,
    pub(crate) adapter_base: String,
    pub(crate) api_base_path: String,
}

const INVALID: &str = "Invalid BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG";

impl Config {
    pub(crate) fn parse(raw: &str) -> Result<Self, String> {
        if raw.len() > 8192 {
            return Err(INVALID.into());
        }
        let mut config: Self = serde_json::from_str(raw).map_err(|_| INVALID)?;
        if config.version != 1
            || config.id.is_empty()
            || config.id.len() > 64
            || !config
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
            || config.community_hosts.len() > 128
        {
            return Err(INVALID.into());
        }
        let origin = secure_url(&config.identity_origin)?;
        if origin.path() != "/" {
            return Err(INVALID.into());
        }
        let base = secure_url(&config.adapter_base)?;
        if base.origin() != origin.origin()
            || !canonical_path(base.path())
            || !canonical_path(&config.api_base_path)
            || !config.api_base_path.ends_with('/')
        {
            return Err(INVALID.into());
        }
        config.identity_origin = origin.origin().ascii_serialization();
        config.adapter_base = base.as_str().trim_end_matches('/').to_owned();
        let mut hosts = Vec::new();
        for entry in &config.community_hosts {
            let (wildcard, host) = entry
                .strip_prefix("*.")
                .map_or((false, entry.as_str()), |host| (true, host));
            if host.is_empty() || host.contains(['*', '/', '@', '?', '#', '\\', '%']) {
                return Err(INVALID.into());
            }
            let url = secure_url(&format!("https://{host}"))?;
            if wildcard && (!matches!(url.host(), Some(Host::Domain(_))) || url.port().is_some()) {
                return Err(INVALID.into());
            }
            let authority = url.origin().ascii_serialization()[8..].to_owned();
            let normalized = if wildcard {
                format!("*.{authority}")
            } else {
                authority
            };
            if hosts.contains(&normalized) {
                return Err(INVALID.into());
            }
            hosts.push(normalized);
        }
        config.community_hosts = hosts;
        Ok(config)
    }

    pub(crate) fn endpoint(&self, suffix: &str) -> Url {
        // Only module-owned fixed suffixes reach this method; a leading slash
        // must append to, rather than replace, the deployment's adapter prefix.
        Url::parse(&format!("{}{suffix}", self.adapter_base)).expect("validated adapter endpoint")
    }

    pub(crate) fn matches_relay(&self, relay: &str) -> Result<bool, String> {
        let relay = Url::parse(&canonical_relay(relay)?).map_err(|_| INVALID)?;
        let authority = relay.origin().ascii_serialization()[6..].to_owned();
        Ok(self.community_hosts.iter().any(|entry| {
            if let Some(suffix) = entry.strip_prefix("*.") {
                relay.port().is_none()
                    && relay.host_str().is_some_and(|host| {
                        host.strip_suffix(suffix)
                            .and_then(|prefix| prefix.strip_suffix('.'))
                            .is_some_and(|label| !label.is_empty() && !label.contains('.'))
                    })
            } else {
                *entry == authority
            }
        }))
    }
}

fn secure_url(raw: &str) -> Result<Url, String> {
    if raw.len() > 2048
        || raw.chars().any(|c| c.is_whitespace() || c == '\\')
        || raw.contains('%')
        || raw.contains('@')
    {
        return Err(INVALID.into());
    }
    let url = Url::parse(raw).map_err(|_| INVALID)?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.host_str().is_some_and(|host| host.ends_with('.'))
        || !canonical_path(url.path())
    {
        return Err(INVALID.into());
    }
    // The URL parser resolves dot segments; reject them before parsing too.
    if raw.split('/').any(|segment| matches!(segment, "." | "..")) {
        return Err(INVALID.into());
    }
    Ok(url)
}

pub(crate) fn canonical_path(path: &str) -> bool {
    path.starts_with('/')
        && !path.starts_with("//")
        && !path.contains("//")
        && !path.contains(['\\', '%', '?', '#'])
        && !path.chars().any(|c| c.is_whitespace() || c.is_control())
        && !path.split('/').any(|segment| matches!(segment, "." | ".."))
}

pub(crate) fn canonical_relay(raw: &str) -> Result<String, String> {
    let (scheme, authority) = raw
        .split_once("://")
        .ok_or("Federated relays require a secure root origin")?;
    if !scheme.eq_ignore_ascii_case("wss") && !scheme.eq_ignore_ascii_case("https") {
        return Err("Federated relays require a secure root origin".into());
    }
    let secure = format!("https://{authority}");
    let url = secure_url(&secure)?;
    if url.path() != "/" || url.port() == Some(80) {
        return Err("Federated relays require a secure root origin".into());
    }
    Ok(format!(
        "wss://{}",
        &url.origin().ascii_serialization()[8..]
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn descriptor() -> serde_json::Value {
        serde_json::json!({"version":1,"id":"example","identityOrigin":"https://identity.example",
            "adapterBase":"https://identity.example/nip-fa/","apiBasePath":"/api/goose/",
            "communityHosts":["*.communities.example","custom.example:8443"]})
    }

    #[test]
    fn deployment_prefix_and_exact_one_label_routing() {
        let config = Config::parse(&descriptor().to_string()).unwrap();
        assert_eq!(
            config.endpoint("/v1/login/start").as_str(),
            "https://identity.example/nip-fa/v1/login/start"
        );
        for relay in [
            "wss://ONE.communities.example:443/",
            "https://custom.example:8443",
        ] {
            assert!(config.matches_relay(relay).unwrap(), "{relay}");
        }
        for relay in [
            "wss://communities.example",
            "wss://a.b.communities.example",
            "wss://a.communities.example:8443",
            "wss://custom.example",
            "wss://evilcommunities.example",
        ] {
            assert!(!config.matches_relay(relay).unwrap(), "{relay}");
        }
    }

    #[test]
    fn unsafe_descriptors_are_refused_before_any_credential_use() {
        for (field, bad) in [
            ("version", serde_json::json!(2)),
            (
                "adapterBase",
                serde_json::json!("https://elsewhere.example"),
            ),
            (
                "adapterBase",
                serde_json::json!("https://identity.example/a/../"),
            ),
            (
                "adapterBase",
                serde_json::json!("https://identity.example/%2f"),
            ),
            (
                "identityOrigin",
                serde_json::json!("http://identity.example"),
            ),
            (
                "communityHosts",
                serde_json::json!(["*.communities.example:8443"]),
            ),
            ("communityHosts", serde_json::json!(["a.*.example"])),
            ("communityHosts", serde_json::json!(["example."])),
        ] {
            let mut value = descriptor();
            value[field] = bad;
            assert!(Config::parse(&value.to_string()).is_err(), "{field}");
        }
    }

    #[test]
    fn relay_wire_authority_and_audience_are_canonical() {
        assert_eq!(
            canonical_relay("wss://EXAMPLE.com:443/").unwrap(),
            "wss://example.com"
        );
        assert_eq!(
            canonical_relay("wss://[2001:DB8::1]:8443").unwrap(),
            "wss://[2001:db8::1]:8443"
        );
        for bad in [
            "wss://example.com:80",
            "wss://example.com.",
            "wss://example.com/a",
            "wss://example.com/../",
            "wss://user@example.com",
            "wss://example.com?x",
            "wss://example.com/%2e",
            "ws://example.com",
        ] {
            assert!(canonical_relay(bad).is_err(), "{bad}");
        }
    }
}
