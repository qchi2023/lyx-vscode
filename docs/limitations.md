# Native interaction and preview limits

LyX runs as a normal native Qt application on a private local X desktop.
TigerVNC sends that desktop to noVNC in a VS Code webview. This is interactive
native LyX, but the browser/VS Code keyboard and clipboard boundary means the
experience cannot be identical to an ordinary desktop window.

- Click inside LyX before typing. Native Ctrl+S, Ctrl+Z, Ctrl+Y and Ctrl+M are
  intended to save, undo, redo and enter math while the viewer has focus.
  Workbench shortcuts can take precedence depending on personal keybindings.
  LyX menus are the fallback. VS Code Save All, autosave and undo history do not
  control native buffers; no VS Code dirty dot or close prompt is promised.
- Closing a VS Code tab or reloading Code disconnects only the viewer. Native
  sessions remain live, including unsaved edits, and consume memory until you
  close native LyX or explicitly end them. Reopen the same file to reattach.
- Explicitly switching to **Text Editor** instead requests native Quit. An
  unsaved-work dialog is shown in a temporary native tab; Cancel restores Native
  LyX. Save/Don't Save completes the switch and closes its owned desktop/bridge.
  Resolve every native buffer opened in that session; a native comparison or
  Save As can leave additional buffers open. A timeout/error preserves them.
- Native dialogs, menus and toolbars remain within the private desktop. Files
  chosen in a dialog are local-machine files. Large dialogs may require a larger
  editor group; browser zoom and native LyX document zoom are different controls.
- Plain text Ctrl+C/Ctrl+V is bridged while active. Unicode/multiline support is
  subject to the native application. Rich text, native math objects between
  separate sessions, images, files, drag/drop and primary-selection/middle-click
  clipboard interoperability are not promised. Within one LyX process, its
  native rich clipboard is retained when host text has not changed. Clipboard
  sync can be disabled. Do not expect browser webviews to expose native widgets
  to screen readers; canvas accessibility is a known limitation.
- Native Compare, File Open and Save As can change the displayed buffer. Input
  stays enabled; tab activation and reconnection preserve that native selection.
  A periodic title/IPC check updates the tab title when LyX answers. Custom title
  formats and modal dialogs may delay detection. Save As does not rebind the
  tab's workspace resource or its extension snapshots. Explorer reopening of the
  original resource selects its corresponding buffer. Closing its session with
  Text Editor or native Quit applies to every buffer in that private process.
- External edits use LyX's own changed-file checks. The broker also archives
  observed disk revisions, but a filesystem watcher cannot guarantee capturing
  every rapid write. No automatic text merge or remote collaboration is provided.
- Profiles are isolated from ordinary desktop LyX preferences, so themes,
  shortcuts and tool configuration may differ even when the executable matches.
  Native profile directories are preserved for manual configuration/recovery.
- No host-reboot or native-crash guarantee is made for edits newer than the last
  successful native autosave. Persistent profiles and snapshots aid recovery;
  they do not replace backups. See [recovery](recovery.md).
- Local processes running as your user can inspect your sessions. The bridge is
  loopback-only with a random per-session token; native VNC is a private Unix
  socket. No network desktop port or public service is opened.

Validation evidence applies to the specific release candidate and its listed
environment; it should not be generalized to other systems or versions.
