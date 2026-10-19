'use strict';
const fs = require('node:fs');
const crypto = require('node:crypto');
const { delay } = require('./common.cjs');

const CONFIG = { timeoutMs: 2500, pollMs: 30, readBytes: 65536 };
const pending = new Map();
const channels = new Map();

async function channel(prefix) {
  const deadline = Date.now() + CONFIG.timeoutMs;
  while (true) {
    let read;
    let write;
    try {
      const input = fs.statSync(`${prefix}.in`);
      const output = fs.statSync(`${prefix}.out`);
      const previous = channels.get(prefix);
      if (previous && previous.input === input.ino && previous.output === output.ino) return previous;
      if (previous) {
        fs.closeSync(previous.read);
        fs.closeSync(previous.write);
        channels.delete(prefix);
      }
      // Keep both ends open between queries. Closing the last input writer
      // causes native LyX to reset its FIFO server and race subsequent queries.
      read = fs.openSync(`${prefix}.out`, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      write = fs.openSync(`${prefix}.in`, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);
      const result = { read, write, input: input.ino, output: output.ino };
      channels.set(prefix, result);
      return result;
    } catch (error) {
      if (read !== undefined) fs.closeSync(read);
      if (write !== undefined) fs.closeSync(write);
      if (!['ENOENT', 'ENXIO'].includes(error.code) || Date.now() >= deadline) throw error;
      await delay(CONFIG.pollMs);
    }
  }
}

async function exchange(prefix, command, argument = '', options = {}) {
  if (/[\r\n]/.test(command + argument)) throw new Error('Native command arguments cannot contain line breaks.');
  const client = `native-lyx-${crypto.randomBytes(6).toString('hex')}`;
  const { read, write } = await channel(prefix);
    fs.writeSync(write, `LYXCMD:${client}:${command}:${argument}\n`);
    let text = '';
    const buffer = Buffer.alloc(CONFIG.readBytes);
    const deadline = Date.now() + (options.timeoutMs ?? CONFIG.timeoutMs);
    while (Date.now() < deadline) {
      if (options.completed?.()) return;
      try {
        const count = fs.readSync(read, buffer, 0, buffer.length, null);
        text += buffer.toString('utf8', 0, count);
      } catch (error) { if (!['EAGAIN', 'EWOULDBLOCK'].includes(error.code)) throw error; }
      for (const line of text.split('\n')) {
        const start = `INFO:${client}:${command}:`;
        if (line.startsWith(start)) return line.slice(start.length).trimEnd();
        if (line.startsWith(`ERROR:${client}:`)) throw new Error(`Native LyX rejected ${command}: ${line.split(':').slice(3).join(':')}`);
      }
      await delay(CONFIG.pollMs);
    }
    throw new Error('Native LyX did not answer its local command pipe; finish any open modal dialog and try again.');
}

function nativeCommand(prefix, command, argument = '', options = {}) {
  const previous = pending.get(prefix) || Promise.resolve();
  const result = previous.catch(() => {}).then(() => exchange(prefix, command, argument, options));
  pending.set(prefix, result);
  result.finally(() => { if (pending.get(prefix) === result) pending.delete(prefix); }).catch(() => {});
  return result;
}
function closeChannel(prefix) {
  const current = channels.get(prefix);
  if (!current) return;
  channels.delete(prefix);
  fs.closeSync(current.read);
  fs.closeSync(current.write);
}
module.exports = { nativeCommand, closeChannel };
