use super::grant::tests::MemoryGrants;
use super::*;
use crate::federated_identity::tests::{at_adapter, record, Memory};

pub(crate) struct Seen {
    pub(crate) target: String,
    pub(crate) headers: Vec<(String, String)>,
    pub(crate) body: Vec<u8>,
}

/// Answers each request with the next `(status, body)`, then reports them.
pub(crate) async fn issuer(
    replies: Vec<(u16, serde_json::Value)>,
) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
    issuer_gated(replies, usize::MAX, None).await
}

/// Like `issuer`, but signals `held` on reading request `at` and answers it
/// only once `release` fires: a request held in flight, without sleeps.
async fn issuer_gated(
    replies: Vec<(u16, serde_json::Value)>,
    at: usize,
    gate: Option<(
        tokio::sync::oneshot::Sender<()>,
        tokio::sync::oneshot::Receiver<()>,
    )>,
) -> (String, tokio::task::JoinHandle<Vec<Seen>>) {
    let mut gate = gate;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}/mount", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut seen = Vec::new();
        for (index, (status, reply)) in replies.into_iter().enumerate() {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut head = Vec::new();
            while !head.ends_with(b"\r\n\r\n") {
                let mut byte = [0];
                socket.read_exact(&mut byte).await.unwrap();
                head.push(byte[0]);
            }
            let text = String::from_utf8(head).unwrap();
            let mut lines = text.split("\r\n");
            let target = lines.next().unwrap().to_owned();
            let headers: Vec<_> = lines
                .filter_map(|line| line.split_once(':'))
                .map(|(name, value)| (name.to_ascii_lowercase(), value.trim().to_owned()))
                .collect();
            let size: usize = headers
                .iter()
                .find(|(name, _)| name == "content-length")
                .map_or(0, |(_, value)| value.parse().unwrap());
            let mut body = vec![0; size];
            socket.read_exact(&mut body).await.unwrap();
            seen.push(Seen {
                target,
                headers,
                body,
            });
            if index == at {
                let (held, release) = gate.take().unwrap();
                held.send(()).unwrap();
                release.await.unwrap();
            }
            let reply = reply.to_string();
            let response = format!(
                "HTTP/1.1 {status} X\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                reply.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        seen
    });
    (base, task)
}

/// A failure bound, never an ordering: a regression that stops the issuer
/// short of its script fails with this message instead of hanging the suite.
pub(crate) async fn bounded<F: std::future::Future>(wait: F) -> F::Output {
    tokio::time::timeout(std::time::Duration::from_secs(10), wait)
        .await
        .expect("the scripted exchange never happened")
}
/// The requests the issuer served, once its whole script has been answered.
pub(crate) async fn settled(served: tokio::task::JoinHandle<Vec<Seen>>) -> Vec<Seen> {
    bounded(served).await.unwrap()
}

pub(crate) struct Fixture {
    pub(crate) tokens: AgentTokens,
    pub(crate) grants: Arc<MemoryGrants>,
    pub(crate) agent: AppAgent,
    pub(crate) key: Secret,
}
/// An owner signed in as `a@example.com` at `base`, and one agent.
pub(crate) fn fixture(base: String) -> Fixture {
    let identity = at_adapter(Arc::new(Memory::default()), base);
    let mut session = record();
    Arc::get_mut(&mut session).unwrap().record.email = Some("a@example.com".into());
    {
        // Signed in through account tracking, so a later account is a change.
        let mut state = identity.state();
        state.session = Some(session);
        state.account = Some(Some("a@example.com".into()));
    }
    let grants = Arc::new(MemoryGrants::default());
    let key = Secret::generate().unwrap();
    let agent = AppAgent {
        pubkey: key.pubkey().into(),
        relay: "wss://relay.example".into(),
        owner: "b".repeat(64),
        auth: r#"["auth","owner","conditions","sig"]"#.into(),
        agent_type: "p/t".into(),
        name: "Ada".into(),
        picture: None,
        profile: None,
        about: None,
        deleted: false,
        deleting: false,
        home: None,
        joining: false,
    };
    Fixture {
        tokens: AgentTokens::with_store(identity, grants.clone()),
        grants,
        agent,
        key,
    }
}
pub(crate) fn enrolled(owner: &str) -> serde_json::Value {
    serde_json::json!({
        "access_token": "grant-1",
        "issued_token_type": GRANT_TOKEN_TYPE,
        "token_type": "N_A",
        "expires_in": 691200,
        "nostr_owner_pubkey": owner,
        "nip_fi_issuer": "https://issuer.example",
    })
}

