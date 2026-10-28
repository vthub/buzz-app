# Desktop test releases

The **Desktop previews** workflow builds all supported desktop platforms from
`main` and publishes one GitHub prerelease, tagged
`v<app-version>-preview.<run-number>.<attempt>` at the built commit:

- **Apple Silicon and Intel macOS:** a signed/notarized DMG and a signed updater
  archive with its `.sig` for each architecture.
- **Windows x64:** unsigned NSIS `.exe` installer and its updater `.sig`.
- **Linux x64:** Ubuntu 24.04 `.deb` and AppImage, each with its updater `.sig`.
- **Provenance:** `SOURCE_COMMIT` and one `SHA256SUMS` covering all twelve asset files.

Publication waits for every platform job, their existing payload checks and
the Windows/Linux updater signatures. A failed platform blocks publication and
automatic feed promotion; it does not publish a partial release. Downloads are
checked against each job's checksums before assembly. If a job fails, use
**Re-run all jobs**, not just failed jobs: the run attempt is part of the version,
and publication rejects mixed-version artifacts. Windows/Linux previews are not
Authenticode-signed Windows releases or evidence of completed desktop acceptance.

Runs are scheduled at **00:17, 06:17, 12:17, and 18:17 UTC**. To start one manually:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main
```

The macOS builds run on Apple Silicon `macos-latest` with the repository's
pinned toolchain; the Intel build cross-compiles `x86_64-apple-darwin` with the
same Rust release from rustup, because Hermit's Rust ships only the host's
standard library. Each publishes an Apple-signed/notarized DMG and a separately
Tauri-signed updater `.app.tar.gz` and `.sig`. The updater archive is
rebuilt from the verified app in the signed DMG; built-in Tauri artifact
creation remains disabled because this DMG-only build does not emit an updater
archive.

Windows and Linux installers are built with the same updater configuration.
Their jobs never receive the Tauri signing key: each checks that its installed or
extracted app executables embed the pinned public key and preview endpoint (and,
on Linux, the deb or AppImage bundle type the updater uses to choose its feed entry),
then uploads the installers. A separate `updater_signatures` job verifies their
checksums and Tauri-signs those exact bytes. The updater runs the downloaded NSIS
installer on Windows (current-user, no elevation), replaces the AppImage in place,
and installs a deb with `dpkg -i` through `pkexec`, which asks for an
administrator password.

The release automatically promotes each eligible build to the rolling preview
feed after the signed prerelease is published and the promotion gate passes.
This includes scheduled runs and manual builds without `promote_version`.
An updater-less artifact, invalid signature, or rollback leaves the existing feed
unchanged, but the promotion job fails and needs investigation. The workflow
does **not** publish to the legacy `block/buzz` updater. Older installed apps
cannot use the feed until an updater-enabled build is installed. Preview builds
for all three platforms are built with the updater enabled and check the preview
endpoint below.

## Preview updater feed (automatic promotion, manual recovery)

The preview endpoint is `https://github.com/block/buzz-app/releases/download/preview-feed/latest.json`.
This is a dedicated rolling prerelease in `block/buzz-app`, separate from legacy
`block/buzz`'s `buzz-desktop-latest`. Reserve `stable-feed/latest.json` in this
repository for a future production channel; this workflow never creates it.
Neither endpoint is `releases/latest`: versioned builds are prereleases.

**Auto-promotion begins as soon as this workflow lands on `main`.** Install an
updater-enabled build manually first (older installed builds lack the updater),
and verify its embedded public key and preview endpoint match the release
configuration. Those values are checked in each candidate's macOS binary at
promotion and in the Windows/Linux binaries by their build jobs, but nothing
validates a live old→new install before publishing. For manual recovery or a controlled repromotion, dispatch
an existing version from `main`:

```sh
gh workflow run release.yml --repo block/buzz-app --ref main \
  -f promote_version=0.7.0-preview.<run>.<attempt>
```

After the first eligible build publishes, exercise discovery, signature
verification, download, install, relaunch/version, and absent-feed and
mismatched-key handling on disposable clients before expanding preview
distribution. There is no safe way to perform a live old→new check against
the fixed URL without first exposing a candidate to clients already pointed
there. Restrict distribution until that check succeeds.
The release build must embed the same pinned public key and preview endpoint as
#312; promotion verifies both in the candidate macOS executable. Builds made before
that integration are ineligible even if their updater archive and signature
exist, as are builds without Windows/Linux signatures. The promotion gate
downloads every updater artifact and signature, verifies the
Minisign archive and trusted-comment signatures against the client's pinned
key. The release signer signs the archive and trusted comment without passing
`--app-version`, so signatures do not embed an authenticated version. The gate
accepts that format and verifies both signatures, but cannot bind the advertised
feed version to those signed bytes.
A feed-response attacker can replay an older authentic archive/signature under
a higher advertised version. Preview distribution must accept that residual
risk until a separate signing migration passes `--app-version`, enables
`requireSignedVersion`, and requires the same version at promotion. The CLI
2.12.2/updater 2.13.3 dependency upgrade leaves this migration deferred. Do not
enable the client flag alone: existing unbound signatures would fail. A signature
mismatch fails before the rolling manifest is replaced.

