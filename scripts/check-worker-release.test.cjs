const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, 'check-worker-release.cjs'), 'utf8');
function check(transform) {
  const messages = [];
  vm.runInNewContext(script, {
    __dirname,
    process: { argv: [] },
    console: { log: message => messages.push(message) },
    require(name) {
      if (name !== 'node:fs') return require(name);
      return { ...fs, readFileSync(file, encoding) {
        const data = fs.readFileSync(file, encoding);
        return /\.(py|toml)$/.test(file) ? transform(data) : data;
      } };
    },
  });
  return messages;
}

test('LF and Windows CRLF checkouts match the recorded worker fingerprint', () => {
  assert.deepEqual(check(text => text.replace(/\r\n/g, '\n')), check(text => text.replace(/\r?\n/g, '\r\n')));
});

test('normalizing line endings still rejects real worker source changes', () => {
  assert.throws(() => check(text => text + '\n# changed source\n'), /Worker source changed: bump BOTH versions/);
});
