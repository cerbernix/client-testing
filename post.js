const fs = require('fs');

function getState(name) {
  return process.env[`STATE_${name}`] || '';
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const pid = parseInt(getState('daemon_pid'), 10);
const logPath = getState('log_path') || '/tmp/cerbernix-daemon.log';

console.log('::group::Cerbernix daemon shutdown');

if (pid) {
  let running = false;
  try {
    process.kill(pid, 0);
    running = true;
  } catch {}

  if (running) {
    console.log(`Sending SIGTERM to daemon (PID ${pid})`);
    try { process.kill(pid, 'SIGTERM'); } catch {}

    let stopped = false;
    for (let i = 0; i < 15; i++) {
      sleepMs(1000);
      try {
        process.kill(pid, 0);
      } catch {
        console.log('Daemon stopped gracefully');
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      console.log('::warning::Daemon did not stop gracefully, sending SIGKILL');
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
  } else {
    console.log('Daemon already exited');
  }
} else {
  console.log('No daemon PID found in state');
}

// Print daemon logs
if (fs.existsSync(logPath)) {
  console.log('--- Daemon log ---');
  console.log(fs.readFileSync(logPath, 'utf8'));
}

// Cleanup
try { fs.unlinkSync('/tmp/cerbernix.sock'); } catch {}

console.log('::endgroup::');
