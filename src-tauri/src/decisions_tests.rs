use super::*;
use crate::jev::KeyStore;
use std::sync::Mutex as StdMutex;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use zeroize::Zeroizing;

#[derive(Default)]
struct FakeStore {
    key: StdMutex<Option<String>>,
    reads: StdMutex<usize>,
    /// Reads fail, as a locked or refused Keychain does.
    unreadable: StdMutex<bool>,
    /// Reads block this long, as a stalled `security` process does.
    stall: StdMutex<Duration>,
}
impl KeyStore for Arc<FakeStore> {
    fn read(&self) -> Result<Option<Zeroizing<String>>, String> {
        *self.reads.lock().unwrap() += 1;
        std::thread::sleep(*self.stall.lock().unwrap());
        if *self.unreadable.lock().unwrap() {
            return Err("locked".into());
        }
        Ok(self.key.lock().unwrap().clone().map(Zeroizing::new))
    }
    fn replace(&self, key: &str) -> Result<(), String> {
        *self.key.lock().unwrap() = Some(key.into());
        Ok(())
    }
    fn clear(&self) -> Result<(), String> {
        *self.key.lock().unwrap() = None;
        Ok(())
    }
}
fn keys(key: Option<&str>) -> (Arc<FakeStore>, JevHost) {
    let store = Arc::new(FakeStore::default());
    *store.key.lock().unwrap() = key.map(Into::into);
    let host = JevHost::with(Box::new(store.clone()));
    (store, host)
}

