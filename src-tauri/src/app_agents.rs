//! Native custody for agents the app runs through a plugin (Agents). The key
//! and owner attestation never enter the WebView; it asks for one bounded
//! event, read, upload or memory write at a time, and native signs and sends it
//! to the agent's community.
use crate::sign_out::{self, legacy_identifier};
use buzz_agent_controller::{
    inline_picture, AppAgent, AppAgents, Carry, Credentials, OldStores, PlatformCredentials,
    PortSource, Portables, ProtectionBinding, ProtectionDefaults, Published, Removal, Secret, CREDENTIALS_BUSY,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::fs::{File, OpenOptions, TryLockError};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

/// A NIP-98 `Authorization` header for one signed HTTP auth event.
fn authorization(event: Value) -> Result<String, String> {
    use base64::Engine;
    Ok(format!(
        "Nostr {}",
        base64::engine::general_purpose::STANDARD
            .encode(serde_json::to_vec(&event).map_err(|_| "Could not authorize profile request")?)
    ))
}

const BUSY_WAITS: u32 = 50;
const BUSY_WAIT: std::time::Duration = std::time::Duration::from_millis(100);

/// The identity file (which locks its own writes across app instances) and its
/// own credential handle, so Agents never waits on, or fails with, the harness
/// agent controller (whose storage lock another app may hold).
#[derive(Clone)]
pub(crate) struct AppAgentHost {
    agents: Result<AppAgents, String>,
    /// Earlier agent systems' identities on this machine, which it can take over.
    old: Result<OldStores, String>,
    credentials: Arc<dyn Credentials>,
    /// Each key after its first read, so only create and first use reach the
    /// credential store, whose lock refuses rather than waits. Waiting on this
    /// lock instead lets concurrent publications queue for that first read.
    keys: Arc<Mutex<HashMap<String, Arc<Secret>>>>,
    /// One profile publication per agent at a time, in any of its communities,
    /// so each is newer than the last; Delete takes it too, so no publication
    /// outlives the key.
    profiles: Arc<Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>>,
    removals: Arc<Mutex<Removals>>,
    hosting: Arc<Hosting>,
}
impl AppAgentHost {
    /// `packaged` is false for a dev build, which steps aside for a packaged app.
    pub(crate) fn new(
        path: Result<PathBuf, String>,
        old: Result<OldStores, String>,
        packaged: bool,
    ) -> Self {
        let hosting = Hosting::new(&path, packaged);
        Self {
            agents: path.map(|path| {
                let agents = AppAgents::open(path);
                // So an older build can read the list again.
                if let Err(error) = agents.upgrade() {
                    eprintln!("Saved agent identities were not upgraded: {error}");
                }
                agents
            }),
            old,
            credentials: Arc::new(PlatformCredentials::default()),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting),
        }
    }
    /// The saved identities, for readers outside Agents such as the inventory.
    pub(crate) fn agents(&self) -> Result<AppAgents, String> {
        self.agents.clone()
    }
    fn removals(&self) -> std::sync::MutexGuard<'_, Removals> {
        self.removals
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Lets go of the removals the page held, as a new page starts none.
    pub(crate) fn page_load(&self) {
        let mut removals = self.removals();
        removals.page += 1;
        removals.held.clear();
    }
    fn keys(&self) -> std::sync::MutexGuard<'_, HashMap<String, Arc<Secret>>> {
        self.keys
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn profile_turn(&self, pubkey: &str) -> Arc<tokio::sync::Mutex<()>> {
        self.profiles
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(pubkey.into())
            .or_default()
            .clone()
    }
    /// The agent's key; read from the credential store only on first use. A
    /// busy store (a harness start or another app holding it) is waited out for
    /// a few seconds, without holding up agents whose keys are already read.
    async fn key(&self, agent: AppAgent) -> Result<(AppAgent, Arc<Secret>), String> {
        let host = self.clone();
        blocking(move || {
            let mut waits = 0;
            loop {
                let mut keys = host.keys();
                if let Some(key) = keys.get(&agent.pubkey) {
                    return Ok((agent, key.clone()));
                }
                match agent.read_key(host.credentials.as_ref()) {
                    Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                        drop(keys);
                        waits += 1;
                        std::thread::sleep(BUSY_WAIT);
                    }
                    read => {
                        let key = Arc::new(read?);
                        keys.insert(agent.pubkey.clone(), key.clone());
                        return Ok((agent, key));
                    }
                }
            }
        })
        .await
    }
    /// Deletes its key in the community at `relay` once any profile publication
    /// in flight has settled, so the community's cleanup sees every profile it
    /// will ever have. The row stays, marked deleted, until the WebView has
    /// cleaned up the community and calls `app_agent_forget`. This copy of the
    /// app stops running the agent once it is in no community.
    async fn delete(&self, pubkey: String, relay: String) -> Result<(), String> {
        let page = self.removals().page;
        let turn = self.profile_turn(&pubkey);
        let _turn = turn.lock().await;
        let host = self.clone();
        blocking(move || {
            // Held across the deletion, so no publication re-reads the key meanwhile.
            let mut keys = host.keys();
            let agents = host.agents.clone()?;
            let removals = host.removals();
            if removals.page != page {
                return Err("The app reloaded while it was being removed".into());
            }
            let removal = removals
                .held
                .get(&pubkey)
                .filter(|removal| removal.is(&pubkey, &relay))
                .ok_or("Its removal from that community isn't held by this app")?;
            keys.remove(&pubkey);
            agents.remove(removal, host.credentials.as_ref())?;
            drop(removals);
            if !agents
                .list()?
                .iter()
                .any(|agent| agent.pubkey == pubkey && !agent.deleted)
            {
                host.hosting.held().remove(&pubkey);
            }
            Ok(())
        })
        .await
    }
    /// The agent in the community at `relay`, if it still has its key there.
    /// One deleted elsewhere loses its cached key.
    async fn agent(&self, pubkey: String, relay: String) -> Result<AppAgent, String> {
        let host = self.clone();
        blocking(move || {
            let agent = host.agents.clone()?.get(&pubkey, &relay);
            if agent.is_err() {
                host.keys().remove(&pubkey);
            }
            agent
        })
        .await
    }
}

