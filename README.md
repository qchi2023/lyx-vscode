# Native LyX for VS Code

Edit workspace `.lyx` files in the **real installed LyX application**, displayed
inside a VS Code editor tab. Native menus, toolbars, equation editing and dialogs
remain native. Save through LyX to the original document. The connected editor
adds no toolbar.

**Linux x64 preview**, tested initially on Ubuntu 24.04. Local desktop VS Code
only. Windows, macOS, web, WSL/SSH and remote/container workspaces are unsupported.
This independent integration is not an official LyX or Microsoft product.

Source and support: [GitHub repository](https://github.com/qchi2023/lyx-vscode),
[report an issue](https://github.com/qchi2023/lyx-vscode/issues).

## Setup

Install LyX, standalone Node 18+, TigerVNC, Openbox, websockify and supporting
tools on the machine running VS Code. Ubuntu 24.04 package names:

```sh
sudo apt install --no-install-recommends lyx nodejs tigervnc-standalone-server openbox websockify wmctrl xauth dbus-x11 fonts-dejavu-core texlive-latex-base texlive-latex-recommended
```

Install the Linux x64 VSIX using **Extensions: Install from VSIX…**. Run **Native
LyX: Check Dependencies**. Open a trusted local workspace and click a `.lyx` file.
If another editor owns the association, choose **Reopen Editor With… → Native
LyX** and configure it as the default for `*.lyx` (`nativeLyx.editor`).

The extension discovers installed executables on PATH. Set `nativeLyxRelease`
executable paths explicitly for multiple LyX versions or a shell-only Node
installation. `lyxPath` selects your installed LyX; no LyX binary is bundled.
Width, height, DPI, autosave interval, session limit and persistent storage root
are configurable in Settings. No dependencies are installed during activation.

## Editing and session lifetime

Click inside LyX before typing. Use native Ctrl+S, Ctrl+Z, Ctrl+Y and Ctrl+M for
save, undo, redo and math. Personal VS Code keybindings may take precedence;
native menus are available. VS Code Save All, autosave, dirty dots and close
prompts do **not** represent native buffers.

Each canonical file has a retained native process/private desktop. Tab closure,
Code reload or connection loss disconnects the viewer and preserves live native
buffers. Reopen the same file to reconnect. **Native LyX: Retained Sessions**
lists them. Save/close work in LyX before **Native LyX: End Session**, whose
confirmation explicitly permits discarding remaining buffers. Retained sessions
consume memory until resolved, even after disabling/uninstalling this extension.

Native crashes require **Native LyX: Recover Session** and a deliberate choice
in LyX's autosave recovery dialog. Recovery of the last successful autosave was
demonstrated; newer edits and host-reboot recovery are not guaranteed. Disk
revisions observed by the watcher are available through **Native LyX: Open Saved
File Snapshots**. Keep ordinary backups. Native external-change prompts require
an explicit reload/overwrite decision; no automatic merge is provided.

## Preview limitations

- Plain-text clipboard bridging only. Rich objects, images, drag/drop and
  primary-selection interoperability across separate sessions are unsupported.
- Use one workspace document per VS Code tab. Native File Open/Save As can switch
  the buffer; a title/IPC identity guard pauses input and offers restoration.
  Save As does not rebind/rename the VS Code tab. The check is not instantaneous.
- Native profiles are separate from ordinary desktop LyX preferences. Dialogs
  must fit within the editor group. Canvas viewing has limited accessibility.
- Snapshots cannot capture every rapid external write or unsaved native edit.
  They are retained without automatic deletion; monitor storage usage.
- Desktop transport stays local: private VNC Unix socket, loopback bridge and a
  random connection token. This does not isolate native LyX from your user account.

To restore previous opening behavior, save/end native sessions, disable/uninstall
the extension and configure `*.lyx` back to your previous editor. Persistent
profiles/snapshots are intentionally retained; do not delete them while running.
The bundled `src/cli.cjs` provides ownership-aware session control after uninstall.

User guides: [installation and removal](docs/installation.md),
[configuration](docs/configuration.md), [limitations](docs/limitations.md), and
[recovery](docs/recovery.md).

## Build and package

Use Node 22+ and npm for the locked build tools:

```sh
npm ci --ignore-scripts
npm run build
npm run package
```

The package command creates a Linux x64 pre-release `.vsix` locally. Install it
through **Extensions: Install from VSIX…**. Generated packages are ignored by
Git. Building a package does not publish it or establish interactive validation.

MPL-2.0 source and noVNC 1.7.0 source/licenses are included in the VSIX. See
[LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
