/**
 * database.js
 * -----------------------------------------------------------------------
 * Inicialização e acesso ao banco de dados SQLite usando better-sqlite3.
 *
 * Tabela principal: onts
 *   - Armazena o cadastro de cada ONT posicionada no mapa do evento.
 *   - As coordenadas (pos_x, pos_y) são relativas à imagem da planta baixa
 *     carregada (sistema de coordenadas Leaflet CRS.Simple) OU lat/lng
 *     quando o fallback OpenStreetMap estiver em uso.
 *
 * Tabela auxiliar: settings
 *   - Guarda configurações gerais da aplicação (ex.: caminho da planta
 *     baixa atual, credenciais da API IXC), para não precisar de .env
 *     fixo caso o técnico queira trocar em tempo de execução.
 *
 * Para trocar de SQLite para outro banco no futuro, basta reimplementar
 * este módulo mantendo a mesma interface pública (funções exportadas).
 * -----------------------------------------------------------------------
 */

const path = require('path');
const Database = require('better-sqlite3');

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
 * Cria as tabelas caso ainda não existam.
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

  // Índice para buscas rápidas por etiqueta ou login IXC.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_onts_tag ON onts (tag_label);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_onts_ixc_login ON onts (ixc_login_id);`);

  console.log('[database] SQLite inicializado em', DB_PATH);
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

module.exports = {
  db,
  initDatabase,
  getSetting,
  setSetting,
};
