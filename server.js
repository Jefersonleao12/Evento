/**
 * server.js
 * -----------------------------------------------------------------------
 * Servidor Express principal da aplicação de Gestão Visual de ONTs.
 *
 * Responsabilidades:
 *   - Servir o frontend estático (public/).
 *   - Expor API REST CRUD para as ONTs cadastradas.
 *   - Permitir upload da imagem da planta baixa do evento.
 *   - Integrar com a API do IXC Provedor para checagem de status
 *     (individual ou em lote) via ixcClient.js.
 *
 * Como rodar:
 *   npm install
 *   npm start        (produção)
 *   npm run dev       (desenvolvimento, com nodemon)
 * -----------------------------------------------------------------------
 */

require('dotenv').config();

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const { db, initDatabase, getSetting, setSetting } = require('./database');
const ixcClient = require('./ixcClient');

const app = express();
const PORT = process.env.PORT || 3000;

/* ------------------------------------------------------------------ *
 * Middlewares gerais
 * ------------------------------------------------------------------ */
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Upload da planta baixa (imagem de fundo do mapa)
 * ------------------------------------------------------------------ */
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `floorplan-${Date.now()}${ext}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15MB
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(png|jpe?g|webp)/.test(file.mimetype);
    cb(allowed ? null : new Error('Formato de imagem não suportado (use PNG, JPG ou WEBP).'), allowed);
  },
});

/* ------------------------------------------------------------------ *
 * Inicializa o banco de dados
 * ------------------------------------------------------------------ */
initDatabase();

/* ==================================================================== *
 * ROTAS - PLANTA BAIXA
 * ==================================================================== */

// Retorna a URL da planta baixa atualmente configurada (se houver).
app.get('/api/floorplan', (req, res) => {
  const floorplanUrl = getSetting('floorplan_url');
  const width = getSetting('floorplan_width');
  const height = getSetting('floorplan_height');
  res.json({
    url: floorplanUrl || null,
    width: width ? Number(width) : null,
    height: height ? Number(height) : null,
  });
});

// Upload de uma nova imagem de planta baixa.
// Espera também "width" e "height" (dimensões naturais da imagem em px)
// enviados pelo frontend, usados para configurar o CRS.Simple do Leaflet.
app.post('/api/floorplan', upload.single('floorplan'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }
  const publicUrl = `/uploads/${req.file.filename}`;
  setSetting('floorplan_url', publicUrl);
  if (req.body.width) setSetting('floorplan_width', req.body.width);
  if (req.body.height) setSetting('floorplan_height', req.body.height);

  res.json({
    url: publicUrl,
    width: req.body.width ? Number(req.body.width) : null,
    height: req.body.height ? Number(req.body.height) : null,
  });
});

/* ==================================================================== *
 * ROTAS - CRUD DE ONTs
 * ==================================================================== */

// Lista todas as ONTs cadastradas.
app.get('/api/onts', (req, res) => {
  const rows = db.prepare('SELECT * FROM onts ORDER BY id ASC').all();
  res.json(rows);
});

// Busca uma ONT específica.
app.get('/api/onts/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'ONT não encontrada.' });
  res.json(row);
});

// Cria uma nova ONT (chamado ao clicar no mapa + preencher o formulário).
app.post('/api/onts', (req, res) => {
  const {
    tag_label,
    asset_number,
    mac_address,
    wifi_ssid,
    wifi_password,
    ixc_login_id,
    pos_x,
    pos_y,
    notes,
  } = req.body;

  if (!tag_label || pos_x === undefined || pos_y === undefined) {
    return res.status(400).json({ error: 'Campos obrigatórios: tag_label, pos_x, pos_y.' });
  }

  const stmt = db.prepare(`
    INSERT INTO onts (tag_label, asset_number, mac_address, wifi_ssid, wifi_password, ixc_login_id, pos_x, pos_y, notes, status)
    VALUES (@tag_label, @asset_number, @mac_address, @wifi_ssid, @wifi_password, @ixc_login_id, @pos_x, @pos_y, @notes, 'unknown')
  `);

  const info = stmt.run({
    tag_label,
    asset_number: asset_number || null,
    mac_address: mac_address || null,
    wifi_ssid: wifi_ssid || null,
    wifi_password: wifi_password || null,
    ixc_login_id: ixc_login_id || null,
    pos_x,
    pos_y,
    notes: notes || null,
  });

  const created = db.prepare('SELECT * FROM onts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(created);
});

// Atualiza uma ONT existente (edição completa dos campos do formulário).
app.put('/api/onts/:id', (req, res) => {
  const existing = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'ONT não encontrada.' });

  const merged = {
    tag_label: req.body.tag_label ?? existing.tag_label,
    asset_number: req.body.asset_number ?? existing.asset_number,
    mac_address: req.body.mac_address ?? existing.mac_address,
    wifi_ssid: req.body.wifi_ssid ?? existing.wifi_ssid,
    wifi_password: req.body.wifi_password ?? existing.wifi_password,
    ixc_login_id: req.body.ixc_login_id ?? existing.ixc_login_id,
    pos_x: req.body.pos_x ?? existing.pos_x,
    pos_y: req.body.pos_y ?? existing.pos_y,
    notes: req.body.notes ?? existing.notes,
    id: req.params.id,
  };

  db.prepare(`
    UPDATE onts SET
      tag_label = @tag_label,
      asset_number = @asset_number,
      mac_address = @mac_address,
      wifi_ssid = @wifi_ssid,
      wifi_password = @wifi_password,
      ixc_login_id = @ixc_login_id,
      pos_x = @pos_x,
      pos_y = @pos_y,
      notes = @notes,
      updated_at = datetime('now')
    WHERE id = @id
  `).run(merged);

  const updated = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  res.json(updated);
});

// Atualiza somente a posição (drag & drop do marcador no mapa, expansão futura).
app.patch('/api/onts/:id/position', (req, res) => {
  const { pos_x, pos_y } = req.body;
  if (pos_x === undefined || pos_y === undefined) {
    return res.status(400).json({ error: 'pos_x e pos_y são obrigatórios.' });
  }
  const result = db.prepare(
    `UPDATE onts SET pos_x = ?, pos_y = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(pos_x, pos_y, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'ONT não encontrada.' });
  res.json(db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id));
});