The job builds the Tauri manifest with each artifact's signature from that
release and an immutable versioned asset URL: `darwin-aarch64`, `darwin-x86_64`, `windows-x86_64`,
`linux-x86_64-deb` and `linux-x86_64-appimage`. Linux has no generic entry, so
a deb install never receives an AppImage. The job refuses full-SemVer rollback and
changed same-version metadata, and replaces the rolling manifest last. The
archive and signature remain on the versioned release. The job reads back
and compares the GitHub API asset; this is not evidence of public endpoint
availability. Confirm the endpoint in an installed client after the first
promotion. GitHub asset replacement can briefly return 404 while the old asset
is replaced. Promotion is serialized with the release workflow, and a failed
upload needs investigation before the next scheduled run.
Recover from a broken feed by promoting a higher tested build; for key loss or
client failure, distribute a manually installed build (an Apple-signed DMG on macOS). Do not assume
rolling back a signed archive can undo an installed update.

## Preview retention

After successful promotion and feed read-back, the same serialized job removes
old versioned preview releases **and their Git tags**, keeping the union of:

- the latest **10 published previews**, ordered by publication time;
- every preview published within the last **seven days** (including the boundary);
- the preview currently referenced by `preview-feed/latest.json`.

Cleanup only considers non-draft prereleases with canonical
`v<app-version>-preview.<run-number>.<attempt>` tags. Stable releases, other tag
formats, and the rolling `preview-feed` release are never deleted. The feed is
read again before cleanup; an unavailable/invalid feed, missing target, failed
listing, or invalid preview publication date aborts before deletion. A deletion
failure stops cleanup and fails the job, without rolling back the promoted feed;
inspect the release/tag state before rerunning. Cleanup also runs after successful
manual promotions, but never after failed promotion or Windows/Linux candidates.

To inspect the current plan without deleting anything, from an authenticated
checkout:

```sh
GH_REPO=block/buzz-app bin/node scripts/prune-preview-releases.mjs
```

The workflow passes `--apply` to execute the plan. Removed release download links
stop working; clients holding a removed version's download URL must check the feed
again. The age window is measured from publication, not promotion. Actions build
artifacts have a separate seven-day retention policy and do not control GitHub
release retention.

## Release tags

Release builds outside this repository's preview workflow consume immutable
`desktop-vX.Y.Z` or `desktop-vX.Y.Z-beta.N` tags, never a branch or commit.
Run **Desktop release tag** from `main` with the version and a full commit SHA
in `main` history. It publishes an annotated tag through the release GitHub App
and fails before writing unless an active tag ruleset includes
`refs/tags/desktop-v*`, has no exclusions, restricts creation, update, deletion
and non-fast-forward, and lets the App bypass it. A published tag is never
moved or reused; cut a new version instead.

Setup, by a repository admin:

- Install the release App and create a `desktop-release-tag` environment that
  deploys only from `main`. Put the `BUZZ_RELEASE_TAGGER_CLIENT_ID` variable and
  `BUZZ_RELEASE_TAGGER_PRIVATE_KEY` secret in that environment, not the repository.
- Create the ruleset with the App as its only bypass actor, in `always` mode. The
  workflow cannot see the bypass list, so confirm it before the first tag and
  after any ruleset change.

## Prerequisites

### Builderlab URL

The **Desktop previews** workflow sets `BUZZ_BUILDERLAB_URL` for all platform
builds, including candidate-only runs. It defaults to `https://app.builderlab.xyz`.
To override it, set the repository's non-secret Actions variable
`BUZZ_BUILDERLAB_URL`; an unset or empty variable uses the production default.

### Signing