/// Which running copy of the app runs each agent. Every copy on this machine
/// (the packaged app and any dev builds) has the same agents and hears the
/// same events. The packaged app always runs what it can and holds
/// `<pubkey>.packaged` while it does; there is only ever one, since only a
/// release build with the release identifier counts and it is single-instance.
/// Dev builds step aside while that is held, and
/// otherwise run each agent from whichever holds `<pubkey>.lock`. The OS lets go
/// of both when a copy exits, however it exits.
struct Hosting {
    /// Where this copy holds its locks, beside its agent list.
    dir: Result<PathBuf, String>,
    /// Where the packaged app holds `<pubkey>.packaged`.
    packaged_dir: Result<PathBuf, String>,
    packaged: bool,
    /// The lock file this copy holds per agent: `.packaged` or `.lock`.
    held: Mutex<HashMap<String, File>>,
}
impl Hosting {
    /// For the agent list at `path`. Dev builds keep their own storage
    /// (`.dev`), so they look for the packaged app's locks in the release
    /// identifier's.
    fn new(path: &Result<PathBuf, String>, packaged: bool) -> Self {
        let agents = path.as_ref().map_err(Clone::clone).and_then(|path| {
            path.parent()
                .ok_or_else(|| "Invalid agent storage".to_owned())
        });
        let dir = agents.clone().map(|agents| agents.join("hosts"));
        let packaged_dir = if packaged {
            dir.clone()
        } else {
            agents.and_then(|agents| {
                let app = agents.parent().ok_or("Invalid agent storage")?;
                Ok(app
                    .with_file_name(legacy_identifier::CURRENT)
                    .join(sign_out::AGENTS)
                    .join("hosts"))
            })
        };
        Self {
            dir,
            packaged_dir,
            packaged,
            held: Mutex::default(),
        }
    }
    fn held(&self) -> std::sync::MutexGuard<'_, HashMap<String, File>> {
        self.held
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    /// Whether this copy runs the agent. The packaged app always does, so a
    /// stuck dev build can never silence it. A dev build takes the agent if no
    /// other copy runs it, and lets go while the packaged app does.
    #[allow(clippy::incompatible_msrv)] // `File` locking; see `sign_out::Instance`.
    fn claim(&self, pubkey: &str) -> Result<bool, String> {
        if pubkey.len() != 64
            || !pubkey
                .bytes()
                .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
        {
            return Err("Invalid agent".into());
        }
        let dir = self.dir.as_ref().map_err(Clone::clone)?;
        std::fs::create_dir_all(dir).map_err(|_| "Could not open agent hosting")?;
        let packaged = self
            .packaged_dir
            .as_ref()
            .map_err(Clone::clone)?
            .join(format!("{pubkey}.packaged"));
        let mut held = self.held();
        if self.packaged {
            if !held.contains_key(pubkey) {
                let file = open_lock(&packaged)?;
                // A dev build checking for it holds it briefly; this tries again next time.
                if lock(file.try_lock())? {
                    held.insert(pubkey.into(), file);
                }
            }
            return Ok(held.contains_key(pubkey));
        }
        // Opened, never created, as a dev build must not create the release
        // storage, which the packaged app's next launch may still move into.
        let running = match File::open(&packaged) {
            Ok(file) => !lock(file.try_lock_shared())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
            Err(_) => return Err("Could not read agent hosting".into()),
        };
        if running {
            held.remove(pubkey);
            return Ok(false);
        }
        if !held.contains_key(pubkey) {
            let file = open_lock(&dir.join(format!("{pubkey}.lock")))?;
            if lock(file.try_lock())? {
                held.insert(pubkey.into(), file);
            }
        }
        Ok(held.contains_key(pubkey))
    }
    /// Policy writes require this copy's custody and no overlapping dev/packaged host.
    #[allow(clippy::incompatible_msrv)]
    fn protecting<T>(
        &self,
        pubkey: &str,
        change: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let held = self.held();
        if !held.contains_key(pubkey) {
            return Err("Change protection in the Buzz app that runs this agent".into());
        }
        let dir = self.dir.as_ref().map_err(Clone::clone)?;
        let other = open_lock(&dir.join(format!(
            "{pubkey}.{}",
            if self.packaged { "lock" } else { "packaged" }
        )))?;
        if !lock(other.try_lock())? {
            return Err("Quit the other copy of Buzz before changing protection".into());
        }
        // Both hosting locks stay held across the native CAS write.
        change()
    }
}
/// Whether a try at a lock took it; closing the file lets go.
#[allow(clippy::incompatible_msrv)]
fn lock(attempt: Result<(), TryLockError>) -> Result<bool, String> {
    match attempt {
        Ok(()) => Ok(true),
        Err(TryLockError::WouldBlock) => Ok(false),
        Err(TryLockError::Error(_)) => Err("Could not read agent hosting".into()),
    }
}
fn open_lock(path: &Path) -> Result<File, String> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| "Could not open agent hosting lock".to_owned())
}

/// Each agent the page loaded now is taking out of a community; see
/// `AppAgents::hold_removal`.
#[derive(Default)]
struct Removals {
    /// Counts page loads, so a hold taken for an earlier page is let go.
    page: u64,
    held: HashMap<String, Removal>,
}

/// Runs blocking file and credential work off the async runtime.
async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| "Native credential operation failed".to_owned())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppAgentSummary {
    pubkey: String,
    relay: String,
    owner: String,
    #[serde(rename = "type")]
    agent_type: String,
    name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    picture: Option<String>,
    deleted: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    deleting: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    home: Option<String>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    joining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    protection: Option<ProtectionBinding>,
    protection_revision: u64,
}
impl From<AppAgent> for AppAgentSummary {
    fn from(agent: AppAgent) -> Self {
        Self {
            pubkey: agent.pubkey,
            relay: agent.relay,
            owner: agent.owner,
            agent_type: agent.agent_type,
            name: agent.name,
            picture: agent.picture,
            deleted: agent.deleted,
            deleting: agent.deleting,
            home: agent.home,
            joining: agent.joining,
            protection: agent.protection,
            protection_revision: agent.protection_revision,
        }
    }
}

/// A taken-over identity and the settings its old store kept for its new type.
#[derive(Serialize)]
pub(crate) struct Ported {
    agent: AppAgentSummary,
    carry: Carry,
    /// What did not come over, said to the person importing.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    notes: Vec<String>,
}

