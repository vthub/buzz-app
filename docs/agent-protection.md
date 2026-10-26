# Agent protection providers

`agentProtection` version 2 separates the native protection boundary from an
installed plugin's classifiers and approval UI. This contract replaces the
removed legacy agent-security/ACP integration. It is experimental and requires
packaged macOS acceptance before production use.

## Provider API

An installed plugin injects `agentProtection`, then registers
`{ processProtection, check(request, signal) }`. Registration is owned by its
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
of the currently displayed conversation. Requests are limited to 64 KiB. Plugins
must propagate cancellation and must not derive identity/policy from tool text.

`snapshot()` returns native defaults/revision and current local agents with
binding/revision and runtime coverage. `saveDefaults(revision, policyOrNull)` and
`saveAgent(pubkey, revision, policyOrNull)` use native compare-and-swap. Another
provider's binding cannot be overwritten implicitly. Policies are JSON objects
limited to 32 KiB. Defaults are copied under the identity lock on every creation
and import path, including agent-requested creation.

Existing-agent saves require an idle runner and exclusive native hosting custody.
The old runtime must acknowledge retirement before persistence. Failed retirement
continues to block retries. Native admission compares the cached protection
revision; stale app copies refuse work and refresh. Old handles are revoked.

## Runtime contract

Runtime types declare `protection: true` only when every supported model request,
tool execution and tool result passes `AgentHandle.protection`. Their `retire`
method must fully end existing native sessions before a policy changes. Missing
coverage refuses protected runs and session mutations, with the type's explicit
`protectionUnavailable` reason. Shared Buzz tool dispatch also gates exact input
snapshots and returned output/errors.

Pi is currently the only integrated runtime. Protected Pi uses one contained
worker per agent/provider generation and separate durable state per native policy
revision. Built-in providers, coding tools and Buzz tools are supported. User Pi
packages are not loaded into protected workers. External Attention commands are
refused for protected agents until that path provides complete enforcement. Tool output/diagnostics/errors
remain buffered until approved, including safe replay. Model dispatch checks
cover restored history, compaction and retries. Deferred provider jobs and payload
rewrite callbacks are refused. An approved shell command is one action; its
internal syscalls are not separately reviewed.

Claude, Codex and Goose retain configurable bindings but refuse protected runs:
their current native APIs cannot enforce every required action/result boundary.
They may still serve as reviewing agents; reviewer authority is a provider policy
choice, separate from requesting-runtime coverage.

## Evidence

Focused tests cover native identity/default persistence, cross-copy custody,
stale admission, policy retirement, cancellation and shared Buzz tools. The macOS
protection CI job installs exact Pi lockfile dependencies and exercises real Pi
storage/tools with a synthetic model/checker: held/denied writes, withheld output,
cancellation, recovery, restored context and compaction. It also executes the
native macOS containment profile. These fixtures do not establish packaged-app
integration, real classifier health or real-model review quality. Human
acceptance and current UI/interaction checks remain required before marking the
experimental PR ready.
