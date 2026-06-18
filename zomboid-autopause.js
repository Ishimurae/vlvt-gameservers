process.on('uncaughtException', err => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[autopause] Erreur non gérée:', err.message);
});

const { execSync } = require('child_process');
const dgram        = require('dgram');
const net          = require('net');

const GAME_PORT      = 16261;
const RCON_PORT      = 27015;
const RCON_PASS      = 'vlvt_rcon_2024';
const CHECK_INTERVAL = 30 * 1000;
const EMPTY_GRACE    = 20 * 60 * 1000;
const START_GRACE    = 3 * 60 * 1000;
const START_WAIT     = 120 * 1000;
const CONFIRM_WINDOW = 30 * 1000;
const START_COOLDOWN = 10 * 60 * 1000;

// Magic bytes RakNet présents dans TOUS les paquets de connexion PZ
const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00,
  0xfe, 0xfe, 0xfe, 0xfe,
  0xfd, 0xfd, 0xfd, 0xfd,
  0x12, 0x34, 0x56, 0x78,
]);

// RakNet ID_NO_FREE_INCOMING_CONNECTIONS (0x14)
// Le client PZ affiche "Connection to server lost" ou similaire
function buildNoConnectionsPacket() {
  const pkt = Buffer.alloc(1 + 16 + 8);
  pkt[0] = 0x14;                        // ID_NO_FREE_INCOMING_CONNECTIONS
  RAKNET_MAGIC.copy(pkt, 1);            // offline magic
  // bytes 17-24 : server GUID (fake zeros)
  return pkt;
}

function isValidPZPacket(msg) {
  if (msg.length < 18) return false;
  for (let i = 0; i <= msg.length - RAKNET_MAGIC.length; i++) {
    if (msg.slice(i, i + RAKNET_MAGIC.length).equals(RAKNET_MAGIC)) return true;
  }
  return false;
}

let emptyStart         = null;
let startTime          = null;
let starting           = false;
let waker              = null;
let lastStartTriggered = 0;

function rconPacket(reqId, reqType, body) {
  const bodyBuf = Buffer.concat([Buffer.from(body, 'utf8'), Buffer.alloc(2)]);
  const data    = Buffer.alloc(8 + bodyBuf.length);
  data.writeInt32LE(reqId, 0);
  data.writeInt32LE(reqType, 4);
  bodyBuf.copy(data, 8);
  const packet = Buffer.alloc(4 + data.length);
  packet.writeInt32LE(data.length, 0);
  data.copy(packet, 4);
  return packet;
}

function countPlayers() {
  return new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(8000);
    let buf           = Buffer.alloc(0);
    let authenticated = false;

    function tryParse() {
      while (buf.length >= 4) {
        const length = buf.readInt32LE(0);
        if (buf.length < 4 + length) break;
        const pkt  = buf.slice(4, 4 + length);
        buf = buf.slice(4 + length);
        const id   = pkt.readInt32LE(0);
        const type = pkt.readInt32LE(4);
        const body = pkt.slice(8).toString('utf8').replace(/\x00/g, '');
        if (!authenticated) {
          if (type === 0) continue;
          if (id === -1) { sock.destroy(); return resolve(-1); }
          authenticated = true;
          sock.write(rconPacket(2, 2, 'players'));
        } else {
          sock.destroy();
          const m = body.match(/Players connected \((\d+)\)/i);
          return resolve(m ? parseInt(m[1], 10) : 0);
        }
      }
    }

    sock.on('data', chunk => { buf = Buffer.concat([buf, chunk]); tryParse(); });
    sock.on('timeout', () => { sock.destroy(); resolve(-1); });
    sock.on('error',   () => resolve(-1));
    sock.connect(RCON_PORT, '127.0.0.1', () => {
      sock.write(rconPacket(1, 3, RCON_PASS));
    });
  });
}

