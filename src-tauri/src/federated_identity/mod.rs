//! One native authority session owner. Secrets and adapter responses never cross IPC.
pub(crate) mod agent;
pub(crate) mod assertion;
pub(crate) mod config;
pub(crate) mod protocol;
pub(crate) mod socket;
pub(crate) mod store;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use config::Config;
use protocol::{expiry, now, Failure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};
use store::Store;
use tauri::{Emitter, Manager};
use tauri_plugin_opener::OpenerExt;
use tokio::sync::{watch, Mutex as AsyncMutex};
use tokio_util::sync::CancellationToken;
use zeroize::{Zeroize, Zeroizing};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Authority {
    id: String,
    identity_origin: String,
    api_base_path: String,
}
#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum Status {
    Unconfigured,
    SignedOut,
    SigningIn,
    Restoring,
    SignedIn,
    ReauthenticationRequired,
    Unavailable,
}
/// Why the signed-in account changed, for owners of state derived from it
/// (agent grants). Expiry and refresh keep the same account; only an explicit
/// sign-out or a different account mean derived state must go.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum SessionChange {
    SignedOut,
    AccountChanged,
    Expired,
    Refreshed,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Snapshot {
    status: Status,
    authority: Option<Authority>,
    revision: String,
    email: Option<String>,
    failure: Option<&'static str>,
}

// No Debug, no IPC serialization. Only the secure store serializes this record.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Record {
    version: u8,
    fingerprint: String,
    pub(super) revision: String,
    session_token: String,
    expires_at: String,
    email: Option<String>,
}
impl Drop for Record {
    fn drop(&mut self) {
        self.session_token.zeroize();
    }
}
struct Session {
    record: Record,
    raw: Zeroizing<Vec<u8>>,
}
#[derive(Clone)]
struct CallbackGuard(crate::oauth_callback::OAuthCallbackHost, String);
impl Drop for CallbackGuard {
    fn drop(&mut self) {
        let _ = self.0.cancel(&self.1);
    }
}
struct State {
    snapshot: Snapshot,
    session: Option<Arc<Session>>,
    restored: bool,
    closed: bool,
    cancellation: CancellationToken,
    callback: Option<CallbackGuard>,
    /// Last account seen signed in this run; tells a refresh from a new account.
    account: Option<Option<String>>,
    /// Bumped with every explicit sign-out, close or change of account, under
    /// the same lock as the change itself: derived agent credentials minted
    /// or stored under an older value are retired.
    retirements: u64,
}
struct Inner {
    config: Option<Config>,
    fingerprint: String,
    #[allow(dead_code)] // Consumed by the agent token client.
    account: String,
    store: Arc<dyn Store>,
    state: Mutex<State>,
    operation: AsyncMutex<()>,
    changes: watch::Sender<Snapshot>,
    account_changes: watch::Sender<Option<SessionChange>>,
    assertions: Mutex<assertion::AssertionCache>,
    discoveries: Mutex<assertion::DiscoveryCache>,
}
#[derive(Clone)]
pub(crate) struct FederatedIdentity(Arc<Inner>);

