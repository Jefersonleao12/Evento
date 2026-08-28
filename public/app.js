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
    currentUser: null, // { id, username, role }
    movingOntId: null, // id do equipamento atualmente em modo "mover no mapa"
    autoRefreshTimer: null,
    relativeTimeTimer: null,
  };

  const DEFAULT_OSM_CENTER = [-15.793889, -47.882778]; // Brasília, ajuste conforme o local do evento
  const DEFAULT_OSM_ZOOM = 18;
  const AUTO_REFRESH_MS = 60 * 1000; // auto-atualização do status via IXC

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
    outro: '📦',
  };
  const EQUIPMENT_LABELS = {
    ont: 'ONT',
    switch: 'Switch',
    access_point: 'Access Point',
    roteador: 'Roteador',
    outro: 'Outro',
  };

  /* ------------------------------------------------------------------ *
   * Helpers de DOM
   * ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  function isAdmin() {
    return Boolean(state.currentUser && state.currentUser.role === 'admin');
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
  }

  async function showApp() {
    $('#login-screen').classList.add('hidden');
    $('#app-header').classList.remove('hidden');
    $('#app-shell').classList.remove('hidden');
    $('#current-username').textContent = state.currentUser.username;
    applyRoleVisibility();

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
    L.imageOverlay(url, bounds).addTo(state.map);
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
    const statusClass = `status-${ont.status || 'unknown'}`;
    const icon = EQUIPMENT_ICONS[ont.equipment_type] || EQUIPMENT_ICONS.ont;
    const label = ont.nome_fantasia ? escapeHtml(ont.nome_fantasia) : '';
    const draggingClass = state.movingOntId === ont.id ? 'dragging' : '';
    return L.divIcon({
      className: '',
      html: `
        <div class="ont-marker-wrap">
          <div class="ont-marker ${statusClass} ${draggingClass}">${icon}</div>
          ${label ? `<div class="ont-marker-label">${label}</div>` : ''}
        </div>`,
      iconSize: [110, label ? 56 : 34],
      iconAnchor: [55, 17],
      popupAnchor: [0, -17],
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
        marker.on('click', () => openDrawer(ont.id));
        state.markers.set(ont.id, marker);
      }
    });
  }

  async function renderStats() {
    try {
      const stats = await api('/api/stats');
      $('#stats-line').textContent =
        `${stats.total} equipamentos • ${stats.online} online • ${stats.offline} offline • ${stats.unknown} sem dados`;
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
    $('#ont-form').reset();
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
   * DRAWER DE DETALHES / AÇÕES RÁPIDAS
   * ==================================================================== */

  function statusLabel(status) {
    return { online: 'Online', offline: 'Offline', unknown: 'Sem dados' }[status] || 'Sem dados';
  }

  function openDrawer(ontId) {
    const ont = state.onts.find((o) => o.id === ontId);
    if (!ont) return;
    state.activeOntId = ontId;

    // innerHTML (não textContent) porque o ícone do tipo ONT é um SVG embutido;
    // tag_label vem de entrada do usuário, por isso passa por escapeHtml().
    $('#d-title').innerHTML =
      `<span class="inline-flex items-center align-middle">${EQUIPMENT_ICONS[ont.equipment_type] || ''}</span> ${escapeHtml(ont.tag_label)}`.trim();
    $('#d-nome-fantasia').textContent = ont.nome_fantasia || '';
    $('#d-status-dot').className =
      'w-2.5 h-2.5 rounded-full shrink-0 ' +
      { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500' }[ont.status || 'unknown'];
    $('#d-equipment-type').textContent = EQUIPMENT_LABELS[ont.equipment_type] || EQUIPMENT_LABELS.ont;
    $('#d-asset').textContent = ont.asset_number || '—';
    $('#d-status-text').textContent = statusLabel(ont.status);
    $('#d-mac').textContent = ont.mac_address || '—';
    $('#d-ssid').textContent = ont.wifi_ssid || '—';
    $('#d-password').textContent = '••••••••';
    $('#d-password').dataset.revealed = 'false';
    $('#btn-toggle-password').textContent = 'mostrar';
    $('#d-ixc').textContent = ont.ixc_login_id || '—';
    $('#d-notes').textContent = ont.notes || '—';
    updateLastCheckText();

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
    state.autoRefreshTimer = setInterval(() => {
      if (document.hidden) return; // evita gastar chamadas com a aba em segundo plano
      checkAllOnIxc(true);
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
    if (!isAdmin()) return;
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
   * PAINEL DE LISTAGEM
   * ==================================================================== */

  function openListPanel() {
    renderListItems('');
    $('#list-panel').classList.remove('hidden');
    $('#list-search').value = '';
    $('#list-search').focus();
  }

  function closeListPanel() {
    $('#list-panel').classList.add('hidden');
  }

  function renderListItems(filter) {
    const term = filter.trim().toLowerCase();
    const filtered = state.onts.filter((o) => {
      if (!term) return true;
      return [o.tag_label, o.mac_address, o.asset_number, o.ixc_login_id, o.nome_fantasia]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(term));
    });

    const dotClass = { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500' };

    $('#list-items').innerHTML = filtered
      .map(
        (o) => `
      <li data-id="${o.id}" class="cursor-pointer bg-slate-900 hover:bg-slate-700/60 rounded-lg p-3 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium truncate">${EQUIPMENT_ICONS[o.equipment_type] || ''} ${escapeHtml(o.tag_label)}${o.nome_fantasia ? ' — ' + escapeHtml(o.nome_fantasia) : ''}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(o.asset_number || 'sem patrimônio')} • ${escapeHtml(o.mac_address || 'sem MAC')} • ${escapeHtml(timeAgo(o.last_checked_at) || 'nunca verificado')}</p>
        </div>
        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotClass[o.status] || dotClass.unknown}"></span>
      </li>`
      )
      .join('') || `<li class="text-slate-500 text-center py-6 text-xs">Nenhum equipamento encontrado.</li>`;

    $$('#list-items li[data-id]').forEach((li) => {
      li.addEventListener('click', () => {
        const id = Number(li.dataset.id);
        closeListPanel();
        const ont = state.onts.find((o) => o.id === id);
        if (ont) {
          state.map.setView(posToLatLng(ont), state.map.getZoom());
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
    $('#btn-toggle-password').addEventListener('click', togglePasswordVisibility);
    $('#btn-toggle-move').addEventListener('click', toggleMoveActiveOnt);

    $('#btn-refresh-status').addEventListener('click', () => checkAllOnIxc(false));
    $('#btn-upload-plant').addEventListener('click', () => $('#plant-file-input').click());
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
