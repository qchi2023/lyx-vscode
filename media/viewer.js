import RFB from '../vendor/novnc/core/rfb.js';
import KeyTable from '../vendor/novnc/core/input/keysym.js';

const CONFIG = { resizeSession: true, scaleViewport: true, reconnectDelaysMs: [1000, 2000, 4000, 8000] };
const vscode = acquireVsCodeApi();
const desktop = document.getElementById('desktop');
const status = document.getElementById('status');
let rfb;
let clipboard = null;
let connected = false;
let pastePending = false;
let pasteKeyHeld = false;
const controlsDown = new Set();
let retryTimer;
let retryCount = 0;
let disposed = false;

function showStatus(text, hidden = false) {
  status.textContent = text;
  status.hidden = hidden;
}

function retryConnection() {
  if (disposed || retryTimer) return;
  const delay = CONFIG.reconnectDelaysMs[Math.min(retryCount++, CONFIG.reconnectDelaysMs.length - 1)];
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (!disposed && !connected) vscode.postMessage({ type: 'reconnect' });
  }, delay);
}

function requestPaste() {
  if (!connected || pastePending || desktop.dataset.clipboard === 'false') return;
  pastePending = true;
  vscode.postMessage({ type: 'paste' });
}

// Intercept before noVNC and VS Code handle the canvas shortcut. Fetch the host
// text first; forwarding Ctrl+V immediately would paste the old remote clipboard.
window.addEventListener('keydown', event => {
  if (event.code === 'ControlLeft' || event.code === 'ControlRight') controlsDown.add(event.code);
  if (!desktop.contains(event.target)) return;
  if (desktop.dataset.clipboard !== 'false' && event.ctrlKey && !event.altKey && !event.shiftKey && event.code === 'KeyV') {
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteKeyHeld = true;
    requestPaste();
  }
}, true);
window.addEventListener('keyup', event => {
  controlsDown.delete(event.code);
  if (event.code === 'KeyV' && pasteKeyHeld) {
    event.preventDefault();
    event.stopImmediatePropagation();
    pasteKeyHeld = false;
  }
}, true);
window.addEventListener('blur', () => { controlsDown.clear(); pasteKeyHeld = false; });

function connect(port, token) {
  if (disposed) return;
  clearTimeout(retryTimer);
  retryTimer = null;
  connected = false;
  pastePending = false;
  clipboard = null;
  controlsDown.clear();
  pasteKeyHeld = false;
  const previous = rfb;
  rfb = null;
  previous?.disconnect();
  desktop.replaceChildren();
  showStatus(retryCount ? 'Reconnecting…' : 'Connecting');
  const current = new RFB(desktop, `ws://127.0.0.1:${port}/?token=${token}`);
  rfb = current;
  current.resizeSession = CONFIG.resizeSession;
  current.scaleViewport = CONFIG.scaleViewport;
  current.addEventListener('connect', () => {
    if (current !== rfb) return;
    connected = true;
    retryCount = 0;
    showStatus('Connected', true);
    current.focus();
  });
  current.addEventListener('disconnect', () => {
    if (current !== rfb || disposed) return;
    connected = false;
    showStatus('Connection lost. Reconnecting…');
    retryConnection();
  });
  current.addEventListener('securityfailure', event => {
    if (current === rfb) showStatus(`Connection failed: ${event.detail.reason || 'authentication'}. Retrying…`);
  });
  current.addEventListener('clipboard', event => {
    if (current !== rfb) return;
    clipboard = event.detail.text;
    if (desktop.dataset.clipboard !== 'false') vscode.postMessage({ type: 'copy', text: clipboard });
  });
}
window.addEventListener('message', event => {
  const message = event.data;
  if (message.type === 'connection') connect(message.port, message.token);
  if (message.type === 'paste') {
    if (!pastePending) return;
    pastePending = false;
    if (!connected) return;
    // Preserve LyX's native rich clipboard when pasting text it just copied.
    if (message.text !== clipboard) {
      if (!message.text) { showStatus('Clipboard has no plain text'); return; }
      rfb.clipboardPasteFrom(message.text);
      clipboard = message.text;
    }
    rfb.focus();
    const injectControl = controlsDown.size === 0;
    if (injectControl) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', true);
    rfb.sendKey(KeyTable.XK_v, 'KeyV');
    if (injectControl) rfb.sendKey(KeyTable.XK_Control_L, 'ControlLeft', false);
  }
  if (message.type === 'error') {
    pastePending = false;
    showStatus(message.text);
    if (!connected) retryConnection();
  }
});
window.addEventListener('pagehide', () => {
  disposed = true;
  clearTimeout(retryTimer);
  rfb?.disconnect();
});
connect(desktop.dataset.port, desktop.dataset.token);
