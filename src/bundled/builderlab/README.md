# Builderlab

Create agents that Builderlab hosts for you, so they keep working even when Buzz is closed.

## Getting started

1. Go to **Settings → Plugins → Builderlab agents** and choose **Sign in with Builderlab**.
2. In **Agents**, choose **New agent** and pick **Builderlab (hosted)** as the **Harness**.
3. Choose a model and reasoning effort, optionally add instructions, then create the agent.
4. Edit instructions later in **Identity**, and model settings in **Settings**.

---

# Builderlab

## Apps pilot

Local agents can create, deploy, inspect readiness, share and open Apps Platform
apps using the Settings Builderlab sign-in. `apps_contract` reports the selected
tenant's runtimes and schema location. Creation checks that contract and supports
`static` and `fetch-js`; it repeats the selected runtime through reservation and
initialization. The executable profile returns the required asset manifest and
bindings, even when its handler serves all content itself.

BBBlock is the employee pilot. BBPublic uses the same authenticated control-plane
boundary: the server must grant Builderlab access to the current workspace/account.
Existing workspace early-preview enablement can provide that access; these tools
do not enable a workspace or bypass its policy. A denied request preserves the
server's permission error. Check the contract before choosing a profile because
BBPublic need not support static hosting.

After an accepted deployment, readiness errors preserve its app, version,
deployment and rollout IDs. `apps_status` checks those exact IDs without uploading
again. A failed reservation or initialization names the planned app ID; inspect or
resume that app before creating another one. Automatic reservation recovery and
hosted tool declarations are separate work.

The app panel uses the existing native browser and persistent website store on
macOS 14+. Website login is separate from Settings login, including sign-out and
account switching. Confirm the website account when testing. Earlier macOS uses a
private store; other platforms do not expose the embedded app panel. CLI-to-site
SSO is a separate integration.

## Remote agents

