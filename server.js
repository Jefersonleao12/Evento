/**
 * server.js
 * -----------------------------------------------------------------------
 * Servidor Express principal da aplicação de Gestão Visual de ONTs.
 *
 * Responsabilidades:
 *   - Servir o frontend estático (public/).
 *   - Autenticar usuários (sessão) e proteger a API.
 *   - Expor API REST CRUD para os equipamentos cadastrados.
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
const session = require('express-session');
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const sharp = require('sharp');

const { db, initDatabase, getSetting, setSetting, findUserByUsername } = require('./database');
const ixcClient = require('./ixcClient');

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.SESSION_SECRET) {
  console.warn(
    '[server] AVISO: SESSION_SECRET não definido no .env — usando um valor temporário ' +
      '(as sessões serão invalidadas a cada reinício). Defina SESSION_SECRET antes do evento.'
  );
}

/* ------------------------------------------------------------------ *
 * Middlewares gerais
 * ------------------------------------------------------------------ */
app.set('trust proxy', 1); // necessário atrás do Nginx para cookies "secure" e rate limit corretos
app.use(compression()); // gzip nas respostas (JSON/HTML/CSS/JS) — ajuda bastante em rede de evento/4G
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(
  session({
    name: 'ont_evento_sid',
    secret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-troque-isso',
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production' && process.env.FORCE_HTTPS !== 'false',
      maxAge: 12 * 60 * 60 * 1000, // 12h
    },
  })
);

// Cache agressivo para uploads (planta baixa, ícones): os nomes de arquivo
// já incluem timestamp, então um arquivo nunca muda de conteúdo sob o
// mesmo nome — o navegador pode guardar em cache por bastante tempo,
// evitando rebaixar a planta baixa inteira a cada visita/refresh.
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'), {
  maxAge: '30d',
  immutable: true,
}));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ *
 * Rate limiting
 * ------------------------------------------------------------------ */
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de login. Tente novamente em alguns minutos.' },
});

const ixcCheckLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas consultas ao IXC em pouco tempo. Aguarde um momento e tente novamente.' },
});

/* ------------------------------------------------------------------ *
 * Auth helpers / middlewares
 * ------------------------------------------------------------------ */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.status(401).json({ error: 'Não autenticado.' });
}

function requireAdmin(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'admin') return next();
  return res.status(403).json({ error: 'Ação restrita ao administrador.' });
}

/* ==================================================================== *
 * ROTAS - AUTENTICAÇÃO
 * ==================================================================== */

app.post('/api/auth/login', loginLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Usuário e senha são obrigatórios.' });
  }

  const user = findUserByUsername(String(username).trim());
  const valid = user && bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }

  req.session.regenerate((err) => {
    if (err) return res.status(500).json({ error: 'Erro ao iniciar sessão.' });
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.json({ user: req.session.user });
  });
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('ont_evento_sid');
    res.json({ ok: true });
  });
});

app.get('/api/auth/me', (req, res) => {
  res.json({ user: (req.session && req.session.user) || null });
});

/* A partir daqui, toda a API exige autenticação. */
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

const EQUIPMENT_TYPES = ['ont', 'switch', 'access_point', 'roteador', 'mikrotik', 'outro'];

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
 * Upload de ícones customizados por tipo de equipamento
 * ------------------------------------------------------------------ */
const iconsDir = path.join(__dirname, 'public', 'uploads', 'icons');
if (!fs.existsSync(iconsDir)) fs.mkdirSync(iconsDir, { recursive: true });

const iconStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, iconsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${req.params.type}-${Date.now()}${ext}`);
  },
});
const uploadIcon = multer({
  storage: iconStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB — ícone, não precisa de mais que isso
  fileFilter: (req, file, cb) => {
    if (!EQUIPMENT_TYPES.includes(req.params.type)) {
      return cb(new Error('Tipo de equipamento inválido.'), false);
    }
    // SVG é servido apenas via <img src="...">, nunca inline no DOM, então é
    // seguro mesmo que contenha <script> (o navegador não executa nesse caso).
    const allowed = /image\/(png|jpe?g|webp|svg\+xml)/.test(file.mimetype);
    cb(allowed ? null : new Error('Formato não suportado (use PNG, JPG, WEBP ou SVG).'), allowed);
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

// Upload de uma nova imagem de planta baixa (admin).
// Espera também "width" e "height" (dimensões naturais da imagem em px)
// enviados pelo frontend, usados para configurar o CRS.Simple do Leaflet.
// Dimensão máxima (maior lado) da planta baixa depois de otimizada. Plantas
// enviadas em resolução de foto/scan (vários milhares de pixels) ficavam
// lentas para baixar e para o navegador decodificar/redesenhar a cada
// zoom/pan — especialmente no celular. 2400px é nítido o suficiente para
// esse uso e reduz drasticamente o tamanho do arquivo.
const FLOORPLAN_MAX_DIMENSION = 2400;

app.post('/api/floorplan', requireAdmin, upload.single('floorplan'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Nenhum arquivo enviado.' });
  }

  const originalPath = req.file.path;
  const optimizedFilename = `floorplan-${Date.now()}.webp`;
  const optimizedPath = path.join(uploadsDir, optimizedFilename);

  try {
    // .rotate() sem argumentos aplica a orientação gravada no EXIF (comum em
    // fotos tiradas direto do celular), evitando planta baixa "deitada".
    const info = await sharp(originalPath)
      .rotate()
      .resize({
        width: FLOORPLAN_MAX_DIMENSION,
        height: FLOORPLAN_MAX_DIMENSION,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality: 85 })
      .toFile(optimizedPath);

    fs.unlink(originalPath, () => {}); // não precisamos mais do arquivo original (grande)

    const publicUrl = `/uploads/${optimizedFilename}`;
    setSetting('floorplan_url', publicUrl);
    // Usa as dimensões REAIS do arquivo já otimizado (não o que o navegador
    // mediu do original) — é isso que o Leaflet usa para os bounds do
    // CRS.Simple, então precisa bater com o arquivo que será servido.
    setSetting('floorplan_width', String(info.width));
    setSetting('floorplan_height', String(info.height));

    res.json({ url: publicUrl, width: info.width, height: info.height });
  } catch (err) {
    fs.unlink(originalPath, () => {});
    next(err);
  }
});

/* ==================================================================== *
 * ROTAS - CRUD DE EQUIPAMENTOS (ONTs, switches, APs, etc.)
 * ==================================================================== */

const LIST_COLUMNS = `
  id, tag_label, asset_number, mac_address, wifi_ssid, ixc_login_id,
  equipment_type, nome_fantasia, pos_x, pos_y, status, last_checked_at,
  notes, created_at, updated_at
