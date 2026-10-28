//! macOS-only detection for when Buzz is launched from installer media (a
//! mounted disk image, a read-only or App Translocation location, or some
//! other non-installed download location) rather than from an Applications
//! folder.
//!
//! When that happens we surface a native first-launch prompt offering to move
//! Buzz into `/Applications` and relaunch from there. This mirrors the
//! widely-copied Potion Factory `LetsMove` flow: never prompt when the app is
//! already installed, treat read-only/disk-image/translocated locations as
//! "running from installer media", and on acceptance copy the bundle, clear
//! quarantine metadata, relaunch the installed copy, and detach the disk image
//! if we were running from one.
//!
//! Ported from berd (squareup/berd#561).
//!
//! The copy already installed in `/Applications` is located, compared, quit
//! and replaced purely by bundle path. Nothing here reads a bundle identifier,
//! executable name, signing identity or data directory, so the old Buzz from
//! block/buzz (`xyz.block.buzz.app`, executable `buzz-desktop`) and a previous
//! build of this app (`xyz.block.buzz.desktop`, executable `Buzz`), which share
//! the `Buzz.app` file name, go through exactly the same flow.

use std::path::{Path, PathBuf};

/// Where the running `.app` bundle lives, classified into the buckets that
/// decide whether we prompt the user to move into `/Applications`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunLocation {
    /// Already inside an Applications directory — never prompt.
    InstalledInApplications,
    /// Running from a mounted disk image (read-only volume under `/Volumes`).
    DiskImage,
    /// Running from a Gatekeeper App Translocation location (a randomized
    /// read-only path under `/private/var/folders/.../AppTranslocation/...`).
    Translocated,
    /// Running from some other read-only volume.
    ReadOnlyVolume,
    /// Running from a writable, non-installed location (e.g. `~/Downloads`).
    OtherNonInstalled,
}

impl RunLocation {
    /// Whether this location should trigger the move-to-Applications prompt.
    /// Anything other than an installed copy is treated as installer media.
    pub fn should_prompt_move(self) -> bool {
        !matches!(self, RunLocation::InstalledInApplications)
    }
}

/// Filesystem facts about the volume containing the running bundle, gathered
/// via `statfs`. Kept as a plain struct so the classification logic can be
/// unit-tested without a real mount.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VolumeInfo {
    pub mount_point: PathBuf,
    pub read_only: bool,
    pub is_root: bool,
}

/// Classify a bundle path + its volume into a [`RunLocation`].
///
/// Conservative by design: a bundle inside any Applications directory is
/// always treated as installed (no prompt), and only unambiguous installer
/// media signals (translocation, read-only volumes) escalate above
/// `OtherNonInstalled`.
pub fn classify(bundle_path: &Path, home: Option<&Path>, volume: &VolumeInfo) -> RunLocation {
    if is_in_applications_folder(bundle_path, home) {
        return RunLocation::InstalledInApplications;
    }
    if is_translocated_path(bundle_path) {
        return RunLocation::Translocated;
    }
    if volume.read_only && !volume.is_root {
        return if volume.mount_point.starts_with("/Volumes") {
            RunLocation::DiskImage
        } else {
            RunLocation::ReadOnlyVolume
        };
    }
    RunLocation::OtherNonInstalled
}

/// Whether `path` lives inside the system `/Applications` or the per-user
/// `~/Applications` directory. Uses component-aware prefix matching so e.g.
/// `/ApplicationsOther/Foo.app` is not mistaken for an install.
fn is_in_applications_folder(path: &Path, home: Option<&Path>) -> bool {
    if path.starts_with("/Applications") {
        return true;
    }
    if let Some(home) = home {
        if path.starts_with(home.join("Applications")) {
            return true;
        }
    }
    false
}

/// Whether `path` is a Gatekeeper App Translocation mount. Translocated
/// bundles live under `/private/var/folders/.../AppTranslocation/<uuid>/...`,
/// so the `AppTranslocation` path component is a reliable, self-contained
/// signal that a simple `/Volumes/...` check would miss.
fn is_translocated_path(path: &Path) -> bool {
    path.components()
        .any(|component| component.as_os_str() == "AppTranslocation")
}

/// Resolve the running `.app` bundle directory by walking up from the current
/// executable to the nearest ancestor with a `.app` extension.
fn bundle_path_from_executable(executable: &Path) -> Option<PathBuf> {
    executable
        .ancestors()
        .find(|ancestor| ancestor.extension().is_some_and(|ext| ext == "app"))
        .map(Path::to_path_buf)
}

/// Where a copy of the running bundle lives once installed: `/Applications/`
/// plus the running bundle's file name.
///
/// Deliberately keyed on the file name alone, never on `CFBundleIdentifier`,
/// `CFBundleExecutable`, `CFBundleName`, the signing identity or the data
/// directory. The old Buzz from block/buzz (`xyz.block.buzz.app`, executable
/// `buzz-desktop`) and this app (`xyz.block.buzz.desktop`, executable `Buzz`)
/// both install as `Buzz.app`, and replacing either must look and behave the
/// same, so the lookup must not be able to tell them apart.
fn installed_copy_path(bundle_path: &Path) -> Option<PathBuf> {
    let app_name = bundle_path.file_name()?;
    Some(Path::new("/Applications").join(app_name))
}

/// Resolve symlinks and `/private` aliasing so two spellings of the same
/// bundle directory compare equal. A path that can't be resolved (e.g. it no
/// longer exists) is compared as written.
fn normalized_bundle_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// Where a move stages its copy before renaming it over `target`:
/// `/Applications/.Buzz.app.staging`. Beside the target, so the final rename
/// is same-volume and atomic; hidden, and not an `.app`, so Launch Services
/// never registers it. The name is fixed because the single-instance guard
/// lets only one move run at a time, so anything already there was left by
/// an earlier move that was interrupted.
fn staging_path(target: &Path) -> PathBuf {
    let mut name = std::ffi::OsString::from(".");
    name.push(target.file_name().unwrap_or_default());
    name.push(".staging");
    target.with_file_name(name)
}

