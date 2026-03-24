const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// --- Helpers ---

function getInput(name) {
  // GitHub Actions sets INPUT_<NAME> with name uppercased, dashes preserved
  return process.env[`INPUT_${name.toUpperCase()}`] || '';
}

function saveState(name, value) {
  fs.appendFileSync(process.env.GITHUB_STATE, `${name}=${value}${os.EOL}`);
}

function fail(msg) {
  process.stdout.write(`::error::${msg}${os.EOL}`);
  process.exit(1);
}

function run(cmd) {
  execSync(cmd, { stdio: 'inherit' });
}

function capture(cmd) {
  return execSync(cmd, { encoding: 'utf8' }).trim();
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// --- Validate required inputs ---

const cacheName = getInput('CACHE-NAME');
const token = getInput('TOKEN');
if (!cacheName) fail("Input 'cache-name' is required");
if (!token) fail("Input 'token' is required");

// Ensure gh CLI can authenticate for release downloads
if (!process.env.GH_TOKEN) {
  process.env.GH_TOKEN = process.env.GITHUB_TOKEN || '';
}

// --- 1. Detect platform ---

const ASSETS = {
  'Linux-X64': 'cerbernix-x86_64-unknown-linux-gnu.tar.gz',
  'Linux-ARM64': 'cerbernix-aarch64-unknown-linux-gnu.tar.gz',
  'macOS-X64': 'cerbernix-x86_64-apple-darwin.tar.gz',
  'macOS-ARM64': 'cerbernix-aarch64-apple-darwin.tar.gz',
};

const platform = `${process.env.RUNNER_OS}-${process.env.RUNNER_ARCH}`;
const asset = ASSETS[platform];
if (!asset) fail(`Unsupported platform: ${platform}`);
console.log(`Platform: ${platform} → ${asset}`);

// --- 2. Resolve version ---

let version = getInput('VERSION') || 'latest';
if (version === 'latest') {
  version = capture(
    'gh release view --repo cerbernix/client-testing --json tagName --jq .tagName'
  );
}
console.log(`Version: ${version}`);

// --- 3. Download and install ---

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'cerbernix-'));
try {
  execSync(
    `gh release download ${quote(version)} --repo cerbernix/client-testing --pattern ${quote(asset)} --dir ${quote(tmpdir)}`,
    { stdio: 'inherit' }
  );
  run(`tar -xzf ${quote(path.join(tmpdir, asset))} -C ${quote(tmpdir)}`);
  run(`sudo install -m 755 ${quote(path.join(tmpdir, 'cerbernix'))} /usr/local/bin/cerbernix`);
} finally {
  fs.rmSync(tmpdir, { recursive: true, force: true });
}
console.log(`Installed cerbernix ${version}`);
try { run('cerbernix --version'); } catch {}

// --- 4. Configure post-build-hook ---

const hookScript = [
  '#!/bin/sh',
  'if [ -e /tmp/cerbernix.sock ]; then',
  '  exec /usr/local/bin/cerbernix hook --socket /tmp/cerbernix.sock',
  'fi',
].join('\n') + '\n';

const hookTmp = path.join(os.tmpdir(), 'cerbernix-post-build-hook');
fs.writeFileSync(hookTmp, hookScript, { mode: 0o755 });
run(`sudo install -m 755 ${quote(hookTmp)} /usr/local/bin/cerbernix-post-build-hook`);
fs.unlinkSync(hookTmp);

// Append to nix.conf if not already present
let nixConf = '';
try { nixConf = fs.readFileSync('/etc/nix/nix.conf', 'utf8'); } catch {}

if (nixConf.includes('post-build-hook')) {
  console.log('::warning::post-build-hook already configured in /etc/nix/nix.conf — skipping');
} else {
  run("echo 'post-build-hook = /usr/local/bin/cerbernix-post-build-hook' | sudo tee -a /etc/nix/nix.conf");
}

// Restart nix-daemon to pick up config change
if (process.env.RUNNER_OS === 'Linux') {
  try { run('sudo systemctl restart nix-daemon.service'); } catch {}
} else if (process.env.RUNNER_OS === 'macOS') {
  try {
    run('sudo launchctl kickstart -k system/org.nixos.nix-daemon');
  } catch {
    try {
      run('sudo launchctl stop org.nixos.nix-daemon');
      run('sudo launchctl start org.nixos.nix-daemon');
    } catch {}
  }
}

// --- 5. Start daemon ---

const debounce = getInput('DEBOUNCE') || '5';
const maxUploads = getInput('MAX-UPLOADS') || '8';
const logPath = '/tmp/cerbernix-daemon.log';
const socketPath = '/tmp/cerbernix.sock';

const logFd = fs.openSync(logPath, 'w');
const daemon = spawn('cerbernix', [
  'daemon',
  '--cache-url', `https://${cacheName}.cerbernix.com`,
  '--socket', socketPath,
  '--debounce', debounce,
  '--max-uploads', maxUploads,
], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  env: { ...process.env, CERBERNIX_TOKEN: token },
});
daemon.unref();
fs.closeSync(logFd);

const pid = daemon.pid;
console.log(`Started cerbernix daemon (PID ${pid})`);

saveState('daemon_pid', String(pid));
saveState('log_path', logPath);

// Wait for socket to appear
const TIMEOUT_S = 30;
let ready = false;
for (let i = 1; i <= TIMEOUT_S; i++) {
  if (fs.existsSync(socketPath)) {
    console.log(`Daemon ready (socket appeared after ${i}s)`);
    ready = true;
    break;
  }
  // Check if daemon exited early
  try {
    process.kill(pid, 0);
  } catch {
    const log = fs.readFileSync(logPath, 'utf8');
    fail(`Cerbernix daemon exited unexpectedly:\n${log}`);
  }
  sleepMs(1000);
}

if (!ready) {
  const log = fs.readFileSync(logPath, 'utf8');
  fail(`Timed out waiting for cerbernix socket after ${TIMEOUT_S}s:\n${log}`);
}

// --- Utilities ---

function quote(s) {
  // Shell-safe single quoting
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
