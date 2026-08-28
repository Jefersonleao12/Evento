/**
 * database.js
 * -----------------------------------------------------------------------
 * Inicialização e acesso ao banco de dados SQLite usando better-sqlite3.
 *
 * Tabela principal: onts
 *   - Armazena o cadastro de cada equipamento (ONT, switch, AP, etc.)
 *     posicionado no mapa do evento.
 *   - As coordenadas (pos_x, pos_y) são relativas à imagem da planta baixa
 *     carregada (sistema de coordenadas Leaflet CRS.Simple) OU lat/lng
 *     quando o fallback OpenStreetMap estiver em uso.
 *
 * Tabela auxiliar: settings
 *   - Guarda configurações gerais da aplicação (ex.: caminho da planta
 *     baixa atual, credenciais da API IXC), para não precisar de .env
 *     fixo caso o técnico queira trocar em tempo de execução.
 *
 * Tabela auxiliar: users
 *   - Contas de acesso ao painel (autenticação por sessão). O papel
 *     ("role") pode ser 'admin' (cadastra/edita/move equipamentos) ou
 *     'viewer' (apenas consulta o mapa e status).
 *
 * Para trocar de SQLite para outro banco no futuro, basta reimplementar
 * este módulo mantendo a mesma interface pública (funções exportadas).
 * -----------------------------------------------------------------------
 */

const path = require('path');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, 'data', 'onts.db');

// Garante que a pasta "data" exista antes de abrir o arquivo do banco.
const fs = require('fs');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// `verbose` pode ser habilitado durante debug: new Database(DB_PATH, { verbose: console.log })
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL'); // melhora concorrência de leitura/escrita

/**
 * Adiciona uma coluna à tabela caso ela ainda não exista (migração simples,
 * idempotente — segura de rodar toda vez que o servidor sobe).
 */
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all();
  const has = existing.some((c) => c.name === column);
  if (!has) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

/**
 * Cria as tabelas caso ainda não existam e aplica migrações incrementais.
 * Executado uma única vez na inicialização do servidor.
 */
function initDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS onts (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      tag_label         TEXT NOT NULL,        -- Número da Etiqueta/Localização
      asset_number      TEXT,                 -- Patrimônio do equipamento
      mac_address       TEXT,                 -- Endereço MAC da ONT
      wifi_ssid         TEXT,                 -- Nome da rede Wi-Fi (SSID)
      wifi_password     TEXT,                 -- Senha do Wi-Fi
      ixc_login_id      TEXT,                 -- ID/Login no IXC (vínculo com API)
      pos_x             REAL NOT NULL,        -- Coordenada X no mapa
      pos_y             REAL NOT NULL,        -- Coordenada Y no mapa
      status            TEXT NOT NULL DEFAULT 'unknown', -- online | offline | unknown
      last_checked_at   TEXT,                 -- ISO timestamp da última checagem IXC
      notes             TEXT,                 -- Observações livres (expansão futura)
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role          TEXT NOT NULL DEFAULT 'viewer', -- admin | viewer
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migrações incrementais (equipamentos com tipo/ícone + nome fantasia).
  addColumnIfMissing('onts', 'equipment_type', `TEXT NOT NULL DEFAULT 'ont'`);
  addColumnIfMissing('onts', 'nome_fantasia', `TEXT`);

  // Índice para buscas rápidas por etiqueta ou login IXC.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_onts_tag ON onts (tag_label);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_onts_ixc_login ON onts (ixc_login_id);`);

  seedDefaultAdmin();

  console.log('[database] SQLite inicializado em', DB_PATH);
}

/**
 * Cria o usuário admin padrão na primeira execução, a partir das variáveis
 * de ambiente ADMIN_USERNAME / ADMIN_PASSWORD (ver .env.example). Não faz
 * nada se já existir algum usuário cadastrado, para não sobrescrever senha
 * trocada manualmente depois.
 */
function seedDefaultAdmin() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (count > 0) return;

  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD || 'admin123';
  const passwordHash = bcrypt.hashSync(password, 10);

  db.prepare(
    `INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'admin')`
  ).run(username, passwordHash);

  console.log(
    `[database] Usuário admin padrão criado: "${username}". ` +
      (process.env.ADMIN_PASSWORD
        ? 'Senha definida via ADMIN_PASSWORD.'
        : 'Senha padrão "admin123" — troque-a definindo ADMIN_PASSWORD no .env antes do evento!')
  );
}

/* ------------------------------------------------------------------ *
 * Helpers de configuração (tabela settings)
 * ------------------------------------------------------------------ */

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

/* ------------------------------------------------------------------ *
 * Helpers de usuários (autenticação)
 * ------------------------------------------------------------------ */

function findUserByUsername(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

module.exports = {
  db,
  initDatabase,
  getSetting,
  setSetting,
  findUserByUsername,
};
