//! Long-lived processes a plugin starts from its manifest's `host.processes`:
//! stdin stays open for the plugin, and stdout and stderr stream back as they
//! arrive. A process belongs to the plugin that started it and to the page that
//! asked; it is killed when the plugin asks, when the page reloads, or when the
//! app exits. A page that reloaded hears nothing of it after. It runs with the
//! user's own access, with optional native containment for protected workers.
mod claude_hooks;
mod protection;
use claude_hooks::ClaudeHooks;
use protection::ProcessProtection;

use crate::host_command::{effective_path, load_login_shell_path, resolve_program};
use crate::{with_manager, PluginManager};
use buzzodz_plugins::HostProcess;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsStr;
#[cfg(unix)]
use std::os::unix::process::CommandExt as _;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::Manager as _;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tokio::process::{ChildStdin, Command};
use tokio::sync::oneshot;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProcessMcpConnection {
    url: String,
    headers: Vec<ProcessMcpHeader>,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProcessMcpHeader {
    name: String,
    value: String,
}

/// Processes alive at once across all plugins.
const MAX_PROCESSES: usize = 64;
/// One write to a process's stdin.
const MAX_WRITE_BYTES: usize = 1024 * 1024;
const READ_BYTES: usize = 64 * 1024;
/// How long a process asked to stop has before it is killed outright.
const STOP_GRACE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum ProcessEvent {
    Stdout {
        data: String,
    },
    Stderr {
        data: String,
    },
    /// The last event. `code` is absent when a signal ended it.
    Exit {
        code: Option<i32>,
    },
}

struct Entry {
    hooks: Option<ClaudeHooks>,
    plugin: String,
    /// Its process group, which is its own pid.
    #[cfg_attr(not(unix), allow(dead_code))]
    group: Option<u32>,
    stdin: Option<Arc<tokio::sync::Mutex<ChildStdin>>>,
    stop: Option<oneshot::Sender<()>>,
}

#[derive(Clone, Default)]
pub(crate) struct HostProcesses {
    inner: Arc<Mutex<Registry>>,
}
#[derive(Default)]
struct Registry {
    next: u64,
    /// Counts page loads, so a spawn the page asked for before it reloaded is
    /// refused rather than left running with nobody listening.
    page: u64,
    entries: HashMap<u64, Entry>,
}
impl HostProcesses {
    fn registry(&self) -> std::sync::MutexGuard<'_, Registry> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
    fn owned<T>(
        &self,
        plugin: &str,
        handle: u64,
        take: impl FnOnce(&mut Entry) -> T,
    ) -> Result<T, String> {
        let mut registry = self.registry();
        match registry.entries.get_mut(&handle) {
            Some(entry) if entry.plugin == plugin => Ok(take(entry)),
            _ => Err("No such process".into()),
        }
    }
    /// The current page load, for `start`.
    pub(crate) fn page(&self) -> u64 {
        self.registry().page
    }
    /// Starts `command`, owned by `plugin`, and streams its output to `on_event`,
    /// unless the page that asked during `page` has since gone.
    #[cfg(test)]
    fn start(
        &self,
        page: u64,
        plugin: String,
        program: &str,
        command: Command,
        on_event: Channel<ProcessEvent>,
    ) -> Result<u64, String> {
        self.start_guarded(page, plugin, program, command, on_event, false)
    }
    fn start_guarded(
        &self,
        page: u64,
        plugin: String,
        program: &str,
        mut command: Command,
        on_event: Channel<ProcessEvent>,
        claude_hooks: bool,
    ) -> Result<u64, String> {
        let state = self.clone();
        let mut registry = self.registry();
        if registry.page != page {
            return Err("The page reloaded".into());
        }
        if registry.entries.len() >= MAX_PROCESSES {
            return Err("Too many processes are running".into());
        }
        // A job, unlike killing the child, also ends the helpers it starts.
        #[cfg(windows)]
        let job = crate::host_command::windows_job::WindowsJob::new()
            .ok_or_else(|| format!("Could not start {program}"))?;
        #[cfg(windows)]
        let mut child = job
            .spawn_hidden(&mut command)
            .map_err(|error| format!("Could not start {program}: {error}"))?;
        #[cfg(not(windows))]
        let mut child = command
            .spawn()
            .map_err(|error| format!("Could not start {program}: {error}"))?;
        let handle = registry.next;
        let hooks = if claude_hooks {
            Some(ClaudeHooks::new(
                child.id().ok_or("Claude has no process group")?,
            ))
        } else {
            None
        };
        registry.next += 1;
        let (stop, stopped) = oneshot::channel();
        registry.entries.insert(
            handle,
            Entry {
                hooks: hooks.clone(),
                plugin,
                group: child.id(),
                stdin: child
                    .stdin
                    .take()
                    .map(|stdin| Arc::new(tokio::sync::Mutex::new(stdin))),
                stop: Some(stop),
            },
        );
        drop(registry);

        let (gone, reader_gone) = oneshot::channel::<()>();
        let gone = Arc::new(Mutex::new(Some(gone)));
        let readers = [
            child.stdout.take().map(|out| {
                forward(
                    out,
                    Stream::Stdout,
                    on_event.clone(),
                    gone.clone(),
                    hooks.clone(),
                )
            }),
            child
                .stderr
                .take()
                .map(|err| forward(err, Stream::Stderr, on_event.clone(), gone.clone(), None)),
        ];
        #[cfg(unix)]
        let group = child.id().map(|pid| pid as i32);
        tauri::async_runtime::spawn(async move {
            let mut stopped = stopped;
            let mut reader_gone = reader_gone;
            let status = tokio::select! {
                status = child.wait() => status.ok(),
                _ = async {
                    // Only a sent signal counts: a closed pipe drops its sender,
                    // and a process may close its output and carry on.
                    tokio::select! {
                        Ok(()) = &mut stopped => {},
                        Ok(()) = &mut reader_gone => {},
                        else => std::future::pending::<()>().await,
                    }
                } => {
                    #[cfg(unix)]
                    if let Some(group) = group {
                        unsafe { libc::kill(-group, libc::SIGTERM) };
                    }
                    #[cfg(windows)]
                    job.terminate(STOP_GRACE).await;
                    match tokio::time::timeout(STOP_GRACE, child.wait()).await {
                        Ok(status) => status.ok(),
                        Err(_) => {
                            let _ = child.start_kill();
                            child.wait().await.ok()
                        }
                    }
                }
            };
            if let Some(hooks) = &hooks {
                hooks.close();
            }
            // Descendants that outlived it go with it.
            #[cfg(unix)]
            if let Some(group) = group {
                unsafe { libc::kill(-group, libc::SIGKILL) };
            }
            #[cfg(windows)]
            job.terminate(STOP_GRACE).await;
            for reader in readers.into_iter().flatten() {
                let _ = reader.await;
            }
            let mut registry = state.registry();
            registry.entries.remove(&handle);
            // A page that reloaded is told nothing: it stopped the process by
            // going, and may run until it unloads, taking the exit for a failure.
            let reloaded = registry.page != page;
            drop(registry);
            if !reloaded {
                let _ = on_event.send(ProcessEvent::Exit {
                    code: status.and_then(|status| status.code()),
                });
            }
        });
        Ok(handle)
    }
    async fn write(
        &self,
        plugin: &str,
        handle: u64,
        data: String,
        close: bool,
    ) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err("Write is too large".into());
        }
        let (stdin, hooks) = self.owned(plugin, handle, |entry| {
            (
                if close {
                    entry.stdin.take()
                } else {
                    entry.stdin.clone()
                },
                entry.hooks.clone(),
            )
        })?;
        let stdin = stdin.ok_or("The process input is closed")?;
        let mut stdin = stdin.lock().await;
        if let Some(hooks) = &hooks {
            hooks.input(data.as_bytes())?;
        }
        let written = async {
            stdin.write_all(data.as_bytes()).await?;
            stdin.flush().await
        };
        let result = written.await;
        if result.is_err() {
            if let Some(hooks) = hooks {
                hooks.trip();
            }
        }
        result.map_err(|_| "The process is not reading its input".into())
    }
    fn kill(&self, plugin: &str, handle: u64) -> Result<(), String> {
        if let Some(stop) = self.owned(plugin, handle, |entry| {
            entry.stdin = None;
            entry.stop.take()
        })? {
            let _ = stop.send(());
        }
        Ok(())
    }
    /// Stops every process, without telling the page: it is gone.
    pub(crate) fn stop_all(&self) {
        let mut registry = self.registry();
        registry.page += 1;
        for entry in registry.entries.values_mut() {
            entry.stdin = None;
            if let Some(stop) = entry.stop.take() {
                let _ = stop.send(());
            }
        }
    }
    /// Kills every process group at once: the app is exiting, and its async
    /// tasks will not run again to stop them. On Windows each process's job
    /// kills it when the app's handle to the job closes.
    pub(crate) fn shutdown(&self) {
        self.stop_all();
        #[cfg(unix)]
        for group in self
            .registry()
            .entries
            .values()
            .filter_map(|entry| entry.group)
        {
            unsafe { libc::kill(-(group as i32), libc::SIGKILL) };
        }
    }
}

