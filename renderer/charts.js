function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function chartFont(size = 10) {
  const family = getCssVar('--font') || 'system-ui, sans-serif';
  return `${size}px ${family}`;
}

function formatNumber(n) {
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat().format(n);
}

function hexWithAlpha(color, alphaHex) {
  if (color?.startsWith('#') && color.length === 7) return `${color}${alphaHex}`;
  return color;
}

function shortRepo(name) {
  if (!name) return '';
  const parts = String(name).split('/');
  return parts.length > 1 ? parts[parts.length - 1] : name;
}

function ensureTooltip() {
  let el = document.getElementById('chart-tooltip');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'chart-tooltip';
  el.className = 'chart-tooltip hidden';
  el.setAttribute('role', 'tooltip');
  document.body.appendChild(el);
  return el;
}

function hideTooltip() {
  const el = document.getElementById('chart-tooltip');
  if (el) el.classList.add('hidden');
}

function showTooltip(clientX, clientY, html) {
  const el = ensureTooltip();
  el.innerHTML = html;
  el.classList.remove('hidden');
  const pad = 12;
  const rect = el.getBoundingClientRect();
  let left = clientX + pad;
  let top = clientY + pad;
  if (left + rect.width > window.innerWidth - 8) left = clientX - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = clientY - rect.height - pad;
  el.style.left = `${Math.max(8, left)}px`;
  el.style.top = `${Math.max(8, top)}px`;
}

