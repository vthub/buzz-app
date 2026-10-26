//! Purpose-bound native backup and optional recovery. No key or recovery credential crosses IPC.
mod crypto;
mod persistence;
pub(crate) use persistence::root as storage_root;

use crate::{
    identity::IdentityHost,
    nsec_backup_config::Config,
    oauth_callback::{OAuthCallbackHost, OAuthRequest},
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use buzz_nsec_backup::{Client, Recovery};
use secp256k1::{PublicKey, Secp256k1, SecretKey, XOnlyPublicKey};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::async_runtime::JoinHandle;
use tauri_plugin_opener::OpenerExt;
use tokio::sync::oneshot;
use zeroize::Zeroizing;

const RETRY: &str = "Could not restore your identity. Try again.";
const CANCELED: &str = "Restore was canceled. Try again.";
const UNAVAILABLE: &str = "Backup recovery is unavailable. Try again later.";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub(crate) enum Source {
    Builderlab,
    Hosted,
}
impl Source {
    fn index(self) -> usize {
        match self {
            Self::Builderlab => 0,
            Self::Hosted => 1,
        }
    }
}

#[derive(Clone)]
struct Session {
    source: Source,
    credential: Zeroizing<String>,
}
struct Candidate {
    handle: String,
    pubkey: String,
    backup_id: String,
    secret: Box<Zeroizing<[u8; 32]>>,
}
#[derive(Serialize)]
pub(crate) struct PublicCandidate {
    handle: String,
    pubkey: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    candidates: Vec<PublicCandidate>,
    current_pubkey: Option<String>,
    failed_count: usize,
}
#[derive(Serialize)]
pub(crate) struct RestoreStarted {
    attempt: String,
}
struct Restore {
    id: String,
    admission: Arc<Mutex<bool>>,
    callback: OAuthCallbackHost,
    callback_id: String,
    task: JoinHandle<()>,
    result: Option<oneshot::Receiver<Result<RestoreResult>>>,
    candidates: Vec<Candidate>,
    current: Option<String>,
    credential: Option<Zeroizing<String>>,
    subject: Option<String>,
    installing: bool,
}
impl Drop for Restore {
    fn drop(&mut self) {
        *self.admission.lock().unwrap_or_else(|e| e.into_inner()) = false;
        self.task.abort();
        let _ = self.callback.cancel(&self.callback_id);
    }
}
#[derive(Default)]
struct State {
    closed: bool,
    epoch: u64,
    generations: [Option<u64>; 2],
    sessions: Vec<Session>,
    worker: Option<JoinHandle<()>>,
    rerun: bool,
    restore: Option<Restore>,
    restore_epoch: u64,
}
impl State {
    fn retire(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.rerun = false;
        if let Some(worker) = self.worker.take() {
            worker.abort();
        }
    }
    fn retire_restore(&mut self) {
        self.restore_epoch = self.restore_epoch.wrapping_add(1);
        self.restore.take();
    }
}
#[derive(Clone)]
pub(crate) struct NsecBackupHost {
    state: Arc<Mutex<State>>,
    config: Arc<Option<Config>>,
    root: Option<PathBuf>,
}
impl Default for NsecBackupHost {
    fn default() -> Self {
        let config = crate::nsec_backup_config::configured(
            option_env!("BUZZ_NSEC_BACKUP_SERVICE_URL"),
            option_env!("BUZZ_NSEC_BACKUP_NAMESPACE"),
        )
        .ok()
        .flatten();
        Self {
            state: Default::default(),
            config: Arc::new(config),
            // Default test hosts never access the OS account's backup directory.
            root: if cfg!(test) { None } else { storage_root() },
        }
    }
}
impl NsecBackupHost {
    pub(crate) async fn set_choice(
        &self,
        identity: IdentityHost,
        pubkey: &str,
        automatic: bool,
    ) -> Result<crate::nsec_backup_choice::BackupChoice> {
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        let path = self.root.as_ref().ok_or(UNAVAILABLE)?.join("choice.json");
        let choice =
            crate::nsec_backup_choice::set(&identity, &path, config, pubkey, automatic).await?;
        if automatic {
            self.trigger(identity);
        }
        Ok(choice)
    }
    pub(crate) fn document_load(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.retire();
        state.retire_restore();
        state.sessions.clear();
        // Source counters restart with each renderer document.
        state.generations = [None, None];
    }
    pub(crate) fn close(&self) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        state.closed = true;
        state.retire();
        state.retire_restore();
        state.sessions.clear();
    }
    pub(crate) fn local_key_installed(&self, identity: IdentityHost) {
        if let Ok(mut state) = self.state.lock() {
            state.retire();
            state.retire_restore();
        }
        self.trigger(identity);
    }
    fn valid(&self, epoch: u64) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.epoch != epoch {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    }
    fn source_allowed(&self, source: Source) -> bool {
        source_allowed_for(
            source,
            self.config.as_ref().as_ref(),
            buzzodz_plugins::BUILDERLAB_ORIGIN,
            buzzodz_plugins::BUILDERLAB_API_BASE_PATH,
        )
    }
    fn session(
        &self,
        source: Source,
        generation: u64,
        credential: Option<String>,
        identity: IdentityHost,
    ) -> Result<()> {
        // Reject a foreign service before copying a caller's already-held credential.
        let credential = credential.map(Zeroizing::new);
        if !self.source_allowed(source) {
            return Ok(());
        }
        if credential.as_ref().is_some_and(|c| !valid_credential(c)) {
            return Err("Invalid backup session".into());
        }
        let mut state = self.state.lock().map_err(|_| "Backup unavailable")?;
        if state.closed {
            return Ok(());
        }
        let previous = state.generations[source.index()];
        if previous.is_some_and(|seen| generation <= seen) {
            return Ok(());
        }
        state.generations[source.index()] = Some(generation);
        let active = state.sessions.last().is_some_and(|s| s.source == source);
        state.sessions.retain(|s| s.source != source);
        if credential.is_none() && !active {
            return Ok(());
        }
        state.retire();
        if let Some(credential) = credential {
            state.sessions.push(Session { source, credential });
        }
        drop(state);
        self.trigger(identity);
        Ok(())
    }
    fn retry(&self, source: Source, identity: IdentityHost) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        let Some(index) = state.sessions.iter().position(|s| s.source == source) else {
            return;
        };
        if index + 1 != state.sessions.len() {
            state.retire();
            let session = state.sessions.remove(index);
            state.sessions.push(session);
        }
        drop(state);
        self.trigger(identity);
    }
    fn trigger(&self, identity: IdentityHost) {
        if self.config.is_none() || self.root.is_none() {
            return;
        }
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        if state.closed {
            return;
        }
        if state
            .worker
            .as_ref()
            .is_some_and(|task| !task.inner().is_finished())
        {
            state.rerun = true;
            return;
        }
        let Some(session) = state.sessions.last().cloned() else {
            return;
        };
        let epoch = state.epoch;
        state.rerun = false;
        let host = self.clone();
        state.worker = Some(tauri::async_runtime::spawn(async move {
            loop {
                if host.backup(&identity, &session, epoch).await.is_err() {
                    eprintln!("Automatic identity backup deferred");
                }
                let Ok(mut state) = host.state.lock() else {
                    return;
                };
                if state.closed || state.epoch != epoch {
                    return;
                }
                // Consume overlapping lifecycle events in this worker, without a timer.
                if std::mem::take(&mut state.rerun) {
                    continue;
                }
                state.worker = None;
                return;
            }
        }));
    }
    async fn backup(&self, identity: &IdentityHost, session: &Session, epoch: u64) -> Result<()> {
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        self.valid(epoch)?;
        let pubkey = identity.viewer().await?;
        let consent = crate::nsec_backup_choice::read(
            &self.root.as_ref().ok_or(UNAVAILABLE)?.join("choice.json"),
            config,
            &pubkey,
        )?;
        if consent.automatic != Some(true) {
            return Ok(());
        }
        // Hold consent's shared lease until this pass ends, including persisted retries.
        self.valid(epoch)?;
        let api = Api::new(&config.service_url, &session.credential)?;
        let account = api.me().await?;
        self.valid(epoch)?;
        let current = api.current().await?;
        if current.as_deref() != Some(&pubkey) {
            return Err("Backup identity mismatch".into());
        }
        let locked = {
            let state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed || state.epoch != epoch {
                return Err(CANCELED.into());
            }
            persistence::LockedRecord::open(
                self.root.as_ref().ok_or(RETRY)?,
                config,
                &account.subject,
                &pubkey,
            )?
        };
        self.valid(epoch)?;
        let record = locked.read()?;
        if let Some(record) = record.as_ref() {
            record.matches_identity(config, &account.subject, &pubkey)?;
            if record.envelope.is_none() {
                return Ok(());
            }
        }
        let client = Client::new(&config.service_url, &session.credential).map_err(|_| RETRY)?;
        let enrollment = client.enroll().await.map_err(|_| RETRY)?;
        self.valid(epoch)?;
        crypto::validate_enrollment(
            &enrollment,
            &config.namespace,
            &enrollment.owner_id,
            &pubkey,
        )?;
        let mut record = match record {
            Some(record) if record.matches(config, &account.subject, &enrollment)? => record,
            _ => {
                let mut record = persistence::Record::new(config, &account.subject, &enrollment);
                let namespace = config.namespace.clone();
                let expected = pubkey.clone();
                let owner = enrollment.owner_id.clone();
                let bytes = identity
                    .with_key(move |secret, local| {
                        if local != expected {
                            return Err("Backup identity mismatch".into());
                        }
                        crypto::seal(&enrollment, &namespace, &owner, local, secret)
                    })
                    .await?;
                record.envelope = Some(String::from_utf8(bytes).map_err(|_| RETRY)?);
                let state = self.state.lock().map_err(|_| RETRY)?;
                if state.closed || state.epoch != epoch {
                    return Err(CANCELED.into());
                }
                locked.write(&record)?;
                drop(state);
                record
            }
        };
        let Some(envelope) = record.envelope.as_ref() else {
            return Ok(());
        };
        self.valid(epoch)?;
        let receipt = client
            .upload(envelope.as_bytes())
            .await
            .map_err(|_| RETRY)?;
        if !receipt.stored || receipt.backup_id != record.backup_id {
            return Err("Backup receipt mismatch".into());
        }
        let state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.epoch != epoch {
            return Err(CANCELED.into());
        }
        record.envelope = None;
        locked.write(&record)?;
        Ok(())
    }
    fn valid_restore(&self, epoch: u64) -> Result<()> {
        let state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.restore_epoch != epoch {
            Err(CANCELED.into())
        } else {
            Ok(())
        }
    }
    async fn begin<R: tauri::Runtime>(
        &self,
        identity: IdentityHost,
        callback: OAuthCallbackHost,
        app: tauri::AppHandle<R>,
    ) -> Result<RestoreStarted> {
        let epoch = {
            let state = self.state.lock().map_err(|_| RETRY)?;
            if state.closed {
                return Err(CANCELED.into());
            }
            state.restore_epoch
        };
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        identity.require_missing().await?;
        let mut random = Zeroizing::new([0u8; 32]);
        getrandom::fill(random.as_mut()).map_err(|_| RETRY)?;
        let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(random.as_ref()));
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut login =
            url::Url::parse(&format!("{}/v1/auth/login", config.service_url)).map_err(|_| RETRY)?;
        login
            .query_pairs_mut()
            .append_pair("type", "cli")
            .append_pair("product", "buzz")
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        let mut state = self.state.lock().map_err(|_| RETRY)?;
        if state.closed || state.restore_epoch != epoch {
            return Err(CANCELED.into());
        }
        if state.restore.is_some() {
            return Err("A restore is already in progress".into());
        }
        let oauth = callback.begin(
            OAuthRequest {
                authorization_url: login.into(),
                callback_path: format!("/callback/{}", uuid::Uuid::new_v4()),
                use_state: Some(true),
            },
            |url| {
                app.opener()
                    .open_url(url, None::<&str>)
                    .map_err(|_| RETRY.to_owned())
            },
        )?;
        let id = uuid::Uuid::new_v4().to_string();
        let (send, receive) = oneshot::channel();
        let admission = Arc::new(Mutex::new(true));
        let host = self.clone();
        let worker_id = id.clone();
        let oauth_id = oauth.id.clone();
        let worker_callback = callback.clone();
        let task = tauri::async_runtime::spawn(async move {
            let result = host
                .recover(
                    epoch,
                    &worker_id,
                    worker_callback,
                    oauth_id,
                    oauth.callback_url,
                    verifier,
                )
                .await;
            let _ = send.send(result);
        });
        state.restore = Some(Restore {
            id: id.clone(),
            admission,
            callback,
            callback_id: oauth.id,
            task,
            result: Some(receive),
            candidates: Vec::new(),
            current: None,
            credential: None,
            subject: None,
            installing: false,
        });
        Ok(RestoreStarted { attempt: id })
    }
    async fn recover(
        &self,
        epoch: u64,
        id: &str,
        callback: OAuthCallbackHost,
        oauth_id: String,
        redirect: String,
        verifier: Zeroizing<String>,
    ) -> Result<RestoreResult> {
        let parameters = callback.wait(&oauth_id).await.map_err(|_| RETRY)?;
        self.valid_restore(epoch)?;
        if parameters
            .parameters
            .iter()
            .any(|(name, _)| name == "error")
        {
            return Err(RETRY.into());
        }
        let mut codes = parameters
            .parameters
            .iter()
            .filter(|(name, _)| name == "code");
        let code = codes.next().map(|(_, code)| code.as_str()).ok_or(RETRY)?;
        if codes.next().is_some() {
            return Err(RETRY.into());
        }
        let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
        let credential = Api::exchange(&config.service_url, code, &verifier, &redirect).await?;
        let api = Api::new(&config.service_url, &credential)?;
        let account = api.me().await?;
        self.valid_restore(epoch)?;
        let current = api.current().await?;
        let client = Client::new(&config.service_url, &credential).map_err(|_| RETRY)?;
        let recovered = client.recover().await.map_err(|error| match error {
            buzz_nsec_backup::Error::HttpStatus(404) => UNAVAILABLE.to_owned(),
            _ => RETRY.to_owned(),
        })?;
        let (candidates, failed_count) = candidates(recovered);
        let summary = RestoreResult {
            candidates: candidates
                .iter()
                .map(|key| PublicCandidate {
                    handle: key.handle.clone(),
                    pubkey: key.pubkey.clone(),
                })
                .collect(),
            current_pubkey: current.clone(),
            failed_count,
        };
        let mut state = self.state.lock().map_err(|_| CANCELED)?;
        if state.closed || state.restore_epoch != epoch {
            return Err(CANCELED.into());
        }
        let attempt = state
            .restore
            .as_mut()
            .filter(|attempt| attempt.id == id)
            .ok_or(CANCELED)?;
        attempt.candidates = candidates;
        attempt.current = current;
        attempt.credential = Some(credential);
        attempt.subject = Some(account.subject);
        Ok(summary)
    }
    async fn wait(&self, id: &str) -> Result<RestoreResult> {
        let receive = self
            .state
            .lock()
            .map_err(|_| CANCELED)?
            .restore
            .as_mut()
            .filter(|attempt| attempt.id == id)
            .and_then(|attempt| attempt.result.take())
            .ok_or(CANCELED)?;
        receive.await.map_err(|_| CANCELED.to_owned())?
    }
    fn cancel(&self, id: &str) {
        let mut state = self.state.lock().unwrap_or_else(|e| e.into_inner());
        if state
            .restore
            .as_ref()
            .is_some_and(|attempt| attempt.id == id)
        {
            state.restore.take();
        }
    }
    async fn install(&self, identity: IdentityHost, id: &str, handle: &str) -> Result<String> {
        let (pubkey, backup_id, credential, subject, current, admission, epoch) = {
            let mut state = self.state.lock().map_err(|_| CANCELED)?;
            if state.closed {
                return Err(CANCELED.into());
            }
            let epoch = state.restore_epoch;
            let attempt = state
                .restore
                .as_mut()
                .filter(|attempt| attempt.id == id && !attempt.installing)
                .ok_or(CANCELED)?;
            let key = attempt
                .candidates
                .iter()
                .find(|key| key.handle == handle)
                .ok_or("Choose an identity to restore")?;
            let credential = attempt.credential.clone().ok_or(CANCELED)?;
            let subject = attempt.subject.clone().ok_or(CANCELED)?;
            attempt.installing = true;
            (
                key.pubkey.clone(),
                key.backup_id.clone(),
                credential,
                subject,
                attempt.current.clone(),
                attempt.admission.clone(),
                epoch,
            )
        };
        let result = async {
            let config = self.config.as_ref().as_ref().ok_or(UNAVAILABLE)?;
            let api = Api::new(&config.service_url, &credential)?;
            if api.current().await? != current {
                return Err("Your account identity changed. Sign in again.".into());
            }
            self.valid_restore(epoch)?;
            let secret = {
                let state = self.state.lock().map_err(|_| CANCELED)?;
                let attempt = state
                    .restore
                    .as_ref()
                    .filter(|attempt| attempt.id == id)
                    .ok_or(CANCELED)?;
                let key = attempt
                    .candidates
                    .iter()
                    .find(|key| key.handle == handle)
                    .ok_or(CANCELED)?;
                if self
                    .root
                    .as_ref()
                    .ok_or_else(|| RETRY.to_owned())
                    .and_then(|root| {
                        persistence::remember_restored(root, config, &subject, &pubkey, &backup_id)
                    })
                    .is_err()
                {
                    eprintln!("Automatic identity backup completion deferred");
                }
                Zeroizing::new(**key.secret)
            };
            self.valid_restore(epoch)?;
            identity
                .install_recovered(secret, pubkey.clone(), admission)
                .await
        }
        .await;
        if result.is_ok() {
            let mut state = self.state.lock().map_err(|_| CANCELED)?;
            if !state.closed
                && state.restore_epoch == epoch
                && state
                    .restore
                    .as_ref()
                    .is_some_and(|attempt| attempt.id == id)
            {
                state.restore.take();
            }
            drop(state);
            self.trigger(identity);
        } else if let Ok(mut state) = self.state.lock() {
            if let Some(attempt) = state.restore.as_mut().filter(|attempt| attempt.id == id) {
                attempt.installing = false;
            }
        }
        result
    }
}