impl FederatedIdentity {
    pub(crate) fn new() -> Result<Self, String> {
        let config = option_env!("BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG")
            .filter(|raw| !raw.is_empty())
            .map(Config::parse)
            .transpose()?;
        let profile = std::env::var("BUZZODZ_PROFILE").unwrap_or_else(|_| "default".into());
        if profile.is_empty() || profile.len() > 128 {
            return Err("Invalid federated identity profile".into());
        }
        let fingerprint = format!(
            "{:x}",
            Sha256::digest(
                serde_json::to_vec(&config)
                    .map_err(|_| "Invalid federated identity configuration")?
            )
        );
        let account = format!("{:x}", Sha256::digest(format!("{profile}\0{fingerprint}")));
        let store = Arc::new(store::SecureStore {
            account: account.clone(),
            root: store::root()?,
        });
        Ok(Self::with_store(config, fingerprint, account, store))
    }
    fn with_store(
        config: Option<Config>,
        fingerprint: String,
        account: String,
        store: Arc<dyn Store>,
    ) -> Self {
        let snapshot = Snapshot {
            status: if config.is_some() {
                Status::Restoring
            } else {
                Status::Unconfigured
            },
            authority: config.as_ref().map(|c| Authority {
                id: c.id.clone(),
                identity_origin: c.identity_origin.clone(),
                api_base_path: c.api_base_path.clone(),
            }),
            revision: uuid::Uuid::new_v4().to_string(),
            email: None,
            failure: None,
        };
        let (changes, _) = watch::channel(snapshot.clone());
        let (account_changes, _) = watch::channel(None);
        Self(Arc::new(Inner {
            config,
            fingerprint,
            account,
            store,
            state: Mutex::new(State {
                snapshot,
                session: None,
                restored: false,
                closed: false,
                retirements: 0,
                cancellation: CancellationToken::new(),
                callback: None,
                account: None,
            }),
            operation: AsyncMutex::new(()),
            changes,
            account_changes,
            assertions: Mutex::new(Default::default()),
            discoveries: Mutex::new(Default::default()),
        }))
    }
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.0
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn publish(&self, state: &State) {
        self.0.changes.send_replace(state.snapshot.clone());
    }
    /// A build without NIP-FI configuration.
    #[cfg(test)]
    pub(crate) fn unconfigured() -> Self {
        let store = Arc::new(tests::Memory::default());
        Self::with_store(None, String::new(), String::new(), store)
    }
    pub(crate) fn snapshot(&self) -> Snapshot {
        self.state().snapshot.clone()
    }
    pub(crate) fn watch<R: tauri::Runtime>(&self, app: tauri::AppHandle<R>) {
        let mut changes = self.0.changes.subscribe();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                let snapshot = changes.borrow_and_update().clone();
                let _ = app.emit_to("main", "federated-identity", snapshot);
            }
        });
    }
    pub(crate) fn cancellation_for(&self, revision: &str) -> Result<CancellationToken, String> {
        let state = self.state();
        if state.closed || state.snapshot.revision != revision {
            return Err("Federated session changed".into());
        }
        Ok(state.cancellation.clone())
    }
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn account_changes(&self) -> watch::Receiver<Option<SessionChange>> {
        self.0.account_changes.subscribe()
    }
    fn signal(&self, change: SessionChange) {
        self.0.account_changes.send_replace(Some(change));
    }
    /// Record a newly installed session's account and report refresh vs change.
    fn signed_in(&self, state: &mut State, email: Option<String>) {
        let change = match &state.account {
            Some(previous) if *previous != email => {
                state.retirements += 1;
                SessionChange::AccountChanged
            }
            _ => SessionChange::Refreshed,
        };
        state.account = Some(email);
        self.signal(change);
    }
    /// Lend the current session token to `use_session` without letting it escape.
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn with_session<T>(
        &self,
        use_session: impl FnOnce(&Zeroizing<String>, &str, &Config) -> T,
    ) -> Option<T> {
        let config = self.0.config.as_ref()?;
        let (token, revision) = {
            let state = self.state();
            let session = state.session.as_ref().filter(|_| !state.closed)?;
            (
                Zeroizing::new(session.record.session_token.clone()),
                state.snapshot.revision.clone(),
            )
        };
        Some(use_session(&token, &revision, config))
    }
    /// Secure-store account for an agent grant in this profile and deployment.
    #[allow(dead_code)] // Consumed by the agent token client.
    pub(crate) fn agent_grant_key(&self, owner: &str, agent: &str) -> String {
        store::agent_grant_key(&self.0.account, owner, agent)
    }
    /// How many times derived agent credentials have been retired this run.
    pub(crate) fn retirements(&self) -> u64 {
        self.state().retirements
    }
    pub(crate) fn current(&self, revision: &str) -> bool {
        let state = self.state();
        !state.closed && state.snapshot.revision == revision
    }
    fn retire(
        &self,
        status: Status,
        failure: Option<&'static str>,
    ) -> (Option<Arc<Session>>, String) {
        let mut state = self.state();
        let session = self.retire_state(&mut state, status, failure);
        (session, state.snapshot.revision.clone())
    }
    fn change_current(&self, revision: &str, status: Status, failure: Option<&'static str>) {
        let mut state = self.state();
        if state.closed || state.snapshot.revision != revision {
            return;
        }
        state.snapshot.status = status;
        state.snapshot.failure = failure;
        self.publish(&state);
    }
    fn retire_state(
        &self,
        state: &mut State,
        status: Status,
        failure: Option<&'static str>,
    ) -> Option<Arc<Session>> {
        self.0
            .assertions
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clear();
        state.cancellation.cancel();
        // Synchronous cleanup lets a replacement login register immediately.
        state.callback.take();
        state.cancellation = CancellationToken::new();
        state.snapshot.revision = uuid::Uuid::new_v4().to_string();
        state.snapshot.status = status;
        state.snapshot.email = None;
        state.snapshot.failure = failure;
        let session = state.session.take();
        self.publish(state);
        session
    }
    pub(crate) fn close(&self) {
        self.clear_discoveries();
        let mut state = self.state();
        self.retire_state(&mut state, Status::SignedOut, None);
        state.closed = true;
        state.retirements += 1;
    }
    async fn storage<T: Send + 'static>(
        &self,
        run: impl FnOnce(Arc<dyn Store>) -> Result<T, &'static str> + Send + 'static,
    ) -> Result<T, Failure> {
        let store = self.0.store.clone();
        tauri::async_runtime::spawn_blocking(move || run(store))
            .await
            .map_err(|_| Failure::from("storage-unavailable"))?
            .map_err(Failure::from)
    }
    async fn remove(&self, session: Arc<Session>) -> Result<(), Failure> {
        self.storage(move |store| store.remove(&session.raw, &session.record.revision))
            .await
    }
    async fn verify(&self, record: &Record) -> Result<Option<String>, Failure> {
        if expiry(&record.expires_at)? <= now()? {
            return Err(Failure {
                code: "reauthentication-required",
                session_denied: true,
            });
        }
        #[derive(Deserialize)]
        struct Checked {
            expires_at: String,
            email: Option<String>,
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        let client = protocol::client()?;
        let result: Checked = protocol::json(|| {
            client
                .get(config.endpoint("/v1/session"))
                .bearer_auth(&record.session_token)
        })
        .await?;
        let expected = chrono::DateTime::parse_from_rfc3339(&record.expires_at)
            .map_err(|_| "invalid-expiry")?;
        let actual = chrono::DateTime::parse_from_rfc3339(&result.expires_at)
            .map_err(|_| "invalid-expiry")?;
        if expected != actual || actual.timestamp() <= now()? {
            return Err("expiry-mismatch".into());
        }
        if result
            .email
            .as_ref()
            .is_some_and(|email| email.len() > 1024)
        {
            return Err("invalid-response".into());
        }
        Ok(result.email)
    }
    pub(crate) async fn restore(&self) -> Snapshot {
        {
            let state = self.state();
            let expired = state.session.as_ref().is_some_and(|session| {
                matches!((expiry(&session.record.expires_at), now()), (Ok(expiry), Ok(now)) if expiry <= now)
            });
            if self.0.config.is_none() || state.closed || (state.restored && !expired) {
                return state.snapshot.clone();
            }
        }
        let _operation = self.0.operation.lock().await;
        self.restore_locked().await;
        self.snapshot()
    }
    // Return this operation's revision so callers can fence concurrent retirement.
    async fn restore_locked(&self) -> String {
        let (expired, revision) = {
            let mut state = self.state();
            let expired = state.session.as_ref().is_some_and(|session| {
                matches!((expiry(&session.record.expires_at), now()), (Ok(expiry), Ok(now)) if expiry <= now)
            });
            let session = if expired {
                self.signal(SessionChange::Expired);
                self.retire_state(
                    &mut state,
                    Status::ReauthenticationRequired,
                    Some("reauthentication-required"),
                )
                .map(|session| (session, state.snapshot.revision.clone()))
            } else {
                None
            };
            (session, state.snapshot.revision.clone())
        };
        if let Some((session, revision)) = expired {
            if let Err(failure) = self.remove(session).await {
                self.change_current(&revision, Status::Unavailable, Some(failure.code));
            }
        }
        if self.0.config.is_none() || self.state().restored || self.state().closed {
            return revision;
        }
        self.change_current(&revision, Status::Restoring, None);
        let result = async {
            let (raw, refusal) = self.storage(|store| store.load()).await?;
            let Some(raw) = raw else {
                return Ok(None);
            };
            if raw.len() > 64 * 1024 {
                return Err("storage-corrupt".into());
            }
            let mut record: Record =
                serde_json::from_slice(&raw).map_err(|_| Failure::from("storage-corrupt"))?;
            if record.version != 1
                || record.fingerprint != self.0.fingerprint
                || uuid::Uuid::parse_str(&record.revision).is_err()
                || record.session_token.is_empty()
                || record.session_token.len() > 4096
                || !record.session_token.bytes().all(|b| b.is_ascii_graphic())
            {
                return Err("storage-corrupt".into());
            }
            let refused = refusal.as_deref() == Some(&record.revision);
            let session = Arc::new(Session { record, raw });
            if refused {
                self.remove(session).await?;
                return Ok(None);
            }
            let checked = self.verify(&session.record).await;
            match checked {
                Ok(email) => {
                    record = serde_json::from_slice(&session.raw)
                        .map_err(|_| Failure::from("storage-corrupt"))?;
                    record.email = email;
                    Ok(Some(Arc::new(Session {
                        record,
                        raw: session.raw.clone(),
                    })))
                }
                Err(failure) if failure.session_denied => {
                    self.remove(session).await?;
                    Err(failure)
                }
                Err(failure) => Err(failure),
            }
        }
        .await;
        let mut state = self.state();
        if state.snapshot.revision != revision || state.closed {
            return revision;
        }
        state.restored = true;
        match result {
            Ok(Some(session)) => {
                state.snapshot.status = Status::SignedIn;
                state.snapshot.revision = session.record.revision.clone();
                state.snapshot.email = session.record.email.clone();
                self.signed_in(&mut state, session.record.email.clone());
                state.session = Some(session);
            }
            Ok(None) => state.snapshot.status = Status::SignedOut,
            Err(failure) => {
                if failure.session_denied {
                    self.signal(SessionChange::Expired);
                }
                state.snapshot.status = if failure.session_denied {
                    Status::ReauthenticationRequired
                } else {
                    Status::Unavailable
                };
                state.snapshot.failure = Some(failure.code);
                // A failed read or check is not permission to overwrite unknown state.
                state.restored = failure.session_denied;
            }
        }
        self.publish(&state);
        revision
    }
    pub(crate) async fn sign_in<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> Snapshot {
        let observed = self.snapshot();
        if observed.status == Status::SigningIn {
            return observed;
        }
        let operation = self.0.operation.lock().await;
        if !self.current(&observed.revision) {
            return self.snapshot();
        }
        let observed = self.restore_locked().await;
        let (revision, cancel) = {
            let mut state = self.state();
            if state.closed
                || state.snapshot.revision != observed
                || !state.restored
                || state.session.is_some()
                || self.0.config.is_none()
            {
                return state.snapshot.clone();
            }
            // Admission and retirement are atomic with cancellation/sign-out.
            self.retire_state(&mut state, Status::SigningIn, None);
            (state.snapshot.revision.clone(), state.cancellation.clone())
        };
        let result = self.login(app, &revision, &cancel, operation).await;
        if let Err(failure) = result {
            self.change_current(&revision, Status::SignedOut, Some(failure.code));
        }
        self.snapshot()
    }
    async fn login<R: tauri::Runtime>(
        &self,
        app: &tauri::AppHandle<R>,
        revision: &str,
        cancel: &CancellationToken,
        operation: tokio::sync::MutexGuard<'_, ()>,
    ) -> Result<(), Failure> {
        if cancel.is_cancelled() {
            return Err("sign-in-canceled".into());
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        let mut bytes = Zeroizing::new([0u8; 32]);
        getrandom::fill(bytes.as_mut()).map_err(|_| "random-unavailable")?;
        let secret = Zeroizing::new(URL_SAFE_NO_PAD.encode(bytes.as_ref()));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()));
        let mut login = config.endpoint("/v1/login/start");
        login
            .query_pairs_mut()
            .append_pair("handoff_challenge", &challenge)
            .append_pair("handoff_challenge_method", "S256");
        let callback = app.state::<crate::oauth_callback::OAuthCallbackHost>();
        let attempt = callback
            .begin_federated(login.to_string(), |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| "browser-unavailable".into())
            })
            .map_err(|_| "browser-unavailable")?;
        // Drop guards cancel only this callback when the whole login future is canceled.
        let _guard = CallbackGuard(callback.inner().clone(), attempt.id.clone());
        {
            let mut state = self.state();
            if state.closed || state.snapshot.revision != revision || cancel.is_cancelled() {
                return Err("sign-in-canceled".into());
            }
            state.callback = Some(_guard.clone());
        }
        // Serialize callback registration, not the user's browser interaction.
        drop(operation);
        let response = tokio::select! {
            _ = cancel.cancelled() => Err(Failure::from("sign-in-canceled")),
            result = callback.wait(&attempt.id) => result.map_err(|error| Failure::from(if error == "Sign-in canceled." { "sign-in-canceled" } else { "callback-refused" })),
        };
        {
            let mut state = self.state();
            if state
                .callback
                .as_ref()
                .is_some_and(|guard| guard.1 == attempt.id)
            {
                state.callback.take();
            }
        }
        let response = response?;
        if response.parameters.iter().any(|(name, _)| name == "error") {
            return Err("login-refused".into());
        }
        let mut codes = response
            .parameters
            .into_iter()
            .filter(|(name, _)| name == "code");
        let code = Zeroizing::new(codes.next().ok_or("callback-refused")?.1);
        if codes.next().is_some() || code.is_empty() || code.len() > 4096 {
            return Err("callback-refused".into());
        }
        self.finish_login(code.as_str(), secret.as_str(), revision, cancel)
            .await
    }

    // Verified exchange and conditional installation form one native transaction.
    async fn finish_login(
        &self,
        code: &str,
        secret: &str,
        revision: &str,
        cancel: &CancellationToken,
    ) -> Result<(), Failure> {
        if cancel.is_cancelled() || !self.current(revision) {
            return Err("session-changed".into());
        }
        let config = self.0.config.as_ref().ok_or("unconfigured")?;
        #[derive(Deserialize)]
        struct Exchanged {
            session_token: String,
            expires_at: String,
        }
        impl Drop for Exchanged {
            fn drop(&mut self) {
                self.session_token.zeroize();
            }
        }
        let body = Zeroizing::new(
            serde_json::to_string(&serde_json::json!({"code":code,"handoff_secret":secret}))
                .map_err(|_| "invalid-request")?,
        );
        let client = protocol::client()?;
        let exchange: Exchanged = tokio::select! {
            _ = cancel.cancelled() => return Err("sign-in-canceled".into()),
            result = protocol::json(|| client.post(config.endpoint("/v1/login/exchange")).header("Content-Type", "application/json").body(body.as_str().to_owned())) => result?,
        };
        if exchange.session_token.is_empty()
            || exchange.session_token.len() > 4096
            || !exchange.session_token.bytes().all(|b| b.is_ascii_graphic())
        {
            return Err("invalid-response".into());
        }
        let mut record = Record {
            version: 1,
            fingerprint: self.0.fingerprint.clone(),
            revision: uuid::Uuid::new_v4().to_string(),
            session_token: exchange.session_token.clone(),
            expires_at: exchange.expires_at.clone(),
            email: None,
        };
        record.email = tokio::select! {
            _ = cancel.cancelled() => return Err("sign-in-canceled".into()),
            result = self.verify(&record) => result?,
        };
        // Persistence/install/late cleanup still serialize with sign-out.
        let _operation = self.0.operation.lock().await;
        if cancel.is_cancelled() || !self.current(revision) {
            return Err("session-changed".into());
        }
        let raw = Zeroizing::new(serde_json::to_vec(&record).map_err(|_| "storage-corrupt")?);
        let session = Arc::new(Session { record, raw });
        let saved = session.clone();
        self.storage(move |store| store.compare(None, Some(&saved.raw)))
            .await?;
        if !self.current(revision) {
            self.remove(session).await?;
            return Err("session-changed".into());
        }
        let installed = {
            let mut state = self.state();
            if state.snapshot.revision == revision && !state.closed {
                state.snapshot.status = Status::SignedIn;
                state.snapshot.revision = session.record.revision.clone();
                state.snapshot.email = session.record.email.clone();
                self.signed_in(&mut state, session.record.email.clone());
                state.session = Some(session.clone());
                self.publish(&state);
                true
            } else {
                false
            }
        };
        if !installed {
            self.remove(session).await?;
            return Err("session-changed".into());
        }
        Ok(())
    }
    pub(crate) fn cancel_sign_in(&self) {
        let mut state = self.state();
        if state.snapshot.status == Status::SigningIn {
            self.retire_state(&mut state, Status::SignedOut, None);
        }
    }
    pub(crate) async fn sign_out(&self) -> Snapshot {
        let (session, revision) = self.retire(Status::SignedOut, None);
        {
            let mut state = self.state();
            state.account = None;
            state.retirements += 1;
        }
        self.signal(SessionChange::SignedOut);
        let _operation = self.0.operation.lock().await;
        let result = if let Some(session) = session {
            self.remove(session).await
        } else {
            // Also retries an incomplete deletion or sign-out during restore.
            self.storage(|store| {
                if let Some(raw) = store.read()? {
                    let record: Record =
                        serde_json::from_slice(&raw).map_err(|_| "storage-corrupt")?;
                    store.remove(&raw, &record.revision)?;
                }
                Ok(())
            })
            .await
        };
        if let Err(failure) = result {
            self.change_current(&revision, Status::Unavailable, Some(failure.code));
        }
        self.snapshot()
    }
}

#[tauri::command]
pub(crate) async fn federated_identity_snapshot(
    host: tauri::State<'_, FederatedIdentity>,
) -> Result<Snapshot, String> {
    Ok(host.restore().await)
}
#[tauri::command]
pub(crate) async fn federated_identity_sign_in<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, FederatedIdentity>,
) -> Result<Snapshot, String> {
    Ok(host.sign_in(&app).await)
}
#[tauri::command]
pub(crate) fn federated_identity_cancel_sign_in(host: tauri::State<'_, FederatedIdentity>) {
    host.cancel_sign_in();
}
#[tauri::command]
pub(crate) async fn federated_identity_sign_out(
    tokens: tauri::State<'_, agent::AgentTokens>,
) -> Result<Snapshot, String> {
    tokens.sign_out().await
}

#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