#[tokio::test]
async fn enrollment_exchanges_the_owner_session_with_only_the_agent_proof() {
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64)))]).await;
    let f = fixture(base);
    let admitted = f.tokens.admit().await.unwrap();
    let grant = f.tokens.grant(&f.agent, &f.key, admitted).await.unwrap();
    assert_eq!(
        (grant.token.as_str(), grant.account.as_str()),
        ("grant-1", "a@example.com")
    );
    // Stored, so a second use does not enroll again.
    assert!(f.tokens.grant(&f.agent, &f.key, admitted).await.is_ok());

    let seen = settled(served).await;
    assert_eq!(seen.len(), 1);
    let wire = &seen[0];
    assert_eq!(wire.target, "POST /mount/v1/nip-fi/agent-grant HTTP/1.1");
    let fields: Vec<(String, String)> = url::form_urlencoded::parse(&wire.body)
        .into_owned()
        .collect();
    let field = |name: &str| fields.iter().find(|(n, _)| n == name).unwrap().1.clone();
    assert_eq!(fields.len(), 7);
    assert_eq!(field("subject_token"), "fixture-session-token");
    assert_eq!(field("agent_pubkey"), f.agent.pubkey);
    assert_eq!(field("runtime"), "local");
    assert_eq!(field("owner_attestation"), f.agent.auth);
    assert_eq!(field("requested_token_type"), GRANT_TOKEN_TYPE);
    for ambient in ["authorization", "cookie", "x-bb-session"] {
        assert!(wire.headers.iter().all(|(name, _)| name != ambient));
    }
    let proof = &wire
        .headers
        .iter()
        .find(|(n, _)| n == "nostr-agent-proof")
        .unwrap()
        .1;
    let proof: serde_json::Value =
        serde_json::from_slice(&STANDARD.decode(&proof["Nostr ".len()..]).unwrap()).unwrap();
    assert_eq!(proof["pubkey"], f.agent.pubkey.as_str());
    let u = proof["tags"][0][1].as_str().unwrap();
    assert!(u.ends_with("/mount/v1/nip-fi/agent-grant"));
    use sha2::{Digest, Sha256};
    assert_eq!(
        proof["tags"][2][1],
        format!("{:x}", Sha256::digest(&wire.body)).as_str()
    );
}

#[tokio::test]
async fn enrollment_needs_a_session_and_refuses_another_owner() {
    let (base, served) = issuer(vec![(200, enrolled(&"c".repeat(64)))]).await;
    let f = fixture(base);
    assert!(f.tokens.grant(&f.agent, &f.key, 0).await.is_err());
    assert!(f.grants.0.lock().unwrap().is_empty());
    settled(served).await;

    f.tokens.0.identity.state().session = None;
    assert_eq!(
        f.tokens
            .grant(&f.agent, &f.key, 0)
            .await
            .err()
            .map(|e| e.message),
        Some(SIGN_IN.into())
    );
}

pub(crate) fn jwt(agent: &AppAgent, claims: serde_json::Value) -> String {
    let now = now().unwrap() as u64;
    let mut base = serde_json::json!({
        "iss": "https://issuer.example",
        "aud": "https://relay.example",
        "nostr_pubkey": agent.pubkey,
        "nostr_owner_pubkey": agent.owner,
        "iat": now,
        "exp": now + 300,
    });
    for (name, value) in claims.as_object().unwrap() {
        base[name] = value.clone();
    }
    format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi-agent+jwt","alg":"ES256"}"#),
        URL_SAFE_NO_PAD.encode(base.to_string())
    )
}
pub(crate) fn issued(agent: &AppAgent, claims: serde_json::Value) -> serde_json::Value {
    let token = jwt(agent, claims);
    let exp = serde_json::from_slice::<serde_json::Value>(
        &URL_SAFE_NO_PAD
            .decode(token.split('.').nth(1).unwrap())
            .unwrap(),
    )
    .unwrap()["exp"]
        .clone();
    serde_json::json!({ "assertion": token, "nostr_pubkey": agent.pubkey, "expires_at": exp })
}

