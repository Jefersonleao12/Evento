/**
 * app.js
 * -----------------------------------------------------------------------
 * Lógica de frontend do Painel de Gestão Visual de Equipamentos (ONTs,
 * switches, access points, roteadores) do evento.
 *
 * Modos de mapa:
 *   1) PLANTA BAIXA (padrão, se uma imagem tiver sido carregada):
 *      usa Leaflet com CRS.Simple, onde pos_x/pos_y dos equipamentos são
 *      coordenadas em PIXELS da imagem original.
 *   2) FALLBACK OpenStreetMap (se nenhuma planta baixa foi definida):
 *      usa o CRS padrão do Leaflet (EPSG:3857); pos_x/pos_y dos
 *      equipamentos guardam, respectivamente, LATITUDE e LONGITUDE.
 *
 * Acesso: a aplicação exige login (usuário/senha). Usuários "admin" podem
 * cadastrar/editar/remover/mover equipamentos e trocar a planta baixa;
 * demais usuários autenticados ("viewer") só visualizam o mapa e podem
 * marcar status manualmente / consultar o IXC.
 *
 * Toda a comunicação com o backend é feita via fetch() para as rotas
 * definidas em server.js (prefixo /api).
 * -----------------------------------------------------------------------
 */

(function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * Estado global da aplicação
   * ------------------------------------------------------------------ */
  const state = {
    map: null,
    mode: 'osm', // 'floorplan' | 'osm'
    floorplan: { url: null, width: null, height: null },
    markers: new Map(), // id -> L.Marker
    onts: [],
    activeOntId: null,
    pendingClickLatLng: null, // ponto clicado aguardando confirmação no formulário
    pendingFixedPos: null, // posição travada ao adicionar equipamento no mesmo local de outro já existente
    activePickerPos: null, // posição do grupo atualmente aberto no seletor de equipamentos empilhados
    listStatusFilter: 'all', // filtro ativo no painel de listagem: all | online | offline | unknown
    currentUser: null, // { id, username, role }
    movingOntId: null, // id do equipamento atualmente em modo "mover no mapa"
    autoRefreshTimer: null,
    relativeTimeTimer: null,
    customIcons: {}, // equipment_type -> URL do ícone customizado (upload do admin)
  };

  const DEFAULT_OSM_CENTER = [-15.793889, -47.882778]; // Brasília, ajuste conforme o local do evento
  const DEFAULT_OSM_ZOOM = 18;
  const AUTO_REFRESH_MS = 60 * 1000; // auto-atualização do status via IXC
  // Zoom aplicado ao selecionar um equipamento na lista/busca — bem próximo,
  // pra achar o equipamento na hora em vez de só centralizar no zoom atual.
  const CLOSE_ZOOM = { floorplan: 3, osm: 19 };

  // Ícone de roteador (duas antenas) usado para equipamentos do tipo ONT,
  // no lugar do emoji genérico — SVG embutido para não depender de arquivo
  // externo nem de rede.
  const ONT_ROUTER_ICON = `
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor"
      stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <line x1="8" y1="12.5" x2="8" y2="5.5"></line>
      <line x1="16" y1="12.5" x2="16" y2="5.5"></line>
      <circle cx="8" cy="4.5" r="1"></circle>
      <circle cx="16" cy="4.5" r="1"></circle>
      <rect x="3" y="12.5" width="18" height="7" rx="1.5"></rect>
      <line x1="6.5" y1="16" x2="9" y2="16"></line>
      <line x1="11.5" y1="16" x2="17.5" y2="16"></line>
    </svg>`;

  const EQUIPMENT_ICONS = {
    ont: ONT_ROUTER_ICON,
    switch: '🔀',
    access_point: '📶',
    roteador: '🌐',
    mikrotik: '📡',
    outro: '📦',
  };
  const EQUIPMENT_LABELS = {
    ont: 'ONT',
    switch: 'Switch',
    access_point: 'Access Point',
    roteador: 'Roteador',
    mikrotik: 'Mikrotik BR',
    outro: 'Outro',
  };

  // Retorna o HTML do ícone de um tipo de equipamento: o ícone customizado
  // enviado pelo admin (se houver), senão o ícone padrão embutido.
  function equipmentIconHtml(type, sizePx = 18) {
    const customUrl = state.customIcons[type];
    if (customUrl) {
      return `<img src="${customUrl}" alt="" style="width:${sizePx}px;height:${sizePx}px;object-fit:contain;vertical-align:middle;" />`;
    }
    return EQUIPMENT_ICONS[type] || EQUIPMENT_ICONS.ont;
  }

  /* ------------------------------------------------------------------ *
   * Helpers de DOM
   * ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  // "owner" é um admin com privilégios extras (ver isOwner) — por isso
  // conta como admin em toda ação que já era restrita a admin.
  function isAdmin() {
    return Boolean(
      state.currentUser && (state.currentUser.role === 'admin' || state.currentUser.role === 'owner')
    );
  }

  // Reservado pra ações restritas a um único usuário (carregar planta
  // baixa e trocar ícones dos equipamentos).
  function isOwner() {
    return Boolean(state.currentUser && state.currentUser.role === 'owner');
  }

  function showToast(msg, isError = false) {
    const toast = $('#toast');
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.toggle('border-red-600', isError);
    toast.classList.toggle('text-red-300', isError);
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => toast.classList.add('hidden'), 3200);
  }

  async function api(path, options = {}) {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      ...options,
    });
    if (res.status === 401) {
      showLoginScreen();
      throw new Error('Sessão expirada. Faça login novamente.');
    }
    if (!res.ok) {
      let msg = `Erro ${res.status}`;
      try {
        const body = await res.json();
        msg = body.error || msg;
      } catch (_) {}
      throw new Error(msg);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  /* ------------------------------------------------------------------ *
   * Tempo relativo (última checagem)
   * ------------------------------------------------------------------ */
  function timeAgo(isoString) {
    if (!isoString) return null;
    // datetime('now') do SQLite retorna UTC sem sufixo de timezone.
    const iso = /Z|[+-]\d\d:\d\d$/.test(isoString) ? isoString : isoString.replace(' ', 'T') + 'Z';
    const then = new Date(iso).getTime();
    if (Number.isNaN(then)) return null;
    const diffSec = Math.max(0, Math.floor((Date.now() - then) / 1000));

    if (diffSec < 10) return 'agora mesmo';
    if (diffSec < 60) return `há ${diffSec}s`;
    const diffMin = Math.floor(diffSec / 60);
    if (diffMin < 60) return `há ${diffMin} min`;
    const diffH = Math.floor(diffMin / 60);
    if (diffH < 24) return `há ${diffH}h`;
    const diffD = Math.floor(diffH / 24);
    return `há ${diffD}d`;
  }

  /* ==================================================================== *
   * AUTENTICAÇÃO
   * ==================================================================== */

  function showLoginScreen() {
    stopAutoRefresh();
    stopRelativeTimeTicker();
    $('#app-header').classList.add('hidden');
    $('#app-shell').classList.add('hidden');
    $('#login-screen').classList.remove('hidden');
    $('#login-password').value = '';
    $('#login-error').classList.add('hidden');
    setTimeout(() => $('#login-username').focus(), 50);
  }

  function applyRoleVisibility() {
    $$('.admin-only').forEach((el) => el.classList.toggle('hidden', !isAdmin()));
    $$('.owner-only').forEach((el) => el.classList.toggle('hidden', !isOwner()));
  }

  async function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#app-header').classList.remove('hidden');
    $('#app-shell').classList.remove('hidden');
    $('#menu-username').textContent =
      `${state.currentUser.username} (${state.currentUser.role === 'admin' ? 'admin' : 'viewer'})`;
    applyRoleVisibility();
    await loadEquipmentIcons();

    if (!state.map) {
      await initMap();
    } else {
      await loadOnts();
    }
    startAutoRefresh();
    startRelativeTimeTicker();
  }

  async function checkSession() {
    try {
      const { user } = await api('/api/auth/me');
      if (user) {
        state.currentUser = user;
        await showApp();
        return;
      }
    } catch (_) {
      /* ignore, cai para tela de login */
    }
    showLoginScreen();
  }

  async function handleLoginSubmit(e) {
    e.preventDefault();
    const username = $('#login-username').value.trim();
    const password = $('#login-password').value;
    const errorEl = $('#login-error');
    errorEl.classList.add('hidden');

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Falha no login.');
      state.currentUser = body.user;
      await showApp();
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.classList.remove('hidden');
    }
  }

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch (_) {}
    state.currentUser = null;
    state.onts = [];
    for (const marker of state.markers.values()) state.map && state.map.removeLayer(marker);
    state.markers.clear();
    closeMenuPanel();
    showLoginScreen();
  }

  /* ==================================================================== *
   * INICIALIZAÇÃO DO MAPA
   * ==================================================================== */

  async function initMap() {
    const floorplan = await api('/api/floorplan').catch(() => ({ url: null }));
    state.floorplan = floorplan;

    if (floorplan && floorplan.url && floorplan.width && floorplan.height) {
      setupFloorplanMap(floorplan);
    } else {
      setupOsmMap();
    }

    state.map.on('click', onMapClick);
    await loadOnts();
  }

  function setupFloorplanMap(floorplan) {
    state.mode = 'floorplan';
    const { url, width, height } = floorplan;

    state.map = L.map('map', {
      crs: L.CRS.Simple,
      minZoom: -3,
      maxZoom: 4,
      zoomSnap: 0.25,
    });

    // Bounds da imagem: [[y0,x0],[y1,x1]] — em CRS.Simple, lat=y e lng=x.
    const bounds = [[0, 0], [height, width]];
    const overlay = L.imageOverlay(url, bounds).addTo(state.map);
    $('#map-loading')?.classList.remove('hidden');
    overlay.once('load', () => $('#map-loading')?.classList.add('hidden'));
    overlay.once('error', () => $('#map-loading')?.classList.add('hidden'));
    state.map.fitBounds(bounds);
    // Permite um pouco de "respiro" ao redor da planta baixa para facilitar o pan/zoom.
    const padding = Math.max(width, height) * 0.25;
    state.map.setMaxBounds([
      [bounds[0][0] - padding, bounds[0][1] - padding],
      [bounds[1][0] + padding, bounds[1][1] + padding],
    ]);
  }

  function setupOsmMap() {
    state.mode = 'osm';
    state.map = L.map('map').setView(DEFAULT_OSM_CENTER, DEFAULT_OSM_ZOOM);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 20,
      attribution: '&copy; OpenStreetMap contributors',
    }).addTo(state.map);
  }

  // Converte um clique do Leaflet (latlng) para pos_x/pos_y persistidos.
  // - floorplan: x = lng, y = lat (pixels da imagem)
  // - osm:       x = lat, y = lng (coordenadas geográficas)
  function latLngToPos(latlng) {
    if (state.mode === 'floorplan') {
      return { pos_x: latlng.lng, pos_y: latlng.lat };
    }
    return { pos_x: latlng.lat, pos_y: latlng.lng };
  }

  function posToLatLng(ont) {
    if (state.mode === 'floorplan') {
      return L.latLng(ont.pos_y, ont.pos_x);
    }
    return L.latLng(ont.pos_x, ont.pos_y);
  }

  function onMapClick(e) {
    if (!isAdmin()) return; // somente admin cadastra equipamentos no mapa
    if (state.movingOntId) return; // em modo "mover", clique no mapa não abre cadastro
    state.pendingClickLatLng = e.latlng;
    openFormModal(null);
  }

  // Tolerância (na unidade de coordenada de cada modo) para considerar dois
  // equipamentos "no mesmo local" — ex.: vários equipamentos na mesma caixa/
  // rack, cadastrados praticamente no mesmo ponto do mapa.
  const CLUSTER_TOLERANCE = { floorplan: 15, osm: 0.00005 };

  // Retorna todos os equipamentos (incluindo o próprio "ont") que estão a
  // uma distância igual ou menor que a tolerância dele — ou seja, o "grupo"
  // que compartilha aquele ponto do mapa.
  function findNearbyOnts(ont) {
    const tol = CLUSTER_TOLERANCE[state.mode] ?? CLUSTER_TOLERANCE.floorplan;
    return state.onts.filter(
      (o) => Math.abs(o.pos_x - ont.pos_x) <= tol && Math.abs(o.pos_y - ont.pos_y) <= tol
    );
  }

  /* ==================================================================== *
   * CARREGAMENTO E RENDERIZAÇÃO DOS EQUIPAMENTOS
   * ==================================================================== */

  async function loadOnts() {
    try {
      state.onts = await api('/api/onts');
      renderMarkers();
      renderStats();
    } catch (err) {
      showToast('Falha ao carregar equipamentos: ' + err.message, true);
    }
  }

  function markerIcon(ont) {
    const statusClass = `status-${markerStatusKey(ont)}`;
    const label = ont.nome_fantasia ? escapeHtml(ont.nome_fantasia) : '';
    const draggingClass = state.movingOntId === ont.id ? 'dragging' : '';
    const customUrl = state.customIcons[ont.equipment_type];
    const groupSize = findNearbyOnts(ont).length;
    const badge = groupSize > 1 ? `<span class="ont-marker-badge">${groupSize}</span>` : '';

    // Ícone customizado (foto enviada pelo admin): sem o anel/borda branca
    // padrão, só a imagem em boa proporção, com um badge de status no canto.
    const iconMarkup = customUrl
      ? `
        <div class="ont-marker-photo-wrap ${draggingClass}">
          <div class="ont-marker-photo"><img src="${customUrl}" alt="" /></div>
          <span class="ont-status-dot ${statusClass}"></span>
          ${badge}
        </div>`
      : `<div class="ont-marker ${statusClass} ${draggingClass}">${equipmentIconHtml(ont.equipment_type, 18)}${badge}</div>`;

    return L.divIcon({
      className: '',
      html: `
        <div class="ont-marker-wrap">
          ${iconMarkup}
          ${label ? `<div class="ont-marker-label">${label}</div>` : ''}
        </div>`,
      iconSize: [110, label ? (customUrl ? 62 : 56) : (customUrl ? 40 : 34)],
      iconAnchor: [55, customUrl ? 20 : 17],
      popupAnchor: [0, customUrl ? -20 : -17],
    });
  }

  function renderMarkers() {
    // Remove marcadores obsoletos
    const currentIds = new Set(state.onts.map((o) => o.id));
    for (const [id, marker] of state.markers.entries()) {
      if (!currentIds.has(id)) {
        state.map.removeLayer(marker);
        state.markers.delete(id);
      }
    }

    state.onts.forEach((ont) => {
      const latlng = posToLatLng(ont);
      let marker = state.markers.get(ont.id);
      if (marker) {
        // Não sobrescreve a posição de um marcador que está sendo arrastado agora.
        if (state.movingOntId !== ont.id) marker.setLatLng(latlng);
        marker.setIcon(markerIcon(ont));
      } else {
        marker = L.marker(latlng, { icon: markerIcon(ont), draggable: false }).addTo(state.map);
        marker.on('click', () => {
          // O clique atinge apenas o marcador do topo quando há vários no
          // mesmo ponto — busca o grupo atual (não o closure antigo) pra
          // sempre refletir o estado mais recente.
          const current = state.onts.find((o) => o.id === ont.id) || ont;
          const group = findNearbyOnts(current);
          if (group.length > 1) {
            openEquipmentPicker(group);
          } else {
            openDrawer(ont.id);
          }
        });
        state.markers.set(ont.id, marker);
      }
    });
  }

  async function renderStats() {
    try {
      const stats = await api('/api/stats');
      $('#stats-line').textContent =
        `${stats.total} equipamentos • ${stats.online} online • ${stats.offline} offline • ${stats.unknown} sem dados`;
      $('#legend-online-count').textContent = stats.online;
      $('#legend-offline-count').textContent = stats.offline;
      $('#legend-unknown-count').textContent = stats.unknown;
      $('#legend-total-count').textContent = stats.total;
    } catch (_) {
      $('#stats-line').textContent = `${state.onts.length} equipamentos cadastrados`;
    }
  }

  /* ==================================================================== *
   * MODAL DE CADASTRO / EDIÇÃO (somente admin)
   * ==================================================================== */

  function openFormModal(ontId) {
    if (!isAdmin()) return;
    const isEdit = Boolean(ontId);
    const ont = isEdit ? state.onts.find((o) => o.id === ontId) : null;

    $('#form-title').textContent = isEdit ? `Editar equipamento #${ont.id}` : 'Cadastrar equipamento';
    $('#f-id').value = isEdit ? ont.id : '';
    $('#f-equipment-type').value = isEdit ? ont.equipment_type || 'ont' : 'ont';
    $('#f-nome-fantasia').value = isEdit ? ont.nome_fantasia || '' : '';
    $('#f-tag').value = isEdit ? ont.tag_label || '' : '';
    $('#f-asset').value = isEdit ? ont.asset_number || '' : '';
    $('#f-mac').value = isEdit ? ont.mac_address || '' : '';
    $('#f-ssid').value = isEdit ? ont.wifi_ssid || '' : '';
    $('#f-password').value = '';
    $('#f-password').placeholder = isEdit ? '(mantido se deixado em branco)' : '********';
    $('#f-ixc').value = isEdit ? ont.ixc_login_id || '' : '';
    $('#f-notes').value = isEdit ? ont.notes || '' : '';

    let pos;
    if (isEdit) {
      pos = { pos_x: ont.pos_x, pos_y: ont.pos_y };
    } else if (state.pendingFixedPos) {
      // Veio do botão "Adicionar equipamento neste local" — usa a mesma
      // posição de um equipamento já existente (não um clique no mapa).
      pos = state.pendingFixedPos;
    } else if (state.pendingClickLatLng) {
      pos = latLngToPos(state.pendingClickLatLng);
    } else {
      pos = { pos_x: 0, pos_y: 0 };
    }
    $('#f-pos-x').value = pos.pos_x;
    $('#f-pos-y').value = pos.pos_y;
    $('#f-coords-preview').textContent = `X: ${Number(pos.pos_x).toFixed(1)}, Y: ${Number(pos.pos_y).toFixed(1)}`;

    $('#form-modal').classList.remove('hidden');
  }

  function closeFormModal() {
    $('#form-modal').classList.add('hidden');
    state.pendingClickLatLng = null;
    state.pendingFixedPos = null;
    $('#ont-form').reset();
  }

  // Abre o formulário de cadastro travado numa posição específica (mesmo
  // ponto de um equipamento já existente) — usado pelos botões "Adicionar
  // equipamento neste local", tanto no drawer quanto no seletor de
  // equipamentos empilhados.
  function openFormModalAtPosition(pos) {
    if (!isAdmin()) return;
    state.pendingFixedPos = pos;
    closeDrawer();
    closeEquipmentPicker();
    openFormModal(null);
  }

  async function handleFormSubmit(e) {
    e.preventDefault();
    const id = $('#f-id').value;
    const passwordValue = $('#f-password').value.trim();
    const payload = {
      equipment_type: $('#f-equipment-type').value,
      nome_fantasia: $('#f-nome-fantasia').value.trim(),
      tag_label: $('#f-tag').value.trim(),
      asset_number: $('#f-asset').value.trim(),
      mac_address: $('#f-mac').value.trim(),
      wifi_ssid: $('#f-ssid').value.trim(),
      ixc_login_id: $('#f-ixc').value.trim(),
      notes: $('#f-notes').value.trim(),
      pos_x: parseFloat($('#f-pos-x').value),
      pos_y: parseFloat($('#f-pos-y').value),
    };
    // Só envia a senha se o usuário digitou algo (evita apagar a senha salva
    // ao editar sem preencher esse campo novamente).
    if (!id || passwordValue) payload.wifi_password = passwordValue;

    try {
      if (id) {
        await api(`/api/onts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Equipamento atualizado com sucesso.');
      } else {
        await api('/api/onts', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Equipamento cadastrado com sucesso.');
      }
      closeFormModal();
      await loadOnts();
    } catch (err) {
      showToast('Erro ao salvar: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * SELETOR DE EQUIPAMENTOS (quando há mais de um no mesmo local)
   * ==================================================================== */

  function openEquipmentPicker(group) {
    state.activePickerPos = { pos_x: group[0].pos_x, pos_y: group[0].pos_y };
    const dotClass = { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500', retirado: 'bg-purple-500' };
    $('#picker-items').innerHTML = group
      .map(
        (o) => `
      <li data-id="${o.id}" class="cursor-pointer bg-slate-900 hover:bg-slate-700/60 rounded-lg p-3 flex items-center gap-3">
        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotClass[markerStatusKey(o)]}"></span>
        <div class="min-w-0 flex-1">
          <p class="font-medium truncate">${equipmentIconHtml(o.equipment_type, 16)} ${escapeHtml(o.tag_label)}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(EQUIPMENT_LABELS[o.equipment_type] || '')}${o.nome_fantasia ? ' • ' + escapeHtml(o.nome_fantasia) : ''}</p>
        </div>
      </li>`
      )
      .join('');

    $$('#picker-items li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        closeEquipmentPicker();
        openDrawer(Number(li.dataset.id));
      });
    });

    $('#picker-modal').classList.remove('hidden');
  }

  function closeEquipmentPicker() {
    $('#picker-modal').classList.add('hidden');
  }

  /* ==================================================================== *
   * DRAWER DE DETALHES / AÇÕES RÁPIDAS
   * ==================================================================== */

  function statusLabel(status) {
    return { online: 'Online', offline: 'Offline', unknown: 'Sem Status' }[status] || 'Sem Status';
  }

  function hasIxcLogin(ont) {
    return Boolean(ont.ixc_login_id && ont.ixc_login_id.trim());
  }

  // Sem login IXC não há como confirmar status real — sempre "sem status"
  // na exibição, mesmo que algum valor antigo tenha ficado salvo no banco.
  function effectiveStatus(ont) {
    return hasIxcLogin(ont) ? ont.status || 'unknown' : 'unknown';
  }

  // Cor/estado exibido no marcador e nas listas: "retirado" (roxo) tem
  // prioridade sobre o status de conexão real, pois sinaliza que o
  // equipamento físico já não está mais neste local.
  function markerStatusKey(ont) {
    return ont.retirado ? 'retirado' : effectiveStatus(ont);
  }

  function openDrawer(ontId) {
    const ont = state.onts.find((o) => o.id === ontId);
    if (!ont) return;
    state.activeOntId = ontId;

    // innerHTML (não textContent) porque o ícone do tipo ONT é um SVG embutido;
    // tag_label vem de entrada do usuário, por isso passa por escapeHtml().
    $('#d-title').innerHTML =
      `<span class="inline-flex items-center align-middle">${equipmentIconHtml(ont.equipment_type, 16)}</span> ${escapeHtml(ont.tag_label)}`.trim();
    $('#d-nome-fantasia').textContent = ont.nome_fantasia || '';
    const status = effectiveStatus(ont);
    $('#d-status-dot').className =
      'w-2.5 h-2.5 rounded-full shrink-0 ' +
      { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500' }[status];
    $('#d-equipment-type').textContent = EQUIPMENT_LABELS[ont.equipment_type] || EQUIPMENT_LABELS.ont;
    $('#d-asset').textContent = ont.asset_number || '—';
    $('#d-status-text').textContent = statusLabel(status);
    $('#d-mac').textContent = ont.mac_address || '—';
    $('#d-ssid').textContent = ont.wifi_ssid || '—';
    $('#d-password').textContent = '••••••••';
    $('#d-password').dataset.revealed = 'false';
    $('#btn-toggle-password').textContent = 'mostrar';
    $('#d-ixc').textContent = ont.ixc_login_id || '—';
    $('#d-notes').textContent = ont.notes || '—';
    updateLastCheckText();

    // Sem login IXC: esconde ações de marcar/consultar status manualmente
    // e mostra um aviso explicando o porquê.
    const hasLogin = hasIxcLogin(ont);
    $('#d-status-actions').classList.toggle('hidden', !hasLogin);
    $('#btn-check-ixc').classList.toggle('hidden', !hasLogin);
    $('#btn-check-power').classList.toggle('hidden', !hasLogin);
    $('#btn-access-device').classList.toggle('hidden', !hasLogin);
    $('#d-no-login-note').classList.toggle('hidden', hasLogin);
    $('#d-power-box').classList.add('hidden'); // só mostra de novo quando o usuário pedir

    // Retirado para o almoxarifado: mostra quem retirou e quando, troca o
    // botão "Retirar Equipamento" por "Devolver ao local".
    $('#d-retirado-note').classList.toggle('hidden', !ont.retirado);
    $('#d-retirado-por').textContent = ont.retirado_por_nome || '—';
    $('#d-retirado-em').textContent = timeAgo(ont.retirado_em) || '';
    $('#btn-retirar').classList.toggle('hidden', Boolean(ont.retirado));
    $('#btn-devolver').classList.toggle('hidden', !ont.retirado);

    const moving = state.movingOntId === ont.id;
    $('#btn-toggle-move-label').textContent = moving ? 'Fixar posição' : 'Mover no mapa';
    $('#btn-toggle-move').classList.toggle('bg-emerald-700/40', moving);
    $('#btn-toggle-move').classList.toggle('border-emerald-700', moving);
    $('#btn-toggle-move').classList.toggle('text-emerald-300', moving);

    $('#drawer').classList.remove('hidden');
  }

  function updateLastCheckText() {
    const ont = state.onts.find((o) => o.id === state.activeOntId);
    if (!ont || $('#drawer').classList.contains('hidden')) return;
    const rel = timeAgo(ont.last_checked_at);
    $('#d-last-check').textContent = rel ? `Última checagem: ${rel}` : 'Nunca verificado no IXC';
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    state.activeOntId = null;
  }

  function togglePasswordVisibility() {
    if (!state.activeOntId) return;
    const el = $('#d-password');
    const revealed = el.dataset.revealed === 'true';

    if (revealed) {
      el.textContent = '••••••••';
      el.dataset.revealed = 'false';
      $('#btn-toggle-password').textContent = 'mostrar';
      return;
    }

    api(`/api/onts/${state.activeOntId}/wifi-password`)
      .then((body) => {
        el.textContent = body.wifi_password || '—';
        el.dataset.revealed = 'true';
        $('#btn-toggle-password').textContent = 'ocultar';
      })
      .catch((err) => showToast('Erro ao revelar senha: ' + err.message, true));
  }

  async function setActiveOntStatus(status) {
    if (!state.activeOntId) return;
    try {
      await api(`/api/onts/${state.activeOntId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      showToast(`Status atualizado para ${statusLabel(status)}.`);
      await loadOnts();
      openDrawer(state.activeOntId);
    } catch (err) {
      showToast('Erro ao atualizar status: ' + err.message, true);
    }
  }

  async function checkActiveOntOnIxc() {
    if (!state.activeOntId) return;
    showToast('Consultando status no IXC...');
    try {
      const result = await api(`/api/onts/${state.activeOntId}/check-status`, { method: 'POST' });
      showToast(`IXC: ${statusLabel(result.ont.status)}${result.ixc.error ? ' — ' + result.ixc.error : ''}`);
      await loadOnts();
      openDrawer(state.activeOntId);
    } catch (err) {
      showToast('Erro ao consultar IXC: ' + err.message, true);
    }
  }

  // Consulta ao vivo a potência/sinal da ONU (Sinal Rx/Tx, Temperatura,
  // Voltagem) no IXC — só existe para equipamentos numa ONU de fibra
  // monitorada; não é salva no banco, é um diagnóstico pontual.
  async function checkActiveOntPower() {
    if (!state.activeOntId) return;
    showToast('Consultando potência da ONU...');
    try {
      const result = await api(`/api/onts/${state.activeOntId}/power`, { method: 'POST' });
      renderPowerBox(result);
    } catch (err) {
      showToast('Erro ao consultar potência: ' + err.message, true);
    }
  }

  function renderPowerBox(result) {
    $('#d-power-box').classList.remove('hidden');
    $('#d-power-time').textContent = result.live ? 'ao vivo agora' : 'em cache (não é ao vivo)';

    if (!result.ok) {
      $('#d-power-grid').innerHTML = '';
      $('#d-power-error').textContent = result.error || 'Não foi possível consultar a potência.';
      $('#d-power-error').classList.remove('hidden');
      return;
    }

    $('#d-power-error').classList.add('hidden');
    const fields = [
      ['Sinal Rx', result.sinalRx !== null ? `${result.sinalRx} dBm` : '—'],
      ['Sinal Tx', result.sinalTx !== null ? `${result.sinalTx} dBm` : '—'],
      ['Temperatura', result.temperatura !== null ? `${result.temperatura} °C` : '—'],
      ['Voltagem', result.voltagem !== null ? `${result.voltagem} V` : '—'],
    ];
    if (result.live) {
      fields.push(['Status potência', result.statusPotencia || (result.onlineNow === false ? 'ONU offline' : '—')]);
      if (result.onlineNow === false && result.causaUltimaQueda) {
        fields.push(['Causa da última queda', result.causaUltimaQueda]);
      }
    }
    $('#d-power-grid').innerHTML = fields
      .map(
        ([label, value]) => `
      <div>
        <p class="text-slate-500">${label}</p>
        <p class="font-mono">${escapeHtml(String(value))}</p>
      </div>`
      )
      .join('');
  }

  // Consulta o IP atual do login no IXC (na hora, nunca um valor salvo —
  // o IP muda a cada vez que o equipamento reinicia/reconecta) e abre a
  // interface de administração dele em uma nova aba.
  async function accessActiveDevice() {
    if (!state.activeOntId) return;

    // Abre a aba já de imediato, ainda dentro do clique do usuário — é o
    // único jeito confiável de não cair no bloqueio de pop-up do navegador,
    // já que a busca do IP é assíncrona. Preenche o endereço quando o IP
    // chegar; se não conseguir, mostra um aviso na própria aba.
    // (Sem "noopener" de propósito: por especificação, window.open() com
    // noopener sempre devolve null — perderíamos a referência necessária
    // para definir o endereço depois que o IP chegar.)
    const newTab = window.open('about:blank', '_blank');

    showToast('Consultando IP atual no IXC...');
    try {
      const result = await api(`/api/onts/${state.activeOntId}/check-status`, { method: 'POST' });
      const ip = result.ixc.raw && result.ixc.raw.ip;
      await loadOnts();
      if (state.activeOntId) openDrawer(state.activeOntId);

      if (!ip) {
        showToast('IP indisponível — equipamento sem sessão ativa no IXC no momento.', true);
        if (newTab) newTab.close();
        return;
      }
      const url = `http://${ip}`;
      if (newTab) {
        newTab.location.href = url;
        showToast(`Abrindo ${url}...`);
      } else {
        showToast(`IP: ${ip} — o navegador bloqueou a nova aba, copie o IP e acesse manualmente.`, true);
      }
    } catch (err) {
      if (newTab) newTab.close();
      showToast('Erro ao consultar IXC: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * MENU DE AÇÕES (cabeçalho enxuto no celular — ações secundárias
   * ficam aqui em vez de lotar a barra de ícones)
   * ==================================================================== */

  function openMenuPanel() {
    $('#menu-panel').classList.remove('hidden');
  }

  function closeMenuPanel() {
    $('#menu-panel').classList.add('hidden');
  }

  /* ==================================================================== *
   * ALMOXARIFADO ("Retirar Equipamento" / "Devolver ao local")
   * ==================================================================== */

  async function retirarActiveOnt() {
    if (!state.activeOntId) return;
    if (!confirm('Retirar este equipamento para o seu almoxarifado? Ele continua sinalizado no mapa (em roxo) só como referência.')) return;
    try {
      await api(`/api/onts/${state.activeOntId}/retirar`, { method: 'PATCH' });
      showToast('Equipamento retirado — agora está no seu almoxarifado.');
      await loadOnts();
      openDrawer(state.activeOntId);
    } catch (err) {
      showToast('Erro ao retirar equipamento: ' + err.message, true);
    }
  }

  async function devolverActiveOnt() {
    if (!state.activeOntId) return;
    try {
      await api(`/api/onts/${state.activeOntId}/devolver`, { method: 'PATCH' });
      showToast('Equipamento devolvido ao local.');
      await loadOnts();
      openDrawer(state.activeOntId);
    } catch (err) {
      showToast('Erro ao devolver equipamento: ' + err.message, true);
    }
  }

  let almoxarifadoItems = [];

  async function openAlmoxarifado() {
    $('#almoxarifado-modal').classList.remove('hidden');
    $('#almoxarifado-items').innerHTML = `<li class="text-slate-500 text-center py-6 text-xs">Carregando...</li>`;
    try {
      almoxarifadoItems = await api('/api/almoxarifado');
      renderAlmoxarifado();
    } catch (err) {
      $('#almoxarifado-items').innerHTML = '';
      showToast('Erro ao carregar almoxarifado: ' + err.message, true);
    }
  }

  function closeAlmoxarifado() {
    $('#almoxarifado-modal').classList.add('hidden');
  }

  function renderAlmoxarifado() {
    const empty = almoxarifadoItems.length === 0;
    $('#almoxarifado-empty').classList.toggle('hidden', !empty);
    $('#almoxarifado-items').innerHTML = almoxarifadoItems
      .map(
        (o) => `
      <li data-id="${o.id}" class="cursor-pointer bg-slate-900 hover:bg-slate-700/60 rounded-lg p-3 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium truncate">${equipmentIconHtml(o.equipment_type, 14)} ${escapeHtml(o.tag_label)}${o.nome_fantasia ? ' — ' + escapeHtml(o.nome_fantasia) : ''}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(EQUIPMENT_LABELS[o.equipment_type] || '')} • retirado ${escapeHtml(timeAgo(o.retirado_em) || '')}</p>
        </div>
        <span class="w-2.5 h-2.5 rounded-full shrink-0 bg-purple-500"></span>
      </li>`
      )
      .join('');

    $$('#almoxarifado-items li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = Number(li.dataset.id);
        closeAlmoxarifado();
        const ont = state.onts.find((o) => o.id === id);
        if (ont) {
          const closeZoom = CLOSE_ZOOM[state.mode] ?? CLOSE_ZOOM.osm;
          state.map.setView(posToLatLng(ont), Math.max(state.map.getZoom(), closeZoom));
        }
        openDrawer(id);
      });
    });
  }

  async function deleteActiveOnt() {
    if (!isAdmin() || !state.activeOntId) return;
    if (!confirm('Remover este equipamento do mapa? Esta ação não pode ser desfeita.')) return;
    try {
      await api(`/api/onts/${state.activeOntId}`, { method: 'DELETE' });
      showToast('Equipamento removido.');
      closeDrawer();
      await loadOnts();
    } catch (err) {
      showToast('Erro ao remover: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * MOVER / FIXAR POSIÇÃO NO MAPA (somente admin)
   * ==================================================================== */

  function toggleMoveActiveOnt() {
    if (!isAdmin() || !state.activeOntId) return;
    const id = state.activeOntId;
    const marker = state.markers.get(id);
    if (!marker) return;

    if (state.movingOntId === id) {
      // Estava movendo: fixa a posição atual do marcador.
      finalizeMove(id, marker);
    } else {
      // Entra em modo "mover": permite arrastar o marcador livremente.
      if (state.movingOntId) {
        // Cancela um "mover" pendente de outro marcador, se houver.
        const prevMarker = state.markers.get(state.movingOntId);
        if (prevMarker) prevMarker.dragging.disable();
        state.movingOntId = null;
      }
      state.movingOntId = id;
      marker.dragging.enable();
      marker.setIcon(markerIcon(state.onts.find((o) => o.id === id)));
      showToast('Arraste o marcador até o local ideal e toque em "Fixar posição".');
      openDrawer(id);
    }
  }

  async function finalizeMove(id, marker) {
    const pos = latLngToPos(marker.getLatLng());
    marker.dragging.disable();
    state.movingOntId = null;
    try {
      await api(`/api/onts/${id}/position`, { method: 'PATCH', body: JSON.stringify(pos) });
      showToast('Posição fixada com sucesso.');
      await loadOnts();
      if (state.activeOntId === id) openDrawer(id);
    } catch (err) {
      showToast('Erro ao fixar posição: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * ATUALIZAÇÃO EM LOTE (botão IXC do cabeçalho + auto-refresh)
   * ==================================================================== */

  async function checkAllOnIxc(silent = false) {
    if (!silent) showToast('Consultando todas as ONTs no IXC...');
    try {
      const result = await api('/api/onts/check-status', { method: 'POST' });
      if (!silent) showToast(`Consulta concluída: ${result.checked} ONT(s) verificadas.`);
      await loadOnts();
      if (state.activeOntId) updateLastCheckText();
    } catch (err) {
      if (!silent) showToast('Erro na consulta em lote: ' + err.message, true);
    }
  }

  function startAutoRefresh() {
    stopAutoRefresh();
    // O servidor já consulta o IXC periodicamente sozinho (independente de
    // haver alguém com o painel aberto). Aqui só relemos os dados já
    // atualizados no banco, em vez de cada aba aberta bater na API do IXC
    // por conta própria — evita sobrecarregar o IXC com consultas repetidas.
    state.autoRefreshTimer = setInterval(() => {
      if (document.hidden) return; // evita gastar chamadas com a aba em segundo plano
      loadOnts();
      if (state.activeOntId) updateLastCheckText();
    }, AUTO_REFRESH_MS);
  }

  function stopAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    state.autoRefreshTimer = null;
  }

  function startRelativeTimeTicker() {
    stopRelativeTimeTicker();
    state.relativeTimeTimer = setInterval(updateLastCheckText, 30 * 1000);
  }

  function stopRelativeTimeTicker() {
    if (state.relativeTimeTimer) clearInterval(state.relativeTimeTimer);
    state.relativeTimeTimer = null;
  }

  /* ==================================================================== *
   * UPLOAD DA PLANTA BAIXA (somente admin)
   * ==================================================================== */

  function handlePlantFileSelected(e) {
    if (!isOwner()) return;
    const file = e.target.files[0];
    if (!file) return;

    const img = new Image();
    const objectUrl = URL.createObjectURL(file);
    img.onload = async () => {
      const width = img.naturalWidth;
      const height = img.naturalHeight;
      URL.revokeObjectURL(objectUrl);

      const formData = new FormData();
      formData.append('floorplan', file);
      formData.append('width', width);
      formData.append('height', height);

      try {
        const res = await fetch('/api/floorplan', { method: 'POST', body: formData });
        if (!res.ok) throw new Error('Falha no upload.');
        showToast('Planta baixa carregada. Recarregando mapa...');
        setTimeout(() => window.location.reload(), 900);
      } catch (err) {
        showToast('Erro no upload da planta: ' + err.message, true);
      }
    };
    img.src = objectUrl;
  }

  /* ==================================================================== *
   * ÍCONES CUSTOMIZADOS POR TIPO DE EQUIPAMENTO (somente admin)
   * ==================================================================== */

  async function loadEquipmentIcons() {
    try {
      state.customIcons = await api('/api/equipment-icons');
    } catch (_) {
      state.customIcons = {};
    }
  }

  function openIconsModal() {
    if (!isOwner()) return;
    renderIconsList();
    $('#icons-modal').classList.remove('hidden');
  }

  function closeIconsModal() {
    $('#icons-modal').classList.add('hidden');
  }

  function renderIconsList() {
    const types = Object.keys(EQUIPMENT_LABELS);
    $('#icons-list').innerHTML = types
      .map((type) => {
        const hasCustom = Boolean(state.customIcons[type]);
        return `
        <div class="bg-slate-900 rounded-lg p-3 flex items-center gap-3" data-icon-row="${type}">
          <div class="w-9 h-9 rounded-full bg-slate-700 flex items-center justify-center shrink-0 text-white">
            ${equipmentIconHtml(type, 20)}
          </div>
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium">${escapeHtml(EQUIPMENT_LABELS[type])}</p>
            <p class="text-[11px] text-slate-500">${hasCustom ? 'Ícone customizado' : 'Usando ícone padrão'}</p>
          </div>
          <label class="text-[11px] px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 cursor-pointer shrink-0">
            Enviar
            <input type="file" data-icon-upload="${type}" accept="image/png,image/jpeg,image/webp,image/svg+xml" class="hidden" />
          </label>
          ${hasCustom ? `<button type="button" data-icon-reset="${type}" class="text-[11px] px-2.5 py-1.5 rounded-lg bg-red-900/60 hover:bg-red-900 text-red-200 shrink-0">Restaurar</button>` : ''}
        </div>`;
      })
      .join('');

    $$('#icons-list [data-icon-upload]').forEach((input) => {
      input.addEventListener('change', (e) => handleIconUpload(input.dataset.iconUpload, e.target.files[0]));
    });
    $$('#icons-list [data-icon-reset]').forEach((btn) => {
      btn.addEventListener('click', () => handleIconReset(btn.dataset.iconReset));
    });
  }

  async function handleIconUpload(type, file) {
    if (!file) return;
    const formData = new FormData();
    formData.append('icon', file);
    try {
      const res = await fetch(`/api/equipment-icons/${type}`, { method: 'POST', body: formData });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Falha no upload.');
      state.customIcons[type] = body.url;
      showToast(`Ícone de ${EQUIPMENT_LABELS[type]} atualizado.`);
      renderIconsList();
      renderMarkers();
    } catch (err) {
      showToast('Erro ao enviar ícone: ' + err.message, true);
    }
  }

  async function handleIconReset(type) {
    try {
      await api(`/api/equipment-icons/${type}`, { method: 'DELETE' });
      delete state.customIcons[type];
      showToast(`Ícone de ${EQUIPMENT_LABELS[type]} restaurado ao padrão.`);
      renderIconsList();
      renderMarkers();
    } catch (err) {
      showToast('Erro ao restaurar ícone: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * RELATÓRIO DE WI-FI (nome fantasia, SSID, senha) — somente admin
   * ==================================================================== */

  let wifiReportRows = [];

  async function openWifiReport() {
    if (!isAdmin()) return;
    $('#wifi-report-modal').classList.remove('hidden');
    $('#wifi-report-rows').innerHTML = `<tr><td colspan="5" class="py-3 text-slate-500">Carregando...</td></tr>`;
    try {
      wifiReportRows = await api('/api/reports/wifi');
      renderWifiReport();
    } catch (err) {
      $('#wifi-report-rows').innerHTML = '';
      showToast('Erro ao carregar relatório: ' + err.message, true);
    }
  }

  function closeWifiReport() {
    $('#wifi-report-modal').classList.add('hidden');
  }

  function renderWifiReport() {
    const empty = wifiReportRows.length === 0;
    $('#wifi-report-empty').classList.toggle('hidden', !empty);
    $('#wifi-report-table').classList.toggle('hidden', empty);
    $('#wifi-report-rows').innerHTML = wifiReportRows
      .map(
        (o) => `
      <tr class="border-b border-slate-700/60">
        <td class="py-1.5 pr-3">${escapeHtml(o.nome_fantasia || '—')}</td>
        <td class="py-1.5 pr-3">${escapeHtml(o.tag_label || '—')}</td>
        <td class="py-1.5 pr-3">${escapeHtml(EQUIPMENT_LABELS[o.equipment_type] || '')}</td>
        <td class="py-1.5 pr-3 font-mono">${escapeHtml(o.wifi_ssid || '—')}</td>
        <td class="py-1.5 pr-3 font-mono">${escapeHtml(o.wifi_password || '—')}</td>
      </tr>`
      )
      .join('');
  }

  function csvField(value) {
    const str = String(value ?? '');
    return /[;"\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  }

  function downloadWifiReportCsv() {
    if (wifiReportRows.length === 0) return;
    const header = ['Nome Fantasia', 'Etiqueta', 'Tipo', 'Wi-Fi (SSID)', 'Senha'];
    const lines = [header.join(';')].concat(
      wifiReportRows.map((o) =>
        [
          csvField(o.nome_fantasia),
          csvField(o.tag_label),
          csvField(EQUIPMENT_LABELS[o.equipment_type] || ''),
          csvField(o.wifi_ssid),
          csvField(o.wifi_password),
        ].join(';')
      )
    );
    // BOM no início garante que o Excel abra os acentos corretamente (UTF-8).
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `relatorio-wifi-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  /* ==================================================================== *
   * PAINEL DE LISTAGEM
   * ==================================================================== */

  function openListPanel() {
    state.listStatusFilter = 'all';
    renderListFilterTabs();
    renderListItems('');
    $('#list-panel').classList.remove('hidden');
    $('#list-search').value = '';
    $('#list-search').focus();
  }

  function closeListPanel() {
    $('#list-panel').classList.add('hidden');
  }

  const LIST_STATUS_FILTERS = [
    { key: 'all', label: 'Todos' },
    { key: 'online', label: 'Online' },
    { key: 'offline', label: 'Offline' },
    { key: 'unknown', label: 'Sem Status' },
  ];

  function renderListFilterTabs() {
    $('#list-filter-tabs').innerHTML = LIST_STATUS_FILTERS.map((f) => {
      const active = state.listStatusFilter === f.key;
      return `<button type="button" data-filter="${f.key}" class="px-2.5 py-1 rounded-full text-[11px] font-medium border ${
        active
          ? 'bg-emerald-600 border-emerald-600 text-white'
          : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-slate-200'
      }">${f.label}</button>`;
    }).join('');

    $$('#list-filter-tabs [data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.listStatusFilter = btn.dataset.filter;
        renderListFilterTabs();
        renderListItems($('#list-search').value);
      });
    });
  }

  function renderListItems(filter) {
    const term = filter.trim().toLowerCase();
    const statusFilter = state.listStatusFilter || 'all';
    const filtered = state.onts.filter((o) => {
      if (statusFilter !== 'all' && effectiveStatus(o) !== statusFilter) return false;
      if (!term) return true;
      return [o.tag_label, o.mac_address, o.asset_number, o.ixc_login_id, o.nome_fantasia]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(term));
    });

    const dotClass = { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500', retirado: 'bg-purple-500' };

    $('#list-items').innerHTML = filtered
      .map(
        (o) => `
      <li data-id="${o.id}" class="cursor-pointer bg-slate-900 hover:bg-slate-700/60 rounded-lg p-3 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium truncate">${equipmentIconHtml(o.equipment_type, 14)} ${escapeHtml(o.tag_label)}${o.nome_fantasia ? ' — ' + escapeHtml(o.nome_fantasia) : ''}${o.retirado ? ' <span class="text-purple-400">(retirado)</span>' : ''}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(o.asset_number || 'sem patrimônio')} • ${escapeHtml(o.mac_address || 'sem MAC')} • ${escapeHtml(timeAgo(o.last_checked_at) || 'nunca verificado')}</p>
        </div>
        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotClass[markerStatusKey(o)]}"></span>
      </li>`
      )
      .join('') || `<li class="text-slate-500 text-center py-6 text-xs">Nenhum equipamento encontrado.</li>`;

    $$('#list-items li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = Number(li.dataset.id);
        closeListPanel();
        const ont = state.onts.find((o) => o.id === id);
        if (ont) {
          const closeZoom = CLOSE_ZOOM[state.mode] ?? CLOSE_ZOOM.osm;
          state.map.setView(posToLatLng(ont), Math.max(state.map.getZoom(), closeZoom));
          openDrawer(id);
        }
      });
    });
  }

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* ==================================================================== *
   * BOOTSTRAP / EVENT LISTENERS
   * ==================================================================== */

  function bindEvents() {
    $('#login-form').addEventListener('submit', handleLoginSubmit);
    $('#btn-logout').addEventListener('click', handleLogout);

    $$('[data-close-modal]').forEach((el) => el.addEventListener('click', closeFormModal));
    $$('[data-close-drawer]').forEach((el) => el.addEventListener('click', closeDrawer));
    $$('[data-close-list]').forEach((el) => el.addEventListener('click', closeListPanel));
    $$('[data-close-icons]').forEach((el) => el.addEventListener('click', closeIconsModal));
    $$('[data-close-picker]').forEach((el) => el.addEventListener('click', closeEquipmentPicker));
    $$('[data-close-wifi-report]').forEach((el) => el.addEventListener('click', closeWifiReport));
    $$('[data-close-almoxarifado]').forEach((el) => el.addEventListener('click', closeAlmoxarifado));
    $$('[data-close-menu]').forEach((el) => el.addEventListener('click', closeMenuPanel));
    $('#btn-menu').addEventListener('click', openMenuPanel);
    $('#btn-icons').addEventListener('click', () => { closeMenuPanel(); openIconsModal(); });
    $('#btn-wifi-report').addEventListener('click', () => { closeMenuPanel(); openWifiReport(); });
    $('#btn-almoxarifado').addEventListener('click', () => { closeMenuPanel(); openAlmoxarifado(); });
    $('#btn-wifi-report-csv').addEventListener('click', downloadWifiReportCsv);
    $('#btn-wifi-report-print').addEventListener('click', () => window.print());

    $('#ont-form').addEventListener('submit', handleFormSubmit);

    $('#btn-edit').addEventListener('click', () => {
      const id = state.activeOntId;
      closeDrawer();
      openFormModal(id);
    });
    $('#btn-delete').addEventListener('click', deleteActiveOnt);
    $('#btn-mark-online').addEventListener('click', () => setActiveOntStatus('online'));
    $('#btn-mark-offline').addEventListener('click', () => setActiveOntStatus('offline'));
    $('#btn-check-ixc').addEventListener('click', checkActiveOntOnIxc);
    $('#btn-check-power').addEventListener('click', checkActiveOntPower);
    $('#btn-access-device').addEventListener('click', accessActiveDevice);
    $('#btn-retirar').addEventListener('click', retirarActiveOnt);
    $('#btn-devolver').addEventListener('click', devolverActiveOnt);
    $('#btn-toggle-password').addEventListener('click', togglePasswordVisibility);
    $('#btn-toggle-move').addEventListener('click', toggleMoveActiveOnt);
    $('#btn-add-here').addEventListener('click', () => {
      const ont = state.onts.find((o) => o.id === state.activeOntId);
      if (ont) openFormModalAtPosition({ pos_x: ont.pos_x, pos_y: ont.pos_y });
    });
    $('#btn-picker-add-here').addEventListener('click', () => {
      if (state.activePickerPos) openFormModalAtPosition(state.activePickerPos);
    });

    $('#btn-refresh-status').addEventListener('click', () => { closeMenuPanel(); checkAllOnIxc(false); });
    $('#btn-upload-plant').addEventListener('click', () => { closeMenuPanel(); $('#plant-file-input').click(); });
    $('#plant-file-input').addEventListener('change', handlePlantFileSelected);

    $('#btn-list').addEventListener('click', openListPanel);
    $('#list-search').addEventListener('input', (e) => renderListItems(e.target.value));

    // Esconde a dica inicial após o primeiro clique no mapa
    document.addEventListener(
      'click',
      () => setTimeout(() => $('#map-hint')?.classList.add('hidden'), 4000),
      { once: true }
    );
  }

  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    checkSession();
  });
})();
