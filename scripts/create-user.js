/**
 * scripts/create-user.js
 * -----------------------------------------------------------------------
 * Cria (ou atualiza a senha/role de) um usuário de acesso ao painel,
 * direto no banco SQLite — útil enquanto não existe uma tela de gestão
 * de usuários na interface.
 *
 * Uso:
 *   node scripts/create-user.js <usuario> <senha> [admin|viewer|owner]
 *
 * Role padrão: admin.
 *   - owner  → tudo que o admin pode, mais carregar planta baixa e trocar
 *              os ícones dos equipamentos (reservado a um usuário só).
 *   - admin  → cadastra, edita, remove e move equipamentos; configurações
 *              do IXC. NÃO pode trocar planta baixa nem ícones (owner só).
 *   - viewer → só visualiza o mapa, marca status manualmente e consulta
 *              o IXC (não pode alterar cadastro nem posição).
 *
 * Se o usuário já existir, a senha e a role são atualizadas (idempotente
 * — seguro rodar de novo pra trocar a senha de alguém).
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, initDatabase } = require('../database');

const [, , username, password, roleArg] = process.argv;
const role = roleArg || 'admin';

if (!username || !password) {
  console.error('Uso: node scripts/create-user.js <usuario> <senha> [admin|viewer|owner]');
  process.exit(1);
}
if (!['admin', 'viewer', 'owner'].includes(role)) {
  console.error('Role inválido — use "admin", "viewer" ou "owner".');
  process.exit(1);
}
if (password.length < 6) {
  console.error('Use uma senha com pelo menos 6 caracteres.');
  process.exit(1);
}

initDatabase();

const passwordHash = bcrypt.hashSync(password, 10);
const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);

if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE username = ?').run(passwordHash, role, username);
  console.log(`Usuário "${username}" já existia — senha e role atualizadas (role: ${role}).`);
} else {
  db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, role);
  console.log(`Usuário "${username}" criado com sucesso (role: ${role}).`);
}
