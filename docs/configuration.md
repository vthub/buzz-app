# Deployment configuration: current-feature parity

Buzz Foundation supports configuration for capabilities that exist here, not a
port of every OG Buzz feature. Keep deployment values in local/CI configuration,
not in source. Build defaults are readable binary data, **never secret storage**.

## Supported inputs and surfaces

| Input | Consumer and boundary |
| --- | --- |
| `BUZZ_BUILDERLAB_URL` | Shared frontend/native build: public login URL and the bundled plugin's exact HTTPS host grant; no runtime override. |
| `BUZZ_DEFAULT_COMMUNITY_URL` | Packaged frontend build: secure relay origin to select once, after identity setup, only when this viewer has no saved community record. Saved choices, including Personal space, always win. Unset in OSS builds. |
| `BUZZ_DATABRICKS_HOST` | Frontend build and dev server: `https://` Databricks workspace URL passed as `DATABRICKS_HOST` to every bundled `goose-acp`, which then prefers it to the host in goose's config. Unset in OSS builds. See [Databricks host](#databricks-host). |
| `BUZZ_RELAY_URL` | Live development broker's default community, not an agent relay override or a packaged default. |
| `BUZZ_BUILD_AUTO_CONNECT_DEFAULT_RELAY` | Presence-only alias for fresh-viewer community selection in live development only. Saved viewer choice wins. |
| `BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` | Native build: federated identity authority, adapter prefix and community hosts. See below. |
| `BUZZ_DEV_OPEN_RELAY` | Development-specific override of that alias: only `1` enables; `0` explicitly opts out. Requires a relay URL and live viewer pin to have an effect. |
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

The bundled Builderlab and Hosted Communities plugins keep their own login
against this origin, with or without the federated identity input below.

## Federated identity build input

`BUZZ_BUILD_FEDERATED_IDENTITY_CONFIG` is a public JSON descriptor supplied to
Cargo through the build environment. It is validated and compiled into native
code, with no runtime override or credential field:

```json
{
  "version": 1,
  "id": "example",
  "identityOrigin": "https://identity.example",
  "communityHosts": ["*.communities.example", "custom.example:8443"],
  "adapterBase": "https://identity.example/nip-fa/",
  "apiBasePath": "/api/goose/"
}
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
