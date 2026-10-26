//! Native terminal capability. Owner IDs are lifecycle fences, not a plugin sandbox.
//! No remote shell endpoint, signing capability or inherited host credentials.
mod context;
#[cfg(all(test, unix))]
mod tests;
#[cfg(unix)]
mod unix;

pub(crate) use context::TerminalContext;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
#[cfg(target_os = "macos")]
pub(crate) use unix::resolve_shell;
use uuid::Uuid;

const MAX_OWNERS: usize = 32;
#[cfg(unix)]
const MAX_SESSIONS: usize = 20;
#[cfg(unix)]
pub(super) const MAX_BYTES: usize = 64 * 1024;
pub(super) const MAX_PENDING_INPUT: usize = 1024 * 1024;

#[cfg(unix)]
pub(crate) struct ReadResult {
    data: Vec<u8>,
    exited: bool,
}
#[cfg(unix)]
impl ReadResult {
    /// Raw IPC body: output bytes, then one exit flag byte. JSON would encode
    /// every output byte as a decimal number in an array.
    fn into_body(mut self) -> Vec<u8> {
        self.data.push(u8::from(self.exited));
        self.data
    }
}

#[cfg(unix)]
type Session = unix::Session;
#[cfg(not(unix))]
struct Session;

#[derive(Default)]
struct Registry {
    stopped: bool,
    owners: HashMap<String, Owner>,
}

#[derive(Default)]
struct Owner {
    closed: bool,
    sessions: HashMap<String, Arc<Mutex<Session>>>,
}

#[derive(Clone, Default)]
pub(crate) struct Terminals(Arc<Mutex<Registry>>);
impl Terminals {
    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Registry>, String> {
        self.0
            .lock()
            .map_err(|_| "Terminal registry unavailable".into())
    }

    fn create_owner(&self) -> Result<String, String> {
        if !cfg!(unix) {
            return Err("Local terminals require macOS or Linux".into());
        }
        let mut state = self.lock()?;
        if state.stopped {
            return Err("Terminal service has stopped".into());
        }
        if state.owners.len() >= MAX_OWNERS {
            return Err("Too many terminal owners".into());
        }
        let id = Uuid::new_v4().to_string();
        state.owners.insert(id.clone(), Owner::default());
        Ok(id)
    }

    fn spawn(
        &self,
        owner: &str,
        context: TerminalContext,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        context.validate()?;
        dimensions(cols, rows)?;
        #[cfg(unix)]
        {
            self.spawn_with(owner, |id| unix::command(&context, id), cols, rows)
        }
        #[cfg(not(unix))]
        {
            let _ = owner;
            Err("Local terminals require macOS or Linux".into())
        }
    }

    #[cfg(unix)]
    fn spawn_with(
        &self,
        owner: &str,
        command: impl FnOnce(&str) -> Result<portable_pty::CommandBuilder, String>,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        dimensions(cols, rows)?;
        // The lock covers admission, creation and insertion. close_owner cannot
        // return before an admitted spawn is accounted for and terminated, and
        // an already revoked owner cannot create another process.
        let mut state = self.lock()?;
        if state.owners.get(owner).is_none_or(|owner| owner.closed) {
            return Err("Terminal owner has closed".into());
        }
        if state
            .owners
            .values()
            .map(|owner| owner.sessions.len())
            .sum::<usize>()
            >= MAX_SESSIONS
        {
            return Err("Too many terminal sessions (maximum 20)".into());
        }
        let id = Uuid::new_v4().to_string();
        let session = Session::spawn(command(&id)?, cols, rows)?;
        state
            .owners
            .get_mut(owner)
            .ok_or("Terminal owner has closed")?
            .sessions
            .insert(id.clone(), Arc::new(Mutex::new(session)));
        Ok(id)
    }

    #[cfg(unix)]
    fn with_session<T>(
        &self,
        owner: &str,
        id: &str,
        run: impl FnOnce(&mut Session) -> Result<T, String>,
    ) -> Result<T, String> {
        let session = self
            .lock()?
            .owners
            .get(owner)
            .filter(|owner| !owner.closed)
            .and_then(|owner| owner.sessions.get(id))
            .cloned()
            .ok_or("Terminal session is unavailable for this owner")?;
        // Only this session stays locked, so one draining terminal cannot
        // delay input, output or resize in another.
        let mut session = session.lock().map_err(|_| "Terminal session unavailable")?;
        run(&mut session)
    }

