/**
 * app.js
 * -----------------------------------------------------------------------
 * Lógica de frontend do Painel de Gestão Visual de ONTs.
 *
 * Modos de mapa:
 *   1) PLANTA BAIXA (padrão, se uma imagem tiver sido carregada):
 *      usa Leaflet com CRS.Simple, onde pos_x/pos_y das ONTs são
 *      coordenadas em PIXELS da imagem original.
 *   2) FALLBACK OpenStreetMap (se nenhuma planta baixa foi definida):
 *      usa o CRS padrão do Leaflet (EPSG:3857); pos_x/pos_y das ONTs
 *      guardam, respectivamente, LATITUDE e LONGITUDE.
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
  };

  const DEFAULT_OSM_CENTER = [-15.793889, -47.882778]; // Brasília, ajuste conforme o local do evento
  const DEFAULT_OSM_ZOOM = 18;

  /* ------------------------------------------------------------------ *
   * Helpers de DOM
   * ------------------------------------------------------------------ */
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

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
    state.pendingClickLatLng = e.latlng;
    openFormModal(null);
  }

  /* ==================================================================== *
   * CARREGAMENTO E RENDERIZAÇÃO DAS ONTs
   * ==================================================================== */

  async function loadOnts() {
    try {
      state.onts = await api('/api/onts');
      renderMarkers();
      renderStats();
    } catch (err) {
      showToast('Falha ao carregar ONTs: ' + err.message, true);
    }
  }

  function markerIcon(ont) {
    const statusClass = `status-${ont.status || 'unknown'}`;
    const shortLabel = (ont.tag_label || '?').slice(-4);
    return L.divIcon({
      className: '',
      html: `<div class="ont-marker ${statusClass}">${shortLabel}</div>`,
      iconSize: [34, 34],
      iconAnchor: [17, 17],
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
        marker.setLatLng(latlng);
        marker.setIcon(markerIcon(ont));
      } else {
        marker = L.marker(latlng, { icon: markerIcon(ont) }).addTo(state.map);
        marker.on('click', () => openDrawer(ont.id));
        state.markers.set(ont.id, marker);
      }
    });
  }

  async function renderStats() {
    try {
      const stats = await api('/api/stats');
      $('#stats-line').textContent =
        `${stats.total} ONTs • ${stats.online} online • ${stats.offline} offline • ${stats.unknown} sem dados`;
    } catch (_) {
      $('#stats-line').textContent = `${state.onts.length} ONTs cadastradas`;
    }
  }

  /* ==================================================================== *
   * MODAL DE CADASTRO / EDIÇÃO
   * ==================================================================== */

  function openFormModal(ontId) {
    const isEdit = Boolean(ontId);
    const ont = isEdit ? state.onts.find((o) => o.id === ontId) : null;

    $('#form-title').textContent = isEdit ? `Editar ONT #${ont.id}` : 'Cadastrar ONT';
    $('#f-id').value = isEdit ? ont.id : '';
    $('#f-tag').value = isEdit ? ont.tag_label || '' : '';
    $('#f-asset').value = isEdit ? ont.asset_number || '' : '';
    $('#f-mac').value = isEdit ? ont.mac_address || '' : '';
    $('#f-ssid').value = isEdit ? ont.wifi_ssid || '' : '';
    $('#f-password').value = isEdit ? ont.wifi_password || '' : '';
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
    const payload = {
      tag_label: $('#f-tag').value.trim(),
      asset_number: $('#f-asset').value.trim(),
      mac_address: $('#f-mac').value.trim(),
      wifi_ssid: $('#f-ssid').value.trim(),
      wifi_password: $('#f-password').value.trim(),
      ixc_login_id: $('#f-ixc').value.trim(),
      notes: $('#f-notes').value.trim(),
      pos_x: parseFloat($('#f-pos-x').value),
      pos_y: parseFloat($('#f-pos-y').value),
    };

    try {
      if (id) {
        await api(`/api/onts/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('ONT atualizada com sucesso.');
      } else {
        await api('/api/onts', { method: 'POST', body: JSON.stringify(payload) });
        showToast('ONT cadastrada com sucesso.');
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

    $('#d-title').textContent = `ONT ${ont.tag_label}`;
    $('#d-status-dot').className =
      'w-2.5 h-2.5 rounded-full ' +
      { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500' }[ont.status || 'unknown'];
    $('#d-asset').textContent = ont.asset_number || '—';
    $('#d-status-text').textContent = statusLabel(ont.status);
    $('#d-mac').textContent = ont.mac_address || '—';
    $('#d-ssid').textContent = ont.wifi_ssid || '—';
    $('#d-password').textContent = '••••••••';
    $('#d-password').dataset.value = ont.wifi_password || '';
    $('#d-password').dataset.revealed = 'false';
    $('#btn-toggle-password').textContent = 'mostrar';
    $('#d-ixc').textContent = ont.ixc_login_id || '—';
    $('#d-notes').textContent = ont.notes || '—';
    $('#d-last-check').textContent = ont.last_checked_at
      ? `Última checagem: ${ont.last_checked_at}`
      : 'Nunca verificado no IXC';

    $('#drawer').classList.remove('hidden');
  }

  function closeDrawer() {
    $('#drawer').classList.add('hidden');
    state.activeOntId = null;
  }

  function togglePasswordVisibility() {
    const el = $('#d-password');
    const revealed = el.dataset.revealed === 'true';
    el.textContent = revealed ? '••••••••' : (el.dataset.value || '—');
    el.dataset.revealed = String(!revealed);
    $('#btn-toggle-password').textContent = revealed ? 'mostrar' : 'ocultar';
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
    if (!state.activeOntId) return;
    if (!confirm('Remover esta ONT do mapa? Esta ação não pode ser desfeita.')) return;
    try {
      await api(`/api/onts/${state.activeOntId}`, { method: 'DELETE' });
      showToast('ONT removida.');
      closeDrawer();
      await loadOnts();
    } catch (err) {
      showToast('Erro ao remover: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * ATUALIZAÇÃO EM LOTE (botão IXC do cabeçalho)
   * ==================================================================== */

  async function checkAllOnIxc() {
    showToast('Consultando todas as ONTs no IXC...');
    try {
      const result = await api('/api/onts/check-status', { method: 'POST' });
      showToast(`Consulta concluída: ${result.checked} ONT(s) verificadas.`);
      await loadOnts();
    } catch (err) {
      showToast('Erro na consulta em lote: ' + err.message, true);
    }
  }

  /* ==================================================================== *
   * UPLOAD DA PLANTA BAIXA
   * ==================================================================== */

  function handlePlantFileSelected(e) {
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
      return [o.tag_label, o.mac_address, o.asset_number, o.ixc_login_id]
        .filter(Boolean)
        .some((v) => v.toLowerCase().includes(term));
    });

    const dotClass = { online: 'bg-emerald-500', offline: 'bg-red-500', unknown: 'bg-gray-500' };

    $('#list-items').innerHTML = filtered
      .map(
        (o) => `
      <li data-id="${o.id}" class="cursor-pointer bg-slate-900 hover:bg-slate-700/60 rounded-lg p-3 flex items-center justify-between gap-2">
        <div class="min-w-0">
          <p class="font-medium truncate">${escapeHtml(o.tag_label)}</p>
          <p class="text-[11px] text-slate-500 truncate">${escapeHtml(o.asset_number || 'sem patrimônio')} • ${escapeHtml(o.mac_address || 'sem MAC')}</p>
        </div>
        <span class="w-2.5 h-2.5 rounded-full shrink-0 ${dotClass[o.status] || dotClass.unknown}"></span>
      </li>`
      )
      .join('') || `<li class="text-slate-500 text-center py-6 text-xs">Nenhuma ONT encontrada.</li>`;

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

    $('#btn-refresh-status').addEventListener('click', checkAllOnIxc);
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
    initMap();
  });
})();
