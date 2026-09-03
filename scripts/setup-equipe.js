/**
 * scripts/setup-equipe.js
 * -----------------------------------------------------------------------
 * Provisiona as contas da equipe de retirada de equipamentos: Higor, Fabio,
 * Kayky e Diogo, todas com a senha "2587" e role "admin" (podem retirar
 * equipamento para o almoxarifado, mover marcadores, etc). Remove as
 * contas antigas equipe01/equipe02/equipe03, que deixam de existir.
 *
 * Uso (na VPS, dentro da pasta do projeto):
 *   node scripts/setup-equipe.js
 *
 * Seguro rodar mais de uma vez (idempotente): se as contas já existirem,
 * só atualiza a senha/role; contas antigas equipe01/02/03 só são removidas
 * se ainda existirem.
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { db, initDatabase } = require('../database');

const SENHA = '2587';
const NOVOS_USUARIOS = ['Higor', 'Fabio', 'Kayky', 'Diogo'];
const USUARIOS_ANTIGOS = ['equipe01', 'equipe02', 'equipe03'];

initDatabase();

const passwordHash = bcrypt.hashSync(SENHA, 10);

for (const username of NOVOS_USUARIOS) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) {
    db.prepare('UPDATE users SET password_hash = ?, role = ? WHERE username = ?').run(passwordHash, 'admin', username);
    console.log(`Usuário "${username}" já existia — senha e role atualizadas (role: admin).`);
  } else {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)').run(username, passwordHash, 'admin');
    console.log(`Usuário "${username}" criado com sucesso (role: admin).`);
  }
}

for (const username of USUARIOS_ANTIGOS) {
  const result = db.prepare('DELETE FROM users WHERE username = ?').run(username);
  if (result.changes > 0) console.log(`Usuário antigo "${username}" removido.`);
}

console.log('\nPronto — Higor, Fabio, Kayky e Diogo com senha "2587" (role admin).');
console.log('Aviso: "2587" é uma senha curta (só dígitos) — troque depois se possível.');
