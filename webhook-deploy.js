'use strict';
// Serveur de déploiement automatique — écoute les webhooks GitHub
// Lance git pull + pm2 reload à chaque push sur main/master

const http   = require('http');
const crypto = require('crypto');
const { execSync } = require('child_process');

const PORT   = 3010;
const SECRET = process.env.WEBHOOK_SECRET || 'vlvt_webhook_2024';

const REPOS = {
  'discord-bot': {
    dir:  '/opt/bots/discord-bot',
    cmds: ['git fetch origin main', 'git reset --hard origin/main', 'npm install --omit=dev', 'node deploy-commands.js', 'pm2 reload LeMajordome'],
  },
  'bot-dashboard': {
    dir:  '/opt/dashboard',
    cmds: ['git fetch origin main', 'git reset --hard origin/main', 'npm install --omit=dev', 'pm2 reload dashboard'],
  },
  'vlvt-gameservers': {
    dir:  '/opt',
    cmds: ['git -C /opt/zomboid fetch && git -C /opt/zomboid reset --hard origin/master || true', 'pm2 reload zomboid-autopause'],
  },
};

function verify(secret, payload, sig) {
  const hmac = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expected = 'sha256=' + hmac;
  try { return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected)); }
  catch { return false; }
}

function deploy(repoName, branch) {
  const cfg = REPOS[repoName];
  if (!cfg) return console.log(`[webhook] Repo inconnu : ${repoName}`);
  if (!['main','master'].includes(branch)) return console.log(`[webhook] Branche ignorée : ${branch}`);

  console.log(`[webhook] Déploiement de ${repoName} (${branch})...`);
  for (const cmd of cfg.cmds) {
    try {
      const out = execSync(cmd, { cwd: cfg.dir, encoding: 'utf8', stdio: ['pipe','pipe','pipe'] });
      if (out.trim()) console.log(`  ✔ ${cmd}\n${out.trim().slice(0,200)}`);
      else console.log(`  ✔ ${cmd}`);
    } catch (e) {
      console.error(`  ✘ ${cmd}: ${e.message.slice(0,200)}`);
    }
  }
  console.log(`[webhook] ${repoName} déployé ✅`);
}

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404); res.end('Not found'); return;
  }

  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => {
    const sig   = req.headers['x-hub-signature-256'] || '';
    const event = req.headers['x-github-event']      || '';

    if (!verify(SECRET, body, sig)) {
      console.warn('[webhook] Signature invalide');
      res.writeHead(401); res.end('Unauthorized'); return;
    }

    if (event !== 'push') { res.writeHead(200); res.end('ok'); return; }

    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); res.end('Bad JSON'); return; }

    const repoName = payload.repository?.name;
    const branch   = (payload.ref || '').replace('refs/heads/', '');

    res.writeHead(200); res.end('ok');
    setImmediate(() => deploy(repoName, branch));
  });
});

server.listen(PORT, () => console.log(`[webhook] Serveur démarré sur port ${PORT}`));
