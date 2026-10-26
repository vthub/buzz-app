//! Secure records plus durable, nonsensitive refusal markers outside wiped app data.
use std::{fs, path::PathBuf};
use zeroize::Zeroizing;

pub(crate) const SERVICE: &str = if cfg!(debug_assertions) {
    "dev.local.buzz.foundation.federated-session.debug"
} else {
    "dev.local.buzz.foundation.federated-session"
};

pub(crate) type LoadedRecord = (Option<Zeroizing<Vec<u8>>>, Option<String>);

pub(crate) trait Store: Send + Sync {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str>;
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str>;
    fn load(&self) -> Result<LoadedRecord, &'static str>;
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str>;
}

pub(crate) struct SecureStore {
    pub(super) account: String,
    pub(super) root: PathBuf,
}

// Releasing the transaction must not wait for inherited/duplicated handles.
// This matches the existing credential-store account lock's explicit unlock.
struct Transaction(std::fs::File);
impl Drop for Transaction {
    fn drop(&mut self) {
        let _ = fs2::FileExt::unlock(&self.0);
    }
}

#[cfg(not(test))]
fn error(error: buzz_credential_store::Error) -> &'static str {
    use buzz_credential_store::Error;
    match error {
        Error::Denied => "storage-denied",
        Error::Corrupt => "storage-corrupt",
        Error::Busy => "storage-busy",
        Error::Changed | Error::Occupied => "session-changed",
        _ => "storage-unavailable",
    }
}

impl SecureStore {
    fn marker(&self, revision: &str) -> Result<PathBuf, &'static str> {
        let revision = uuid::Uuid::parse_str(revision).map_err(|_| "storage-corrupt")?;
        Ok(self
            .root
            .join(format!("{}.{revision}.refused", self.account)))
    }
    fn index(&self) -> PathBuf {
        self.root.join(format!("{}.record", self.account))
    }
    /// Every cooperating FI reader/writer holds this account lock across both
    /// the secure-record operation and its nonsensitive refusal marker.
    fn lock(&self) -> Result<Transaction, &'static str> {
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        let file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(self.root.join(format!("{}.lock", self.account)))
            .map_err(|_| "storage-unavailable")?;
        fs2::FileExt::try_lock_exclusive(&file).map_err(|error| {
            if error.kind() == std::io::ErrorKind::WouldBlock {
                "storage-busy"
            } else {
                "storage-unavailable"
            }
        })?;
        Ok(Transaction(file))
    }
    fn refused(&self, revision: &str) -> Result<Option<String>, &'static str> {
        match fs::read_to_string(self.marker(revision)?) {
            Ok(contents) if contents == revision => Ok(Some(contents)),
            Ok(_) => Err("storage-corrupt"),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) => Err("storage-unavailable"),
        }
    }
    fn refuse(&self, revision: &str) -> Result<(), &'static str> {
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(self.marker(revision)?)
            .map_err(|_| "storage-unavailable")?;
        use std::io::Write;
        file.write_all(revision.as_bytes())
            .and_then(|_| file.sync_all())
            .map_err(|_| "storage-unavailable")
    }
    fn clear_refusal(&self, revision: &str) -> Result<(), &'static str> {
        match fs::remove_file(self.marker(revision)?) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("storage-unavailable"),
        }
    }
}

impl Store for SecureStore {
    fn read(&self) -> Result<Option<Zeroizing<Vec<u8>>>, &'static str> {
        #[cfg(not(test))]
        {
            match buzz_credential_store::read_session(SERVICE, &self.account) {
                Ok(value) => Ok(Some(value)),
                Err(buzz_credential_store::Error::Absent) => Ok(None),
                Err(value) => Err(error(value)),
            }
        }
        #[cfg(test)]
        Err("storage-unavailable")
    }
    fn compare(
        &self,
        expected: Option<&[u8]>,
        replacement: Option<&[u8]>,
    ) -> Result<(), &'static str> {
        let _transaction = self.lock()?;
        // Register before writing any secret. Buzz identity deletion walks these
        // public account keys even after configuration or profile changes.
        fs::create_dir_all(&self.root).map_err(|_| "storage-unavailable")?;
        fs::write(self.index(), b"1").map_err(|_| "storage-unavailable")?;
        #[cfg(not(test))]
        {
            buzz_credential_store::compare_session(SERVICE, &self.account, expected, replacement)
                .map_err(error)
        }
        #[cfg(test)]
        {
            let _ = (expected, replacement);
            Err("storage-unavailable")
        }
    }
    fn load(&self) -> Result<LoadedRecord, &'static str> {
        let _transaction = self.lock()?;
        let raw = self.read()?;
        let refusal = match raw.as_ref() {
            Some(raw) if raw.len() <= 64 * 1024 => {
                let record: super::Record =
                    serde_json::from_slice(raw).map_err(|_| "storage-corrupt")?;
                self.refused(&record.revision)?
            }
            Some(_) => return Err("storage-corrupt"),
            None => None,
        };
        Ok((raw, refusal))
    }
    fn remove(&self, expected: &[u8], revision: &str) -> Result<(), &'static str> {
        // Refusal must also survive contention with another Buzz instance.
        // Revision-scoped files cannot overwrite a newer record's refusal.
        self.refuse(revision)?;
        let _transaction = self.lock()?;
        #[cfg(not(test))]
        buzz_credential_store::compare_session(SERVICE, &self.account, Some(expected), None)
            .map_err(error)?;
        #[cfg(test)]
        {
            let _ = expected;
            Err("storage-unavailable")
        }
        #[cfg(not(test))]
        self.clear_refusal(revision)
    }
}

