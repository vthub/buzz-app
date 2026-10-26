//! Agent token client: each local agent's NIP-FI grant and the agent assertion
//! JWTs it mints. The native app holds both; nothing crosses IPC.

pub(crate) mod grant;

use super::{
    config::canonical_relay,
    protocol::{self, now, Failure},
    FederatedIdentity, SessionChange, Snapshot,
};
use base64::{
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
    Engine,
};
use buzz_agent_controller::{AppAgent, Secret};
use grant::{Grant, GrantStore, SecureGrantStore};
use serde::Deserialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as AsyncMutex;
use zeroize::Zeroizing;

const GRANT_PATH: &str = "/v1/nip-fi/agent-grant";
const ASSERTION_PATH: &str = "/v1/nip-fi/agent-assertion";
const GRANT_TOKEN_TYPE: &str = "urn:builderlab:params:oauth:token-type:nip-fi-agent-grant";
const SIGN_IN: &str = "Sign in to your organization to enroll this agent";
const STOPPED: &str =
    "Your organization no longer accepts this agent; sign in again to re-enroll it";
const CHANGED: &str = "Your organization sign-in changed; try again";
const DELETED: &str = "This agent was deleted";

/// Lists every agent's owner and pubkey, for retiring all grants at once.
type Agents = dyn Fn() -> Result<Vec<(String, String)>, String> + Send + Sync;

#[derive(Clone)]
pub(crate) struct AgentTokens(Arc<Inner>);
struct Inner {
    identity: FederatedIdentity,
    store: Arc<dyn GrantStore>,
    /// One turn per agent, so concurrent requests share one enrollment.
    slots: Mutex<HashMap<String, Arc<AsyncMutex<Slot>>>>,
    /// Each agent's current incarnation. Deletion closes it, so requests that
    /// read the agent before then are refused; an import opens the next one.
    incarnations: Mutex<HashMap<String, Incarnation>>,
    /// Grant writes and retirements are one transaction under this lock: every
    /// write checks it, and a retirement is recorded and wiped under it.
    retired: Arc<Mutex<Retired>>,
    /// Serializes wipes and organization sign-out, so none clears the durable
    /// record of a retirement whose wipe is still to come.
    wiping: AsyncMutex<()>,
    agents: std::sync::OnceLock<Arc<Agents>>,
    /// Signalled when the next sign-out waits for a grant write holding `retired`.
    #[cfg(test)]
    contended: Mutex<Option<std::sync::mpsc::Sender<()>>>,
}
#[derive(Default)]
struct Retired {
    /// The owner's retirements whose grant wipe has completed.
    wiped: u64,
    /// Whether a durable retirement record awaits its wipe; unknown until read
    /// from storage, once per process, before any grant is admitted.
    pending: Option<bool>,
}
#[derive(Clone, Copy, Default)]
struct Incarnation {
    generation: u64,
    closed: bool,
}
#[derive(Default)]
struct Slot {
    assertion: Option<Cached>,
    /// Its grant was refused and the one re-enrollment failed: it stays
    /// stopped, without retrying, until the owner signs in again.
    stopped: bool,
}
/// One minted assertion, reused until shortly before it expires.
struct Cached {
    /// The owner's retirements when it was minted; any later one retires it.
    retirements: u64,
    /// The account that enrolled its grant; any other signed-in account retires it.
    account: String,
    relay: String,
    header: Zeroizing<String>,
    refresh_at: u64,
}

