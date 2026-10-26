//! One agent's stored grant. A grant outlives the owner's BB session (8 days
//! idle, 90 absolute), so session expiry never touches it. It records the BB
//! account that enrolled it: whenever the owner is signed in, a different
//! account retires it, which also covers a restart into another account.

use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use super::super::store::{self, SERVICE};

// No Debug, no IPC serialization. Only the secure store serializes this record.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Grant {
    version: u8,
    pub(crate) owner: String,
    pub(crate) agent: String,
    /// The enrolling BB account's session email.
    pub(crate) account: String,
    /// The `nip_fi_issuer` that granted it, which its assertions must carry.
    pub(crate) issuer: String,
    pub(crate) token: String,
    /// Issued by the one re-enrollment after a refusal and not yet used to
    /// mint: if it is refused too, the agent stops instead of enrolling again.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub(crate) replacement: bool,
}
impl Drop for Grant {
    fn drop(&mut self) {
        self.token.zeroize();
    }
}
impl Grant {
    pub(crate) fn new(
        owner: String,
        agent: String,
        account: String,
        issuer: String,
        token: String,
    ) -> Self {
        Self {
            version: 1,
            owner,
            agent,
            account,
            issuer,
            token,
            replacement: false,
        }
    }
    /// Whether this grant may be used. Without a session (expired or not yet
    /// restored) the grant is used as it is, so agents keep working.
    pub(crate) fn usable_with(&self, signed_in: Option<&str>) -> bool {
        signed_in.is_none_or(|account| account == self.account)
    }
}

pub(crate) trait GrantStore: Send + Sync {
    fn read(&self, key: &str) -> Result<Option<Grant>, &'static str>;
    fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str>;
    fn delete(&self, key: &str) -> Result<(), &'static str>;
    /// Whether the durable retirement record at `key` exists.
    fn pending(&self, key: &str) -> Result<bool, &'static str>;
    fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str>;
}

/// Reads the grant at `key`, retiring it when the signed-in account differs.
pub(crate) fn load(
    store: &dyn GrantStore,
    key: &str,
    signed_in: Option<&str>,
) -> Result<Option<Grant>, &'static str> {
    match store.read(key)? {
        Some(grant) if grant.usable_with(signed_in) => Ok(Some(grant)),
        Some(_) => store.delete(key).map(|()| None),
        None => Ok(None),
    }
}

pub(crate) struct SecureGrantStore;

// Grant records share the session records' secure-store owner and lock.
impl GrantStore for SecureGrantStore {
    fn read(&self, key: &str) -> Result<Option<Grant>, &'static str> {
        raw(key)?
            .map(|raw| serde_json::from_slice(&raw).map_err(|_| "Stored agent grant is unreadable"))
            .transpose()
    }
    fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str> {
        let next = Zeroizing::new(serde_json::to_vec(grant).map_err(|_| "Invalid agent grant")?);
        store::register_grant(storage_root()?, key, || {
            let current = raw(key)?;
            buzz_credential_store::compare_session(
                SERVICE,
                key,
                current.as_deref().map(Vec::as_slice),
                Some(&next),
            )
            .map_err(|_| "Secure storage is unavailable")
        })
    }
    fn pending(&self, key: &str) -> Result<bool, &'static str> {
        raw(key).map(|raw| raw.is_some())
    }
    // Indexed like a grant, so a full Buzz sign-out erases it with them.
    fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str> {
        if !pending {
            return self.delete(key);
        }
        store::register_grant(storage_root()?, key, || {
            let current = raw(key)?;
            buzz_credential_store::compare_session(
                SERVICE,
                key,
                current.as_deref().map(Vec::as_slice),
                Some(b"retiring".as_slice()),
            )
            .map_err(|_| "Secure storage is unavailable")
        })
    }
    fn delete(&self, key: &str) -> Result<(), &'static str> {
        store::unregister_grant(
            storage_root()?,
            key,
            || match buzz_credential_store::delete_session(SERVICE, key) {
                Ok(()) | Err(buzz_credential_store::Error::Absent) => Ok(()),
                Err(_) => Err("Secure storage is unavailable"),
            },
        )
    }
}