#[derive(Clone, Copy)]
enum Stream {
    Stdout,
    Stderr,
}

/// Starts the declared process `process_id` with `args` after its declared
/// arguments. `env` adds variables (`null` removes one) to the app's own
/// environment, less any Buzz identity: an agent's key never leaves the app.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) async fn plugin_host_process_spawn<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    manager: tauri::State<'_, PluginManager>,
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    revision: String,
    process_id: String,
    args: Vec<String>,
    cwd: Option<String>,
    env: Option<HashMap<String, Option<String>>>,
    on_event: Channel<ProcessEvent>,
    mcp: Option<ProcessMcpConnection>,
    protection: Option<ProcessProtection>,
) -> Result<u64, String> {
    let page = processes.page();
    let plugin = id.clone();
    let (declared, registry) = with_manager(manager, move |manager| {
        let registry = manager.storage_root().to_path_buf();
        manager
            .host_grants(&id, &revision)?
            .processes
            .into_iter()
            .find(|process| process.id == process_id)
            .ok_or_else(|| "Process is not declared".into())
            .map(|declared| (declared, registry))
    })
    .await?;
    if args.len() > 256 || args.iter().any(|arg| arg.contains('\0')) {
        return Err("Invalid process arguments".into());
    }
    load_login_shell_path().await;
    let path = effective_path();
    let program = program_path(&declared, || app.path().resource_dir().ok(), &path)?;
    let (program, prefix) = if mcp.is_some() {
        let resources = app.path().resource_dir().map_err(|_| "No app resources")?;
        let helper = if cfg!(windows) {
            "buzz-agent-command.exe"
        } else {
            "buzz-agent-command"
        };
        (
            resources.join("bin").join(helper),
            vec![
                std::ffi::OsString::from("--launch"),
                program.into_os_string(),
            ],
        )
    } else {
        (program, Vec::new())
    };
    #[cfg(not(target_os = "macos"))]
    let _ = &registry;
    let claude_hooks = protection.is_some() && plugin == "buzz.claude-code";
    let mut command = if let Some(protection) = protection {
        #[cfg(not(target_os = "macos"))]
        {
            let _ = protection;
            return Err("Protected workers require macOS".into());
        }
        #[cfg(target_os = "macos")]
        {
            // A dev frontend can be served from another checkout. Its actual
            // source is not native-owned, so HMR could replace the gate.
            if tauri::is_dev() {
                return Err("Use a packaged Buzz build for protected workers; development frontends are mutable".into());
            }
            let controls = app
                .path()
                .app_data_dir()
                .map_err(|_| "Application data is unavailable")?
                .join("agents");
            std::fs::create_dir_all(&controls).map_err(|_| "Agent controls are unavailable")?;
            let executable =
                std::env::current_exe().map_err(|_| "Application executable is unavailable")?;
            let bundle = executable
                .ancestors()
                .find(|p| p.extension().is_some_and(|extension| extension == "app"))
                .map(std::path::Path::to_path_buf)
                .unwrap_or(executable);
            let profile = protection.profile(&[controls, bundle, registry])?;
            let mut contained = Command::new("/usr/bin/sandbox-exec");
            contained.args(["-p", &profile]).arg(program);
            contained
        }
    } else {
        Command::new(program)
    };
    command.args(prefix);
    command
        .args(&declared.args)
        .args(&args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Never pass on an identity the app itself was started with.
    for (name, _) in std::env::vars_os() {
        let text = name.to_string_lossy();
        if text.starts_with("BUZZ_") || text.starts_with("NOSTR_") {
            command.env_remove(&name);
        }
    }
    command.env("PATH", &path);
    for (name, value) in env.unwrap_or_default() {
        if name.is_empty() || name.contains(['=', '\0']) {
            return Err("Invalid environment variable".into());
        }
        match value {
            Some(value) => command.env(name, value),
            None => command.env_remove(name),
        };
    }
    if let Some(mcp) = mcp {
        command.env(
            "BUZZ_AGENT_CONNECTION",
            serde_json::to_string(&mcp).map_err(|error| error.to_string())?,
        );
    }
    if let Some(cwd) = cwd {
        let directory = expand_home(&cwd)?;
        std::fs::create_dir_all(&directory)
            .map_err(|_| "Could not create the process directory")?;
        command.current_dir(directory);
    }
    #[cfg(unix)]
    command.as_std_mut().process_group(0);

    processes.start_guarded(
        page,
        plugin,
        &declared.program,
        command,
        on_event,
        claude_hooks,
    )
}

/// Writes `data` to the process's stdin; `close` then ends its input.
#[tauri::command]
pub(crate) async fn plugin_host_process_write(
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    handle: u64,
    data: String,
    close: bool,
) -> Result<(), String> {
    processes.write(&id, handle, data, close).await
}

/// Asks the process to stop, then kills it and its descendants. Its `exit`
/// event follows.
#[tauri::command]
pub(crate) fn plugin_host_process_kill(
    processes: tauri::State<'_, HostProcesses>,
    id: String,
    handle: u64,
) -> Result<(), String> {
    processes.kill(&id, handle)
}

/// Streams one pipe to the page as text. A page that stops listening stops
/// the process too.
fn forward(
    mut pipe: impl AsyncRead + Unpin + Send + 'static,
    stream: Stream,
    channel: Channel<ProcessEvent>,
    gone: Arc<Mutex<Option<oneshot::Sender<()>>>>,
    hooks: Option<ClaudeHooks>,
) -> tauri::async_runtime::JoinHandle<()> {
    tauri::async_runtime::spawn(async move {
        let mut buffer = vec![0; READ_BYTES];
        let mut pending = Vec::new();
        loop {
            let read = match pipe.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => read,
            };
            pending.extend_from_slice(&buffer[..read]);
            if let Some(hooks) = &hooks {
                if hooks.output(&buffer[..read]).is_err() {
                    break;
                }
            }
            let data = take_text(&mut pending);
            if data.is_empty() {
                continue;
            }
            let event = match stream {
                Stream::Stdout => ProcessEvent::Stdout { data },
                Stream::Stderr => ProcessEvent::Stderr { data },
            };
            if channel.send(event).is_err() {
                if let Some(gone) = gone
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .take()
                {
                    let _ = gone.send(());
                }
                break;
            }
        }
    })
}

