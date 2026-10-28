# Packaged human identity and relay access

Native macOS, Windows and Linux without the live development broker open on a
welcome screen when no human key exists on this device: **Buzz** — "Your people,
your agents, your projects — all in one place." — with **Sign in with email**
(the label the Buzz mobile client uses; first-run copy never names the sign-in
provider), a live **Community URL** field with **Continue** beside it (the
same field and normalisation as Join a community below), and **Scan a QR code**,
shown disabled as *Coming soon*. Sign in runs the bundled Builderlab plugin's
browser sign-in under that plugin's own native network grant; that credential
is not yet shared with Settings → Integrations → Builderlab. A failed or
canceled sign-in shows *Couldn’t sign in* with the error and **Back** to the
welcome screen. The welcome screen carries the
onboarding artwork and wordmark, and every later first-run page sits on the
same artwork; pages without a finished design are plain black-and-white
wireframes. When a page replaces another, focus moves to the new page's
heading unless the page focuses a field itself, and **Back** returns focus to
the choice that opened the page.

A URL given on the welcome screen is looked up first, before sign-in and before
any key exists: **Continue** opens the same **Finding community** page described
below, which sends only the two unauthenticated GETs, so a typo, an unreachable
relay or a non-Buzz address fails there with the same classified copy; **Cancel**
(and **Retry**, when offered) behave as below, except that Cancel returns to the
welcome screen with the address kept in the field. A found community decides
which sign-in follows: `discoverAuthentication` in
`src/features/identity/builderlab-tenants.ts` matches the community's hostname,
then its NIP-11 `self` key, against the
[`BUZZ_BUILDERLAB_TENANTS` build table](configuration.md#builderlab-tenant-table-build-input).
A match starts Builderlab sign-in at once at that tenant's portal (the same
browser sign-in, exchange and account check, at the row's `loginOrigin` instead
of `BUZZ_BUILDERLAB_URL`), and the welcome screen shows it pending (**Cancel
sign-in**, with the field disabled). Cancel sign-in, and **Back** from a sign-in
or setup failure, return to the welcome screen with the address kept and do not
look it up again. A community no row hosts is not known to be Builderlab-hosted,
so it pauses on **Connect to {host}** instead of choosing a portal. The page
says only that Buzz relies on a key for the user's identity; its choices are
**Sign in with email**, which signs in at `BUZZ_BUILDERLAB_URL` and
continues exactly as the welcome screen's own button does (the landing shows
the sign-in pending with the address held; the key it creates is linked to that
account and backed up there), and setup then lands on **Join Community** for
the address;
**I already have a key** opens **Enter your private key** and, with no account
signed in, continues from there with no link step and no backup offer; **Back**
returns to the welcome screen with the address kept.