    fn close(&self, owner: &str, id: &str) -> Result<(), String> {
        let session = self
            .lock()?
            .owners
            .get(owner)
            .and_then(|entry| entry.sessions.get(id))
            .map(|session| (owner.to_owned(), id.to_owned(), session.clone()));
        self.stop_sessions(session.into_iter().collect())
    }

    fn close_owner(&self, owner: &str) -> Result<(), String> {
        let sessions = {
            let mut state = self.lock()?;
            let Some(entry) = state.owners.get_mut(owner) else {
                return Ok(());
            };
            entry.closed = true; // revoke before cleanup, even when cleanup fails
            handles(owner, entry)
        };
        self.stop_sessions(sessions)
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let sessions = {
            let mut state = self.lock()?;
            state.stopped = true;
            let mut sessions = Vec::new();
            for (id, owner) in &mut state.owners {
                owner.closed = true;
                sessions.extend(handles(id, owner));
            }
            sessions
        };
        self.stop_sessions(sessions)
    }

    /// Stops sessions without holding the registry lock, so waiting on a busy
    /// session never stalls another. Handles stay registered until stopped:
    /// a failed stop leaves cleanup to an explicit retry. Owners revoked before
    /// this call cannot admit new sessions, so the handle list is complete.
    fn stop_sessions(&self, sessions: Vec<Handle>) -> Result<(), String> {
        let mut result = Ok(());
        let mut stopped = Vec::new();
        for (owner, id, session) in sessions {
            match stop(&session) {
                Ok(()) => stopped.push((owner, id)),
                Err(error) => result = Err(error),
            }
        }
        let mut state = self.lock()?;
        for (owner, id) in stopped {
            if let Some(entry) = state.owners.get_mut(&owner) {
                entry.sessions.remove(&id);
            }
        }
        state
            .owners
            .retain(|_, owner| !owner.closed || !owner.sessions.is_empty());
        result
    }
}

/// Owner ID, session ID and the session's own lock.
type Handle = (String, String, Arc<Mutex<Session>>);

fn handles(owner: &str, entry: &Owner) -> Vec<Handle> {
    entry
        .sessions
        .iter()
        .map(|(id, session)| (owner.to_owned(), id.clone(), session.clone()))
        .collect()
}

fn stop(session: &Mutex<Session>) -> Result<(), String> {
    #[cfg(unix)]
    {
        session
            .lock()
            .map_err(|_| "Terminal session unavailable")?
            .shutdown()
    }
    #[cfg(not(unix))]
    {
        let _ = session;
        Ok(())
    }
}

fn dimensions(cols: u16, rows: u16) -> Result<(), String> {
    if !(2..=500).contains(&cols) || !(1..=300).contains(&rows) {
        Err("Terminal dimensions must be 2–500 columns and 1–300 rows".into())
    } else {
        Ok(())
    }
}

#[tauri::command]
pub(crate) async fn terminal_create_owner(
    state: tauri::State<'_, Terminals>,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.create_owner())
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_spawn(
    state: tauri::State<'_, Terminals>,
    owner: String,
    context: TerminalContext,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.spawn(&owner, context, cols, rows))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_read(
    state: tauri::State<'_, Terminals>,
    owner: String,
    id: String,
) -> Result<tauri::ipc::Response, String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        {
            state
                .with_session(&owner, &id, Session::read)
                .map(|result| tauri::ipc::Response::new(result.into_body()))
        }
        #[cfg(not(unix))]
        {
            let _ = (state, owner, id);
            Err("Local terminals require macOS or Linux".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_write(
    state: tauri::State<'_, Terminals>,
    owner: String,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_PENDING_INPUT {
        return Err("Terminal input exceeds 1 MiB".into());
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        {
            state.with_session(&owner, &id, |session| session.write(data.as_bytes()))
        }
        #[cfg(not(unix))]
        {
            let _ = (state, owner, id, data);
            Err("Local terminals require macOS or Linux".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_resize(
    state: tauri::State<'_, Terminals>,
    owner: String,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    dimensions(cols, rows)?;
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(unix)]
        {
            state.with_session(&owner, &id, |session| session.resize(cols, rows))
        }
        #[cfg(not(unix))]
        {
            let _ = (state, owner, id);
            Err("Local terminals require macOS or Linux".into())
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_close(
    state: tauri::State<'_, Terminals>,
    owner: String,
    id: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.close(&owner, &id))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub(crate) async fn terminal_close_owner(
    state: tauri::State<'_, Terminals>,
    owner: String,
) -> Result<(), String> {
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.close_owner(&owner))
        .await
        .map_err(|e| e.to_string())?
}
