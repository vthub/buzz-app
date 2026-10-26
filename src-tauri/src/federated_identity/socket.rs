//! Only upgrade/frame transport. The renderer retains subscriptions and reconnects.
use super::{config::canonical_relay, FederatedIdentity};
use crate::identity::IdentityHost;
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::ipc::Channel;
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::tungstenite::{
    client::IntoClientRequest, protocol::WebSocketConfig, Message,
};
use tokio_util::sync::CancellationToken;

struct Connection {
    stop: CancellationToken,
    sender: mpsc::Sender<String>,
    start: Option<oneshot::Sender<()>>,
}
#[derive(Default)]
pub(crate) struct Sockets(Arc<Mutex<HashMap<String, Connection>>>);
impl Sockets {
    pub(crate) fn clear(&self) {
        for (_, connection) in self
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .drain()
        {
            connection.stop.cancel();
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub(crate) enum SocketEvent {
    Text {
        data: String,
    },
    /// The relay's close code and reason, when it sent a close frame.
    Closed {
        code: Option<u16>,
        reason: Option<String>,
    },
}
#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
pub(crate) enum SocketMode {
    Public,
    Native,
}

#[tauri::command]
pub(crate) async fn relay_socket_connect(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    identity: tauri::State<'_, IdentityHost>,
    id: String,
    relay: String,
    on_event: Channel<SocketEvent>,
) -> Result<SocketMode, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid socket connection")?;
    let relay = canonical_relay(&relay)?;
    let stop = CancellationToken::new();
    let (sender, mut outgoing) = mpsc::channel(16);
    let (start, started) = oneshot::channel();
    {
        let mut live = sockets
            .0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if live.len() >= 16 || live.contains_key(&id) {
            return Err("Native sockets are busy".into());
        }
        live.insert(
            id.clone(),
            Connection {
                stop: stop.clone(),
                sender,
                start: Some(start),
            },
        );
    }
    let connect = upgrade(
        fi.inner(),
        identity.inner(),
        &relay,
        id.clone(),
        stop.clone(),
    );
    let result = tokio::select! { _ = stop.cancelled() => Err("Native socket canceled".into()), result = connect => result };
    let (mut socket, assertion, cancel) = match result {
        Ok(Some(connection)) => connection,
        result => {
            sockets
                .0
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&id);
            return result.map(|_| SocketMode::Public);
        }
    };
    let host = fi.inner().clone();
    let identity = identity.inner().clone();
    let registry = sockets.0.clone();
    tauri::async_runtime::spawn(async move {
        let expires = assertion.remaining();
        let expiry = tokio::time::sleep(expires);
        tokio::pin!(expiry);
        let mut closing: Option<(u16, String)> = None;
        let ready = tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(10), started) => result.is_ok_and(|value| value.is_ok()),
            _ = cancel.cancelled() => false,
            _ = stop.cancelled() => false,
            _ = &mut expiry => false,
        };
        if ready {
            let pump = async {
                loop {
                    tokio::select! {
                        data = outgoing.recv() => {
                            let Some(data) = data else { break; };
                            if host.admit_assertion(&identity, &assertion).await.is_err() { break; }
                            // FI and NIP-42 must bind the same native key.
                            if let Ok(serde_json::Value::Array(frame)) = serde_json::from_str::<serde_json::Value>(&data) {
                                if frame.first().and_then(|v| v.as_str()) == Some("AUTH") && frame.get(1).and_then(|v| v.get("pubkey")).and_then(|v| v.as_str()) != Some(assertion.viewer.as_str()) { break; }
                            }
                            if socket.send(Message::Text(data.into())).await.is_err() { break; }
                        }
                        frame = socket.next() => {
                            if host.admit_assertion(&identity, &assertion).await.is_err() { break; }
                            match frame {
                                Some(Ok(Message::Text(data))) if on_event.send(SocketEvent::Text {data:data.to_string()}).is_ok() => {},
                                Some(Ok(Message::Ping(data))) => { if socket.send(Message::Pong(data)).await.is_err() { break; } },
                                Some(Ok(Message::Pong(_))) => {},
                                Some(Ok(Message::Close(frame))) => {
                                    closing = frame.map(|frame| (u16::from(frame.code), frame.reason.to_string()));
                                    break;
                                }
                                _ => break,
                            }
                        }
                    }
                }
            };
            tokio::select! {
                _ = cancel.cancelled() => {},
                _ = stop.cancelled() => {},
                _ = &mut expiry => {},
                _ = pump => {},
            }
        }
        // Do not flush queued protected frames after expiry or retirement.
        drop(socket);
        registry
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&id);
        // A policy close may end an expired or refused assertion: never reuse it.
        if closing.as_ref().is_some_and(|(code, _)| *code == 1008) {
            host.reject_assertion(&assertion).await;
        }
        let (code, reason) = match closing {
            Some((code, reason)) => (Some(code), Some(reason)),
            None => (None, None),
        };
        let _ = on_event.send(SocketEvent::Closed { code, reason });
    });
    Ok(SocketMode::Native)
}
#[tauri::command]
pub(crate) fn relay_socket_start(
    sockets: tauri::State<'_, Sockets>,
    id: String,
) -> Result<(), String> {
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get_mut(&id)
        .and_then(|entry| entry.start.take())
        .ok_or("Native socket retired")?
        .send(())
        .map_err(|_| "Native socket retired".into())
}
#[tauri::command]
pub(crate) fn relay_socket_send(
    sockets: tauri::State<'_, Sockets>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > 1024 * 1024 {
        return Err("Socket frame too large".into());
    }
    sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .get(&id)
        .ok_or("Native socket retired")?
        .sender
        .try_send(data)
        .map_err(|_| "Socket send queue is full".into())
}
#[tauri::command]
pub(crate) fn relay_socket_close(
    sockets: tauri::State<'_, Sockets>,
    fi: tauri::State<'_, FederatedIdentity>,
    id: String,
) {
    fi.close_discovery(&id);
    if let Some(entry) = sockets
        .0
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .remove(&id)
    {
        entry.stop.cancel();
    }
}

