const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROVIDER_TIMEOUT = 20000;
const INSTALL_TIMEOUT = 120000;
const CLOUDFLARED_INSTALL_GRACE = 10000;
const CLOUDFLARED_MIN_BYTES = 10 * 1024 * 1024;
const MAX_RESTART_ATTEMPTS = 2;

let cloudflaredInstallPromise = null;
let validatedCloudflaredPath = null;
let cloudflaredCheckFailedPath = null;
let cloudflaredCheckFailedAt = 0;

function getCloudflaredBinPath() {
  const exe = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  return path.join(os.homedir(), '.liveshare', 'cloudflared', exe);
}

function isBinaryUsable(binPath) {
  try {
    const result = spawnSync(binPath, ['--version'], {
      timeout: 3000,
      stdio: 'ignore',
      windowsHide: true,
    });
    return result.status === 0;
  } catch (_) {
    return false;
  }
}

function isCloudflaredReady() {
  const binPath = getCloudflaredBinPath();
  if (validatedCloudflaredPath === binPath) return true;
  if (
    cloudflaredCheckFailedPath === binPath &&
    Date.now() - cloudflaredCheckFailedAt < 30000
  ) {
    return false;
  }
  try {
    const stat = fs.statSync(binPath);
    if (!stat.isFile() || stat.size < CLOUDFLARED_MIN_BYTES) return false;
    if (process.platform !== 'win32' && (stat.mode & 0o111) === 0) return false;
  } catch (_) {
    return false;
  }
  if (!isBinaryUsable(binPath)) {
    cloudflaredCheckFailedPath = binPath;
    cloudflaredCheckFailedAt = Date.now();
    return false;
  }
  validatedCloudflaredPath = binPath;
  return true;
}

function installCloudflared(cloudflared, binPath) {
  const binDir = path.dirname(binPath);
  fs.mkdirSync(binDir, { recursive: true });
  const tmpDir = fs.mkdtempSync(path.join(binDir, '.install-'));
  const tmpPath = path.join(tmpDir, path.basename(binPath));
  validatedCloudflaredPath = null;
  cloudflaredCheckFailedPath = null;
  cloudflaredCheckFailedAt = 0;
  return cloudflared
    .install(tmpPath)
    .then(() => {
      if (process.platform !== 'win32') fs.chmodSync(tmpPath, 0o755);
      if (!isBinaryUsable(tmpPath)) {
        throw new Error('downloaded cloudflared is not executable');
      }
      if (process.platform === 'win32' && fs.existsSync(binPath)) {
        fs.unlinkSync(binPath);
      }
      fs.renameSync(tmpPath, binPath);
      validatedCloudflaredPath = binPath;
      return binPath;
    })
    .finally(() => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (_) {}
    });
}

async function ensureCloudflared() {
  const cloudflared = require('cloudflared');
  const binPath = getCloudflaredBinPath();
  cloudflared.use(binPath);
  if (!isCloudflaredReady()) {
    if (!cloudflaredInstallPromise) {
      console.log('[LS] Downloading cloudflared binary...');
      const install = installCloudflared(cloudflared, binPath);
      let wrapped = null;
      wrapped = install.finally(() => {
        if (cloudflaredInstallPromise === wrapped) {
          cloudflaredInstallPromise = null;
        }
      });
      cloudflaredInstallPromise = wrapped;
    }
    const pending = cloudflaredInstallPromise;
    try {
      await withTimeout(pending, INSTALL_TIMEOUT);
    } catch (e) {
      if (cloudflaredInstallPromise === pending) {
        cloudflaredInstallPromise = null;
      }
      if (!isCloudflaredReady()) throw e;
    }
  }
  if (!isCloudflaredReady()) {
    throw new Error('cloudflared binary is not ready');
  }
  return cloudflared;
}

let tunnelInstance = null;
let currentUrl = null;
let restartAttempts = 0;
let intentionalStop = false;
let tunnelStarting = false;
let installRetryPending = false;
let urlChangeCallback = null;
let tunnelGeneration = 0;

function wrapTunnel(url, closeFn) {
  const cbs = { close: [], error: [] };
  let closed = false;
  const obj = {
    url,
    close: () => {
      if (closed) return;
      closed = true;
      closeFn();
      cbs.close.slice().forEach((fn) => fn());
    },
    onClose: (cb) => cbs.close.push(cb),
    onError: (cb) => cbs.error.push(cb),
  };
  obj._fireClose = () => {
    if (closed) return;
    closed = true;
    cbs.close.slice().forEach((fn) => fn());
  };
  obj._fireError = (err) => {
    cbs.error.slice().forEach((fn) => fn(err));
  };
  return obj;
}

