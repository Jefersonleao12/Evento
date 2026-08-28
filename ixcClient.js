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
      // Autenticação Basic com o token do IXC (usuário e senha = token).
      Authorization: 'Basic ' + Buffer.from(`${authToken}:${authToken}`).toString('base64'),
      'Content-Type': 'application/json',
      ixcsoft: 'listar',
    },
  });
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
    // Exemplo de consulta via endpoint de radusuarios online do IXC.
    // Ajuste o "qtype"/"query" conforme o campo usado no seu IXC para
    // identificar o login (login, id, ou id_grupo).
    const response = await client.post('/webservice/v1/radusuarios', {
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
    const isOnline =
      registro.online === 'S' ||
      registro.status_conexao === 'online' ||
      registro.ativo === 'S' && registro.online === 'S';

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
 * Testa a conectividade/credenciais configuradas contra o IXC.
 * Útil para um botão "Testar conexão" na tela de configurações.
 */
async function testConnection(config = {}) {
  const client = buildClient(config);
  if (!client) {
    return { ok: false, error: 'Configuração ausente (IXC_BASE_URL / IXC_TOKEN)' };
  }
  try {
    await client.post('/webservice/v1/radusuarios', {
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
  testConnection,
};