fn source_allowed_for(
    source: Source,
    config: Option<&Config>,
    builderlab_origin: &str,
    builderlab_api_base_path: &str,
) -> bool {
    let Some(config) = config else {
        return false;
    };
    match source {
        Source::Hosted => config.service_url == "https://app.builderlab.xyz/api/goose",
        Source::Builderlab => url::Url::parse(&config.service_url)
            .ok()
            .is_some_and(|url| {
                let path = format!("{}/", url.path().trim_end_matches('/'));
                !builderlab_origin.is_empty()
                    && url.origin().ascii_serialization() == builderlab_origin
                    && path == builderlab_api_base_path
            }),
    }
}

fn valid_credential(value: &str) -> bool {
    !value.is_empty() && value.len() <= 4096 && value.bytes().all(|c| (33..=126).contains(&c))
}
fn public_key(value: &str) -> Result<String> {
    let public: XOnlyPublicKey = value.parse().map_err(|_| RETRY)?;
    if public.to_string() != value {
        return Err(RETRY.into());
    }
    Ok(value.to_owned())
}
fn candidates(recovered: Recovery) -> (Vec<Candidate>, usize) {
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    let mut failed = recovered.failed_backup_ids.len();
    for backup in recovered.backups {
        let verified = (|| -> Result<String> {
            if uuid::Uuid::parse_str(&backup.backup_id)
                .map_err(|_| RETRY)?
                .to_string()
                != backup.backup_id
            {
                return Err(RETRY.into());
            }
            let mut scalar = SecretKey::from_byte_array(*backup.secret_key()).map_err(|_| RETRY)?;
            let derived = PublicKey::from_secret_key(&Secp256k1::signing_only(), &scalar)
                .x_only_public_key()
                .0
                .to_string();
            scalar.non_secure_erase();
            if derived != public_key(&backup.nostr_pubkey)? {
                return Err(RETRY.into());
            }
            Ok(derived)
        })();
        match verified {
            Ok(pubkey) if seen.insert(pubkey.clone()) => candidates.push(Candidate {
                handle: uuid::Uuid::new_v4().to_string(),
                pubkey,
                backup_id: backup.backup_id.clone(),
                secret: Box::new(Zeroizing::new(*backup.secret_key())),
            }),
            Ok(_) => {}
            Err(_) => failed += 1,
        }
    }
    (candidates, failed)
}