#[tauri::command]
pub(crate) async fn app_agent_list(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Vec<AppAgentSummary>, String> {
    let agents = state.agents.clone()?;
    blocking(move || Ok(agents.list()?.into_iter().map(Into::into).collect())).await
}

/// Generates a key for `owner` in `destination`, has the signed-in owner attest
/// it, and saves both. Nothing is saved unless all three succeed.
#[tauri::command]
pub(crate) async fn app_agent_create(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    destination: String,
    owner: String,
    agent_type: String,
    name: String,
) -> Result<AppAgentSummary, String> {
    let agents = state.agents.clone()?;
    let prepared = AppAgents::prepare(&destination, &owner, &agent_type, &name)?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let mut keys = host.keys();
        host.credentials.retry();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        keys.insert(agent.pubkey.clone(), Arc::new(key));
        Ok(agent.into())
    })
    .await
}

/// Changes only the plugin binding, never identity or credential custody.
#[tauri::command]
pub(crate) async fn app_agent_protection_defaults(
    host: tauri::State<'_, AppAgentHost>,
    owner: String,
) -> Result<ProtectionDefaults, String> {
    let agents = host.agents()?;
    blocking(move || agents.protection_defaults(&owner)).await
}
#[tauri::command]
pub(crate) async fn app_agent_set_protection_defaults(
    host: tauri::State<'_, AppAgentHost>,
    owner: String,
    revision: u64,
    provider: String,
    policy: Option<Value>,
) -> Result<(), String> {
    let agents = host.agents()?;
    blocking(move || agents.set_protection_defaults(&owner, revision, &provider, policy)).await
}
#[tauri::command]
pub(crate) async fn app_agent_set_protection(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    revision: u64,
    provider: String,
    policy: Option<Value>,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    let hosting = state.hosting.clone();
    blocking(move || {
        hosting.protecting(&pubkey, || {
            agents.set_protection(&pubkey, revision, &provider, policy)
        })
    })
    .await
}

/// Identities earlier agent systems saved on this machine, as Agents could take
/// them over; the caller leaves out its own.
#[tauri::command]
pub(crate) async fn app_agent_portable(
    state: tauri::State<'_, AppAgentHost>,
) -> Result<Portables, String> {
    let old = state.old.clone()?;
    blocking(move || Ok(old.list())).await
}

/// Takes over an earlier identity with its key, name, picture and description,
/// as `app_agent_create` does for a new one, and reports its carried settings.
/// Its old store keeps it.
#[tauri::command]
pub(crate) async fn app_agent_port(
    state: tauri::State<'_, AppAgentHost>,
    identity: tauri::State<'_, crate::identity::IdentityHost>,
    source: PortSource,
    pubkey: String,
    destination: String,
    owner: String,
    agent_type: String,
) -> Result<Ported, String> {
    let agents = state.agents.clone()?;
    let old = state.old.clone()?;
    let credentials = state.credentials.clone();
    let (found, key) = blocking(move || {
        credentials.retry();
        let mut waits = 0;
        loop {
            match old.take(source, &pubkey, credentials.as_ref()) {
                Err(error) if error == CREDENTIALS_BUSY && waits < BUSY_WAITS => {
                    waits += 1;
                    std::thread::sleep(BUSY_WAIT);
                }
                taken => return taken,
            }
        }
    })
    .await?;
    let prepared = AppAgents::adopt(
        &destination,
        &owner,
        &agent_type,
        key,
        &found.name,
        found.picture.clone(),
        found.about.clone(),
    )?;
    let auth = identity
        .inner()
        .authorize_agent(owner, prepared.pubkey().to_owned())
        .await?;
    let host = state.inner().clone();
    let (mut agent, key) = blocking(move || {
        let mut keys = host.keys();
        let (agent, key) = agents.commit(prepared, &auth, host.credentials.as_ref())?;
        let key = Arc::new(key);
        keys.insert(agent.pubkey.clone(), key.clone());
        Ok((agent, key))
    })
    .await?;
    let mut notes = vec![];
    // Old Buzz kept some pictures inline; the community serves the upload. The
    // agent comes over without it if that fails, which the import reports.
    let inline = found
        .picture
        .as_deref()
        .filter(|url| url.starts_with("data:"));
    if inline.is_some_and(|url| inline_picture(url).is_none()) {
        notes.push(format!(
            "{} came over without its picture, which isn't a PNG, JPEG, GIF or WebP image under 6 MB.",
            agent.name
        ));
    }
    if let Some((mime, bytes)) = inline.and_then(inline_picture) {
        let agents = state.agents.clone()?;
        let uploaded = async {
            let receipt = upload(&agent, &key, bytes, mime).await?;
            let url = receipt["url"].as_str().ok_or("Upload returned no URL")?;
            let (pubkey, relay, picture) = (
                agent.pubkey.clone(),
                agent.relay.clone(),
                Some(url.to_owned()),
            );
            blocking(move || agents.set_picture(&pubkey, &relay, picture)).await?;
            Ok::<_, String>(url.to_owned())
        };
        match uploaded.await {
            Ok(url) => agent.picture = Some(url),
            Err(error) => {
                eprintln!("Imported agent picture was not saved: {error}");
                notes.push(format!("{} came over without its picture.", agent.name));
            }
        }
    }
    Ok(Ported {
        agent: agent.into(),
        carry: found.carry,
        notes,
    })
}

#[tauri::command]
pub(crate) async fn app_agent_rename(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    name: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.rename(&pubkey, &name)).await
}

#[tauri::command]
pub(crate) async fn app_agent_set_type(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    agent_type: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_type(&pubkey, &agent_type)).await
}

/// Sets its picture in the community at `relay`, one that community serves.
#[tauri::command]
pub(crate) async fn app_agent_set_picture(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    picture: Option<String>,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.set_picture(&pubkey, &relay, picture)).await
}

/// Adds the agent, as it is in the community at `from`, to the community at
/// `destination`, with the same key and owner attestation; see `AppAgents::join`.
#[tauri::command]
pub(crate) async fn app_agent_join(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    from: String,
    destination: String,
    picture: Option<String>,
) -> Result<AppAgentSummary, String> {
    let host = state.inner().clone();
    blocking(move || {
        // Held so no first key read meets this write in the credential store.
        let _keys = host.keys();
        host.credentials.retry();
        let agents = host.agents.clone()?;
        Ok(agents
            .join(
                &pubkey,
                &from,
                &destination,
                picture,
                host.credentials.as_ref(),
            )?
            .into())
    })
    .await
}