/// Remove a leftover staging copy so the next copy starts from nothing.
/// Nothing to remove is fine. A leftover that can't be removed is an error:
/// `ditto` would merge into it, and the stale files would break the new
/// copy's code signature.
fn clear_staging(staging: &Path) -> std::io::Result<()> {
    match std::fs::remove_dir_all(staging) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(std::io::Error::new(
            error.kind(),
            format!(
                "failed to remove leftover staging copy {}: {error}",
                staging.display()
            ),
        )),
    }
}

/// Version identity read from a bundle's `Contents/Info.plist`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BundleVersion {
    /// `CFBundleShortVersionString`, e.g. `"0.7.0"`.
    pub short: String,
    /// `CFBundleVersion`, the build identifier.
    pub build: String,
}

/// How the running copy's version relates to a copy already in `/Applications`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VersionRelation {
    /// The running copy is a newer version than the installed one.
    RunningNewer,
    /// The running copy is an older version than the installed one.
    RunningOlder,
    /// Both copies report the same version.
    Same,
    /// At least one version string could not be parsed.
    Unknown,
}

/// Compare two bundle versions by their `CFBundleShortVersionString`, parsed as
/// semver. If either side fails to parse we return [`VersionRelation::Unknown`]
/// rather than guessing — the caller degrades to neutral "replace" wording.
fn compare_versions(running: &BundleVersion, installed: &BundleVersion) -> VersionRelation {
    use semver::Version;

    let (Ok(running), Ok(installed)) = (
        Version::parse(&running.short),
        Version::parse(&installed.short),
    ) else {
        return VersionRelation::Unknown;
    };

    match running.cmp(&installed) {
        std::cmp::Ordering::Greater => VersionRelation::RunningNewer,
        std::cmp::Ordering::Less => VersionRelation::RunningOlder,
        std::cmp::Ordering::Equal => VersionRelation::Same,
    }
}

/// What moving into `/Applications` actually means given what's already there.
/// Folding "does an install exist" and the version relation into one value
/// keeps the dialog copy and the action that follows it from ever disagreeing.
#[derive(Debug, Clone, PartialEq, Eq)]
enum MoveScenario {
    /// Nothing in `/Applications` — a plain first install.
    FreshInstall,
    /// An older copy is installed; this copy is newer.
    Upgrade { from: String, to: String },
    /// A newer copy is installed; this copy is older.
    Downgrade { from: String, to: String },
    /// The same version is already installed.
    Reinstall { version: String },
    /// A copy is installed but its version couldn't be determined.
    ExistingUnknown,
}

/// Derive the [`MoveScenario`] from whether `/Applications/Buzz.app` exists and
/// the two versions. Pure so it can be unit-tested over the full truth table.
fn scenario_for(
    target_exists: bool,
    running: Option<&BundleVersion>,
    installed: Option<&BundleVersion>,
) -> MoveScenario {
    if !target_exists {
        return MoveScenario::FreshInstall;
    }
    let (Some(running), Some(installed)) = (running, installed) else {
        return MoveScenario::ExistingUnknown;
    };
    match compare_versions(running, installed) {
        VersionRelation::RunningNewer => MoveScenario::Upgrade {
            from: installed.short.clone(),
            to: running.short.clone(),
        },
        VersionRelation::RunningOlder => MoveScenario::Downgrade {
            from: installed.short.clone(),
            to: running.short.clone(),
        },
        VersionRelation::Same => MoveScenario::Reinstall {
            version: running.short.clone(),
        },
        VersionRelation::Unknown => MoveScenario::ExistingUnknown,
    }
}

/// The three text fields a native `NSAlert` needs.
struct AlertCopy {
    message: String,
    informative: String,
    primary_button: String,
}

/// A trailing note describing how the app is currently being run, appended to
/// every scenario's informative text so the user understands the prompt's
/// trigger regardless of the version situation.
fn location_note(location: RunLocation) -> &'static str {
    match location {
        RunLocation::DiskImage => "\n\nYou're currently running Buzz from a disk image.",
        RunLocation::Translocated => {
            "\n\nmacOS is running this copy from a temporary, read-only location."
        }
        RunLocation::ReadOnlyVolume => "\n\nYou're currently running Buzz from a read-only volume.",
        RunLocation::OtherNonInstalled => {
            "\n\nYou're currently running Buzz from outside your Applications folder."
        }
        RunLocation::InstalledInApplications => "",
    }
}

