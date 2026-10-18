'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureRuntime } = require('./runtime.cjs');
const { inspect } = require('./diagnostics.cjs');
const { request } = require('./common.cjs');

const CONFIG = { viewType: 'nativeLyx.editor', settingGroup: 'nativeLyxRelease', identityIntervalMs: 2500 };
function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function activate(context) {
  let starting;
  const output = vscode.window.createOutputChannel('Native LyX');
  context.subscriptions.push(output);
  const settings = () => {
    const configuration = vscode.workspace.getConfiguration(CONFIG.settingGroup);
    const keys = ['lyxPath', 'nodePath', 'vncPath', 'windowManagerPath', 'websockifyPath', 'wmctrlPath',
      'xauthPath', 'dbusPath', 'dependencyRoot', 'width', 'height', 'dpi', 'autosaveSeconds', 'maxSessions', 'startupTimeoutMs'];
    return Object.fromEntries(keys.map(key => [key, configuration.get(key)]));
  };
  const storageRoot = () => vscode.workspace.getConfiguration(CONFIG.settingGroup).get('storageRoot') || context.globalStorageUri.fsPath;
  const broker = () => starting ||= ensureRuntime({ sourceRoot: context.extensionPath, storageRoot: storageRoot(), settings: settings() })
    .catch(error => { starting = null; throw error; });
  const call = async (route, body) => {
    try { return await request((await broker()).socket, route, body); }
    catch (error) {
      if (['ENOENT', 'ECONNREFUSED'].includes(error.code)) {
        starting = null;
        return request((await broker()).socket, route, body);
      }
      throw error;
    }
  };
  const trustedFile = uri => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!vscode.workspace.isTrusted || uri.scheme !== 'file' || folder?.uri.scheme !== 'file') {
      throw new Error('Native LyX requires a .lyx file in a trusted local Linux workspace. Remote/virtual workspaces are not supported in this preview.');
    }
    return folder;
  };
  const showError = error => vscode.window.showErrorMessage(`Native LyX: ${error.message}`);

  context.subscriptions.push(vscode.window.registerCustomEditorProvider(CONFIG.viewType, {
    async openCustomDocument(uri) {
      const folder = trustedFile(uri);
      const session = await call('/open', { filename: uri.fsPath, root: folder.uri.fsPath });
      return { uri, folder, session, dispose() {} };
    },
    async resolveCustomEditor(document, panel) {
      panel.webview.options = { enableScripts: true, localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')
      ] };
      const nonce = crypto.randomBytes(24).toString('hex');
      const style = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media/viewer.css'));
      const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'dist/viewer.js'));
      const clipboardSync = vscode.workspace.getConfiguration(CONFIG.settingGroup).get('clipboardSync');
      panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; img-src data: blob:; connect-src ws://127.0.0.1:*;">
        <link rel="stylesheet" href="${style}"></head><body><div id="status" role="status">Connecting</div>
        <main id="desktop" aria-label="Native LyX: ${escape(document.uri.fsPath)}" data-port="${document.session.port}" data-token="${document.session.token}" data-clipboard="${clipboardSync}"></main>
        <script type="module" nonce="${nonce}" src="${script}"></script></body></html>`;
      let disposed = false;
      let checking = false;
      let mismatchReported = false;
      const check = async restore => {
        if (disposed || checking || !panel.active) return;
        checking = true;
        try {
          const result = await call('/identity', { id: document.session.id, restore, passive: !restore });
          if (!disposed) panel.webview.postMessage({ type: 'identity', ...result });
          if (result.matches === false && !mismatchReported) {
            mismatchReported = true;
            vscode.window.showWarningMessage(
              `LyX switched to ${result.actual || 'another document'}. This tab remains bound to ${path.basename(document.uri.fsPath)}.`, 'Restore this tab’s document')
              .then(async decision => {
                if (!decision || disposed) return;
                const restored = await call('/identity', { id: document.session.id, restore: true });
                if (!disposed) panel.webview.postMessage({ type: 'identity', ...restored });
              }).then(undefined, error => output.appendLine(error.message));
          }
          if (result.matches === true) mismatchReported = false;
        } catch (error) { output.appendLine(error.message); }
        finally { checking = false; }
      };
      const messages = panel.webview.onDidReceiveMessage(async message => {
        try {
          if (message.type === 'paste' && clipboardSync && panel.active) {
            const text = await vscode.env.clipboard.readText();
            if (!disposed) panel.webview.postMessage({ type: 'paste', text });
          }
          if (message.type === 'copy' && clipboardSync && panel.active && vscode.window.state.focused &&
              typeof message.text === 'string' && message.text.length <= 1048576) await vscode.env.clipboard.writeText(message.text);
          if (message.type === 'reconnect') {
            const session = await call('/attach', { filename: document.uri.fsPath, root: document.folder.uri.fsPath });
            document.session = session;
            if (!disposed) panel.webview.postMessage({ type: 'connection', port: session.port, token: session.token });
          }
        } catch (error) {
          output.appendLine(error.message);
          if (!disposed) panel.webview.postMessage({ type: 'error', text: error.message });
        }
      });
      const visibility = panel.onDidChangeViewState(() => { if (panel.active) check(true); });
      const interval = setInterval(() => check(false), CONFIG.identityIntervalMs);
      panel.onDidDispose(() => { disposed = true; clearInterval(interval); messages.dispose(); visibility.dispose(); });
      check(false);
    }
  }, { supportsMultipleEditorsPerDocument: false }));

  const choose = async () => {
    const sessions = await call('/sessions');
    return vscode.window.showQuickPick(sessions.map(session => ({ label: path.basename(session.filename),
      description: `${session.id} · ${session.live ? 'retained' : session.state}`, detail: session.filename, session })));
  };
  const register = (name, action) => context.subscriptions.push(vscode.commands.registerCommand(`nativeLyxRelease.${name}`, async () => {
    try { await action(); } catch (error) { await showError(error); }
  }));
  register('diagnostics', async () => {
    const report = inspect(settings());
    output.appendLine(JSON.stringify({ ...report, storageRoot: storageRoot() }, null, 2));
    output.show(true);
    if (!report.ok) await showError(new Error(report.errors.join('\n')));
  });
  register('sessions', async () => {
    const selected = await choose();
    if (!selected) return;
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(selected.session.filename), CONFIG.viewType);
    await call('/identity', { id: selected.session.id, restore: true });
  });
  register('endSession', async () => {
    const selected = await choose();
    if (!selected) return;
    const decision = await vscode.window.showWarningMessage(
      'Save/close documents in native LyX first. VS Code does not know their dirty state. Ending this session discards any remaining unsaved buffers. Profiles/snapshots are preserved.',
      { modal: true }, 'End and discard remaining buffers');
    if (decision) await call('/end', { id: selected.session.id, discardConfirmed: true });
  });
  register('recovery', async () => {
    const selected = await choose();
    if (!selected) return;
    const decision = await vscode.window.showWarningMessage(
      'Reopen the preserved native profile? LyX may offer its autosave recovery dialog. Keep both disk versions if there is a conflict; existing snapshots are preserved.',
      { modal: true }, 'Reopen preserved profile');
    if (!decision) return;
    await call('/recover', { id: selected.session.id, confirmed: true });
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(selected.session.filename), CONFIG.viewType);
  });
  register('history', async () => {
    const selected = await choose();
    if (!selected) return;
    const folder = path.join(selected.session.directory, 'snapshots');
    if (!fs.existsSync(folder)) throw new Error('No saved snapshots are available for this session.');
    await vscode.env.openExternal(vscode.Uri.file(folder));
  });
}
module.exports = { activate, deactivate() {} };