const cancelRegistry = [];

function cancelAllInFlight() {
  const handlers = cancelRegistry.splice(0);
  handlers.forEach((fn) => fn());
}

function cleanupHandler(handler) {
  const idx = cancelRegistry.indexOf(handler);
  if (idx !== -1) cancelRegistry.splice(idx, 1);
}

function registerCancel(handler) {
  cancelRegistry.push(handler);
  return () => cleanupHandler(handler);
}

async function withTimeout(promise, ms) {
  let timer = null;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function forceKillAfterGrace(child) {
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch (_) {}
  }, 1000);
  child.once('exit', () => clearTimeout(killTimer));
}

// ─── cloudflared provider ───────────────────────────────────────────────────

function tryCloudflared(port, generation) {
  return new Promise((resolve, reject) => {
    if (generation !== tunnelGeneration) {
      reject(new Error('cancelled'));
      return;
    }
    const installWait = isCloudflaredReady()
      ? 1000
      : CLOUDFLARED_INSTALL_GRACE;
    withTimeout(ensureCloudflared(), installWait)
      .then((cloudflared) => {
        if (generation !== tunnelGeneration) {
          reject(new Error('cancelled'));
          return;
        }
        const tunnelUrl = `http://localhost:${port}`;
        const tunnel = cloudflared.Tunnel.quick(tunnelUrl, {
          '--no-autoupdate': true,
        });

        let resolved = false;

        const unreg = registerCancel(() => {
          if (resolved) return;
          resolved = true;
          try {
            tunnel.stop();
          } catch (_) {}
          forceKillAfterGrace(tunnel.process);
          reject(new Error('cancelled'));
        });

        tunnel.on('url', (url) => {
          if (resolved) return;
          resolved = true;
          unreg();
          const tw = wrapTunnel(url, () => {
            try {
              tunnel.stop();
            } catch (_) {}
            forceKillAfterGrace(tunnel.process);
          });
          tunnel.on('exit', () => tw._fireClose());
          tunnel.on('error', (err) => tw._fireError(err));
          resolve(tw);
        });

        tunnel.on('error', (err) => {
          if (!resolved) {
            resolved = true;
            unreg();
            reject(err);
          }
        });

        tunnel.on('exit', (code) => {
          if (!resolved) {
            resolved = true;
            unreg();
            reject(new Error(`cloudflared exited with code ${code}`));
          }
        });

        setTimeout(() => {
          if (!resolved) {
            resolved = true;
            unreg();
            try {
              tunnel.stop();
            } catch (_) {}
            forceKillAfterGrace(tunnel.process);
            reject(new Error('cloudflared timed out'));
          }
        }, PROVIDER_TIMEOUT);
      })
      .catch((err) => {
        reject(
          new Error(
            `cloudflared unavailable: ${err.message || err}`.slice(0, 200),
          ),
        );
      });
  });
}

// ─── localhost.run provider (SSH) ─────────────────────────────────────────

function tryLocalhostRun(port, generation) {
  return new Promise((resolve, reject) => {
    if (generation !== tunnelGeneration) {
      reject(new Error('cancelled'));
      return;
    }
    const child = spawn(
      'ssh',
      [
        '-o',
        'StrictHostKeyChecking=no',
        '-o',
        'ServerAliveInterval=30',
        '-o',
        'ServerAliveCountMax=3',
        '-o',
        'ExitOnForwardFailure=yes',
        '-o',
        'TCPKeepAlive=yes',
        '-R',
        `80:localhost:${port}`,
        'nokey@localhost.run',
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let resolved = false;
    let buffer = '';

    const unreg = registerCancel(() => {
      if (resolved) return;
      resolved = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {}
      reject(new Error('cancelled'));
    });

    function onOutput(data) {
      if (resolved) return;
      buffer += data.toString();
      const m = buffer.match(
        /https:\/\/[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.lhr\.life/,
      );
      if (m) {
        resolved = true;
        unreg();
        child.stdout.removeAllListeners('data');
        child.stderr.removeAllListeners('data');
        const tw = wrapTunnel(m[0], () => child.kill('SIGTERM'));
        child.on('exit', () => tw._fireClose());
        child.on('error', (err) => tw._fireError(err));
        resolve(tw);
      }
    }

    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    child.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        unreg();
        reject(err);
      }
    });

    child.on('exit', (code) => {
      if (!resolved) {
        resolved = true;
        unreg();
        reject(new Error(`ssh exited with code ${code}`));
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        unreg();
        try {
          child.kill('SIGTERM');
        } catch (_) {}
        reject(new Error('localhost.run timed out'));
      }
    }, PROVIDER_TIMEOUT);
  });
}