function serverStatus() {
  try {
    const list = JSON.parse(execSync('pm2 jlist').toString());
    const p = list.find(x => x.name === 'zomboid');
    return p ? p.pm2_env.status : 'stopped';
  } catch { return 'stopped'; }
}

function startServer() {
  if (waker) { waker.close(); waker = null; }
  console.log('[autopause] Démarrage Project Zomboid...');
  try { execSync('pm2 start zomboid'); } catch(e) { console.error(e.message); }
  startTime          = Date.now();
  lastStartTriggered = Date.now();
  starting           = true;
  setTimeout(() => { starting = false; }, START_WAIT);
}

function stopServer() {
  console.log('[autopause] Arrêt Project Zomboid (vide depuis 20 min)');
  try { execSync('pm2 stop zomboid'); } catch(e) { console.error(e.message); }
  startTime  = null;
  emptyStart = null;
}

function startWaker() {
  if (waker) return;
  waker = dgram.createSocket('udp4');
  const _udpFirst = new Map();
  const noConn    = buildNoConnectionsPacket();

  waker.on('message', (msg, rinfo) => {
    if (!isValidPZPacket(msg)) return;

    // Répondre immédiatement : le client PZ voit une erreur de connexion
    // plutôt qu'un silence total
    waker.send(noConn, rinfo.port, rinfo.address, () => {});

    if (Date.now() - lastStartTriggered < START_COOLDOWN) return;

    const ip  = rinfo.address;
    const now = Date.now();
    const prev = _udpFirst.get(ip);

    if (prev && now - prev < CONFIRM_WINDOW) {
      _udpFirst.delete(ip);
      console.log('[autopause] 2ème paquet PZ valide de ' + ip + ' → démarrage serveur');
      startServer();
    } else {
      _udpFirst.set(ip, now);
      console.log('[autopause] 1er paquet PZ valide de ' + ip + ', attente confirmation (30s)...');
      setTimeout(() => { if (_udpFirst.get(ip) === now) _udpFirst.delete(ip); }, CONFIRM_WINDOW);
    }
  });

  waker.on('error', err => {
    console.error('[autopause] Erreur waker:', err.message);
    waker = null;
    setTimeout(startWaker, 10000);
  });

  waker.bind(GAME_PORT, '0.0.0.0', () => {
    console.log('[autopause] Waker UDP actif sur port ' + GAME_PORT);
  });
}

async function tick() {
  if (starting) { console.log('[autopause] Démarrage en cours...'); return; }

  const status = serverStatus();
  if (status !== 'online') { startWaker(); return; }
  if (waker) { waker.close(); waker = null; }

  if (startTime && (Date.now() - startTime) < START_GRACE) {
    console.log('[autopause] Grâce post-démarrage...');
    return;
  }

  let count = await countPlayers();
  if (count === -1) {
    // Fallback : connexions TCP établies sur le port jeu
    try {
      const raw = execSync("ss -tn 'sport = :16261' 2>/dev/null | grep -c ESTAB || echo 0", { encoding:'utf8', shell:'/bin/bash' }).trim();
      count = parseInt(raw, 10) || 0;
    } catch { count = 0; }
    console.log('[autopause] RCON indisponible — fallback TCP : ' + count + ' connexion(s)');
  }
  console.log('[autopause] Joueurs: ' + count);

  if (count === 0) {
    if (!emptyStart) emptyStart = Date.now();
    const elapsed   = Date.now() - emptyStart;
    const remaining = Math.max(0, EMPTY_GRACE - elapsed);
    console.log('[autopause] Vide depuis ' + Math.round(elapsed/1000) + 's (arrêt dans ' + Math.round(remaining/1000) + 's)');
    if (elapsed >= EMPTY_GRACE) stopServer();
  } else {
    if (emptyStart) console.log('[autopause] ' + count + ' joueur(s) — timer réinitialisé');
    emptyStart = null;
  }
}

setInterval(tick, CHECK_INTERVAL);
tick();
