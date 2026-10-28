# Changelog

## 0.1.3 — Unreleased Linux preview

- Closing a Native LyX tab requests normal native Quit with Save/Don't Save/Cancel.
  Cancel restores the document; completed closure stops only its owned session.
- Serialize Close All decisions while preserving tab switching/group moves.
- Release session watchers and command pipes after cleanup; stop an idle broker
  after the final managed session closes. Reopening starts the same file again.
- Keep reload/disconnect retention and the existing Text Editor quit flow.

## 0.1.2 — Linux preview

- Opening a document after shutdown or a native LyX exit automatically restarts
  its preserved profile. Native autosave/emergency dialogs remain in LyX.
- Reuse a running native session and coalesce concurrent openings of the same file.
- Text Editor requests normal LyX Quit with native Save/Don't Save/Cancel;
  Native LyX starts it again. Stop the private desktop only after normal exit.
- Keep native comparison/File Open/Save As interactive and reflect the current
  buffer in the tab title; reconnect no longer switches away from it.
- Upgrade the owned 0.1.1 broker while retaining its native applications.
- Automatic reconnect never restarts an explicitly stopped native session.

## 0.1.1 — Linux preview

- Real installed LyX inside local VS Code editor tabs.
- Installed executable discovery, explicit overrides and startup diagnostics.
- Persistent broker engines/profiles outside versioned extension directories.
- Retained per-file native sessions, bridge repair and broker crash adoption.
- Native document identity guard, original-file saving and observed disk snapshots.
- Automatic reconnect, dynamic fit and plain-text keyboard clipboard bridging.
- Explicit native-crash recovery and ownership-aware session termination.
- MPL-2.0, included third-party source/notices, allowlisted Linux x64 VSIX.
- Experimental limitations and required desktop dependencies are documented.
