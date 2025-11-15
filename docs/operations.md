# Operations Guide

## Manual compaction workflow

Run **`raBoard: Compact Logs…`** once per week to keep room spools from ballooning. The recommended preset is **「先週まで」 (through last week)** so that active discussions stay in the spool for a few extra days while historical posts move into their day-specific NDJSON archives. Follow these tips when compacting:

1. Announce the maintenance window in the affected rooms to avoid surprise deletions.
2. Select the room, choose 「先週まで」, and confirm the summary before execution.
3. Verify that new `.ndjson` files appear under `rooms/<room>/logs/` and that `rooms/<room>/msgs/` shrinks accordingly.
4. If the command reports a lock, wait a minute for the previous run to release `.lock` and retry.

Keeping a weekly cadence prevents thousands of tiny files from accumulating, simplifies backups, and ensures NDJSON archives remain contiguous for analytics.

## Troubleshooting checklist

- **Missing directories after install**  
  Use `raBoard: Open Timeline` to trigger the bootstrap routine. The extension creates `rooms/<room>/{msgs,attachments,logs}` and `presence/` if they are absent. If the folders still do not appear, confirm that the share path in `raBoard.shareRoot` is correct and reachable.
- **Permission errors during writes**  
  Confirm that users have read/write access on the UNC share. Test by manually creating and deleting a file in `rooms/<room>/msgs/`. If the OS denies access, update the share ACL or deploy a dedicated security group for raBoard editors.
- **Presence indicators never show online**  
  Ensure `raBoard.presenceTtlSec` is at least 15 seconds and that local antivirus tools are not blocking the `tmp→rename` heartbeat updates inside `presence/<user>.json`. Presence can also be disabled if the filesystem is mounted read-only.
- **Notifications silenced unexpectedly**  
  Check whether `raBoard.notifications.dnd` is enabled via the `raBoard: Toggle Notifications DND` command. Disable DND to resume toast notifications while keeping status badges active.
- **Rooms missing from unread badges**  
  Review `raBoard.notifications.rooms`. When this array is non-empty, only listed rooms contribute to unread counts. Clear the setting or add the missing room names to restore the expected coverage.