#[tokio::test]
async fn an_agent_assertion_is_minted_with_the_grant_validated_and_reused() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let reply = issued(&probe, serde_json::json!({}));
    let (base, served) = issuer(vec![(200, enrolled(&"b".repeat(64))), (200, reply)]).await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;

    let first = f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .unwrap();
    assert!(first.starts_with("Bearer ") && first.contains('.'));
    let again = f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(*first, *again);

    let seen = settled(served).await;
    assert_eq!(seen.len(), 2, "the cached assertion is reused");
    let mint = &seen[1];
    assert_eq!(
        mint.target,
        "POST /mount/v1/nip-fi/agent-assertion HTTP/1.1"
    );
    let header = |name: &str| {
        mint.headers
            .iter()
            .find(|(n, _)| n == name)
            .map(|(_, v)| v.as_str())
    };
    assert_eq!(header("authorization"), Some("Bearer grant-1"));
    assert!(header("nostr-authorization").unwrap().starts_with("Nostr "));
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&mint.body).unwrap(),
        serde_json::json!({ "nostr_pubkey": f.agent.pubkey, "relay_url": "wss://relay.example" })
    );
}

#[test]
fn agent_assertions_must_name_this_agent_owner_issuer_and_community() {
    let f = fixture("http://unused".into());
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    let now = now().unwrap() as u64;
    let check = |claims: serde_json::Value| {
        let token = jwt(&f.agent, claims);
        validate(
            &token,
            &f.agent,
            &grant,
            "wss://relay.example",
            now + 300,
            now,
        )
    };
    assert!(check(serde_json::json!({})).is_ok());
    for wrong in [
        serde_json::json!({ "nostr_pubkey": "c".repeat(64) }),
        serde_json::json!({ "nostr_owner_pubkey": "c".repeat(64) }),
        serde_json::json!({ "iss": "https://other.example" }),
        serde_json::json!({ "aud": "https://other.example" }),
        serde_json::json!({ "exp": now + 299 }),
        serde_json::json!({ "iat": now + 60 }),
    ] {
        assert!(check(wrong).is_err());
    }
    let human = format!(
        "{}.{}.sig",
        URL_SAFE_NO_PAD.encode(br#"{"typ":"nip-fi+jwt"}"#),
        jwt(&f.agent, serde_json::json!({}))
            .split('.')
            .nth(1)
            .unwrap()
    );
    assert!(validate(
        &human,
        &f.agent,
        &grant,
        "wss://relay.example",
        now + 300,
        now
    )
    .is_err());
}

#[tokio::test]
async fn a_community_outside_the_organization_gets_no_assertion() {
    let mut f = fixture("http://unused".into());
    f.agent.relay = "wss://elsewhere.example".into();
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_none());
}

fn refused_grant() -> (u16, serde_json::Value) {
    (401, serde_json::json!({ "error": "invalid_grant" }))
}

#[tokio::test]
async fn a_refused_grant_is_replaced_once_then_the_agent_stops() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let owner = "b".repeat(64);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[2].target.contains("agent-grant"), "re-enrolled once");
    assert_eq!(f.grants.0.lock().unwrap().len(), 1);

    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(STOPPED)
    );
    // Stopped: no further enrollment or mint is attempted.
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(STOPPED)
    );
    assert_eq!(settled(served).await.len(), 4);
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "no refused grant is kept"
    );
}

#[tokio::test]
async fn concurrent_refusals_share_the_one_re_enrollment() {
    let owner = "b".repeat(64);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    let (a, b) = tokio::join!(
        f.tokens.evidence(&f.agent, &f.key, 0),
        f.tokens.evidence(&f.agent, &f.key, 0)
    );
    assert_eq!(a.err().as_deref(), Some(STOPPED));
    assert_eq!(b.err().as_deref(), Some(STOPPED));
    assert_eq!(settled(served).await.len(), 4);
}

