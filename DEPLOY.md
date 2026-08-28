# Guia de Implantação — VPS com PM2 + Nginx + Certbot

Este guia assume uma VPS Ubuntu/Debian já provisionada, com acesso root (ou sudo) via SSH, e um domínio/subdomínio já apontado (registro DNS tipo **A**) para o IP da VPS — por exemplo `ontevento.suaempresa.com.br`.

## 1. Preparar o servidor

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git build-essential
```

### Instalar o Node.js (via NodeSource, versão LTS)

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
node -v   # confirme Node 18+ 
```

### Instalar o PM2 (gerenciador de processos)

```bash
sudo npm install -g pm2
```

## 2. Enviar e instalar a aplicação

```bash
# Na sua máquina local, envie o projeto para a VPS (via scp, rsync ou git clone)
scp -r ont-event-manager usuario@SEU_IP:/home/usuario/

# Na VPS:
cd /home/usuario/ont-event-manager
npm install --omit=dev
cp .env.example .env
nano .env   # preencha IXC_BASE_URL, IXC_TOKEN e a PORT desejada (ex: 3000)
```

> `better-sqlite3` compila um módulo nativo durante o `npm install` — por isso o pacote `build-essential` foi instalado no passo 1.

## 3. Subir a aplicação com PM2

```bash
cd /home/usuario/ont-event-manager
pm2 start server.js --name ont-event-manager

# Confirma que está rodando
pm2 status
pm2 logs ont-event-manager --lines 50
```

### Persistir o processo entre reboots da VPS

```bash
pm2 save
pm2 startup
# O comando acima imprime uma linha "sudo env PATH=... pm2 startup systemd -u usuario --hp /home/usuario"
# Copie e execute exatamente essa linha impressa no terminal.
```

### Comandos úteis do PM2

```bash
pm2 restart ont-event-manager   # reiniciar após atualizações
pm2 stop ont-event-manager
pm2 delete ont-event-manager
pm2 monit                       # monitor em tempo real de CPU/memória
```

## 4. Instalar e configurar o Nginx como proxy reverso

```bash
sudo apt install -y nginx
```

Crie o arquivo de configuração do site:

```bash
sudo nano /etc/nginx/sites-available/ont-event-manager
```

Cole o conteúdo abaixo (ajuste `ontevento.suaempresa.com.br` e a porta, se for diferente de 3000):

```nginx
server {
    listen 80;
    server_name ontevento.suaempresa.com.br;

    # Permite upload de imagens da planta baixa (até 15MB, igual ao limite do multer)
    client_max_body_size 20M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_cache_bypass $http_upgrade;
    }
}
```

Ative o site e teste a configuração:

```bash
sudo ln -s /etc/nginx/sites-available/ont-event-manager /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

Neste ponto, `http://ontevento.suaempresa.com.br` já deve carregar a aplicação (via proxy para a porta 3000).

## 5. Emitir certificado SSL grátis com Certbot

```bash
sudo apt install -y certbot python3-certbot-nginx

sudo certbot --nginx -d ontevento.suaempresa.com.br
```

O Certbot detecta automaticamente o bloco `server` criado acima, obtém o certificado da Let's Encrypt e reescreve a configuração do Nginx para redirecionar HTTP → HTTPS. Siga as perguntas interativas (e-mail para renovação, aceite dos termos, e opção de forçar redirecionamento HTTPS — recomendado escolher "sim").

### Renovação automática

O pacote `certbot` já instala um timer/cron que renova o certificado automaticamente antes de expirar. Para confirmar que está ativo:

```bash
sudo systemctl status certbot.timer
sudo certbot renew --dry-run   # simula a renovação, sem alterar nada
```

## 6. Checklist final

- [ ] `pm2 status` mostra `ont-event-manager` como `online`.
- [ ] `pm2 startup` configurado (processo sobrevive a reboot da VPS).
- [ ] `https://ontevento.suaempresa.com.br` carrega o painel com cadeado válido.
- [ ] Upload de planta baixa testado (verifique `client_max_body_size` no Nginx se der erro 413).
- [ ] Variáveis `IXC_BASE_URL` e `IXC_TOKEN` preenchidas no `.env` (ou configuradas via tela de Configurações da aplicação).
- [ ] Botão "Consultar status no IXC" retorna Online/Offline corretamente para uma ONT de teste.
- [ ] Backup do arquivo `data/onts.db` incluído na rotina de backup da VPS (é o banco SQLite com todo o cadastro).

## 7. Atualizando a aplicação no futuro

```bash
cd /home/usuario/ont-event-manager
git pull            # ou reenvie os arquivos atualizados via scp/rsync
npm install --omit=dev
pm2 restart ont-event-manager
```

## Notas sobre a API do IXC Provedor

- O endpoint usado por padrão em `ixcClient.js` é `/webservice/v1/radusuarios`, comum em instalações IXC para consultar logins PPPoE/rádio e seu status de sessão online. **Confirme o endpoint e os nomes de campo exatos com a documentação/suporte do seu IXC**, pois podem variar entre versões (alguns provedores expõem também `/webservice/v1/su_oltonu` para dados específicos de ONU na OLT).
- A autenticação usada é Basic Auth com o token da API como usuário e senha (padrão do IXC). Gere o token em **Configurações Gerais → API** dentro do painel administrativo do IXC.
- Caso a API do IXC não esteja acessível durante o evento (ex.: rede isolada), a aplicação continua funcionando normalmente — os botões "Marcar Online/Offline" permitem atualização manual do status sem depender da integração.
