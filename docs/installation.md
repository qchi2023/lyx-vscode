# Installation and removal

Preview scope: local Linux x64 desktop VS Code, initially Ubuntu 24.04. Windows,
macOS, web VS Code, WSL/SSH and container workspaces are unsupported. Install
dependencies on the machine running the desktop extension host. No automatic
package installation, downloads, telemetry or external desktop connection occurs
on activation. The extension launches the installed LyX executable; it does not
bundle a different LyX version.

## Linux dependencies

On Ubuntu 24.04 install these distribution packages with your package manager:
`lyx`, `tigervnc-standalone-server`, `openbox`, `wmctrl`, `xauth`, `dbus-x11`,
`websockify`, `nodejs`, `fonts-dejavu-core`, `texlive-latex-base`, and
`texlive-latex-recommended`.
The base TeX classes avoid LyX's first-document missing-class warning; other TeX
packages remain document-specific. PDF compilation needs the same TeX setup as
desktop LyX. Building the extension requires Node 22+ and npm; the broker itself
needs standalone Node 18+.

The private TigerVNC server must support `-rfbunixpath`, `-rfbunixmode` and dynamic
desktop resizing. The bridge needs websockify's `TokenFile` plugin with Unix
socket targets.
Run **Native LyX: Check Dependencies** before opening a document. If GUI-launched
Code cannot see your shell's PATH, set executable paths explicitly in Settings.
An NVM installation often needs an explicit `nativeLyxRelease.nodePath`.

## Install the local package

In VS Code, run **Extensions: Install from VSIX…**, select the supplied Linux x64
VSIX, and reload when requested. Trust only a workspace whose files you intend
to open in native LyX. Click a workspace `.lyx` file in Explorer. If another
extension already owns the file association, use **Reopen Editor With… → Native
LyX**, then configure the default editor for `*.lyx` as `nativeLyx.editor`.
The extension does not migrate profiles or terminate sessions created by other
integrations. Save and resolve those sessions separately before switching.

Each canonical file gets its own native process and private desktop. Reopening
the same file reuses its retained session. Save in LyX before ending a session.
See [shortcuts and limitations](limitations.md) and [recovery](recovery.md).

## Disable, uninstall, restore text opening

1. Save/close documents through native LyX. VS Code's tab dirty indicator does
   not describe native unsaved buffers.
2. Use **Native LyX: Retained Sessions** to inspect retained processes; use
   **Native LyX: End Session** only after resolving work. The confirmation warns
   that remaining native buffers will be discarded.
3. Disable/uninstall the extension through Extensions. Set `*.lyx` back to your
   previous editor through **Reopen Editor With… → Text Editor → Configure
   default editor**, or remove only the association you added.
4. Retained runtime data deliberately survives extension removal. Before
   uninstalling, note the diagnostics' storage root. The included control tool
   `src/cli.cjs` can list/end retained sessions and shut down an empty broker;
   its usage is displayed when called without arguments. End requires the
   explicit `--discard` flag. Do not delete the storage root while a session is
   running. Archive its profiles/snapshots before any manual data removal.

Uninstalling alone does not terminate native sessions: preserving unsaved work
takes priority over automatic process cleanup. The extension never manages
ordinary desktop LyX processes it did not create.
