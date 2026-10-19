# Session lifetime, recovery and conflicts

Start with **Native LyX: Retained Sessions**. Never end a session merely because
its viewer disconnected. Reopening the same canonical workspace file attaches
to the retained native process. A lost WebSocket retries automatically; a dead
bridge can be recreated without restarting native LyX. An unexpectedly exited
broker adopts its recorded live processes using PID, process start time and
machine boot identity, so PID reuse is not treated as ownership.

If native LyX itself has exited or the PC has shut down, click the document in
Explorer again. The extension restarts LyX using the same preserved profile,
without an extension recovery prompt. LyX may offer its usual autosave or
emergency recovery dialog, just as on the desktop. Inspect both the
disk document and recovered version; save a separate copy if uncertain. Recovery
does not silently replace the original file. Native autosave data may reside
beside the document or in the retained profile/temp directory. Never delete
those directories while diagnosing recovery.

**Native LyX: Open Saved File Snapshots** opens immutable copies of observed
disk revisions. Copy a desired revision to a separate file for inspection before
restoring anything. Snapshots capture saved disk bytes, not the current unsaved
native buffer. They have no automatic retention deletion in this preview; monitor
disk usage. The per-file snapshot size limit is 64 MiB. Inability to capture a
snapshot does not justify overwriting the original. Logs/registry are local and
may contain document paths; redact them before sharing a bug report.

When another program changes a file, use LyX's reload/overwrite conflict dialog
deliberately. Do not select overwrite unless you intend to replace the external
revision. Preserve separate copies when keeping both sets of edits. Automatic
merging is not implemented. A watcher may miss very short-lived disk versions;
use ordinary file backups in addition to this integration.

Choosing **Reopen Editor With… → Text Editor** requests normal native Quit.
If native LyX needs a save decision, a temporary tab displays its real dialog.
Save/Don't Save finishes the switch and stops only that private session; Cancel
returns to Native LyX. No forced kill is used to dismiss an unanswered dialog.
Choosing Native LyX again starts it with the same profile and selected file.
When upgrading from 0.1.1, only the old integration broker is restarted to load
the graceful-quit support; recorded native applications/desktops are adopted.

For explicit forced session termination, save/close its native documents first, then choose **Native
LyX: End Session**. The modal confirmation explicitly permits discarding any
remaining buffers. Only recorded owned processes receive termination signals;
profiles, snapshots and logs are retained. If a process does not exit, ownership
records remain and a new session is refused rather than losing track of it.

After a reboot, native processes cannot survive. The next opening automatically
starts LyX again with the retained profile. Edits after the last native autosave may be lost. Test
recovery with a disposable file on your own LyX version before relying on it.
