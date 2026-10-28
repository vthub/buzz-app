# Deployment configuration: current-feature parity

Buzz Foundation supports configuration for capabilities that exist here, not a
port of every OG Buzz feature. Keep deployment values in local/CI configuration,
not in source. Build defaults are readable binary data, **never secret storage**.

## Supported inputs and surfaces

| Input | Consumer and boundary |
| --- | --- |
| `BUZZ_BUILDERLAB_URL` | Shared frontend/native build: public login URL and the bundled plugin's exact HTTPS host grant; no runtime override. |
| `BUZZ_BUILDERLAB_TENANTS` | Shared frontend/native build: which relays each Builderlab deployment hosts and its login origin, for the first-launch community URL; every login origin joins the bundled plugin's host grant. No runtime override. |
| `BUZZ_DEFAULT_COMMUNITY_URL` | Packaged frontend build: secure relay origin to select once, after identity setup, only when this viewer has no saved community record. Saved choices, including Personal space, always win. Unset in OSS builds. |
| `BUZZ_DATABRICKS_HOST` | Frontend build and dev server: `https://` Databricks workspace URL passed as `DATABRICKS_HOST` to every bundled `goose-acp`, which then prefers it to the host in goose's config. Unset in OSS builds. See [Databricks host](#databricks-host). |
| `BUZZ_RELAY_URL` | Live development broker's default community, not an agent relay override or a packaged default. |
| `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` | Presence-only alias for fresh-viewer community selection in live development only. Saved viewer choice wins. |
| `BUZZ_DEV_OPEN_RELAY` | Development-specific override of that alias: only `1` enables; `0` explicitly opts out. Requires a relay URL and live viewer pin to have an effect. |
| `BUZZ_DEV_FIRST_RUN_ACCOUNT` | Dev server only: answers the first-run Builderlab account reads (linked key, owned communities, saved communities, backed-up keys) in place of kgoose, and fakes backup recovery. Builds define it empty. See [below](#first-run-account-seed-development). |
| `BUZZ_DEV_VIEWER`, `BUZZ_COMMUNITY_ALIASES`, `BUZZ_DEV_NOTIFICATIONS` | Existing public viewer pin, public routing aliases and dev notification override; unchanged. See the [development setup](contributing.md). |
| `BUZZ_UPDATER_PUBLIC_KEY`, `BUZZ_UPDATER_ENDPOINT` | Native release build, process environment only: two non-empty values register the updater plugin. The same public key and endpoint must reach `tauri build --config` as `plugins.updater`, and update archives must be signed by the matching private key. Desktop preview release runs supply both for every platform (see [releases](releases.md)); candidate-only and local builds report automatic updates as unavailable. |

The retired v1 inputs `BUZZ_BUILD_AGENT_ENV`, `BUZZ_BUILD_BUZZ_AGENT_PROVIDER`
and `BUZZ_BUILD_AGENT_ACCESS_OWNER_ONLY` are no longer read or compiled. Agents
uses each plugin agent type's settings. Remove these old defaults from local/CI
configuration; they do not configure Agents. Restart Vite to change broker or
routing configuration. Production frontend builds never load the dev broker or
expose its auto-open seed. They can separately opt into the packaged community
default below.

## Packaged community default

Internal packagers can set a public community origin for fresh installs:

```sh
BUZZ_DEFAULT_COMMUNITY_URL=wss://relay.example.com bin/pnpm tauri build
```

The frontend build reads this value from repository-root `.env.local` or the build
process environment (process wins, including an explicit empty value). It accepts
only `wss://` or `https://` origins without credentials, paths, queries or fragments;
invalid values fail the build. It is compiled into the frontend, so changing the
launched app's environment cannot override it. Leave it unset for OSS builds.
The dev server ignores it; live development retains its existing opt-in inputs.

After native identity restoration, creation or import, the existing community
service selects and saves this origin only if the viewer has no `buzz-client.v1`
record on this device. Any saved record wins, including Personal space, malformed
records and unresolvable aliases. A later build default cannot change that saved
choice. Selection starts the normal authenticated relay session; it grants no
membership or admission bypass. If the relay refuses admission or is offline,
the normal connection error/retry flow applies. No legacy preferences are copied.

## Databricks host

Internal packagers can point the bundled goose's Databricks provider at a
workspace:

```sh
BUZZ_DATABRICKS_HOST=https://workspace.cloud.databricks.com/ bin/pnpm tauri build
```

The frontend reads it from repository-root `.env.local` or the process
environment (process wins) and compiles it in. It must be an `https://` URL
without credentials; invalid values fail the build. Every `goose-acp` the goose
plugin starts receives it as `DATABRICKS_HOST`, so goose reports Databricks as
configured and ignores a host saved in goose's config. Only the host is set:
the model, thinking level and sign-in stay goose's own. Leave it unset for OSS
builds.

## Builderlab URL build input

Set `BUZZ_BUILDERLAB_URL` in repository-root `.env.local` for development, or in
the process running `bin/pnpm build` / `bin/pnpm tauri build` for packaging:

```sh
BUZZ_BUILDERLAB_URL=https://app.builderlab.xyz bin/pnpm tauri build
```

Vite uses its existing environment loader; the native plugin-manager build reads
repository-root `.env.local` and process values using the native dotenv pattern.
For desktop, supply the full URL in `.env.local` or the build process environment
so both stages receive it. Vite's additional `.env` and mode-specific files do
not configure native grants. Process values take precedence, including an
explicit empty value. When unset or empty, login is unconfigured and no network
origin is granted. Local builds have no deployment default. The desktop release
workflow supplies the production URL by default; see [release configuration](releases.md#builderlab-url).

Any HTTPS host is supported, including an explicit port or deployment path. URL
credentials, query parameters and fragments are rejected by the native build.
The desktop's native plugin catalog supplies the effective manifest, granting
only the configured URL's exact origin. Never put credentials in this input.

The bundled Builderlab login consumes this public URL and appends `/api/goose`.

Restart desktop development after changing this input so Vite and the native
grant rebuild together; browser-only development needs a Vite restart. Production
web and desktop frontend builds substitute the value into compiled code: changing `.env.local`
or the launched app's environment afterward cannot override it. Rebuild and
redistribute to change a packaged value.

## Builderlab tenant table build input

`BUZZ_BUILDERLAB_TENANTS` tells the first-launch screen which Builderlab
deployment, if any, hosts a community URL the person types, so sign-in can go to
that deployment's portal ([identity](identity.md)). It is read exactly like
`BUZZ_BUILDERLAB_URL`: Vite exposes it as `VITE_BUZZ_BUILDERLAB_TENANTS`, and the
native plugin-manager build reads the same `.env.local`/process value. Set both
inputs in the same place; the repository supplies no deployment table.

The value is a JSON array of rows, each `{"relayHost", "self"?, "loginOrigin"}`:

```sh
BUZZ_BUILDERLAB_TENANTS='[{"relayHost":"communities.buzz.xyz","self":"12f6870117eff1a6318bd38c82a65d51dd19879b7489f57247114d0ee8a96de3","loginOrigin":"https://app.builderlab.xyz"},{"relayHost":"block.builderlab.xyz","self":"76aa9daa7edc9c2e1dc6a2a90dbce10c1bd52f060fa6506ba7bad4f50240fc01","loginOrigin":"https://block.builderlab.xyz"},{"relayHost":"test.blockstaging.build","self":"f7f4df9401ecf46cc608b0889a61d957b306721cdefe42cb24519cb5a473dcf1","loginOrigin":"https://test.blockstaging.build"}]'
```

- `relayHost`: a lowercase hostname (no scheme, port, path or wildcard). A
  community URL matches it exactly or as a suffix at a label boundary, so
  `block.builderlab.xyz` covers `buzz.block.builderlab.xyz` and
  `acme.communities.block.builderlab.xyz` but not `notblock.builderlab.xyz`.
  Only the default port matches. Rows must not repeat a host; the longest
  matching host wins.
- `self` (optional): the deployment's relay key as NIP-11 `self` publishes it,
  64 lowercase hex. When no host matches, a relay publishing a listed key still
  matches its row, so a known deployment survives a DNS move; it can only select
  a login origin already in the table.
- `loginOrigin`: the deployment's portal, written exactly as its canonical
  `https://` origin (no credentials, port `443` omitted, no path, query or
  fragment). The native build grants every distinct `loginOrigin`, together with
  `BUZZ_BUILDERLAB_URL`'s origin, to the bundled Builderlab plugin, up to 15
  login origins (the manifest limit of 16 keeps one for that origin's Apps
  Platform); the first-launch OAuth client can reach nothing else. The native
  kind-24243 binding signer accepts a challenge for these origins and production
  Builderlab only.

A community URL that matches no row chooses no portal: the welcome screen asks
whether to connect with Builderlab at `BUZZ_BUILDERLAB_URL` or bring an existing key.
Malformed rows fail the Vite configuration and the native build without echoing
the value. The same restart and rebuild rules as `BUZZ_BUILDERLAB_URL` apply.

## First-run account seed (development)

After Builderlab sign-in, the first-launch flow reads four things about the
account from kgoose: the Nostr key bound to it, the communities it owns, the
destinations saved to it ([known communities](communities.md#known-communities))
and the keys it holds a backup of ([identity](identity.md)), binds a key it creates or
imports to an unlinked account, and, on Start over, unlinks the lost key
before binding the new one. A developer's real account is bound to their real key and that binding
must not change, so `BUZZ_DEV_FIRST_RUN_ACCOUNT` replaces those reads, the
binding, the unlink, the key backup and backup recovery — and nothing else —
on a dev server:

```sh
# A brand-new account: the key-setup choice follows sign-in.
BUZZ_DEV_FIRST_RUN_ACCOUNT=unlinked
# A returning user: Welcome back for this npub, with these owned communities.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","communities":["design.example.com"]}'
# An account with these destinations saved to it (read with the account check; nothing restores them yet).
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"known":["chat.example.com","wss://buzz.example.org:8443"]}'
# A brand-new account whose every backup fails as if Builderlab were unreachable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"unreachable"}'
# A brand-new account whose first backup fails, so Try again then succeeds.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"backup":"fail-once"}'
# A returning user whose Start over unlink fails as kgoose answering 503 would.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","unlink":503}'
# A returning user with Restore from backup, which answers that recovery is unavailable.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"]}'
# The same, where every restore recovers this throwaway key.
BUZZ_DEV_FIRST_RUN_ACCOUNT='{"npub":"npub1…","backups":["npub1…"],"recovery":"nsec1…"}'
```

Every field is optional; without `npub` the account is unlinked. `communities`
lists hostnames (or `wss://`/`https://` origins) the way the Community URL field
accepts them; `known` lists the destinations saved to the account the same way,
answered as kgoose spells them (`wss://host[:port]`). `backup` names a failure kind from
`src/features/identity/backup-failure.ts` (such as `unreachable`, `timeout` or
`refused`), and every backup then fails with that kind's page; `fail-once`
fails only the first backup after each sign-in, as Builderlab not confirming
it, so Try again succeeds. `unlink` is an
HTTP error status (400–599), and every unlink then fails as kgoose answering it
would: a 429 or 5xx offers Try again, and a 401 reads as a lapsed sign-in. `backups` lists the npubs backup status answers
(none when absent), so Welcome back offers Restore from backup when it holds
`npub`. `recovery` is the `nsec1…` every restore recovers, which installing
imports as if it were typed; without it every restore answers that recovery is
unavailable, as every tenant does today. The value is plain text in your
environment, so use a throwaway key, never a real one. Vite exposes the value
as `VITE_BUZZ_FIRST_RUN_ACCOUNT` for `serve` only; `pnpm build` and
`pnpm tauri build` define it empty, so packaged apps always ask kgoose. A
malformed value fails the Vite configuration without being echoed. Restart the
dev server after changing it. With a seed, binding, unlinking and backup
succeed (unless `unlink` or `backup` is set), and a joined community's save to
the account succeeds, without a request, a native signature or a native backup
command, in every build.
Restore opens no browser and runs no native recovery command.

## Whole-video limit

The desktop app reads relay video from its origin one bounded `Range` at a
time. When an origin ignores it and answers a video with a whole `200`, the app
copies that video to a temporary file, up to the development broker's 500 MiB
video limit, and answers the player's requests from the file as bytes arrive.
The limit is the compile-time constant `WHOLE_VIDEO_MAX` in
`src-tauri/src/relay.rs`; edit it and rebuild to change it.

- A video of exactly the limit plays. A larger `Content-Length` is rejected with
  413 before any download; without one, the download stops and is rejected once
  it passes the limit. Without a `Content-Length`, playback starts once the
  whole video has arrived, since a range answer needs the total size.
- At most two such files exist at once, each anonymous and deleted by the OS
  when it closes. Opening a third drops the least recently used one. A file is
  kept while a player's connection to it is open or a read waits for its
  bytes, and for 60 seconds after; then it is dropped, stopping its download,
  and playing the video again downloads it again.

## Deliberate exclusions

Inventory source: `block/buzz-releases` at
`af57fbf40b50941c03cef2466b1e6970ab6bc779` (`.buildkite/pipeline*.yml`,
`scripts/build-macos.sh`, mobile helpers, `scripts/lib.sh` and publishing helpers),
compared with OG `block/buzz` at
`99c2acf90cfbb1cb2d3a8bd900c0ec1642e20540` (`desktop/src-tauri/build.rs` and its
runtime consumers). No deployment-specific values from those repositories are
copied here.

| OG/release input | Why it is not implemented here |
| --- | --- |
| `BUZZ_DESKTOP_BUILD_RELAY_URL` | Retired name; internal builds use `BUZZ_DEFAULT_COMMUNITY_URL` above. No legacy input alias or admission bypass is added. Native macOS, Windows and Linux otherwise restore the selected saved community; new admission uses Join a community. Windows/Linux installed-app acceptance remains unverified. The dev broker and saved agent destinations remain separate. See [packaged identity](identity.md). |
| `BUZZ_BUILD_RELAY_RECONNECT_CMD` | No reconnect-command feature; arbitrary deployment command execution is not added. |
| Updater helper fallback aliases | Only the two canonical updater names above are read. Private signing keys never belong in app defaults. |
| `--features mesh-llm` | No mesh/provider integration is supplied by the native identity crate. Import carries identities, not legacy runtimes. |
| `BUZZ_BUILD_OBSERVER_ARCHIVE_DEFAULT`, `BUZZ_BUILD_AGENT_METRIC_ARCHIVE_DEFAULT` | Already no-ops in inspected OG: its archive capability checks return true for all builds. This app does not claim equivalent archive collection by accepting inert flags. |
| Build-command `BUZZ_ACP_ALLOWED_RESPOND_TO`, `BUZZ_ACP_ALLOWED_CHANNEL_ADD_POLICIES` | OG consumers are runtime-only; setting these around compilation does not bake them. The retired v1 listener no longer consumes these inputs; Agents uses its attention settings. |
| Mobile `BUZZ_AGE_GATING_ENABLED`, Android `BUZZ_ANDROID_RELEASE_SIGNING=external` | No corresponding Flutter/Android target in this app. |
| CI version/tag metadata, artifact paths/upload controls, signing teams/profiles, Apple/App Store/Artifactory/Play credentials, Android signer roles/sockets, SDK/JDK/toolchain settings, Tauri bundle/config arguments | Release infrastructure and packaging controls, not product defaults. No new build-variable forwarding API. |

Ignored `.env.local` can contain unrelated development settings. Only the inputs
with current consumers listed above have an effect. Do not use any build input
for private keys, tokens or raw agent configuration.
