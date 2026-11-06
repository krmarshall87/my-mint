// Small dependency-free SVG/HTML charts. Everything is built with DOM calls and
// textContent, so labels from bank data are never parsed as HTML.
(function () {
  const SVG_NS = 'http://www.w3.org/2000/svg';

  function el(tag, attrs = {}, text) {
    const node = tag.startsWith('svg:')
      ? document.createElementNS(SVG_NS, tag.slice(4))
      : document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null) node.setAttribute(k, v);
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------------------------------------------------------- tooltip --
  // One tooltip per chart card. Values lead (strong), labels follow (muted).
  function tooltip(card) {
    let tip = card.querySelector(':scope > .chart-tip');
    if (!tip) {
      tip = el('div', { class: 'chart-tip', role: 'status', hidden: '' });
      card.appendChild(tip);
    }
    return {
      show(rows, title, x, y) {
        tip.replaceChildren();
        if (title) tip.appendChild(el('div', { class: 'tip-title' }, title));
        for (const r of rows) {
          const row = el('div', { class: 'tip-row' });
          if (r.color) row.appendChild(el('span', { class: 'tip-key', style: `background:${r.color}` }));
          row.appendChild(el('strong', {}, r.value));
          row.appendChild(el('span', { class: 'muted' }, r.label));
          tip.appendChild(row);
        }
        tip.hidden = false;
        const box = card.getBoundingClientRect();
        const w = tip.offsetWidth, h = tip.offsetHeight;
        let left = x - box.left + 12, top = y - box.top - h - 12;
        if (left + w > box.width - 4) left = x - box.left - w - 12;
        if (top < 4) top = y - box.top + 16;
        tip.style.left = `${Math.max(4, left)}px`;
        tip.style.top = `${top}px`;
      },
      hide() { tip.hidden = true; },
    };
  }

  // Position a tooltip at an element (keyboard focus) instead of the pointer.
  function anchorOf(node) {
    const r = node.getBoundingClientRect();
    return [r.left + r.width / 2, r.top + Math.min(r.height / 2, 40)];
  }

  // Round an axis maximum up to a clean number, with ~4 ticks.
  function niceScale(max, ticks = 4) {
    if (!(max > 0)) return { max: 1, step: 1 };
    const raw = max / ticks;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
    return { max: step * Math.ceil(max / step), step };
  }

  const compactMoney = (n) =>
    n >= 10000
      ? '$' + new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(n)
      : '$' + Math.round(n).toLocaleString();

  // Column path: 4px rounded data-end (top), square at the baseline.
  function columnPath(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
  }

  // --------------------------------------------------- grouped column chart --
  // series: [{ key, label, color }] ; rows: [{ label, sub, [key]: number }]
  function columns(container, { rows, series, format, height = 220 }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    if (!rows.length) {
      container.appendChild(el('p', { class: 'chart-empty muted' }, 'No data for these filters.'));
      return;
    }
    const width = Math.max(280, container.clientWidth);
    const m = { top: 12, right: 8, bottom: 28, left: 52 };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const { max, step } = niceScale(Math.max(...rows.flatMap((r) => series.map((s) => r[s.key]))));
    const yOf = (v) => m.top + plotH - (v / max) * plotH;
    const band = plotW / rows.length;
    const gap = 2; // surface gap between the paired columns
    const colW = Math.max(2, Math.min(24, (band * 0.7 - gap) / series.length));
    const groupW = colW * series.length + gap * (series.length - 1);

    const svg = el('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': container.dataset.label || '' });

    // Recessive hairline grid + tick labels.
    for (let v = 0; v <= max + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: v === 0 ? 'axis-line' : 'grid-line' }));
      svg.appendChild(el('svg:text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, compactMoney(v)));
    }

    // Show at most ~12 x labels.
    const every = Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 48)));
    const hover = el('svg:rect', { class: 'hover-band', y: m.top, height: plotH, width: band, visibility: 'hidden' });
    svg.appendChild(hover);

    let lastYear = null;
    rows.forEach((row, i) => {
      const x0 = m.left + band * i + (band - groupW) / 2;
      series.forEach((s, j) => {
        const v = row[s.key];
        if (v > 0) {
          const y = yOf(v);
          svg.appendChild(el('svg:path', { d: columnPath(x0 + j * (colW + gap), y, colW, m.top + plotH - y), style: `fill:${s.color}`, class: 'mark' }));
        }
      });
      if (i % every === 0) {
        // Add the year to the first visible label and whenever it changes.
        const text = row.year && row.year !== lastYear ? `${row.label} ${row.year}` : row.label;
        lastYear = row.year;
        svg.appendChild(el('svg:text', { x: m.left + band * i + band / 2, y: height - 8, 'text-anchor': 'middle', class: 'tick' }, text));
      }
      // Hit target: the whole band, so the reader aims at a month, not a 12px column.
      const hit = el('svg:rect', { x: m.left + band * i, y: m.top, width: band, height: plotH, class: 'hit', tabindex: 0, 'aria-label': `${row.sub || row.label}: ${series.map((s) => `${s.label} ${format(row[s.key])}`).join(', ')}` });
      const show = (x, y) => {
        hover.setAttribute('x', m.left + band * i);
        hover.setAttribute('visibility', 'visible');
        const extra = row.extra ? [row.extra] : [];
        tip.show([...series.map((s) => ({ color: s.color, value: format(row[s.key]), label: s.label })), ...extra], row.sub || row.label, x, y);
      };
      hit.addEventListener('pointermove', (e) => show(e.clientX, e.clientY));
      hit.addEventListener('focus', () => show(...anchorOf(hit)));
      const hide = () => { hover.setAttribute('visibility', 'hidden'); tip.hide(); };
      hit.addEventListener('pointerleave', hide);
      hit.addEventListener('blur', hide);
      svg.appendChild(hit);
    });
    container.appendChild(svg);
  }

  // ---------------------------------------------------- ranked bar list ------
  // rows: [{ label, value, sub?, onClick? }] ; one series, one color.
  function bars(container, { rows, format, color, total }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    if (!rows.length) {
      container.appendChild(el('p', { class: 'chart-empty muted' }, 'No spending for these filters.'));
      return;
    }
    const max = Math.max(...rows.map((r) => r.value));
    const list = el('ol', { class: 'bar-list' });
    for (const r of rows) {
      const share = total > 0 ? Math.round((r.value / total) * 100) : 0;
      const li = el('li', { class: 'bar-row' + (r.onClick ? ' clickable' : ''), tabindex: 0, 'aria-label': `${r.label}: ${format(r.value)} (${share}%)` });
      li.appendChild(el('span', { class: 'bar-label' }, r.label));
      const track = el('span', { class: 'bar-track' });
      track.appendChild(el('span', { class: 'bar-fill', style: `width:${Math.max(0.5, (r.value / max) * 100)}%;background:${color}` }));
      li.appendChild(track);
      li.appendChild(el('span', { class: 'bar-value' }, format(r.value)));
      const rowsFor = () => [{ color, value: format(r.value), label: `${share}% of spending` }, ...(r.sub ? [{ value: '', label: r.sub }] : [])];
      li.addEventListener('pointermove', (e) => tip.show(rowsFor(), r.label, e.clientX, e.clientY));
      li.addEventListener('focus', () => tip.show(rowsFor(), r.label, ...anchorOf(li)));
      li.addEventListener('pointerleave', () => tip.hide());
      li.addEventListener('blur', () => tip.hide());
      if (r.onClick) {
        li.addEventListener('click', r.onClick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); r.onClick(); } });
      }
      list.appendChild(li);
    }
    container.appendChild(list);
  }

  // ------------------------------------------------------------ table view --
  // The accessible twin of every chart: same numbers, no hover needed.
  function table(container, { columns: cols, rows }) {
    container.replaceChildren();
    const t = el('table', { class: 'data-table' });
    const head = el('tr');
    cols.forEach((c) => head.appendChild(el('th', { class: c.num ? 'num' : '' }, c.label)));
    t.appendChild(el('thead')).appendChild(head);
    const body = el('tbody');
    for (const r of rows) {
      const tr = el('tr');
      cols.forEach((c) => tr.appendChild(el('td', { class: c.num ? 'num' : '' }, c.get(r))));
      body.appendChild(tr);
    }
    t.appendChild(body);
    container.appendChild(t);
  }

  window.Charts = { columns, bars, table };
})();
