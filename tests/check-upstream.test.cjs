'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { check, hookOutput } = require('../scripts/check-upstream.cjs');

function git(repo, ...args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function write(repo, name, content) {
  const file = path.join(repo, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}
function commit(repo, name, content) {
  write(repo, name, content);
  git(repo, 'add', '--', name);
  git(repo, 'commit', '-qm', 'Synthetic test commit');
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'upstream watch tests '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const upstream = path.join(root, 'upstream');
  const repo = path.join(root, 'working checkout');
  const workspace = path.join(root, 'workspace');
  const dataDir = path.join(root, 'data');
  fs.mkdirSync(upstream);
  fs.mkdirSync(workspace);
  git(upstream, 'init', '-b', 'main');
  git(upstream, 'config', 'user.name', 'Fixture');
  git(upstream, 'config', 'user.email', 'fixture@example.com');
  commit(upstream, 'source.js', 'base\n');
  git(root, 'clone', upstream, repo);
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.com');
  const config = { enabled: true, repo: path.relative(workspace, repo), remote: 'origin', branch: 'main' };
  write(workspace, '.codex/upstream-watch.json', JSON.stringify(config));
  return { root, upstream, repo, workspace, dataDir, config, run: (options = {}) => check(workspace, { dataDir, ...options }) };
}

test('detects relevant commits without changing branch, index, working files or FETCH_HEAD', t => {
  const f = fixture(t);
  commit(f.repo, 'source.js', 'local contribution\n');
  write(f.repo, 'source.js', 'uncommitted user work\n');
  git(f.repo, 'fetch', 'origin');
  const before = { head: git(f.repo, 'rev-parse', 'HEAD'), index: git(f.repo, 'write-tree'), status: git(f.repo, 'status', '--porcelain') };
  const fetchHead = fs.readFileSync(path.join(f.repo, '.git', 'FETCH_HEAD'), 'utf8');
  commit(f.upstream, 'source.js', 'upstream fix\n');
  const result = f.run();
  assert.equal(result.status, 'checked');
  assert.equal(result.relevant, true);
  assert.deepEqual(result.paths, ['source.js']);
  assert.equal(result.count, 1);
  assert.deepEqual({ head: git(f.repo, 'rev-parse', 'HEAD'), index: git(f.repo, 'write-tree'), status: git(f.repo, 'status', '--porcelain') }, before);
  assert.equal(fs.readFileSync(path.join(f.repo, '.git', 'FETCH_HEAD'), 'utf8'), fetchHead);
  assert.equal(fs.readFileSync(path.join(f.repo, 'source.js'), 'utf8'), 'uncommitted user work\n');
});

test('unrelated commits stay quiet and repeated hooks honor cooldown', t => {
  const f = fixture(t);
  write(f.repo, 'source.js', 'dirty\n');
  commit(f.upstream, 'unrelated.js', 'other change\n');
  const result = f.run({ now: 100000 });
  assert.equal(result.relevant, false);
  assert.deepEqual(hookOutput('SessionStart', result), {});
  assert.equal(f.run({ now: 100001 }).status, 'cooldown');
  assert.equal(f.run({ now: 100002, force: true }).count, 0);
});

test('new commits after a successful check are compared with the prior upstream tip', t => {
  const f = fixture(t);
  write(f.repo, 'source.js', 'dirty\n');
  assert.equal(f.run().count, 0);
  commit(f.upstream, 'source.js', 'new fix\n');
  const result = f.run({ force: true });
  assert.equal(result.count, 1);
  assert.equal(result.relevant, true);
});

test('missing configuration and disabled configuration do not fetch', t => {
  const f = fixture(t);
  assert.equal(check(f.root, { dataDir: f.dataDir }).status, 'unconfigured');
  write(f.workspace, '.codex/upstream-watch.json', JSON.stringify({ enabled: false }));
  assert.equal(f.run().status, 'unconfigured');
  assert.equal(fs.existsSync(f.dataDir), false);
});

test('bad config, missing branch and failed fetch produce bounded private-data-free errors', t => {
  const f = fixture(t);
  write(f.workspace, '.codex/upstream-watch.json', '{invalid');
  assert.equal(f.run().status, 'error');
  write(f.workspace, '.codex/upstream-watch.json', JSON.stringify({ ...f.config, branch: 'missing' }));
  assert.equal(f.run({ force: true }).status, 'error');
  git(f.repo, 'remote', 'set-url', 'origin', path.join(f.root, 'test-secret-not-for-output'));
  write(f.workspace, '.codex/upstream-watch.json', JSON.stringify(f.config));
  const result = f.run({ force: true });
  assert.equal(result.status, 'error');
  assert.ok(!JSON.stringify(result).includes('test-secret-not-for-output'));
});

test('concurrent checks use a lock and release it after completion', t => {
  const f = fixture(t);
  fs.mkdirSync(f.dataDir);
  const id = crypto.createHash('sha256').update(JSON.stringify([f.repo, f.config.remote, f.config.branch])).digest('hex');
  const lock = path.join(f.dataDir, `${id}.lock`);
  fs.mkdirSync(lock);
  assert.equal(f.run().status, 'busy');
  fs.rmdirSync(lock);
  assert.equal(f.run().status, 'checked');
  assert.equal(fs.existsSync(lock), false);
});

test('secret-file metadata and commit subjects are not emitted', t => {
  const f = fixture(t);
  commit(f.upstream, '.env', 'synthetic only\n');
  commit(f.repo, '.env', 'local synthetic\n');
  const result = f.run();
  assert.equal(result.relevant, true);
  assert.deepEqual(result.paths, []);
  assert.ok(!JSON.stringify(result).includes('synthetic'));
});

test('force-pushed upstream history is re-compared from the current merge base', t => {
  const f = fixture(t);
  write(f.repo, 'source.js', 'dirty\n');
  const base = git(f.upstream, 'rev-parse', 'HEAD');
  commit(f.upstream, 'source.js', 'first fix\n');
  assert.equal(f.run().count, 1);
  git(f.upstream, 'checkout', '-b', 'replacement', base);
  commit(f.upstream, 'source.js', 'replacement fix\n');
  git(f.upstream, 'branch', '-f', 'main', 'replacement');
  const result = f.run({ force: true });
  assert.equal(result.status, 'checked');
  assert.equal(result.count, 1);
  assert.equal(result.relevant, true);
});

test('hook output is valid event-specific context and does not claim semantic equivalence', () => {
  const output = hookOutput('PostToolUse', { relevant: true, count: 1, paths: ['source.js'] });
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(output.hookSpecificOutput.additionalContext, /does not prove a bug is fixed/);
});

test('plugin manifest, catalog and hooks resolve inside the package', () => {
  const root = path.resolve(__dirname, '..');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'plugin.json'), 'utf8'));
  assert.equal(manifest.name, 'upstream-watch');
  assert.equal(manifest.version, '0.1.0');
  const hooks = JSON.parse(fs.readFileSync(path.join(root, manifest.extensions['com.openai'].hooks), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks), ['SessionStart', 'UserPromptSubmit', 'PostToolUse']);
  for (const groups of Object.values(hooks.hooks)) for (const group of groups) for (const handler of group.hooks) {
    assert.equal(handler.type, 'command');
    assert.equal(handler.async, true);
    assert.match(handler.command, /PLUGIN_ROOT/);
  }
  const catalog = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(path.resolve(root, catalog.plugins[0].source.path), root);
});