// Atualiza manualmente o status (botão "Marcar Online/Offline" manual).
app.patch('/api/onts/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['online', 'offline', 'unknown'].includes(status)) {
    return res.status(400).json({ error: "status deve ser 'online', 'offline' ou 'unknown'." });
  }
  const result = db.prepare(
    `UPDATE onts SET status = ?, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(status, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'ONT não encontrada.' });
  res.json(db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id));
});

// Remove uma ONT.
app.delete('/api/onts/:id', (req, res) => {
  const result = db.prepare('DELETE FROM onts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'ONT não encontrada.' });
  res.status(204).send();
});

/* ==================================================================== *
 * ROTAS - INTEGRAÇÃO IXC PROVEDOR
 * ==================================================================== */

// Consulta o status de UMA ONT específica no IXC e persiste o resultado.
app.post('/api/onts/:id/check-status', async (req, res) => {
  const ont = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  if (!ont) return res.status(404).json({ error: 'ONT não encontrada.' });

  const ixcConfig = {
    baseUrl: getSetting('ixc_base_url'),
    token: getSetting('ixc_token'),
  };

  const result = await ixcClient.checkOntStatus(ont.ixc_login_id, ixcConfig);

  db.prepare(
    `UPDATE onts SET status = ?, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(result.status, ont.id);

  const updated = db.prepare('SELECT * FROM onts WHERE id = ?').get(ont.id);
  res.json({ ont: updated, ixc: result });
});

// Consulta o status de TODAS as ONTs cadastradas em lote (botão "Atualizar Tudo").
// Executa as chamadas em série com pequeno espaçamento para não sobrecarregar
// a API do IXC durante o evento; ajuste CONCURRENCY se necessário.
app.post('/api/onts/check-status', async (req, res) => {
  const onts = db.prepare('SELECT * FROM onts WHERE ixc_login_id IS NOT NULL AND ixc_login_id != ""').all();
  const ixcConfig = {
    baseUrl: getSetting('ixc_base_url'),
    token: getSetting('ixc_token'),
  };

  const results = [];
  for (const ont of onts) {
    const result = await ixcClient.checkOntStatus(ont.ixc_login_id, ixcConfig);
    db.prepare(
      `UPDATE onts SET status = ?, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
    ).run(result.status, ont.id);
    results.push({ id: ont.id, tag_label: ont.tag_label, status: result.status, error: result.error || null });
  }

  res.json({ checked: results.length, results });
});

/* ==================================================================== *
 * ROTAS - CONFIGURAÇÕES (credenciais IXC via interface, opcional)
 * ==================================================================== */

app.get('/api/settings/ixc', (req, res) => {
  res.json({
    base_url: getSetting('ixc_base_url') || process.env.IXC_BASE_URL || '',
    configured: Boolean((getSetting('ixc_base_url') || process.env.IXC_BASE_URL) && (getSetting('ixc_token') || process.env.IXC_TOKEN)),
  });
});

app.post('/api/settings/ixc', async (req, res) => {
  const { base_url, token } = req.body;
  if (base_url) setSetting('ixc_base_url', base_url);
  if (token) setSetting('ixc_token', token);
  res.json({ ok: true });
});

app.post('/api/settings/ixc/test', async (req, res) => {
  const ixcConfig = {
    baseUrl: getSetting('ixc_base_url'),
    token: getSetting('ixc_token'),
  };
  const result = await ixcClient.testConnection(ixcConfig);
  res.json(result);
});

/* ==================================================================== *
 * ROTA - ESTATÍSTICAS (resumo para dashboard/header)
 * ==================================================================== */
app.get('/api/stats', (req, res) => {
  const total = db.prepare('SELECT COUNT(*) AS c FROM onts').get().c;
  const online = db.prepare(`SELECT COUNT(*) AS c FROM onts WHERE status = 'online'`).get().c;
  const offline = db.prepare(`SELECT COUNT(*) AS c FROM onts WHERE status = 'offline'`).get().c;
  const unknown = total - online - offline;
  res.json({ total, online, offline, unknown });
});

/* ------------------------------------------------------------------ *
 * Fallback: qualquer rota não-API retorna o index.html (SPA simples)
 * ------------------------------------------------------------------ */
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

/* ------------------------------------------------------------------ *
 * Handler de erros (ex.: erro de upload do multer)
 * ------------------------------------------------------------------ */
app.use((err, req, res, next) => {
  console.error('[server] Erro:', err.message);
  res.status(500).json({ error: err.message || 'Erro interno do servidor.' });
});

app.listen(PORT, () => {
  console.log(`\n🚀 Painel de Gestão de ONTs rodando em http://localhost:${PORT}\n`);
});