/// Produce the alert's message, informative text, and primary-button label for
/// a given scenario and run location. Pure and unit-tested so the wording can
/// never drift from the action it describes.
fn alert_copy(scenario: &MoveScenario, location: RunLocation) -> AlertCopy {
    let note = location_note(location);
    match scenario {
        MoveScenario::FreshInstall => AlertCopy {
            message: "Move to Applications folder?".to_string(),
            informative: format!(
                "Buzz can move itself to your Applications folder and relaunch from there. \
                 This keeps automatic updates working and avoids problems with running from \
                 installer media.{note}"
            ),
            primary_button: "Move to Applications Folder".to_string(),
        },
        MoveScenario::Upgrade { from, to } => AlertCopy {
            message: "Upgrade Buzz in your Applications folder?".to_string(),
            informative: format!(
                "You have Buzz {from} installed. This copy is the newer version {to}. \
                 Buzz can replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Upgrade and Relaunch".to_string(),
        },
        MoveScenario::Downgrade { from, to } => AlertCopy {
            message: "Replace the newer version in your Applications folder?".to_string(),
            informative: format!(
                "You have Buzz {from} installed, which is newer than this copy ({to}). \
                 Buzz can replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Replace and Relaunch".to_string(),
        },
        MoveScenario::Reinstall { version } => AlertCopy {
            message: format!("Reinstall Buzz {version} in your Applications folder?"),
            informative: format!(
                "Buzz {version} is already installed in your Applications folder. Buzz can \
                 replace the installed copy and relaunch from it.{note}"
            ),
            primary_button: "Reinstall and Relaunch".to_string(),
        },
        MoveScenario::ExistingUnknown => AlertCopy {
            message: "Replace the copy in your Applications folder?".to_string(),
            informative: format!(
                "Buzz is already installed in your Applications folder. Buzz can replace the \
                 installed copy and relaunch from it.{note}"
            ),
            primary_button: "Replace and Relaunch".to_string(),
        },
    }
}

/// Message and informative text for the alert shown when a move the user
/// confirmed fails partway through. Without privilege escalation a standard
/// user on a locked-down `/Applications` will reliably land here, so the
/// failure must be visible rather than swallowed into a log line. Pure so the
/// wording stays testable alongside the rest of the dialog copy.
fn move_failed_alert_copy(error: &str) -> (String, String) {
    (
        "Couldn't move Buzz to your Applications folder".to_string(),
        format!(
            "Buzz will keep running from its current location. You can move it yourself by \
             dragging Buzz into your Applications folder, then opening it from there.\n\n\
             Details: {error}"
        ),
    )
}

/// Quote `value` for safe interpolation into a `/bin/sh -c` command string.
/// Wraps it in single quotes and rewrites any embedded single quote as the
/// classic `'\''` sequence (close quote, escaped literal quote, reopen quote),
/// so a path containing shell metacharacters — or a bundle deliberately renamed
/// to contain a quote — can't break out of the quoting and run arbitrary
/// commands. Pure so the escaping is unit-testable.
fn shell_single_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

#[cfg(target_os = "macos")]
mod macos {
    use super::*;
    use std::os::unix::ffi::OsStrExt;
    use std::process::Command;
    use tauri::{AppHandle, Manager};

    const SUPPRESSION_MARKER: &str = "suppress-move-to-applications";

    /// Detect whether Buzz is running from installer media and, if so, offer
    /// to move it into `/Applications`. Runs once per launch, on the main
    /// thread, from a main-queue block scheduled at `RunEvent::Ready`: the
    /// modal alert redraws the visible main window, which re-enters tao, so it
    /// must not be called from inside a tao event-loop callback (see the call
    /// site in `lib.rs`). On acceptance this tears down as Quit does,
    /// relaunches from the installed copy and exits the current process.
    pub(crate) fn maybe_prompt_move_to_applications(app: &AppHandle) {
        // Never interrupt development builds, which legitimately run from
        // `target/` and similar non-installed locations.
        if cfg!(debug_assertions) {
            return;
        }

        let Some(bundle_path) = running_app_bundle_path() else {
            return;
        };
        let Some(target) = installed_copy_path(&bundle_path) else {
            return;
        };
        let Some(volume) = volume_info(&bundle_path) else {
            return;
        };
        let home = dirs::home_dir();
        let location = classify(&bundle_path, home.as_deref(), &volume);
        if !location.should_prompt_move() {
            return;
        }

        // Respect a prior "Do not show this message again" choice.
        let marker = suppression_marker_path(app);
        if marker.as_ref().is_some_and(|path| path.exists()) {
            return;
        }

        // Read both versions from disk (rather than trusting the compiled-in
        // version) so the running and installed copies are always compared
        // apples-to-apples. Only `CFBundleShortVersionString` is compared;
        // whatever is installed under this file name is treated the same.
        let running = read_bundle_version(&bundle_path);
        let installed = target
            .exists()
            .then(|| read_bundle_version(&target))
            .flatten();
        let scenario = scenario_for(target.exists(), running.as_ref(), installed.as_ref());

        eprintln!(
            "Buzz appears to be running from installer media ({location:?}, {scenario:?}); \
             prompting to move to /Applications"
        );

        let Some(decision) = show_move_alert(&scenario, location) else {
            return;
        };

        if decision.suppress {
            if let Some(marker) = marker {
                if let Some(parent) = marker.parent() {
                    let _ = std::fs::create_dir_all(parent);
                }
                let _ = std::fs::write(&marker, b"");
            }
        }

        if !decision.move_requested {
            return;
        }

        match move_to_applications_and_relaunch(&bundle_path, &volume, location) {
            Ok(()) => {
                eprintln!("Relaunching Buzz from /Applications");
                // Tear down as Quit does, so terminals, plugin processes and
                // agent runtimes don't outlive us. Only now: had the move or
                // the relaunch failed, the app would keep running and still
                // need them.
                crate::shut_down(app);
                std::process::exit(0);
            }
            Err(error) => {
                eprintln!("Failed to move Buzz to /Applications: {error}");
                show_move_failed_alert(&error.to_string());
            }
        }
    }

    fn suppression_marker_path(app: &AppHandle) -> Option<PathBuf> {
        app.path()
            .app_data_dir()
            .ok()
            .map(|dir| dir.join(SUPPRESSION_MARKER))
    }

    fn running_app_bundle_path() -> Option<PathBuf> {
        let executable = std::env::current_exe().ok()?;
        bundle_path_from_executable(&executable)
    }

    /// Read `CFBundleShortVersionString` and `CFBundleVersion` from a bundle's
    /// `Contents/Info.plist`. Returns `None` if the plist is missing/unreadable
    /// or lacks a short version string; the build identifier is best-effort and
    /// falls back to the short version when absent.
    fn read_bundle_version(bundle_path: &Path) -> Option<BundleVersion> {
        let info_plist = bundle_path.join("Contents/Info.plist");
        let value = plist::Value::from_file(&info_plist).ok()?;
        let dict = value.as_dictionary()?;
        let short = dict.get("CFBundleShortVersionString")?.as_string()?;
        let build = dict
            .get("CFBundleVersion")
            .and_then(plist::Value::as_string)
            .unwrap_or(short);
        Some(BundleVersion {
            short: short.to_string(),
            build: build.to_string(),
        })
    }

    /// Gather volume facts for `path` via `statfs`.
    fn volume_info(path: &Path) -> Option<VolumeInfo> {
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        // SAFETY: `stat` is fully initialized by `statfs` on success; we only
        // read it when the call returns 0.
        let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
        if unsafe { libc::statfs(c_path.as_ptr(), &mut stat) } != 0 {
            return None;
        }
        let mount_point = c_string_field_to_path(&stat.f_mntonname);
        let read_only = (stat.f_flags & libc::MNT_RDONLY as u32) != 0;
        let is_root = mount_point == Path::new("/");
        Some(VolumeInfo {
            mount_point,
            read_only,
            is_root,
        })
    }

    fn c_string_field_to_path(field: &[libc::c_char]) -> PathBuf {
        let bytes: Vec<u8> = field
            .iter()
            .take_while(|&&byte| byte != 0)
            .map(|&byte| byte as u8)
            .collect();
        PathBuf::from(std::ffi::OsStr::from_bytes(&bytes))
    }

    struct MoveDecision {
        move_requested: bool,
        suppress: bool,
    }

    fn show_move_alert(scenario: &MoveScenario, location: RunLocation) -> Option<MoveDecision> {
        use objc2_app_kit::{NSAlert, NSAlertFirstButtonReturn, NSControlStateValueOn};
        use objc2_foundation::{MainThreadMarker, NSString};

        let copy = alert_copy(scenario, location);

        // AppKit calls here are only valid on the main thread, proven by the
        // `mtm` marker we just obtained.
        let mtm = MainThreadMarker::new()?;
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&copy.message));
        alert.setInformativeText(&NSString::from_str(&copy.informative));
        let _ = alert.addButtonWithTitle(&NSString::from_str(&copy.primary_button));
        let _ = alert.addButtonWithTitle(&NSString::from_str("Do Not Move"));
        alert.setShowsSuppressionButton(true);

        let move_requested = alert.runModal() == NSAlertFirstButtonReturn;
        let suppress = alert
            .suppressionButton()
            .is_some_and(|button| button.state() == NSControlStateValueOn);

        Some(MoveDecision {
            move_requested,
            suppress,
        })
    }

    /// Tell the user a confirmed move failed, so the app silently continuing
    /// from installer media isn't the only signal. Best-effort: if we can't get
    /// onto the main thread the warning log is the fallback.
    fn show_move_failed_alert(error: &str) {
        use objc2_app_kit::NSAlert;
        use objc2_foundation::{MainThreadMarker, NSString};

        let (message, informative) = move_failed_alert_copy(error);

        // AppKit calls here are only valid on the main thread, proven by the
        // `mtm` marker.
        let Some(mtm) = MainThreadMarker::new() else {
            return;
        };
        let alert = NSAlert::new(mtm);
        alert.setMessageText(&NSString::from_str(&message));
        alert.setInformativeText(&NSString::from_str(&informative));
        let _ = alert.addButtonWithTitle(&NSString::from_str("OK"));
        let _ = alert.runModal();
    }

    fn move_to_applications_and_relaunch(
        bundle_path: &Path,
        volume: &VolumeInfo,
        location: RunLocation,
    ) -> std::io::Result<()> {
        let target = installed_copy_path(bundle_path)
            .ok_or_else(|| std::io::Error::other("app bundle path has no file name"))?;

        // Stage the copy under a hidden name on the same volume as the
        // target, so a failed or interrupted `ditto` (disk full, killed
        // mid-copy) can never leave a working installed copy trashed and the
        // target a half-written bundle. Only once the copy fully succeeds do
        // we trash the old copy and rename the staged one into place — an
        // atomic, same-volume rename. The move the dialog promised therefore
        // either happens completely or not at all.
        let staging = staging_path(&target);
        // At most one staging copy exists. One left by an interrupted earlier
        // move is removed first; if it can't be, the move stops here rather
        // than copying into it.
        clear_staging(&staging)?;

        // `ditto` is the macOS-blessed way to copy an app bundle while
        // preserving its structure and metadata.
        let status = Command::new("/usr/bin/ditto")
            .arg(bundle_path)
            .arg(&staging)
            .status()?;
        if !status.success() {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(std::io::Error::other(format!("ditto exited with {status}")));
        }

        // The copy is complete and on the target's volume, so the remaining
        // steps are fast and the rename is atomic. An installed copy, if one
        // exists, goes to the Trash (recoverable and Finder-undoable) rather
        // than being overwritten in place. If trashing fails (e.g. a
        // read-only /Applications) we bail before the rename and discard the
        // staged copy, leaving the existing install untouched. Any running
        // instance of the installed bundle is quit first; trashing a running
        // bundle still succeeds, so a copy that won't quit never blocks the
        // move.
        if target.exists() {
            terminate_running_copies(&target);
            if let Err(error) = move_to_trash(&target) {
                let _ = std::fs::remove_dir_all(&staging);
                return Err(error);
            }
        }
        if let Err(error) = std::fs::rename(&staging, &target) {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }

        // Clear quarantine so Gatekeeper doesn't re-prompt or translocate the
        // freshly installed copy.
        let _ = Command::new("/usr/bin/xattr")
            .args(["-r", "-d", "com.apple.quarantine"])
            .arg(&target)
            .status();

        let detach_mount =
            matches!(location, RunLocation::DiskImage).then(|| volume.mount_point.clone());
        relaunch_after_exit(&target, detach_mount)
    }

    /// Move `path` to the user's Trash via `NSFileManager`. Preferred over
    /// `rm -rf` because it's recoverable and Finder-undoable if the user changes
    /// their mind about replacing the installed copy.
    fn move_to_trash(path: &Path) -> std::io::Result<()> {
        use objc2_foundation::{NSFileManager, NSString, NSURL};

        let url = NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()));
        NSFileManager::defaultManager()
            .trashItemAtURL_resultingItemURL_error(&url, None)
            .map_err(|error| {
                std::io::Error::other(format!(
                    "failed to move {} to Trash: {error:?}",
                    path.display()
                ))
            })
    }

    /// How long a running copy of the installed bundle gets to quit politely
    /// before it is force-quit so the move can proceed.
    const TERMINATE_GRACE: std::time::Duration = std::time::Duration::from_secs(2);

    /// Quit every running application whose bundle is `target`, so the copy
    /// about to be trashed doesn't linger with a stale tray icon or write a
    /// later self-update into the Trash. Matched by bundle *path*, not bundle
    /// identifier: `tauri_plugin_single_instance` already guarantees a previous
    /// build of this app isn't running, but the old block/buzz Buzz uses a
    /// different identifier, keeps running after its window is closed, and
    /// must be quit the same way without naming it. Best-effort: the outcome
    /// is logged and the move continues regardless, because trashing a running
    /// bundle succeeds on macOS.
    fn terminate_running_copies(target: &Path) {
        use objc2_app_kit::NSWorkspace;

        let target = normalized_bundle_path(target);
        let running = NSWorkspace::sharedWorkspace().runningApplications();
        for app in running.iter() {
            let Some(path) = app.bundleURL().and_then(|url| url.path()) else {
                continue;
            };
            if normalized_bundle_path(Path::new(&path.to_string())) != target {
                continue;
            }
            let pid = app.processIdentifier();
            let asked = app.terminate();
            let deadline = std::time::Instant::now() + TERMINATE_GRACE;
            while asked && !has_exited(&app, pid) && std::time::Instant::now() < deadline {
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            let outcome = if has_exited(&app, pid) {
                "quit before replacement"
            } else if app.forceTerminate() {
                "force-quit before replacement"
            } else {
                "would not quit; replacing it anyway"
            };
            eprintln!(
                "Running copy of {} (pid {pid}): {outcome}",
                target.display()
            );
        }
    }

    /// Whether a running application has exited. `isTerminated` only updates
    /// when the main run loop spins, which it doesn't while we sleep-poll on
    /// the main thread, so the kernel's view of the pid is checked as well.
    fn has_exited(app: &objc2_app_kit::NSRunningApplication, pid: libc::pid_t) -> bool {
        if app.isTerminated() {
            return true;
        }
        // `kill(-1, 0)` would probe every process, so only a real pid counts.
        // SAFETY: signal 0 performs no action beyond the existence check.
        pid > 0
            && unsafe { libc::kill(pid, 0) } == -1
            && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
    }

    /// Spawn a detached shell that waits for this process to exit, launches the
    /// installed copy, and (optionally) detaches the disk image we ran from.
    fn relaunch_after_exit(target: &Path, detach_mount: Option<PathBuf>) -> std::io::Result<()> {
        let pid = std::process::id();
        // The paths are single-quote escaped before interpolation: the only
        // reason a shell is involved at all is the wait-for-pid loop, and a
        // bundle whose name contains shell metacharacters must not be able to
        // turn that loop into arbitrary command execution.
        let target = shell_single_quote(&target.to_string_lossy());
        let mut script = format!(
            "while /bin/kill -0 {pid} >/dev/null 2>&1; do /bin/sleep 0.2; done; \
             /usr/bin/open {target}"
        );
        if let Some(mount) = detach_mount {
            let mount = shell_single_quote(&mount.to_string_lossy());
            script.push_str(&format!(
                "; /bin/sleep 1; /usr/bin/hdiutil detach {mount} >/dev/null 2>&1"
            ));
        }
        Command::new("/bin/sh").arg("-c").arg(script).spawn()?;
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::maybe_prompt_move_to_applications;

#[cfg(test)]
mod tests {
    use super::*;

    fn volume(mount_point: &str, read_only: bool) -> VolumeInfo {
        VolumeInfo {
            mount_point: PathBuf::from(mount_point),
            read_only,
            is_root: mount_point == "/",
        }
    }

    #[test]
    fn bundle_path_resolves_to_dot_app_ancestor() {
        let exe = Path::new("/Applications/Buzz.app/Contents/MacOS/Buzz");
        assert_eq!(
            bundle_path_from_executable(exe),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
    }

    #[test]
    fn bundle_path_is_none_without_dot_app() {
        let exe = Path::new("/Users/someone/code/buzz-app/target/release/Buzz");
        assert_eq!(bundle_path_from_executable(exe), None);
    }

    #[test]
    fn applications_folder_detection_is_component_aware() {
        let home = Path::new("/Users/someone");
        assert!(is_in_applications_folder(
            Path::new("/Applications/Buzz.app"),
            Some(home)
        ));
        assert!(is_in_applications_folder(
            Path::new("/Users/someone/Applications/Buzz.app"),
            Some(home)
        ));
        // A directory that merely starts with the same characters is not a match.
        assert!(!is_in_applications_folder(
            Path::new("/ApplicationsOther/Buzz.app"),
            Some(home)
        ));
        assert!(!is_in_applications_folder(
            Path::new("/Volumes/Buzz/Buzz.app"),
            Some(home)
        ));
    }

    #[test]
    fn translocation_detected_by_path_component() {
        let translocated =
            Path::new("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app");
        assert!(is_translocated_path(translocated));
        assert!(!is_translocated_path(Path::new("/Volumes/Buzz/Buzz.app")));
    }

    #[test]
    fn classify_installed_app_does_not_prompt() {
        let location = classify(
            Path::new("/Applications/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::InstalledInApplications);
        assert!(!location.should_prompt_move());
    }

    #[test]
    fn classify_user_applications_counts_as_installed() {
        let location = classify(
            Path::new("/Users/someone/Applications/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::InstalledInApplications);
        // Without a known home, ~/Applications is just another writable folder.
        let location = classify(
            Path::new("/Users/someone/Applications/Buzz.app"),
            None,
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
    }

    #[test]
    fn classify_disk_image() {
        let location = classify(
            Path::new("/Volumes/Buzz/Buzz.app"),
            None,
            &volume("/Volumes/Buzz", true),
        );
        assert_eq!(location, RunLocation::DiskImage);
        assert!(location.should_prompt_move());
    }

    #[test]
    fn classify_translocation_takes_priority_over_volume() {
        let location = classify(
            Path::new("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app"),
            None,
            &volume("/private/var/folders/ab/cd/T/AppTranslocation/UUID/d", true),
        );
        assert_eq!(location, RunLocation::Translocated);
    }

    #[test]
    fn classify_read_only_non_volume() {
        let location = classify(
            Path::new("/mnt/ro/Buzz.app"),
            None,
            &volume("/mnt/ro", true),
        );
        assert_eq!(location, RunLocation::ReadOnlyVolume);
    }

    #[test]
    fn classify_read_only_root_is_not_installer_media() {
        // A sealed system volume mounted at `/` is read-only, but a bundle on
        // it is just a non-installed copy, not a disk image.
        let location = classify(
            Path::new("/ApplicationsOther/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", true),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
    }

    #[test]
    fn classify_writable_download_is_other_non_installed() {
        let location = classify(
            Path::new("/Users/someone/Downloads/Buzz.app"),
            Some(Path::new("/Users/someone")),
            &volume("/", false),
        );
        assert_eq!(location, RunLocation::OtherNonInstalled);
        assert!(location.should_prompt_move());
    }

    #[test]
    fn installed_copy_path_uses_only_the_bundle_file_name() {
        // Whatever the running copy's identifier or executable, the installed
        // copy is `/Applications/<same file name>`.
        assert_eq!(
            installed_copy_path(Path::new("/Volumes/Buzz/Buzz.app")),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
        assert_eq!(
            installed_copy_path(Path::new(
                "/private/var/folders/ab/cd/T/AppTranslocation/UUID/d/Buzz.app"
            )),
            Some(PathBuf::from("/Applications/Buzz.app"))
        );
        assert_eq!(installed_copy_path(Path::new("/")), None);
    }

    #[cfg(unix)]
    #[test]
    fn normalized_bundle_path_matches_through_symlinks() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bundle = dir.path().join("Buzz.app");
        std::fs::create_dir(&bundle).expect("create bundle");
        let link = dir.path().join("Linked.app");
        std::os::unix::fs::symlink(&bundle, &link).expect("symlink");
        // `NSRunningApplication` reports a resolved bundle URL while the target
        // is built from the file name; both must normalise to one path (on
        // macOS this also folds `/var` onto `/private/var`).
        assert_eq!(
            normalized_bundle_path(&link),
            normalized_bundle_path(&bundle)
        );
        assert_ne!(
            normalized_bundle_path(&link),
            normalized_bundle_path(&dir.path().join("Other.app"))
        );
        // A path that doesn't exist is compared as written rather than dropped.
        assert_eq!(
            normalized_bundle_path(Path::new("/Applications/Missing.app")),
            PathBuf::from("/Applications/Missing.app")
        );
    }

    #[test]
    fn staging_path_is_hidden_fixed_and_beside_the_target() {
        // No pid or other per-run part, so a later move finds an earlier
        // move's leftover; never an `.app`, so Launch Services ignores it.
        assert_eq!(
            staging_path(Path::new("/Applications/Buzz.app")),
            PathBuf::from("/Applications/.Buzz.app.staging")
        );
        assert_eq!(
            staging_path(Path::new("/Applications/Buzz Preview.app")),
            PathBuf::from("/Applications/.Buzz Preview.app.staging")
        );
    }

    #[test]
    fn clear_staging_removes_a_leftover_copy() {
        let dir = tempfile::tempdir().expect("tempdir");
        let staging = dir.path().join(".Buzz.app.staging");
        std::fs::create_dir_all(staging.join("Contents/MacOS")).expect("create leftover");
        std::fs::write(staging.join("Contents/MacOS/Buzz"), b"stale").expect("write leftover");

        clear_staging(&staging).expect("clear leftover");

        assert!(!staging.exists());
    }

    #[test]
    fn clear_staging_accepts_nothing_to_clear() {
        let dir = tempfile::tempdir().expect("tempdir");
        clear_staging(&dir.path().join(".Buzz.app.staging")).expect("nothing to clear");
    }

    #[cfg(unix)]
    #[test]
    fn clear_staging_fails_when_a_leftover_cannot_be_removed() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().expect("tempdir");
        let staging = dir.path().join(".Buzz.app.staging");
        let contents = staging.join("Contents");
        std::fs::create_dir_all(&contents).expect("create leftover");
        std::fs::write(contents.join("x"), b"stale").expect("write leftover");
        // Entries of a read-only directory can't be unlinked, even by its owner.
        std::fs::set_permissions(&contents, std::fs::Permissions::from_mode(0o555))
            .expect("lock leftover");
        let result = clear_staging(&staging);
        std::fs::set_permissions(&contents, std::fs::Permissions::from_mode(0o755))
            .expect("unlock leftover");

        let error = result.expect_err("a leftover that can't be removed stops the move");
        assert!(
            error.to_string().contains(&staging.display().to_string()),
            "{error}"
        );
        assert!(contents.join("x").exists());
    }

    fn version(short: &str, build: &str) -> BundleVersion {
        BundleVersion {
            short: short.to_string(),
            build: build.to_string(),
        }
    }

    #[test]
    fn compare_versions_orders_by_short_semver() {
        assert_eq!(
            compare_versions(&version("0.8.0", "8"), &version("0.7.12", "712")),
            VersionRelation::RunningNewer
        );
        assert_eq!(
            compare_versions(&version("0.7.12", "712"), &version("0.8.0", "8")),
            VersionRelation::RunningOlder
        );
        assert_eq!(
            compare_versions(&version("1.2.3", "10"), &version("1.2.3", "20")),
            VersionRelation::Same
        );
    }

    #[test]
    fn compare_versions_unparseable_is_unknown() {
        assert_eq!(
            compare_versions(&version("not-a-version", "1"), &version("0.7.12", "712")),
            VersionRelation::Unknown
        );
        assert_eq!(
            compare_versions(&version("0.8.0", "8"), &version("", "0")),
            VersionRelation::Unknown
        );
    }

    /// The `CFBundleShortVersionString` this build ships, read from the same
    /// `tauri.conf.json` the bundler reads so the old-Buzz cases track the real
    /// current version instead of a copy of it.
    fn current_version() -> String {
        let conf: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        conf["version"].as_str().expect("version").to_string()
    }

    /// Every version family the old Buzz from block/buzz has shipped, as the
    /// (`CFBundleShortVersionString`, `CFBundleVersion`) pairs found in its
    /// bundles: the OSS and Block-signed (`-block`) 0.5.x releases, canary and
    /// Intel-canary builds, and the Sprout-era test builds.
    const OLD_BUZZ_VERSIONS: &[(&str, &str)] = &[
        ("0.5.28", "0.5.28"),
        ("0.5.28", "0.5.28-block"),
        ("0.5.9", "0.5.9-block"),
        ("0.3.18", "0.3.18"),
        ("0.5.29-test.123", "0.5.29-test.123"),
        ("0.5.28-intel-test.45", "0.5.28-intel-test.45"),
        ("0.0.1-test.3", "0.0.1-test.3"),
    ];

    #[test]
    fn old_buzz_from_block_buzz_is_always_an_upgrade() {
        let current = current_version();
        let running = version(&current, &current);
        for (short, build) in OLD_BUZZ_VERSIONS {
            let installed = version(short, build);
            assert_eq!(
                compare_versions(&running, &installed),
                VersionRelation::RunningNewer,
                "{short} / {build}"
            );
            assert_eq!(
                scenario_for(true, Some(&running), Some(&installed)),
                MoveScenario::Upgrade {
                    from: short.to_string(),
                    to: current.clone(),
                },
                "{short} / {build}"
            );
        }
    }

    #[test]
    fn old_buzz_prerelease_suffix_never_degrades_to_replace() {
        // `CFBundleVersion` is read but never compared, so a `-block` or
        // `-test.N` suffix there changes nothing; the same suffix on the short
        // string parses as a semver prerelease rather than falling into
        // `ExistingUnknown`.
        let running = version("0.7.1", "0.7.1");
        let clean = scenario_for(true, Some(&running), Some(&version("0.5.28", "0.5.28")));
        assert_eq!(
            scenario_for(
                true,
                Some(&running),
                Some(&version("0.5.28", "0.5.28-block"))
            ),
            clean
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&running),
                Some(&version("0.5.28", "0.5.29-test.123"))
            ),
            clean
        );
        for short in ["0.5.28-block", "0.5.29-test.123", "0.5.28-intel-test.45"] {
            assert_eq!(
                scenario_for(true, Some(&running), Some(&version(short, short))),
                MoveScenario::Upgrade {
                    from: short.to_string(),
                    to: "0.7.1".to_string(),
                },
                "{short}"
            );
        }
    }

    #[test]
    fn old_buzz_and_previous_buzz_app_build_get_the_same_upgrade_dialog() {
        // Same scenario variant, same message and button, and informative text
        // identical apart from the version numbers: the dialog can't tell
        // whether `/Applications/Buzz.app` is block/buzz's Buzz or an earlier
        // build of this app.
        let running = version("0.7.1", "0.7.1");
        let old_buzz = scenario_for(
            true,
            Some(&running),
            Some(&version("0.5.28", "0.5.28-block")),
        );
        let previous_buzz_app =
            scenario_for(true, Some(&running), Some(&version("0.7.0", "0.7.0")));
        assert_eq!(
            old_buzz,
            MoveScenario::Upgrade {
                from: "0.5.28".to_string(),
                to: "0.7.1".to_string(),
            }
        );
        assert_eq!(
            previous_buzz_app,
            MoveScenario::Upgrade {
                from: "0.7.0".to_string(),
                to: "0.7.1".to_string(),
            }
        );

        let old = alert_copy(&old_buzz, RunLocation::DiskImage);
        let previous = alert_copy(&previous_buzz_app, RunLocation::DiskImage);
        assert_eq!(old.message, previous.message);
        assert_eq!(old.primary_button, previous.primary_button);
        assert_eq!(
            old.informative.replace("0.5.28", "0.7.0"),
            previous.informative
        );
    }

    #[test]
    fn scenario_for_no_install_is_fresh() {
        assert_eq!(
            scenario_for(false, Some(&version("0.8.0", "8")), None),
            MoveScenario::FreshInstall
        );
    }

    #[test]
    fn scenario_for_existing_install_maps_relation() {
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.8.0", "8")),
                Some(&version("0.7.12", "712"))
            ),
            MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            }
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.7.12", "712")),
                Some(&version("0.8.0", "8"))
            ),
            MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            }
        );
        assert_eq!(
            scenario_for(
                true,
                Some(&version("0.8.0", "8")),
                Some(&version("0.8.0", "8"))
            ),
            MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            }
        );
    }

    #[test]
    fn scenario_for_unreadable_existing_is_existing_unknown() {
        // Target exists but we couldn't read one (or both) versions.
        assert_eq!(
            scenario_for(true, Some(&version("0.8.0", "8")), None),
            MoveScenario::ExistingUnknown
        );
        assert_eq!(
            scenario_for(true, None, Some(&version("0.7.12", "712"))),
            MoveScenario::ExistingUnknown
        );
        // Both readable but at least one short string isn't semver.
        assert_eq!(
            scenario_for(
                true,
                Some(&version("nightly", "8")),
                Some(&version("0.7.12", "712"))
            ),
            MoveScenario::ExistingUnknown
        );
    }

    #[test]
    fn alert_copy_reflects_scenario() {
        let fresh = alert_copy(&MoveScenario::FreshInstall, RunLocation::DiskImage);
        assert_eq!(fresh.message, "Move to Applications folder?");
        assert_eq!(fresh.primary_button, "Move to Applications Folder");
        assert!(fresh.informative.starts_with("Buzz can move itself"));

        let upgrade = alert_copy(
            &MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(upgrade.message, "Upgrade Buzz in your Applications folder?");
        assert_eq!(upgrade.primary_button, "Upgrade and Relaunch");
        assert!(upgrade
            .informative
            .contains("You have Buzz 0.7.12 installed"));
        assert!(upgrade.informative.contains("newer version 0.8.0"));

        let downgrade = alert_copy(
            &MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(
            downgrade.message,
            "Replace the newer version in your Applications folder?"
        );
        assert_eq!(downgrade.primary_button, "Replace and Relaunch");
        assert!(downgrade
            .informative
            .contains("0.8.0 installed, which is newer than this copy (0.7.12)"));

        let reinstall = alert_copy(
            &MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            },
            RunLocation::DiskImage,
        );
        assert_eq!(
            reinstall.message,
            "Reinstall Buzz 0.8.0 in your Applications folder?"
        );
        assert_eq!(reinstall.primary_button, "Reinstall and Relaunch");
        assert!(reinstall
            .informative
            .starts_with("Buzz 0.8.0 is already installed"));

        let unknown = alert_copy(&MoveScenario::ExistingUnknown, RunLocation::DiskImage);
        assert_eq!(
            unknown.message,
            "Replace the copy in your Applications folder?"
        );
        assert_eq!(unknown.primary_button, "Replace and Relaunch");
        assert!(unknown
            .informative
            .starts_with("Buzz is already installed in your Applications folder."));
    }

    #[test]
    fn alert_copy_appends_location_note() {
        // The per-location note is appended regardless of scenario.
        for scenario in [
            MoveScenario::FreshInstall,
            MoveScenario::Upgrade {
                from: "0.7.12".to_string(),
                to: "0.8.0".to_string(),
            },
            MoveScenario::Downgrade {
                from: "0.8.0".to_string(),
                to: "0.7.12".to_string(),
            },
            MoveScenario::Reinstall {
                version: "0.8.0".to_string(),
            },
            MoveScenario::ExistingUnknown,
        ] {
            assert!(alert_copy(&scenario, RunLocation::DiskImage)
                .informative
                .ends_with("\n\nYou're currently running Buzz from a disk image."));
            assert!(alert_copy(&scenario, RunLocation::Translocated)
                .informative
                .ends_with("\n\nmacOS is running this copy from a temporary, read-only location."));
            assert!(alert_copy(&scenario, RunLocation::ReadOnlyVolume)
                .informative
                .ends_with("\n\nYou're currently running Buzz from a read-only volume."));
            assert!(alert_copy(&scenario, RunLocation::OtherNonInstalled)
                .informative
                .ends_with(
                    "\n\nYou're currently running Buzz from outside your Applications folder."
                ));
            assert!(!alert_copy(&scenario, RunLocation::InstalledInApplications)
                .informative
                .ends_with('\n'));
        }
    }

    #[test]
    fn move_failed_alert_copy_surfaces_error_and_manual_path() {
        let (message, informative) = move_failed_alert_copy("ditto exited with exit status: 1");
        assert_eq!(message, "Couldn't move Buzz to your Applications folder");
        // The user is told the app keeps working and how to move it by hand.
        assert!(informative.starts_with("Buzz will keep running from its current location."));
        assert!(informative.contains("dragging Buzz into your Applications folder"));
        // The underlying error is included for support/debugging.
        assert!(informative.ends_with("\n\nDetails: ditto exited with exit status: 1"));
    }

    #[test]
    fn shell_single_quote_wraps_plain_paths() {
        assert_eq!(
            shell_single_quote("/Applications/Buzz.app"),
            "'/Applications/Buzz.app'"
        );
        // Spaces and shell metacharacters are inert inside single quotes.
        assert_eq!(
            shell_single_quote("/Volumes/My Buzz & Co/Buzz.app"),
            "'/Volumes/My Buzz & Co/Buzz.app'"
        );
    }

    #[cfg(unix)]
    #[test]
    fn shell_single_quote_neutralizes_embedded_quotes() {
        // A bundle renamed to break out of double quotes stays a single inert
        // argument under single-quote escaping.
        let malicious = r#"/Volumes/x/Buzz";rm -rf ~;".app"#;
        let quoted = shell_single_quote(malicious);
        assert_eq!(quoted, r#"'/Volumes/x/Buzz";rm -rf ~;".app'"#);
        // A literal single quote becomes the classic close/escape/reopen
        // sequence rather than ending the quoted string early.
        assert_eq!(shell_single_quote("a'b"), r#"'a'\''b'"#);

        // The escaping round-trips through a real shell: the quoted string,
        // echoed back, must equal the original path verbatim with no splitting
        // or command execution.
        let output = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("printf %s {}", shell_single_quote(malicious)))
            .output()
            .expect("spawn /bin/sh");
        assert_eq!(String::from_utf8_lossy(&output.stdout), malicious);
    }
}