`;

// Lista todos os equipamentos cadastrados (sem a senha do Wi-Fi — ver
// GET /api/onts/:id/wifi-password para revelar sob demanda).
app.get('/api/onts', (req, res) => {
  const rows = db.prepare(`SELECT ${LIST_COLUMNS} FROM onts ORDER BY id ASC`).all();
  res.json(rows);
});

// Busca um equipamento específico (sem a senha do Wi-Fi).
app.get('/api/onts/:id', (req, res) => {
  const row = db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Equipamento não encontrado.' });
  res.json(row);
});

// Revela a senha do Wi-Fi sob demanda (botão "mostrar" no detalhe).
app.get('/api/onts/:id/wifi-password', (req, res) => {
  const row = db.prepare('SELECT wifi_password FROM onts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Equipamento não encontrado.' });
  res.json({ wifi_password: row.wifi_password || '' });
});

/* ==================================================================== *
 * ROTAS - ÍCONES CUSTOMIZADOS POR TIPO DE EQUIPAMENTO (admin apenas)
 * ==================================================================== */

// Retorna a URL do ícone customizado de cada tipo (null quando não houver,
// caso em que o frontend usa o ícone padrão embutido).
app.get('/api/equipment-icons', (req, res) => {
  const icons = {};
  for (const type of EQUIPMENT_TYPES) {
    icons[type] = getSetting(`equipment_icon_${type}`) || null;
  }
  res.json(icons);
});

// Envia/substitui o ícone customizado de um tipo de equipamento. Admin apenas.
app.post('/api/equipment-icons/:type', requireAdmin, (req, res, next) => {
  if (!EQUIPMENT_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: 'Tipo de equipamento inválido.' });
  }
  uploadIcon.single('icon')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Falha no upload.' });
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado.' });

    const publicUrl = `/uploads/icons/${req.file.filename}`;
    setSetting(`equipment_icon_${req.params.type}`, publicUrl);
    res.json({ type: req.params.type, url: publicUrl });
  });
});

// Remove o ícone customizado de um tipo, voltando a usar o padrão. Admin apenas.
app.delete('/api/equipment-icons/:type', requireAdmin, (req, res) => {
  if (!EQUIPMENT_TYPES.includes(req.params.type)) {
    return res.status(400).json({ error: 'Tipo de equipamento inválido.' });
  }
  const currentUrl = getSetting(`equipment_icon_${req.params.type}`);
  if (currentUrl) {
    const filePath = path.join(__dirname, 'public', currentUrl.replace(/^\//, ''));
    fs.unlink(filePath, () => {}); // best-effort; não bloqueia a resposta se falhar
  }
  setSetting(`equipment_icon_${req.params.type}`, '');
  res.json({ ok: true });
});

// Cria um novo equipamento (chamado ao clicar no mapa + preencher o formulário). Admin apenas.
app.post('/api/onts', requireAdmin, (req, res) => {
  const {
    tag_label,
    asset_number,
    mac_address,
    wifi_ssid,
    wifi_password,
    ixc_login_id,
    equipment_type,
    nome_fantasia,
    pos_x,
    pos_y,
    notes,
  } = req.body;

  if (!tag_label || pos_x === undefined || pos_y === undefined) {
    return res.status(400).json({ error: 'Campos obrigatórios: tag_label, pos_x, pos_y.' });
  }

  const stmt = db.prepare(`
    INSERT INTO onts (
      tag_label, asset_number, mac_address, wifi_ssid, wifi_password, ixc_login_id,
      equipment_type, nome_fantasia, pos_x, pos_y, notes, status
    )
    VALUES (
      @tag_label, @asset_number, @mac_address, @wifi_ssid, @wifi_password, @ixc_login_id,
      @equipment_type, @nome_fantasia, @pos_x, @pos_y, @notes, 'unknown'
    )
  `);

  const info = stmt.run({
    tag_label,
    asset_number: asset_number || null,
    mac_address: mac_address || null,
    wifi_ssid: wifi_ssid || null,
    wifi_password: wifi_password || null,
    ixc_login_id: ixc_login_id || null,
    equipment_type: EQUIPMENT_TYPES.includes(equipment_type) ? equipment_type : 'ont',
    nome_fantasia: nome_fantasia || null,
    pos_x,
    pos_y,
    notes: notes || null,
  });

  const created = db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(info.lastInsertRowid);
  res.status(201).json(created);
});

// Atualiza um equipamento existente (edição completa dos campos do formulário). Admin apenas.
app.put('/api/onts/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Equipamento não encontrado.' });

  const merged = {
    tag_label: req.body.tag_label ?? existing.tag_label,
    asset_number: req.body.asset_number ?? existing.asset_number,
    mac_address: req.body.mac_address ?? existing.mac_address,
    wifi_ssid: req.body.wifi_ssid ?? existing.wifi_ssid,
    wifi_password: req.body.wifi_password ?? existing.wifi_password,
    ixc_login_id: req.body.ixc_login_id ?? existing.ixc_login_id,
    equipment_type: EQUIPMENT_TYPES.includes(req.body.equipment_type)
      ? req.body.equipment_type
      : existing.equipment_type,
    nome_fantasia: req.body.nome_fantasia ?? existing.nome_fantasia,
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
      equipment_type = @equipment_type,
      nome_fantasia = @nome_fantasia,
      pos_x = @pos_x,
      pos_y = @pos_y,
      notes = @notes,
      updated_at = datetime('now')
    WHERE id = @id
  `).run(merged);

  const updated = db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(req.params.id);
  res.json(updated);
});

// Atualiza somente a posição (drag & drop do marcador no mapa). Admin apenas.
app.patch('/api/onts/:id/position', requireAdmin, (req, res) => {
  const { pos_x, pos_y } = req.body;
  if (pos_x === undefined || pos_y === undefined) {
    return res.status(400).json({ error: 'pos_x e pos_y são obrigatórios.' });
  }
  const result = db.prepare(
    `UPDATE onts SET pos_x = ?, pos_y = ?, updated_at = datetime('now') WHERE id = ?`
  ).run(pos_x, pos_y, req.params.id);

  if (result.changes === 0) return res.status(404).json({ error: 'Equipamento não encontrado.' });
  res.json(db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(req.params.id));
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

  if (result.changes === 0) return res.status(404).json({ error: 'Equipamento não encontrado.' });
  res.json(db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(req.params.id));
});