#[tauri::command]
pub(crate) async fn app_agent_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    state.delete(pubkey, relay).await
}

#[tauri::command]
pub(crate) async fn app_agent_begin_delete(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.begin_delete(&pubkey)).await
}

/// Starts its leaving the community at `relay`; see `AppAgents::begin_leave`.
#[tauri::command]
pub(crate) async fn app_agent_begin_leave(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.begin_leave(&pubkey, &relay)).await
}

/// Holds its removal from the community at `relay` for this copy of the app,
/// until `app_agent_release_removal`; see `AppAgents::hold_removal`.
#[tauri::command]
pub(crate) async fn app_agent_hold_removal(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let host = state.inner().clone();
    let page = host.removals().page;
    blocking(move || {
        let removal = host.agents.clone()?.hold_removal(&pubkey, &relay)?;
        let mut removals = host.removals();
        // A page that loaded meanwhile holds none, so it is let go.
        if removals.page != page {
            return Err("The app reloaded while it was being removed".into());
        }
        removals.held.insert(pubkey, removal);
        Ok(())
    })
    .await
}

#[tauri::command]
pub(crate) fn app_agent_release_removal(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) {
    let held = &mut state.removals().held;
    if held
        .get(&pubkey)
        .is_some_and(|removal| removal.is(&pubkey, &relay))
    {
        held.remove(&pubkey);
    }
}

#[tauri::command]
pub(crate) async fn app_agent_forget(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let agents = state.agents.clone()?;
    blocking(move || agents.forget(&pubkey, &relay)).await
}

/// Whether this copy of the app runs the agent; see `Hosting`.
#[tauri::command]
pub(crate) async fn app_agent_claim(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    revision: Option<u64>,
) -> Result<bool, String> {
    let hosting = state.hosting.clone();
    let agents = state.agents.clone()?;
    blocking(move || {
        if !hosting.claim(&pubkey)? {
            return Ok(false);
        }
        let current = agents.list()?.into_iter().find(|agent| agent.pubkey == pubkey && !agent.deleted).ok_or("No such agent on this device")?;
        if current.protection_revision != revision.unwrap_or(0) {
            return Err("Agent protection changed; refresh before running this agent".into());
        }
        Ok(true)
    })
    .await
}

