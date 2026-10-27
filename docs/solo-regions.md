# Solo regions

The host exposes `ctx.soloNavigation.version === 2` only with the complete region
implementation. The public types are exported from `@buzz/author`. The service is
created with the relay in `src/app/services.ts`; plugins register sources through
their tracked Cordis context.

The host derives `buzz.region:<pluginId>:<sourceId>` from the caller. Labels own
placement, even when a plugin is off, loading, unavailable, or failed. The host
uses one projection for the live list, recovery list, inventory exclusion, header
chip, and personal filing guards. Unknown channel types do not imply Solo.
Existing personal workspace assignments remain stored while they are dormant.
Label edits preserve region labels. There is no public remove operation.

Each bind has a fresh incarnation. Reconnect and Retry abort the previous bind;
old handles, menus, state writes, and reveal subscribers cannot act in the new
incarnation. A source must return increasing revisions with the current binding.
Header actions remain outside the component error boundary, so a source can offer
recovery actions while the host renders its channels.

The source owns its content, presentation, and disclosure controls. It receives
the stable `ui.Conversation` component. Conversation renders only live channels
and calls its children with the name, preview, selected state, and bound parts:
`Link` supplies navigation, current state, focus identity, and rename; `Menu`
supplies the standard chat menu; `Actions` is its overflow button; `Reveal`
shows content only at rest or only while the menu is active; and `Unread` shows
the host unread state. `ui.Card` is the shared
`NavigationCard`, which owns hover, selection, and drag-target paint. Typography,
status, and layout inside a row are the source's choice. Source styles may target
`.navigation-item`, `.navigation-item-trailing`, `.buzz-button-label`,
`[data-navigation-card]` with its `.navigation-card-row`, `-body`, and `-footer`
parts, `[data-solo-disclosure]`, `[data-channel-activity]`, and
`[data-channel-unread]`. They may read `--session-action-size`,
`--session-trailing-end`, `--project-icon-size`, and `--channel-row-fill-start`
and `-end` for row geometry. Other host classes and module class names are
private. Conversations are not drag sources and cannot file into personal
workspaces.

`data-solo-destination-id` is a supported behavior hook. A primary
`Conversation.Link` carries its channel ID; secondary links omit the marker.
Recovery destinations use the same marker. Nexus uses it to identify dragged
tasks and restore focus after a move. Plugins must scope queries to their own
region. Changes to the marker or its meaning require coordinated updates to the
host and consuming plugins.

The host retains one JSON state value per scope, viewer, and source key across
unmount, disposal, and registration. It accepts at most 16 KiB. A failed or stale
write returns false and does not update the memory value. Sources must keep their
own accepted state unchanged when a write fails.

Host reveal listeners receive live intent only. A pending request is kept only
for a late source subscriber and ends when navigation leaves or the connection
changes. The header chip can explicitly reveal the same current chat after a
manual scroll through the scroll owner's `revealAgain`; ordinary retries never
re-arm viewport ownership. Missing plugins use generic recovery copy, and catalog
loading does not imply that a plugin is uninstalled.

Reveal requests expand the host frame and let the source open the path. After
commit, the host uses the existing sidebar reveal retry. Recovery rows use the
same destination marker. Removing a focused row restores focus to a remaining row,
then the region heading; removing the region restores focus to the Solo heading.

Focused tests live beside `solo-navigation.ts` and `SoloRegions.tsx`. Browser and
native app checks must still cover geometry, both themes, enlarged text, keyboard
focus, hidden sections, and relay signing. DOM checks do not establish those facts.