/// The complete UTF-8 text in `pending`, leaving a character split across
/// reads for the next one. Invalid bytes become U+FFFD.
fn take_text(pending: &mut Vec<u8>) -> String {
    let complete = match std::str::from_utf8(pending) {
        Ok(_) => pending.len(),
        // An incomplete trailing sequence waits for its remaining bytes.
        Err(error) if error.error_len().is_none() => error.valid_up_to(),
        Err(_) => pending.len(),
    };
    let rest = pending.split_off(complete);
    let text = String::from_utf8_lossy(pending).into_owned();
    *pending = rest;
    text
}

/// An absolute directory, or one under the user's home written `~/…`.
/// Where a declared program runs from. A bundled one is in the app's `bin`
/// resources, which `tauri dev` also copies beside the debug executable, and is
/// never looked up on `path`. Windows adds `.exe` to a path itself.
fn program_path(
    declared: &HostProcess,
    resources: impl FnOnce() -> Option<PathBuf>,
    path: &OsStr,
) -> Result<PathBuf, String> {
    if !declared.bundled {
        return Ok(resolve_program(&declared.program, path));
    }
    let resources = resources().ok_or_else(|| format!("Could not start {}", declared.program))?;
    Ok(resources.join("bin").join(&declared.program))
}

/// The rest of a path written `~/…`, or on Windows also `~\…`.
pub(crate) fn under_home(path: &str) -> Option<&str> {
    path.strip_prefix("~/")
        .or_else(|| path.strip_prefix("~\\").filter(|_| cfg!(windows)))
}

pub(crate) fn expand_home(directory: &str) -> Result<PathBuf, String> {
    let path = if directory == "~" {
        home()?
    } else if let Some(rest) = under_home(directory) {
        home()?.join(rest)
    } else {
        PathBuf::from(directory)
    };
    if !path.is_absolute() {
        return Err("The process directory must be absolute".into());
    }
    Ok(path)
}
fn home() -> Result<PathBuf, String> {
    // Windows' own profile folder, never a `HOME` another tool set, such as
    // Git for Windows' `/c/Users/…`.
    #[cfg(windows)]
    let order = ["USERPROFILE", "HOME"];
    #[cfg(not(windows))]
    let order = ["HOME", "USERPROFILE"];
    order
        .into_iter()
        .find_map(std::env::var_os)
        .map(PathBuf::from)
        .ok_or_else(|| "No home directory".into())
}

#[cfg(test)]
mod tests;