/// One connection per response; `None` accepts and never answers. Returns the
/// URL and each request's head and body.
async fn server(
    responses: Vec<Option<(u16, &'static str, String)>>,
) -> (String, Arc<StdMutex<Vec<(String, Value)>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/decide", listener.local_addr().unwrap());
    let seen = Arc::new(StdMutex::new(Vec::new()));
    let log = seen.clone();
    tokio::spawn(async move {
        let mut held = Vec::new();
        for response in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut request = Vec::new();
            let mut buf = [0u8; 8192];
            let (head, body) = loop {
                let n = socket.read(&mut buf).await.unwrap();
                request.extend_from_slice(&buf[..n]);
                let text = String::from_utf8_lossy(&request).to_string();
                if let Some(end) = text.find("\r\n\r\n") {
                    let length = text
                        .lines()
                        .find_map(|l| {
                            l.to_ascii_lowercase()
                                .strip_prefix("content-length:")
                                .map(|v| v.trim().parse::<usize>().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= end + 4 + length || n == 0 {
                        break (
                            text[..end].to_ascii_lowercase(),
                            request[end + 4..].to_vec(),
                        );
                    }
                }
            };
            log.lock()
                .unwrap()
                .push((head, serde_json::from_slice(&body).unwrap_or(Value::Null)));
            match response {
                Some((status, headers, body)) => {
                    let reply = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n{headers}\r\n{body}",
                        body.len()
                    );
                    socket.write_all(reply.as_bytes()).await.unwrap();
                }
                None => held.push(socket),
            }
        }
        std::future::pending::<()>().await;
        drop(held);
    });
    (url, seen)
}
fn decisions(url: &str) -> DecisionsHost {
    DecisionsHost::with(
        Endpoints {
            typesafe: url.into(),
            builderlab: Some(url.into()),
        },
        TIMEOUT,
    )
}
fn request(questions: Value) -> Request {
    serde_json::from_value(
        json!({ "state": "The build is broken on main.", "questions": questions }),
    )
    .unwrap()
}
/// One question of each type.
fn every_type() -> Request {
    request(json!({
        "urgent": { "type": "yes_no", "instructions": "It needs attention now." },
        "topic": { "type": "choice", "instructions": "What is it about?",
                   "options": { "build": "CI or builds", "other": "Anything else" } },
        "severity": { "type": "score", "instructions": "How severe?", "levels": ["low", "medium", "high"] },
    }))
}
fn expected(model: &str, backend: Backend) -> Decided {
    Decided::Answered {
        backend,
        model: model.into(),
        answers: BTreeMap::from([
            ("urgent".into(), Answer::YesNo { probability: 0.8 }),
            (
                "topic".into(),
                Answer::Choice {
                    choice: "build".into(),
                    confidence: 0.9,
                    probabilities: BTreeMap::from([("build".into(), 0.95), ("other".into(), 0.05)]),
                },
            ),
            (
                "severity".into(),
                Answer::Score {
                    score: 2.0,
                    confidence: 0.7,
                    probabilities: BTreeMap::from([
                        ("0".into(), 0.1),
                        ("1".into(), 0.2),
                        ("2".into(), 0.7),
                    ]),
                },
            ),
        ]),
    }
}

#[tokio::test]
async fn typesafe_sends_the_saved_key_and_reads_tagged_answers() {
    let reply = json!({ "model": "jev-1.13.0", "answers": {
        "urgent": { "type": "noul", "noul": 0.8 },
        "topic": { "type": "choice", "choice": "build", "confidence": 0.9, "probabilities": { "build": 0.95, "other": 0.05 } },
        "severity": { "type": "score", "score": 2.0, "confidence": 0.7, "probabilities": { "0": 0.1, "1": 0.2, "2": 0.7 } },
    }});
    let (url, seen) = server(vec![Some((200, "", reply.to_string()))]).await;
    let (_, keys) = keys(Some("test-key-do-not-use"));
    let result = decisions(&url)
        .decide(&keys, Backend::Typesafe, None, every_type())
        .await;
    assert_eq!(result, expected("jev-1.13.0", Backend::Typesafe));
    let (head, body) = seen.lock().unwrap()[0].clone();
    assert!(head.contains("authorization: bearer test-key-do-not-use")); // sadscan:disable np.http.2 (fake test key)
    assert!(head.contains("accept: application/json"), "{head}");
    assert_eq!(
        body["questions"],
        json!({
            "urgent": { "type": "noul", "instructions": "It needs attention now." },
            "topic": { "type": "choice", "instructions": "What is it about?", "criteria": { "build": "CI or builds", "other": "Anything else" } },
            "severity": { "type": "score", "instructions": "How severe?", "criteria": ["low", "medium", "high"] },
        })
    );
    assert_eq!(body["model"], "jev-1.13.0");
    // The webview's result carries no key.
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("test-key-do-not-use"));
}

#[tokio::test]
async fn typesafe_without_a_key_sends_nothing() {
    let (url, seen) = server(vec![]).await;
    let (_, keys) = keys(None);
    let result = decisions(&url)
        .decide(&keys, Backend::Typesafe, None, every_type())
        .await;
    assert_eq!(
        result,
        Decided::Failed {
            backend: Backend::Typesafe,
            reason: Failure::MissingCredentials
        }
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn malformed_questions_are_refused_before_any_call() {
    let (url, seen) = server(vec![]).await;
    let (store, keys) = keys(Some("test-key-do-not-use"));
    let host = decisions(&url);
    let bad = [
        json!({}),
        json!({ "": { "type": "yes_no", "instructions": "x" } }),
        json!({ "a": { "type": "yes_no", "instructions": "  " } }),
        json!({ "a": { "type": "choice", "instructions": "x", "options": { "only": "one" } } }),
        json!({ "a": { "type": "score", "instructions": "x", "levels": ["one"] } }),
        json!({ "a": { "type": "score", "instructions": "x", "levels": ["a", ""] } }),
        json!({ "x".repeat(65): { "type": "yes_no", "instructions": "x" } }),
    ];
    for questions in bad {
        let result = host
            .decide(&keys, Backend::Typesafe, None, request(questions.clone()))
            .await;
        assert_eq!(
            result,
            Decided::Failed {
                backend: Backend::Typesafe,
                reason: Failure::InvalidRequest
            },
            "{questions}"
        );
    }
    let mut empty = request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    empty.state = " ".into();
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, empty).await,
        Decided::Failed {
            reason: Failure::InvalidRequest,
            ..
        }
    ));
    let mut huge = request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    huge.state = "x".repeat(INPUT_LIMIT);
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, huge).await,
        Decided::Failed {
            reason: Failure::InputLimit,
            ..
        }
    ));
    assert!(seen.lock().unwrap().is_empty());
    // Refused before the key is read.
    assert_eq!(*store.reads.lock().unwrap(), 0);
}