#[tokio::test]
async fn an_unreachable_issuer_during_recovery_does_not_stop_the_agent() {
    let key = Secret::generate().unwrap();
    let mut probe = fixture("http://unused".into()).agent;
    probe.pubkey = key.pubkey().into();
    let owner = "b".repeat(64);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        unavailable(),
        unavailable(),
        unavailable(),
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    f.agent.pubkey = key.pubkey().into();
    f.key = key;
    let failed = f.tokens.evidence(&f.agent, &f.key, 0).await.unwrap_err();
    assert_ne!(failed, STOPPED);
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "the refused grant is gone"
    );
    // The next request takes the ordinary lazy enrollment.
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 7);
}

fn signed_in_again(f: &Fixture, email: &str) {
    let identity = &f.tokens.0.identity;
    let mut session = record();
    Arc::get_mut(&mut session).unwrap().record.email = Some(email.into());
    let mut state = identity.state();
    state.session = Some(session);
    identity.signed_in(&mut state, Some(email.into()));
}
/// Lists the fixture's agent, as the agent host does, without the watcher.
fn listing(f: &Fixture) {
    let listed = (f.agent.owner.clone(), f.agent.pubkey.clone());
    let _ = f
        .tokens
        .0
        .agents
        .set(Arc::new(move || Ok(vec![listed.clone()])));
}
fn keyed(owner: &str) -> (Secret, AppAgent) {
    let key = Secret::generate().unwrap();
    let mut agent = fixture("http://unused".into()).agent;
    agent.pubkey = key.pubkey().into();
    agent.owner = owner.into();
    (key, agent)
}

#[tokio::test]
async fn sign_out_then_sign_in_before_the_watcher_runs_retires_cached_and_stored_credentials() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        mint(),
        (200, enrolled(&owner)),
        mint(),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());

    // The watcher would only see `Refreshed`: the sign-out was overwritten.
    f.tokens.0.identity.sign_out().await;
    signed_in_again(&f, "a@example.com");
    assert_eq!(
        f.tokens.0.identity.account_changes().borrow().clone(),
        Some(SessionChange::Refreshed)
    );

    // Neither the cached assertion nor the stored grant is reused.
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[2].target.contains("agent-grant"), "enrolled anew");
    assert_eq!(seen.len(), 4);
}

#[tokio::test]
async fn a_new_account_retires_the_cached_assertion() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        mint(),
        (200, enrolled(&owner)),
        mint(),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    signed_in_again(&f, "b@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 4);
}

#[tokio::test]
async fn expiry_and_same_account_refresh_keep_the_grant_and_assertion() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let identity = &f.tokens.0.identity;
    identity.retire(
        crate::federated_identity::Status::ReauthenticationRequired,
        None,
    );
    identity.signal(SessionChange::Expired);
    signed_in_again(&f, "a@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 2);
    assert_eq!(f.grants.0.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_mint_in_flight_across_sign_out_is_neither_returned_nor_cached() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (held_tx, held) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ],
        1,
        Some((held_tx, release_rx)),
    )
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    listing(&f);
    let f = Arc::new(f);
    let call = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.evidence(&f.agent, &f.key, 0).await })
    };
    bounded(held).await.unwrap();
    f.tokens.0.identity.sign_out().await;
    release.send(()).unwrap();
    assert_eq!(call.await.unwrap().err().as_deref(), Some(CHANGED));
    assert!(f
        .tokens
        .slot(&f.agent.pubkey)
        .lock()
        .await
        .assertion
        .is_none());
    settled(served).await;
    // The next request is admitted only after the wipe.
    assert!(f.tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "the old grant is wiped"
    );
}