fn storage_root() -> Result<std::path::PathBuf, &'static str> {
    store::root().map_err(|_| "Secure storage is unavailable")
}

fn raw(key: &str) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
    match buzz_credential_store::read_session(SERVICE, key) {
        Ok(raw) => Ok(Some(raw)),
        Err(buzz_credential_store::Error::Absent) => Ok(None),
        Err(_) => Err("Secure storage is unavailable"),
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;

    /// The next write signals `.0` once called, then waits for `.1`.
    pub(crate) type Gate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);
    /// Grants in memory, plus the retirement record. `failing` refuses deletes;
    /// `gate` holds the next write.
    #[derive(Default)]
    pub(crate) struct MemoryGrants(
        pub(crate) Mutex<HashMap<String, Vec<u8>>>,
        std::sync::atomic::AtomicBool,
        Mutex<Option<Gate>>,
    );
    impl MemoryGrants {
        pub(crate) fn failing(&self, on: bool) {
            self.1.store(on, std::sync::atomic::Ordering::SeqCst);
        }
        pub(crate) fn gate(&self, gate: Gate) {
            *self.2.lock().unwrap() = Some(gate);
        }
    }

    impl GrantStore for MemoryGrants {
        fn read(&self, key: &str) -> Result<Option<Grant>, &'static str> {
            let grants = self.0.lock().unwrap();
            Ok(grants
                .get(key)
                .map(|raw| serde_json::from_slice(raw).unwrap()))
        }
        fn write(&self, key: &str, grant: &Grant) -> Result<(), &'static str> {
            let gate = self.2.lock().unwrap().take();
            if let Some((held, release)) = gate {
                held.send(()).unwrap();
                release.recv().unwrap();
            }
            let raw = serde_json::to_vec(grant).unwrap();
            self.0.lock().unwrap().insert(key.into(), raw);
            Ok(())
        }
        fn delete(&self, key: &str) -> Result<(), &'static str> {
            if self.1.load(std::sync::atomic::Ordering::SeqCst) {
                return Err("Secure storage is unavailable");
            }
            self.0.lock().unwrap().remove(key);
            Ok(())
        }
        fn pending(&self, key: &str) -> Result<bool, &'static str> {
            Ok(self.0.lock().unwrap().contains_key(key))
        }
        fn set_pending(&self, key: &str, pending: bool) -> Result<(), &'static str> {
            if !pending {
                return self.delete(key);
            }
            self.0
                .lock()
                .unwrap()
                .insert(key.into(), b"retiring".to_vec());
            Ok(())
        }
    }

    fn enrolled(store: &MemoryGrants, account: &str) {
        let grant = Grant::new(
            "owner".into(),
            "agent".into(),
            account.into(),
            "issuer".into(),
            "g".into(),
        );
        store.write("key", &grant).unwrap();
    }

    #[test]
    fn a_restart_into_a_different_account_retires_the_old_grant() {
        let store = MemoryGrants::default();
        enrolled(&store, "a@example.com");

        // A new run: the session signal says Refreshed, but the account differs.
        assert!(load(&store, "key", Some("b@example.com"))
            .unwrap()
            .is_none());
        assert!(store.0.lock().unwrap().is_empty());
    }

    #[test]
    fn the_same_account_or_no_session_keeps_the_grant() {
        let store = MemoryGrants::default();
        enrolled(&store, "a@example.com");

        let same = load(&store, "key", Some("a@example.com")).unwrap().unwrap();
        assert_eq!(same.token, "g");
        // Owner session expired: agents keep working on their grant.
        assert!(load(&store, "key", None).unwrap().is_some());
        assert!(store.0.lock().unwrap().contains_key("key"));
    }
}
