/**
 * Single-file MCP App UI (vanilla JS, no external assets — works under the
 * host's default-deny CSP). Served by src/ui.ts as ui://ui-design/gallery.html.
 *
 * Protocol (MCP Apps spec 2026-01-26, JSON-RPC 2.0 over postMessage):
 *   app -> host : ui/initialize, ui/notifications/initialized, tools/call,
 *                 ui/open-link, ui/request-display-mode
 *   host -> app : ui/notifications/tool-input, ui/notifications/tool-result,
 *                 ui/notifications/tool-cancelled
 *
 * Images are pulled through the `get_image` tool (tools/call) so the server's
 * local cache + sharp transcode are reused; direct remote <img src> is only a
 * fallback when the bridge is unavailable.
 */
export const GALLERY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ui-design gallery</title>
<style>
  :root {
    --bg: var(--color-background-primary, #101114);
    --bg2: var(--color-background-secondary, #17181c);
    --bg3: var(--color-background-tertiary, #1f2127);
    --text: var(--color-text-primary, #eceef2);
    --text2: var(--color-text-secondary, #9aa0ab);
    --border: var(--color-border-primary, #2a2d35);
    --accent: var(--ring-primary, #4c8dff);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
  header { display: flex; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid var(--border); position: sticky; top: 0; background: var(--bg); z-index: 5; }
  header h1 { font-size: 14px; margin: 0; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 50%; }
  header .count { color: var(--text2); font-size: 12px; white-space: nowrap; }
  .spacer { flex: 1; }
  .status { padding: 6px 14px; font-size: 12px; color: var(--text2); }
  .status.err { color: #ff9d9d; }
  main { padding: 8px 10px 12px; max-height: min(70vh, 580px); overflow-y: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(126px, 1fr)); gap: 7px; }
  .card { position: relative; background: var(--bg2); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; cursor: pointer; }
  .thumbwrap { width: 100%; aspect-ratio: 4/5; background: var(--bg3); }
  .card img, .step img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .card .meta { padding: 5px 6px 7px; }
  .card .title { font-size: 11px; font-weight: 600; margin: 0 0 3px; overflow-wrap: anywhere; }
  .badges { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
  .badge { font-size: 10.5px; color: var(--text2); background: var(--bg3); border: 1px solid var(--border); padding: 1px 6px; border-radius: 999px; }
  .swatches { display: flex; gap: 3px; margin-top: 6px; }
  .sw { width: 14px; height: 14px; border-radius: 4px; border: 1px solid rgba(128,128,128,.35); }
  .appbar { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; margin-bottom: 12px; }
  .appbar h2 { margin: 0 0 4px; font-size: 15px; }
  .kv { display: flex; flex-wrap: wrap; gap: 4px 14px; color: var(--text2); font-size: 12px; }
  .kv b { color: var(--text); font-weight: 600; }
  video { width: 100%; max-height: 240px; background: #000; border-radius: 12px; margin-bottom: 12px; display: block; }
  .flows { display: flex; flex-direction: column; gap: 8px; }
  .flow { background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 8px 10px; }
  .flow h3 { margin: 0 0 2px; font-size: 14px; }
  .flow .sub { color: var(--text2); font-size: 12px; margin-bottom: 10px; }
  .steps { display: flex; gap: 6px; overflow-x: auto; padding-bottom: 4px; }
  .step { flex: 0 0 auto; width: 125px; }
  .step .thumbwrap { border-radius: 8px; overflow: hidden; }
  .step .n { font-size: 11px; color: var(--text2); margin: 6px 0 2px; }
  .appsrow { display: flex; align-items: center; gap: 12px; background: var(--bg2); border: 1px solid var(--border); border-radius: 12px; padding: 10px 14px; margin-bottom: 10px; }
  .appsrow img.icon { width: 44px; height: 44px; border-radius: 10px; object-fit: cover; background: var(--bg3); flex: 0 0 auto; }
  .appsrow .info { flex: 1; min-width: 0; }
  .appsrow .name { font-weight: 600; font-size: 14px; }
  .appsrow .sub { color: var(--text2); font-size: 12px; overflow-wrap: anywhere; }
  button { background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 12.5px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  button:disabled { opacity: .6; cursor: default; }
  .overlay { position: fixed; inset: 0; background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center; z-index: 10; padding: 20px; }
  .panel { background: var(--bg); border: 1px solid var(--border); border-radius: 16px; max-width: 860px; width: 100%; max-height: 92vh; overflow: auto; padding: 16px; }
  .panel img { width: 100%; border-radius: 10px; display: block; }
  .panel h3 { margin: 0 0 10px; font-size: 14px; }
  .panel .actions { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
  .panel .desc { color: var(--text2); font-size: 12.5px; margin-top: 10px; }
  .empty { color: var(--text2); padding: 40px 0; text-align: center; }
  pre.json { color: var(--text2); font-size: 11.5px; overflow: auto; }
  .single { max-width: 720px; }
  .single .meta { color: var(--text2); font-size: 12px; margin-top: 10px; }
  .loading { color: var(--text2); font-size: 12.5px; padding: 30px 0; text-align: center; }
  .model-panel { margin: 10px 14px 0; border: 1px solid var(--border); border-radius: 10px; background: var(--bg2); }
  .model-panel summary { cursor: pointer; padding: 10px 12px; font-weight: 600; }
  .model-panel .body { padding: 0 12px 12px; }
  .model-panel p { color: var(--text2); font-size: 12px; margin: 4px 0 10px; }
  .model-panel pre { background: var(--bg3); border-radius: 8px; padding: 10px; overflow: auto; max-height: 280px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
  .model-panel .images { display: flex; gap: 8px; overflow-x: auto; }
  .model-panel .images img { max-height: 110px; border-radius: 6px; }
  .gallery-note { padding: 6px 10px 0; color: var(--text2); font-size: 11px; }
</style>
</head>
<body>
<header>
  <h1 id="title">ui-design</h1>
  <span class="count" id="count"></span>
</header>
<div class="status" id="status" hidden></div>
<div class="gallery-note" id="gallery-note" hidden></div>
<details class="model-panel" id="model-panel" hidden>
  <summary>Tool payload (text and images returned to the host)</summary>
  <div class="body" id="model-content"></div>
</details>
<main id="view"><div class="loading">waiting for tool result…</div></main>
<script type="module">
'use strict';

var view = document.getElementById('view');
var titleEl = document.getElementById('title');
var countEl = document.getElementById('count');
var statusEl = document.getElementById('status');
var galleryNote = document.getElementById('gallery-note');
var modelPanel = document.getElementById('model-panel');
var modelContent = document.getElementById('model-content');

var state = {
  data: null,
  imageBlock: null,
  bridgeReady: false,
  hostCaps: null,
  overlay: null
};

function showModelResult(res) {
  modelPanel.hidden = false;
  var blocks = (res && res.content) || [];
  var images = blocks.filter(function (block) { return block.type === 'image'; }).length;
  galleryNote.hidden = false;
  galleryNote.textContent = images + ' inline image' + (images === 1 ? '' : 's') +
    ' in the tool result · Gallery also previews media URLs in the returned data.';
  modelContent.replaceChildren();
  var note = document.createElement('p');
  note.textContent = 'These are the blocks returned to the host. The host decides how to present them to the model.';
  modelContent.appendChild(note);
  blocks.forEach(function (block, index) {
    var label = document.createElement('p');
    label.textContent = 'Content block ' + (index + 1) + ': ' + block.type;
    modelContent.appendChild(label);
    if (block.type === 'text') {
      var pre = document.createElement('pre');
      pre.textContent = block.text;
      modelContent.appendChild(pre);
    } else if (block.type === 'image') {
      var image = document.createElement('img');
      image.src = 'data:' + block.mimeType + ';base64,' + block.data;
      image.alt = 'Image content block ' + (index + 1);
      var wrap = document.createElement('div');
      wrap.className = 'images';
      wrap.appendChild(image);
      modelContent.appendChild(wrap);
      var mime = document.createElement('p');
      mime.textContent = block.mimeType + ' · ' + Math.round(block.data.length * 3 / 4 / 1024) + ' KB encoded image';
      modelContent.appendChild(mime);
    }
  });
  if (res && res.structuredContent) {
    var structured = document.createElement('details');
    var summary = document.createElement('summary');
    summary.textContent = 'Structured content';
    structured.appendChild(summary);
    var json = document.createElement('pre');
    json.textContent = JSON.stringify(res.structuredContent, null, 2);
    structured.appendChild(json);
    modelContent.appendChild(structured);
  }
}

/* ---------- JSON-RPC over postMessage ---------- */

var rpcId = 0;
var pending = new Map();

function rpc(method, params) {
  return new Promise(function (resolve, reject) {
    var id = ++rpcId;
    pending.set(id, { resolve: resolve, reject: reject });
    window.parent.postMessage({ jsonrpc: '2.0', id: id, method: method, params: params || {} }, '*');
    setTimeout(function () {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('timeout: ' + method));
      }
    }, 30000);
  });
}

function notify(method, params) {
  window.parent.postMessage({ jsonrpc: '2.0', method: method, params: params || {} }, '*');
}

window.addEventListener('message', function (e) {
  var m = e.data;
  if (!m || m.jsonrpc !== '2.0') return;
  if (typeof m.id === 'number' && pending.has(m.id)) {
    var p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error((m.error && m.error.message) || 'rpc error'));
    else p.resolve(m.result);
    return;
  }
  if (typeof m.method === 'string' && m.method.indexOf('ui/notifications/') === 0) {
    if (m.method === 'ui/notifications/tool-input') {
      var a = m.params && m.params.arguments;
      setStatus('calling tool: ' + JSON.stringify(a).slice(0, 140));
    } else if (m.method === 'ui/notifications/tool-result') {
      onResult(m.params);
    } else if (m.method === 'ui/notifications/tool-cancelled') {
      setStatus('tool call cancelled', true);
    } else if (m.method === 'ui/notifications/host-context-changed') {
      applyHostStyles(m.params);
    } else if (m.method === 'ui/notifications/tool-input-partial') {
      /* streaming args — ignore, the full tool-input follows */
    }
    return;
  }
  if (m.method === 'ui/resource-teardown') {
    closeOverlay();
    state.data = null;
    view.innerHTML = '<div class="loading">closed</div>';
    window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: {} }, '*');
    return;
  }
  // Any host REQUEST this app does not track (tools/list, resources/list,
  // prompts/list, ping, ui/request-display-mode, …) gets a minimal reply so
  // the host never hangs on an unanswered request.
  if (m.id !== undefined) {
    var result;
    if (m.method === 'tools/list') result = { tools: [] };
    else if (m.method === 'resources/list') result = { resources: [] };
    else if (m.method === 'prompts/list') result = { prompts: [] };
    else if (m.method === 'ping') result = {};
    else if (m.method === 'ui/request-display-mode') {
      result = { mode: (m.params && m.params.mode) || 'inline' };
      document.body.dataset.displayMode = result.mode;
    } else result = { ok: true };
    window.parent.postMessage({ jsonrpc: '2.0', id: m.id, result: result }, '*');
  }
});

function applyHostStyles(ctx) {
  if (!ctx) return;
  var vars = ctx.styles && ctx.styles.variables;
  if (vars && typeof vars === 'object') {
    var root = document.documentElement;
    Object.keys(vars).forEach(function (k) {
      if (typeof vars[k] === 'string') root.style.setProperty(k, vars[k]);
    });
  }
  if (ctx.theme) document.body.dataset.theme = ctx.theme;
}

rpc('ui/initialize', {
  appInfo: { name: 'ui-design-gallery', version: '0.1.0' },
  appCapabilities: { availableDisplayModes: ['inline', 'fullscreen'] },
  protocolVersion: '2026-01-26'
})
  .then(function (res) {
    state.bridgeReady = true;
    if (res && res.hostCapabilities) state.hostCaps = res.hostCapabilities;
    applyHostStyles(res && res.hostContext);
    notify('ui/notifications/initialized');
  })
  .catch(function (err) {
    setStatus('host bridge unavailable — ' + err.message + ' (images fall back to direct URLs)', true);
  });

/* ---------- helpers ---------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function setStatus(msg, isErr) {
  statusEl.textContent = msg || '';
  statusEl.hidden = !msg;
  statusEl.classList.toggle('err', !!isErr);
}

function fmtMoney(v) {
  if (v == null) return null;
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M/mo';
  if (v >= 1e3) return '$' + Math.round(v / 1e3) + 'k/mo';
  return '$' + v + '/mo';
}

function fmtNum(v) {
  if (v == null) return null;
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return Math.round(v / 1e3) + 'k';
  return String(v);
}

function firstUrl(rec) {
  if (rec.cachedUrls && rec.cachedUrls[0]) return rec.cachedUrls[0];
  if (rec.thumbnailUrl) return rec.thumbnailUrl;
  if (rec.imageUrls && rec.imageUrls[0]) return rec.imageUrls[0];
  return null;
}

/** Fetch an image through the get_image tool (cache + transcode on the server). */
function bridgeImage(url, maxDim, format) {
  return rpc('tools/call', { name: 'get_image', arguments: { url: url, maxDim: maxDim, format: format || 'jpeg' } })
    .then(function (res) {
      if (res && res.isError) throw new Error('get_image failed');
      var b = null;
      (res.content || []).forEach(function (c) { if (c.type === 'image') b = c; });
      if (!b) throw new Error('no image in result');
      return 'data:' + b.mimeType + ';base64,' + b.data;
    });
}

/** <img> that loads via the bridge once visible; falls back to the remote URL. */
function lazyImg(rec, maxDim, cls) {
  var img = document.createElement('img');
  img.className = cls || '';
  img.alt = rec.title || rec.id || 'screenshot';
  img.loading = 'lazy';
  var url = firstUrl(rec);
  if (!url) return img;
  var started = false;
  var useDirect = function () { img.src = url; };
  var io = new IntersectionObserver(function (ents) {
    ents.forEach(function (en) {
      if (!en.isIntersecting || started) return;
      started = true;
      if (state.bridgeReady) {
        bridgeImage(url, maxDim || 640)
          .then(function (dataUrl) { img.src = dataUrl; })
          .catch(useDirect);
      } else {
        useDirect();
      }
      io.unobserve(en.target);
    });
  }, { rootMargin: '300px' });
  io.observe(img);
  return img;
}

function openUrl(url) {
  if (!url) return;
  rpc('ui/open-link', { url: url })
    .catch(function () {
      setStatus('open this in your browser: ' + url);
    });
}

function swatchesEl(colors) {
  if (!colors || !colors.length) return null;
  var w = document.createElement('div');
  w.className = 'swatches';
  colors.slice(0, 8).forEach(function (c) {
    var s = document.createElement('span');
    s.className = 'sw';
    s.style.background = c;
    s.title = c;
    w.appendChild(s);
  });
  return w;
}

function badge(text) {
  var b = document.createElement('span');
  b.className = 'badge';
  b.textContent = text;
  return b;
}

/* ---------- views ---------- */

function onResult(res) {
  showModelResult(res);
  var d = null;
  if (res && res.structuredContent) d = res.structuredContent;
  else if (res && res.content) {
    for (var i = 0; i < res.content.length; i++) {
      if (res.content[i].type === 'text') {
        try { d = JSON.parse(res.content[i].text); } catch (e) { d = { _text: res.content[i].text }; }
        break;
      }
    }
  }
  if (!d) d = {};
  state.data = d;
  state.imageBlock = null;
  (res.content || []).forEach(function (c) { if (c.type === 'image') state.imageBlock = c; });
  render();
}

function render() {
  var d = state.data;
  closeOverlay();
  view.innerHTML = '';
  titleEl.textContent = 'ui-design';
  countEl.textContent = '';

  if (d._text) {
    view.innerHTML = '<div class="loading">' + esc(d._text) + '</div>';
    return;
  }

  if (d.type === 'screens' && Array.isArray(d.results)) {
    renderGrid(d.results, 'Screens · ' + (d.query || 'all'), d.notes);
  } else if (d.type === 'apps' && Array.isArray(d.apps)) {
    renderApps(d.apps, d.notes);
  } else if (d.app && Array.isArray(d.screens)) {
    renderAppSession(d, d.notes);
  } else if (Array.isArray(d.flows)) {
    renderFlows(d.flows, 'Flows', d.notes);
  } else if (Array.isArray(d.components)) {
    renderGrid(d.components, 'Components · ' + (d.component || ''), d.notes);
  } else if (d.url) {
    renderSingleImage(d);
  } else {
    view.innerHTML = '<pre class="json">' + esc(JSON.stringify(d, null, 2)) + '</pre>';
  }
}

function renderNotes(notes) {
  if (!notes || !notes.length) return;
  var p = document.createElement('div');
  p.className = 'status';
  p.textContent = notes.join(' · ');
  view.appendChild(p);
}

function renderGrid(records, heading, notes) {
  titleEl.textContent = 'ui-design — ' + heading;
  countEl.textContent = records.length + ' items';
  if (!records.length) {
    view.innerHTML = '<div class="empty">no results</div>';
    renderNotes(notes);
    return;
  }
  var grid = document.createElement('div');
  grid.className = 'grid';
  records.forEach(function (rec) {
    grid.appendChild(card(rec));
  });
  view.appendChild(grid);
  renderNotes(notes);
}

function card(rec) {
  var el = document.createElement('div');
  el.className = 'card';
  var tw = document.createElement('div');
  tw.className = 'thumbwrap';
  tw.appendChild(lazyImg(rec, 640));
  el.appendChild(tw);
  if (rec.videoUrl) {
    var clip = document.createElement('video');
    clip.src = rec.videoUrl;
    clip.controls = true;
    clip.playsInline = true;
    clip.preload = 'metadata';
    el.appendChild(clip);
  }

  var meta = document.createElement('div');
  meta.className = 'meta';
  var h = document.createElement('div');
  h.className = 'title';
  h.textContent = rec.title || rec.id;
  meta.appendChild(h);
  if (rec.tags && rec.tags.length) {
    var badges = document.createElement('div');
    badges.className = 'badges';
    badges.appendChild(badge(rec.source));
    if (rec.platform && rec.platform !== 'unknown') badges.appendChild(badge(rec.platform));
    rec.tags.forEach(function (t) { badges.appendChild(badge(t)); });
    meta.appendChild(badges);
  }
  var sw = swatchesEl(rec.colors);
  if (sw) meta.appendChild(sw);
  el.appendChild(meta);

  el.addEventListener('click', function () { openDetail(rec); });
  return el;
}

function renderApps(apps, notes) {
  titleEl.textContent = 'ui-design — app catalog';
  countEl.textContent = apps.length + ' apps';
  if (!apps.length) {
    view.innerHTML = '<div class="empty">no apps matched</div>';
    renderNotes(notes);
    return;
  }
  apps.forEach(function (a) {
    var row = document.createElement('div');
    row.className = 'appsrow';
    var icon = document.createElement('img');
    icon.className = 'icon';
    icon.alt = a.name;
    var iconUrl = a.iconUrl;
    if (iconUrl) {
      icon.src = iconUrl;
    }
    row.appendChild(icon);
    var info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = '<div class="name">' + esc(a.name) + '</div>' +
      '<div class="sub">' + esc(
        [a.category,
         a.rating != null ? '★ ' + Number(a.rating).toFixed(1) : null,
         fmtNum(a.downloads) ? fmtNum(a.downloads) + ' downloads' : null,
         fmtMoney(a.revenue),
         a.paywallType ? 'paywall: ' + a.paywallType : null
        ].filter(Boolean).join(' · ')
      ) + '</div>';
    row.appendChild(info);

    view.appendChild(row);
  });
  renderNotes(notes);
}

function renderAppSession(d, notes) {
  var a = d.app || {};
  titleEl.textContent = 'ui-design — ' + (a.name || 'app session');
  countEl.textContent = (d.screens || []).length + ' screens' + (d.storeScreenshotCount ? ' + ' + d.storeScreenshotCount + ' store' : '');

  var bar = document.createElement('div');
  bar.className = 'appbar';
  bar.innerHTML = '<h2>' + esc(a.name || '') + '</h2>' +
    '<div class="kv">' +
    kv('rating', a.rating != null ? Number(a.rating).toFixed(1) + ' ★' : null) +
    kv('downloads', fmtNum(a.downloads)) +
    kv('revenue', fmtMoney(a.revenueUsdMonthly)) +
    kv('paywall', a.paywallType) +
    kv('onboarding', a.onboardingStepCount != null ? a.onboardingStepCount + ' steps' : null) +
    kv('version', a.version) +
    '</div>';
  view.appendChild(bar);

  if (d.videoUrl) {
    var video = document.createElement('video');
    video.src = d.videoUrl;
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.addEventListener('error', function () {
      var note = document.createElement('div');
      note.className = 'status';
      note.textContent = 'video stream not reachable from this host — ' + d.videoUrl;
      video.replaceWith(note);
    });
    view.appendChild(video);
  }

  if (!d.screens.length) {
    view.appendChild(emptyEl('no screens decoded'));
  } else {
    var grid = document.createElement('div');
    grid.className = 'grid';
    d.screens.forEach(function (s, i) {
      var el = card(s);
      var n = document.createElement('div');
      n.className = 'badge';
      n.style.position = 'absolute';
      n.style.top = '8px';
      n.style.right = '8px';
      n.textContent = '#' + (i + 1);
      el.appendChild(n);
      grid.appendChild(el);
    });
    view.appendChild(grid);
    }
  renderNotes(notes);
}

function kv(k, v) {
  return v != null ? '<span>' + esc(k) + ': <b>' + esc(v) + '</b></span>' : '';
}

function renderFlows(flows, heading, notes) {
  titleEl.textContent = 'ui-design — ' + heading;
  countEl.textContent = flows.length + ' flows';
  if (!flows.length) {
    view.innerHTML = '<div class="empty">no flows found</div>';
    renderNotes(notes);
    return;
  }
  var wrap = document.createElement('div');
  wrap.className = 'flows';
  flows.forEach(function (f) {
    var box = document.createElement('div');
    box.className = 'flow';
    box.innerHTML = '<h3>' + esc(f.title || f.id) + '</h3>' +
      '<div class="sub">' + esc(
        [f.app && f.app.name ? 'by ' + f.app.name : null, f.source, (f.steps || []).length + ' steps']
          .filter(Boolean).join(' · ')
      ) + '</div>';
    if (f.videoUrl) {
      var clip = document.createElement('video');
      clip.src = f.videoUrl;
      clip.controls = true;
      clip.playsInline = true;
      clip.preload = 'metadata';
      box.appendChild(clip);
    }
    var steps = document.createElement('div');
    steps.className = 'steps';
    (f.steps || []).forEach(function (step, i) {
      var s = document.createElement('div');
      s.className = 'step';
      var tw = document.createElement('div');
      tw.className = 'thumbwrap';
      tw.appendChild(lazyImg(step, 640));
      var n = document.createElement('div');
      n.className = 'n';
      n.textContent = 'step ' + (i + 1) + (step.title ? ' — ' + step.title : '');
      s.appendChild(tw);
      s.appendChild(n);
      s.addEventListener('click', function () { openDetail(step); });
      steps.appendChild(s);
    });
    box.appendChild(steps);
    wrap.appendChild(box);
  });
  view.appendChild(wrap);
  renderNotes(notes);
}

function renderSingleImage(d) {
  titleEl.textContent = 'ui-design — image';
  countEl.textContent = d.width ? d.width + '×' + d.height + ' ' : '';
  var box = document.createElement('div');
  box.className = 'single';
  var img = document.createElement('img');
  var block = state.imageBlock;
  if (block) {
    img.src = 'data:' + block.mimeType + ';base64,' + block.data;
  } else if (d.url && state.bridgeReady) {
    bridgeImage(d.url, 1600, 'auto')
      .then(function (u) { img.src = u; })
      .catch(function () { img.src = d.url; });
  } else if (d.url) {
    img.src = d.url;
  }
  img.alt = 'screenshot';
  box.appendChild(img);
  var meta = document.createElement('div');
  meta.className = 'meta';
  meta.innerHTML = '<div class="kv">' +
    kv('mime', d.mimeType) +
    kv('size', d.bytes ? Math.round(d.bytes / 1024) + ' KB' : null) +
    kv('dims', d.width ? d.width + '×' + d.height : null) +
    '</div>';
  box.appendChild(meta);
  if (d.notes && d.notes.length) {
    var n = document.createElement('div');
    n.className = 'meta';
    n.textContent = d.notes.join(' · ');
    box.appendChild(n);
  }
  var actions = document.createElement('div');
  actions.className = 'actions';
  var openBtn = document.createElement('button');
  openBtn.textContent = 'Open original';
  openBtn.addEventListener('click', function () { openUrl(d.url); });
  actions.appendChild(openBtn);
  box.appendChild(actions);
  view.appendChild(box);
}

function emptyEl(msg) {
  var e = document.createElement('div');
  e.className = 'empty';
  e.textContent = msg;
  return e;
}

/* ---------- detail overlay ---------- */

function closeOverlay() {
  if (state.overlay) {
    state.overlay.remove();
    state.overlay = null;
  }
}

function openDetail(rec) {
  closeOverlay();
  var ov = document.createElement('div');
  ov.className = 'overlay';
  ov.addEventListener('click', function (e) { if (e.target === ov) closeOverlay(); });
  var panel = document.createElement('div');
  panel.className = 'panel';
  var h = document.createElement('h3');
  h.textContent = (rec.title || rec.id) + (rec.app && rec.app.name ? ' — ' + rec.app.name : '');
  panel.appendChild(h);
  var img = document.createElement('img');
  img.alt = rec.title || rec.id;
  img.src = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
  panel.appendChild(img);
  var desc = document.createElement('div');
  desc.className = 'desc';
  desc.textContent = [rec.source, rec.platform, (rec.tags || []).slice(0, 6).join(', ')]
    .filter(Boolean).join(' · ');
  panel.appendChild(desc);
  if (rec.fonts && rec.fonts.length) {
    var f = document.createElement('div');
    f.className = 'desc';
    f.textContent = 'fonts: ' + rec.fonts.join(', ');
    panel.appendChild(f);
  }
  var sw = swatchesEl(rec.colors);
  if (sw) panel.appendChild(sw);

  var actions = document.createElement('div');
  actions.className = 'actions';
  var openBtn = document.createElement('button');
  openBtn.textContent = 'Open source page';
  openBtn.addEventListener('click', function () { openUrl(rec.sourceUrl); });
  actions.appendChild(openBtn);
  var closeBtn = document.createElement('button');
  closeBtn.textContent = 'Close';
  closeBtn.addEventListener('click', closeOverlay);
  actions.appendChild(closeBtn);
  panel.appendChild(actions);
  ov.appendChild(panel);
  document.body.appendChild(ov);
  state.overlay = ov;

  var url = firstUrl(rec);
  if (!url) { img.remove(); return; }
  var load = function () {
    if (state.bridgeReady) {
      bridgeImage(url, 2048, 'auto')
        .then(function (u) { img.src = u; })
        .catch(function () { img.src = url; });
    } else {
      img.src = url;
    }
  };
  load();
}

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') closeOverlay();
});
</script>
</body>
</html>`;
