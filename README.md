# raBoard

raBoard is a Visual Studio Code extension that turns a shared Windows SMB folder into a lightweight bulletin board and chat hub. It provides a timeline-centric webview, presence indicators, inline media previews, and VS Code command integrations without deploying any servers. All collaboration state is stored in a UNC path that your administrators provision and back up.

## Requirements recap (v0.3)

v0.3 continues the serverless philosophy established in earlier releases while polishing day-to-day collaboration flows:

- **Shared folder as the single source of truth.** Messages, logs, attachments, and presence pulses all live under a UNC share such as `\\\\mysv01\\board`.
- **Timeline-first experience.** The sidebar webview loads the 200 most recent posts, polls every five seconds, and gracefully skips malformed payloads.
- **Room lifecycle automation.** Switching to a room creates its `msgs/`, `attachments/`, and `logs/` directories on demand so teams can self-serve new channels.
- **Presence and notifications refresh.** Thirty-second heartbeats with a 60-second TTL render online pills, while configurable notifications (toast, badge, status) surface unread activity.
- **Manual compaction path.** Operators run the compact command to roll per-message JSON spools into daily NDJSON logs, keeping the share tidy without automation.
- **Attachment hygiene.** Inline previews support png/jpg/jpeg/svg, enforce a 10 MB ceiling, and fall back to download links for oversized or unrecognized files.

Refer to [`requirements.md`](requirements.md) for the authoritative functional specification.

## Admin-provisioned folder layout

Prepare the share root ahead of deployment and ensure editors receive read/write access. The extension creates missing directories on demand, but a clean baseline helps validate permissions:

```text
\\mysv01\board
├─ rooms/
│  └─ <room>/
│     ├─ msgs/            # Incoming message spool (1 JSON per file)
│     ├─ attachments/     # Drop zone for room-specific image assets
│     └─ logs/            # Daily NDJSON archives (manual compaction)
└─ presence/
   └─ <user>.json         # Presence heartbeat (tmp→rename writes)
```

Tips for administrators:

- Pre-create at least one room (for example `general`) to smoke-test permissions.
- Keep nightly backups of the share and include `logs/` in retention policies.
- Use share-level quotas or monitoring to alert when `attachments/` growth accelerates.

## Settings

| Setting | Type | Default | Description |
| --- | --- | --- | --- |
| `raBoard.shareRoot` | string | `\\\\mysv01\\board` | UNC path to the shared board root. |
| `raBoard.defaultRoom` | string | `general` | Room to join on startup. |
| `raBoard.userName` | string | _(empty)_ | Override for the name stored in presence heartbeats. |
| `raBoard.pollIntervalMs` | number | `5000` | Milliseconds between message polling cycles (minimum 1000). |
| `raBoard.presenceTtlSec` | number | `60` | Seconds before a user is considered offline if presence is stale (minimum 15). |
| `raBoard.maxImageMB` | number | `10` | Maximum inline image size before falling back to download links (in megabytes). |
| `raBoard.maxInlinePx` | number | `240` | Maximum rendered height for inline images (in pixels). |
| `raBoard.initialLoadLimit` | number | `200` | Maximum number of recent messages loaded when opening a room. |
| `raBoard.debug` | boolean | `false` | Enable verbose debug logging in the raBoard output channel. |
| `raBoard.notifications.enabled` | boolean | `true` | Toggle unread notification features globally. |
| `raBoard.notifications.mode` | string | `both` | Notification channel mix: `both`, `toast`, `badge`, or `status`. |
| `raBoard.notifications.rooms` | array | `[]` | Explicit list of rooms that should trigger unread notifications. |
| `raBoard.notifications.throttleMs` | number | `10000` | Minimum milliseconds between toast notifications. |
| `raBoard.notifications.includeActiveRoom` | boolean | `false` | Whether to count the active room toward unread totals. |
| `raBoard.notifications.dnd` | boolean | `false` | Mute toast notifications while keeping badges and status updates. |

## Commands

Use the VS Code Command Palette and search for these entries:

- `raBoard: Open Timeline`
- `raBoard: Switch Room`
- `raBoard: Compact Logs…`
- `raBoard: Open Attachments Folder`
- `raBoard: Toggle Notifications DND`
- `raBoard: Open Unread Room…`
- `raBoard: Dev - Force Poll`
- `raBoard: Dev - Dump Config`
- `raBoard: Dev - Inject Dummy Message`
- `raBoard: Mark All Read`

## Screenshots

Replace these placeholders with real captures once the UI solidifies:

![Timeline screenshot placeholder](media/screenshots/timeline.png)

![Room switcher placeholder](media/screenshots/room-switcher.png)

![Notifications placeholder](media/screenshots/notifications.png)