#[tokio::test]
async fn answers_that_do_not_fit_the_questions_are_invalid() {
    let one = || {
        request(json!({
            "topic": { "type": "choice", "instructions": "x", "options": { "build": "b", "other": "o" } },
        }))
    };
    let bad = [
        // Another model than the pinned one.
        json!({ "model": "jev-2", "answers": { "topic": { "type": "choice", "choice": "build", "confidence": 0.9 } } }),
        // A choice that was not offered.
        json!({ "model": "jev-1.13.0", "answers": { "topic": { "type": "choice", "choice": "deploy", "confidence": 0.9 } } }),
        // Another type than asked.
        json!({ "model": "jev-1.13.0", "answers": { "topic": { "type": "noul", "noul": 0.9 } } }),
        // Out of range.
        json!({ "model": "jev-1.13.0", "answers": { "topic": { "type": "choice", "choice": "build", "confidence": 1.5 } } }),
        // A probability for an unknown option.
        json!({ "model": "jev-1.13.0", "answers": { "topic": { "type": "choice", "choice": "build", "confidence": 0.9, "probabilities": { "deploy": 0.1 } } } }),
        // Missing.
        json!({ "model": "jev-1.13.0", "answers": {} }),
        json!({ "model": "jev-1.13.0" }),
    ];
    let (_, keys) = keys(Some("test-key-do-not-use"));
    for reply in bad {
        let (url, _) = server(vec![Some((200, "", reply.to_string()))]).await;
        let result = decisions(&url)
            .decide(&keys, Backend::Typesafe, None, one())
            .await;
        assert_eq!(
            result,
            Decided::Failed {
                backend: Backend::Typesafe,
                reason: Failure::InvalidResponse
            },
            "{reply}"
        );
    }
    let (url, _) = server(vec![Some((200, "", "x".repeat(RESPONSE_LIMIT + 1)))]).await;
    assert!(matches!(
        decisions(&url)
            .decide(&keys, Backend::Typesafe, None, one())
            .await,
        Decided::Failed {
            reason: Failure::InvalidResponse,
            ..
        }
    ));
}

#[tokio::test]
async fn statuses_map_to_one_failure_and_are_not_retried() {
    let yes_no = || request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    let backend = Backend::Typesafe;
    let cases = [
        (302, Failure::Unauthorized),
        (403, Failure::Unauthorized),
        (400, Failure::InvalidRequest),
        (422, Failure::InvalidRequest),
        (429, Failure::ServiceError),
        (503, Failure::ServiceError),
    ];
    for (status, reason) in cases {
        let ok =
            json!({ "model": "jev-1.13.0", "answers": { "a": { "type": "noul", "noul": 0.5 } } });
        let (url, seen) = server(vec![
            Some((
                status,
                "location: https://example.invalid/\r\n",
                String::new(),
            )),
            Some((200, "", ok.to_string())),
        ])
        .await;
        let (_, keys) = keys(Some("test-key-do-not-use"));
        let result = decisions(&url).decide(&keys, backend, None, yes_no()).await;
        assert_eq!(result, Decided::Failed { backend, reason }, "{status}");
        assert_eq!(seen.lock().unwrap().len(), 1, "{status}");
    }
}

#[tokio::test]
async fn a_refused_key_is_read_again_on_the_next_call() {
    let (url, _) = server(vec![Some((401, "", String::new()))]).await;
    let (store, keys) = keys(Some("old"));
    let host = decisions(&url);
    let yes_no = || request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, yes_no()).await,
        Decided::Failed {
            reason: Failure::Unauthorized,
            ..
        }
    ));
    *store.key.lock().unwrap() = None;
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, yes_no()).await,
        Decided::Failed {
            reason: Failure::MissingCredentials,
            ..
        }
    ));
    assert_eq!(*store.reads.lock().unwrap(), 2);
}

#[tokio::test]
async fn an_unreadable_keychain_is_a_service_error_and_is_read_again() {
    let reply =
        json!({ "model": "jev-1.13.0", "answers": { "a": { "type": "noul", "noul": 0.5 } } });
    let (url, seen) = server(vec![Some((200, "", reply.to_string()))]).await;
    let (store, keys) = keys(Some("k"));
    *store.unreadable.lock().unwrap() = true;
    let host = decisions(&url);
    let yes_no = || request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    // Not "missing": the key may still be saved.
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, yes_no()).await,
        Decided::Failed {
            reason: Failure::ServiceError,
            ..
        }
    ));
    *store.unreadable.lock().unwrap() = false;
    assert!(matches!(
        host.decide(&keys, Backend::Typesafe, None, yes_no()).await,
        Decided::Answered { .. }
    ));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn a_stalled_keychain_read_is_inside_the_deadline() {
    let (store, keys) = keys(Some("k"));
    *store.stall.lock().unwrap() = Duration::from_secs(3);
    let mut slow = request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    slow.timeout_ms = Some(1_000);
    let started = Instant::now();
    let result = decisions("http://127.0.0.1:9/")
        .decide(&keys, Backend::Typesafe, None, slow)
        .await;
    assert_eq!(
        result,
        Decided::Failed {
            backend: Backend::Typesafe,
            reason: Failure::Timeout
        }
    );
    assert!(started.elapsed() < Duration::from_secs(2));
}