The bundled `block.builderlab` plugin adds Settings → Plugins → Builderlab agents.
With a valid `BUZZ_BUILDERLAB_URL` build input, it also registers
`block.builderlab/builderlab` in Agents' new-agent type picker.
`adapter-type/` connects this hosted type to Beekeeper: provision registers the
agent, activation submits the owner proof and community supplied by Agents, and
removal deletes the provider runtime. Agents owns unfinished setup recovery and
the runtime-tagged community registration; the provider keeps the key and runs
the agent even while Buzz is closed. On desktop, Create agent and confirmed
deletion start browser sign-in when needed, then continue the action. Both share
an existing Settings sign-in attempt; a failed or canceled login leaves the
action available for retry. Settings still provides sign-in and sign-out.
While Create agent waits for the browser, its dialog offers Cancel sign-in, which
cancels the shared login (as Settings' does) and leaves Create available for
retry. Deletion's wait has no such control; disabling the plugin or closing Buzz
also cancels it.
Beekeeper accepts an owner proof only from the Buzz key bound to the signed-in
Builderlab account. After sign-in, and again before each activation, the plugin
checks `/v1/buzz/nostr-identities/current` and binds an unbound account to this
device's key through the native kind 24243 signer, which accepts only
production Builderlab or a login origin this build grants the plugin
(`BUZZ_BUILDERLAB_URL`'s and each tenant's). An account
bound to another key is reported and never unbound.
The agent's Identity tab reads its current instructions from Builderlab and
saves changes directly to the provider. Loading and saving use the same login;
failed saves keep the draft, and switching accounts requires the original
account before saving. Empty instructions can be saved to clear them.
The Settings tab loads a separate model catalog from Builderlab. Choose a model
and one of that model's reasoning efforts, then save the pair for new tasks.
There is no default or fallback selection. Missing or unavailable saved choices
show the server's setup status and require a supported pair. Changing the model
clears the effort choice. Instructions and model settings save independently.
Creation offers the same catalog choices and optional instructions. The provider
registers and activates the agent before saving the settings together. Unfinished
setup retains these values on this device so retry continues the same agent,
including after a restart. Setup completes only once the settings save succeeds.
Settings shows the fixed remote workspace and per-thread session behavior. Both
tabs link to the configured Builderlab site for remote runtime management.
Activity shows the turns the agent published to its owner while Buzz has been
open, across all of its conversations. It doesn't scope to the conversation it
was opened from, because hosted frames don't always name their thread. It needs
the Agent Activity plugin, which owns the feed.
Create sends the chosen picture with registration, and Beekeeper publishes it at
attestation. Renaming or changing the picture republishes the agent's profile
through Beekeeper's `update-agent-profile`.
While the hosted type is registered, the plugin also provides `ctx.builderlab`
so bundled consumers such as Bestie can set a hosted agent's model and
instructions with the same login. It offers only sign-in, the signed-in
account subject, list, the model catalog and those two updates; it never
exposes the credential or the Beekeeper client.

The adapter retains the provider agent ID, server, verified account subject and
provisioning replay reference in `buzz.builderlab.adapter-identity.v1:` records.
No credentials or owner proofs are saved. These records survive restart and
deletion so retries can confirm an already-missing runtime without assuming
absence from another account's list. Registration retains its replay UUID until
Agents has saved unfinished setup and begins activation, or provider deletion
is confirmed. On another device, removal resolves the ID from the signed-in
account's list; an unknown key is refused. Existing Settings-created
agents are not migrated into this type.

- `oauth/` owns browser handoff, code exchange, account verification, and the
  plugin-lifetime session. `browserCredential()` returns a verified `Credential`;
  `session.credential()` provides access to it. The session handles cancellation,
  sign-out, and disposal.
- `login/` owns the login experience: pending state, cancellation, retry, email
  display, and sign-out.
- `agents/` lists the signed-in account's remote agents beneath login, with
  refresh and retry. Settings directs people to the **Agents** tab to create,
  edit instructions and delete agents. Listing does not activate agents or
  publish community registrations. Requests reuse the OAuth credential through
  native host HTTP; sign-out and navigation discard late results.
  The client also supplies the hosted adapter's Beekeeper operations. Pending
  registration UUIDs survive restart, scoped to server, verified account and
  name. Retry the same name after an uncertain failure within the server's
  seven-day replay window. Instructions are limited to 20,000 characters,
  affect newly accepted tasks and are never published to the relay.
- `known-communities/` keeps the account's community list in step with this
  device through the `knownCommunities` capability while signed in, in native
  builds with a configured service. The list is an account-scoped set behind
  three idempotent JSON routes under `/v1/buzz/known-communities/`: `list`
  (`{}` → `{ communities: [{ community_url }] }`), `add` and `remove` (each
  `{ community_url }`; adding a saved destination or removing an absent one
  succeeds, and adds past about 1,000 saved destinations are refused with
  `limit_reached`). Each sign-in merges the complete list (adding what it
  lists; a saved membership it omits is kept and not uploaded again, since
  removals made on another device are ignored for now), then sends each
  destination's latest queued join or leave one at a time, retrying failures
  as sent. A list this client cannot read halts sync until the next sign-in,
  as does a 404 on any route (not yet deployed); a listed address the device
  could never save is dropped and counted, never a halt. See
  [communities](../../../docs/communities.md#known-communities).

The plugin uses the `BUZZ_BUILDERLAB_URL` [build input](../../../docs/configuration.md#builderlab-url-build-input)
as its server address and appends `/api/goose`. Its bundled native grant also
covers every `loginOrigin` in the `BUZZ_BUILDERLAB_TENANTS` table, which only
the first-launch sign-in uses.

On desktop, the plugin supplies `/v1/auth/login` with `type=cli` and
`product=builderlab` to the shared native
[`oauth_callback` module](../../../src-tauri/src/oauth_callback/README.md).
Native code inserts a loopback `redirect_uri` address, opens the browser, and returns
callback parameters to the plugin. Native code generates and validates OAuth
state; the plugin also uses a random callback path.

Each attempt generates a random PKCE verifier held only in memory, sending its
SHA-256 challenge with `code_challenge_method=S256` during login. The plugin
posts the callback code and `code_verifier` to `/v1/auth/login/exchange`, then
verifies the returned session credential with `/v1/auth/me` using the
`X-BB-Session-Credential` header. These requests use the shared host transport.
The login snapshot retains `capabilities.can_use_remote_agents`; only explicit
`true` enables remote agents. Otherwise, Settings and the Agents provider show
“Coming soon” and no Beekeeper requests are sent. Sign out and back in to refresh
this capability.