#[tokio::test]
async fn an_enrollment_committing_after_sign_out_stores_nothing() {
    let f = fixture("http://unused".into());
    listing(&f);
    let retirements = f.tokens.admit().await.unwrap();
    f.tokens.0.identity.sign_out().await;
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    assert_eq!(
        f.tokens
            .commit(&f.agent, grant, retirements)
            .await
            .err()
            .as_deref(),
        Some(CHANGED)
    );
    assert!(f.grants.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn deletion_refuses_requests_already_queued_for_the_agent() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (held_tx, held) = tokio::sync::oneshot::channel();
    let (release, release_rx) = tokio::sync::oneshot::channel();
    let (base, served) = issuer_gated(
        vec![
            (200, enrolled(&owner)),
            (200, issued(&probe, serde_json::json!({}))),
        ],
        0,
        Some((held_tx, release_rx)),
    )
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    let f = Arc::new(f);
    let spawn_evidence = || {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.evidence(&f.agent, &f.key, 0).await })
    };
    // One request enrolls; deletion and a stale request queue behind it.
    let first = spawn_evidence();
    bounded(held).await.unwrap();
    let forget = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.forget(&f.agent.owner, &f.agent.pubkey).await })
    };
    // Deletion closes the agent before it waits for the request in flight.
    bounded(async {
        while !f.tokens.closed(&f.agent.pubkey) {
            tokio::task::yield_now().await;
        }
    })
    .await;
    let stale = spawn_evidence();
    release.send(()).unwrap();
    // The request in flight settles refused too: its agent is gone.
    assert_eq!(first.await.unwrap().err().as_deref(), Some(DELETED));
    forget.await.unwrap().unwrap();
    assert_eq!(stale.await.unwrap().err().as_deref(), Some(DELETED));
    assert_eq!(
        settled(served).await.len(),
        2,
        "no enrollment after deletion"
    );
    assert!(f.grants.0.lock().unwrap().is_empty());
    assert_eq!(
        f.tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .err()
            .as_deref(),
        Some(DELETED)
    );
}

#[tokio::test]
async fn a_replacement_refused_after_a_transient_failure_stops_without_a_second_exchange() {
    let owner = "b".repeat(64);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        unavailable(),
        unavailable(),
        unavailable(),
        refused_grant(),
    ])
    .await;
    let f = fixture(base);
    let failed = f.tokens.evidence(&f.agent, &f.key, 0).await.unwrap_err();
    assert_ne!(failed, STOPPED);
    let at = f.tokens.grant_key(&f.agent);
    assert!(f.grants.read(&at).unwrap().unwrap().replacement);
    let (a, b) = tokio::join!(
        f.tokens.evidence(&f.agent, &f.key, 0),
        f.tokens.evidence(&f.agent, &f.key, 0)
    );
    assert_eq!(a.err().as_deref(), Some(STOPPED));
    assert_eq!(b.err().as_deref(), Some(STOPPED));
    assert_eq!(
        settled(served).await.len(),
        7,
        "one exchange, no third grant"
    );
    assert!(f.grants.0.lock().unwrap().is_empty());
}

#[tokio::test]
async fn a_replacement_that_mints_after_a_transient_failure_becomes_ordinary() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let unavailable = || (503, serde_json::json!({ "error": "issuance_unavailable" }));
    let (base, served) = issuer(vec![
        (200, enrolled(&owner)),
        refused_grant(),
        (200, enrolled(&owner)),
        unavailable(),
        unavailable(),
        unavailable(),
        (200, issued(&probe, serde_json::json!({}))),
    ])
    .await;
    let mut f = fixture(base);
    (f.agent, f.key) = (probe.clone(), key);
    assert!(f.tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 7, "no second exchange");
    let at = f.tokens.grant_key(&f.agent);
    assert!(!f.grants.read(&at).unwrap().unwrap().replacement);
}

#[tokio::test]
async fn a_new_sign_in_lifts_a_stop_and_deletion_retires_the_grant() {
    let f = fixture("http://unused".into());
    listing(&f);
    let at = f.tokens.grant_key(&f.agent);
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    f.grants.write(&at, &grant).unwrap();
    f.tokens.slot(&f.agent.pubkey).lock().await.stopped = true;
    f.tokens
        .follow(Some(SessionChange::Refreshed))
        .await
        .unwrap();
    assert!(!f.tokens.slot(&f.agent.pubkey).lock().await.stopped);
    assert!(
        f.grants.0.lock().unwrap().contains_key(&at),
        "refresh keeps grants"
    );

    f.tokens
        .forget(&f.agent.owner, &f.agent.pubkey)
        .await
        .unwrap();
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "deletion retires the grant"
    );
}