type Upgraded = (
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    super::assertion::Assertion,
    CancellationToken,
);
/// The native upgrade to `relay` with its assertion, or `None` when the
/// community does not require NIP-FI and the renderer connects instead.
async fn upgrade(
    fi: &FederatedIdentity,
    identity: &IdentityHost,
    relay: &str,
    id: String,
    stop: CancellationToken,
) -> Result<Option<Upgraded>, String> {
    let url = url::Url::parse(relay).map_err(|_| "Invalid relay")?;
    let assertion = fi.assertion_for_socket(identity, &url, id, stop).await?;
    let Some(assertion) = assertion else {
        return Ok(None);
    };
    let cancel = fi.cancellation_for(&assertion.revision)?;
    fi.admit_assertion(identity, &assertion).await?;
    let mut request = relay
        .into_client_request()
        .map_err(|_| "Invalid native socket request")?;
    request.headers_mut().insert(
        super::assertion::HEADER,
        assertion
            .header
            .as_str()
            .parse()
            .map_err(|_| "Invalid federated authorization")?,
    );
    let config = WebSocketConfig::default()
        .max_message_size(Some(1024 * 1024))
        .max_frame_size(Some(1024 * 1024));
    let _ = rustls::crypto::ring::default_provider().install_default();
    let (socket, _) = tokio::select! {
        _ = cancel.cancelled() => return Err("Federated session changed".into()),
        result = tokio::time::timeout(Duration::from_secs(30), tokio_tungstenite::connect_async_tls_with_config(request, Some(config), false, connector())) => match result.map_err(|_| "Native socket timed out")? {
            Ok(connection) => connection,
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                // NIP-FI's fixed refusal classes: 401 wants fresh evidence,
                // 403 is a decision to stop, 503 is a temporary outage.
                return Err(match response.status().as_u16() {
                    401 => {
                        fi.reject_assertion(&assertion).await;
                        "relay-unauthorized"
                    }
                    403 => "relay-forbidden",
                    503 => "relay-unavailable",
                    _ => "Native socket upgrade refused",
                }
                .into());
            }
            Err(_) => return Err("Native socket upgrade refused".into()),
        },
    };
    fi.admit_assertion(identity, &assertion).await?;
    Ok(Some((socket, assertion, cancel)))
}

/// Tests' loopback communities use one self-signed root.
fn connector() -> Option<tokio_tungstenite::Connector> {
    #[cfg(test)]
    return Some(super::testing::trusted_connector());
    #[cfg(not(test))]
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::federated_identity::testing::{community, reply};

    fn relay(community: &super::super::testing::Community) -> String {
        format!("wss://{}", community.origin.authority())
    }

    /// The upgrade request carries exactly the issued assertion; the relay's
    /// refusal ends the attempt after it is captured.
    #[tokio::test]
    async fn upgrade_attaches_for_required_discovery() {
        let community = community(true).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert_eq!(result.err().as_deref(), Some("relay-forbidden"));
        let heads = server.heads().await;
        assert!(
            heads[0].to_ascii_lowercase().contains("upgrade: websocket"),
            "{}",
            heads[0]
        );
        community.assert_carried(&heads[0]);
    }

    /// Ordinary discovery leaves the socket public: no native upgrade, so no
    /// request that could carry an assertion.
    #[tokio::test]
    async fn upgrade_omits_for_ordinary_discovery() {
        let community = community(false).await;
        let server = community.serve(vec![reply("403 Forbidden", "{}")]);
        let result = upgrade(
            &community.fi,
            &community.host,
            &relay(&community),
            uuid::Uuid::new_v4().to_string(),
            CancellationToken::new(),
        )
        .await;
        assert!(matches!(result, Ok(None)));
        assert!(server.received().is_empty());
    }
}
