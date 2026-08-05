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

function drawLineChart(canvas, series, options = {}) {
  const parent = canvas.parentElement;
  const width = parent?.clientWidth || canvas.clientWidth || 300;
  const height = parent?.clientHeight || canvas.clientHeight || 120;
  const color = options.color || getCssVar('--chart-stars') || '#0078d4';

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

  if (!series.length) {
    ctx.fillStyle = textSecondary;
    ctx.font = chartFont(10);
    ctx.textAlign = 'center';
    ctx.fillText('No data — refresh or load history', width / 2, height / 2);
    return;
  }

  const values = series.map((p) => p.value);
  const maxVal = Math.max(...values, 1);
  const minVal = Math.min(0, ...values);
  const range = maxVal - minVal || 1;

  const xAt = (i) => pad.left + (i / Math.max(series.length - 1, 1)) * plotW;
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

  const points = series.map((p, i) => ({ x: xAt(i), y: yAt(p.value) }));

  if (points.length > 1) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, pad.top + plotH);
    points.forEach((pt) => ctx.lineTo(pt.x, pt.y));
    ctx.lineTo(points[points.length - 1].x, pad.top + plotH);
    ctx.closePath();
    ctx.fillStyle = color.startsWith('#') && color.length === 7
      ? `${color}18`
      : color;
    ctx.fill();
  }

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

  const labelEvery = series.length <= 10
    ? 1
    : Math.ceil(series.length / Math.max(4, Math.floor(width / 56)));
  series.forEach((p, i) => {
    if (i % labelEvery !== 0 && i !== series.length - 1) return;
    ctx.fillStyle = textSecondary;
    ctx.font = chartFont(9);
    ctx.textAlign = 'center';
    ctx.fillText(p.date.slice(5), xAt(i), height - 4);
  });
}

window.GhCharts = { drawLineChart, formatNumber };
