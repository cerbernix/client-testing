const { execSync, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const { URL } = require('url');

// --- Helpers ---

function getInput(name) {
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

const debugEnabled =
  (getInput('DEBUG') || process.env.CERBERNIX_DEBUG || '').toLowerCase() === 'true' ||
  process.env.ACTIONS_STEP_DEBUG === 'true' ||
  process.env.RUNNER_DEBUG === '1';

function debug(msg) {
  if (debugEnabled) process.stdout.write(`::debug::${msg}${os.EOL}`);
}

function maskValue(v) {
  if (!v) return;
  process.stdout.write(`::add-mask::${v}${os.EOL}`);
}

function httpRequest(method, urlStr, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const opts = {
      method,
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      headers: { ...headers },
    };
    if (body) {
      opts.headers['Content-Length'] = Buffer.byteLength(body);
    }
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// --- Validate cache-name ---

const cacheName = getInput('CACHE-NAME') || process.env.CERBERNIX_CACHE_NAME || '';
if (!cacheName) fail("Input 'cache-name' (or env CERBERNIX_CACHE_NAME) is required");

// --- Resolve token (direct or via OIDC exchange) ---

async function resolveToken() {
  const direct = getInput('TOKEN') || process.env.CERBERNIX_TOKEN || '';
  if (direct) {
    debug('Using token from input/CERBERNIX_TOKEN env');
    if (!direct.startsWith('cbx_')) {
      process.stdout.write(`::warning::Provided token does not start with 'cbx_' — server will reject it${os.EOL}`);
    }
    return direct;
  }

  const reqUrl = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const reqTok = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!reqUrl || !reqTok) {
    fail(
      "No 'token' input and OIDC env vars are missing. " +
      "Set the workflow's 'permissions: id-token: write' and either provide 'token' or run with OIDC."
    );
  }

  // Audience is fixed per-cache; the server validates against this exact value.
  const audience = `https://${cacheName}.cerbernix.com`;
  const scope = getInput('OIDC-SCOPE') || 'rw';
  const ttl = parseInt(getInput('OIDC-TTL') || '3600', 10);

  console.log(`OIDC: requesting JWT (audience=${audience})`);

  // 1. Get the GitHub OIDC JWT
  const jwtUrl = `${reqUrl}&audience=${encodeURIComponent(audience)}`;
  debug(`OIDC: GET ${jwtUrl.replace(/[?&]token=[^&]*/, '')}`);
  let jwtResp;
  try {
    jwtResp = await httpRequest('GET', jwtUrl, {
      headers: { Authorization: `Bearer ${reqTok}` },
    });
  } catch (e) {
    fail(`OIDC: failed to contact GitHub OIDC endpoint: ${e.message}`);
  }
  if (jwtResp.status !== 200) {
    fail(
      `OIDC: GitHub OIDC request failed (HTTP ${jwtResp.status}). ` +
      `Body: ${jwtResp.body.slice(0, 500)}`
    );
  }
  let jwtJson;
  try { jwtJson = JSON.parse(jwtResp.body); } catch (e) {
    fail(`OIDC: GitHub OIDC response was not JSON: ${jwtResp.body.slice(0, 500)}`);
  }
  const jwt = jwtJson.value;
  if (!jwt || typeof jwt !== 'string') {
    fail(`OIDC: GitHub OIDC response missing 'value' field: ${jwtResp.body.slice(0, 500)}`);
  }
  maskValue(jwt);

  // Decode and log claims for debugging (no signature verify)
  try {
    const parts = jwt.split('.');
    if (parts.length === 3) {
      const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
      console.log('OIDC: JWT claims:');
      console.log(`  sub: ${claims.sub}`);
      console.log(`  repository: ${claims.repository}`);
      console.log(`  repository_owner: ${claims.repository_owner}`);
      console.log(`  ref: ${claims.ref}`);
      console.log(`  workflow: ${claims.workflow}`);
      console.log(`  workflow_ref: ${claims.workflow_ref || claims.job_workflow_ref || ''}`);
      console.log(`  actor: ${claims.actor}`);
      console.log(`  environment: ${claims.environment || '(none)'}`);
      console.log(`  aud: ${Array.isArray(claims.aud) ? claims.aud.join(',') : claims.aud}`);
    }
  } catch (e) {
    debug(`OIDC: could not decode JWT claims: ${e.message}`);
  }

  // 2. Exchange JWT for cbx_ token
  const exchangeUrl = `https://${cacheName}.cerbernix.com/oidc/token`;
  console.log(`OIDC: exchanging JWT at ${exchangeUrl} (scope=${scope}, ttl=${ttl})`);
  let exchResp;
  try {
    exchResp = await httpRequest('POST', exchangeUrl, {
      headers: {
        Authorization: `Bearer ${jwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ scope, ttl }),
    });
  } catch (e) {
    fail(`OIDC: failed to contact ${exchangeUrl}: ${e.message}`);
  }
  if (exchResp.status !== 200) {
    fail(
      `OIDC: token exchange failed (HTTP ${exchResp.status}). ` +
      `Body: ${exchResp.body.slice(0, 500)}`
    );
  }
  let exchJson;
  try { exchJson = JSON.parse(exchResp.body); } catch (e) {
    fail(`OIDC: exchange response was not JSON: ${exchResp.body.slice(0, 500)}`);
  }
  if (!exchJson.token || typeof exchJson.token !== 'string' || !exchJson.token.startsWith('cbx_')) {
    fail(`OIDC: exchange returned invalid token: ${JSON.stringify(exchJson).slice(0, 500)}`);
  }
  maskValue(exchJson.token);
  console.log(`OIDC: matched rule "${exchJson.matched_rule}" (scope=${exchJson.scope}, expires_in=${exchJson.expires_in}s)`);
  return exchJson.token;
}

async function main() {
  const token = await resolveToken();

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
  let version = getInput('VERSION') || process.env.CERBERNIX_VERSION || 'latest';
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

  let nixConf = '';
  try { nixConf = fs.readFileSync('/etc/nix/nix.conf', 'utf8'); } catch {}

  if (nixConf.includes('post-build-hook')) {
    console.log('::warning::post-build-hook already configured in /etc/nix/nix.conf — skipping');
  } else {
    run("echo 'post-build-hook = /usr/local/bin/cerbernix-post-build-hook' | sudo tee -a /etc/nix/nix.conf");
  }

  // --- 4b. Configure netrc for nix substitution from this cache ---
  const cacheHost = `${cacheName}.cerbernix.com`;
  const netrcPath = path.join(process.env.RUNNER_TEMP || '/tmp', 'cerbernix.netrc');
  fs.writeFileSync(netrcPath, `machine ${cacheHost} login cerbernix password ${token}\n`, { mode: 0o600 });
  fs.appendFileSync(process.env.GITHUB_ENV, `NIX_NETRC=${netrcPath}${os.EOL}`);
  // nix on the system daemon reads /etc/nix/netrc by default; mirror it there too
  run(`sudo install -m 600 ${quote(netrcPath)} /etc/nix/netrc`);
  debug(`Wrote netrc to ${netrcPath} and /etc/nix/netrc for host ${cacheHost}`);

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

  // --- 4c. Sanity check: hit /nix-cache-info with the token ---
  try {
    const probe = await httpRequest('GET', `https://${cacheHost}/nix-cache-info`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (probe.status === 200) {
      console.log(`Cache reachable: ${cacheHost} (HTTP 200)`);
      debug(`nix-cache-info body: ${probe.body.replace(/\n/g, ' | ')}`);
    } else {
      process.stdout.write(
        `::warning::Probe of ${cacheHost}/nix-cache-info returned HTTP ${probe.status}: ${probe.body.slice(0, 300)}${os.EOL}`
      );
    }
  } catch (e) {
    process.stdout.write(`::warning::Could not probe cache: ${e.message}${os.EOL}`);
  }

  // --- 5. Start daemon ---
  const debounce = getInput('DEBOUNCE') || process.env.CERBERNIX_DEBOUNCE || '5';
  const maxUploads = getInput('MAX-UPLOADS') || process.env.CERBERNIX_MAX_UPLOADS || '8';
  const logPath = '/tmp/cerbernix-daemon.log';
  const socketPath = '/tmp/cerbernix.sock';

  const logFd = fs.openSync(logPath, 'w');
  const daemon = spawn('cerbernix', [
    'daemon',
    '--cache-url', `https://${cacheHost}`,
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

  const TIMEOUT_S = 30;
  let ready = false;
  for (let i = 1; i <= TIMEOUT_S; i++) {
    if (fs.existsSync(socketPath)) {
      console.log(`Daemon ready (socket appeared after ${i}s)`);
      ready = true;
      break;
    }
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
}

function quote(s) {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

main().catch((e) => fail(e.stack || e.message));