/// Lets another copy of the app run the agent, as when this one cannot.
#[tauri::command]
pub(crate) fn app_agent_release(state: tauri::State<'_, AppAgentHost>, pubkey: String) {
    state.hosting.held().remove(&pubkey);
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct AppAgentEvent {
    kind: u16,
    content: String,
    #[serde(default)]
    tags: Vec<Vec<String>>,
}

/// Signs one event as the agent and posts it to the agent's own community.
#[tauri::command]
pub(crate) async fn app_agent_publish(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    event: AppAgentEvent,
) -> Result<Value, String> {
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    let signed = agent.sign(&key, event.kind, event.content, event.tags)?;
    post(&agent, &key, signed).await
}

/// Publishes changed public metadata. Safe to call any time; one publication
/// runs per agent at a time and records only what its community accepted.
#[tauri::command]
pub(crate) async fn app_agent_publish_profile(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
) -> Result<(), String> {
    let turn = state.profile_turn(&pubkey);
    let _turn = turn.lock().await;
    let agent = state.agent(pubkey, relay).await?;
    if agent.profile_is_current() {
        return Ok(());
    }
    let (agent, key) = state.key(agent).await?;
    let signed = post(&agent, &key, agent.profile_event(&key)?).await?;
    let created_at = signed
        .get("created_at")
        .and_then(Value::as_u64)
        .ok_or("Invalid agent event")?;
    let agents = state.agents.clone()?;
    blocking(move || {
        agents.published(
            &agent.pubkey,
            &agent.relay,
            Published {
                name: agent.name,
                picture: agent.picture,
                about: agent.about,
                created_at,
            },
        )
    })
    .await
}

/// Reads from the agent's community as the agent, so it sees what the agent
/// may see rather than what the owner may.
#[tauri::command]
pub(crate) async fn app_agent_query(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    filters: Vec<Value>,
) -> Result<Value, String> {
    if filters.is_empty() || filters.len() > 8 {
        return Err("Agents read with one to eight filters".into());
    }
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    read(&agent, &key, &filters).await
}

async fn read(agent: &AppAgent, key: &Secret, filters: &[Value]) -> Result<Value, String> {
    let bytes = serde_json::to_vec(filters).map_err(|_| "Could not encode agent read")?;
    let (status, body) = signed_read(agent, key, agent.query_url(), bytes).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the agent read: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid agent read".into())
}

/// Posts a read body to one of the agent's community endpoints, signed as the
/// agent, and returns the status and bounded body.
async fn signed_read(
    agent: &AppAgent,
    key: &Secret,
    url: String,
    bytes: Vec<u8>,
) -> Result<(reqwest::StatusCode, Vec<u8>), String> {
    let response = client()?
        .post(&url)
        .timeout(Duration::from_secs(20))
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &url, &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent read failed")?;
    let status = response.status();
    Ok((status, bounded(response, 8 * 1024 * 1024).await?))
}

/// Searches the agent's community for profiles whose `name` or `display_name`
/// matches `query`, best match first, as the agent. `None` means the community
/// has no profile name search (it answered 404 or 405), so the caller uses
/// NIP-50 search instead.
#[tauri::command]
pub(crate) async fn app_agent_search_profiles(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    query: String,
    limit: u32,
) -> Result<Option<Value>, String> {
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    search_profiles(&agent, &key, &query, limit).await
}

async fn search_profiles(
    agent: &AppAgent,
    key: &Secret,
    query: &str,
    limit: u32,
) -> Result<Option<Value>, String> {
    let bytes = serde_json::to_vec(&serde_json::json!({ "query": query, "limit": limit }))
        .map_err(|_| "Could not encode profile search")?;
    let (status, body) = signed_read(agent, key, agent.profile_search_url(), bytes).await?;
    if matches!(
        status,
        reqwest::StatusCode::NOT_FOUND | reqwest::StatusCode::METHOD_NOT_ALLOWED
    ) {
        return Ok(None);
    }
    if !status.is_success() {
        return Err(format!(
            "The community refused the profile search: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body)
        .map(Some)
        .map_err(|_| "Invalid profile search".into())
}

/// The largest file an agent uploads, as base64 through the WebView.
const UPLOAD_LIMIT: usize = 50 * 1024 * 1024;

/// A `type/subtype` MIME, lowercase, without parameters.
fn mime_type(value: &str) -> Option<String> {
    let mime = value.split(';').next()?.trim().to_ascii_lowercase();
    let (kind, subtype) = mime.split_once('/')?;
    let token = |part: &str| {
        !part.is_empty()
            && part.len() <= 127
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b".+-_".contains(&b))
    };
    (token(kind) && token(subtype)).then_some(mime)
}

/// Uploads one file (base64 `data` of type `mime`) to the agent's community
/// as the agent, and returns the community's description of it.
#[tauri::command]
pub(crate) async fn app_agent_upload(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    data: String,
    mime: String,
) -> Result<Value, String> {
    use base64::Engine;
    // The type is a hint: the community sniffs the bytes and decides what it
    // accepts, as it does for the owner's own attachments.
    let mime = mime_type(&mime).ok_or("Invalid upload type")?;
    if data.len() > UPLOAD_LIMIT / 3 * 4 + 4 {
        return Err("Agents upload files up to 50 MB".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|_| "Invalid upload data")?;
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    upload(&agent, &key, bytes, &mime).await
}

/// Uploads one blob to the agent's community as the agent.
async fn upload(
    agent: &AppAgent,
    key: &Secret,
    bytes: Vec<u8>,
    mime: &str,
) -> Result<Value, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let sha256 = format!("{:x}", Sha256::digest(&bytes));
    let auth = serde_json::to_vec(&agent.upload_auth(key, &sha256)?)
        .map_err(|_| "Could not authorize upload")?;
    let response = client()?
        .put(agent.upload_url())
        .timeout(Duration::from_secs(120))
        .header("Content-Type", mime)
        .header("X-SHA-256", &sha256)
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent upload unconfirmed")?;
    let status = response.status();
    let body = bounded(response, 64 * 1024).await?;
    if !status.is_success() {
        return Err(format!(
            "The community refused the upload: {}",
            reason(status, &body)
        ));
    }
    serde_json::from_slice(&body).map_err(|_| "Invalid upload receipt".into())
}

/// The URL of repository `repo` of `owner` in the agent's community, and the
/// `Authorization` header Git sends there as the agent for the next minute.
/// The key stays native; the header grants only that repository.
#[tauri::command]
pub(crate) async fn app_agent_git_auth(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    owner: String,
    repo: String,
) -> Result<Value, String> {
    use base64::Engine;
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    let (url, auth) = agent.git_auth(&key, &owner, &repo)?;
    let auth = serde_json::to_vec(&auth).map_err(|_| "Could not authorize Git")?;
    Ok(serde_json::json!({
        "url": url,
        "header": format!(
            "Authorization: Nostr {}",
            base64::engine::general_purpose::STANDARD.encode(auth)
        ),
    }))
}

/// The largest image an agent is shown. Claude takes 5 MiB of base64 on its
/// strictest hosts, and base64 is 4 characters per 3 bytes.
const MEDIA_LIMIT: u64 = 5 * 1024 * 1024 / 4 * 3;
/// The largest file an agent saves: the community's largest upload, a video.
const MEDIA_FILE_LIMIT: u64 = 500 * 1024 * 1024;
/// Images an agent can be shown.
const SHOWN_TYPES: [&str; 4] = ["image/jpeg", "image/png", "image/gif", "image/webp"];

/// One media blob saved for an agent, and the image itself when it can be shown.
#[derive(Debug, Serialize, PartialEq)]
pub(crate) struct AgentMedia {
    path: String,
    #[serde(rename = "type")]
    mime: String,
    size: u64,
    /// Base64, only for an image within [`MEDIA_LIMIT`].
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<String>,
}

/// Downloads one of its community's media blobs (its URL or `sha256[.ext]`)
/// as the agent, of any type the community serves. It is saved to a local file
/// so the agent's own tools can open it; an image is also returned to be shown.
/// The file goes in the OS temp dir, as the Node MCP server saves it, so the OS
/// removes it later; the agent needs it only for its turn.
#[tauri::command]
pub(crate) async fn app_agent_media(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    url: String,
) -> Result<AgentMedia, String> {
    use base64::Engine;
    let dir = std::env::temp_dir().join("buzz-agent-media");
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    let url = agent.media_url(&url)?;
    let auth =
        serde_json::to_vec(&agent.media_auth(&key)?).map_err(|_| "Could not authorize media")?;
    let response = client()?
        .get(&url)
        .timeout(Duration::from_secs(600))
        .header(
            "Authorization",
            format!(
                "Nostr {}",
                base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(auth)
            ),
        )
        .header("x-auth-tag", &agent.auth)
        .send()
        .await
        .map_err(|_| "Agent media request failed")?;
    save_media(&agent, &url, response, &dir).await
}

/// Streams a media response to `dir`, named by its hash, checking the hash.
async fn save_media(
    agent: &AppAgent,
    url: &str,
    mut response: reqwest::Response,
    dir: &Path,
) -> Result<AgentMedia, String> {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    use std::io::Write;
    let status = response.status();
    if !status.is_success() {
        let body = bounded(response, 64 * 1024).await.unwrap_or_default();
        return Err(format!(
            "The community refused the media: {}",
            reason(status, &body)
        ));
    }
    let mime = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(mime_type)
        .unwrap_or_else(|| "application/octet-stream".into());
    let shown = SHOWN_TYPES.contains(&mime.as_str());
    std::fs::create_dir_all(dir).map_err(|_| "Media storage unavailable")?;
    let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|_| "Media storage unavailable")?;
    let mut hash = Sha256::new();
    let mut size = 0u64;
    let mut image = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Agent media request failed")?
    {
        size += chunk.len() as u64;
        if size > MEDIA_FILE_LIMIT {
            return Err("Media over 500 MiB cannot be saved".into());
        }
        hash.update(&chunk);
        file.write_all(&chunk)
            .map_err(|_| "Media could not be saved")?;
        if shown && size <= MEDIA_LIMIT {
            image.extend_from_slice(&chunk);
        }
    }
    agent.verify_media_hash(url, &format!("{:x}", hash.finalize()))?;
    // The blob's own name, so the same media is saved once; with an extension
    // from its type when the URL gives none.
    let mut name = url.rsplit('/').next().unwrap_or_default().to_owned();
    if !name.contains('.') {
        if let Some(ext) = mime
            .split_once('/')
            .map(|(_, subtype)| subtype)
            .filter(|ext| ext.len() <= 8 && ext.bytes().all(|b| b.is_ascii_alphanumeric()))
        {
            name = format!("{name}.{ext}");
        }
    }
    let path = dir.join(name);
    file.persist(&path)
        .map_err(|_| "Media could not be saved")?;
    Ok(AgentMedia {
        path: path.to_string_lossy().into_owned(),
        data: (shown && size <= MEDIA_LIMIT)
            .then(|| base64::engine::general_purpose::STANDARD.encode(&image)),
        mime,
        size,
    })
}

/// Writes one memory entry, encrypted to the agent's owner. `after` is the
/// `created_at` of the entry it replaces, or 0.
#[tauri::command]
pub(crate) async fn app_agent_remember(
    state: tauri::State<'_, AppAgentHost>,
    pubkey: String,
    relay: String,
    slug: String,
    body: String,
    after: u64,
) -> Result<Value, String> {
    let (agent, key) = state.key(state.agent(pubkey, relay).await?).await?;
    let signed = agent.memory(&key, &slug, &body, after)?;
    post(&agent, &key, signed).await
}

/// One client for every agent request, so frequent small posts such as
/// typing pulses reuse a connection instead of opening a new one each time.
/// Each request sets its own timeout.
fn client() -> Result<&'static reqwest::Client, String> {
    static CLIENT: OnceLock<Result<reqwest::Client, reqwest::Error>> = OnceLock::new();
    CLIENT
        .get_or_init(|| {
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(10))
                // A connection idle across sleep may be dead; open a new one.
                .pool_idle_timeout(Duration::from_secs(30))
                .build()
        })
        .as_ref()
        .map_err(|_| "Agent client unavailable".into())
}