/// Secure-store account for one agent's grant, beside (never inside) the
/// owner's session record: same profile and deployment scoping, its own key.
#[allow(dead_code)] // Consumed by the agent token client.
pub(crate) fn agent_grant_key(account: &str, owner: &str, agent: &str) -> String {
    use sha2::{Digest, Sha256};
    format!(
        "{:x}",
        Sha256::digest(format!("agent-grant\0{account}\0{owner}\0{agent}"))
    )
}

/// Runs `write` for the agent grant at `key` under its account lock, after
/// registering `key` in the index the boot erase owner walks, so a full Buzz
/// sign-out removes the grant like any session record.
pub(crate) fn register_grant<T>(
    root: PathBuf,
    key: &str,
    write: impl FnOnce() -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let store = SecureStore {
        account: key.to_owned(),
        root,
    };
    let _transaction = store.lock()?;
    fs::write(store.index(), b"1").map_err(|_| "storage-unavailable")?;
    write()
}

/// Runs `delete` for the agent grant at `key` under its account lock, then
/// drops its index entry. A failed deletion keeps the entry for the boot owner.
pub(crate) fn unregister_grant(
    root: PathBuf,
    key: &str,
    delete: impl FnOnce() -> Result<(), &'static str>,
) -> Result<(), &'static str> {
    let store = SecureStore {
        account: key.to_owned(),
        root,
    };
    let _transaction = store.lock()?;
    delete()?;
    match fs::remove_file(store.index()) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err("storage-unavailable"),
    }
}

pub(crate) fn root() -> Result<PathBuf, &'static str> {
    dirs::data_dir()
        .map(|path| path.join(format!(".{SERVICE}")))
        .ok_or("storage-unavailable")
}

/// Called before the existing boot owner deletes the human key or opens a WebView.
pub(crate) fn remove_all(root: PathBuf) -> Result<(), String> {
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("Federated session removal could not access storage".into()),
    };
    for entry in entries {
        let entry = entry.map_err(|_| "Federated session removal failed")?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("record") {
            continue;
        }
        let account = path.file_stem().and_then(|value| value.to_str());
        let Some(account) = account else { continue };
        if account.len() != 64 || !account.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let store = SecureStore {
            account: account.to_owned(),
            root: root.clone(),
        };
        let _transaction = store.lock()?;
        // The boot owner's durable pending sign-out fences all app activity.
        // Wiping an indexed slot needs neither its schema nor read permission.
        #[cfg(not(test))]
        match buzz_credential_store::delete_session(SERVICE, account) {
            Ok(()) | Err(buzz_credential_store::Error::Absent) => {}
            Err(value) => return Err(error(value).into()),
        }
        #[cfg(test)]
        return Err("storage-unavailable".into());
        #[cfg(not(test))]
        fs::remove_file(path).map_err(|_| "Federated session index removal failed")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_wipe_ignores_stray_indices_and_retains_failed_deletions() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("stray.record"), b"unrelated").unwrap();
        assert!(remove_all(root.path().into()).is_ok());
        let account = "ab".repeat(32);
        let index = root.path().join(format!("{account}.record"));
        fs::write(&index, b"1").unwrap();
        let store = SecureStore {
            account,
            root: root.path().into(),
        };
        let held = store.lock().unwrap();
        assert_eq!(remove_all(root.path().into()), Err("storage-busy".into()));
        assert!(index.exists());
        drop(held);
        // This test build denies OS credential access. A failed delete must
        // leave its index for the boot owner's pending sign-out retry.
        assert_eq!(
            remove_all(root.path().into()),
            Err("storage-unavailable".into())
        );
        assert!(index.exists());
    }

    #[test]
    fn agent_grants_are_indexed_for_the_identity_wipe_before_they_are_written() {
        let root = tempfile::tempdir().unwrap();
        let key = agent_grant_key("profile", "owner", "agent");
        let index = root.path().join(format!("{key}.record"));
        // Registered before the secret write, which here fails: kept anyway.
        let failed: Result<(), _> =
            register_grant(root.path().into(), &key, || Err("storage-unavailable"));
        assert!(failed.is_err());
        assert!(index.exists());
        // The boot owner walks it (and this build denies the OS delete).
        assert_eq!(
            remove_all(root.path().into()),
            Err("storage-unavailable".into())
        );
        assert!(index.exists());
        // A failed grant deletion keeps the index; a completed one drops it.
        assert!(unregister_grant(root.path().into(), &key, || Err("storage-unavailable")).is_err());
        assert!(index.exists());
        unregister_grant(root.path().into(), &key, || Ok(())).unwrap();
        assert!(!index.exists());
        assert!(remove_all(root.path().into()).is_ok());
    }

    #[test]
    fn failed_removal_still_refuses_only_the_known_revision() {
        let root = tempfile::tempdir().unwrap();
        let store = SecureStore {
            account: "fixture".into(),
            root: root.path().into(),
        };
        let old = uuid::Uuid::new_v4().to_string();
        let newer = uuid::Uuid::new_v4().to_string();
        store.refuse(&newer).unwrap();
        let transaction = store.lock().unwrap();
        let inherited = transaction.0.try_clone().unwrap();
        assert_eq!(
            store.remove(b"known in-memory record", &old),
            Err("storage-busy")
        );
        assert_eq!(store.refused(&old).unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        drop(transaction);
        store.clear_refusal(&old).unwrap();
        // The test build denies secure-store access instead of touching OS credentials.
        assert_eq!(
            store.remove(b"known in-memory record", &old),
            Err("storage-unavailable")
        );
        assert_eq!(store.refused(&old).unwrap().as_deref(), Some(old.as_str()));
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        store.clear_refusal(&old).unwrap();
        assert!(store.refused(&old).unwrap().is_none());
        assert_eq!(
            store.refused(&newer).unwrap().as_deref(),
            Some(newer.as_str())
        );
        drop(inherited);
    }
}