/// A grant for the fixture's agent, enrolled by `account`, stored directly.
fn stored(f: &Fixture, account: &str) {
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        account.into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    f.grants
        .write(&f.tokens.grant_key(&f.agent), &grant)
        .unwrap();
}
/// A new process over the same profile's storage: nothing in memory, no
/// session restored yet.
fn restarted(f: &Fixture, base: String) -> AgentTokens {
    let fresh = fixture(base);
    {
        let mut state = fresh.tokens.0.identity.state();
        state.session = None;
        state.account = None;
    }
    let tokens = AgentTokens::with_store(fresh.tokens.0.identity.clone(), f.grants.clone());
    let listed = (f.agent.owner.clone(), f.agent.pubkey.clone());
    let _ = tokens
        .0
        .agents
        .set(Arc::new(move || Ok(vec![listed.clone()])));
    tokens
}

#[tokio::test]
async fn an_organization_sign_out_whose_grant_deletion_fails_resumes_it_after_restart() {
    let (base, served) = issuer(vec![]).await;
    let f = fixture(base.clone());
    listing(&f);
    stored(&f, "a@example.com");
    f.grants.failing(true);
    assert!(f.tokens.sign_out().await.is_err());

    // Restarted before the cleanup finished: the grant is neither used nor
    // restored while it cannot be deleted.
    let tokens = restarted(&f, base);
    assert!(tokens.evidence(&f.agent, &f.key, 0).await.is_err());
    assert!(f
        .grants
        .0
        .lock()
        .unwrap()
        .contains_key(&f.tokens.grant_key(&f.agent)));
    // The next attempt finishes the cleanup first, then has nothing to use.
    f.grants.failing(false);
    assert_eq!(
        tokens.evidence(&f.agent, &f.key, 0).await.err().as_deref(),
        Some(SIGN_IN)
    );
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "grant and record wiped"
    );
    assert!(
        settled(served).await.is_empty(),
        "no grant or assertion call"
    );
}

#[tokio::test]
async fn a_grant_write_past_its_check_does_not_survive_a_concurrent_sign_out() {
    let f = Arc::new(fixture("http://unused".into()));
    listing(&f);
    let retirements = f.tokens.admit().await.unwrap();
    let (held_tx, held) = std::sync::mpsc::channel();
    let (release, release_rx) = std::sync::mpsc::channel();
    f.grants.gate((held_tx, release_rx));
    let grant = Grant::new(
        f.agent.owner.clone(),
        f.agent.pubkey.clone(),
        "a@example.com".into(),
        "https://issuer.example".into(),
        "g".into(),
    );
    let write = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.commit(&f.agent, grant, retirements).await })
    };
    bounded(tokio::task::spawn_blocking(move || held.recv()))
        .await
        .unwrap()
        .unwrap();
    // The write has passed its check. Sign-out runs until it waits on the
    // transaction the write holds; only then is the write released. Were the
    // two not one transaction, sign-out would finish first and the write would
    // land after its wipe.
    let (contended_tx, contended) = std::sync::mpsc::channel();
    *f.tokens.0.contended.lock().unwrap() = Some(contended_tx);
    let sign_out = {
        let f = f.clone();
        tokio::spawn(async move { f.tokens.sign_out().await })
    };
    // Sign-out drops the sender unsignalled if it never waits.
    let waited = bounded(tokio::task::spawn_blocking(move || {
        contended.recv().is_ok()
    }))
    .await
    .unwrap();
    release.send(()).unwrap();
    assert!(write.await.unwrap().is_ok());
    assert!(waited, "sign-out did not wait for the write's transaction");
    assert!(bounded(sign_out).await.unwrap().is_ok());
    assert!(
        f.grants.0.lock().unwrap().is_empty(),
        "no retired grant survives"
    );
}

