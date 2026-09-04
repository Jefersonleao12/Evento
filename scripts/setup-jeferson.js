/**
 * scripts/setup-jeferson.js
 * -----------------------------------------------------------------------
 * Cria (ou atualiza) o usuário "jeferson" com role "owner" — o único que
 * pode carregar planta baixa e trocar os ícones dos equipamentos. Os
 * demais admins (Higor, Fabio, Kayky, Diogo) continuam podendo cadastrar,
 * editar, mover e remover equipamentos normalmente, só não têm mais essas
 * duas ações.
 *
 * Uso (na VPS, dentro da pasta do projeto):
 *   node scripts/setup-jeferson.js
 *
 * Seguro rodar mais de uma vez (idempotente).
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, initDatabase } = require('../database');

const USERNAME = 'jeferson';
const SENHA = '3197';

initDatabase();

const passwordHash = bcrypt.hashSync(SENHA, 10);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(USERNAME);

if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE username = ?').run(passwordHash, 'owner', USERNAME);
  console.log(`Usuário "${USERNAME}" já existia — senha e role atualizadas (role: owner).`);
} else {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(USERNAME, passwordHash, 'owner');
  console.log(`Usuário "${USERNAME}" criado com sucesso (role: owner).`);
}

console.log('\nSó esse usuário consegue carregar planta baixa e trocar ícones dos equipamentos.');
console.log('Aviso: "3197" é uma senha curta (só dígitos) — troque depois se possível.');
