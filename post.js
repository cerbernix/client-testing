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
    // Daemon listens for SIGINT (tokio::signal::ctrl_c) to break its accept
    // loop and drain the upload queue. SIGTERM would kill it before flushing.
    console.log(`Sending SIGINT to daemon (PID ${pid}) and waiting for queue to drain`);
    try { process.kill(pid, 'SIGINT'); } catch {}

    const DRAIN_TIMEOUT_S = 300;
    let stopped = false;
    for (let i = 0; i < DRAIN_TIMEOUT_S; i++) {
      sleepMs(1000);
      try {
        process.kill(pid, 0);
      } catch {
        console.log(`Daemon stopped gracefully after ${i + 1}s`);
        stopped = true;
        break;
      }
    }

    if (!stopped) {
      console.log(`::warning::Daemon still running after ${DRAIN_TIMEOUT_S}s, sending SIGKILL — pending uploads dropped`);
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
