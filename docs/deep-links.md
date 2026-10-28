# OS deep links

Packaged desktop builds register a URL scheme with the operating system, so a
link opened outside the app brings it to the front and navigates, at cold start
too. Every build uses `buzz://`, the same scheme in-app links and **Copy link**
use. Ordinary `just desktop` development runs do not register the scheme or
enforce a single native instance, so linked worktrees can run in parallel. macOS
requires the registered bundle itself to run, not `just desktop` or another copy
with the same app identifier. Packaged builds share this scheme (see
[current limits](#current-limits)). Each packaged or debug-bundle launch makes
that app the scheme's handler, ahead of other apps declaring `buzz`, such as the
original Buzz desktop app; until its first launch, the OS chooses. The browser
build has no OS ingress and keeps
its `#buzz=` address form.

## Accepted links

The OS ingress accepts the Buzz link forms and nothing else:

- `buzz://message?channel=<id>&id=<event>[&thread=<root>]`
- `buzz://channel/<id>`
- `buzz://channel/<id>/<event>` (the original desktop message alias)
- `buzz://repo?owner=<64-hex key>&d=<identifier>[&tab=<section>]`
- `buzz://pr?id=<64-hex event>&owner=<64-hex key>&d=<repository>`
- `buzz://issue?id=<64-hex event>&owner=<64-hex key>&d=<repository>`
- `buzz://join?relay=<wss-url>&code=<code>[&policy_receipt=<receipt>]`

Both query-based invite and message links also accept a single `/` before `?`,
as supplied by Windows URL activation (for example, `buzz://join/?relay=…&code=…`).
Non-root paths remain unsupported for these forms; channel paths are unchanged.

Entity sections are `files`, `commits`, `issues`, `prs`, `contributors`, and
`channels`; omitting the section opens the overview. Repository commit links add
`&tab=commits&commit=<40- or 64-hex hash>`. Identifiers use 1-64 ASCII letters,
digits, `_`, `-`, or `.`, without a leading dot or `..`. Query parameters outside
a form's grammar are ignored, with their values and any repeats, so a link that
another client decorated still opens; a duplicated known parameter is rejected as
ambiguous. The `channel` forms carry everything in the path and ignore any query.
The same forms work in message content.

The navigation forms above do not carry a community, so each binds to the currently
selected community and viewer, and fails `unavailable` when no community is
selected or no identity is known. `buzz://join` is the separate invitation form.
It holds through identity setup and opens the
existing join dialog with the relay and code prefilled; it never claims or saves
membership until the user completes discovery, policy acceptance, claim and profile
confirmation. The first-run welcome screen hands an address (and invite code)
typed there to the same intent when it enters the app on a restored community
instead ([identity](identity.md)), so one dialog serves both. The relay's HTTPS `/invite/<code>` page supplies that `buzz://join`
link; HTTPS itself is not registered as an OS handler. Malformed join links,
incomplete entity links, unknown hosts and oversize links fail as
`invalid-target` and show "This destination couldn't open" with **Open Settings**.
Unsupported links have no Retry action. Nothing is auto-joined. A valid address
is never authorization:
bound targets pass the same viewer, membership and channel checks as in-app
navigation, so a link into a channel you cannot read still fails `denied`. The
frontend expects the canonical lowercase `buzz:` scheme; the native URL parser
can normalize scheme case before delivery, so uppercase OS input is not
guaranteed to be rejected.

The latest arriving link wins. Before readiness, one pending intent is retained;
if identity or community is missing, select a community and use **Retry navigation**.
The first known viewer and community bind the intent: switching either afterward
cannot reinterpret it. New navigation cancels it. A cold start opens the ordinary
start page before the destination.

Repositories owns entity presentation through the link-only `buzz.repos/repos`
page; it has no header destination or directory. Repository overviews, files,
commit history and selected diffs, issue/PR details and discussion, contributors,
and linked channels are read-only destinations. Old `buzz://project` links open
“Project containers are no longer available” with guidance to use a repository,
issue or pull request link. They do not read retired container metadata.
The composer’s ResourcePicker discovers listed repositories bound to the current
channel and searches their issues and pull requests directly.
Signed entity metadata remains visible independently of linked-channel access;
Git reads still enforce the relay's authorization. Missing entities and failed
explicit Git sections report navigation failure, not an empty successful page.

**Copy link** emits `buzz://message`, including a reply's thread root when known.
This deliberately omits the sender's community and identity: recipients must select
the correct community before opening it. Original mobile Buzz requires a UUID
channel identifier; named development channels are supported here but do not imply
mobile compatibility. The app has no link form of its own beyond the Buzz ones:
unknown `buzz://` hosts are rejected everywhere, staying plain text in message
content and failing `invalid-target` at the OS boundary.

## Testing locally

For OS ingress, use a packaged app or debug bundle. Write a link by hand, such as
`buzz://channel/general` or `buzz://message?channel=general&id=<64-hex event id>`.
A warm packaged app should come to the front and open the conversation. A cold
start should launch, show the start page, then open the destination once the
client is ready. A malformed link such as `buzz://join?relay=example` must show
the failure notice. Ordinary `just desktop` keeps in-app Buzz links and
**Copy link**, but external `buzz://` delivery is not a supported development
contract.

For entity destinations, use `just web` with the existing authenticated development
broker, select the owning community, and open a Buzz repo, PR or issue link in a
message. No publication is needed to browse. The broker requires Git on its PATH;
it signs repository-root NIP-98 reads with the existing host identity. A selected
commit must show that exact revision and its diff. Back/Forward and Copy link
preserve the entity route, including the requested tab and commit.

**Before native testing:** coordinate with anyone using another Buzz copy on the
machine. Packaged/debug registration can change the installed app's handler, and
packaged apps with the shared app identifier permit only one active native
instance across checkouts. Use a disposable machine/profile or explicitly agree
which app owns the handler and how to restore it. If an older development launch
already claimed `buzz://`, launch the intended packaged app/debug bundle once, or
reinstall it, so that app claims the handler again. Do not launch/register a test
bundle over an active installation without agreement.

**macOS** only routes a scheme to a bundled app. `just desktop` binaries are never
registered, so build a debug bundle and launch it once to register it with Launch
Services and make its identifier the explicit `buzz` default. First quit every
other native Buzz copy, including `just desktop`.
For warm delivery, the bundle selected by Launch Services must itself be running;
forwarding an OS URL from that bundle to a different running copy is not supported:

```sh
just desktop-bundle
open "target/debug/bundle/macos/Buzz.app"
open "buzz://channel/general"
```

Quit the app and run the last command again to test a cold start. The bundle lands
under the workspace `target/` directory because `src-tauri` is a workspace member.

**Windows** packaged/debug builds register the launching binary under the current
user on every start. Ordinary `just desktop` does not register. `just desktop`
and `just desktop-bundle --no-bundle` share `target/debug`; if you ran
`just desktop` after the last debug build, rebuild before launching the executable
or the registered binary will still have development-mode behavior. Use the
installed app or build and run a debug binary, then open a link:

```powershell
just desktop-bundle --no-bundle
.\target\debug\Buzz.exe
start buzz://channel/general
```

The NSIS installer registers the installed app as well; whichever build launched
most recently owns the scheme. Installing or updating the original Buzz desktop
app takes it back until this app launches again.

**Linux** packaged/debug builds write a `<binary>-handler.desktop` entry and call
`xdg-mime` and `update-desktop-database` on every start, so both must be
installed. Ordinary `just desktop` does not register. As on Windows, rerun
`just desktop-bundle --no-bundle` after any `just desktop` launch before testing
the shared `target/debug` executable. Packaged `.deb` and AppImage builds also
declare the scheme in their desktop entry.

```sh
just desktop-bundle --no-bundle
./target/debug/Buzz
xdg-open "buzz://channel/general"
```

## Current limits

- Ordinary development runs do not register `buzz` or enforce the packaged
  single-instance policy. Several worktree apps can run together, but external
  `buzz://` links have no guaranteed development target.
- Every local package keeps the same application identifier, so packaged/debug
  apps share app data and single-instance identity. This is one active packaged
  native Buzz per machine, not per-worktree isolation; Launch Services can list
  several bundles under that identity. On macOS, a registered bundle launched
  while a different copy (including an unbundled dev process) is running can exit
  before receiving the OS URL. The running copy may gain focus without opening
  the link. Cross-copy URL handoff is unsupported: quit the other copy and open
  the link with the intended registered bundle. Cold-start acceptance requires no
  native copy running; warm acceptance requires that exact registered bundle
  already running. Windows/Linux use the plugin's argv handoff.
- Ordinary development worktrees still share app data.
- Invite links (`buzz://join`) open the explicit join dialog; HTTPS
  `/invite/<code>` URLs are shareable through the relay landing page but are not
  registered as OS application links. Remote push is not handled.
- Git browsing uses the authenticated development broker or, in desktop builds,
  native NIP-98 signed reads through the system `git` on `PATH` (macOS also checks
  Homebrew paths). Without `git`, or on other adapters, entity metadata still shows
  and explicit Git sections report unavailable. PR commit lookups only read the base repository;
  external fork clone URLs are never fetched, so exact fork PR diffs are unavailable.
  No repository editing, issue changes, PR review
  decisions, or merge operations are included.
- Git reads fetch a fresh shallow repository per demand: latest 100 commits,
  20,000 file entries, 1 MiB text files and a 4 MiB response ceiling. The 12-second
  deadline and two-read concurrency bound work, not downloaded pack bytes/disk.
  Very large repositories may fail. Empty repositories show no files/commits;
  requesting a specific absent revision still fails. Discovery and issue/PR lists show at most 100 events;
  activity exceeding the 500-event safety bound reports unavailable. These are
  finite views, not exhaustive analytics. Project member resolution is bounded to
  64 members. Valid metadata identifiers outside Buzz's link grammar remain visible
  but cannot be opened/shared through these routes.
- Only the main window receives links. Release signing and distribution remain
  unconfigured; a locally built bundle is enough to exercise scheme registration.