// Remove um equipamento. Admin apenas.
app.delete('/api/onts/:id', requireAdmin, (req, res) => {
  const result = db.prepare('DELETE FROM onts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Equipamento não encontrado.' });
  res.status(204).send();
});

/* ==================================================================== *
 * ROTAS - INTEGRAÇÃO IXC PROVEDOR
 * ==================================================================== */

// Consulta o status de UM equipamento específico no IXC e persiste o resultado.
app.post('/api/onts/:id/check-status', ixcCheckLimiter, async (req, res) => {
  const ont = db.prepare('SELECT * FROM onts WHERE id = ?').get(req.params.id);
  if (!ont) return res.status(404).json({ error: 'Equipamento não encontrado.' });

  const ixcConfig = {
    baseUrl: getSetting('ixc_base_url'),
    token: getSetting('ixc_token'),
  };

  const result = await ixcClient.checkOntStatus(ont.ixc_login_id, ixcConfig);

  db.prepare(
    `UPDATE onts SET status = ?, last_checked_at = datetime('now'), updated_at = datetime('now') WHERE id = ?`
  ).run(result.status, ont.id);

  const updated = db.prepare(`SELECT ${LIST_COLUMNS} FROM onts WHERE id = ?`).get(ont.id);
  res.json({ ont: updated, ixc: result });
});

// Pequena pausa entre chamadas sequenciais ao IXC, para não sobrecarregar a
// API do provedor quando o evento tiver muitos equipamentos cadastrados.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const IXC_BATCH_DELAY_MS = Number(process.env.IXC_BATCH_DELAY_MS) || 200;

// Consulta o status de TODOS os equipamentos cadastrados em lote (botão "Atualizar Tudo").
// Executa as chamadas em série com espaçamento (IXC_BATCH_DELAY_MS) para não
// sobrecarregar a API do IXC durante o evento, e é limitada por rate limit
// (ver ixcCheckLimiter) para não ser disparada em excesso.
app.post('/api/onts/check-status', ixcCheckLimiter, async (req, res) => {
  const onts = db.prepare("SELECT * FROM onts WHERE ixc_login_id IS NOT NULL AND ixc_login_id != ''").all();
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
    if (IXC_BATCH_DELAY_MS > 0) await sleep(IXC_BATCH_DELAY_MS);
  }

  res.json({ checked: results.length, results });
});

/* ==================================================================== *
 * ROTAS - CONFIGURAÇÕES (credenciais IXC via interface, opcional). Admin apenas.
 * ==================================================================== */

app.get('/api/settings/ixc', requireAdmin, (req, res) => {
  res.json({
    base_url: getSetting('ixc_base_url') || process.env.IXC_BASE_URL || '',
    configured: Boolean((getSetting('ixc_base_url') || process.env.IXC_BASE_URL) && (getSetting('ixc_token') || process.env.IXC_TOKEN)),
  });
});

app.post('/api/settings/ixc', requireAdmin, async (req, res) => {
  const { base_url, token } = req.body;
  if (base_url) setSetting('ixc_base_url', base_url);
  if (token) setSetting('ixc_token', token);
  res.json({ ok: true });
});

app.post('/api/settings/ixc/test', requireAdmin, async (req, res) => {
  const ixcConfig = {
    baseUrl: getSetting('ixc_base_url'),
    token: getSetting('ixc_token'),
  };
  const result = await ixcClient.testConnection(ixcConfig);
  res.json(result);
});

/* ==================================================================== *
 * ROTA - RELATÓRIO DE WI-FI (nome fantasia, SSID e senha). Admin apenas,
 * já que expõe senhas de Wi-Fi em lote.
 * ==================================================================== */
app.get('/api/reports/wifi', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT id, tag_label, equipment_type, nome_fantasia, wifi_ssid, wifi_password
    FROM onts
    WHERE (nome_fantasia IS NOT NULL AND nome_fantasia != '')
       OR (wifi_ssid IS NOT NULL AND wifi_ssid != '')
       OR (wifi_password IS NOT NULL AND wifi_password != '')
    ORDER BY tag_label ASC
  `).all();
  res.json(rows);
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
app.use((req, res, next) => {
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