// ─── main loop ────────────────────────────────────────────────────────────

const PROVIDERS = [
  { name: 'cloudflared', fn: tryCloudflared },
  { name: 'localhost.run', fn: tryLocalhostRun },
];

async function startTunnel(port, isRestart = false) {
  stopTunnel();
  const generation = ++tunnelGeneration;
  const errors = [];
  intentionalStop = false;
  if (!isRestart) restartAttempts = 0;
  tunnelStarting = true;
  installRetryPending = false;

  try {
    if (!isCloudflaredReady()) {
      ensureCloudflared()
        .then(() => {
          if (generation !== tunnelGeneration) return;
          if (tunnelInstance || intentionalStop) return;
          if (tunnelStarting) {
            installRetryPending = true;
            return;
          }
          console.log('[LS] cloudflared install finished, retrying tunnel');
          tryRestart(port).catch(() => {});
        })
        .catch((e) => {
          console.warn('[LS] cloudflared background install failed:', e.message);
        });
    }

    for (const provider of PROVIDERS) {
      if (generation !== tunnelGeneration) {
        return { url: null, errors };
      }
      console.log(`[LS] Tunnel: trying ${provider.name}...`);
      try {
        const instance = await withTimeout(
          provider.fn(port, generation),
          PROVIDER_TIMEOUT,
        );

        if (generation !== tunnelGeneration) {
          try {
            instance.close();
          } catch (_) {}
          return { url: null, errors };
        }

        cancelAllInFlight();

        currentUrl = instance.url;
        tunnelInstance = instance;

        instance.onClose(() => {
          if (tunnelInstance !== instance) return;
          console.log(`[LS] Tunnel closed (${provider.name})`);
          tunnelInstance = null;
          currentUrl = null;
          if (!intentionalStop) {
            tryRestart(port).catch(() => {});
          }
        });

        instance.onError((err) => {
          console.error(`[LS] Tunnel error (${provider.name}):`, err);
        });

        console.log(`[LS] Tunnel started via ${provider.name}: ${currentUrl}`);
        return { url: currentUrl, errors: [] };
      } catch (e) {
        if (generation !== tunnelGeneration) {
          return { url: null, errors };
        }
        cancelAllInFlight();
        if (intentionalStop) {
          return { url: null, errors };
        }
        const msg = `${provider.name}: ${e.message || e}`;
        errors.push(msg);
        console.warn(
          `[LS] Tunnel provider ${provider.name} failed: ${e.message || e}`,
        );
      }
    }

    console.error('[LS] All tunnel providers failed');
    return { url: null, errors };
  } finally {
    if (generation === tunnelGeneration) {
      tunnelStarting = false;
      if (installRetryPending) {
        installRetryPending = false;
        if (!tunnelInstance && !intentionalStop) {
          console.log('[LS] Retrying tunnel after cloudflared install');
          tryRestart(port).catch(() => {});
        }
      }
    }
  }
}

async function tryRestart(port) {
  if (tunnelStarting || intentionalStop) return;
  if (restartAttempts >= MAX_RESTART_ATTEMPTS) {
    console.error('[LS] Tunnel restart limit reached');
    if (urlChangeCallback) urlChangeCallback(null);
    return;
  }
  restartAttempts++;
  console.log(
    `[LS] Attempting tunnel restart (${restartAttempts}/${MAX_RESTART_ATTEMPTS})...`,
  );
  const result = await startTunnel(port, true);
  if (result.url) {
    console.log(`[LS] Tunnel restarted: ${result.url}`);
    restartAttempts = 0;
    if (urlChangeCallback) urlChangeCallback(result.url);
  } else if (!tunnelStarting && !intentionalStop) {
    console.error('[LS] Tunnel restart failed');
    if (urlChangeCallback) urlChangeCallback(null);
  }
}

function setUrlChangeCallback(cb) {
  urlChangeCallback = cb;
}

function stopTunnel() {
  tunnelGeneration++;
  cancelAllInFlight();
  const inst = tunnelInstance;
  tunnelInstance = null;
  currentUrl = null;
  tunnelStarting = false;
  installRetryPending = false;
  if (inst) {
    try {
      inst.close();
    } catch (e) {
      console.error('[LS] Error closing tunnel:', e);
    }
  }
  intentionalStop = true;
}

module.exports = { startTunnel, stopTunnel, setUrlChangeCallback };
