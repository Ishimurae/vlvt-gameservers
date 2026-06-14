process.on('uncaughtException', err => { if(err.code==='ECONNRESET'||err.code==='EPIPE') return; console.error('[autopause] Exception:', err); });

const { execSync } = require('child_process');
const net = require('net');

const PORT           = 26010;
const PM2_NAME       = '7DTD-Ishimura';
const TELNET_PORT    = 26070;
const TELNET_PASS    = 'Ish1Admin24';
const CHECK_INTERVAL = 30 * 1000;
const EMPTY_GRACE    = 5 * 60 * 1000;
const START_GRACE    = 3 * 60 * 1000;
const START_WAIT     = 180 * 1000;
const START_COOLDOWN = 10 * 60 * 1000;
const CONFIRM_WINDOW = 30 * 1000;

let emptyStart         = null;
let startTime          = null;
let starting           = false;
let waker              = null;
let lastStartTriggered = 0;

function countConnections() {
  return new Promise(resolve => {
    const sock  = new net.Socket();
    let buf     = '';
    let state   = 'prompt';
    const tid   = setTimeout(() => { sock.destroy(); resolve(0); }, 6000);
    sock.connect(TELNET_PORT, '127.0.0.1');
    sock.on('data', data => {
      buf += data.toString().replace(/\x1b\[[0-9;]*m/g, '');
      if (state === 'prompt' && buf.includes('Please enter password')) {
        buf = ''; sock.write(TELNET_PASS + '\r\n'); state = 'auth';
      } else if (state === 'auth' && buf.includes('Logon successful')) {
        buf = ''; sock.write('listplayers\r\n'); state = 'response';
        clearTimeout(tid);
        setTimeout(() => { const m = buf.match(/Total of\s+(\d+)/i); sock.destroy(); resolve(m ? parseInt(m[1]) : 0); }, 2500);
      }
    });
    sock.on('error', () => { clearTimeout(tid); resolve(0); });
  });
}

function serverStatus() {
  try {
    const list = JSON.parse(execSync('pm2 jlist').toString());
    const p = list.find(x => x.name === PM2_NAME);
    return p ? p.pm2_env.status : 'stopped';
  } catch { return 'stopped'; }
}

function startServer() {
  if (waker) { waker.close(); waker = null; }
  console.log('[autopause] Démarrage ' + PM2_NAME + '...');
  try { execSync('pm2 start ' + PM2_NAME); } catch(e) { console.error('[autopause] Erreur pm2 start:', e.message); }
  startTime          = Date.now();
  lastStartTriggered = Date.now();
  starting           = true;
  setTimeout(() => { starting = false; }, START_WAIT);
}

function stopServer() {
  console.log('[autopause] Arrêt ' + PM2_NAME + ' (vide depuis 5 min)');
  try { execSync('pm2 stop ' + PM2_NAME); } catch(e) { console.error('[autopause] Erreur pm2 stop:', e.message); }
  startTime  = null;
  emptyStart = null;
}

function startWaker() {
  if (waker) return;
  const _wkIps = new Map();

  waker = net.createServer(sock => {
    sock.setTimeout(5000);
    sock.on('error', () => {});
    sock.on('timeout', () => sock.destroy());

    const ip = sock.remoteAddress || 'unknown';

    sock.once('data', chunk => {
      if (chunk.length < 4) { sock.destroy(); return; }
      if (Date.now() - lastStartTriggered < START_COOLDOWN) { sock.destroy(); return; }

      const now  = Date.now();
      const prev = _wkIps.get(ip);

      if (prev && now - prev < CONFIRM_WINDOW) {
        _wkIps.delete(ip);
        console.log('[autopause] 2ème paquet valide de ' + ip + ' → démarrage ' + PM2_NAME);
        setTimeout(() => sock.destroy(), 3000);
        startServer();
      } else {
        _wkIps.set(ip, now);
        console.log('[autopause] 1er paquet de ' + ip + ', confirmation dans 30s...');
        setTimeout(() => sock.destroy(), 3000);
        setTimeout(() => { if (_wkIps.get(ip) === now) _wkIps.delete(ip); }, CONFIRM_WINDOW);
      }
    });
  });

  waker.on('error', err => {
    console.error('[autopause] Erreur waker:', err.message);
    waker = null;
    setTimeout(startWaker, 10000);
  });

  waker.listen(PORT, '0.0.0.0', () => {
    console.log('[autopause] Waker ' + PM2_NAME + ' actif sur port ' + PORT);
  });
}

async function tick() {
  if (starting) { console.log('[autopause] Démarrage en cours (génération monde)...'); return; }

  const status = serverStatus();
  if (status !== 'online') { startWaker(); return; }
  if (waker) { waker.close(); waker = null; }

  if (startTime && (Date.now() - startTime) < START_GRACE) {
    console.log('[autopause] Grâce post-démarrage...');
    return;
  }

  const conns = await countConnections();
  console.log('[autopause] Connexions actives: ' + conns);

  if (conns === 0) {
    if (!emptyStart) emptyStart = Date.now();
    const elapsed   = Date.now() - emptyStart;
    const remaining = Math.max(0, EMPTY_GRACE - elapsed);
    console.log('[autopause] Vide depuis ' + Math.round(elapsed/1000) + 's (arrêt dans ' + Math.round(remaining/1000) + 's)');
    if (elapsed >= EMPTY_GRACE) stopServer();
  } else {
    if (emptyStart) console.log('[autopause] Joueur(s) connecté(s) — timer réinitialisé');
    emptyStart = null;
  }
}

setInterval(tick, CHECK_INTERVAL);
tick();
