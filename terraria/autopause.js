process.on('uncaughtException', err => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[autopause] Exception:', err);
});

const { execSync } = require('child_process');
const net = require('net');

const PORT           = 7777;
const CHECK_INTERVAL = 30 * 1000;
const EMPTY_GRACE    = 20 * 60 * 1000;
const START_GRACE    = 3 * 60 * 1000;
const START_WAIT     = 90 * 1000;
const START_COOLDOWN = 10 * 60 * 1000;

const WAIT_MSG = 'Serveur en cours de demarrage !\nReessaie dans ~2 minutes.';

let emptyStart         = null;
let startTime          = null;
let starting           = false;
let waker              = null;
let lastStartTriggered = 0;

// Terraria ConnectionRequest : byte[2]=0x01, byte[4..12]="Terraria"
function isValidTerrariaPacket(buf) {
  return buf.length >= 12 && buf[2] === 0x01 && buf.slice(4, 12).toString('ascii') === 'Terraria';
}

// Terraria Disconnect packet (MessageID=2) avec message texte
function buildDisconnectPacket(text) {
  const textBuf = Buffer.from(text, 'utf8');
  const pkt     = Buffer.alloc(2 + 1 + 1 + textBuf.length);
  pkt.writeUInt16LE(pkt.length, 0);   // longueur totale (incl. ces 2 bytes)
  pkt[2] = 0x02;                       // MessageID : Disconnect
  pkt[3] = textBuf.length;            // longueur du texte
  textBuf.copy(pkt, 4);
  return pkt;
}

function sendWaitMessage(sock) {
  try {
    sock.write(buildDisconnectPacket(WAIT_MSG));
  } catch {}
}

function countConnections() {
  try {
    const out   = execSync(`ss -tn state established '( sport = :${PORT} )'`).toString();
    const lines = out.trim().split('\n').slice(1);
    return lines.filter(l => l.trim().length > 0).length;
  } catch { return 0; }
}

function serverStatus() {
  try {
    const list = JSON.parse(execSync('pm2 jlist').toString());
    const p = list.find(x => x.name === 'terraria');
    return p ? p.pm2_env.status : 'stopped';
  } catch { return 'stopped'; }
}

function startServer() {
  if (waker) { waker.close(); waker = null; }
  console.log('[autopause] Démarrage serveur Terraria...');
  try { execSync('pm2 restart terraria --update-env'); } catch(e) { console.error('[autopause] Erreur pm2:', e.message); }
  startTime          = Date.now();
  lastStartTriggered = Date.now();
  starting           = true;
  setTimeout(() => { starting = false; }, START_WAIT);
}

function stopServer() {
  console.log('[autopause] Arrêt serveur Terraria (vide depuis 20 min)');
  try { execSync('pm2 stop terraria'); } catch(e) { console.error('[autopause] Erreur pm2:', e.message); }
  startTime  = null;
  emptyStart = null;
}

function startWaker() {
  if (waker) return;
  waker = net.createServer(sock => {
    sock.setTimeout(5000);
    sock.on('error', () => {});
    sock.on('timeout', () => sock.destroy());

    const ip = sock.remoteAddress || 'unknown';

    sock.once('data', chunk => {
      if (!isValidTerrariaPacket(chunk)) { sock.destroy(); return; }

      // Toujours envoyer le message d'attente avant de fermer
      sendWaitMessage(sock);
      setTimeout(() => sock.destroy(), 500);

      if (Date.now() - lastStartTriggered < START_COOLDOWN) return;

      console.log('[autopause] Paquet Terraria valide de ' + ip + ' → démarrage serveur');
      startServer();
    });
  });

  waker.on('error', err => {
    console.error('[autopause] Erreur waker:', err.message);
    waker = null;
    setTimeout(startWaker, 10000);
  });

  waker.listen(PORT, '0.0.0.0', () => {
    console.log('[autopause] Waker Terraria actif sur port ' + PORT);
  });
}

function tick() {
  if (starting) { console.log('[autopause] Serveur en cours de démarrage...'); return; }

  const status = serverStatus();
  if (status !== 'online') { startWaker(); return; }
  if (waker) { waker.close(); waker = null; }

  if (startTime && (Date.now() - startTime) < START_GRACE) {
    console.log('[autopause] Grâce post-démarrage...');
    return;
  }

  const conns = countConnections();
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