#[tokio::test]
async fn another_account_as_the_first_sign_in_after_restart_retires_the_cached_grant() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let mint = || (200, issued(&probe, serde_json::json!({})));
    let (base, served) = issuer(vec![mint(), (200, enrolled(&owner)), mint()]).await;
    let mut f = fixture(base.clone());
    (f.agent, f.key) = (probe.clone(), key);
    stored(&f, "a@example.com");
    let tokens = restarted(&f, base);
    // With no session restored, A's grant mints as it should.
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());

    let f = Fixture { tokens, ..f };
    signed_in_again(&f, "b@example.com");
    assert_eq!(
        f.tokens.0.identity.account_changes().borrow().clone(),
        Some(SessionChange::Refreshed),
        "the process saw no account before B"
    );
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let seen = settled(served).await;
    assert!(seen[1].target.contains("agent-grant"), "B enrolled anew");
    let at = f.tokens.grant_key(&f.agent);
    assert_eq!(
        f.grants.read(&at).unwrap().unwrap().account,
        "b@example.com"
    );
}

#[tokio::test]
async fn another_first_sign_in_retires_the_grant_even_once_that_session_has_expired() {
    // The watcher follows B's sign-in before it expires, or sees both as one change.
    for watched_before_expiry in [true, false] {
        let owner = "b".repeat(64);
        let (key, probe) = keyed(&owner);
        let (base, served) = issuer(vec![(200, issued(&probe, serde_json::json!({})))]).await;
        let mut f = fixture(base.clone());
        (f.agent, f.key) = (probe.clone(), key);
        stored(&f, "a@example.com");
        let tokens = restarted(&f, base.clone());
        assert!(tokens
            .evidence(&f.agent, &f.key, 0)
            .await
            .unwrap()
            .is_some());

        // B is the first sign-in, with no agent call while it lasts.
        let f = Fixture { tokens, ..f };
        signed_in_again(&f, "b@example.com");
        let identity = f.tokens.0.identity.clone();
        let watch = || f.tokens.follow(identity.account_changes().borrow().clone());
        if watched_before_expiry {
            watch().await.unwrap();
        }
        // B's session expires and the restore owner removes it.
        {
            let mut state = identity.state();
            let session = Arc::get_mut(state.session.as_mut().unwrap()).unwrap();
            session.record.expires_at = "2000-01-01T00:00:00Z".into();
            state.restored = true;
        }
        identity.restore().await;
        assert!(identity.state().session.is_none());
        watch().await.unwrap();

        // A's grant neither mints nor comes back, here or after a restart.
        assert_eq!(
            f.tokens
                .evidence(&f.agent, &f.key, 0)
                .await
                .err()
                .as_deref(),
            Some(SIGN_IN)
        );
        let tokens = restarted(&f, base);
        assert_eq!(
            tokens.evidence(&f.agent, &f.key, 0).await.err().as_deref(),
            Some(SIGN_IN)
        );
        assert!(
            f.grants.0.lock().unwrap().is_empty(),
            "grant and record wiped"
        );
        assert_eq!(settled(served).await.len(), 1, "only A's first mint");
    }
}

#[tokio::test]
async fn the_same_account_as_the_first_sign_in_after_restart_keeps_the_grant() {
    let owner = "b".repeat(64);
    let (key, probe) = keyed(&owner);
    let (base, served) = issuer(vec![(200, issued(&probe, serde_json::json!({})))]).await;
    let mut f = fixture(base.clone());
    (f.agent, f.key) = (probe.clone(), key);
    stored(&f, "a@example.com");
    let tokens = restarted(&f, base);
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    // Without a session, and then signed in as A, the assertion is reused.
    assert!(tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    let f = Fixture { tokens, ..f };
    signed_in_again(&f, "a@example.com");
    assert!(f
        .tokens
        .evidence(&f.agent, &f.key, 0)
        .await
        .unwrap()
        .is_some());
    assert_eq!(settled(served).await.len(), 1);
    assert!(f
        .grants
        .0
        .lock()
        .unwrap()
        .contains_key(&f.tokens.grant_key(&f.agent)));
}