Deploy [the signing infrastructure](https://github.com/squareup/tf-mobuild-workers/pull/1398)
and set these repository Actions secrets:

- `OSX_CODESIGN_ROLE`: ARN of `block-buzz-app-codesign-role`.
- `CODESIGN_S3_BUCKET`: `block-buzz-app-artifacts-bucket-<environment>`.
- `TAURI_SIGNING_PRIVATE_KEY`: persistent Tauri updater private key (not the
  Apple Developer ID signing identity). Restrict access to release CI and back
  it up outside Actions; losing it prevents old updater-enabled builds from
  trusting new releases.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for that key.

Keep the matching updater public key in updater-enabled app builds. Rotate only
with a planned transition/recovery path (a manually installed signed DMG if
necessary); changing the key alone strands existing installations. Do not
publish a preview `latest.json` until its archive and signature are available
at stable HTTPS URLs. Verify old-build → new-build installation promptly after
the first eligible auto-promotion, before wider preview distribution.

## Bundled goose-acp

Every package ships `goose-acp` in its `bin` resources, so Goose agents need no
install. `scripts/build-goose-acp.mjs` builds it from the goose commit pinned in
`runtime/goose-acp.json`, with only the features the Goose plugin uses, in the
small `lean` profile (about 15 MB on macOS). `tauri build` runs the script
through `beforeBuildCommand`; `just desktop` runs it with `--dev`, Cargo's faster
dev profile. It skips the build when the staged binary already matches the pin.
To move to a newer goose, change `revision` in the pin. The app's own signature
covers the binary; nothing else checks it at launch. Each release job checks that
its package contains it.

## Windows and Linux installers and candidate-only runs

The same **Desktop previews** workflow has a manual `candidates` switch. It builds
unsigned Windows x64 NSIS `.exe` and Ubuntu 24.04 x64 `.deb`/AppImage artifacts,
without running macOS signing or the release publisher:

```sh
gh workflow run release.yml --repo block/buzz-app \
  --ref <candidate-branch> -f candidates=true
```

Scheduled runs and dispatches without this switch build and publish all three
platforms. A `promote_version` recovery run skips all platform builds and only
updates the feed. Candidate-only runs remain artifact-only, are built without the updater, and can run from
a feature branch, without signing credentials or publication. They use the same
preview version, source commit and repository toolchain pins; they never
use legacy Buzz's sidecars, updater feed, application identifier, or signing
secrets. The workflow records
`SOURCE_COMMIT` and checksums over final installer bytes. Download the
`windows-x64-candidate` and `linux-x64-candidates` artifacts from that Actions run
within seven days. These are **ready to try only after their build and payload
checks pass**, not accepted releases.

Windows uses the repository's Rust, Node and pnpm pins on the hosted MSVC runner
because Hermit does not run there. NSIS retains Tauri's current-user install and
WebView2 download-bootstrapper defaults (network needed if WebView2 is absent).
The job silently installs into a disposable runner directory and verifies the
installed app executable, without launching the app.

The Windows config pins `bundle.publisher` to `local`, the publisher Tauri derived
from the identifier before 1.0, so an update still finds the install folder Tauri
records under `Software\local\Buzz Foundation`. An update keeps existing shortcuts,
so `src-tauri/installer-hooks.nsh` gives the Start menu and desktop shortcuts the
current identifier as their AppUserModelID, which Windows shows notifications under.

Linux reuses old Buzz's Ubuntu 24.04 recipe and guarded Wayland/GStreamer AppImage
repair from `block/buzz` tag `desktop-v0.5.25`. Repacking tools and the type2 runtime
are checksum-pinned. The workflow verifies the app executable in the extracted deb
and the app executable and launch shim in the extracted AppImage after repacking.
Compatibility guards fail rather than silently omitting a fix.
AppImage still relies on host desktop/media libraries; this is not a promise of
universal distro compatibility. Neither candidate job writes shared build caches.

### Acceptance still required

Use disposable Windows 11 and Ubuntu 24.04 GNOME accounts with throwaway keys.
Do not replace an everyday machine's `buzz://` handler without agreement.

1. Install and launch without a developer toolchain; respect Windows security
   policy for unsigned apps. Linux needs a working Secret Service desktop session.
2. Create/import identity, quit and relaunch with the same key. Check unavailable
   storage fails safely. Join the intended community, send/receive and reconnect.
3. Check cold/warm `buzz://` links, install a newer preview over the previous one,
   verify identity/settings survive, and record uninstall/retained-data behavior.
4. Have a human repeat install → messaging → restart before accepting the build.

Two Windows native failures were last observed at `a68b39d6` (legacy-import path
separator assertion and model-auth recovery). Re-run the existing manual Windows
CI lane on the candidate and diagnose any surviving failures separately from
installer success. The packaging jobs do not waive them or enable local-agent
hosting. Builderlab/NIP-FI admission remains a separate product limitation.
Windows/Linux installers published by normal release runs are in the preview
updater feed. Publishing or promoting a preview does not waive the manual
acceptance checks above, including an old→new automatic update on each platform.
