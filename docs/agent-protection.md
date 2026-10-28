# Agent protection providers

`agentProtection` version 2 separates the native protection boundary from an
installed plugin's classifiers and approval UI. This contract replaces the
removed legacy agent-security/ACP integration. It is experimental and requires
packaged macOS acceptance before production use.

## Provider API

An installed plugin injects `agentProtection`, then registers
`{ processProtection, check(request, signal), phases?(policy) }`. Registration is owned by its
plugin ID; replacing or unloading it revokes the old registration and pending
checks. Only the exact boolean `true` permits an action. Exceptions, cancellation,
missing providers, invalid/oversized requests and the bounded deadline deny it.

`processProtection` contains absolute existing `readOnlyPaths` and `hiddenPaths`.
The native process launcher adds agent controls, installed plugin storage and the
application bundle. macOS denies worker writes to these roots and replacement of
their ancestors, reads of private approval state, and Apple Events. Workspace
writes remain possible. Mutable development frontends and other operating
systems refuse protected processes. This is approval-authority containment, not
a general network/filesystem policy.

`check` receives an immutable action (`kind`, `session`, `content`, optional
`command`) plus host-captured `agent`, `relay`, `runtime` and `policy`. `kind` is
`context`, `tool` or `tool-result`. Session metadata is not authorization or proof
of the currently displayed conversation. Each source or combined tool action is limited to 256 KiB. Optional `phases(policy)` returns a
boolean for every action kind; it is captured from the native policy at launch.
Disabled phases still validate the provider lifetime, but send no inspection
evidence and do not invoke a checker. Omitting it enables every phase. Plugins
must propagate cancellation and must not derive identity/policy from tool text.

`snapshot()` returns native defaults/revision and current local agents with
binding/revision and runtime coverage. `saveDefaults(revision, policyOrNull)` and
`saveAgent(pubkey, revision, policyOrNull)` use native compare-and-swap. Another
provider's binding cannot be overwritten implicitly. Policies are JSON objects
limited to 32 KiB. Defaults are copied under the identity lock on every creation
and import path, including agent-requested creation.

Existing-agent saves require an idle runner and exclusive native hosting custody.
Every community membership, including disconnected ones, must acknowledge native
runtime retirement before persistence. A pubkey transition also holds memberships
that join while a save is pending. Failed retirement
continues to block retries. Native admission compares the cached protection
revision; stale app copies refuse work and refresh. Old handles are revoked. Protected identities use a sticky version-3 envelope
containing every membership; legacy split files with divergent policy and
ambiguous protected version-2 migrations are refused.

## Runtime contract

Runtime types declare `protection: true` only when every supported model request,
tool execution and tool result passes `AgentHandle.protection`. Their `retire`
method must fully end existing native sessions before a policy changes. Missing
coverage refuses protected runs and session mutations, with the type's explicit
`protectionUnavailable` reason. Shared Buzz tool dispatch also gates exact input
snapshots and returned output/errors.

Protected Pi uses one contained
worker per agent/provider generation and separate durable state per native policy
revision. Built-in providers, coding tools and Buzz tools are supported. User Pi
packages are not loaded into protected workers. External Attention commands are
refused for protected agents until that path provides complete enforcement. Tool output/diagnostics/errors
remain buffered until approved, including safe replay. Model dispatch checks
cover restored history, compaction and retries. Deferred provider jobs and payload
rewrite callbacks are refused. Image-generation and classifier request shapes without explicit conversation messages are refused. An approved shell command is one action; its
internal syscalls are not separately reviewed.

Goose uses the exact source pin in `runtime/goose-acp.json` with the mandatory
`runtime/goose-security.patch`. Its native provider decorator gates model input,
including tool results, and its central tool dispatcher gates arguments together
with the native conversation. Providers with internal tool loops, toolshim,
unreviewed native command hooks, recipe shell callbacks and unsupported extension
launches are refused. Protected agents have dedicated contained workers.

Codex uses a separate pinned app server (`runtime/codex-security.json` and
`runtime/codex-security.patch`). Prepared HTTP/WebSocket model requests pass the
native gate, including recovery/compaction requests; native local tool dispatch
checks the arguments and conversation after hook rewrites. Hosted tools are
refused. Ordinary unprotected Codex retains its independent updater.