Success continues to a **Setting up Buzz** page that shows the current step
beside a spinner. It first runs **Checking your account**, a real read of the
Nostr key bound to the signed-in Builderlab account
(`POST /api/goose/v1/buzz/nostr-identities/current` at the portal that signed
the user in, authenticated with the first-run session credential and sent
through the bundled plugin's native grant; `src/features/identity/builderlab-account.ts`,
sharing the hosted-communities card's routes and reply parsers). A `200` with
no `identity` means no key is linked (kgoose sends `MISSING_MAPPING` only from
the community list); any other failure is **Couldn’t finish setup**, naming the
step and HTTP status (never the response body), for example "Builderlab account
check failed (HTTP 403: not JSON)". A lapsed sign-in, which kgoose answers on
every account route with a plain-text HTTP 401, reads *Your Builderlab sign-in
is no longer valid.* here and on every later account step. Binding is 1:1 and
enforced, so the answer picks the lane: a linked account is never given a
second key. Under the same label, and in parallel, it reads the destinations
saved to the account (`POST /api/goose/v1/buzz/known-communities/list`, same
portal and credential: the list the Builderlab plugin's
[known-communities sync](communities.md#known-communities) keeps, which needs
no Nostr identity). That read never fails setup: a refusal, a portal without
the route (a plain-text `404`) or a row the app cannot read leaves the list
unknown and first run continues as if the account had saved none. The list is
kept from sign-in until the welcome screen is shown again, so Start over keeps
it, and every lane ends by restoring it (*Restoring your communities*, below).

Either lane continues with *Checking for a backed-up key*, which reads the
keys the account holds a backup of
(`POST /api/goose/v1/buzz/nsec-backups/status`, same portal). It is sent only
where the backup step can run (see
[automatic backup](#automatic-backup-and-optional-recovery)); kgoose answers
`404` wherever backups are not configured, which today is everywhere but
staging's public Builderlab. Not sent, a `404` or any failure leaves the lookup
unavailable rather than empty, and never fails setup: it only decides whether
Welcome back offers a restore and whether an import needs the backup offer.

**Not linked** then pauses on **Set up your key**: when the lookup listed no
backups, it says no backed-up key was found for this account, so Buzz will
make one (an unavailable or failed lookup says nothing either way, nor does
one that lists backups, which outlive an unlink), and it says that an
encrypted copy is backed up to the account, which Block can use to restore the
key on the user's other devices. Under the body it says who is signed in
(*Signed in as {email}.*, or *Signed in.* when the portal sent no address), so
a wrong account is visible before any key exists. Like the welcome screen, it
stacks its choices at the bottom: **Create my key** (primary) above a quieter
**I already have a key** and **Use a different account**, which signs the
first-run session out and returns to the welcome screen with the typed address
kept and no key created. The browser may still hold the portal's own cookie
session, so the next **Sign in with email** can re-select the same account
unless the user signs out of the portal in the browser first; first run cannot
end that session. Choosing Create my key is the backup consent (see
[consent hooks](#automatic-backup-consent-hooks)). It runs **Creating keys**,
which generates a Nostr key through the same native create command as the key
setup screen, so the next launch opens as a returning user; then **Linking your key**, which
binds that key to the signed-in account at the same portal (kgoose's binding
challenge, signed natively as a kind-24243 event, then verified — the flow the
hosted-communities card drives), sending nothing more when the account already
holds the key; then **Backing up your key**, which waits for the native
uploader to confirm the backup
([automatic backup](#automatic-backup-and-optional-recovery)). First run never
shows the new key; Settings → Identity can reveal it later.

**I already have a key** opens **Enter your private key** while setup stays
paused, laid out as the onboarding import screen (centred heading and body,
**Continue with this key** above **Back** at the bottom): a masked private-key
field —
paste or type an `nsec1…` key,
or drop or choose a text file of at most 1 KiB whose first line is one — with
**Reveal private key**, a live *Public identity* npub preview under a valid key
(never hex), and classified messages for anything else: a NIP-49 `ncryptsec1…`
backup is refused as *Password-protected backups aren’t supported here yet*
(the app has no NIP-49 decryption), other text as *That doesn’t look like a
valid nsec*. **Back** returns to Set up your key with the typed key discarded;
**Continue with this key**, enabled only for a valid nsec, stores it through the
same native import command as the key setup screen (`identity_import`, which
takes the nsec as typed) behind *Importing your key…*, shown on the same
screen. A native refusal — an
invalid key, or a key already saved in this slot — appears under the field with
the form kept. An imported key is then linked to the account like a created
one and pauses on **Back up this key?**, since importing never uploads
silently: Buzz can keep an encrypted copy in the account, which Block can use
to restore this key, including anywhere else it is used. **Not now** carries on without a
backup; **Back it up**, the backup consent for that key, runs **Backing up your
key**. An import from **Connect to {host}**, with no Builderlab sign-in, has
no account to link the key to or back it up in, so it skips the link and the
offer and continues at once.

**Linked** pauses on **Welcome back**: the account is already linked to a Buzz
identity — the key on the user's other device — shown as the full npub under
*Linked public key (npub)* with **Copy**, with the same *Signed in as {email}.*
line under the body. A linked key does not mean a
backed-up one, so only when the lookup lists the linked key does the page also
offer **Restore from backup** (primary), with **Enter your private key** as a
smaller choice; otherwise **Enter your private key** is primary. It opens the
same import page, which here accepts only the linked key: any other valid nsec
is refused under the field with *That isn’t the key linked to this account. It
expects npub1…*, and **Back** returns to Welcome back. **Recover from another
device** is *Coming soon* (device pairing is its future entry). Last in the
stack, **Use a different account** is the same exit as on Set up your key: it
signs the session out and returns to the welcome screen without importing,
restoring or replacing the linked key. The imported
key is already the account's, so nothing is linked. Unless the lookup already
lists it, a successful import then pauses on **Back up this key?** as on a new
account; a listed key continues without the offer.

**Restore from backup** runs native recovery (see
[optional recovery](#automatic-backup-and-optional-recovery)), which opens its
own browser sign-in: the first-run one is not reused. Above the recovery, the
page centres its heading and, only while it waits for that sign-in or offers
the linked key, *Your key is stored securely on this device.*: an outcome that
restores nothing drops the line, and the unavailable copy below replaces it. Of
the keys it recovers, only the linked one is offered; a recovery without it
says *None of your backups holds the key linked to this account, so nothing was
restored.*, installs nothing and offers **Enter your private key**, which opens
the import page. Installing the key continues as an import does, without the
backup offer: the key is already backed up. Where recovery is unavailable or
refused for the account — no tenant enables it today, and public organizations
are refused by design — the page says *Backup restore isn’t available for this
account* and offers **Enter your private key**, which opens the import
page, never a retry. Any other failure offers **Try recovery again**. **Back**
cancels the recovery and returns to Welcome back.

On Welcome back, **I lost this key** (quieter) runs **Finding communities**, a real read of the
communities the account owns
(`POST /api/goose/v1/buzz/communities/list`), and shows **Start over with a new
key**: a new key loses everything the old one could reach; *Communities you
own* lists their hostnames (*None* when empty, or that the list could not be
loaded), and memberships in other people's communities cannot be listed and are
lost too. The page also says that starting over unlinks the old key, then
creates a new key, links it to the account and keeps an encrypted copy that
Block can use to restore it, so choosing it is the new key's backup consent.
**Back** returns to Welcome back; **Start over with a new key** (destructive)
runs **Creating keys**, then *Unlinking your old key*, which deletes the old
key's binding (`POST /api/goose/v1/buzz/nostr-identities/delete`), then
**Linking your key** and **Backing up your key** for the new key, with no key
choice between. The old key stays linked until the new one is on the device,
and binding never overwrites, so the unlink comes after creation and before
the link. The unlink checks the bound key first: it sends nothing more when
the account holds no key or the new one, fails when it holds a third key, and
deletes only while it is still the old one, so repeating it never removes the
new key's binding. It
counts as done only when kgoose confirms removing the old key, or the account
then holds no key or the new one. If the old key is still bound (kgoose removes
nothing when the sign-in is no longer active) or another key is, the step fails
without Try again.
Welcome back itself never offers Create my key.

Every lane ends the same way. A linked account runs **Finding communities**
(the same real read) once its key is on the device; the old key's list is not
read after starting over. A failed step shows **Couldn’t finish setup** with the
error — for a refused link, the hosted-communities card's copy (*This
Builderlab account is connected to another Buzz identity.*, *This Buzz identity
is connected to another Builderlab account.*) or first run's own for kgoose's
other refusals, such as an expired link request or too many attempts; for a
backup, why it did not complete; otherwise the step and HTTP status, as for the
account check. kgoose's own wording is never shown, nor its correlation ID,
which stays on the error and is logged in development builds. Once a key is on
the device, the page also says what is undone: *Your key is saved on this
device, but it isn’t linked to your account or backed up yet.* when
the unlink or link failed (a key that isn't linked can't be backed up),
otherwise *Your key is saved on this device, but it isn’t backed up yet.* A
failure that may clear offers **Try again** (primary), which repeats the failed
step and the rest of the lane, never creating a second key: for the account
check, unlink or link, no answer, too many requests (HTTP 429) or a server
error (HTTP 5xx), and for the link also a link request that expired, was
already used or could not be found, since Try again asks for a new one; for a
backup, Builderlab being unreachable or slow to confirm. A lapsed sign-in is
never retried, since Try again would send the same sign-in. A failed unlink or
link with a key on the device blocks: nothing links the key later, so the page
offers only **Try again**, whatever the failure, and no way past it. A failed
backup also offers **Continue without backup**, which writes nothing and skips
the remaining steps for the end of the lane below (Finding communities on a
linked account, then the restore); a later sign-in runs the backup again.
Before a key exists, the page offers **Back** to the welcome screen instead.

Within one first-run session the Join page exits only through a join or a
restored community; there is no skip. That holds only while the app stays
open. Quitting with a key on the device but no saved community ends first run:
the next launch restores the key and, with setup idle, lifts the gate straight
into the in-app **Join a community** landing (`CommunityLanding`), the page a
key without a community has always opened on. The key stays on the device, and
the **Key backup** row in Settings → Identity shows the backup state. A link or
backup step still running at quit ends with the process: the native uploader's
pass is retired, and whether the link committed on kgoose is unknown to the
client. Both are safe to run again — the link reads the account's current key
first and does nothing when it already holds this one, and the uploader runs
again when the user next signs in to Builderlab in Settings — but nothing
re-runs the link on its own, and Settings has no row for it; the Key backup row
reports only what the uploader's last pass found.

Every lane ends with *Restoring your communities…* when the account check
listed destinations saved to the account (`src/features/identity/restore-communities.ts`):
each distinct destination this build can open (the list is deduplicated by
canonical origin, and an address the app cannot open is skipped) gets the
same signed profile read the Join Community page uses to prove admission, at
most three at once, and none started more than 45 s after the step began. A
destination that admits the key is saved to this device through
`communities.joined` under its hostname (its relay profile seeds the empty
local default); one that refuses the key, cannot be reached or will not save
is recorded and otherwise silent — nothing shows it in the app, and the
Builderlab plugin's sync adds it without an admission read after the next
Settings sign-in. The step never fails setup. Where setup rests then depends
on what was admitted:

- Nothing (the list was empty, unreadable, or every destination was refused or
  unreachable): the Join page below, as if the account had saved none.
- At least one, with no address given on the welcome screen: the first
  admitted is selected and the app opens on it.
- At least one, and the welcome-screen address is among them: that one is
  selected and the app opens on it; nothing else is asked.
- At least one, but the welcome-screen address is not among them (not saved,
  refused or unreachable): the first admitted is selected, the app opens on it,
  and the typed address — with its invite code, if it came from an invite link —
  is handed to the rail's **Add a community** dialog through the same invite
  intent a `buzz://join` link uses ([deep links](deep-links.md)), so the join
  completes inside the app: discovery, policy, code, profile. A saved
  destination that refused the key therefore never shows the first-run **This
  community needs an invite** page; the dialog's access step says to ask an
  administrator for a code, and the npub is in Settings → Identity. Closing
  the dialog leaves the restored community selected.

Entering the app this way (as after a first-run join) first runs the profile
step below when no profile exists anywhere, and clears the typed address from
the welcome screen's own state, so once the dialog owns it nothing on this
side can look it up again. The startup visit's 15-second deadline runs only
while the app is presenting it, so a first run of any length enters on the
channels page rather than a timed-out destination. Otherwise setup lands on
**Join Community** for the address given on the welcome screen, looked up again
(the policy may have changed meanwhile), or otherwise on **Join a community**,
laid out as the in-app Join a community landing: a centred heading, then, when
the account owns communities, rows under *Communities you own* — icon
placeholder, hostname and **Join** (named *Join {host}* for assistive
technology), which takes exactly the typed-URL path for that host — then a
**Community URL** field with **Continue** beside it.
**Scan a QR code** and **Create a community**, both *Coming soon*, are stacked
at the bottom. An empty or failed list shows the page without rows. No invite
list is shown; nothing serves pending invites yet. In development,
[`BUZZ_DEV_FIRST_RUN_ACCOUNT`](configuration.md#first-run-account-seed-development)
answers the two account reads, and fakes the link, the unlink and the backup,
in place of kgoose and the native uploader.

The URL field is live. A typed address may omit its scheme (`relay.example.com`
is read as `wss://relay.example.com`); `wss://` and `https://` are accepted in
any case, while `ws://`/`http://`, credentials, paths, queries and fragments are
not (`enteredRelayOrigin` in `src/features/communities/destination.ts`).
**Continue** stays enabled while the field is empty or invalid; Continue or
Enter submits, and an empty or invalid address shows *Please enter a valid
community URL* under the field. Continue only starts the lookup; the join itself
is the Join Community page's **Join**. The field also takes an invite link: the
relay's `https://<host>/invite/<code>` page, or the `buzz://join?relay=…&code=…`
link that page opens (`parsePastedInvite` in
`src/features/communities/invite-link.ts`). The community is looked up at the
link's origin exactly as for a typed address, and nothing is sent with the code
until Join claims it; a link given on the welcome screen keeps its code through
sign-in and setup.

Join opens **Finding community** (`src/features/communities/FindCommunity.tsx`,
reusable by later flows): the hostname and **Cancel** at once, with a "Looking
up {host}…" status only after one second (the shared `LoadingRegion`, as for
any initial read; Retry starts the second again). **Cancel** returns to Join a
community with the typed address intact — however the user arrived there — and
discards any late answer. The page reads the relay's NIP-11
document and `/api/join-policy` in parallel through the identity-free native
`relay_http` GET path. Those two unauthenticated GETs are the only pre-join
traffic: nothing is signed with the device's key until the user chooses to join.
On success it shows **Join Community**: only what the relay publishes — the
icon if set and the hostname — plus, when the deployment has a join policy,
*I confirm that I am at least 18 years old.* (if age attestation is required) and
*I agree to this community’s Terms of Service and Privacy Notice.*, whose links
open the relay's `/api/join-policy/terms` and `/privacy` pages outside the app. No
name, description, member count, owner or invite badge is shown: none is knowable
before joining. **Join** sits to the right of **Cancel**, as in every dialog
footer, and is always labelled Join: shown consent boxes gate it, they do not
rename it. Lookup failures are classified, not echoed: an unreachable relay or an
unusable policy answer offers **Cancel** and **Retry** (a missing policy counts as
"none" only once NIP-11 confirmed a Buzz relay); a non-Buzz address or a Buzz
relay with no community bound to that host offers **Cancel** only.

**Join** is the same join the rail's Add-a-community dialog performs, through
the same owner (`admitCommunity` and `completeJoin` in
`src/features/communities/join.ts`, which save through `communities.joined` in
`src/features/communities/service.ts`; [communities](communities.md)). Before
anything is sent, the join is recorded on this device for the key (the join
journal, `join-journal.ts`), so a reply lost between the relay and the app —
a claim the relay honoured but the app never heard — is not claimed again: a
later Join for a recorded community first sends the signed profile read, and
only when that still denies the key does it claim. A device that cannot keep
the record stops there with the journal's storage message and sends nothing.
When the address came with an invite code, Join
claims it as the dialog does: if the deployment has a join policy, the
policy is accepted for that code with its version and the age box
(`/api/invites/accept-policy`), then the claim (`/api/invites/claim`) carries the
returned receipt; both are NIP-98-signed by the key, and the relay must answer
that the key joined or already was a member. Then, with or without a code, a
signed profile read (`inspectProfile`: NIP-11 again, then a NIP-98-signed
`POST /query` for the key's own kind 0) proves the relay admits this key. The
membership — the canonical origin as id, the hostname as name, the NIP-11
icon if set — is saved to this device and selected, and the gate lifts into the
app on that community; when **Set up your profile** follows (below), the
membership is saved after that step, as in the dialog, so nothing is joined
while it stands. After a Builderlab sign-in the destination is also saved
to the account straight away (`POST /api/goose/v1/buzz/known-communities/add`
with its `wss://host[:port]` address, same portal and credential as the account
reads), so the user's other devices restore it; the app waits for that answer,
but a failed save never stops it opening. A key imported from **Connect to
{host}** has no account, so nothing is saved there. Restored destinations are
not saved again, and joins in the in-app dialog reach the account through the
sync instead ([known communities](communities.md#known-communities)). While the
join is in flight the page shows *Joining…* with Join and Cancel disabled. The
join itself publishes nothing: no kind 0, and no policy receipt or invite claim
without a code. Without a code the ticked boxes are the client's record of
consent, as on the dialog's code-less path.

A relay that requires an invite answers the read with 401/403, shown as **This
community needs an invite**; a claim the relay refuses (an expired, used-up or
invalid code, or a policy that changed) lands on the same page with the dialog's
refusal copy under the code field, and no read is sent. The page offers an
**Invite code** field with **Join**, which runs the same policy acceptance (under
the consent the first Join gave), claim and read for the typed code; a refusal
shows under the field and keeps the page and the typed code, and a code the
native route will not send (anything but letters, digits, `.`, `_` and `-`)
reads as not valid. Admins also admit people by npub, so the page shows the
user's public key as the full npub (never hex or an abbreviation) under *Your
public key (npub)* with **Copy** and an inline copied/could-not-copy status,
plus the note that it is their public identity and safe to share. **Try again**
repeats the join without a code, so an admin's add takes effect without
retyping the address; **Back** returns to the find page (the typed address
stays in the URL field behind it). A relay that cannot be reached — for the
claim or the read — shows the lookup's unreachable copy; a device that will
not keep the join's record shows the journal's storage message. Both offer
**Back**. An existing relay profile seeds the empty local default.

When no profile exists anywhere — the relay held no kind 0 for the key and the
device's local default has no name (read before the join, since `joined` adopts
a relay profile into an empty default) — the gate stays up for **Set up your
profile** (`src/features/identity/ProfileStep.tsx`): the shared profile
fields — avatar, required display name, optional description — prefilled with
the local part of the Builderlab email as the name (blank when the key was
imported without a Builderlab sign-in). The same rule applies after
*Restoring your communities*: if none of the admitted destinations held a
profile and the local default has none, the step is shown for the selected
one, and a handed-off address opens in the dialog only after it, so the
dialog's own profile step starts from the name given here. A relay that
already holds the key's profile, or a local default with a name, skips the
step. **Continue** is the dialog's profile step (`completeJoin`): the draft is
recorded in the join journal, the profile is read afresh, the kind 0 is
published to that one relay through the same signed `relay_sign` +
`POST /events` route Settings → Profile uses when the draft differs from what
the relay holds, and it is read back; only a readback that is current saves the
membership (and the result as the device's local default for later joins) and
enters the app on the community. A rejected publish, or a readback the relay
has since superseded, stays on the step with the error inline and the draft
intact. **Skip for now** saves the membership alone, publishes nothing, and
enters the app; Settings → Profile remains the
editor. Denied/unavailable/corrupt storage is not first run: like the page
shown while the saved identity opens, it is titled **Your Buzz identity**, and
it keeps the **Retry secure storage access** path.

The key setup screen (`IdentitySetup`) is no longer shown on first launch; the
fixture below still renders it. It offers **Create a new identity** or **Use an
existing key**. These are alternatives. It can also offer **Continue with your
Buzz identity** when old Buzz is installed and **Restore from backup** in builds
with backup recovery configured; both are described below. Import accepts an
nsec, validates its checksum and secp256k1 scalar, and persists that exact key
before adopting its public identity. It never generates a replacement after an
import, read or write failure.

One native owner keeps the key in memory after successful restore. The new
create-only secure-storage item is service `xyz.block.buzz.desktop.identity` in release
builds, or `xyz.block.buzz.desktop.identity.debug` with Rust debug assertions,
account `human`. Debug worktrees share the debug item, not the release identity;
ports and frontend dev mode do not isolate it. macOS keeps its existing default
file Keychain/security-framework implementation. Windows uses Credential Manager;
Linux uses Secret Service through keyring 3.6.3, as old Buzz does. Linux requires
a running desktop Secret Service with a default collection (for example GNOME
Keyring), reachable on the user's session D-Bus. Missing, inaccessible or ambiguous
storage fails closed: unlock/configure the store and explicitly retry.

Human storage does not use or change agent credentials or old Buzz's
`buzz-desktop/secrets` blob. A competing item refuses overwrite. Windows/Linux
creates and agent deletes share a per-user, service/account file lock under the
OS account's home `.buzz-foundation/credential-locks`, independent of HOME/XDG,
profile and worktree overrides. Lock files are empty, retained, and never hold keys;
a busy lock reports a retryable error rather than waiting behind another process's
consent dialog. Locks serialize cooperating Buzz instances, not arbitrary other
programs or other machines. Windows credentials use keyring's enterprise persistence
and may roam under Windows policy; locks do not coordinate machines.
Neither Windows Credential Manager nor Secret Service supplies per-app access
isolation from other programs running as the same OS user.

There is no file/environment fallback, automatic legacy migration or human key
replacement. When installed old Buzz's data folder (`xyz.block.buzz.app`) exists,
setup also offers **Continue with your Buzz identity**. Only that click reads old
Buzz's `buzz-desktop`/`secrets` item, so any OS access prompt follows it; the
offer itself checks only the folder. It takes the item's `identity` entry and
saves it exactly as a pasted import would: validated, create-only, never over a
saved key, and never writing the old item. The offer returns after Sign out while
old Buzz's data remains. The human key is deleted from this device only by
[Sign out of Buzz](#sign-out-of-buzz); no other command or plugin service can
delete it. Agents' bring-over (`app_agent_port`) may read only the selected
old Buzz service/account and copy the selected agent key into this app's separate
agent namespace; it never writes the old blob.
No user key belongs in release configuration.

## Local restore helper on macOS

macOS builds with Rust debug assertions accept `BUZZ_DEV_CREDENTIAL_HELPER` as an
absolute executable path. When set, only `read_human()` uses this helper.
The helper replaces both the normal read and the copy from the previous service.
Its setup must select the intended saved identity, including its service name.
Exit 10 declares that identity absent; it does not start a Keychain migration.
Release builds ignore it. With no setting, the normal Keychain read is unchanged.
Import, creation, deletion, agent keys, and session records keep their own owners.

The helper receives a fresh Unix socket as stdout and no stdin. It must return
exactly 63 bytes of nsec text with no newline, then close stdout and exit zero.
The native identity owner still validates the nsec checksum and scalar. Exit 10
means absent, 11 means denied, and 12 means corrupt. Other failures stop restore.
Only absence permits identity creation. The app clears the returned buffer when
its owner releases it. It does not log helper output or stderr.

Normal reads have a five-second limit. For first approval only, set
`BUZZ_DEV_CREDENTIAL_HELPER_AUTHORIZE=1`. This passes `--authorize` and allows
two minutes. Remove that setting after approval. A failed helper never triggers
a second credential read.

The helper is trusted local code. Keep its setup and signing keys outside this
repository. It must read only the exact debug human item in the default Keychain
and disable Keychain dialogs during normal reads. Before it sends a key, it must
verify the socket peer's audit token, parent PID, and live code signature against
the configured app identifier and certificate. A PID check alone is insufficient.
Reject pipes and sockets created before exec. Sign both processes with hardened
runtime and without entitlements that allow code injection. These access controls
need native tests; the app hook does not supply them.

The certificate check trusts access to its signing key. Another program that can
use that key and app identifier can satisfy the same requirement. Approval to use
the signing key across rebuilds therefore extends trust to those programs.

## Automatic backup and optional recovery

Desktop builds configured with `BUZZ_NSEC_BACKUP_SERVICE_URL` and
`BUZZ_NSEC_BACKUP_NAMESPACE` back up a local identity only after an explicit saved
automatic-backup choice, Builderlab or Hosted communities login, and matching key
binding. Unset, self-managed, corrupt or mismatched consent prevents all backup
requests, including retries. These are paired
native build-process inputs; unset leaves the feature disabled. The service URL
includes its API prefix and must use HTTPS. Existing login credentials are accepted
only for the matching trusted build origin. Without a qualifying login, backup
defers without opening a browser or delaying identity readiness.

The native host validates enrollment and seals with the reviewed HPKE v1 protocol.
Only encrypted pending bytes and public completion metadata are saved in the OS
account's `.buzz-foundation/nsec-backups/<human credential service>` folder, scoped
separately for debug and release. A shared lock serializes cooperating
copies. Pending bytes and IDs survive restart; later login/binding/key-install
events retry them, including a coalesced follow-up when an event arrives during an
active pass. Upload success requires a matching stored receipt. Backup
failure never replaces or deletes the local identity.

The main WebView can observe the uploader through `identity.backup`, which
registers on first read and stays out of identity snapshots. Its status says
whether Builderlab backup can run in this build and whether the latest pass is
idle, running, complete, waiting for consent, a session or a key binding, or
failed with a named kind; no service response body reaches the renderer. A login
handoff or retry resolves to the number of the pass it starts, or to none, so a
caller can wait for that pass's own outcome. A pass superseded by a key install
reports nothing; reloading the window mid-pass reports idle.

First run's **Backing up your key** is a pass of this uploader. It saves the
automatic choice for the key, hands the first-run Builderlab sign-in to the
uploader, waits up to 60 seconds for the pass that handoff starts, and then
hands the sign-in back, whatever the outcome; an earlier pass's result never
answers it. A pass that stops to wait for consent, a session or a key binding
fails the step, since nothing would wake it again before first run ends. The
failed page names the reason without any service response. The automatic choice
stays on after a failure, Continue without backup included, so a later
Builderlab sign-in may still finish the backup the user asked for. The step
hands a sign-in over only when this build's uploader can back up to Builderlab
and the user signed in at the build's own portal: a tenant's sign-in is never
handed to the uploader. Anywhere else, which today is every tenant sign-in and
every build without backup configured, the step fails at once as *Key backup
isn’t available in this version of Buzz.* without saving the choice, and the
user continues without backup.

**Settings → Identity** shows the uploader's latest status as a read-only **Key
backup** row, by the same rule: the row appears only when this build's uploader
can back up to Builderlab and a Builderlab sign-in would be at the build's own
portal, as the Settings one is. It uses first run's failure wording, except
that a failure first run's Try again could clear, and a lapsed sign-in, say
instead that Buzz tries again the next time the user signs in to Builderlab,
since a new sign-in hands the uploader a session and starts another pass. Idle is what a fresh launch or
a window reload reports, not evidence that no backup exists. The row has no
consent or retry control.

When secure storage confirms absence, native recovery commands support explicit
browser sign-in. The session and recovered keys remain native; the renderer sees
only validated public identities and attempt-scoped handles. Recovery prefers the
account's current associated identity. A previous identity requires explicit
selection and does not change the account association. Failed mapping requests,
unavailable endpoints, an account refused recovery (outside a private
organization), failed backups and an empty successful result remain distinct.
Installation uses the existing create-only secure store; cancel, reload, signout
or a competing create/import prevents stale installation.
Remembering recovered completion is best effort; retry-file failure does not block
secure-store installation. Pending uploads still require durable ciphertext before sending.
Plain signout retains backup records; Sign out and erase removes this credential
service's records through the existing resumable wipe before clearing its marker.

Rollout requires the backend backup/recovery endpoints, private-organization
authorization, database migration, and configured KMS recipient/permissions. The
client inputs must match that service's namespace. Synthetic HTTP/storage tests
do not establish live sign-in, KMS or installed-app
secure-storage acceptance. No backend provisioning or activation is part of this change.

Identity setup offers Restore when secure storage confirms that no local key is present.
The existing restore UI presents the current identity and explicit previous-identity
selection. Restoring a key does not enable automatic backup or change its saved
consent; no consent selection UI is added in this stack.

A shared credential blob can reduce repeated OS prompts by caching many credentials
after one read. For this one human key, one cached item retains that read-once benefit without
coupling human writes to agent credentials or old-app blob writers. This is not a
claim that per-secret storage is always superior or that prompts are eliminated.
Consent, app signing and update behavior require attended native verification.

## UI and sensitive data

Settings exposes Profile in Personal space as well as in a selected community.
Identity details are separate under **Buzz → Identity**, so they remain available
if the community profile cannot load. The full npub and hex public key can be
copied. The nsec is absent from the rendered field until Reveal; Copy can fetch it without revealing it. Hide, leaving Identity,
window blur and document hiding retire pending reveals and clear the displayed
secret. Failed private-key actions report fixed errors. Copy deliberately leaves
the key on the OS clipboard; the UI warns about that. The one exception is the
first-run **Enter your private key** page: the typed, pasted or file-read nsec
lives only in that page's state, masked until **Reveal private key**, and
crosses IPC once, on **Continue with this key**, through `identity_import`; leaving the page
discards it, and nothing logs or persists it. On the returning-user lane the
page compares the typed key's derived npub with the account's linked npub in
the page, before IPC, so a mismatched nsec never reaches native import. The
**Welcome back** page shows the linked public key and the signed-in email; the first-run
Builderlab session credential is held by the OAuth session store and sent only
in the two account reads' `X-BB-Session-Credential` header, never rendered.

The app UI passes a private string through IPC only during explicit import/export
interaction. JavaScript/IPC string memory is not guaranteed zeroized. Native
key bytes and temporary storage buffers use zeroizing owners, but this is not a
claim that every framework allocation is wiped. No secret is put in public
snapshots, plugin service registrations, localStorage, logs or relay events.
The main app and its same-origin plugins are trusted, not isolated security
principals; plugin JavaScript can invoke `identity_export` directly. Not registering
a plugin key service is an API ownership choice, not a sandbox. The main-webview
command permission is not proof of a human gesture.

## Sign out of Buzz

Settings → Buzz → Identity → **Sign out of Buzz** removes the private key from this
device only; the npub and its history stay on relays. The dialog presents two
layers: the key always goes, and settings, agents and other Buzz data stay unless
the user erases them. It embeds the private-key controls above. Confirm stays
disabled until the user reveals or copies the key and ticks "I have my key".
**Also erase everything else Buzz stores on this device** (internally, wipe)
requires typing `erase all my data`; **Also remove my agents** appears only with
it; the button then reads **Sign out and erase**. Wipe clears
this app's data, local data, WebView storage, caches and plugin storage. It cannot
reach the clipboard, exported keys or relay data, and the dialog says so. Sign out
is unavailable with the development broker (`BUZZ_DEV_VIEWER`). Development
builds can sign out but not wipe: they have their own human key, but share agent
keys with the installed app, so the native command refuses
wipe. The dialog asks the native side (`sign_out_wipe_refusal`) whether wipe is
available and, when it isn't, disables wipe up front with the reason; this holds
for any Rust debug build, including a debug bundle with a production frontend. A development-build sign-out signs out every
development build, which share the debug key, and leaves the installed app
signed in. Wipe is unavailable while
`BUZZODZ_HOME` moves plugin storage out of app data.

Every running instance, debug or release under any identifier, holds two locks
shared in the user data folder (created first if a first launch finds none)
before it looks for a pending sign-out:

- a **key lock** named for its human key store (`.<service>.instance.lock`), shared
  by every copy using that key whatever its identifier. Like the sign-out marker,
  record and backup folder, it keeps the store's service from before 1.0
  (`dev.local.buzz.foundation.identity`), so files older builds wrote are still
  found; and
- the **all-Buzz lock** (`.dev.local.buzz.foundation.instance.lock`), named for
  the storage all builds share (the default plugin folder and the agent key
  service), not for the app identifier. It keeps the identifier Buzz used before
  1.0, so those builds and later ones exclude each other.

Before 1.0, Buzz's identifier was `dev.local.buzz.foundation`. Before taking these
locks, a launch as `xyz.block.buzz.desktop` renames what the old identifier names:
app data (with plugin storage), config, local data, caches, macOS WebKit storage,
their sign-out trash and a pending sign-out marker, so the update keeps
everything and finishes a sign-out the old build committed. It takes the all-Buzz
lock alone and waits for every agent ownership lock, so it never moves storage
another copy or a stopping agent still uses. If any legacy path sits beside its
new-identifier counterpart, after a rollback for instance, the launch moves
nothing, finishes no pending sign-out, and exits naming every such pair; neither copy
is safely the one to keep, and an erase would miss the legacy one. A failure exits
with a native alert, and the next launch moves what is left. Development launches
(`just desktop`, `just desktop-bundle`) use `xyz.block.buzz.desktop.dev`, so they
keep their own app data and plugin storage and never take or block the installed
app's. The first one copies the installed app's app data (without the release-only
`archive`), config, local data and macOS WebKit storage, each from
`xyz.block.buzz.desktop`, else `dev.local.buzz.foundation`, under the same locks,
so the installed app must be closed once, and takes a pending development
sign-out marker. It refuses while the installed app has a sign-out pending, so it
never copies storage being erased. A linked folder copies what it links to; links
inside are left out, so the copy shares nothing with the installed app's storage,
which stays in place. Copied folders keep who else may read them, but stay
writable by their owner. An interrupted copy finishes at the next launch.

Keys were saved under `dev.local.buzz.foundation.*` services before 1.0; they
now live under `xyz.block.buzz.desktop.*`: the human key (`.identity[.debug]`),
the agent keys (`.agents`, shared by release and development) and the TypeSafe
key (`.jev-key[.debug]`). A read looks under the new name first. Only when the
key is absent there does it look under the old name and copy what it finds,
create-only, then return the key saved under the new name. The copy holds the
old item's interprocess lock, which deleting the old item takes too, so a delete
in another Buzz can't land between its read and write. A key already there
stays, even if it differs. On macOS an agent key is looked for in the new
bundle, then its own new item, then the old bundle, then its own old item, all
under the bundle lock older builds take too. The old items stay, so an older
build still finds them. Any failure is an error for that key only, never
absence. Writes touch only the new names. Every deletion (Sign out, deleting
an agent, an erase, clearing the TypeSafe key) removes the old item before the
new one, and on macOS the agent's entry from the old bundle, so a read never
copies back a deleted key. On macOS each deletion reads again to confirm the
item is gone. Deleting an agent fails, keeping every copy, while the old bundle
is malformed.

Older builds sign out by deleting the human key under the old name only. A
record in the user data folder (`.<service>.sign-outs-seen`, next to the
finished record) keeps the count of finished sign-outs the last launch saw.
After any pending sign-out finishes, a launch that finds the count grew deletes
the human key under the new name too; the first launch only starts the count.
It decides holding the record's lock file alone, so a copy launching at the
same time sees the count this one recorded and never deletes a key saved since.
If the deletion fails, it records nothing and exits. The count is replaced by
a synced rename, and on macOS and Linux every launch syncs its folder before
any key is saved, so a power loss can't bring back a lower count and delete a
newer key. Windows has no folder sync, as for the app's other atomic writes: a
power loss right after a launch recorded a new count can lose the rename, and
the next launch then deletes a key saved in that window. Older builds record a
finished sign-out with an unsynced append on every OS, so a power loss then can
keep the deletion but lose the count, and the signed-out key under the new name
stays. Older builds' other
deletions aren't counted: after an older build erases agents or clears the
TypeSafe key, their copies under the new names stay. On macOS, Keychain may ask once to
allow the renamed app to use each saved item.

A sign-out needs its key lock alone, so every other copy using that key must be
closed. A wipe also needs the all-Buzz lock alone, so every other Buzz must be
closed. A development-build sign-out therefore needs only other development
worktrees closed, not the installed app, and the installed app's plain sign-out
doesn't need development builds closed. Locks are taken key first, then
all-Buzz, released in reverse, and never waited for while one is held alone.
Whenever an instance takes its locks shared again (after finishing a pending
sign-out, or after a refused sign-out), it looks for the marker again: at launch
a new marker is finished in turn; in a running instance it means another process
committed a sign-out, and Buzz exits natively (see below). A running instance
also exits if the sign-out record (`.<service>.sign-outs-finished`, kept forever
and shared by every identifier using the key) changed since launch: another
process finished a sign-out of its key while it let go. Retaking them
shared is bounded too; on timeout, or if a lock can't be let go, Buzz exits the
same way. These locks
coordinate running Buzz 1.0 app copies only: `buzzodz plugin sign` reads the
human key without them, under the new name else the old, and never copies it,
so Keychain items stay the app's; older Buzz versions don't take them, so close those
before signing out. The native
`sign_out` command deletes nothing: it admits one sign-out per instance, refuses
unless it can hold the locks it needs alone, writes a marker beside (not inside)
app data recording the wipe and agent choices, and restarts; agent processes
stop as they do on Quit. The marker is named for the exact human key store
(debug or release), so another build never acts on it. If the marker can't be
written nothing has changed; if a later step fails, Buzz exits natively, and the
next launch finishes the sign-out.

Once the marker is written, and before any native exit, the native signer is
closed for the rest of the process: the cached key is dropped, and every key
operation (signing, agent authorization, export, restore, import or create)
refuses when it runs, including calls that started before it closed. Pairing
closes in the same close step: the live attempt is cancelled before it can publish a
payload it already prepared, and no new attempt starts. Work admitted before
the close isn't recalled: a payload admitted before pairing closes may still be
sent or delivered (an outcome not yet known is reported as uncertain), and signatures and agent authorizations
already issued remain valid. A native exit runs the same best-effort teardown as Quit, then shows a native
alert and exits however that went; the dialog never offers a retry or Cancel
once this instance's locks or agents are in an unknown state. Agents don't
outlive Buzz: each runs under a supervisor that stops it when Buzz's socket
closes, holding that agent's ownership lock (`dev.local.buzz.agent-ownership`
in the user data folder) until it has stopped. A supervisor that can't stop its
agent keeps the lock.

A launch that finds the marker takes its key lock alone, and for a wipe the
all-Buzz lock too, waiting briefly for the exiting instance, then reads the
marker once more and runs only choices those locks cover: if it has meanwhile
become a wipe, the launch lets go and starts over to take every lock. Before a
wipe, it tries every agent ownership lock; if any is still held, it removes
nothing and exits with a native alert that an agent is still stopping, so a
later launch retries. A plain sign-out skips this: it removes only the human
key, and the ownership folder is shared with every Buzz, so another copy's
running agents would block it. A marker
that can't be read or parsed fails closed. It finishes before any window,
webview storage, service or identity read:

1. With remove agents, every agent's locally stored key is deleted, read from
   the agent registry, which stays in place until all are gone. That includes
   imported deployed-remote agents, whose import kept a local copy; the remote
   deployment itself is not stopped or deleted.
2. With wipe, app data, local data, WebView storage and caches are renamed
   aside. App data's agent folder (`agent-controller`) is put back unless agents
   were removed.
3. The human item is deleted and a fresh read must find it absent.
4. The renamed folders and anything recreated in place are deleted, then the
   sign-out record advances, then the marker is removed. Kept agents keep only
   what they need to be identified and start again: the agent list with their
   settings (`agents.json`), the shared agent defaults (`defaults.json`),
   including any API keys entered in their settings, and their keys in the
   keychain. Everything else in `agent-controller`, including saved Databricks
   logins, logs and anything added there later, is deleted; a kept Databricks
   agent must sign in again. The dialog says both.

Every step is safe to repeat: deleting an absent key succeeds, and an agent
registry confirmed absent means its keys are already gone; failing to check it
stops before anything moves. The wipe never acts through a link at Buzz's own
folders: every wiped folder, its `.sign-out-trash` sibling, the kept
`agent-controller` in both, and the agent list when agents are removed must be a
real folder or absent. This is checked before the marker is written, before
anything moves, and again right before every move, rollback and delete. The OS
storage folders above them (`Application Support`, `Caches`, `~/Library/WebKit`)
are trusted as the app already trusts them, so if one is a link the wipe removes
only Buzz's folder under it. The wipe is not designed to resist another program
swapping folders while it runs. Every other presence check in the wipe is fallible
too: one that can't look fails the attempt, keeping the marker. If renaming or the key delete fails, the renames are rolled back. On any failure
the marker is kept and Buzz shows a native error and exits without opening a
window, so nothing recreates wiped storage and the next launch retries. Without
wipe, local data stays: it is already scoped by public key, so signing back in
with the same key finds it. Builderlab and hosted-community logins live only in
memory and end with the restart. Kept agents start only while the signed-in key
matches the owner in their saved attestation, checked before their key is read.

## Automatic backup consent hooks

The native identity service exposes `getBackupChoice()` and
`setBackupChoice(pubkey, automatic)`. These APIs expose public metadata and do not
change identity readiness. Reading a choice does not contact a server; saving
automatic backup wakes the existing native uploader if a session is connected.
First run's selections are **Create my key**, **Start over with a new key** and,
for an imported key, **Back it up**: each page discloses that Block can restore
the key (an imported one including anywhere else it is used) before **Backing
up your key** saves `automatic: true`. Account sign-in, the key setup screen,
an import without Builderlab sign-in and **Not now** do not imply consent, and Settings has no
selection.

The choice is bound to the current public key and trusted build-configured backup
service and namespace. Missing or mismatched metadata returns no choice;
unreadable metadata fails closed. An unavailable build rejects choice writes.
Debug and release use their existing separate key-custody namespaces. Only the
main WebView can read or save the choice.
Plain sign-out retains the choice; sign-out and erase removes it through the
existing resumable wipe, without erasing the other key-custody namespace.

The native uploader consumes `nsec_backup_choice::read` before any
backup request and retain its returned value through the upload. Its shared file
lease prevents a successful choice change from racing an admitted upload across
app copies. Saving a choice reports busy while such a lease is held. Disabling
automatic backup governs future uploads and does not delete existing backups.
The consent hooks are the base of the draft stack:
#1137 consent hooks → #1106 gated uploader → #1107 recovery → #1101 restore UI.

## Packaged connection

A public native viewer hydrates the existing public-key-scoped local profile and
memberships. On macOS, Windows and Linux, app composition supplies the shared
native relay adapter after identity restoration. Windows/Linux installed-app
transport acceptance remains unverified. Only the selected saved community opens on restart; Personal
space stays disconnected. Discovery failure leaves the community retryable.
Native sessions do **not** fall through to the dev broker signer.

The native identity owner signs event templates and authenticates HTTP with
NIP-98, including the exact request URL, method, a body hash on POST and a fresh nonce
for each attempt. Native networking permits only discovery, join-policy, invite
mint/acceptance/claim, relay-advertised GIF search, query, event and bounded
workflow run-history routes on HTTPS origins, with bounded bodies, timeouts and
no redirects. JavaScript never obtains the private key for transport. NIP-11
`self` establishes relay authority; the operator-contact `pubkey` is not a
substitute. The existing live owner handles WSS/NIP-42 authentication and
signature verification. IPC permissions remain limited to the main WebView.

Relay staff console requests (`relay_admin_*`) use a separate native owner.
The admin origin comes only from the selected relay's NIP-11 `admin_api` and
must be a public HTTPS host. Every probe, read, write, attachment fetch and
retry resolves that host, refuses the request if any answer is loopback,
private, link-local or otherwise reserved (or if DNS fails or returns nothing),
and connects only to the vetted addresses while keeping the hostname for TLS
and NIP-98. That client ignores system proxies and follows no redirects. The
webview names a closed route; native code builds the URL, checks the request's
expected relay, admin origin and signer before signing, and caps each response.

When there is a selected identity and relay and the relay advertises a valid
admin host, opening Settings sends one signed role check (`probe`, `GET
/api/admin/v1/probe`, empty body) to that host without a further click, so the
Moderation entries show only to staff (a relay with admin auth off shows its
read-only entries to everyone). Every member who opens Settings sends it, not
only staff, because only the answer says who is staff. It goes to whatever
admin host the relay advertises, which can differ from the community's
connection host and need not share its domain. That host learns the active
public key, the client's IP address and that Settings was opened; no private
key, login token or community data is sent. The NIP-98 signature is bound to
that URL, method and body and carries a timestamp, so it can't be used for any
other request, and a conforming server rejects it after a short window (this
relay allows ±60 seconds); the recipient can still keep it. A relay that names
another deployment's real admin host lets that deployment's staff see and act
on that deployment from inside the wrong relay's Settings, subject to that
deployment's permissions; the relay that named it receives none of that
traffic. The practical risk is confusion about which deployment is being
administered, and each console screen names the admin host in its subtitle,
which limits it. This is accepted because the user already trusts the relay to
name its admin host, and sending that host the key, the IP address and when
Settings was opened is part of that trust. It repeats each time Settings
opens, re-reading the advertised admin host first, and each newly selected
identity or relay is checked once while Settings stays open. Other re-checks
(a 401 or 403, Check again, changing your own staff entry) are listed in
[relay-staff.md](relay-staff.md); none starts after Settings closes.

Channel lifecycle/details and identity archive commands, channel recipe preparation/decoding,
and opening direct messages use purpose-bound native commands. Creation kind 9007 is
advertised only when NIP-11 reports NIP-29 support. NIP-44 stays in the native
identity owner; recipe plaintext is never returned by a generic decrypt command.

Community admission, kind-0 profile reads/publication, the NIP-43 leave request
(kind 28936, signed only in its empty protected shape) and the adapter's advertised
message/event writes use this identity. [Join recovery](communities.md#packaged-admission-and-recovery)
records public progress before remote changes. The existing durable outbox retains
uncertain delivery across restart; retry uses the same signed event with fresh HTTP
authentication. Events older than 15 minutes get a strong ID readback instead of
being republished or silently re-dated. Missing/failed readback retains uncertainty;
the user must inspect the conversation before explicitly sending a new message.

Protected media and uploads are native, because the webview cannot attach Blossom
(kind 24242) authentication itself: `<img>`, `<video>` and `<audio>` send no custom
headers, and the CSP keeps `connect-src` closed to general HTTPS. Relay `/media/`
URLs selected by shared TypeScript render through the `buzz-media` URI scheme;
`<video>` and `<audio>` instead load the same URLs from a native listener on
`127.0.0.1`, since WebKitGTK cannot play a custom scheme. It authorizes each
request by a random per-launch path token given only to the main window, the
bound `Host` and the app's `Origin`, and serves one request per connection.
Both validate HTTPS and the `/media/<hash>` URL shape but do not enforce
saved-community membership; the selected server receives a short-lived token
scoped to its origin. The scheme signs a fresh 60-second `get` token per request
and forwards only a bounded single `Range`; non-image/video/audio types (and SVG)
are served with download disposition and `nosniff`. The main webview does not navigate to protected media for downloads: a narrowly scoped native command authenticates the bounded media GET, saves to the OS Downloads directory without replacing existing files, and rejects unsafe filenames. `relay_upload`
hashes, signs (`upload` + `x`) and sends the exact bytes JavaScript passes it;
shared TypeScript (`hostUpload`) owns limits, error mapping and descriptor
validation. JavaScript never signs kind 24242. Packaged HEIC and video
preparation uses fixed demuxers and ffmpeg arguments in the native host, then
hashes and uploads only the converted bytes; JavaScript receives the descriptor,
not the prepared file. ffmpeg must be installed on the computer.
Community member changes (NIP-43 kinds 9030–9032) are signed in the host only
in the exact add/remove/role shape; the relay decides authority. Repository HTTP
and other broker-only helpers are not claimed by this adapter. NIP-FI assertion
acquisition is not implemented, so deployments enforcing it are outside acceptance.
Windows/Linux custody, credential migration and release-signing acceptance remain
separate limitations.

Development with a public `BUZZ_DEV_VIEWER` pin enables the legacy broker
(Vite derives `VITE_BUZZ_LIVE=1`), even inside `just desktop`, and does not offer
native private-key controls. `just desktop` passes Vite's effective public pin
(including an explicitly empty shell override) to the native app. The public pin
alone is not authorization. Packaged builds always use native identity, ignoring
the pin. This reuses the broker's trusted-local-process boundary; it does not copy
keys or introduce another signing protocol.

Without the pin, supported desktop development uses
the native identity path; see the [host-mode matrix](contributing.md#shared-logic-and-host-boundaries). Creating/importing the
new native item does not update that old blob. Future reset/rotation would not
synchronize copies automatically; neither operation is in this scope. Sign out
does not touch that old blob.

## Try the UI without credentials

Use the existing environment-free fixture Vite config:

```sh
bin/pnpm exec vite --config tests/fixtures/agent-control.vite.mjs --port 1547
```

Open `/tests/fixtures/identity.html`. It renders the key import/create screen
(not the first-launch welcome) with mock IPC and an in-memory public
fixture key, not an OS credential store or a relay. Import accepts only the
displayed fixture key. Reset and simulated restart affect fixture state only. **Never enter a real
nsec.** Browser exercises prove UI behavior, not secure native persistence.

Before real-key use or a usable-release claim: independent custody review,
isolated native consent/denial/import/create/restart checks, human UI feedback,
and installed-app live read/send/receipt/restart acceptance are still required.
Do not launch/restart someone's desktop app or inspect their credentials to test.

### Windows/Linux native acceptance (not established by the fixture)

Use a disposable **OS account/VM**, not a profile, port or HOME override: credentials
are per OS user. Use only throwaway keys, keep old Buzz closed for import handover,
and do not connect that identity to a real community for this storage check.

- On Windows and Linux with a working Secret Service/default collection, create
  or import, export the throwaway key, quit/relaunch, and confirm the same public
  identity and export. Repeat separately for debug and release builds.
- With an existing Linux key locked, dismiss the unlock request. Expect a storage
  error/retry, not first-run create/import choices; unlock and retry to restore.
  Without Secret Service, expect an error rather than key generation/fallback.
- Where two development instances can run, an occupied human/agent item must not
  be overwritten. Lock contention must be retryable; after exit, locks release.

Deferred until agent import is reachable from the UI on Windows/Linux:
explicitly import a throwaway old-Buzz agent, restart and verify the exact key,
then delete only the destination agent and verify the old source remains. This is
not a reachable UI acceptance step for this storage slice and does not establish
Windows execution.

Attended Windows/Linux execution and human confirmation are release gates, not
claims made by cross-compilation, fake-store tests, or the browser fixture.