#[derive(Deserialize)]
struct Account {
    subject: String,
    expires_at: String,
}
#[derive(Deserialize)]
struct Exchange {
    #[serde(deserialize_with = "credential")]
    session_credential: Zeroizing<String>,
}
fn credential<'de, D: serde::Deserializer<'de>>(
    input: D,
) -> std::result::Result<Zeroizing<String>, D::Error> {
    let value = Zeroizing::new(String::deserialize(input)?);
    if !valid_credential(&value) {
        return Err(serde::de::Error::custom("Invalid session"));
    }
    Ok(value)
}
struct Api {
    http: reqwest::Client,
    root: String,
    credential: reqwest::header::HeaderValue,
}
impl Api {
    fn new(root: &str, credential: &str) -> Result<Self> {
        let mut header = reqwest::header::HeaderValue::from_str(credential).map_err(|_| RETRY)?;
        header.set_sensitive(true);
        Ok(Self {
            http: Self::http(root)?,
            root: root.to_owned(),
            credential: header,
        })
    }
    fn http(root: &str) -> Result<reqwest::Client> {
        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .timeout(Duration::from_secs(30));
        if root.starts_with("http:") {
            builder = builder.no_proxy();
        }
        builder.build().map_err(|_| RETRY.into())
    }
    async fn exchange(
        root: &str,
        code: &str,
        verifier: &str,
        redirect: &str,
    ) -> Result<Zeroizing<String>> {
        #[derive(Serialize)]
        struct Request<'a> {
            code: &'a str,
            code_verifier: &'a str,
            redirect_uri: &'a str,
        }
        let body = Zeroizing::new(
            serde_json::to_vec(&Request {
                code,
                code_verifier: verifier,
                redirect_uri: redirect,
            })
            .map_err(|_| RETRY)?,
        );
        let response = Self::http(root)?
            .post(format!("{root}/v1/auth/login/exchange"))
            .header(reqwest::header::CONTENT_TYPE, "application/json")
            .body(bytes::Bytes::from_owner(body))
            .send()
            .await
            .map_err(|_| RETRY)?;
        let value: Exchange =
            serde_json::from_slice(&Self::body(response).await?).map_err(|_| RETRY)?;
        Ok(value.session_credential)
    }
    async fn request(&self, path: &str, post: bool) -> Result<Zeroizing<Vec<u8>>> {
        let url = format!("{}{path}", self.root);
        let request = if post {
            self.http
                .post(url)
                .header(reqwest::header::CONTENT_TYPE, "application/json")
                .body("{}")
        } else {
            self.http.get(url)
        };
        let response = request
            .header("X-BB-Session-Credential", &self.credential)
            .send()
            .await
            .map_err(|_| RETRY)?;
        Self::body(response).await
    }
    async fn body(mut response: reqwest::Response) -> Result<Zeroizing<Vec<u8>>> {
        if !response.status().is_success()
            || response.content_length().is_some_and(|len| len > 8192)
        {
            return Err(RETRY.into());
        }
        let mut body = Zeroizing::new(Vec::with_capacity(8192));
        while let Some(chunk) = response.chunk().await.map_err(|_| RETRY)? {
            if chunk.len() > 8192 - body.len() {
                return Err(RETRY.into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(body)
    }
    async fn me(&self) -> Result<Account> {
        let account: Account = serde_json::from_slice(&self.request("/v1/auth/me", false).await?)
            .map_err(|_| RETRY)?;
        let expiry = chrono::DateTime::parse_from_rfc3339(&account.expires_at)
            .map_err(|_| RETRY)?
            .timestamp();
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| RETRY)?
            .as_secs();
        if account.subject.is_empty()
            || account.subject.len() > 1024
            || account.subject.chars().any(char::is_control)
            || expiry <= now as i64
        {
            return Err(RETRY.into());
        }
        Ok(account)
    }
    async fn current(&self) -> Result<Option<String>> {
        let value: serde_json::Value = serde_json::from_slice(
            &self
                .request("/v1/buzz/nostr-identities/current", true)
                .await?,
        )
        .map_err(|_| RETRY)?;
        if value.get("error").is_some_and(|error| !error.is_null()) {
            return Err(RETRY.into());
        }
        let known = value
            .get("correlation_id")
            .and_then(|id| id.as_str())
            .is_some_and(|id| !id.is_empty());
        match value.get("identity") {
            Some(serde_json::Value::Null) if known => Ok(None),
            Some(identity) => public_key(
                identity
                    .get("pubkey_hex")
                    .and_then(|key| key.as_str())
                    .ok_or(RETRY)?,
            )
            .map(Some),
            None if known => Ok(None),
            _ => Err(RETRY.into()),
        }
    }
}

#[tauri::command]
pub(crate) fn nsec_backup_available(host: tauri::State<'_, NsecBackupHost>) -> bool {
    host.config.is_some()
}
#[tauri::command]
pub(crate) fn nsec_backup_session(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    source: Source,
    generation: u64,
    credential: Option<String>,
) -> Result<()> {
    host.session(source, generation, credential, identity.inner().clone())
}
#[tauri::command]
pub(crate) fn nsec_backup_retry(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    source: Source,
) {
    host.retry(source, identity.inner().clone());
}
#[tauri::command]
pub(crate) async fn nsec_restore_begin<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    callback: tauri::State<'_, OAuthCallbackHost>,
) -> Result<RestoreStarted> {
    host.begin(identity.inner().clone(), callback.inner().clone(), app)
        .await
}
#[tauri::command]
pub(crate) async fn nsec_restore_wait(
    host: tauri::State<'_, NsecBackupHost>,
    attempt: String,
) -> Result<RestoreResult> {
    host.wait(&attempt).await
}
#[tauri::command]
pub(crate) async fn nsec_restore_install(
    host: tauri::State<'_, NsecBackupHost>,
    identity: tauri::State<'_, IdentityHost>,
    attempt: String,
    handle: String,
) -> Result<String> {
    host.install(identity.inner().clone(), &attempt, &handle)
        .await
}
#[tauri::command]
pub(crate) fn nsec_restore_cancel(host: tauri::State<'_, NsecBackupHost>, attempt: String) {
    host.cancel(&attempt);
}

#[cfg(test)]
#[path = "nsec_backup/tests.rs"]
mod tests;
