/**
 * radpopClient.js
 * -----------------------------------------------------------------------
 * Consulta AO VIVO a potência/sinal da ONU, simulando o botão "Potência /
 * Resumo" que existe dentro do próprio painel administrativo do IXC.
 *
 * Diferente de ixcClient.js (que usa o token da API webservice e só lê o
 * último valor SALVO no banco do IXC), este módulo autentica como um
 * usuário administrador de verdade (e-mail + senha) e mantém uma sessão
 * de cookies — exatamente como o navegador faz — pra disparar a consulta
 * em tempo real na OLT.
 *
 * Fluxo (descoberto analisando o tráfego de rede do próprio painel):
 *   1) POST /api-module/auth/login   (multipart/form-data: email=...)
 *      -> resposta { data: { type: "password" } } confirma que o e-mail
 *         existe e pede a senha.
 *   2) POST /api-module/auth/login   (multipart/form-data: password=...)
 *      -> resposta { data: { type: "redirect" } } confirma login OK.
 *      A sessão (cookies) fica guardada automaticamente no cookie jar.
 *   3) GET /aplicativo/radpop_radio_cliente_fibra/rel_22991.php?id=<id>
 *      -> HTML simples com o resultado da consulta ao vivo na OLT
 *         (o mesmo <id> que já obtemos hoje via ixcClient.getOnuPower).
 *
 * Sessão é reaproveitada entre chamadas (fica em memória, só refaz login
 * se expirar). Nunca derruba o servidor: qualquer falha vira
 * { ok: false, error }.
 * -----------------------------------------------------------------------
 */

const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const FormData = require('form-data');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let session = null; // { client, baseUrl, email, loggedIn }

function getSession(baseUrl) {
  if (session && session.baseUrl === baseUrl) return session;

  const jar = new CookieJar();
  const instance = wrapper(
    axios.create({
      baseURL: baseUrl,
      jar,
      withCredentials: true,
      timeout: 15000,
      headers: { 'User-Agent': USER_AGENT },
      validateStatus: () => true, // trata erros HTTP manualmente
    })
  );

  session = { client: instance, baseUrl, loggedIn: false };
  return session;
}

async function login(baseUrl, email, password) {
  const s = getSession(baseUrl);

  const form1 = new FormData();
  form1.append('email', email);
  const r1 = await s.client.post('/api-module/auth/login', form1, { headers: form1.getHeaders() });
  if (!(r1.status === 200 && r1.data && r1.data.data && r1.data.data.type === 'password')) {
    throw new Error(
      `E-mail de admin do IXC não reconhecido (ou o fluxo de login mudou). Resposta do IXC (status ${r1.status}): ${JSON.stringify(r1.data)}`
    );
  }

  const form2 = new FormData();
  form2.append('password', password);
  const r2 = await s.client.post('/api-module/auth/login', form2, { headers: form2.getHeaders() });
  if (!(r2.status === 200 && r2.data && r2.data.data && r2.data.data.type === 'redirect')) {
    throw new Error(
      `Senha de admin do IXC incorreta (ou o fluxo de login mudou). Resposta do IXC (status ${r2.status}): ${JSON.stringify(r2.data)}`
    );
  }

  s.loggedIn = true;
}

async function ensureLoggedIn(baseUrl, email, password) {
  const s = getSession(baseUrl);
  if (!s.loggedIn) await login(baseUrl, email, password);
}

// Extrai pares "Rótulo: valor" do HTML simples do relatório
// (<div>Rótulo: valor</div>) num objeto { "Rótulo": "valor" }.
function parseReportHtml(html) {
  const fields = {};
  const lines = [];
  const divRegex = /<div>([^<]*)<\/div>/g;
  let m;
  while ((m = divRegex.exec(html))) lines.push(m[1].trim());

  let onlineNow = null;
  for (const line of lines) {
    if (/^Onu Online!?$/i.test(line)) { onlineNow = true; continue; }
    if (/^Onu Offline!?$/i.test(line)) { onlineNow = false; continue; }
    if (line.startsWith('---')) continue;
    if (line === 'INFORMAÇÕES ADICIONAIS:') continue;

    const idx = line.indexOf(':');
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  return { onlineNow, fields };
}

const toNumberOrNull = (v) => (v === undefined || v === null || v === '' || v === '-' ? null : Number(v));

/**
 * Consulta ao vivo a potência da ONU vinculada ao registro
 * radpop_radio_cliente_fibra.id (o mesmo id que ixcClient.getOnuPower já
 * descobre a partir do login IXC).
 */
async function getLivePower({ baseUrl, adminEmail, adminPassword, onuRecordId }) {
  if (!baseUrl || !adminEmail || !adminPassword) {
    return { ok: false, error: 'Consulta ao vivo não configurada (defina IXC_ADMIN_EMAIL e IXC_ADMIN_PASSWORD).' };
  }
  if (!onuRecordId) {
    return { ok: false, error: 'ID da ONU não informado.' };
  }

  const cleanBaseUrl = baseUrl.replace(/\/+$/, '');

  try {
    await ensureLoggedIn(cleanBaseUrl, adminEmail, adminPassword);

    let res = await getSession(cleanBaseUrl).client.get(
      `/aplicativo/radpop_radio_cliente_fibra/rel_22991.php?id=${encodeURIComponent(onuRecordId)}`
    );

    // Sessão pode ter expirado — tenta logar de novo uma vez.
    if (typeof res.data !== 'string' || !res.data.includes('Potência de ONU')) {
      session.loggedIn = false;
      await ensureLoggedIn(cleanBaseUrl, adminEmail, adminPassword);
      res = await getSession(cleanBaseUrl).client.get(
        `/aplicativo/radpop_radio_cliente_fibra/rel_22991.php?id=${encodeURIComponent(onuRecordId)}`
      );
    }

    if (typeof res.data !== 'string' || !res.data.includes('Potência de ONU')) {
      return { ok: false, error: 'Resposta inesperada do IXC ao consultar potência ao vivo.' };
    }

    const { onlineNow, fields } = parseReportHtml(res.data);

    return {
      ok: true,
      live: true,
      onlineNow,
      sinalRx: toNumberOrNull(fields['Sinal Rx']),
      sinalTx: toNumberOrNull(fields['Sinal Tx']),
      temperatura: toNumberOrNull(fields['Temperatura']),
      voltagem: toNumberOrNull(fields['Voltagem']),
      statusPotencia: fields['Status potência'] || null,
      causaUltimaQueda: fields['Causa da última queda'] || null,
      mac: fields['Mac'] || null,
      onuNumero: fields['Onu id'] || null,
      lastUpTime: fields['Last up time'] || null,
      lastDownTime: fields['Last down time'] || null,
      raw: fields,
    };
  } catch (err) {
    session = null; // descarta sessão possivelmente inválida
    console.error('[radpopClient] Erro na consulta ao vivo:', err.message);
    return { ok: false, error: err.message };
  }
}

module.exports = { getLivePower };