#[tokio::test]
async fn the_callers_timeout_bounds_the_call() {
    let (url, seen) = server(vec![None]).await;
    let (_, keys) = keys(Some("test-key-do-not-use"));
    let mut slow = request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    slow.timeout_ms = Some(1_000);
    let started = Instant::now();
    let result = decisions(&url)
        .decide(&keys, Backend::Typesafe, None, slow)
        .await;
    assert_eq!(
        result,
        Decided::Failed {
            backend: Backend::Typesafe,
            reason: Failure::Timeout
        }
    );
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(seen.lock().unwrap().len(), 1);
}

fn session(value: &str) -> Option<Zeroizing<String>> {
    Some(Zeroizing::new(value.into()))
}

#[tokio::test]
async fn builderlab_sends_the_sign_in_and_reads_named_answers() {
    let reply = json!({ "model": "any-model", "answers": [
        { "name": "urgent", "predicate": { "probability": 0.8 } },
        { "name": "topic", "choice": { "choice": "build", "confidence": 0.9,
          "probabilities": [{ "value": "build", "probability": 0.95 }, { "value": "other", "probability": 0.05 }] } },
        { "name": "severity", "score": { "score": 2.0, "confidence": 0.7,
          "probabilities": [{ "level": 0, "probability": 0.1 }, { "level": 1, "probability": 0.2 }, { "level": 2, "probability": 0.7 }] } },
    ]});
    let (url, seen) = server(vec![Some((200, "", reply.to_string()))]).await;
    let (store, keys) = keys(Some("test-key-do-not-use"));
    let result = decisions(&url)
        .decide(
            &keys,
            Backend::Builderlab,
            session("bb-session"),
            every_type(),
        )
        .await;
    assert_eq!(result, expected("any-model", Backend::Builderlab));
    let (head, body) = seen.lock().unwrap()[0].clone();
    assert!(
        head.contains("x-bb-session-credential: bb-session"),
        "{head}"
    );
    // The TypeSafe key is neither read nor sent.
    assert!(!head.contains("authorization"), "{head}");
    assert_eq!(*store.reads.lock().unwrap(), 0);
    assert_eq!(body["input"], "The build is broken on main.");
    assert_eq!(
        body["questions"],
        json!([
            { "name": "severity", "instructions": "How severe?", "score": { "levels": ["low", "medium", "high"] } },
            { "name": "topic", "instructions": "What is it about?", "choice": { "choices": [
                { "value": "build", "description": "CI or builds" },
                { "value": "other", "description": "Anything else" },
            ] } },
            { "name": "urgent", "instructions": "It needs attention now.", "predicate": {} },
        ])
    );
    assert!(!serde_json::to_string(&result)
        .unwrap()
        .contains("bb-session"));
}

#[tokio::test]
async fn builderlab_without_a_sign_in_or_an_address_sends_nothing() {
    let (url, seen) = server(vec![]).await;
    let (_, keys) = keys(None);
    for missing in [None, session(" ")] {
        assert_eq!(
            decisions(&url)
                .decide(&keys, Backend::Builderlab, missing, every_type())
                .await,
            Decided::Failed {
                backend: Backend::Builderlab,
                reason: Failure::MissingCredentials
            }
        );
    }
    let unconfigured = DecisionsHost::with(
        Endpoints {
            typesafe: url.clone(),
            builderlab: None,
        },
        TIMEOUT,
    );
    assert_eq!(
        unconfigured
            .decide(
                &keys,
                Backend::Builderlab,
                session("bb-session"),
                every_type()
            )
            .await,
        Decided::Failed {
            backend: Backend::Builderlab,
            reason: Failure::ServiceError
        }
    );
    assert!(seen.lock().unwrap().is_empty());
}

