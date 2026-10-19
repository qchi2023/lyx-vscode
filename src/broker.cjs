'use strict';
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');
const { CONFIG: PROTOCOL, privateDirectory, pathsFor, atomicJson, canonicalFile,
  identity, isOwned, stopOwned, delay } = require('./common.cjs');
const { nativeCommand, closeChannel } = require('./native-ipc.cjs');

const CONFIG = { bodyLimit: 32768, maxSnapshotBytes: 64 * 1024 * 1024, displayFirst: 120, displayLast: 219,
  quitTimeoutMs: 30 * 60 * 1000 };

async function serve(options) {
  const locations = pathsFor(options.storageRoot);
  privateDirectory(locations.storage);
  privateDirectory(locations.runtime);
  if (fs.existsSync(locations.lock)) {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(locations.lock, 'utf8')); }
    catch { throw new Error('Broker lock is unreadable. Another broker may still be starting; inspect diagnostics before recovery.'); }
    if (isOwned(owner)) throw new Error('A retained Native LyX broker already owns this storage directory.');
    fs.unlinkSync(locations.lock);
  }
  const lock = fs.openSync(locations.lock, 'wx', 0o600);
  fs.writeFileSync(lock, JSON.stringify(identity(process.pid)));
  fs.closeSync(lock);

  const sessions = new Map();
  const pending = new Map();
  const watchers = new Map();
  const quitting = new Map();
  let server;
  let startupQueue = Promise.resolve();
  try {
    if (fs.existsSync(locations.registry)) {
      const saved = JSON.parse(fs.readFileSync(locations.registry, 'utf8'));
      if (saved.protocol !== PROTOCOL.protocol || !Array.isArray(saved.sessions)) throw new Error('Unsupported session registry format.');
      for (const session of saved.sessions) sessions.set(session.filename, session);
    }
  } catch (error) {
    fs.unlinkSync(locations.lock);
    throw new Error(`Session registry could not be read; it was preserved without overwriting it. ${error.message}`);
  }

  function persist() {
    if (fs.existsSync(locations.registry)) fs.copyFileSync(locations.registry, `${locations.registry}.bak`);
    atomicJson(locations.registry, { protocol: PROTOCOL.protocol, sessions: [...sessions.values()] });
  }
  const record = (session, name) => session.processes.find(item => item.name === name && isOwned(item));
  const nativeAlive = session => Boolean(record(session, 'lyx-app') || record(session, 'lyx'));
  function reconcileExit(session) {
    if (nativeAlive(session) || ['closed in LyX', 'ended explicitly'].includes(session.state)) return;
    const guardian = session.processes.findLast(item => item.name === 'lyx');
    try {
      const receipt = JSON.parse(fs.readFileSync(path.join(session.directory, 'native-exit.json')));
      if (receipt.owner?.pid === guardian?.pid && receipt.owner?.start === guardian?.start && receipt.owner?.boot === guardian?.boot) {
        session.state = receipt.code === 0 && !receipt.signal ? 'closed in LyX' : 'recovery required';
        session.recoveryRequired = session.state === 'recovery required';
      }
    } catch {}
  }
  function publicSession(session, connection = false) {
    const result = { id: session.id, filename: session.filename, currentFile: session.currentFile,
      state: session.state, live: nativeAlive(session), recoveryRequired: session.recoveryRequired,
      directory: session.directory, display: session.display, created: session.created,
      snapshots: session.snapshots || [], error: session.error, processes: session.processes };
    if (connection) Object.assign(result, { port: session.port, token: session.token });
    return result;
  }

  function snapshot(session) {
    try {
      const stat = fs.statSync(session.filename);
      if (stat.size > CONFIG.maxSnapshotBytes) {
        session.snapshotWarning = 'File exceeds the 64 MiB snapshot limit; native conflict handling still applies.';
        return;
      }
      const bytes = fs.readFileSync(session.filename);
      const hash = crypto.createHash('sha256').update(bytes).digest('hex');
      if (session.diskHash === hash) return;
      const directory = privateDirectory(path.join(session.directory, 'snapshots'));
      const filename = path.join(directory, `${Date.now()}-${hash.slice(0, 16)}.lyx`);
      fs.writeFileSync(filename, bytes, { flag: 'wx', mode: 0o600 });
      session.snapshots ||= [];
      session.snapshots.push({ filename, hash, at: new Date().toISOString(), size: bytes.length });
      session.diskHash = hash;
      session.fileMissing = false;
      persist();
    } catch (error) {
      if (error.code === 'ENOENT') session.fileMissing = true;
      else session.snapshotWarning = error.message;
      persist();
    }
  }
  function watch(session) {
    if (watchers.has(session.id)) return;
    try {
      const watcher = fs.watch(path.dirname(session.filename), (_, filename) => {
        if (!filename || filename.toString() === path.basename(session.filename)) snapshot(session);
      });
      watcher.on('error', error => { session.snapshotWarning = error.message; persist(); });
      watchers.set(session.id, watcher);
      snapshot(session);
    } catch (error) { session.snapshotWarning = error.message; persist(); }
  }

  function environment(session) {
    const env = { ...process.env, DISPLAY: session.display, XAUTHORITY: session.auth,
      XDG_CACHE_HOME: path.join(session.directory, 'cache'), QT_QPA_PLATFORM: 'xcb', QT_AUTO_SCREEN_SCALE_FACTOR: '0' };
    if (options.dependencyRoot) {
      env.LD_LIBRARY_PATH = [path.join(options.dependencyRoot, 'usr/lib/x86_64-linux-gnu'), env.LD_LIBRARY_PATH].filter(Boolean).join(':');
      env.XDG_DATA_DIRS = [path.join(options.dependencyRoot, 'usr/share'), env.XDG_DATA_DIRS || '/usr/local/share:/usr/share'].join(':');
    }
    delete env.WAYLAND_DISPLAY;
    delete env.DBUS_SESSION_BUS_ADDRESS;
    delete env.SESSION_MANAGER;
    delete env.ELECTRON_RUN_AS_NODE;
    return env;
  }

  async function launch(session, name, executable, args) {
    const log = fs.openSync(path.join(session.directory, `${name}.log`), 'a', 0o600);
    const child = spawn(executable, args, { env: environment(session), detached: true, stdio: ['ignore', log, log] });
    fs.closeSync(log);
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const owned = { name, ...identity(child.pid) };
    if (!owned.start) throw new Error(`${name} exited before its process identity could be recorded.`);
    session.processes.push(owned);
    child.on('error', error => { session.error = `${name}: ${error.message}`; persist(); });
    child.on('exit', (code, signal) => {
      session.lastExit = { name, code, signal, at: new Date().toISOString() };
      if (name === 'lyx' && session.state !== 'ended explicitly') {
        const applicationRemains = Boolean(record(session, 'lyx-app'));
        session.state = applicationRemains ? 'running' : code === 0 ? 'closed in LyX' : 'recovery required';
        session.recoveryRequired = !applicationRemains && code !== 0;
      }
      persist();
    });
    child.unref();
    persist();
  }

  async function waitFor(check, label) {
    const deadline = Date.now() + options.startupTimeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await delay(120);
    }
    throw new Error(`${label} timed out. Native buffers/profiles were retained. Run Native LyX: Retained Sessions to inspect them.`);
  }
  async function freePort() {
    return new Promise((resolve, reject) => {
      const listener = net.createServer();
      listener.on('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const port = listener.address().port;
        listener.close(error => error ? reject(error) : resolve(port));
      });
    });
  }
  function displayNumber() {
    for (let number = CONFIG.displayFirst; number <= CONFIG.displayLast; number++) {
      if (!fs.existsSync(`/tmp/.X${number}-lock`) && !fs.existsSync(`/tmp/.X11-unix/X${number}`)) return `:${number}`;
    }
    throw new Error('No unused private display between 120 and 219. Resolve retained sessions explicitly.');
  }
  async function bridge(session) {
    if (record(session, 'bridge')) return;
    if (!record(session, 'desktop')) throw new Error('The private desktop exited. Preserve this profile and use explicit session recovery.');
    session.port = await freePort();
    session.token = crypto.randomBytes(32).toString('hex');
    const tokens = path.join(session.directory, 'tokens');
    fs.writeFileSync(tokens, `${session.token}: unix_socket:${session.rfbSocket}\n`, { mode: 0o600 });
    await launch(session, 'bridge', options.websockifyPath, ['--token-plugin', 'TokenFile', '--token-source', tokens, `127.0.0.1:${session.port}`]);
    await waitFor(() => new Promise(resolve => {
      const client = net.connect({ host: '127.0.0.1', port: session.port });
      client.once('connect', () => { client.destroy(); resolve(true); });
      client.once('error', () => resolve(false));
    }), 'Local viewer bridge');
  }
  async function stopSession(session, decision, preserveProfile = true) {
    if (decision !== true) throw new Error('An explicit discard decision is required before ending any retained native session.');
    session.state = 'ended explicitly';
    session.recoveryRequired = false;
    for (const processRecord of [...session.processes].reverse()) stopOwned(processRecord);
    const deadline = Date.now() + 5000;
    while (session.processes.some(isOwned) && Date.now() < deadline) await delay(100);
    persist();
    if (session.processes.some(isOwned)) throw new Error('A retained process has not exited. Its ownership records were kept; inspect session logs before retrying.');
    closeChannel(session.pipe);
    if (!preserveProfile) throw new Error('Profiles are never automatically deleted.');
  }

  function quitSession(session) {
    const previous = quitting.get(session.id);
    if (previous?.status === 'waiting' || previous?.status === 'closing') return previous;
    const result = { status: 'waiting' };
    quitting.set(session.id, result);
    (async () => {
      try {
        if (nativeAlive(session)) {
          // Native LyX, including every buffer in this private process, owns
          // Save/Don't Save/Cancel. Never send a termination signal to it here.
          await nativeCommand(session.pipe, 'lyx-quit', '', {
            timeoutMs: CONFIG.quitTimeoutMs, completed: () => !nativeAlive(session)
          });
          const deadline = Date.now() + 1500;
          while (nativeAlive(session) && Date.now() < deadline) await delay(60);
        }
        if (nativeAlive(session)) { result.status = 'cancelled'; return; }
        reconcileExit(session);
        if (session.state !== 'closed in LyX' && session.state !== 'ended explicitly') {
          throw new Error('LyX exited unexpectedly while closing; its profile and autosaves were preserved.');
        }
        result.status = 'closing';
        // The native application has already exited by its own decision.
        await stopSession(session, true);
        result.status = 'closed';
      } catch (error) {
        result.status = 'error';
        result.error = error.message;
      }
    })();
    return result;
  }

  async function startSession(session) {
    session.runtime = privateDirectory(path.join(locations.runtime, session.id));
    session.directory = privateDirectory(path.join(locations.storage, 'sessions', session.id));
    for (const folder of ['profile', 'cache', 'tmp', 'snapshots']) privateDirectory(path.join(session.directory, folder));
    session.auth = path.join(session.runtime, 'Xauthority');
    session.rfbSocket = path.join(session.runtime, 'rfb.sock');
    session.pipe = path.join(session.runtime, 'lyxpipe');
    const shortTemp = path.join(session.runtime, 'tmp');
    const persistentTemp = path.join(session.directory, 'tmp');
    if (!fs.existsSync(shortTemp)) fs.symlinkSync(persistentTemp, shortTemp, 'dir');
    if (!fs.lstatSync(shortTemp).isSymbolicLink() || fs.readlinkSync(shortTemp) !== persistentTemp) {
      throw new Error('Private native temporary-directory alias has an unexpected target; preserved it for inspection.');
    }
    session.display = displayNumber();
    session.processes = [];
    session.state = 'starting';
    session.error = null;
    session.recoveryRequired = false;
    for (const filename of [session.rfbSocket, `${session.pipe}.in`, `${session.pipe}.out`]) {
      if (fs.existsSync(filename)) fs.unlinkSync(filename);
    }
    const env = environment(session);
    execFileSync(options.xauthPath, ['-f', session.auth, 'add', session.display, '.', crypto.randomBytes(16).toString('hex')], { env, timeout: 5000 });
    persist();
    await launch(session, 'desktop', options.vncPath, [session.display, '-geometry', `${options.width}x${options.height}`,
      '-depth', '24', '-dpi', String(options.dpi), '-nolisten', 'tcp', '-auth', session.auth, '-rfbport', '-1',
      '-rfbunixpath', session.rfbSocket, '-rfbunixmode', '0600', '-SecurityTypes', 'None', '-AlwaysShared',
      '-MaxDisconnectionTime', '0', '-MaxIdleTime', '0']);
    await waitFor(() => fs.existsSync(session.rfbSocket), 'Virtual display');
    const wmConfig = path.join(session.directory, 'openbox.xml');
    fs.writeFileSync(wmConfig, '<?xml version="1.0"?><openbox_config xmlns="http://openbox.org/3.4/rc"><focus><focusNew>yes</focusNew></focus><desktops><number>1</number></desktops><applications><application class="lyx" type="normal"><decor>no</decor><maximized>yes</maximized></application></applications></openbox_config>', { mode: 0o600 });
    await launch(session, 'wm', options.windowManagerPath, ['--sm-disable', '--config-file', wmConfig]);
    const preference = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const preferences = path.join(session.directory, 'profile/preferences');
    if (!fs.existsSync(preferences)) {
      fs.writeFileSync(preferences, `Format 38\n\\tempdir_path "${preference(shortTemp)}"\n\\serverpipe "${preference(session.pipe)}"\n\\autosave ${options.autosaveSeconds}\n\\use_lastfilepos false\n`, { mode: 0o600 });
    }
    await launch(session, 'lyx', options.nodePath, [path.join(__dirname, 'native-launch.cjs'),
      path.join(session.directory, 'native-exit.json'), options.dbusPath, '--', options.lyxPath, '--no-remote', '-userdir',
      path.join(session.directory, 'profile'), '-geometry', `${options.width}x${options.height}+0+0`, session.filename]);
    await bridge(session);
    await waitFor(() => {
      if (!nativeAlive(session)) throw new Error(`LyX exited during startup. See ${session.directory}/lyx.log; use explicit recovery before reopening.`);
      try { return /lyx/i.test(execFileSync(options.wmctrlPath, ['-lx'], { env, encoding: 'utf8', timeout: 2000 })); }
      catch { return false; }
    }, 'Native LyX window');
    const windows = execFileSync(options.wmctrlPath, ['-lpx'], { env, encoding: 'utf8', timeout: 2000 });
    const nativeWindow = windows.split('\n').map(line => line.trim().split(/\s+/)).find(fields => /lyx/i.test(fields[3] || ''));
    const application = nativeWindow && identity(Number(nativeWindow[2]));
    const guardian = record(session, 'lyx');
    if (!application || application.group !== guardian?.pid) throw new Error('Cannot verify native LyX window process ownership. Its session was retained for inspection.');
    session.processes.push({ name: 'lyx-app', ...application, groupOwned: true });
    session.windowId = nativeWindow[0];
    session.state = 'running';
    watch(session);
    persist();
    return session;
  }

  async function checkIdentity(session, restore, passive = false) {
    try {
      const rows = execFileSync(options.wmctrlPath, ['-lpx'], { env: environment(session), encoding: 'utf8', timeout: 2000 }).split('\n');
      const row = session.windowId ? rows.find(line => line.startsWith(`${session.windowId} `)) : rows.find(line => /lyx/i.test(line));
      const title = row?.match(/^\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(.*)$/)?.[1];
      if (passive && title && title === session.nativeTitle && session.currentFile) {
        return { matches: session.currentFile === session.filename, actual: session.currentFile, expected: session.filename, cached: true };
      }
      let actual = await nativeCommand(session.pipe, 'server-get-filename');
      if (actual && actual !== session.filename && restore) {
        await nativeCommand(session.pipe, 'buffer-switch', session.filename);
        actual = await nativeCommand(session.pipe, 'server-get-filename');
      }
      session.currentFile = actual;
      if (actual && title) session.nativeTitle = title;
      persist();
      return { matches: actual ? actual === session.filename : null, actual, expected: session.filename };
    } catch (error) {
      // Native modal dialogs must remain usable; an unanswered query is not a
      // reason to replace a buffer or terminate its process.
      return { matches: null, expected: session.filename, warning: error.message };
    }
  }

  async function open(file, root, attach = false) {
    const filename = canonicalFile(file, root);
    let session = sessions.get(filename);
    if (quitting.get(session?.id)?.status === 'closing') {
      throw new Error('The previous native session is finishing its normal shutdown. Try opening it again in a moment.');
    }
    if (session) reconcileExit(session);
    for (const other of sessions.values()) {
      if (other.filename !== filename && other.currentFile === filename && nativeAlive(other)) {
        throw new Error('This file is already open through native File Open/Save As in another retained session. Resolve that session before starting a second writer.');
      }
    }
    if (session && nativeAlive(session)) {
      await bridge(session);
      const checked = quitting.get(session.id)?.status === 'waiting' ? null : await checkIdentity(session, !attach, attach);
      return { ...publicSession(session, true), identity: checked };
    }
    if (attach) {
      throw new Error('This native session has stopped. Reopen the file with Native LyX to start it again.');
    }
    if (session && session.state !== 'closed in LyX' && session.state !== 'ended explicitly') {
      session.recoveryRequired = true;
      session.state = 'recovery required';
      persist();
      const error = new Error('A previous native session ended unexpectedly. Use Native LyX: Recover Session; its profile, autosaves and snapshots were preserved.');
      error.code = 'RECOVERY_REQUIRED';
      throw error;
    }
    if ([...sessions.values()].filter(nativeAlive).length >= options.maxSessions) throw new Error('Native session limit reached. Resolve a retained session explicitly before opening another document.');
    if (session) await stopSession(session, true);
    session ||= { id: crypto.randomBytes(8).toString('hex'), filename, root: fs.realpathSync(root),
      created: new Date().toISOString(), processes: [], snapshots: [] };
    sessions.set(filename, session);
    quitting.delete(session.id);
    try { await startSession(session); }
    catch (error) {
      session.error = error.message;
      if (!nativeAlive(session)) {
        for (const owned of [...session.processes].reverse()) stopOwned(owned);
        session.state = 'recovery required';
        session.recoveryRequired = true;
      }
      persist();
      throw error;
    }
    return publicSession(session, true);
  }

  async function handle(route, body) {
    if (route === '/health') return { protocol: PROTOCOL.protocol, ...identity(process.pid), engine: __dirname,
      capabilities: ['graceful-quit'], pending: pending.size + [...quitting.values()].filter(item => ['waiting', 'closing'].includes(item.status)).length };
    if (route === '/sessions') return [...sessions.values()].map(session => { reconcileExit(session); return publicSession(session); });
    const session = [...sessions.values()].find(item => item.id === body.id);
    if (route === '/quit' || route === '/quit-state') {
      if (!session) throw new Error('Unknown retained session.');
      return route === '/quit' ? quitSession(session) : quitting.get(session.id) || { status: 'cancelled' };
    }
    if (route === '/end') {
      if (!session) throw new Error('Unknown retained session.');
      const operation = startupQueue.then(() => stopSession(session, body.discardConfirmed));
      startupQueue = operation.catch(() => {});
      await operation;
      return { ended: session.id };
    }
    if (route === '/identity') {
      if (!session || !nativeAlive(session)) throw new Error('Native session is not running; use explicit session recovery.');
      if (quitting.get(session.id)?.status === 'waiting') return { matches: null, expected: session.filename };
      return checkIdentity(session, Boolean(body.restore), Boolean(body.passive));
    }
    if (route === '/recover') {
      if (!session || body.confirmed !== true) throw new Error('Choose a retained session and explicitly confirm reopening its preserved profile.');
      if (nativeAlive(session)) throw new Error('This native session is still running. Reopen its editor instead of recovering it.');
      const operation = startupQueue.then(async () => {
        // Another request may already have recovered it while this one queued.
        if (nativeAlive(session)) { await bridge(session); return session; }
        if ([...sessions.values()].filter(nativeAlive).length >= options.maxSessions) {
          throw new Error('Native session limit reached. Close a native session before reopening another document.');
        }
        await stopSession(session, true);
        return startSession(session);
      });
      startupQueue = operation.catch(() => {});
      await operation;
      return publicSession(session, true);
    }
    if (route === '/shutdown') {
      if (pending.size) throw new Error('Wait for pending session openings before shutting down the broker.');
      if ([...sessions.values()].some(item => item.processes.some(isOwned))) throw new Error('Resolve retained sessions explicitly before shutting down the broker.');
      setTimeout(() => server.close(() => {
        if (isOwned(JSON.parse(fs.readFileSync(locations.lock, 'utf8')))) fs.unlinkSync(locations.lock);
        process.exit(0);
      }), 50);
      return { stopping: true };
    }
    if (!['/open', '/attach'].includes(route)) throw new Error('Unknown native runtime operation.');
    const filename = canonicalFile(body.filename, body.root);
    if (!pending.has(filename)) {
      const operation = startupQueue.then(() => open(filename, body.root, route === '/attach'));
      startupQueue = operation.catch(() => {});
      pending.set(filename, operation.finally(() => pending.delete(filename)));
    }
    return pending.get(filename);
  }

  for (const session of sessions.values()) {
    reconcileExit(session);
    if (nativeAlive(session)) { session.state = 'running'; watch(session); }
    else if (!['closed in LyX', 'ended explicitly'].includes(session.state)) {
      session.state = 'recovery required'; session.recoveryRequired = true;
    }
  }
  persist();
  if (fs.existsSync(locations.socket)) fs.unlinkSync(locations.socket);
  server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'POST') throw new Error('Only local POST requests are accepted.');
      let text = '';
      for await (const chunk of req) {
        text += chunk;
        if (Buffer.byteLength(text) > CONFIG.bodyLimit) throw new Error('Native runtime request too large.');
      }
      const result = await handle(req.url, JSON.parse(text || '{}'));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (error) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error.message, code: error.code }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(locations.socket, () => { fs.chmodSync(locations.socket, 0o600); resolve(); });
  });
  return { server, locations };
}

if (require.main === module) {
  process.umask(0o077);
  try {
    const options = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    serve(options).catch(error => { console.error(error.message); process.exitCode = 1; });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { serve };
