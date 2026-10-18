'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const http = require('node:http');

const CONFIG = { protocol: 1, requestTimeoutMs: 90000, maxResponseBytes: 4 * 1024 * 1024 };

function privateDirectory(location) {
  fs.mkdirSync(location, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(location);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()) {
    throw new Error(`Private state directory must be a real directory owned by this user: ${location}`);
  }
  fs.chmodSync(location, 0o700);
  return location;
}

function pathsFor(storageRoot) {
  const storage = path.resolve(storageRoot);
  const tag = crypto.createHash('sha256').update(storage).digest('hex').slice(0, 12);
  const runtimeBase = process.env.XDG_RUNTIME_DIR || path.join(os.tmpdir(), `native-lyx-${process.getuid()}`);
  const runtime = path.join(runtimeBase, `native-lyx-${tag}`);
  return { storage, runtime, socket: path.join(runtime, 'broker-v1.sock'),
    registry: path.join(storage, 'registry-v1.json'), lock: path.join(storage, 'broker-v1.lock'),
    config: path.join(storage, 'broker-v1.json'), engines: path.join(storage, 'engines') };
}

function atomicJson(filename, value) {
  const temporary = `${filename}.${process.pid}.new`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2), { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, filename);
}

function canonicalFile(filename, workspace) {
  if (typeof filename !== 'string' || /[\r\n]/.test(filename)) {
    throw new Error('LyX file paths containing line breaks cannot be used with the native IPC protocol.');
  }
  const file = fs.realpathSync(filename);
  const root = fs.realpathSync(workspace);
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Select a .lyx file inside its trusted local workspace, including the resolved symlink target.');
  }
  if (!/\.lyx$/i.test(file) || !fs.statSync(file).isFile()) throw new Error('Select an existing regular .lyx file.');
  return file;
}

function identity(pid) {
  try {
    const text = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).trim().split(/\s+/);
    if (fields[0] === 'Z') return null;
    return { pid: Number(pid), start: fields[19], group: Number(fields[2]),
      boot: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim() };
  } catch { return null; }
}
function isOwned(record) {
  const current = record && identity(record.pid);
  return Boolean(record?.start && record.boot && current?.start === record.start && current.boot === record.boot);
}
function stopOwned(record, signal = 'SIGTERM') {
  const current = record && identity(record.pid);
  if (!current || current.start !== record.start || current.boot !== record.boot) return false;
  const ownedGroup = current.group === current.pid || (record.groupOwned === true && current.group === record.group);
  try { process.kill(ownedGroup ? -current.group : current.pid, signal); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  return true;
}

function request(socketPath, route, body = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({ socketPath, path: route, method: 'POST', headers: {
      'content-type': 'application/json', 'content-length': Buffer.byteLength(data)
    } }, response => {
      let result = '';
      response.on('data', chunk => {
        result += chunk;
        if (Buffer.byteLength(result) > CONFIG.maxResponseBytes) req.destroy(new Error('Broker response exceeded its limit.'));
      });
      response.on('end', () => {
        try {
          const value = JSON.parse(result);
          if (response.statusCode !== 200) {
            const error = new Error(value.error || 'Native LyX request failed.');
            error.code = value.code;
            reject(error);
          } else resolve(value);
        } catch (error) { reject(error); }
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error('Native LyX request timed out. Retained native sessions were not terminated.')));
    req.on('error', reject);
    req.end(data);
  });
}

function fileHash(filename) { return crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex'); }
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

module.exports = { CONFIG, privateDirectory, pathsFor, atomicJson, canonicalFile, identity, isOwned, stopOwned, request, fileHash, delay };
