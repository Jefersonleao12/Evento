/**
 * ixcClient.js
 * -----------------------------------------------------------------------
 * Módulo de integração com a API do IXC Provedor.
 *
 * O IXC expõe uma API REST (webservice) autenticada via Basic Auth, onde
 * o "usuário" é um token gerado no painel administrativo (Configurações
 * > Chaves de API) e a "senha" é o próprio token novamente (ou uma chave
 * secreta, dependendo da versão). Consulte a documentação oficial do seu
 * provedor de IXC para confirmar o endpoint exato da sua instalação.
 *
 * Endpoint típico para consulta de rádio/ONU (varia por versão do IXC):
 *   POST https://SEU_IXC_HOST/webservice/v1/radusuarios
 *   POST https://SEU_IXC_HOST/webservice/v1/su_oltonu   (dados de ONU, se aplicável)
 *
 * Este módulo foi escrito de forma resiliente: se a API do IXC não
 * responder como esperado, ele nunca derruba o servidor — apenas retorna
 * status "unknown" e loga o erro, para não travar o evento em produção.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');

// Variáveis de ambiente (ver .env.example). Podem ser sobrescritas via
// tabela settings do banco, permitindo trocar credenciais sem reiniciar
// o processo (ver rota /api/settings/ixc no server.js).
const IXC_BASE_URL = process.env.IXC_BASE_URL || '';
const IXC_TOKEN = process.env.IXC_TOKEN || '';

/**
 * Monta um client axios pré-configurado para a API do IXC.
 * Aceita overrides (baseUrl/token) vindos do banco de configurações,
 * caso o técnico prefira configurar pela interface web em vez do .env.
 */
// Monta o header Basic Auth do token do IXC. Existem dois formatos de
// token nas instalações do IXC:
//   - Token único (opaco): usuário e senha do Basic Auth são o mesmo
//     valor repetido ("token:token").
//   - Token no formato "id:hash" (comum em versões mais novas — o ID da
//     chave de API já vem junto, separado por ":"): usado como está,
//     SEM duplicar, já que ele já é o par "usuário:senha".
// Usar o formato errado gera uma autenticação inválida — o Nginx recusa
// com "401 Authorization Required" antes mesmo de chegar na aplicação
// do IXC, o que pode parecer (mas não é) um bloqueio de proxy.
function buildAuthHeader(authToken) {
  const basicAuthPair = authToken.includes(':') ? authToken : `${authToken}:${authToken}`;
  return 'Basic ' + Buffer.from(basicAuthPair).toString('base64');
}

