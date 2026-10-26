//! Opaque, plugin-owned policy bound to a native-held agent identity.
use crate::Result;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectionBinding {
    pub provider: String,
    pub policy: serde_json::Value,
}
impl ProtectionBinding {
    pub fn validate(&self) -> Result<()> {
        if self.provider.is_empty()
            || self.provider.len() > 160
            || !self
                .provider
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
            || !self.policy.is_object()
            || serde_json::to_vec(&self.policy)
                .map_err(|_| "Invalid protection policy")?
                .len()
                > 32 * 1024
        {
            return Err("Invalid protection binding".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ProtectionDefaults {
    pub revision: u64,
    pub defaults: Option<ProtectionBinding>,
}