Claude uses the pinned native CLI 2.1.305. Unfiltered input, pre-tool, raw success/
failure output and final tool-batch hooks await review. Native transcript plus
immutable native stream events provide preceding evidence while writes are
pending. A native watchdog kills stalled hook callbacks before the CLI's timeout
can fail open. Hook-registration errors and Stop terminate the worker. Workspace
instruction loading, attachments, native subagent delegation, background tasks,
experimental context clearing and fallback rewrites are disabled. Compaction and
session reset/fork are refused; protected resumes require the same native policy
state key and readable prior transcript. Start a new conversation when this
bounded path cannot continue. Do not describe this evidence as a lossless active
history snapshot.

Input inspection follows Goose's separation of conversation text from provider
configuration. Dynamic instructions and every native message are checked as
individual immutable sources before model dispatch; tool catalogues, schemas and
model options are not prompt-classifier evidence. Pi uses its native system-text
renderer to retain dynamic instruction sections without embedded tool declarations.
Codex validates local dispatch for additional tool declarations before excluding
those declarations from input inspection. Restored messages and tool results are
retained; this contract does not adopt Goose's ten-user-message window. An individual
source failure prevents model dispatch. Tool-action inspection still receives the
exact arguments and combined preceding native conversation.

Optional native plugin hooks are disabled for protected Pi, Claude and Codex workers until replacement payloads can be inspected in the correct order. Ordinary workers retain native hook dispatch.

All supported protected workers require packaged macOS containment. Reviewer
choice remains separate from the requesting runtime's enforcement capability.

## Configurable inspection models

Runtime plugins own `registerModels({label, models, complete})`; credentials remain
with that runtime. `modelChoices()` lists configured choices. A protection provider
calls `evaluate(model, request, signal)` for tool-less inference with exact action
and preceding conversation evidence. Only structured `{blocked, reason}` output
is accepted; the assessment records the actual model. Provider changes, invalid
output and cancellation never create an approval.

`review(model, request, signal, explanationOnly)` uses the same short-lived,
tool-free inference for a pending finding, without creating an agent identity.
Human explanations grant no execution authority. Completion receives separate
`{system, input}` fields: fixed trusted review instructions and JSON user evidence.
Each runtime preserves those roles and disposes its temporary inference work.

Buzz Security independently configures incoming-content and dangerous-action
hooks, at default and per-agent scope. Each can be disabled or assigned a model
from any registered runtime, including custom model IDs. Recommended selections
are defaults rather than an allowlist. Model assessment is distinct from assigning
a Buzz agent to recommend or decide on a flagged action. The security plugin
offers model review by default, with an existing Buzz agent as an explicit option.

## Evidence

Focused tests cover native identity/default persistence, cross-copy custody,
stale admission, policy retirement, cancellation and shared Buzz tools. The macOS
protection CI job installs exact Pi lockfile dependencies and exercises real Pi
storage/tools with a synthetic model/checker: held/denied writes, withheld output,
cancellation, recovery, restored context and compaction. It also executes the
native macOS containment profile. These fixtures do not establish packaged-app
integration, real classifier health or real-model review quality. The same macOS job builds exact protected Goose/Codex pins, verifies the pinned
Claude download against its release checksum, and runs native fixtures using synthetic loopback model responses and
real filesystem writes to prove held actions, denied writes and denied input;
Claude additionally exercises withheld successful/failed output and resumed
transcripts. Native build caches are keyed by pins and patches; timing artifacts
record fixture counts, elapsed time and slowest cases. Cold local Goose/Codex
compilation took about three/five minutes respectively; hosted CI timing remains
to be measured on the pushed head. Human
acceptance and current UI/interaction checks remain required before marking the
experimental PR ready.

Each input source or combined tool action is bounded to 256 KiB, with separate 768 KiB serialized prompt/record headroom. Nothing is truncated to fit. Fixed classifiers can have smaller input bounds; a failed inspection must pause or deny. These byte limits do not establish classifier tokenization or detection completeness.
