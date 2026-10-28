# Configuration

Settings use the `nativeLyxRelease` prefix. Empty executable paths discover the
corresponding program on PATH. Explicit paths are recommended for multiple LyX
versions and shell-only Node installations. Arguments are passed directly to
executables; setting values are not shell commands.

| Setting suffix | Meaning / default |
|---|---|
| lyxPath | Installed `lyx` executable |
| nodePath | Standalone `node`, version 18+ |
| vncPath | `Xtigervnc` or compatible `Xvnc` |
| windowManagerPath | `openbox` |
| websockifyPath | `websockify` with TokenFile/Unix target support |
| wmctrlPath / xauthPath / dbusPath | `wmctrl`, `xauth`, `dbus-run-session` |
| dependencyRoot | Optional extracted package prefix with usr/bin, usr/lib, usr/share; empty uses system libraries |
| storageRoot | Empty uses VS Code global storage for this extension; optional absolute persistent directory |
| width / height | Initial virtual desktop 1200 × 800; viewer resizes dynamically |
| dpi | Initial desktop DPI, 96 |
| autosaveSeconds | Native LyX autosave interval, 30 seconds |
| maxSessions | 4 concurrent native sessions; completed tab closure releases its slot |
| startupTimeoutMs | 60000; increase for slow first-run LyX configuration |
| clipboardSync | true; bridge plain text only while the editor is active |

Executable/display/limit settings apply when starting a new broker. Existing
brokers retain their original configuration to avoid disrupting work. Save and
resolve all sessions; after completed closes the idle broker exits automatically.
Reopen after it exits to apply new startup settings.
The autosave setting initializes new native profiles; an existing profile keeps
its native preferences. Clipboard setting changes require reopening the tab.

Never set storageRoot to an extension installation directory or an ephemeral
folder. Changing it starts a separate runtime; earlier sessions remain under
the old root. Use only a local disk with reliable Unix file locking/rename
semantics. The socket path is short and derived from the storage root; native
profiles and immutable broker engines survive ordinary extension upgrades.
