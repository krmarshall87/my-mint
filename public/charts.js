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
      const c = r.color || color;
      track.appendChild(el('span', { class: 'bar-fill', style: `width:${Math.max(0.5, (r.value / max) * 100)}%;background:${c}` }));
      li.appendChild(track);
      li.appendChild(el('span', { class: 'bar-value' }, format(r.value)));
      const rowsFor = () => [{ color: c, value: format(r.value), label: `${share}% of spending` }, ...(r.sub ? [{ value: '', label: r.sub }] : [])];
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


  // ------------------------------------------------------------- donut ------
  // slices: [{ label, value, color, onClick? }]. Part-to-whole at a glance; the
  // legend beside it carries every name, amount and share (never color alone).
  function donut(container, { slices, format, centerLabel = 'total' }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    const total = slices.reduce((s, x) => s + x.value, 0);
    if (!slices.length || !(total > 0)) {
      container.appendChild(el('p', { class: 'chart-empty muted' }, 'No spending for these filters.'));
      return;
    }
    const wrap = el('div', { class: 'donut-wrap' });
    const size = 240, r = size / 2 - 4, inner = r * 0.62, cx = size / 2, cy = size / 2;
    const svg = el('svg:svg', { width: size, height: size, viewBox: `0 0 ${size} ${size}`, role: 'img', 'aria-label': container.dataset.label || 'Spending by category', class: 'donut' });
    const pt = (rad, a) => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)];
    const arc = (a0, a1) => {
      if (a1 - a0 >= Math.PI * 2 - 1e-6) a1 = a0 + Math.PI * 2 - 1e-4; // a single full slice
      const large = a1 - a0 > Math.PI ? 1 : 0;
      const [x0, y0] = pt(r, a0), [x1, y1] = pt(r, a1), [x2, y2] = pt(inner, a1), [x3, y3] = pt(inner, a0);
      return `M${x0},${y0}A${r},${r} 0 ${large} 1 ${x1},${y1}L${x2},${y2}A${inner},${inner} 0 ${large} 0 ${x3},${y3}Z`;
    };
    const legend = el('ol', { class: 'donut-legend' });
    const paths = [], rows = [];
    const focus = (i) => {
      paths.forEach((p, j) => p.classList.toggle('dim', i !== null && j !== i));
      rows.forEach((row, j) => row.classList.toggle('active', j === i));
    };
    let a = 0;
    slices.forEach((s, i) => {
      const a1 = a + (s.value / total) * Math.PI * 2;
      const share = Math.round((s.value / total) * 100);
      const path = el('svg:path', { d: arc(a, a1), style: `fill:${s.color}`, class: 'slice', tabindex: 0, 'aria-label': `${s.label}: ${format(s.value)}, ${share}%` });
      a = a1;
      const rowsFor = () => [{ color: s.color, value: format(s.value), label: `${share}% of spending` }];
      path.addEventListener('pointermove', (e) => { focus(i); tip.show(rowsFor(), s.label, e.clientX, e.clientY); });
      path.addEventListener('focus', () => { focus(i); tip.show(rowsFor(), s.label, ...anchorOf(path)); });
      const off = () => { focus(null); tip.hide(); };
      path.addEventListener('pointerleave', off);
      path.addEventListener('blur', off);
      svg.appendChild(path);
      paths.push(path);

      const li = el('li', { class: 'legend-row' + (s.onClick ? ' clickable' : '') });
      li.appendChild(el('span', { class: 'swatch', style: `background:${s.color}` }));
      li.appendChild(el('span', { class: 'legend-name' }, s.label));
      li.appendChild(el('span', { class: 'legend-value' }, format(s.value)));
      li.appendChild(el('span', { class: 'legend-share muted' }, `${share}%`));
      li.addEventListener('pointerenter', () => focus(i));
      li.addEventListener('pointerleave', () => focus(null));
      if (s.onClick) {
        li.tabIndex = 0;
        li.addEventListener('click', s.onClick);
        li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); s.onClick(); } });
        path.addEventListener('click', s.onClick);
        path.classList.add('clickable');
      }
      legend.appendChild(li);
      rows.push(li);
    });
    svg.appendChild(el('svg:text', { x: cx, y: cy - 2, 'text-anchor': 'middle', class: 'donut-total' }, format(total)));
    svg.appendChild(el('svg:text', { x: cx, y: cy + 18, 'text-anchor': 'middle', class: 'donut-sub' }, centerLabel));
    wrap.appendChild(svg);
    wrap.appendChild(legend);
    container.appendChild(wrap);
  }

  // -------------------------------------------------------------- meter -----
  // A budget bar: fill = spent / limit, colored by status, with an optional
  // "today" marker showing how far through the month we are.
  function meter({ value, max, status, marker }) {
    const bar = el('div', { class: `meter ${status}`, role: 'meter', 'aria-valuemin': 0, 'aria-valuemax': max, 'aria-valuenow': value });
    bar.appendChild(el('span', { class: 'meter-fill', style: `width:${max > 0 ? Math.min(100, (value / max) * 100) : 0}%` }));
    if (marker != null && marker > 0 && marker < 1) bar.appendChild(el('span', { class: 'meter-today', style: `left:${marker * 100}%`, title: 'Today' }));
    return bar;
  }

  // Rounded data-end for a bar growing down from the baseline.
  function columnPathDown(x, y, w, h) {
    const r = Math.min(4, w / 2, h);
    return `M${x},${y}V${y + h - r}Q${x},${y + h} ${x + r},${y + h}H${x + w - r}Q${x + w},${y + h} ${x + w},${y + h - r}V${y}Z`;
  }

  // Symmetric-ish clean ticks spanning min..max (min may be negative).
  function niceRange(min, max, ticks = 4) {
    const span = Math.max(Math.abs(min), Math.abs(max)) || 1;
    const { step } = niceScale(span, Math.max(2, Math.round(ticks / (min < 0 && max > 0 ? 2 : 1))));
    return { lo: Math.floor(min / step) * step, hi: Math.ceil(max / step) * step || step, step };
  }

  // ------------------------------------------------ diverging bars + line --
  // rows: [{ label, year, sub, up, down, line, estimated }]. "up" grows above
  // zero, "down" below it (pass a positive number), "line" is drawn on top.
  // One axis: all three are dollars.
  function diverging(container, { rows, up, down, line, format, height = 260 }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    if (!rows.length) {
      container.appendChild(el('p', { class: 'chart-empty muted' }, 'No data yet.'));
      return;
    }
    const width = Math.max(280, container.clientWidth);
    const m = { top: 12, right: 10, bottom: 28, left: 58 };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const values = rows.flatMap((r) => [r.up, -r.down, r.line]);
    const { lo, hi, step } = niceRange(Math.min(0, ...values), Math.max(0, ...values));
    const yOf = (v) => m.top + ((hi - v) / (hi - lo)) * plotH;
    const band = plotW / rows.length;
    const colW = Math.max(3, Math.min(24, band * 0.6));
    const svg = el('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': container.dataset.label || '' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: Math.abs(v) < 1e-9 ? 'axis-line' : 'grid-line' }));
      svg.appendChild(el('svg:text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, (v < 0 ? '−' : '') + compactMoney(Math.abs(v))));
    }
    const hover = el('svg:rect', { class: 'hover-band', y: m.top, height: plotH, width: band, visibility: 'hidden' });
    svg.appendChild(hover);
    const zero = yOf(0);
    const every = Math.ceil(rows.length / Math.max(1, Math.floor(plotW / 48)));
    let lastYear = null;
    const pts = [];
    rows.forEach((r, i) => {
      const cx = m.left + band * i + band / 2;
      const x = cx - colW / 2;
      const cls = r.estimated ? 'mark estimated' : 'mark';
      if (r.up > 0) svg.appendChild(el('svg:path', { d: columnPath(x, yOf(r.up), colW, zero - yOf(r.up)), style: `fill:${up.color}`, class: cls }));
      // 2px surface gap between the up and down bars at the baseline.
      if (r.down > 0) svg.appendChild(el('svg:path', { d: columnPathDown(x, zero + 1, colW, Math.max(0, yOf(-r.down) - zero - 1)), style: `fill:${down.color}`, class: cls }));
      pts.push([cx, yOf(r.line)]);
      if (i % every === 0) {
        const text = r.year && r.year !== lastYear ? `${r.label} ${r.year}` : r.label;
        lastYear = r.year;
        svg.appendChild(el('svg:text', { x: cx, y: height - 8, 'text-anchor': 'middle', class: 'tick' }, text));
      }
    });
    svg.appendChild(el('svg:path', { d: pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(''), class: 'net-line', style: `stroke:${line.color}` }));
    pts.forEach(([x, y]) => svg.appendChild(el('svg:circle', { cx: x, cy: y, r: 4, class: 'net-dot', style: `fill:${line.color}` })));
    rows.forEach((r, i) => {
      const hit = el('svg:rect', { x: m.left + band * i, y: m.top, width: band, height: plotH, class: 'hit', tabindex: 0,
        'aria-label': `${r.sub}: ${up.label} ${format(r.up)}, ${down.label} ${format(r.down)}, ${line.label} ${format(r.line)}` });
      const show = (px, py) => {
        hover.setAttribute('x', m.left + band * i);
        hover.setAttribute('visibility', 'visible');
        tip.show([
          { color: line.color, value: format(r.line), label: line.label },
          { color: up.color, value: format(r.up), label: up.label },
          { color: down.color, value: format(r.down), label: down.label },
          ...(r.estimated ? [{ value: '', label: 'Estimated' }] : []),
        ], r.sub, px, py);
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

  // ---------------------------------------------------- spending pace -------
  // Cumulative spending by day: last month as a light area, this month as a
  // line ending in a dot. A crosshair snaps to the day under the pointer.
  function pace(container, { current, previous, days, format, currentLabel, previousLabel, color, height = 200 }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    const width = Math.max(280, container.clientWidth);
    const m = { top: 12, right: 12, bottom: 26, left: 54 };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const n = Math.max(days, previous.length);
    const { max, step } = niceScale(Math.max(1, ...current, ...previous));
    const xOf = (d) => m.left + ((d - 1) / Math.max(1, n - 1)) * plotW;
    const yOf = (v) => m.top + plotH - (Math.max(0, v) / max) * plotH;
    const svg = el('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': container.dataset.label || '' });
    for (let v = 0; v <= max + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: v === 0 ? 'axis-line' : 'grid-line' }));
      svg.appendChild(el('svg:text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, compactMoney(v)));
    }
    const ord = (d) => `${d}${d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th'}`;
    for (const d of [1, 8, 15, 22, 29].filter((d) => d <= n)) svg.appendChild(el('svg:text', { x: xOf(d), y: height - 8, 'text-anchor': 'middle', class: 'tick' }, ord(d)));
    if (previous.length) {
      const top = previous.map((v, i) => `${xOf(i + 1)},${yOf(v)}`);
      svg.appendChild(el('svg:path', { d: `M${xOf(1)},${yOf(0)}L${top.join('L')}L${xOf(previous.length)},${yOf(0)}Z`, class: 'pace-area', style: `fill:${color}` }));
    }
    if (current.length) {
      svg.appendChild(el('svg:path', { d: current.map((v, i) => `${i ? 'L' : 'M'}${xOf(i + 1)},${yOf(v)}`).join(''), class: 'pace-line', style: `stroke:${color}` }));
      const last = current.length;
      svg.appendChild(el('svg:circle', { cx: xOf(last), cy: yOf(current[last - 1]), r: 5, class: 'pace-dot', style: `stroke:${color}` }));
    }
    const cross = el('svg:line', { y1: m.top, y2: m.top + plotH, class: 'crosshair', visibility: 'hidden' });
    svg.appendChild(cross);
    const hit = el('svg:rect', { x: m.left, y: m.top, width: plotW, height: plotH, class: 'hit', tabindex: 0, 'aria-label': container.dataset.label || '' });
    const showDay = (d, px, py) => {
      const x = xOf(d);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('visibility', 'visible');
      tip.show([
        ...(d <= current.length ? [{ color, value: format(current[d - 1]), label: currentLabel }] : []),
        ...(d <= previous.length ? [{ color, value: format(previous[d - 1]), label: previousLabel }] : []),
      ], `Day ${d}`, px, py);
    };
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      const d = Math.min(n, Math.max(1, Math.round(((e.clientX - box.left - m.left) / plotW) * (n - 1)) + 1));
      showDay(d, e.clientX, e.clientY);
    });
    hit.addEventListener('focus', () => showDay(Math.max(1, current.length), ...anchorOf(hit)));
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
    container.appendChild(svg);
  }

  // ------------------------------------------------------- balance outlook --
  // Projected balance day by day (a step line), with a dashed buffer line.
  // days: [{ date, label, balance, events: [{ name, amount }] }]
  function outlook(container, { days, buffer, format, color, height = 220 }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    if (!days.length) return;
    const width = Math.max(280, container.clientWidth);
    const m = { top: 12, right: 12, bottom: 26, left: 58 };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const vals = days.map((d) => d.balance);
    const { lo, hi, step } = niceRange(Math.min(0, buffer, ...vals), Math.max(buffer, ...vals));
    const n = days.length;
    const xOf = (i) => m.left + (i / Math.max(1, n - 1)) * plotW;
    const yOf = (v) => m.top + plotH - ((v - lo) / (hi - lo || 1)) * plotH;
    const svg = el('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': container.dataset.label || '' });
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: Math.abs(v) < 1e-9 ? 'axis-line' : 'grid-line' }));
      svg.appendChild(el('svg:text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, (v < 0 ? '−' : '') + compactMoney(Math.abs(v))));
    }
    const every = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(plotW / 70))));
    days.forEach((d, i) => { if (i % every === 0) svg.appendChild(el('svg:text', { x: xOf(i), y: height - 8, 'text-anchor': 'middle', class: 'tick' }, d.label)); });
    const by = Math.round(yOf(buffer)) + 0.5;
    svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: by, y2: by, class: 'buffer-line' }));
    svg.appendChild(el('svg:text', { x: width - m.right, y: by - 5, 'text-anchor': 'end', class: 'tick' }, `Buffer ${format(buffer)}`));
    let path = `M${xOf(0)},${yOf(vals[0])}`;
    for (let i = 1; i < n; i++) path += `H${xOf(i)}V${yOf(vals[i])}`;
    svg.appendChild(el('svg:path', { d: path, class: 'pace-line', style: `stroke:${color}` }));
    days.forEach((d, i) => { if (d.events.some((e) => e.card)) svg.appendChild(el('svg:circle', { cx: xOf(i), cy: yOf(d.balance), r: 3.5, class: 'pace-dot', style: `stroke:${color}` })); });
    const cross = el('svg:line', { y1: m.top, y2: m.top + plotH, class: 'crosshair', visibility: 'hidden' });
    svg.appendChild(cross);
    const hit = el('svg:rect', { x: m.left, y: m.top, width: plotW, height: plotH, class: 'hit', tabindex: 0, 'aria-label': container.dataset.label || '' });
    const show = (i, px, py) => {
      const d = days[i];
      cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i)); cross.setAttribute('visibility', 'visible');
      tip.show([
        { color, value: format(d.balance), label: 'checking, end of day' },
        ...d.events.map((e) => ({ value: `${e.amount > 0 ? '+' : '−'}${format(Math.abs(e.amount))}`, label: e.name })),
      ], d.date, px, py);
    };
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      show(Math.min(n - 1, Math.max(0, Math.round(((e.clientX - box.left - m.left) / plotW) * (n - 1)))), e.clientX, e.clientY);
    });
    hit.addEventListener('focus', () => show(0, ...anchorOf(hit)));
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
    container.appendChild(svg);
  }

  // ------------------------------------------------------------ line chart --
  // Several series over the same x points (e.g. a loan balance with and without
  // extra payments). series: [{ label, color, dashed, values: [number|null] }]
  function lines(container, { labels, series, format, height = 220, tickEvery = 12 }) {
    const card = container.closest('.chart-card');
    const tip = tooltip(card);
    container.replaceChildren();
    const n = labels.length;
    if (!n) return;
    const width = Math.max(280, container.clientWidth);
    const m = { top: 12, right: 12, bottom: 26, left: 58 };
    const plotW = width - m.left - m.right, plotH = height - m.top - m.bottom;
    const all = series.flatMap((s) => s.values.filter((v) => v != null));
    const { max, step } = niceScale(Math.max(1, ...all));
    const xOf = (i) => m.left + (i / Math.max(1, n - 1)) * plotW;
    const yOf = (v) => m.top + plotH - (Math.max(0, v) / max) * plotH;
    const svg = el('svg:svg', { width, height, viewBox: `0 0 ${width} ${height}`, role: 'img', 'aria-label': container.dataset.label || '' });
    for (let v = 0; v <= max + 1e-9; v += step) {
      const y = Math.round(yOf(v)) + 0.5;
      svg.appendChild(el('svg:line', { x1: m.left, x2: width - m.right, y1: y, y2: y, class: v === 0 ? 'axis-line' : 'grid-line' }));
      svg.appendChild(el('svg:text', { x: m.left - 8, y: y + 4, 'text-anchor': 'end', class: 'tick' }, compactMoney(v)));
    }
    const every = Math.max(tickEvery, Math.ceil(n / Math.max(2, Math.floor(plotW / 60)) / tickEvery) * tickEvery);
    for (let i = 0; i < n; i += every) svg.appendChild(el('svg:text', { x: xOf(i), y: height - 8, 'text-anchor': 'middle', class: 'tick' }, labels[i]));
    for (const s of series) {
      let d = '';
      s.values.forEach((v, i) => { if (v != null) d += `${d ? 'L' : 'M'}${xOf(i)},${yOf(v)}`; });
      svg.appendChild(el('svg:path', { d, class: `pace-line${s.dashed ? ' dashed-line' : ''}`, style: `stroke:${s.color}` }));
    }
    const cross = el('svg:line', { y1: m.top, y2: m.top + plotH, class: 'crosshair', visibility: 'hidden' });
    svg.appendChild(cross);
    const hit = el('svg:rect', { x: m.left, y: m.top, width: plotW, height: plotH, class: 'hit', tabindex: 0, 'aria-label': container.dataset.label || '' });
    const show = (i, px, py) => {
      cross.setAttribute('x1', xOf(i)); cross.setAttribute('x2', xOf(i)); cross.setAttribute('visibility', 'visible');
      tip.show(series.map((s) => ({ color: s.color, value: s.values[i] == null ? 'paid off' : format(s.values[i]), label: s.label })), labels[i], px, py);
    };
    hit.addEventListener('pointermove', (e) => {
      const box = svg.getBoundingClientRect();
      show(Math.min(n - 1, Math.max(0, Math.round(((e.clientX - box.left - m.left) / plotW) * (n - 1)))), e.clientX, e.clientY);
    });
    hit.addEventListener('focus', () => show(0, ...anchorOf(hit)));
    const hide = () => { cross.setAttribute('visibility', 'hidden'); tip.hide(); };
    hit.addEventListener('pointerleave', hide);
    hit.addEventListener('blur', hide);
    svg.appendChild(hit);
    container.appendChild(svg);
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

  window.Charts = { columns, bars, donut, meter, table, el, diverging, pace, outlook, lines };
})();
