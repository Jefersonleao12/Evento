/**
 * debug-ixc.js
 * -----------------------------------------------------------------------
 * Testa diretamente uma tabela do webservice do IXC, sem passar pela
 * aplicação — útil pra descobrir qual endpoint/tabela existe de fato
 * nessa instalação quando /webservice/v1/radusuarios não funciona.
 *
 * Uso:
 *   node debug-ixc.js <valor-de-busca> [tabela] [campo-qtype] [operador]
 *
 * Exemplos:
 *   node debug-ixc.js boiarural04                         (tabela padrão: radusuarios, campo radusuarios.login)
 *   node debug-ixc.js boiarural04 su_oltonu su_oltonu.id_contrato =
 *   node debug-ixc.js boiarural04 radacct radacct.username =
 *   node debug-ixc.js 0 cliente cliente.id ">"              (teste "o webservice responde pra qualquer tabela?")
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');

const baseUrl = (process.env.IXC_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.IXC_TOKEN || '';

// Token no formato "id:hash" (versões novas do IXC) já é o par usuário:senha
// do Basic Auth — não duplicar. Token opaco (sem ":") duplica como antes.
const basicAuthPair = token.includes(':') ? token : `${token}:${token}`;

const client = axios.create({
  baseURL: baseUrl,
  timeout: 8000,
  headers: {
    Authorization: 'Basic ' + Buffer.from(basicAuthPair).toString('base64'),
    'Content-Type': 'application/json',
    ixcsoft: 'listar',
  },
});

const [, , query, tabela = 'radusuarios', qtype = 'radusuarios.login', oper = '='] = process.argv;

if (!query) {
  console.error('Uso: node debug-ixc.js <valor-de-busca> [tabela] [campo-qtype] [operador]');
  process.exit(1);
}

console.log(`--> POST ${baseUrl}/webservice/v1/${tabela}  { qtype: "${qtype}", query: "${query}", oper: "${oper}" }\n`);

client
  .post(`/webservice/v1/${tabela}`, {
    qtype,
    query,
    oper,
    page: '1',
    rp: '5',
  })
  .then((res) => {
    console.log(JSON.stringify(res.data, null, 2));
  })
  .catch((err) => {
    console.error('Erro HTTP:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  });
