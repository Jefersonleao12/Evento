/**
 * list-ixc.js
 * -----------------------------------------------------------------------
 * Lista vários registros de uma tabela do webservice do IXC de uma vez —
 * diferente do debug-ixc.js (que busca 1 valor específico), este script
 * serve pra "navegar" pelos dados reais: ver quais campos existem, quais
 * valores aparecem, e confirmar se a tabela/rota é a certa antes de usar
 * no ixcClient.js.
 *
 * Uso:
 *   node list-ixc.js <tabela> [quantidade] [pagina] [ordenar-por]
 *
 * Exemplos:
 *   node list-ixc.js su_oltonu                     (lista os 20 primeiros registros)
 *   node list-ixc.js su_oltonu 50                   (lista os 50 primeiros)
 *   node list-ixc.js su_oltonu 20 2                 (página 2, 20 por página)
 *   node list-ixc.js radusuarios 20 1 radusuarios.id
 *
 * Por padrão consulta "<tabela>.id > 0", ordenado por "<tabela>.id" desc —
 * ou seja, lista os registros mais recentes primeiro. Ajuste o campo de
 * ordenação (4º argumento) se a tabela não tiver coluna "id".
 * -----------------------------------------------------------------------
 */

require('dotenv').config();
const axios = require('axios');

const baseUrl = (process.env.IXC_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.IXC_TOKEN || '';

const client = axios.create({
  baseURL: baseUrl,
  timeout: 15000,
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${token}:${token}`).toString('base64'),
    'Content-Type': 'application/json',
    ixcsoft: 'listar',
  },
});

const [, , tabela, quantidadeArg, paginaArg, sortnameArg] = process.argv;

if (!tabela) {
  console.error('Uso: node list-ixc.js <tabela> [quantidade] [pagina] [ordenar-por]');
  console.error('Exemplo: node list-ixc.js su_oltonu 30');
  process.exit(1);
}

const quantidade = quantidadeArg || '20';
const pagina = paginaArg || '1';
const sortname = sortnameArg || `${tabela}.id`;

console.log(`--> POST ${baseUrl}/webservice/v1/${tabela}`);
console.log(`    qtype: ${tabela}.id | oper: > | query: 0 | rp: ${quantidade} | página: ${pagina}\n`);

client
  .post(`/webservice/v1/${tabela}`, {
    qtype: `${tabela}.id`,
    query: '0',
    oper: '>',
    page: pagina,
    rp: quantidade,
    sortname,
    sortorder: 'desc',
  })
  .then((res) => {
    const data = res.data;
    if (!data || !Array.isArray(data.registros)) {
      console.log('Resposta sem "registros" (provavelmente um erro) — corpo completo:');
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    console.log(`Total de registros na tabela: ${data.total || data.registros.length}`);
    console.log(`Mostrando ${data.registros.length} registro(s) desta página:\n`);

    data.registros.forEach((registro, i) => {
      console.log(`--- registro ${i + 1} ---`);
      console.log(JSON.stringify(registro, null, 2));
    });

    if (data.registros.length === 0) {
      console.log('(nenhum registro encontrado — confira se a tabela existe e se o token tem permissão nela)');
    }
  })
  .catch((err) => {
    console.error('Erro HTTP:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
  });
