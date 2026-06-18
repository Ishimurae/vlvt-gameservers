#!/usr/bin/env node
// Arrête automatiquement le serveur Zomboid si 0 joueur pendant IDLE_MINUTES
'use strict';

const { execSync } = require('child_process');
const fs           = require('fs');

const IDLE_MINUTES = 30;
const STATE_FILE   = '/tmp/zomboid-idle-since.txt';
const LOG_PREFIX   = '[zomboid-idle]';

function log(msg) { console.log(new Date().toISOString().slice(0,16).replace('T',' ') + ' ' + LOG_PREFIX + ' ' + msg); }

function isZomboidRunning() {
  try {
    const list = JSON.parse(execSync('pm2 jlist', { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] }));
    const z = list.find(p => p.name === 'zomboid');
    return z && z.pm2_env.status === 'online';
  } catch { return false; }
}

function getPlayerCount() {
  try {
    // Connexions TCP ESTABLISHED sur le port jeu (16261)
    const out = execSync("ss -tn 'sport = :16261' 2>/dev/null | grep -c ESTAB || true", { encoding: 'utf8', shell: true }).trim();
    return parseInt(out, 10) || 0;
  } catch { return 0; }
}

function stopZomboid() {
  try {
    execSync('pm2 stop zomboid', { encoding: 'utf8' });
    log('Serveur arrêté — 0 joueur depuis ' + IDLE_MINUTES + ' minutes.');
  } catch (e) { log('Erreur arrêt PM2 : ' + e.message); }
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

// Pas en cours → rien à faire
if (!isZomboidRunning()) {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  process.exit(0);
}

const players = getPlayerCount();
const now     = Date.now();

if (players > 0) {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  log(players + ' joueur(s) connecté(s) — OK.');
  process.exit(0);
}

// 0 joueur
if (!fs.existsSync(STATE_FILE)) {
  fs.writeFileSync(STATE_FILE, String(now));
  log('0 joueur — décompte lancé (arrêt dans ' + IDLE_MINUTES + ' min si personne).');
  process.exit(0);
}

const since   = parseInt(fs.readFileSync(STATE_FILE, 'utf8'), 10) || now;
const idleMin = Math.floor((now - since) / 60000);
log('0 joueur depuis ' + idleMin + ' min (seuil : ' + IDLE_MINUTES + ' min).');

if (now - since >= IDLE_MINUTES * 60 * 1000) {
  stopZomboid();
}
