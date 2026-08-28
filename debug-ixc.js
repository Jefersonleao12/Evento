require('dotenv').config();
const axios = require('axios');

const baseUrl = (process.env.IXC_BASE_URL || '').replace(/\/+$/, '');
const token = process.env.IXC_TOKEN || '';

const client = axios.create({
  baseURL: baseUrl,
  timeout: 8000,
  headers: {
    Authorization: 'Basic ' + Buffer.from(`${token}:${token}`).toString('base64'),
    'Content-Type': 'application/json',
    ixcsoft: 'listar',
  },
});

const login = process.argv[2];
client.post('/webservice/v1/radusuarios', {
  qtype: 'radusuarios.login',
  query: login,
  oper: '=',
  page: '1',
  rp: '5',
}).then(res => {
  console.log(JSON.stringify(res.data, null, 2));
}).catch(err => {
  console.error('Erro HTTP:', err.response ? JSON.stringify(err.response.data, null, 2) : err.message);
});