#[tokio::test]
async fn only_a_builderlab_401_ends_the_sign_in_and_none_touch_the_key() {
    for (status, reason) in [
        (401, Failure::SessionExpired),
        // Refusing decisions is not refusing the sign-in.
        (403, Failure::Unauthorized),
        (302, Failure::Unauthorized),
        (404, Failure::ServiceError),
        (429, Failure::ServiceError),
        (503, Failure::ServiceError),
    ] {
        let (url, _) = server(vec![Some((status, "", String::new()))]).await;
        let (store, keys) = keys(Some("k"));
        let yes_no = request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
        assert_eq!(
            decisions(&url)
                .decide(&keys, Backend::Builderlab, session("old"), yes_no)
                .await,
            Decided::Failed {
                backend: Backend::Builderlab,
                reason
            },
            "{status}"
        );
        assert_eq!(*store.reads.lock().unwrap(), 0);
        assert_eq!(store.key.lock().unwrap().as_deref(), Some("k"));
    }
}

/// A reply captured from kgoose's OpenAI Decisions route (2026-10-21), which
/// Builderlab is to serve: the shape #1334 sends was accepted unchanged.
#[tokio::test]
async fn builderlab_reads_a_real_openai_decisions_reply() {
    let reply = r#"{"model":"gpt-6-luna","usage":{"input_tokens":392,"output_tokens":0},"answers":[{"name":"urgent","predicate":{"probability":1.0}},{"name":"topic","choice":{"choice":"build","confidence":1.0,"probabilities":[{"value":"build","probability":1.0},{"value":"other","probability":0.0}]}},{"name":"severity","score":{"score":0.28,"confidence":0.58,"probabilities":[{"level":0,"label":"low","probability":0.73},{"level":1,"label":"medium","probability":0.26},{"level":2,"label":"high","probability":0.01}]}}]}"#;
    let (url, _) = server(vec![Some((200, "", reply.into()))]).await;
    let (_, keys) = keys(None);
    let Decided::Answered { model, answers, .. } = decisions(&url)
        .decide(&keys, Backend::Builderlab, session("s"), every_type())
        .await
    else {
        panic!("not answered");
    };
    assert_eq!(model, "gpt-6-luna");
    assert_eq!(answers["urgent"], Answer::YesNo { probability: 1.0 });
    assert!(matches!(&answers["topic"], Answer::Choice { choice, .. } if choice == "build"));
    assert!(
        matches!(&answers["severity"], Answer::Score { score, probabilities, .. }
        if (*score - 0.28).abs() < 1e-9 && probabilities.len() == 3)
    );
}

#[tokio::test]
async fn ambiguous_builderlab_answers_are_invalid() {
    let yes_no = || request(json!({ "a": { "type": "yes_no", "instructions": "x" } }));
    for answers in [
        json!([{ "name": "a", "predicate": { "probability": 0.1 } },
               { "name": "a", "predicate": { "probability": 0.9 } }]),
        json!([{ "name": "a", "predicate": { "probability": 0.1 },
                 "score": { "score": 0.0, "confidence": 0.5 } }]),
    ] {
        let reply = json!({ "model": "m", "answers": answers }).to_string();
        let (url, _) = server(vec![Some((200, "", reply))]).await;
        let (_, keys) = keys(None);
        assert_eq!(
            decisions(&url)
                .decide(&keys, Backend::Builderlab, session("s"), yes_no())
                .await,
            Decided::Failed {
                backend: Backend::Builderlab,
                reason: Failure::InvalidResponse
            },
            "{answers}"
        );
    }
}

#[test]
fn the_webview_names_backends_and_answers_as_documented() {
    assert_eq!(
        serde_json::to_value(Decided::Failed {
            backend: Backend::Typesafe,
            reason: Failure::MissingCredentials
        })
        .unwrap(),
        json!({ "outcome": "failed", "backend": "typesafe", "reason": "missing_credentials" })
    );
    assert_eq!(
        serde_json::to_value(Backend::Builderlab).unwrap(),
        json!("builderlab")
    );
    assert_eq!(
        serde_json::to_value(Answer::YesNo { probability: 0.5 }).unwrap(),
        json!({ "type": "yes_no", "probability": 0.5 })
    );
}