function buildClient({ baseUrl, token } = {}) {
  const url = (baseUrl || IXC_BASE_URL || '').replace(/\/+$/, '');
  const authToken = token || IXC_TOKEN;

  if (!url || !authToken) {
    return null;
  }

  return axios.create({
    baseURL: url,
    timeout: 8000,
    headers: {
      Authorization: buildAuthHeader(authToken),
      'Content-Type': 'application/json',
      ixcsoft: 'listar',
    },
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Algumas instalações têm uma proteção intermitente no proxy (fail2ban/WAF)
// que bloqueia rajadas de requisições com "401 Authorization Required" —
// um erro do Nginx, não da aplicação do IXC (que devolveria JSON, não
// HTML). Esse bloqueio costuma ser passageiro, então tentamos de novo
// algumas vezes com espaçamento antes de desistir, em vez de marcar a ONT
// como "sem dados" já na primeira falha transitória.
function isTransientProxyBlock(err) {
  return err.response && err.response.status === 401 && typeof err.response.data === 'string';
}

async function postWithRetry(client, path, body, { retries = 2, delayMs = 1200 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await client.post(path, body);
    } catch (err) {
      if (attempt >= retries || !isTransientProxyBlock(err)) throw err;
      await sleep(delayMs * (attempt + 1));
    }
  }
}

/**
 * Consulta o status de conexão (online/offline) de um login de radius/PPPoE
 * no IXC a partir do ID/Login cadastrado na ONT.
 *
 * Retorna um objeto padronizado:
 *   { status: 'online' | 'offline' | 'unknown', raw: <resposta bruta> }
 */
async function checkOntStatus(ixcLoginId, config = {}) {
  if (!ixcLoginId) {
    return { status: 'unknown', raw: null, error: 'ixc_login_id não informado' };
  }

  const client = buildClient(config);
  if (!client) {
    return {
      status: 'unknown',
      raw: null,
      error: 'Integração IXC não configurada (defina IXC_BASE_URL e IXC_TOKEN)',
    };
  }

  try {
    const response = await postWithRetry(client, '/webservice/v1/radusuarios', {
      qtype: 'radusuarios.login',
      query: ixcLoginId,
      oper: '=',
      page: '1',
      rp: '1',
      sortname: 'radusuarios.id',
      sortorder: 'desc',
    });

    const registros = response.data && response.data.registros;
    if (!Array.isArray(registros) || registros.length === 0) {
      return { status: 'unknown', raw: response.data, error: 'Login não encontrado no IXC' };
    }

    const registro = registros[0];
    // O campo "ativo" / "status" varia conforme a versão do IXC.
    // Muitas instalações expõem "status" = 'Ativo' e um campo separado
    // indicando se a sessão radius está online (ex.: "online" = 'S'/'N').
    //
    // Correção: a condição anterior era
    //   `registro.online === 'S' || registro.status_conexao === 'online' || registro.ativo === 'S' && registro.online === 'S'`
    // que, por precedência de operadores, equivale a
    //   `online === 'S' || status_conexao === 'online' || (ativo === 'S' && online === 'S')`
    // — a 3ª cláusula nunca influenciava o resultado, pois já era coberta
    // pela 1ª. Isso permitia marcar como "online" um login cujo cadastro
    // esteja desativado no IXC (ex.: sessão radius presa/stale após o
    // cancelamento do contrato). Agora `ativo` funciona como um portão
    // real: só é online se o cadastro está ativo E há sinal de sessão.
    const hasOnlineSignal = registro.online === 'S' || registro.status_conexao === 'online';
    const isOnline = registro.ativo !== 'N' && hasOnlineSignal;

    return {
      status: isOnline ? 'online' : 'offline',
      raw: registro,
    };
  } catch (err) {
    console.error('[ixcClient] Erro ao consultar IXC:', err.message);
    return { status: 'unknown', raw: null, error: err.message };
  }
}

/**
 * Consulta a potência/sinal da ONU (Sinal Rx/Tx, Temperatura, Voltagem)
 * associada a um login, via a tabela "radpop_radio_cliente_fibra" — módulo
 * de monitoramento de fibra (RadPOP) integrado ao IXC. Só existe dado
 * quando o equipamento está numa ONU GPON monitorada; equipamentos ligados
 * de outra forma (Wi-Fi, Ethernet direto, 4G) não têm esse registro.
 *
 * Diferente do status online/offline (tabela radusuarios), aqui é preciso
 * primeiro descobrir o ID interno do login (radusuarios.id) — a consulta à
 * tabela radpop usa esse ID, não o texto do login.
 *
 * Retorna:
 *   { ok: true, sinalRx, sinalTx, temperatura, voltagem, onuNumero, mac, distanciaOnu, raw }
 *   ou { ok: false, error }
 */
async function getOnuPower(ixcLoginId, config = {}) {
  if (!ixcLoginId) {
    return { ok: false, error: 'ixc_login_id não informado' };
  }

  const client = buildClient(config);
  if (!client) {
    return { ok: false, error: 'Integração IXC não configurada (defina IXC_BASE_URL e IXC_TOKEN)' };
  }

  try {
    // 1) Descobre o ID interno do login (radusuarios.id) a partir do texto do login.
    const loginResponse = await postWithRetry(client, '/webservice/v1/radusuarios', {
      qtype: 'radusuarios.login',
      query: ixcLoginId,
      oper: '=',
      page: '1',
      rp: '1',
      sortname: 'radusuarios.id',
      sortorder: 'desc',
    });
    const loginRegistros = loginResponse.data && loginResponse.data.registros;
    if (!Array.isArray(loginRegistros) || loginRegistros.length === 0) {
      return { ok: false, error: 'Login não encontrado no IXC' };
    }
    const radiusId = loginRegistros[0].id;
    if (!radiusId) {
      return { ok: false, error: 'Não foi possível obter o ID interno do login no IXC' };
    }

    // 2) Busca o registro de potência da ONU vinculado a esse ID.
    const powerResponse = await postWithRetry(client, '/webservice/v1/radpop_radio_cliente_fibra', {
      qtype: 'radpop_radio_cliente_fibra.id_login',
      query: String(radiusId),
      oper: '=',
      page: '1',
      rp: '1',
    });
    const powerRegistros = powerResponse.data && powerResponse.data.registros;
    if (!Array.isArray(powerRegistros) || powerRegistros.length === 0) {
      return { ok: false, error: 'Sem dados de potência de ONU para este equipamento (não está numa ONU de fibra monitorada).' };
    }

    const r = powerRegistros[0];
    const toNumberOrNull = (v) => (v === undefined || v === null || v === '' ? null : Number(v));

    return {
      ok: true,
      sinalRx: toNumberOrNull(r.sinal_rx),
      sinalTx: toNumberOrNull(r.sinal_tx),
      temperatura: toNumberOrNull(r.temperatura),
      voltagem: toNumberOrNull(r.voltagem),
      onuNumero: r.onu_numero || null,
      mac: r.mac || null,
      distanciaOnu: r.distancia_onu || null,
      raw: r,
    };
  } catch (err) {
    console.error('[ixcClient] Erro ao consultar potência da ONU:', err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Testa a conectividade/credenciais configuradas contra o IXC.
 * Útil para um botão "Testar conexão" na tela de configurações.
 */
async function testConnection(config = {}) {
  const client = buildClient(config);
  if (!client) {
    return { ok: false, error: 'Configuração ausente (IXC_BASE_URL / IXC_TOKEN)' };
  }
  try {
    await postWithRetry(client, '/webservice/v1/radusuarios', {
      qtype: 'radusuarios.id',
      query: '1',
      oper: '>',
      page: '1',
      rp: '1',
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  checkOntStatus,
  getOnuPower,
  testConnection,
};
