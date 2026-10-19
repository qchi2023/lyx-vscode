'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { ensureRuntime } = require('./runtime.cjs');
const { inspect } = require('./diagnostics.cjs');
const { request, delay } = require('./common.cjs');

const CONFIG = { viewType: 'nativeLyx.editor', settingGroup: 'nativeLyxRelease', identityIntervalMs: 2500 };
function escape(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function activate(context) {
  let starting;
  const opening = new Map();
  const detached = new Map();
  const switching = new Set();
  let active = true;
  context.subscriptions.push({ dispose() { active = false; } });
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

  const provider = {
    async openCustomDocument(uri) {
      const folder = trustedFile(uri);
      const filename = fs.realpathSync(uri.fsPath);
      if (!opening.has(filename)) {
        const operation = (async () => {
          const body = { filename, root: folder.uri.fsPath };
          try { return await call('/open', body); }
          catch (error) {
            if (error.code !== 'RECOVERY_REQUIRED') throw error;
            const retained = (await call('/sessions')).find(session => session.filename === filename);
            if (!retained) throw error;
            // Opening a stopped document restarts its existing profile. Native
            // LyX owns any autosave/emergency prompt; no buffer is discarded here.
            if (retained.live) return call('/open', body);
            return call('/recover', { id: retained.id, confirmed: true });
          }
        })();
        opening.set(filename, operation.finally(() => opening.delete(filename)));
      }
      const session = await opening.get(filename);
      return { uri, folder, session, dispose() {} };
    },
    async resolveCustomEditor(document, panel) {
      if (!document.quitting) detached.delete(document.uri.toString());
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
      const check = async restore => {
        if (disposed || checking || !panel.active || document.quitting) return;
        checking = true;
        try {
          const result = await call('/identity', { id: document.session.id, restore, passive: !restore });
          // Native Compare/File Open/Save As may legitimately select another
          // buffer. Reflect it in the title without disabling native input.
          if (!disposed && result.actual) panel.title = path.basename(result.actual);
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
            if (document.quitting) return;
            const session = await call('/attach', { filename: document.uri.fsPath, root: document.folder.uri.fsPath });
            document.session = session;
            if (!disposed) panel.webview.postMessage({ type: 'connection', port: session.port, token: session.token });
          }
        } catch (error) {
          output.appendLine(error.message);
          if (!disposed) panel.webview.postMessage({ type: 'error', text: error.message });
        }
      });
      const visibility = panel.onDidChangeViewState(() => { if (panel.active) check(false); });
      const interval = setInterval(() => check(false), CONFIG.identityIntervalMs);
      panel.onDidDispose(() => {
        disposed = true; clearInterval(interval); messages.dispose(); visibility.dispose();
        if (!document.quitting && active) {
          detached.set(document.uri.toString(), document);
          setTimeout(checkTextSwitches, 100);
        }
      });
      check(false);
    }
  };
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(CONFIG.viewType, provider,
    { supportsMultipleEditorsPerDocument: false }));

  async function switchToText(document, editor) {
    const key = document.uri.toString();
    switching.add(key);
    let decisionPanel;
    let finished = false;
    try {
      let result = await call('/quit', { id: document.session.id });
      await delay(500);
      while (active && ['waiting', 'closing'].includes(result.status)) {
        result = await call('/quit-state', { id: document.session.id });
        if (result.status === 'waiting' && !decisionPanel) {
          // A disposed custom editor cannot veto Reopen With. Show the actual
          // native Quit dialog in a temporary viewer until the user decides.
          decisionPanel = vscode.window.createWebviewPanel('nativeLyx.quit',
            `${path.basename(document.uri.fsPath)} — Save changes in LyX`, editor.viewColumn || vscode.ViewColumn.Active,
            { enableScripts: true, retainContextWhenHidden: true });
          decisionPanel.onDidDispose(() => { decisionPanel = undefined; });
          await provider.resolveCustomEditor({ ...document, quitting: true }, decisionPanel);
        }
        await delay(200);
      }
      if (!active) return;
      starting = null;
      finished = true;
      if (result.status === 'closed') {
        const restoreText = Boolean(decisionPanel);
        decisionPanel?.dispose();
        // Reuse the existing TextDocument, including any source edits; never
        // replace its contents with an extension-generated copy.
        if (restoreText) await vscode.window.showTextDocument(editor.document, { viewColumn: editor.viewColumn, preview: false });
      } else {
        decisionPanel?.dispose();
        await vscode.commands.executeCommand('vscode.openWith', document.uri, CONFIG.viewType);
        if (result.status === 'error') throw new Error(result.error);
      }
    } catch (error) {
      if (active) {
        finished = true;
        decisionPanel?.dispose();
        await vscode.commands.executeCommand('vscode.openWith', document.uri, CONFIG.viewType);
        await showError(error);
      }
    } finally {
      if (finished) detached.delete(key);
      switching.delete(key);
    }
  }
  function checkTextSwitches() {
    if (!active) return;
    for (const editor of vscode.window.visibleTextEditors) {
      const key = editor.document.uri.toString();
      const document = detached.get(key);
      if (!document || switching.has(key)) continue;
      const nativeTab = vscode.window.tabGroups.all.some(group => group.tabs.some(tab =>
        tab.input instanceof vscode.TabInputCustom && tab.input.viewType === CONFIG.viewType && tab.input.uri.toString() === key));
      if (!nativeTab) switchToText(document, editor).catch(showError);
    }
  }
  context.subscriptions.push(vscode.window.onDidChangeVisibleTextEditors(checkTextSwitches));

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