function tooltipHtml(point, options = {}) {
  const label = options.valueLabel || 'Delta';
  const repos = point.repos || [];
  const maxRows = options.maxRepos || 8;
  const rows = repos.slice(0, maxRows).map((r) => {
    const sign = r.delta > 0 ? '+' : '';
    return `<div class="tt-row"><span class="tt-repo">${escapeHtml(shortRepo(r.name))}</span><span class="tt-delta">${sign}${formatNumber(r.delta)}</span></div>`;
  }).join('');
  const more = repos.length > maxRows
    ? `<div class="tt-more">+${repos.length - maxRows} more</div>`
    : '';
  const body = repos.length
    ? `<div class="tt-repos">${rows}${more}</div>`
    : `<div class="tt-empty">${point.value > 0 ? 'No per-repo breakdown' : 'No change'}</div>`;

  return `
    <div class="tt-date">${escapeHtml(point.date)}</div>
    <div class="tt-total">${escapeHtml(label)} <strong>${formatNumber(point.value)}</strong></div>
    ${body}
  `;
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** @type {WeakMap<HTMLCanvasElement, { hits: Array, options: object }>} */
const chartState = new WeakMap();

function bindHover(canvas) {
  if (canvas._ghHoverBound) return;
  canvas._ghHoverBound = true;

  canvas.addEventListener('mousemove', (e) => {
    const state = chartState.get(canvas);
    if (!state?.hits?.length) {
      hideTooltip();
      canvas.style.cursor = 'default';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const hit = state.hits.find((h) =>
      x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1
    );
    if (!hit) {
      hideTooltip();
      canvas.style.cursor = 'default';
      return;
    }
    canvas.style.cursor = 'pointer';
    showTooltip(e.clientX, e.clientY, tooltipHtml(hit.point, state.options));
  });

  canvas.addEventListener('mouseleave', () => {
    hideTooltip();
    canvas.style.cursor = 'default';
  });
}

function drawLineChart(canvas, series, options = {}) {
  const parent = canvas.parentElement;
  const width = parent?.clientWidth || canvas.clientWidth || 300;
  const height = parent?.clientHeight || canvas.clientHeight || 120;
  const color = options.color || getCssVar('--chart-stars') || '#0078d4';
  const mode = options.mode || 'line'; // 'line' | 'bars'
  const interactive = options.interactive !== false && (mode === 'bars' || options.tooltips);

  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const pad = {
    top: 8,
    right: 8,
    bottom: height < 100 ? 16 : 20,
    left: width < 180 ? 32 : 38
  };
  const plotW = Math.max(1, width - pad.left - pad.right);
  const plotH = Math.max(1, height - pad.top - pad.bottom);

  ctx.clearRect(0, 0, width, height);

  const textSecondary = getCssVar('--text-secondary') || 'rgba(128,128,128,0.8)';
  const border = getCssVar('--border') || 'rgba(128,128,128,0.2)';

  const hits = [];

  if (!series.length) {
    ctx.fillStyle = textSecondary;
    ctx.font = chartFont(10);
    ctx.textAlign = 'center';
    ctx.fillText(options.emptyText || 'No data yet', width / 2, height / 2);
    chartState.set(canvas, { hits: [], options });
    bindHover(canvas);
    return;
  }

  const values = series.map((p) => p.value);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(0, ...values);
  const range = maxVal - minVal || 1;

  const xAt = (i) => pad.left + (series.length === 1
    ? plotW / 2
    : (i / Math.max(series.length - 1, 1)) * plotW);
  const yAt = (v) => pad.top + plotH - ((v - minVal) / range) * plotH;

  const gridLines = height < 100 ? 3 : 4;
  ctx.strokeStyle = border;
  ctx.lineWidth = 1;
  for (let i = 0; i <= gridLines; i++) {
    const y = pad.top + (plotH * i) / gridLines;
    ctx.beginPath();
    ctx.moveTo(pad.left, y);
    ctx.lineTo(pad.left + plotW, y);
    ctx.stroke();

    const val = maxVal - (range * i) / gridLines;
    ctx.fillStyle = textSecondary;
    ctx.font = chartFont(9);
    ctx.textAlign = 'right';
    ctx.fillText(formatNumber(Math.round(val)), pad.left - 4, y + 3);
  }

  if (mode === 'bars') {
    const gap = series.length > 40 ? 1 : 2;
    const slot = plotW / series.length;
    const barW = Math.max(1, slot - gap);
    series.forEach((p, i) => {
      const x = pad.left + i * slot + gap / 2;
      const y = yAt(p.value);
      const h = pad.top + plotH - y;
      ctx.fillStyle = hexWithAlpha(color, 'cc');
      ctx.fillRect(x, y, barW, Math.max(h, p.value > 0 ? 2 : 0));
      if (interactive) {
        hits.push({
          x0: pad.left + i * slot,
          x1: pad.left + (i + 1) * slot,
          y0: pad.top,
          y1: pad.top + plotH,
          point: p
        });
      }
    });
  } else {
    const points = series.map((p, i) => ({ x: xAt(i), y: yAt(p.value), value: p.value, point: p }));

    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, pad.top + plotH);
      points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
      ctx.lineTo(points[points.length - 1].x, pad.top + plotH);
      ctx.closePath();
      ctx.fillStyle = hexWithAlpha(color, '18');
      ctx.fill();

      ctx.beginPath();
      points.forEach((pt, i) => {
        if (i === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.75;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.stroke();
    }

    const markerEvery = points.length <= 24
      ? 1
      : Math.ceil(points.length / 16);
    points.forEach((pt, i) => {
      const isEdge = i === 0 || i === points.length - 1;
      const isSparse = points.length <= 3;
      if (!isEdge && !isSparse && i % markerEvery !== 0 && !interactive) return;
      const r = isSparse || points.length === 1 ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (interactive) {
        const hitR = Math.max(10, slotHitRadius(series.length, plotW));
        hits.push({
          x0: pt.x - hitR,
          x1: pt.x + hitR,
          y0: pad.top,
          y1: pad.top + plotH,
          point: pt.point
        });
      }
    });
  }

  const labelEvery = series.length <= 10
    ? Math.max(1, Math.floor(series.length / 4) || 1)
    : Math.ceil(series.length / Math.max(4, Math.floor(width / 56)));
  series.forEach((p, i) => {
    if (series.length === 1 || i % labelEvery === 0 || i === series.length - 1) {
      ctx.fillStyle = textSecondary;
      ctx.font = chartFont(9);
      ctx.textAlign = 'center';
      ctx.fillText(p.date.slice(5), xAt(i), height - 4);
    }
  });

  chartState.set(canvas, { hits, options });
  bindHover(canvas);
}

function slotHitRadius(count, plotW) {
  if (count <= 1) return 14;
  return Math.max(8, (plotW / count) / 2);
}

window.GhCharts = { drawLineChart, formatNumber, hideTooltip };
