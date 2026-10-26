use super::{now, template, Call, Channel, IdentityHost, Result, Update};
use crate::federated_identity::{assertion, FederatedIdentity};
use buzz_audio_client::{
    connection::{self, AudioSocket as Socket},
    encoder::AudioEncoder,
    jitter::PeerJitterBuffer,
    wire::parse_relay_frame,
};
use futures_util::{SinkExt, StreamExt};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use std::{
    collections::BTreeMap,
    future::{pending, Future},
    time::Duration,
};
use tokio::sync::{mpsc, watch};
use tokio::time::Instant;
use tokio_tungstenite::{
    tungstenite::{client::IntoClientRequest, handshake::client::Request, Message},
    Connector,
};
use tokio_util::sync::CancellationToken;
use url::Url;

type Peers = BTreeMap<u8, String>;

pub(super) struct Connection {
    pub(super) socket: Option<Socket>,
    pub(super) peers: BTreeMap<u8, String>,
    pub(super) expires_at: Option<Instant>,
    pub(super) cancellation: CancellationToken,
}

fn tls_config() -> Result<std::sync::Arc<rustls::ClientConfig>> {
    static CONFIG: std::sync::OnceLock<Result<std::sync::Arc<rustls::ClientConfig>>> =
        std::sync::OnceLock::new();
    CONFIG
        .get_or_init(|| {
            let mut roots = rustls::RootCertStore::empty();
            roots.add_parsable_certificates(rustls_native_certs::load_native_certs().certs);
            if roots.is_empty() {
                return Err("System TLS certificates unavailable".into());
            }
            // reqwest and the updater enable different providers. Choose explicitly,
            // rather than letting rustls panic when both providers are compiled in.
            let config = rustls::ClientConfig::builder_with_provider(std::sync::Arc::new(
                rustls::crypto::aws_lc_rs::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .map_err(|_| "Huddle TLS unavailable")?
            .with_root_certificates(roots)
            .with_no_client_auth();
            Ok(std::sync::Arc::new(config))
        })
        .clone()
}

fn roster(value: &Value) -> Result<Peers> {
    Ok(connection::parse_peers(value)?
        .into_iter()
        .map(|p| (p.index, p.pubkey))
        .collect())
}
pub(super) async fn connect(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    room: &str,
) -> Result<Connection> {
    connect_via(host, fi, call, room, Connector::Rustls(tls_config()?)).await
}

async fn connect_via(
    host: &IdentityHost,
    fi: &FederatedIdentity,
    call: &Call,
    room: &str,
    connector: Connector,
) -> Result<Connection> {
    let community = super::origin(&call.community)?;
    // Issued for the community's HTTPS origin and the signing identity, like
    // every other relay route; without a NIP-FI session it carries nothing.
    let authorization = super::super::evidence(host, Some(fi), &community)
        .await?
        .ok_or("Huddle authorization unavailable")?;
    let request = audio_request(&community, room, authorization.header())?;
    let expires_at = authorization
        .assertion
        .as_ref()
        .map(|assertion| assertion.expires_at);
    let cancellation = fi.authorization_cancellation(&authorization)?;
    let (socket, peers) = fi
        .during_authorization(host, &authorization, open(host, call, request, connector))
        .await??;
    ensure_authorized(expires_at, &cancellation)?;
    Ok(Connection {
        socket: Some(socket),
        peers,
        expires_at,
        cancellation,
    })
}

pub(super) fn ensure_authorized(
    expires_at: Option<Instant>,
    cancellation: &CancellationToken,
) -> Result<()> {
    if cancellation.is_cancelled() {
        return Err("Huddle authorization changed. Join again to reconnect.".into());
    }
    if expires_at.is_some_and(|deadline| Instant::now() >= deadline) {
        return Err("Huddle authorization expired. Join again to reconnect.".into());
    }
    Ok(())
}

async fn authorization_guard<T>(
    expires_at: Option<Instant>,
    cancellation: &CancellationToken,
    operation: impl Future<Output = Result<T>>,
) -> Result<T> {
    let expiry = async {
        if let Some(deadline) = expires_at {
            tokio::time::sleep_until(deadline).await;
        } else {
            pending::<()>().await;
        }
    };
    tokio::pin!(expiry);
    tokio::select! {
        biased;
        _ = cancellation.cancelled() => Err("Huddle authorization changed. Join again to reconnect.".into()),
        _ = &mut expiry => Err("Huddle authorization expired. Join again to reconnect.".into()),
        result = operation => result,
    }
}

/// The audio upgrade request: `Authorization` stays NIP-98 territory, so the
/// NIP-FI assertion travels in its own header, as on the main socket.
fn audio_request(community: &Url, room: &str, assertion: Option<&str>) -> Result<Request> {
    let mut url = community.clone();
    url.set_scheme("wss").map_err(|_| "Invalid Huddle relay")?;
    url.set_path(&format!("/huddle/{room}/audio"));
    let mut request = url
        .as_str()
        .into_client_request()
        .map_err(|_| "Invalid Huddle relay")?;
    if let Some(assertion) = assertion {
        request.headers_mut().insert(
            assertion::HEADER,
            assertion
                .parse()
                .map_err(|_| "Invalid federated authorization")?,
        );
    }
    Ok(request)
}

async fn open(
    host: &IdentityHost,
    call: &Call,
    request: Request,
    connector: Connector,
) -> Result<(Socket, Peers)> {
    // Use the same origin string as the existing desktop v2 client for NIP-42.
    let relay = super::origin(&call.community)?
        .as_str()
        .trim_end_matches('/')
        .replacen("https://", "wss://", 1);
    let joined = connection::connect(
        request,
        Some(&call.parent),
        Some(connector),
        |challenge| async move {
            host.sign(template(
                22242,
                vec![
                    vec!["relay".into(), relay],
                    vec!["challenge".into(), challenge],
                ],
                String::new(),
            ))
            .await
        },
    )
    .await?;
    Ok((
        joined.socket,
        joined
            .peers
            .into_iter()
            .map(|p| (p.index, p.pubkey))
            .collect(),
    ))
}

struct Receiver {
    jitter: PeerJitterBuffer,
    last_packet: tokio::time::Instant,
}
struct Codec {
    encoder: AudioEncoder,
    receivers: BTreeMap<u8, Receiver>,
}
impl Codec {
    fn new() -> Result<Self> {
        Ok(Self {
            encoder: AudioEncoder::new()?,
            receivers: BTreeMap::new(),
        })
    }
    fn insert(&mut self, frame: &[u8], peers: &Peers) -> Result<()> {
        if frame.len() > 4009 {
            return Ok(());
        }
        let Some((index, header, payload)) = parse_relay_frame(frame) else {
            return Ok(());
        };
        if !peers.contains_key(&index) {
            return Ok(());
        }
        if let std::collections::btree_map::Entry::Vacant(entry) = self.receivers.entry(index) {
            entry.insert(Receiver {
                jitter: PeerJitterBuffer::new(index)
                    .map_err(|e| format!("Audio decoder unavailable: {e}"))?,
                last_packet: tokio::time::Instant::now(),
            });
        }
        if let Some(receiver) = self.receivers.get_mut(&index) {
            // Malformed or excessively late media must not end the call.
            if receiver
                .jitter
                .insert_packet(header.seq, header.ts_48k, payload)
                .is_ok()
            {
                receiver.last_packet = tokio::time::Instant::now();
            }
        }
        Ok(())
    }
    fn play(
        &mut self,
        peers: &Peers,
        mut emit: impl FnMut(String, Vec<f32>) -> Result<()>,
    ) -> Result<()> {
        for (index, receiver) in &mut self.receivers {
            if receiver.last_packet.elapsed() > Duration::from_millis(500)
                && receiver.jitter.is_empty()
            {
                continue;
            }
            if let Some(peer) = peers.get(index) {
                let (samples, _) = receiver
                    .jitter
                    .get_audio()
                    .map_err(|e| format!("Huddle playback failed: {e}"))?;
                emit(peer.clone(), samples)?;
            }
        }
        Ok(())
    }
    fn replace(&mut self, peers: &mut Peers, next: Peers) {
        self.receivers.retain(|i, _| peers.get(i) == next.get(i));
        *peers = next;
    }
    fn joined(&mut self, peers: &mut Peers, delta: Peers) {
        let mut next = peers.clone();
        next.extend(delta);
        self.replace(peers, next);
    }
}

pub(super) async fn run(
    mut connection: Connection,
    mut pcm: mpsc::Receiver<Vec<f32>>,
    mut stop: watch::Receiver<bool>,
    updates: &Channel<Update>,
    touched: &std::sync::atomic::AtomicU64,
) -> Result<()> {
    ensure_authorized(connection.expires_at, &connection.cancellation)?;
    let mut socket = connection
        .socket
        .take()
        .ok_or("Huddle audio connection closed")?;
    let mut peers = connection.peers;
    let expires_at = connection.expires_at;
    let authorization_cancellation = connection.cancellation;
    let mut codec = Codec::new()?;
    let mut heartbeat = tokio::time::interval(Duration::from_secs(10));
    heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut playout = tokio::time::interval(Duration::from_millis(10));
    playout.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut last_received = tokio::time::Instant::now();
    authorization_guard(expires_at, &authorization_cancellation, async {
        loop {
            if *stop.borrow() {
                break;
            }
            tokio::select! {
                biased;
                _ = stop.changed() => break,
                // Cleanup must not be starved by a continuously ready audio stream.
                _ = heartbeat.tick() => {
                    super::check_cancelled(&stop, touched)?;
                    if last_received.elapsed() > Duration::from_secs(30) { return Err("Huddle connection timed out. You can join again.".into()); }
                    tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Ping(now().to_be_bytes().to_vec().into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
                }
                _ = playout.tick() => {
                    codec.play(&peers, |peer, samples| updates.send(Update::Audio { peer, samples }).map_err(|_| "Huddle view closed".into()))?;
                }
                packet = socket.next() => {
                    last_received = tokio::time::Instant::now();
                    match packet {
                        Some(Ok(Message::Binary(frame))) => {
                            codec.insert(&frame, &peers)?;
                        }
                        Some(Ok(Message::Text(text))) => {
                            let value: Value = serde_json::from_str(&text).map_err(|_| "Invalid Huddle update")?;
                            match value["type"].as_str() {
                                Some("joined") => {
                                    // Mesh joins are deltas. Preserve already connected peers.
                                    codec.joined(&mut peers, roster(&value)?);
                                }
                                Some("roster") => {
                                    let next = roster(&value)?;
                                    codec.replace(&mut peers, next);
                                }
                                Some("left") => {
                                    if let Some(i) = value["peer_index"].as_u64().filter(|i| *i <= 255) {
                                        peers.remove(&(i as u8));
                                        codec.receivers.remove(&(i as u8));
                                    }
                                }
                                Some("error") => return Err("The relay ended this Huddle connection".into()),
                                _ => continue,
                            }
                            updates.send(Update::Participants {participants:peers.values().cloned().collect()}).map_err(|_| "Huddle view closed")?;
                        }
                        Some(Ok(Message::Ping(bytes))) => {
                            tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Pong(bytes))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
                        }
                        Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return Err("Huddle disconnected. You can join again.".into()),
                        _ => {},
                    }
                }
                samples = pcm.recv() => {
                    let Some(samples) = samples else { break; };
                    let frame = codec.encoder.encode(&samples)?;
                    tokio::time::timeout(Duration::from_secs(2), socket.send(Message::Binary(frame.into()))).await.map_err(|_| "Huddle connection stalled")?.map_err(|_| "Huddle disconnected")?;
                }
            }
        }
        let _ = tokio::time::timeout(Duration::from_secs(2), socket.close(None)).await;
        Ok(())
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use buzz_audio_client::encoder::FRAME_SAMPLES;
    use futures_util::Sink;
    use std::{
        pin::Pin,
        task::{Context, Poll},
    };
    use tokio::sync::oneshot;

    struct PendingSendSink {
        started: Option<oneshot::Sender<()>>,
        release: oneshot::Receiver<()>,
        queued: bool,
    }

    impl Sink<Message> for PendingSendSink {
        type Error = std::convert::Infallible;

        fn poll_ready(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }

        fn start_send(
            mut self: Pin<&mut Self>,
            _: Message,
        ) -> std::result::Result<(), Self::Error> {
            self.queued = true;
            Ok(())
        }

        fn poll_flush(
            self: Pin<&mut Self>,
            context: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            let this = self.get_mut();
            if let Some(started) = this.started.take() {
                let _ = started.send(());
            }
            if !this.queued {
                return Poll::Ready(Ok(()));
            }
            match Pin::new(&mut this.release).poll(context) {
                Poll::Pending => Poll::Pending,
                Poll::Ready(_) => {
                    this.queued = false;
                    Poll::Ready(Ok(()))
                }
            }
        }

        fn poll_close(
            self: Pin<&mut Self>,
            _: &mut Context<'_>,
        ) -> Poll<std::result::Result<(), Self::Error>> {
            Poll::Ready(Ok(()))
        }
    }

    async fn pending_send_error(expire: bool) -> String {
        let (started, mut observed) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let mut socket = PendingSendSink {
            started: Some(started),
            release: released,
            queued: false,
        };
        let cancellation = CancellationToken::new();
        let expires_at = expire.then(|| Instant::now() + Duration::from_secs(1));
        let result = {
            let sending = authorization_guard(expires_at, &cancellation, async {
                tokio::time::timeout(
                    Duration::from_secs(2),
                    socket.send(Message::Ping(vec![1].into())),
                )
                .await
                .map_err(|_| "Huddle connection stalled")?
                .map_err(|_| "Huddle disconnected")?;
                Ok(())
            });
            tokio::pin!(sending);
            tokio::select! {
                biased;
                _ = &mut observed => {},
                result = &mut sending => panic!("fixture send completed before its gate opened: {result:?}"),
            }
            if expire {
                tokio::time::advance(Duration::from_secs(1)).await;
            } else {
                cancellation.cancel();
            }
            let completion = tokio::time::timeout(Duration::from_secs(1), &mut sending);
            tokio::pin!(completion);
            tokio::select! {
                biased;
                result = &mut completion => result.expect("authorization retirement must interrupt the pending send"),
                _ = tokio::time::advance(Duration::from_secs(1)) => panic!("pending send ignored authorization retirement"),
            }
        };
        assert!(socket.queued, "the send reached the gated flush boundary");
        release.send(()).expect("release the fixture send gate");
        drop(socket);
        result.unwrap_err()
    }

    #[tokio::test(start_paused = true)]
    async fn expiry_and_session_retirement_abort_a_pending_audio_send() {
        assert_eq!(
            pending_send_error(true).await,
            "Huddle authorization expired. Join again to reconnect."
        );
        assert_eq!(
            pending_send_error(false).await,
            "Huddle authorization changed. Join again to reconnect."
        );
    }

    async fn active_call_error(expire: bool) -> String {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (started, observed) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let mut started = Some(started);
            while let Some(frame) = socket.next().await {
                match frame {
                    Ok(Message::Ping(payload)) => {
                        if let Some(started) = started.take() {
                            let _ = started.send(());
                        }
                        if socket.send(Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
        });
        let (socket, _) = tokio_tungstenite::connect_async(format!("ws://{address}"))
            .await
            .unwrap();
        let deadline = expire.then(|| Instant::now() + Duration::from_secs(1));
        let authorization_cancellation = CancellationToken::new();
        let retire = authorization_cancellation.clone();
        let (_pcm_sender, pcm) = mpsc::channel(1);
        let (_stop_sender, stop) = watch::channel(false);
        let updates = Channel::new(|_| Ok(()));
        let touched =
            std::sync::Arc::new(std::sync::atomic::AtomicU64::new(super::super::lease_time()));
        let run = tokio::spawn(async move {
            run(
                Connection {
                    socket: Some(socket),
                    peers: Peers::new(),
                    expires_at: deadline,
                    cancellation: authorization_cancellation,
                },
                pcm,
                stop,
                &updates,
                &touched,
            )
            .await
        });
        observed.await.unwrap();
        if expire {
            tokio::time::advance(Duration::from_secs(2)).await;
        } else {
            retire.cancel();
        }
        let error = run.await.unwrap().unwrap_err();
        server.await.unwrap();
        error
    }

    #[tokio::test(start_paused = true)]
    async fn established_audio_stops_at_assertion_expiry_and_session_retirement() {
        assert_eq!(
            active_call_error(true).await,
            "Huddle authorization expired. Join again to reconnect."
        );
        assert_eq!(
            active_call_error(false).await,
            "Huddle authorization changed. Join again to reconnect."
        );
    }

    #[test]
    fn the_audio_upgrade_carries_the_assertion_only_in_its_own_header() {
        let community = Url::parse("https://relay.example/").unwrap();
        let request = audio_request(&community, "room", Some("Bearer jwt")).unwrap();
        assert_eq!(request.uri(), "wss://relay.example/huddle/room/audio");
        assert_eq!(request.headers()[assertion::HEADER], "Bearer jwt");
        assert!(request.headers().get("authorization").is_none());

        // Without a NIP-FI session the upgrade is exactly the old bare URL.
        let bare = audio_request(&community, "room", None).unwrap();
        assert!(bare.headers().get(assertion::HEADER).is_none());
        assert!(bare.headers().get("authorization").is_none());
    }
    mod wire {
        use super::*;
        use crate::federated_identity::testing;
        use futures_util::FutureExt;
        use std::sync::Arc;
        use tokio::{
            io::AsyncReadExt,
            net::{TcpListener, TcpStream},
            sync::oneshot,
        };
        use tokio_rustls::{server::TlsStream, TlsAcceptor};
        use tokio_tungstenite::{tungstenite::handshake::server, WebSocketStream};

        const FAILURE_BOUND: Duration = Duration::from_secs(5);

        type Stream = TlsStream<TcpStream>;

        /// A loopback TLS relay; `tls()` gives the client connector trusting only it.
        struct Relay(TcpListener, TlsAcceptor);
        impl Relay {
            async fn accept(&self) -> Stream {
                let (tcp, _) = self.0.accept().await.unwrap();
                self.1.accept(tcp).await.unwrap()
            }
        }
        fn tls() -> (TlsAcceptor, Connector) {
            let cert = rcgen::generate_simple_self_signed(vec!["127.0.0.1".into()]).unwrap();
            let provider = Arc::new(rustls::crypto::aws_lc_rs::default_provider());
            let server = rustls::ServerConfig::builder_with_provider(provider.clone())
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_no_client_auth()
                .with_single_cert(
                    vec![cert.cert.der().clone()],
                    rustls::pki_types::PrivateKeyDer::Pkcs8(
                        cert.signing_key.serialize_der().into(),
                    ),
                )
                .unwrap();
            let mut roots = rustls::RootCertStore::empty();
            roots.add(cert.cert.der().clone()).unwrap();
            let client = rustls::ClientConfig::builder_with_provider(provider)
                .with_safe_default_protocol_versions()
                .unwrap()
                .with_root_certificates(roots)
                .with_no_client_auth();
            (
                TlsAcceptor::from(Arc::new(server)),
                Connector::Rustls(Arc::new(client)),
            )
        }

        /// A loopback community on a non-default port. `required` is whether its
        /// discovery demands NIP-FI; the session starts signed in.
        async fn community(
            required: bool,
        ) -> (
            Relay,
            Connector,
            IdentityHost,
            FederatedIdentity,
            Call,
            String,
            (String, tokio::task::JoinHandle<Vec<String>>),
        ) {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let (acceptor, connector) = tls();
            let relay = format!("wss://{}", listener.local_addr().unwrap());
            let host = IdentityHost::fixture();
            let viewer = host.viewer().await.unwrap();
            let (issuer, token, bodies) = testing::issuer(&viewer, &relay).await;
            let fi = testing::signed_in(issuer, &relay, required);
            let call = Call {
                id: uuid::Uuid::new_v4().to_string(),
                community: format!("https://{}/", &relay[6..]),
                viewer,
                parent: uuid::Uuid::new_v4().to_string(),
                room: None,
            };
            (
                Relay(listener, acceptor),
                connector,
                host,
                fi,
                call,
                relay,
                (token, bodies),
            )
        }

        async fn upgrade(
            relay: &Relay,
        ) -> (
            WebSocketStream<Stream>,
            String,
            tokio_tungstenite::tungstenite::http::HeaderMap,
        ) {
            let stream = relay.accept().await;
            let (seen, head) = std::sync::mpsc::channel();
            // tungstenite fixes the callback's error type.
            #[allow(clippy::result_large_err)]
            let socket = tokio_tungstenite::accept_hdr_async(
                stream,
                move |request: &server::Request, response: server::Response| {
                    seen.send((request.uri().to_string(), request.headers().clone()))
                        .unwrap();
                    Ok(response)
                },
            )
            .await
            .unwrap();
            let (uri, headers) = head.recv().unwrap();
            (socket, uri, headers)
        }

        async fn send(socket: &mut WebSocketStream<Stream>, value: Value) {
            socket
                .send(Message::Text(value.to_string().into()))
                .await
                .unwrap();
        }

        /// The relay half of a successful join; returns the client's auth message.
        async fn admit(socket: &mut WebSocketStream<Stream>, viewer: &str) -> Value {
            send(
                socket,
                json!({"type":"challenge","challenge":"relay-challenge"}),
            )
            .await;
            let Some(Ok(Message::Text(auth))) = socket.next().await else {
                panic!("expected the NIP-42 auth message");
            };
            send(
                socket,
                json!({"type":"joined","peer_index":0,"peers":[{"peer_index":0,"pubkey":viewer}]}),
            )
            .await;
            serde_json::from_str(&auth).unwrap()
        }

        #[tokio::test]
        async fn connect_sends_the_community_assertion_and_signs_nip42_with_the_same_key() {
            let (listener, connector, host, fi, call, relay, (token, issued)) =
                community(true).await;
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            let relay_side = async {
                let (mut socket, uri, headers) = upgrade(&listener).await;
                (admit(&mut socket, &call.viewer).await, uri, headers)
            };
            let (joined, (auth, uri, headers)) = tokio::join!(connecting, relay_side);
            let joined = joined.unwrap();
            assert!(joined.socket.is_some());
            assert_eq!(joined.peers, Peers::from([(0, call.viewer.clone())]));
            assert!(joined.expires_at.is_some());
            assert!(!joined.cancellation.is_cancelled());

            let requested: Value = serde_json::from_str(&issued.await.unwrap()[0]).unwrap();
            assert_eq!(
                requested["relay_url"], relay,
                "issued for the community origin and port"
            );
            assert_eq!(uri, "/huddle/room/audio");
            assert_eq!(
                headers["host"],
                &relay[6..],
                "the community's host and port"
            );
            assert_eq!(headers[assertion::HEADER], format!("Bearer {token}"));
            assert!(headers.get("authorization").is_none());

            let event: nostr::event::Event = serde_json::from_value(auth["event"].clone()).unwrap();
            event.verify().unwrap();
            assert_eq!(
                event.pubkey.to_hex(),
                call.viewer,
                "NIP-42 signed by the asserted key"
            );
            let event = serde_json::to_value(event).unwrap();
            assert_eq!(event["kind"], 22242);
            assert_eq!(
                event["tags"],
                json!([["relay", relay], ["challenge", "relay-challenge"]])
            );
            assert_eq!(auth["parent_channel_id"], call.parent);
        }

        #[tokio::test]
        async fn connect_without_a_required_session_sends_no_assertion() {
            let (listener, connector, host, fi, call, _, _) = community(false).await;
            fi.sign_out_for_test();
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            let relay_side = async {
                let (mut socket, _, headers) = upgrade(&listener).await;
                admit(&mut socket, &call.viewer).await;
                headers
            };
            let (joined, headers) = tokio::join!(connecting, relay_side);
            joined.unwrap();
            assert!(headers.get(assertion::HEADER).is_none());
            assert!(headers.get("authorization").is_none());
        }

        #[tokio::test]
        async fn signed_out_before_connect_opens_no_socket() {
            let (listener, connector, host, fi, call, _, _) = community(true).await;
            fi.sign_out_for_test();
            let result = connect_via(&host, &fi, &call, "room", connector).await;
            assert!(result.is_err());
            assert!(
                listener.0.accept().now_or_never().is_none(),
                "no upgrade was attempted"
            );
        }

        /// Retire the session at `gate`, then let the relay continue: the retired
        /// connect must end without authenticating or returning a socket.
        async fn retired_at(gate: &str, retire: impl FnOnce(&FederatedIdentity)) {
            let (listener, connector, host, fi, call, _, _) = community(true).await;
            let connecting = connect_via(&host, &fi, &call, "room", connector);
            tokio::pin!(connecting);
            let (reached, at_gate) = oneshot::channel();
            let (release, released) = oneshot::channel::<()>();
            let relay_side = tokio::spawn({
                let gate = gate.to_owned();
                async move {
                    if gate == "upgrade" {
                        // The upgrade request has arrived; withhold the response.
                        let mut stream = listener.accept().await;
                        let mut head = Vec::new();
                        while !head.ends_with(b"\r\n\r\n") {
                            head.push(stream.read_u8().await.unwrap());
                        }
                        reached.send(()).unwrap();
                        released.await.unwrap();
                        let mut rest = Vec::new();
                        // EOF: the client hung up instead of waiting.
                        let _ = stream.read_to_end(&mut rest).await;
                        rest.is_empty()
                    } else {
                        // Upgraded; the client now waits for the challenge.
                        let (mut socket, _, _): (WebSocketStream<Stream>, _, _) =
                            upgrade(&listener).await;
                        reached.send(()).unwrap();
                        released.await.unwrap();
                        let _ = socket
                            .send(Message::Text(
                                json!({"type":"challenge","challenge":"late"})
                                    .to_string()
                                    .into(),
                            ))
                            .await;
                        !matches!(socket.next().await, Some(Ok(Message::Text(_))))
                    }
                }
            });
            tokio::select! {
                _ = at_gate => {}
                result = &mut connecting => panic!("connect ended before the {gate} gate: {:?}", result.map(|_| ())),
            }
            retire(&fi);
            let result = tokio::time::timeout(FAILURE_BOUND, &mut connecting)
                .await
                .unwrap_or_else(|_| panic!("retired connect at the {gate} gate kept waiting"));
            assert_eq!(
                result.map(|_| ()).unwrap_err(),
                "Federated authorization changed"
            );
            release.send(()).unwrap();
            let silent = tokio::time::timeout(FAILURE_BOUND, relay_side)
                .await
                .unwrap()
                .unwrap();
            assert!(silent, "retired work sent more after the {gate} gate");
        }

        #[tokio::test]
        async fn sign_out_during_the_upgrade_ends_the_connect() {
            retired_at("upgrade", FederatedIdentity::sign_out_for_test).await;
        }

        #[tokio::test]
        async fn account_switch_during_the_upgrade_ends_the_connect() {
            retired_at("upgrade", FederatedIdentity::switch_account_for_test).await;
        }

        #[tokio::test]
        async fn sign_out_while_awaiting_the_challenge_sends_no_auth() {
            retired_at("challenge", FederatedIdentity::sign_out_for_test).await;
        }

        #[tokio::test]
        async fn account_switch_while_awaiting_the_challenge_sends_no_auth() {
            retired_at("challenge", FederatedIdentity::switch_account_for_test).await;
        }
    }

    #[test]
    fn tls_uses_an_explicit_provider_with_system_trust() {
        assert!(tls_config().is_ok());
    }

    #[test]
    fn mesh_join_delta_keeps_existing_speakers_and_reuse_clears_playout() {
        let mut codec = Codec::new().unwrap();
        let mut peers = BTreeMap::from([(1, "a".repeat(64)), (2, "b".repeat(64))]);
        let frame = [
            vec![1],
            codec.encoder.encode(&vec![0.1; FRAME_SAMPLES]).unwrap(),
        ]
        .concat();
        codec.insert(&frame, &peers).unwrap();
        codec.joined(
            &mut peers,
            roster(&json!({"peers":[{"peer_index":3,"pubkey":"c".repeat(64)}]})).unwrap(),
        );
        assert_eq!(peers.len(), 3);
        assert!(codec.receivers.contains_key(&1));
        let mut heard = Vec::new();
        codec
            .play(&peers, |peer, samples| {
                assert_eq!(samples.len(), 480);
                assert!(samples.iter().all(|s| s.is_finite()));
                heard.push(peer);
                Ok(())
            })
            .unwrap();
        assert_eq!(heard, vec!["a".repeat(64)]);
        codec.joined(&mut peers, BTreeMap::from([(1, "d".repeat(64))]));
        assert!(!codec.receivers.contains_key(&1));
        assert_eq!(peers.len(), 3);
        codec.insert(&frame, &peers).unwrap();
        codec.replace(&mut peers, BTreeMap::new());
        assert!(codec.receivers.is_empty());
    }

    #[test]
    fn malformed_frames_and_rosters_are_bounded() {
        assert!(roster(&json!({"peers":[{"peer_index":256,"pubkey":"a".repeat(64)}]})).is_err());
        assert!(roster(&json!({"peers":[{"peer_index":0,"pubkey":"bad"}]})).is_err());
        let mut codec = Codec::new().unwrap();
        for frame in [vec![0; 8], vec![0; 40010], vec![0; 50]] {
            codec.insert(&frame, &Peers::new()).unwrap();
        }
        assert!(codec.receivers.is_empty());
    }
}