impl AgentTokens {
    pub(crate) fn new(identity: FederatedIdentity) -> Self {
        Self::with_store(identity, Arc::new(SecureGrantStore))
    }
    /// Tokens for a build without an organization: agents send no evidence.
    #[cfg(test)]
    pub(crate) fn unconfigured() -> Self {
        Self::with_store(
            FederatedIdentity::unconfigured(),
            Arc::new(grant::tests::MemoryGrants::default()),
        )
    }
    fn with_store(identity: FederatedIdentity, store: Arc<dyn GrantStore>) -> Self {
        Self(Arc::new(Inner {
            identity,
            store,
            slots: Mutex::default(),
            incarnations: Mutex::default(),
            retired: Arc::default(),
            wiping: AsyncMutex::default(),
            agents: std::sync::OnceLock::new(),
            #[cfg(test)]
            contended: Mutex::default(),
        }))
    }
    fn slot(&self, agent: &str) -> Arc<AsyncMutex<Slot>> {
        lock(&self.0.slots).entry(agent.into()).or_default().clone()
    }
    async fn storage<T: Send + 'static>(
        &self,
        run: impl FnOnce(&dyn GrantStore) -> Result<T, &'static str> + Send + 'static,
    ) -> Result<T, String> {
        let store = self.0.store.clone();
        tauri::async_runtime::spawn_blocking(move || run(store.as_ref()))
            .await
            .map_err(|_| "Secure storage is unavailable")?
            .map_err(str::to_owned)
    }
    /// The BB account last seen signed in, if any. It outlives that session's
    /// expiry, so a grant another account enrolled stays refused meanwhile.
    fn account(&self) -> Option<String> {
        let state = self.0.identity.state();
        state.account.clone().flatten().filter(|_| !state.closed)
    }
    /// The signed-in BB account, if any.
    fn signed_in(&self) -> Option<String> {
        let state = self.0.identity.state();
        state
            .session
            .as_ref()
            .filter(|_| !state.closed)
            .and_then(|session| session.record.email.clone())
    }
    fn grant_key(&self, agent: &AppAgent) -> String {
        self.0.identity.agent_grant_key(&agent.owner, &agent.pubkey)
    }
    /// The durable retirement record's key; no owner pubkey takes this form.
    fn retiring_key(&self) -> String {
        self.0.identity.agent_grant_key("retiring", "")
    }

    /// The agent's current incarnation, taken before a request reads the agent
    /// and passed to `evidence`.
    pub(crate) fn incarnation(&self, agent: &str) -> u64 {
        lock(&self.0.incarnations)
            .get(agent)
            .map_or(0, |at| at.generation)
    }
    #[cfg(test)]
    pub(crate) fn closed(&self, agent: &str) -> bool {
        !self.live(agent, self.incarnation(agent))
    }
    fn live(&self, agent: &str, incarnation: u64) -> bool {
        let at = lock(&self.0.incarnations).get(agent).copied();
        at.unwrap_or_default().generation == incarnation && !at.is_some_and(|at| at.closed)
    }
    /// An authorized import installed the agent again: requests taken from now
    /// on work, while ones from before its deletion stay refused. Returns the
    /// installation's incarnation.
    pub(crate) fn reopen(&self, agent: &str) -> u64 {
        let mut incarnations = lock(&self.0.incarnations);
        let at = incarnations.entry(agent.into()).or_default();
        if at.closed {
            *at = Incarnation {
                generation: at.generation + 1,
                closed: false,
            };
        }
        at.generation
    }

    /// The `Nostr-Federated-Identity` value for the agent's requests to its
    /// community, or `None` when that community is not the organization's.
    /// Concurrent requests share one enrollment and one mint.
    pub(crate) async fn evidence(
        &self,
        agent: &AppAgent,
        key: &Secret,
        incarnation: u64,
    ) -> Result<Option<Zeroizing<String>>, String> {
        let Some(config) = self.0.identity.0.config.as_ref() else {
            return Ok(None);
        };
        if !config.matches_relay(&agent.relay)? {
            return Ok(None);
        }
        let relay = canonical_relay(&agent.relay)?;
        let slot = self.slot(&agent.pubkey);
        let mut slot = slot.lock().await;
        if !self.live(&agent.pubkey, incarnation) {
            return Err(DELETED.into());
        }
        let retirements = self.admit().await?;
        let now = now()? as u64;
        let account = self.account();
        if let Some(cached) = &slot.assertion {
            if cached.retirements == retirements
                && account
                    .as_ref()
                    .is_none_or(|account| *account == cached.account)
                && cached.relay == relay
                && cached.refresh_at > now
            {
                return Ok(Some(cached.header.clone()));
            }
        }
        if slot.stopped {
            return Err(STOPPED.into());
        }
        slot.assertion = None;
        let grant = self
            .grant(agent, key, retirements)
            .await
            .map_err(|error| error.message)?;
        let cached = match self.mint(agent, key, &grant, relay.clone()).await {
            Err(failure) if failure.code == "grant-refused" && grant.replacement => {
                // The one re-enrollment's grant is refused as well.
                slot.stopped = true;
                self.retire(agent).await?;
                return Err(STOPPED.into());
            }
            Err(failure) if failure.code == "grant-refused" => {
                // Retire the refused grant for good, then enroll once more.
                // The replacement is stored marked as such until it mints, so
                // its refusal stops the agent even after a transient failure
                // or a restart in between. Any other failure is reported as
                // it is, and the next request enrolls lazily.
                drop(grant);
                if let Err(error) = self.retire(agent).await {
                    // Kept, the refused grant would be recovered on every call.
                    slot.stopped = true;
                    return Err(error);
                }
                let grant = match self.enrolled(agent, key, retirements, true).await {
                    Ok(grant) => grant,
                    Err(error) if error.refused => {
                        slot.stopped = true;
                        return Err(STOPPED.into());
                    }
                    Err(error) => return Err(error.message),
                };
                match self.mint(agent, key, &grant, relay).await {
                    Ok(cached) => {
                        self.settle(agent, grant, retirements).await?;
                        cached
                    }
                    Err(failure) if failure.code == "grant-refused" => {
                        slot.stopped = true;
                        self.retire(agent).await?;
                        return Err(STOPPED.into());
                    }
                    Err(failure) => return Err(refused(failure.code)),
                }
            }
            Ok(cached) if grant.replacement => {
                self.settle(agent, grant, retirements).await?;
                cached
            }
            minted => minted.map_err(|failure| refused(failure.code))?,
        };
        if !self.live(&agent.pubkey, incarnation) {
            return Err(DELETED.into());
        }
        if self.0.identity.retirements() != retirements
            || self
                .account()
                .is_some_and(|account| account != cached.account)
        {
            return Err(CHANGED.into());
        }
        let header = cached.header.clone();
        slot.assertion = Some(Cached {
            retirements,
            ..cached
        });
        Ok(Some(header))
    }

    /// The owner's current retirement count, once every grant from before it
    /// is wiped, including a retirement recorded durably before a restart. An
    /// explicit sign-out or account change bumps the count synchronously, so no
    /// request is admitted on retired credentials even before the watcher runs.
    async fn admit(&self) -> Result<u64, String> {
        loop {
            let current = self.0.identity.retirements();
            {
                let retired = lock(&self.0.retired);
                if retired.wiped == current && retired.pending == Some(false) {
                    return Ok(current);
                }
            }
            let _wiping = self.0.wiping.lock().await;
            self.wipe(current).await?;
        }
    }
    /// With `wiping` held: deletes every agent's grant if a retirement awaits
    /// it, then records `upto` as wiped and clears the durable record. A failed
    /// wipe records nothing, so the next request retries it.
    async fn wipe(&self, upto: u64) -> Result<(), String> {
        let (retired, at) = (self.0.retired.clone(), self.retiring_key());
        let pending = self
            .storage(move |store| {
                let mut retired = lock(&retired);
                if retired.pending.is_none() {
                    retired.pending = Some(store.pending(&at)?);
                }
                Ok(retired.pending == Some(true) || retired.wiped < upto)
            })
            .await?;
        if !pending {
            return Ok(());
        }
        // Cached assertions carry the count and account they were minted
        // under, so they are already unusable; only stored grants need deleting.
        let keys = self.grant_keys().await?;
        let (retired, at) = (self.0.retired.clone(), self.retiring_key());
        self.storage(move |store| {
            let mut retired = lock(&retired);
            keys.iter().try_for_each(|key| store.delete(key))?;
            store.set_pending(&at, false)?;
            *retired = Retired {
                wiped: retired.wiped.max(upto),
                pending: Some(false),
            };
            Ok(())
        })
        .await
    }

    /// Every agent's grant key.
    async fn grant_keys(&self) -> Result<Vec<String>, String> {
        let agents = self
            .0
            .agents
            .get()
            .cloned()
            .ok_or("Agents are unavailable")?;
        Ok(tauri::async_runtime::spawn_blocking(move || agents())
            .await
            .map_err(|_| "Agents are unavailable")??
            .into_iter()
            .map(|(owner, agent)| self.0.identity.agent_grant_key(&owner, &agent))
            .collect())
    }
    /// Once an account is seen signed in, retires every grant if any was
    /// enrolled by another account. Recorded durably first, as sign-out is, so
    /// neither that session ending nor a restart lets the old grant mint again.
    async fn reconcile(&self) -> Result<(), String> {
        let Some(account) = self.account() else {
            return Ok(());
        };
        let _wiping = self.0.wiping.lock().await;
        let keys = self.grant_keys().await?;
        let (retired, at) = (self.0.retired.clone(), self.retiring_key());
        let foreign = self
            .storage(move |store| {
                let mut retired = lock(&retired);
                for key in &keys {
                    if store
                        .read(key)?
                        .is_some_and(|grant| !grant.usable_with(Some(&account)))
                    {
                        store.set_pending(&at, true)?;
                        retired.pending = Some(true);
                        return Ok(true);
                    }
                }
                Ok(false)
            })
            .await?;
        if foreign {
            self.wipe(self.0.identity.retirements()).await?;
        }
        Ok(())
    }

    /// Signs the owner out of the organization and retires every agent's grant
    /// with it. The retirement is recorded durably first, under the grant-write
    /// lock, so a write already past its check lands before it and is wiped,
    /// and a cleanup interrupted by failure or restart finishes before any
    /// grant is admitted again. Without that record nothing is signed out.
    pub(crate) async fn sign_out(&self) -> Result<Snapshot, String> {
        let _wiping = self.0.wiping.lock().await;
        let (retired, at) = (self.0.retired.clone(), self.retiring_key());
        #[cfg(test)]
        let contended = lock(&self.0.contended).take();
        self.storage(move |store| {
            #[cfg(test)]
            if let (Err(std::sync::TryLockError::WouldBlock), Some(contended)) =
                (retired.try_lock().map(drop), contended)
            {
                let _ = contended.send(());
            }
            let mut retired = lock(&retired);
            store.set_pending(&at, true)?;
            retired.pending = Some(true);
            Ok(())
        })
        .await?;
        let snapshot = self.0.identity.sign_out().await;
        self.wipe(self.0.identity.retirements()).await?;
        Ok(snapshot)
    }

    /// Trades the grant for a short-lived agent assertion for `relay`.
    async fn mint(
        &self,
        agent: &AppAgent,
        key: &Secret,
        grant: &Grant,
        relay: String,
    ) -> Result<Cached, Failure> {
        let config = self.0.identity.0.config.as_ref().ok_or("unconfigured")?;
        let endpoint = config.endpoint(ASSERTION_PATH);
        // Field order and exact bytes are the NIP-FA assertion request contract.
        let body =
            serde_json::json!({ "nostr_pubkey": agent.pubkey, "relay_url": relay }).to_string();
        let proof = || {
            agent
                .issuer_auth(key, endpoint.as_str(), body.as_bytes())
                .and_then(nostr)
        };
        proof().map_err(|_| "invalid-proof")?;
        #[derive(Deserialize)]
        struct Issued {
            assertion: String,
            nostr_pubkey: String,
            expires_at: u64,
        }
        let client = protocol::client()?;
        let issued: Issued = protocol::json(|| {
            let request = client
                .post(endpoint.clone())
                .bearer_auth(&grant.token)
                .header("Content-Type", "application/json")
                .body(body.clone());
            match proof() {
                Ok(proof) => request.header("Nostr-Authorization", proof),
                Err(_) => request,
            }
        })
        .await?;
        let assertion = Zeroizing::new(issued.assertion);
        let now = now()? as u64;
        if issued.nostr_pubkey != agent.pubkey || issued.expires_at <= now {
            return Err("invalid-assertion".into());
        }
        validate(&assertion, agent, grant, &relay, issued.expires_at, now)?;
        Ok(Cached {
            header: Zeroizing::new(format!("Bearer {}", assertion.as_str())),
            // One with 30s or less to live is used once, never reused.
            refresh_at: issued.expires_at.saturating_sub(30),
            retirements: 0,
            account: grant.account.clone(),
            relay,
        })
    }

    /// Retires a deleted agent's grant. Its incarnation closes at once, so a
    /// request in flight or queued for it is refused rather than enrolling it
    /// again; the grant is deleted once that request has settled.
    pub(crate) async fn forget(&self, owner: &str, agent: &str) -> Result<(), String> {
        lock(&self.0.incarnations)
            .entry(agent.into())
            .or_default()
            .closed = true;
        let slot = self.slot(agent);
        let mut slot = slot.lock().await;
        slot.assertion = None;
        let at = self.0.identity.agent_grant_key(owner, agent);
        self.storage(move |store| store.delete(&at)).await
    }

    /// Follows the owner's account: an explicit sign-out or another account,
    /// including a first sign-in other than the one that enrolled a grant,
    /// retires every agent's grant (`agents` lists each owner and agent), and
    /// any new sign-in lets a stopped agent enroll again. Expiry keeps grants.
    /// Requests check the retirement count themselves; this only wipes early.
    pub(crate) fn watch(
        &self,
        agents: impl Fn() -> Result<Vec<(String, String)>, String> + Send + Sync + 'static,
    ) {
        let _ = self.0.agents.set(Arc::new(agents));
        let tokens = self.clone();
        let mut changes = self.0.identity.account_changes();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                let change = changes.borrow_and_update().clone();
                if let Err(error) = tokens.follow(change).await {
                    eprintln!("Agent grants were not retired: {error}");
                }
            }
        });
    }
    async fn follow(&self, change: Option<SessionChange>) -> Result<(), String> {
        if matches!(
            change,
            Some(SessionChange::Refreshed | SessionChange::AccountChanged)
        ) {
            let slots: Vec<_> = lock(&self.0.slots).values().cloned().collect();
            for slot in slots {
                slot.lock().await.stopped = false;
            }
        }
        self.admit().await?;
        // On every change: a sign-in and its expiry may arrive as one.
        self.reconcile().await
    }

    async fn retire(&self, agent: &AppAgent) -> Result<(), String> {
        let at = self.grant_key(agent);
        self.storage(move |store| store.delete(&at)).await
    }

    /// The agent's grant, enrolling it on first use: new agents and ones made
    /// before enrollment existed alike.
    async fn grant(
        &self,
        agent: &AppAgent,
        key: &Secret,
        retirements: u64,
    ) -> Result<Grant, Error> {
        let (at, account) = (self.grant_key(agent), self.account());
        if let Some(grant) = self
            .storage(move |store| grant::load(store, &at, account.as_deref()))
            .await?
        {
            return Ok(grant);
        }
        self.enrolled(agent, key, retirements, false).await
    }
    /// Enrolls the agent and stores its grant, unless the owner's credentials
    /// were retired meanwhile.
    async fn enrolled(
        &self,
        agent: &AppAgent,
        key: &Secret,
        retirements: u64,
        replacement: bool,
    ) -> Result<Grant, Error> {
        let mut grant = self.enroll(agent, key).await?;
        grant.replacement = replacement;
        Ok(self.commit(agent, grant, retirements).await?)
    }
    /// The replacement grant minted: it is an ordinary grant from now on.
    async fn settle(
        &self,
        agent: &AppAgent,
        mut grant: Grant,
        retirements: u64,
    ) -> Result<(), String> {
        grant.replacement = false;
        self.commit(agent, grant, retirements).await.map(drop)
    }
    /// Stores `grant` in the retirement transaction: only if no retirement was
    /// counted since `retirements` was admitted, nor recorded and not yet wiped.
    async fn commit(
        &self,
        agent: &AppAgent,
        grant: Grant,
        retirements: u64,
    ) -> Result<Grant, String> {
        let (at, identity, retired) = (
            self.grant_key(agent),
            self.0.identity.clone(),
            self.0.retired.clone(),
        );
        self.storage(move |store| {
            let retired = lock(&retired);
            if retired.pending != Some(false) || identity.retirements() != retirements {
                return Err(CHANGED);
            }
            store.write(&at, &grant).map(|()| grant)
        })
        .await
    }

    /// Exchanges the owner's BB session for a grant for this agent (RFC 8693),
    /// proven by the owner's NIP-OA tag and the agent's own signature. Only the
    /// session that started it may install the result.
    async fn enroll(&self, agent: &AppAgent, key: &Secret) -> Result<Grant, Error> {
        let identity = &self.0.identity;
        let account = self.signed_in().ok_or(SIGN_IN)?;
        let (form, revision, endpoint) = identity
            .with_session(|token, revision, config| {
                let form = url::form_urlencoded::Serializer::new(String::new())
                    .append_pair(
                        "grant_type",
                        "urn:ietf:params:oauth:grant-type:token-exchange",
                    )
                    .append_pair("subject_token", token)
                    .append_pair(
                        "subject_token_type",
                        "urn:builderlab:params:oauth:token-type:bb-session",
                    )
                    .append_pair("requested_token_type", GRANT_TOKEN_TYPE)
                    .append_pair("agent_pubkey", &agent.pubkey)
                    .append_pair("runtime", "local")
                    .append_pair("owner_attestation", &agent.auth)
                    .finish();
                (
                    Zeroizing::new(form),
                    revision.to_owned(),
                    config.endpoint(GRANT_PATH),
                )
            })
            .ok_or(SIGN_IN)?;
        if form.len() > 8192 {
            return Err("This agent's enrollment is too large".into());
        }
        let cancel = identity.cancellation_for(&revision)?;
        // Each attempt is signed anew: the issuer refuses a replayed proof.
        let proof = || nostr(agent.issuer_auth(key, endpoint.as_str(), form.as_bytes())?);
        proof()?;
        let client = protocol::client()?;
        #[derive(Deserialize)]
        struct Enrolled {
            access_token: String,
            issued_token_type: String,
            token_type: String,
            nostr_owner_pubkey: String,
            nip_fi_issuer: String,
        }
        let request = protocol::json::<Enrolled>(|| {
            let request = client
                .post(endpoint.clone())
                .header("Content-Type", "application/x-www-form-urlencoded")
                .body(form.as_bytes().to_vec());
            match proof() {
                Ok(proof) => request.header("Nostr-Agent-Proof", proof),
                Err(_) => request,
            }
        });
        let enrolled = tokio::select! {
            () = cancel.cancelled() => return Err(CHANGED.into()),
            enrolled = request => enrolled.map_err(Error::from)?,
        };
        let token = Zeroizing::new(enrolled.access_token);
        if !identity.current(&revision) {
            return Err(CHANGED.into());
        }
        if enrolled.issued_token_type != GRANT_TOKEN_TYPE
            || enrolled.token_type != "N_A"
            || enrolled.nostr_owner_pubkey != agent.owner
            || enrolled.nip_fi_issuer.is_empty()
            || token.is_empty()
            || token.len() > 1024
            || token.chars().any(char::is_whitespace)
        {
            return Err("Your organization returned an invalid agent enrollment".into());
        }
        Ok(Grant::new(
            agent.owner.clone(),
            agent.pubkey.clone(),
            account,
            enrolled.nip_fi_issuer,
            token.to_string(),
        ))
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A NIP-98 `Nostr` header value for one signed HTTP auth event.
fn nostr(event: serde_json::Value) -> Result<String, String> {
    serde_json::to_vec(&event)
        .map(|event| format!("Nostr {}", STANDARD.encode(event)))
        .map_err(|_| "Could not authorize the agent".into())
}

/// Local misuse checks on an agent assertion; the relay verifies its signature.
fn validate(
    token: &str,
    agent: &AppAgent,
    grant: &Grant,
    relay: &str,
    expires_at: u64,
    now: u64,
) -> Result<(), Failure> {
    let invalid = || Failure::from("invalid-assertion");
    let parts: Vec<_> = token.split('.').collect();
    if token.len() > 8192 || parts.len() != 3 || parts.iter().any(|part| part.is_empty()) {
        return Err(invalid());
    }
    let decode = |part: &str| -> Result<serde_json::Value, Failure> {
        let bytes = Zeroizing::new(URL_SAFE_NO_PAD.decode(part).map_err(|_| invalid())?);
        serde_json::from_slice(&bytes).map_err(|_| invalid())
    };
    let (header, claims) = (decode(parts[0])?, decode(parts[1])?);
    let text = |name: &str| claims.get(name).and_then(serde_json::Value::as_str);
    let minted = claims.get("iat").and_then(serde_json::Value::as_u64);
    let audience = format!("https://{}", &relay["wss://".len()..]);
    if header.get("typ").and_then(serde_json::Value::as_str) != Some("nip-fi-agent+jwt")
        || text("nostr_pubkey") != Some(&agent.pubkey)
        || text("nostr_owner_pubkey") != Some(&agent.owner)
        || text("iss") != Some(&grant.issuer)
        || text("aud") != Some(&audience)
        || claims.get("exp").and_then(serde_json::Value::as_u64) != Some(expires_at)
        || !minted.is_some_and(|minted| minted <= now + 5 && minted <= expires_at)
    {
        return Err(invalid());
    }
    Ok(())
}

/// A failed enrollment, and whether the organization refused it (rather than
/// being unreachable, or the owner not being signed in).
#[derive(Debug)]
struct Error {
    message: String,
    refused: bool,
}
impl From<String> for Error {
    fn from(message: String) -> Self {
        Self {
            message,
            refused: false,
        }
    }
}
impl From<&str> for Error {
    fn from(message: &str) -> Self {
        message.to_owned().into()
    }
}
impl From<Failure> for Error {
    fn from(failure: Failure) -> Self {
        Self {
            message: refused(failure.code),
            refused: matches!(
                failure.code,
                "adapter-refused"
                    | "authorization-denied"
                    | "binding-mismatch"
                    | "invalid-proof"
                    | "grant-refused"
            ),
        }
    }
}

/// What the agent's owner sees when the identity issuer turns it away.
fn refused(code: &'static str) -> String {
    match code {
        "network-unavailable" | "network-timeout" => {
            "Your organization's identity service is unreachable".into()
        }
        code => format!("Your organization refused this agent ({code})"),
    }
}

#[cfg(test)]
pub(crate) mod tests;
