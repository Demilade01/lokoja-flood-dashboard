/* Flood Watch — application logic
 * State-driven dashboard: map, layer toggles, metrics from summary.json,
 * observation slideshow (rotates through months), weather (refresh + failure handling).
 * No figures are typed into the HTML; the JS reads summary.json so cards and map stay consistent.
 */
(() => {
  'use strict';

  // ---------- Configuration ----------
  const EVENTS = {
    april21: { file: './data/april21.geojson', date: 'April 21, 2025', short: 'Apr 21', label: 'Pre-flood reference', chartLabel: 'Apr 21',
      note: 'Pre-flood water observation. May contain permanent river water; do not treat the entire polygon as newly flooded land.',
      interpretation: 'Baseline water extent', color: '#178b8b' },
    july15:  { file: './data/july15.geojson',  date: 'July 15, 2025',  short: 'Jul 15', label: 'Flooding observation', chartLabel: 'Jul 15',
      note: 'Principal flooding observation. Mapped water / flood extent — the peak of the three supplied observations.',
      interpretation: 'Peak flood observation', color: '#cf513d' },
    nov2:    { file: './data/nov2.geojson',    date: 'November 2, 2025', short: 'Nov 2', label: 'Post-flood reference', chartLabel: 'Nov 2',
      note: 'Post-flood observation. Water may remain elevated; permanent river water remains present year-round.',
      interpretation: 'Recession observation', color: '#315f75' }
  };
  const ORDER = ['april21', 'july15', 'nov2'];

  const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast?latitude=7.80&longitude=6.73'
    + '&current=temperature_2m,relative_humidity_2m,precipitation,rain,weather_code,wind_speed_10m'
    + '&daily=precipitation_sum,precipitation_probability_max,weather_code'
    + '&forecast_days=5&timezone=Africa%2FLagos';
  const REFRESH_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes — matches existing README

  // ---------- State ----------
  const state = {
    selected: 'july15', // default to peak flooding observation per acceptance criteria
    layers: { flood: true, boundary: true, towns: true, buildings: true, roads: true, basemap: true },
    map: null,
    floodLayer: null,
    exposedLayer: null,
    boundaryLayer: null,
    townsLayer: null,
    roadsLayer: null,
    basemapLayer: null,
    summary: null,
    townsData: null,
    exposureData: null,
    roadsData: null,
    eventData: {},
    weather: null,
    weatherTimer: null
  };

  // ---------- Utilities ----------
  const $  = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const escapeHTML = (v) => String(v ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  const fmt = (n) => Number(n).toLocaleString('en-NG');
  const fmtArea = (n) => Number(n).toFixed(2);

  async function fetchJSON(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  // Validate a parsed GeoJSON object minimally
  function isValidGeoJSON(obj) {
    if (!obj || typeof obj !== 'object') return false;
    if (obj.type !== 'FeatureCollection') return false;
    if (!Array.isArray(obj.features)) return false;
    return true;
  }

  // ---------- Theme ----------
  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    const button = $('[data-theme-toggle]');
    if (!button) return;
    const dark = theme === 'dark';
    button.setAttribute('aria-label', `Switch to ${dark ? 'light' : 'dark'} mode`);
    button.innerHTML = dark
      ? '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>'
      : '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  }

  // ---------- Map helpers ----------
  function townMarker(feature, latlng) {
    const marker = L.circleMarker(latlng, {
      radius: 5, color: '#f8faf9', weight: 2, fillColor: '#25312f', fillOpacity: 1
    });
    const name = escapeHTML(feature.properties.name || 'Settlement');
    const type = escapeHTML(feature.properties.type || 'Settlement');
    marker.bindTooltip(name, { permanent: true, direction: 'top', className: 'town-label', offset: [0, -6] });
    marker.bindPopup(`<strong>${name}</strong><br>Type: ${type}<br>Feature class: Settlement location<br>Relationship: inside the study-area boundary.`);
    return marker;
  }

  function eventSummary(id) {
    return state.summary.events.find(e => e.id === id);
  }

  function exposureFilter(feature) {
    return Boolean(feature.properties[state.selected]);
  }

  // ---------- Road / bridge safety screening ----------
  // Ray-casting point-in-ring test (coords are [lng, lat]).
  function pointInRing(lng, lat, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1];
      const xj = ring[j][0], yj = ring[j][1];
      if (((yi > lat) !== (yj > lat)) && (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  // A single Polygon = [outerRing, hole1, hole2, ...]: inside outer AND outside every hole.
  function pointInPolygon(lng, lat, rings) {
    if (!rings.length || !pointInRing(lng, lat, rings[0])) return false;
    for (let h = 1; h < rings.length; h++) {
      if (pointInRing(lng, lat, rings[h])) return false; // sits in a hole
    }
    return true;
  }

  // Works for both Polygon and MultiPolygon geometries.
  function pointInFlood(lng, lat, geometry) {
    if (!geometry) return false;
    if (geometry.type === 'Polygon') {
      return pointInPolygon(lng, lat, geometry.coordinates);
    }
    if (geometry.type === 'MultiPolygon') {
      return geometry.coordinates.some(poly => pointInPolygon(lng, lat, poly));
    }
    return false;
  }

  // Is a checkpoint inside the CURRENTLY SELECTED event's flood polygon? -> dangerous.
  function isDangerous(lng, lat) {
    const flood = state.eventData[state.selected];
    if (!flood || !Array.isArray(flood.features)) return false;
    return flood.features.some(f => pointInFlood(lng, lat, f.geometry));
  }

  // Build the road/bridge checkpoint layer, coloured for the selected observation.
  function buildRoadsLayer() {
    const DANGER = '#d6273a', SAFE = '#1f6fd6';
    return L.geoJSON(state.roadsData, {
      pointToLayer: (feature, latlng) => {
        const danger = isDangerous(latlng.lng, latlng.lat);
        const isBridge = feature.properties.kind === 'bridge';
        return L.circleMarker(latlng, {
          radius: isBridge ? 7 : 6,
          color: '#ffffff',
          weight: 1.6,
          fillColor: danger ? DANGER : SAFE,
          fillOpacity: 0.95
        });
      },
      onEachFeature: (feature, layer) => {
        const danger = isDangerous(
          feature.geometry.coordinates[0], feature.geometry.coordinates[1]
        );
        const meta = EVENTS[state.selected];
        const name = escapeHTML(feature.properties.name || 'Checkpoint');
        const kind = feature.properties.kind === 'bridge' ? 'Bridge' : 'Road';
        layer.bindTooltip(name, { direction: 'top', offset: [0, -8], className: 'town-label' });
        layer.bindPopup(
          `<strong>${name}</strong><br>`
          + `Feature: ${kind} checkpoint<br>`
          + `Observation: ${escapeHTML(meta.date)}<br>`
          + `Status: <strong style="color:${danger ? DANGER : SAFE}">`
          + `${danger ? 'DANGEROUS — within mapped water' : 'SAFE — outside mapped water'}</strong><br>`
          + `<em>Spatial screening against this date's flood polygon — not a verified road-closure feed.</em>`
        );
      }
    });
  }

  // ---------- Draw active flood + exposure layers ----------
  function drawEvent(fit = false) {
    const meta = EVENTS[state.selected];
    const summary = eventSummary(state.selected);
    if (!state.map || !summary) return;

    if (state.floodLayer) state.map.removeLayer(state.floodLayer);
    if (state.exposedLayer) state.map.removeLayer(state.exposedLayer);

    state.floodLayer = L.geoJSON(state.eventData[state.selected], {
      style: { color: meta.color, weight: 2, opacity: 1, fillColor: meta.color, fillOpacity: 0.48 },
      onEachFeature: (_, layer) => layer.bindPopup(
        `<strong>${escapeHTML(meta.date)}</strong><br>${escapeHTML(meta.label)}<br>`
        + `Mapped area: ${fmtArea(summary.area_km2)} km²<br>`
        + `Dataset status: Historical GIS observation<br>`
        + `Source: User-supplied shapefile, reprojected to WGS 84.<br>`
        + `<em>Historical — not a live flood feed.</em>`
      )
    });
    if (state.layers.flood) state.floodLayer.addTo(state.map);

    // Exposed buildings: only render if toggle is on AND layer enabled
    state.exposedLayer = L.geoJSON(state.exposureData, {
      filter: exposureFilter,
      pointToLayer: (feature, latlng) => L.circleMarker(latlng, {
        radius: 2.6, color: '#6d4d00', weight: 0.7, fillColor: '#ff8a3d', fillOpacity: 0.88
      }),
      onEachFeature: (feature, layer) => {
        const label = feature.properties.name || `OSM building ${feature.properties.osm_id || 'unlabelled'}`;
        const dates = ORDER.filter(k => feature.properties[k]).map(k => EVENTS[k].short).join(', ');
        layer.bindPopup(
          `<strong>${escapeHTML(label)}</strong><br>`
          + `Exposure date(s): ${escapeHTML(dates)}<br>`
          + `Method: centroid-in-polygon screening<br>`
          + `Status: <em>potentially exposed — not confirmed damage.</em>`
        );
      }
    });
    if (state.layers.buildings) state.exposedLayer.addTo(state.map);

    // Road / bridge safety checkpoints — recoloured for the selected observation
    if (state.roadsLayer) state.map.removeLayer(state.roadsLayer);
    if (state.roadsData) {
      state.roadsLayer = buildRoadsLayer();
      if (state.layers.roads) state.roadsLayer.addTo(state.map);
    }

    updateMetrics();
    updateMapOverlays();
    updateSlideshowDisplay();
    updateSRSummary();
    if (fit && state.floodLayer && state.layers.flood) {
      state.map.fitBounds(state.floodLayer.getBounds(), { padding: [30, 30] });
    }
  }

  // ---------- Metrics UI ----------
  function updateMetrics() {
    const meta = EVENTS[state.selected];
    const summary = eventSummary(state.selected);
    if (!summary) return;
    const idx = ORDER.indexOf(state.selected);

    const mappedAreaEl = $('#mapped-area');
    if (mappedAreaEl) mappedAreaEl.textContent = fmtArea(summary.area_km2);
    const buildingCountEl = $('#building-count');
    if (buildingCountEl) buildingCountEl.textContent = fmt(summary.building_centroids_within);

    // Exposure rate (percentage of total mapped buildings)
    const totalBuildings = state.exposureData ? state.exposureData.features.length : 0;
    const exposureRateEl = $('#exposure-rate');
    if (exposureRateEl) {
      if (totalBuildings > 0) {
        const pct = (summary.building_centroids_within / totalBuildings) * 100;
        exposureRateEl.textContent = pct < 1 ? pct.toFixed(2) + '%' : pct.toFixed(1) + '%';
      } else {
        exposureRateEl.textContent = '—';
      }
    }

    // Change from previous observation
    const areaChangeEl = $('#area-change');
    if (areaChangeEl) {
      if (idx === 0) {
        areaChangeEl.textContent = 'Baseline';
      } else {
        const prev = eventSummary(ORDER[idx - 1]);
        if (!prev || prev.area_km2 === 0) {
          areaChangeEl.textContent = 'Not applicable';
        } else {
          const c = ((summary.area_km2 - prev.area_km2) / prev.area_km2) * 100;
          const sign = c > 0 ? '+' : '';
          areaChangeEl.textContent = `${sign}${c.toFixed(1)}%`;
        }
      }
    }

    const mapDateEl = $('#map-date');
    if (mapDateEl) mapDateEl.textContent = meta.date;
    const mapLabelEl = $('#map-label');
    if (mapLabelEl) mapLabelEl.textContent = `${meta.label} · ${meta.interpretation}`;
    const mapStatusEl = $('#map-status');
    if (mapStatusEl) {
      mapStatusEl.style.background = meta.color;
      mapStatusEl.style.boxShadow = `0 0 0 5px ${meta.color}2e`;
    }
    const legendFloodEl = $('#legend-flood');
    if (legendFloodEl) legendFloodEl.style.background = meta.color;
    const legendFloodLabelEl = $('#legend-flood-label');
    if (legendFloodLabelEl) legendFloodLabelEl.textContent = `${meta.short} mapped water`;
  }

  function updateMapOverlays() {
    if (!state.map) return;
    state.floodLayer   && (state.layers.flood     ? state.floodLayer.addTo(state.map)     : state.map.removeLayer(state.floodLayer));
    state.boundaryLayer && (state.layers.boundary ? state.boundaryLayer.addTo(state.map)  : state.map.removeLayer(state.boundaryLayer));
    state.townsLayer   && (state.layers.towns     ? state.townsLayer.addTo(state.map)     : state.map.removeLayer(state.townsLayer));
    state.exposedLayer && (state.layers.buildings ? state.exposedLayer.addTo(state.map)   : state.map.removeLayer(state.exposedLayer));
    state.roadsLayer   && (state.layers.roads     ? state.roadsLayer.addTo(state.map)     : state.map.removeLayer(state.roadsLayer));
    if (state.basemapLayer) {
      if (state.layers.basemap) state.map.addLayer(state.basemapLayer);
      else state.map.removeLayer(state.basemapLayer);
    }
  }

  // ---------- Slideshow display (current + next observation) ----------
  function updateSlideshowDisplay() {
    const idx = ORDER.indexOf(state.selected);
    const nextIdx = (idx + 1) % ORDER.length;
    const meta = EVENTS[state.selected];
    const nextMeta = EVENTS[ORDER[nextIdx]];
    const currentEl = $('#current-date');
    const currentLabelEl = $('#current-label');
    const nextEl = $('#next-date');
    const counterEl = $('#event-counter');
    if (currentEl) currentEl.textContent = meta.date;
    if (currentLabelEl) currentLabelEl.textContent = meta.label;
    if (nextEl) nextEl.textContent = nextMeta.date;
    if (counterEl) counterEl.textContent = `${idx + 1} / 3`;
  }

  // ---------- Comparison table (removed — section deleted) ----------
  function updateComparisonTable() { /* no-op: stats section removed */ }

  // ---------- Comparison chart (removed — section deleted) ----------
  function updateComparisonChart() { /* no-op: stats section removed */ }

  // ---------- Screen-reader summary ----------
  function updateSRSummary() {
    const meta = EVENTS[state.selected];
    const summary = eventSummary(state.selected);
    if (!summary || !state.exposureData) return;
    const el = $('#sr-summary');
    if (!el) return;
    el.textContent = `Observation ${meta.date}, ${meta.label}. Mapped water area ${fmtArea(summary.area_km2)} square kilometres. ${fmt(summary.building_centroids_within)} potentially exposed buildings out of ${state.exposureData.features.length.toLocaleString('en-NG')} mapped buildings.`;
  }

  // ---------- Load all data (shared by initMap and refreshAll) ----------
  async function loadData() {
    const [summary, boundary, towns, exposure, roads, ...events] = await Promise.all([
      fetchJSON('./data/summary.json'),
      fetchJSON('./data/boundary.geojson'),
      fetchJSON('./data/towns.geojson'),
      fetchJSON('./data/exposed-buildings.geojson'),
      fetchJSON('./data/road-points.geojson'),
      ...ORDER.map(id => fetchJSON(EVENTS[id].file))
    ]);

    // Validate
    if (!summary || !Array.isArray(summary.events) || summary.events.length !== 3) {
      throw new Error('summary.json is missing the expected events array.');
    }
    [boundary, towns, exposure, roads, ...events].forEach((d, i) => {
      if (!isValidGeoJSON(d)) throw new Error(`Invalid GeoJSON for dataset index ${i}`);
    });

    state.summary = summary;
    state.townsData = towns;
    state.exposureData = exposure;
    state.roadsData = roads;
    ORDER.forEach((key, i) => { state.eventData[key] = events[i]; });

    return { boundary, towns };
  }

  // ---------- Initialize map (runs once) ----------
  async function initMap() {
    try {
      const { boundary, towns } = await loadData();

      // Map setup
      state.map = L.map('map', { zoomControl: false, preferCanvas: true, minZoom: 10 }).setView([7.795, 6.762], 13);
      L.control.zoom({ position: 'topright' }).addTo(state.map);

      state.basemapLayer = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors'
      }).addTo(state.map);

      state.boundaryLayer = L.geoJSON(boundary, {
        style: { color: '#596965', weight: 2, dashArray: '7 6', fillOpacity: 0 }
      });
      state.boundaryLayer.bindPopup('<strong>Study-area boundary</strong><br>Supplied reference GIS data.<br>Defines the area of interest for flood observation.');

      state.townsLayer = L.geoJSON(towns, { pointToLayer: townMarker });

      drawEvent(false);
      // Fit to boundary so all dates show consistent framing
      state.map.fitBounds(state.boundaryLayer.getBounds(), { padding: [20, 20] });
      $('#map-loading').hidden = true;
    } catch (error) {
      console.error('[initMap]', error);
      $('#map-loading').hidden = true;
      $('#map-error').hidden = false;
    }
  }

  // ---------- Slideshow advance (rotates to next observation and reloads map) ----------
  async function refreshAll() {
    const btn = $('#refresh-all');
    if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }
    try {
      // Advance to next observation in the rotation
      const idx = ORDER.indexOf(state.selected);
      const nextIdx = (idx + 1) % ORDER.length;
      state.selected = ORDER[nextIdx];

      // Reload data from source (honors the "reloads the map" requirement)
      const { boundary, towns } = await loadData();

      // Update boundary layer
      if (state.boundaryLayer) {
        state.boundaryLayer.clearLayers();
        state.boundaryLayer.addData(boundary);
      }
      // Update towns layer
      if (state.townsLayer) {
        state.townsLayer.clearLayers();
        state.townsLayer.addData(towns);
      }
      // Redraw flood + exposure layers for the new observation
      drawEvent(false);
    } catch (error) {
      console.error('[refreshAll]', error);
    } finally {
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 4l10 8-10 8V4z"/><line x1="19" y1="5" x2="19" y2="19"/></svg> Next observation';
      }
    }
  }

  // ---------- Weather ----------
  const weatherSymbol = (code) => {
    if (code === 0) return '☀';
    if ([1, 2, 3].includes(code)) return '◒';
    if ([45, 48].includes(code)) return '≋';
    if (code >= 51 && code <= 67) return '☂';
    if (code >= 80 && code <= 82) return '☔';
    if (code >= 95) return '⚡';
    return '·';
  };

  async function loadWeather() {
    const status = $('#weather-status');
    const refreshBtn = $('#weather-refresh');
    if (refreshBtn) { refreshBtn.disabled = true; refreshBtn.textContent = 'Refreshing…'; }

    try {
      const data = await fetchJSON(OPEN_METEO_URL);
      state.weather = data;
      const unit = data.current_units;

      $('#temperature').textContent   = `${Math.round(data.current.temperature_2m)}${unit.temperature_2m}`;
      $('#precipitation').textContent = `${Number(data.current.precipitation).toFixed(1)} ${unit.precipitation}`;
      $('#humidity').textContent      = `${Math.round(data.current.relative_humidity_2m)}${unit.relative_humidity_2m}`;
      $('#weather-code').textContent  = weatherSymbol(data.current.weather_code);

      const maxRain = Math.max(...data.daily.precipitation_sum, 1);
      $('#forecast').innerHTML = data.daily.time.map((date, i) => {
        const day = new Intl.DateTimeFormat('en-NG', { weekday: 'short', timeZone: 'Africa/Lagos' })
          .format(new Date(`${date}T12:00:00+01:00`));
        const rain = Number(data.daily.precipitation_sum[i]);
        const probability = data.daily.precipitation_probability_max[i] ?? 0;
        return `<div class="forecast-row">
          <span>${escapeHTML(day)}</span>
          <span class="forecast-track"><i style="width:${Math.max(3, (rain / maxRain) * 100)}%"></i></span>
          <span class="forecast-mm">${rain.toFixed(1)}mm</span>
          <span class="forecast-prob">${probability}%</span>
        </div>`;
      }).join('');

      const obsTime = new Date(data.current.time).toLocaleString('en-NG', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Lagos' });
      const retrievalTime = new Date().toLocaleTimeString('en-NG', { timeStyle: 'short', timeZone: 'Africa/Lagos' });
      $('#weather-updated').textContent = `Model observation: ${obsTime} · Retrieved: ${retrievalTime} · Open-Meteo`;

      status.className = 'live-chip online';
      status.innerHTML = '<i></i>Live weather connected';
    } catch (error) {
      console.error('[loadWeather]', error);
      status.className = 'live-chip error';
      status.innerHTML = '<i></i>Weather unavailable';
      // Keep historical map working — only update weather UI
      if (!state.weather) {
        $('#temperature').textContent   = 'Temporarily unavailable';
        $('#precipitation').textContent = 'Temporarily unavailable';
        $('#humidity').textContent      = 'Temporarily unavailable';
        $('#weather-code').textContent  = '—';
      }
      $('#forecast').innerHTML = '<p class="updated">Live weather could not be retrieved. The historical map remains available. Try the refresh button when you are back online.</p>';
      $('#weather-updated').textContent = 'Last attempt: ' + new Date().toLocaleTimeString('en-NG', { timeStyle: 'short', timeZone: 'Africa/Lagos' });
    } finally {
      if (refreshBtn) { refreshBtn.disabled = false; refreshBtn.textContent = 'Refresh weather now'; }
    }
  }

  // ---------- Wire up DOM events ----------
  function bindEvents() {
    // Theme toggle
    $('[data-theme-toggle]').addEventListener('click', () => {
      setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    });

    // Refresh all data button
    const refreshAllBtn = $('#refresh-all');
    if (refreshAllBtn) refreshAllBtn.addEventListener('click', refreshAll);

    // Layer toggles
    $$('[data-layer]').forEach(input => {
      input.addEventListener('change', () => {
        state.layers[input.dataset.layer] = input.checked;
        updateMapOverlays();
      });
    });

    // Fit map button
    $('#fit-map').addEventListener('click', () => {
      if (state.map && state.boundaryLayer) {
        state.map.fitBounds(state.boundaryLayer.getBounds(), { padding: [20, 20] });
      }
    });

    // Weather refresh
    $('#weather-refresh').addEventListener('click', loadWeather);
  }

  // ---------- Boot ----------
  document.addEventListener('DOMContentLoaded', () => {
    setTheme(matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    bindEvents();
    initMap();
    loadWeather();
    state.weatherTimer = setInterval(loadWeather, REFRESH_INTERVAL_MS);
  });
})();