async fn bounded(mut response: reqwest::Response, limit: usize) -> Result<Vec<u8>, String> {
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "Agent request failed")? {
        if body.len() + chunk.len() > limit {
            return Err("Agent response is too large".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Why the community refused, from its JSON body when it gives one.
fn reason(status: reqwest::StatusCode, body: &[u8]) -> String {
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    receipt
        .get("message")
        .or_else(|| receipt.get("error"))
        .and_then(Value::as_str)
        .map(|text| text.chars().take(300).collect::<String>())
        .unwrap_or_else(|| format!("status {}", status.as_u16()))
}

async fn post(agent: &AppAgent, key: &Secret, signed: Value) -> Result<Value, String> {
    let event_id = signed
        .get("id")
        .and_then(Value::as_str)
        .ok_or("Invalid agent event")?
        .to_owned();
    let bytes = serde_json::to_vec(&signed).map_err(|_| "Could not encode agent event")?;
    let response = client()?
        .post(agent.events_url())
        .timeout(Duration::from_secs(20))
        .header("Content-Type", "application/json")
        .header(
            "Authorization",
            authorization(agent.http_auth(key, &agent.events_url(), &bytes)?)?,
        )
        .header("x-auth-tag", &agent.auth)
        .body(bytes)
        .send()
        .await
        .map_err(|_| "Agent event unconfirmed; it may or may not have been accepted")?;
    let status = response.status();
    let body = response.bytes().await.unwrap_or_default();
    let receipt: Value =
        serde_json::from_slice(&body[..body.len().min(16 * 1024)]).unwrap_or(Value::Null);
    if !status.is_success()
        || receipt.get("accepted").and_then(Value::as_bool) != Some(true)
        || receipt.get("event_id").and_then(Value::as_str) != Some(event_id.as_str())
    {
        return Err(format!(
            "The community refused the agent event: {}",
            reason(status, &body)
        ));
    }
    Ok(signed)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    /// One saved key, behind a store that is busy for the first few reads.
    struct Busy(Mutex<Option<String>>, AtomicU32);
    impl Credentials for Busy {
        fn read_legacy(
            &self,
            _: buzz_agent_controller::LegacySource,
            _: &str,
        ) -> Result<Secret, String> {
            unreachable!()
        }
        fn read(&self, _: &str, pubkey: &str) -> Result<Option<Secret>, String> {
            if self.1.load(Ordering::SeqCst) > 0 {
                self.1.fetch_sub(1, Ordering::SeqCst);
                return Err(CREDENTIALS_BUSY.into());
            }
            self.0
                .lock()
                .unwrap()
                .as_ref()
                .map(|hex| Secret::parse(hex, pubkey))
                .transpose()
        }
        fn add(&self, _: &str, _: &Secret) -> Result<(), String> {
            unreachable!()
        }
        fn delete(&self, _: &str, _: &str) -> Result<(), String> {
            self.0.lock().unwrap().take();
            Ok(())
        }
    }

    #[tokio::test]
    async fn a_first_key_read_waits_out_a_busy_store() {
        let key = Secret::generate().unwrap();
        let host = AppAgentHost {
            agents: Err("unused".into()),
            old: Err("unused".into()),
            credentials: Arc::new(Busy(
                Mutex::new(Some(key.hex().to_string())),
                AtomicU32::new(3),
            )),
            keys: Arc::default(),
            profiles: Arc::default(),
            removals: Arc::default(),
            hosting: Arc::new(hosting(Err("unused".into()), true)),
        };
        let agent = AppAgent {
            pubkey: key.pubkey().into(),
            relay: "wss://relay.example".into(),
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
            deleting: false,
            home: None,
            joining: false,
            protection: None,
            protection_revision: 0,
        };
        let (_, read) = host.key(agent).await.unwrap();
        assert_eq!(read.pubkey(), key.pubkey());
    }

    #[test]
    fn a_membership_reaches_the_webview_with_its_home_and_whether_it_is_joining() {
        let key = Secret::generate().unwrap();
        let home = agent_at("wss://home.example".into(), &key);
        let summary = |agent| serde_json::to_value(AppAgentSummary::from(agent)).unwrap();
        let at_home = summary(home.clone());
        assert!(at_home.get("home").is_none() && at_home.get("joining").is_none());
        let joined = AppAgent {
            relay: "wss://other.example".into(),
            home: Some(home.relay.clone()),
            joining: true,
            ..home
        };
        let joined = summary(joined);
        assert_eq!(joined["home"], "wss://home.example");
        assert_eq!(joined["joining"], true);
    }

    #[tokio::test]
    async fn delete_waits_for_a_profile_and_refuses_a_reloaded_pages_hold() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("identities.json");
        let key = Secret::generate().unwrap();
        let agent = AppAgent {
            deleting: true,
            ..agent_at("wss://relay.example".into(), &key)
        };
        std::fs::write(&path, serde_json::to_vec(&[&agent]).unwrap()).unwrap();
        let mut host = AppAgentHost::new(Ok(path), Err("unused".into()), true);
        host.credentials = Arc::new(Busy(
            Mutex::new(Some(key.hex().to_string())),
            AtomicU32::new(0),
        ));
        let agents = host.agents().unwrap();
        host.keys().insert(agent.pubkey.clone(), Arc::new(key));
        host.removals().held.insert(
            agent.pubkey.clone(),
            agents.hold_removal(&agent.pubkey, &agent.relay).unwrap(),
        );
        let turn = host.profile_turn(&agent.pubkey);
        let publishing = turn.lock().await;
        let mut deleting = Box::pin(host.delete(agent.pubkey.clone(), agent.relay.clone()));
        // Poll through the generation capture into the held publication lock.
        assert!(matches!(
            futures_util::poll!(&mut deleting),
            std::task::Poll::Pending
        ));
        host.page_load();
        host.removals().held.insert(
            agent.pubkey.clone(),
            agents.hold_removal(&agent.pubkey, &agent.relay).unwrap(),
        );
        drop(publishing);
        assert_eq!(
            deleting.await.unwrap_err(),
            "The app reloaded while it was being removed"
        );
        assert_eq!(agents.list().unwrap(), std::slice::from_ref(&agent));
        assert!(agent.read_key(host.credentials.as_ref()).is_ok());
        assert!(host.keys().contains_key(&agent.pubkey));
        assert!(host.removals().held.contains_key(&agent.pubkey));
        // Only the current page may finish cleanup using its own hold.
        host.delete(agent.pubkey.clone(), agent.relay.clone())
            .await
            .unwrap();
        assert!(agents.list().unwrap()[0].deleted);
        assert!(agent.read_key(host.credentials.as_ref()).is_err());
        assert!(!host.keys().contains_key(&agent.pubkey));
        agents.forget(&agent.pubkey, &agent.relay).unwrap();
        assert!(agents.list().unwrap().is_empty());
    }

    /// Answers one HTTP request with `status` and `body`, and returns the
    /// request it read.
    async fn answer_once(
        status: &'static str,
        body: &'static str,
    ) -> (String, tokio::task::JoinHandle<String>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let served = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut chunk = [0; 4096];
            loop {
                let read = socket.read(&mut chunk).await.unwrap();
                request.extend_from_slice(&chunk[..read]);
                let text = String::from_utf8_lossy(&request);
                if let Some((head, rest)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_ascii_lowercase()
                                .strip_prefix("content-length: ")
                                .map(str::to_owned)
                        })
                        .and_then(|value| value.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    if rest.len() >= length {
                        break;
                    }
                }
            }
            let reply = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            socket.write_all(reply.as_bytes()).await.unwrap();
            String::from_utf8(request).unwrap()
        });
        (origin, served)
    }

    fn agent_at(relay: String, key: &Secret) -> AppAgent {
        AppAgent {
            pubkey: key.pubkey().into(),
            relay,
            owner: "a".repeat(64),
            auth: "[]".into(),
            agent_type: "p/t".into(),
            name: "Ada".into(),
            picture: None,
            profile: None,
            about: None,
            deleted: false,
            deleting: false,
            home: None,
            joining: false,
            protection: None,
            protection_revision: 0,
        }
    }

    /// Serves `body` as `mime` once, and returns the response to a GET of `path`.
    async fn media_response(
        mime: &'static str,
        body: &'static [u8],
        path: &str,
    ) -> (String, reqwest::Response) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = [0; 4096];
            let _ = socket.read(&mut request).await.unwrap();
            let head = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: {mime}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(head.as_bytes()).await.unwrap();
            socket.write_all(body).await.unwrap();
        });
        let response = reqwest::get(format!("{origin}{path}")).await.unwrap();
        (origin, response)
    }

    #[tokio::test]
    async fn media_of_any_type_is_saved_by_its_hash_and_only_images_are_shown() {
        use base64::Engine;
        use sha2::{Digest, Sha256};
        let key = Secret::generate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let video: &'static [u8] = b"\0\0\0\x18ftypmp42 not really a video";
        let sha = format!("{:x}", Sha256::digest(video));
        let path = format!("/media/{sha}");
        let (origin, response) = media_response("video/mp4", video, &path).await;
        let agent = agent_at(origin.clone(), &key);
        let saved = save_media(&agent, &format!("{origin}{path}"), response, dir.path())
            .await
            .unwrap();
        let file = dir.path().join(format!("{sha}.mp4"));
        assert_eq!(
            saved,
            AgentMedia {
                path: file.to_string_lossy().into_owned(),
                mime: "video/mp4".into(),
                size: video.len() as u64,
                data: None,
            }
        );
        assert_eq!(std::fs::read(&file).unwrap(), video);

        let image: &'static [u8] = b"\x89PNG\r\n\x1a\n pixels";
        let sha = format!("{:x}", Sha256::digest(image));
        let path = format!("/media/{sha}.png");
        let (origin, response) = media_response("image/png; charset=binary", image, &path).await;
        let saved = save_media(
            &agent_at(origin.clone(), &key),
            &format!("{origin}{path}"),
            response,
            dir.path(),
        )
        .await
        .unwrap();
        assert_eq!(saved.mime, "image/png");
        assert_eq!(
            saved.data,
            Some(base64::engine::general_purpose::STANDARD.encode(image))
        );
        assert!(saved.path.ends_with(&format!("{sha}.png")));
    }

    #[tokio::test]
    async fn media_that_does_not_match_its_hash_is_not_saved() {
        let key = Secret::generate().unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = format!("/media/{}.pdf", "0".repeat(64));
        let (origin, response) = media_response("application/pdf", b"%PDF-1.7", &path).await;
        let saved = save_media(
            &agent_at(origin.clone(), &key),
            &format!("{origin}{path}"),
            response,
            dir.path(),
        )
        .await;
        assert_eq!(saved, Err("Media did not match its SHA-256".into()));
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 0);
    }

    #[test]
    fn upload_types_are_hints_of_any_kind_but_must_be_well_formed() {
        assert_eq!(
            mime_type("Application/PDF; x=1").as_deref(),
            Some("application/pdf")
        );
        assert_eq!(
            mime_type("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
                .as_deref(),
            Some("application/vnd.openxmlformats-officedocument.wordprocessingml.document")
        );
        for bad in ["", "pdf", "a/", "/b", "a/b c", "a/b\r\nx: y"] {
            assert_eq!(mime_type(bad), None, "{bad:?}");
        }
    }

    #[tokio::test]
    async fn profile_search_posts_the_query_signed_and_returns_the_ranked_events() {
        let key = Secret::generate().unwrap();
        let (origin, served) = answer_once("200 OK", r#"[{"kind":0}]"#).await;
        let found = search_profiles(&agent_at(origin, &key), &key, "wes", 40)
            .await
            .unwrap();
        assert_eq!(found, Some(serde_json::json!([{ "kind": 0 }])));
        let request = served.await.unwrap();
        assert!(request.starts_with("POST /profiles/search HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("authorization: nostr "));
        let body: Value = serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
        assert_eq!(body, serde_json::json!({ "query": "wes", "limit": 40 }));
    }

    #[tokio::test]
    async fn profile_search_reports_a_missing_endpoint_and_fails_on_other_errors() {
        let key = Secret::generate().unwrap();
        for status in ["404 Not Found", "405 Method Not Allowed"] {
            let (origin, served) = answer_once(status, "").await;
            let found = search_profiles(&agent_at(origin, &key), &key, "wes", 40).await;
            assert_eq!(found, Ok(None), "{status}");
            served.await.unwrap();
        }
        let (origin, served) = answer_once(
            "500 Internal Server Error",
            r#"{"error":"profile search error"}"#,
        )
        .await;
        let failed = search_profiles(&agent_at(origin, &key), &key, "wes", 40).await;
        assert_eq!(
            failed,
            Err("The community refused the profile search: profile search error".into())
        );
        served.await.unwrap();
    }

    fn hosting(dir: Result<PathBuf, String>, packaged: bool) -> Hosting {
        Hosting {
            packaged_dir: dir.clone(),
            dir,
            packaged,
            held: Mutex::default(),
        }
    }

    #[test]
    fn protection_changes_require_current_and_exclusive_hosting() {
        let dir = tempfile::tempdir().unwrap();
        let agent = "a".repeat(64);
        let dev = hosting(Ok(dir.path().join("hosts")), false);
        let packaged = hosting(Ok(dir.path().join("hosts")), true);
        assert!(dev.protecting(&agent, || Ok(())).is_err());
        assert!(dev.claim(&agent).unwrap());
        assert!(dev.protecting(&agent, || Ok(())).is_ok());
        assert!(packaged.claim(&agent).unwrap());
        // A packaged takeover alone does not mean the dev process has stopped.
        assert!(packaged.protecting(&agent, || Ok(())).is_err());
        assert!(dev.protecting(&agent, || Ok(())).is_err());
        assert!(!dev.claim(&agent).unwrap());
        assert!(packaged.protecting(&agent, || Ok(())).is_ok());
    }

    #[test]
    fn one_copy_runs_each_agent_until_it_lets_go() {
        let dir = tempfile::tempdir().unwrap();
        let (first, second) = ("a".repeat(64), "b".repeat(64));
        let one = hosting(Ok(dir.path().join("hosts")), false);
        let other = hosting(Ok(dir.path().join("hosts")), false);
        assert!(one.claim(&first).unwrap());
        assert!(one.claim(&first).unwrap());
        assert!(!other.claim(&first).unwrap());
        assert!(other.claim(&second).unwrap());
        // As when that copy quits.
        drop(one);
        assert!(other.claim(&first).unwrap());
        assert!(other.claim("../x").is_err());
    }

    #[test]
    fn a_packaged_app_runs_what_it_can_and_dev_builds_let_go() {
        let dir = tempfile::tempdir().unwrap();
        let (agent, other) = ("a".repeat(64), "b".repeat(64));
        let dev = hosting(Ok(dir.path().join("hosts")), false);
        let packaged = hosting(Ok(dir.path().join("hosts")), true);
        assert!(dev.claim(&agent).unwrap());
        assert!(dev.claim(&other).unwrap());
        // The packaged app runs it at once, though the dev build had it first,
        assert!(packaged.claim(&agent).unwrap());
        // and the dev build lets go at its next claim.
        assert!(!dev.claim(&agent).unwrap());
        assert!(packaged.claim(&agent).unwrap());
        // A second dev build cannot take it either.
        let another = hosting(Ok(dir.path().join("hosts")), false);
        assert!(!another.claim(&agent).unwrap());
        // One the packaged app does not ask for stays with the dev build.
        assert!(dev.claim(&other).unwrap());
        // As when it can no longer run it.
        packaged.held().remove(&agent);
        assert!(dev.claim(&agent).unwrap());
        assert!(!another.claim(&agent).unwrap());
    }

    #[test]
    fn dev_builds_let_go_while_the_installed_app_runs_an_agent() {
        let data = tempfile::tempdir().unwrap();
        let list = |identifier: &str| {
            Ok(data
                .path()
                .join(identifier)
                .join(sign_out::AGENTS)
                .join("identities.json"))
        };
        let agent = "a".repeat(64);
        let dev = Hosting::new(&list(legacy_identifier::DEV), false);
        assert!(dev.claim(&agent).unwrap());
        // Before an update's first launch moves it, release storage may still be
        // under the legacy identifier; a dev build creating the new one would
        // make that launch refuse to start.
        assert!(!data.path().join(legacy_identifier::CURRENT).exists());
        let packaged = Hosting::new(&list(legacy_identifier::CURRENT), true);
        assert!(packaged.claim(&agent).unwrap());
        assert!(!dev.claim(&agent).unwrap());
        let another = Hosting::new(&list(legacy_identifier::DEV), false);
        assert!(!another.claim(&agent).unwrap());
        // As when the installed app quits.
        drop(packaged);
        assert!(dev.claim(&agent).unwrap());
        assert!(!another.claim(&agent).unwrap());
    }
}
