(async function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const nf = new Intl.NumberFormat("ru-RU");
  const STATUS = {
    confirmed: { label: "Подтверждён", color: "var(--good)" },
    pending: { label: "Ожидает", color: "var(--warn)" },
    cancelled: { label: "Отменён", color: "var(--bad)" }
  };
  const AGE_BUCKETS = [
    { l: "до 18", f: (a) => a < 18 }, { l: "18–24", f: (a) => a >= 18 && a <= 24 },
    { l: "25–34", f: (a) => a >= 25 && a <= 34 }, { l: "35–44", f: (a) => a >= 35 && a <= 44 },
    { l: "45+", f: (a) => a >= 45 }
  ];

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else if (v === true) e.setAttribute(k, "");
      else if (v !== false && v != null) e.setAttribute(k, v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return e;
  }
  const svgNS = "http://www.w3.org/2000/svg";
  function s(tag, attrs, text) {
    const e = document.createElementNS(svgNS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    return e;
  }
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);
  const num = (n) => nf.format(n);
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  /* ---------- state ---------- */
  const state = {
    rows: [], capacity: 150, loaded: false, canWrite: true, sig: "",
    f: { period: "30", status: "", source: "", track: "", q: "" },
    sort: { key: "createdAt", dir: -1 }, page: 0, mode: "daily", csv: null, editCap: false
  };
  const PAGE = 10;

  /* ---------- dates ---------- */
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const dayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  const rowDate = (r) => new Date(r.createdAt);
  const fmtShort = (d) => d.toLocaleDateString("ru-RU", { day: "numeric", month: "short" });
  const fmtLong = (d) => d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "long" });

  /* ---------- filtering ---------- */
  function baseFilter(rows) {
    const { status, source, track, q } = state.f;
    const needle = q.trim().toLowerCase();
    return rows.filter((r) =>
      (!status || r.status === status) && (!source || r.source === source) && (!track || r.track === track) &&
      (!needle || [r.name, r.email, r.city].some((v) => String(v || "").toLowerCase().includes(needle))));
  }
  function windowBounds() {
    if (state.f.period === "all") return null;
    const n = +state.f.period, today = startOfDay(new Date());
    return { n, from: addDays(today, -(n - 1)), to: addDays(today, 1), prevFrom: addDays(today, -(2 * n - 1)) };
  }
  function filtered() {
    const base = baseFilter(state.rows), w = windowBounds();
    if (!w) return base;
    return base.filter((r) => { const d = rowDate(r); return d >= w.from && d < w.to; });
  }
  function prevCount() {
    const w = windowBounds(); if (!w) return null;
    return baseFilter(state.rows).filter((r) => { const d = rowDate(r); return d >= w.prevFrom && d < w.from; }).length;
  }
  function countBy(rows, key, fallback) {
    const m = new Map();
    for (const r of rows) {
      const k = (r[key] && String(r[key]).trim()) || fallback;
      const e = m.get(k) || { label: k, value: 0, confirmed: 0 };
      e.value++; if (r.status === "confirmed") e.confirmed++;
      m.set(k, e);
    }
    return [...m.values()].sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "ru"));
  }

  /* ---------- tooltip & toast ---------- */
  const tip = $("#tip");
  function showTip(ev, title, lines) {
    tip.replaceChildren(h("b", { text: title }), ...lines.map((t) => h("div", { text: t })));
    tip.hidden = false;
    const pad = 12, w = tip.offsetWidth, hh = tip.offsetHeight;
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + w > window.innerWidth - 8) x = ev.clientX - w - pad;
    if (y + hh > window.innerHeight - 8) y = ev.clientY - hh - pad;
    tip.style.left = Math.max(8, x) + "px"; tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  let toastTimer;
  function toast(msg) {
    const t = $("#toast"); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 3600);
  }
  function errText(e) {
    return (e && e.message) || "Не удалось выполнить действие.";
  }

  /* ---------- API ---------- */
  async function api(method, url, body) {
    const res = await fetch(url, {
      method, credentials: "same-origin",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    });
    let data = null;
    try { data = await res.json(); } catch (e) { /* пустой ответ */ }
    if (!res.ok) {
      if (res.status === 401 && url !== "/api/login") showLogin();
      const err = new Error((data && data.error) || "Ошибка сервера (" + res.status + ")");
      err.status = res.status; throw err;
    }
    return data;
  }
  async function reload() {
    const d = await api("GET", "/api/participants");
    const sig = JSON.stringify(d);
    if (sig === state.sig && state.loaded) return;
    state.sig = sig; state.rows = d.participants; state.capacity = d.capacity; state.loaded = true;
    renderEmpty(); renderAll();
  }

  /* ---------- KPIs ---------- */
  function renderKpis() {
    const rows = filtered(), n = rows.length;
    const conf = rows.filter((r) => r.status === "confirmed").length;
    const pend = rows.filter((r) => r.status === "pending").length;
    const canc = rows.filter((r) => r.status === "cancelled").length;
    const prev = prevCount(), w = windowBounds();
    const taken = state.rows.filter((r) => r.status !== "cancelled").length;
    const free = state.capacity - taken;

    let deltaEl;
    if (prev == null) deltaEl = h("span", { class: "delta flat", text: "за всё время" });
    else if (prev === 0) deltaEl = h("span", { class: "delta flat", text: n ? "в прошлом периоде регистраций не было" : "—" });
    else {
      const d = Math.round(((n - prev) / prev) * 100);
      deltaEl = h("span", {}, h("span", { class: "delta " + (d > 0 ? "up" : d < 0 ? "down" : "flat"), text: (d > 0 ? "▲ +" : d < 0 ? "▼ " : "= ") + d + "%" }), " к предыдущим " + w.n + " дн.");
    }
    const capNote = state.editCap
      ? h("span", { class: "cap-edit" },
          h("input", { id: "cap-input", type: "number", min: "1", value: state.capacity, "aria-label": "Количество мест" }),
          h("button", { class: "btn small primary", type: "button", onclick: saveCapacity, text: "Ок" }))
      : h("span", {}, free >= 0 ? "Свободно " + num(free) : "Превышение на " + num(-free), " · ",
          state.canWrite ? h("button", { class: "linkbtn", type: "button", onclick: () => { state.editCap = true; renderKpis(); setTimeout(() => { const i = $("#cap-input"); if (i) i.focus(); }, 0); }, text: "изменить" }) : null);

    const meter = (parts) => h("div", { class: "meter", "aria-hidden": "true" }, parts.map((p) => h("i", { style: "width:" + p.w + "%;background:" + p.c })));
    $("#kpis").replaceChildren(
      h("div", { class: "card kpi" }, h("div", { class: "label", text: "Регистраций" }), h("div", { class: "value", text: num(n) }), h("div", { class: "note" }, deltaEl)),
      h("div", { class: "card kpi" }, h("div", { class: "label", text: "Подтверждено" }),
        h("div", { class: "value" }, num(conf), " ", h("small", { text: pct(conf, n) + "%" })),
        meter([{ w: pct(conf, n), c: STATUS.confirmed.color }, { w: pct(pend, n), c: STATUS.pending.color }]),
        h("div", { class: "note", text: "Ожидают подтверждения: " + num(pend) })),
      h("div", { class: "card kpi" }, h("div", { class: "label", text: "Занято мест" }),
        h("div", { class: "value" }, num(taken), " ", h("small", { text: "из " + num(state.capacity) })),
        meter([{ w: Math.min(100, pct(taken, state.capacity)), c: "var(--accent)" }]),
        h("div", { class: "note" }, capNote)),
      h("div", { class: "card kpi" }, h("div", { class: "label", text: "Отмены" }),
        h("div", { class: "value" }, num(canc), " ", h("small", { text: pct(canc, n) + "%" })),
        h("div", { class: "note", text: canc ? "Отказались от участия" : "Отмен нет" }))
    );
  }
  async function saveCapacity() {
    const v = Math.round(+$("#cap-input").value);
    state.editCap = false;
    if (!(v > 0)) { renderKpis(); return; }
    try { await api("PUT", "/api/settings", { capacity: v }); state.capacity = v; }
    catch (e) { toast(errText(e)); }
    renderKpis(); renderInsights();
  }

  /* ---------- daily chart ---------- */
  function series() {
    const base = baseFilter(state.rows), today = startOfDay(new Date()), w = windowBounds();
    let from;
    if (w) from = w.from;
    else {
      const ds = base.map(rowDate).filter((d) => !isNaN(d));
      from = ds.length ? startOfDay(new Date(Math.min(...ds))) : today;
      const cap = addDays(today, -89); if (from < cap) from = cap;
    }
    const days = [];
    for (let d = new Date(from); d <= today; d = addDays(d, 1)) days.push({ d: new Date(d), k: dayKey(d), n: 0, cum: 0 });
    const idx = new Map(days.map((x, i) => [x.k, i]));
    let before = 0;
    for (const r of base) {
      const d = rowDate(r); if (isNaN(d)) continue;
      const k = dayKey(d);
      if (idx.has(k)) days[idx.get(k)].n++; else if (startOfDay(d) < from) before++;
    }
    let c = before; for (const x of days) { c += x.n; x.cum = c; }
    return days;
  }
  function niceMax(v) {
    if (v <= 4) return 4;
    const x = v / 4, p = Math.pow(10, Math.floor(Math.log10(x))), m = x / p;
    return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p * 4;
  }
  function renderDaily() {
    const box = $("#chart-daily");
    const days = series(), W = Math.max(260, box.clientWidth), H = 240;
    const ml = 36, mr = 10, mt = 14, mb = 26, iw = W - ml - mr, ih = H - mt - mb;
    const cum = state.mode === "cum";
    const vals = days.map((x) => (cum ? x.cum : x.n));
    const max = niceMax(Math.max(1, ...vals));
    const y = (v) => mt + ih - (v / max) * ih;
    const svg = s("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": cum ? "Накопительное число регистраций" : "Регистрации по дням" });
    for (let i = 0; i <= 4; i++) {
      const v = (max / 4) * i, yy = y(v);
      svg.append(s("line", { class: "grid-line", x1: ml, x2: W - mr, y1: yy, y2: yy }));
      svg.append(s("text", { x: ml - 6, y: yy + 4, "text-anchor": "end" }, num(Math.round(v))));
    }
    const n = days.length, slot = iw / Math.max(1, n);
    const hl = s("rect", { y: mt, height: ih, width: slot, fill: "var(--hover)", visibility: "hidden" });
    svg.append(hl);
    const step = Math.max(1, Math.ceil(n / 7));
    days.forEach((x, i) => {
      if ((n - 1 - i) % step === 0) svg.append(s("text", { x: ml + slot * (i + 0.5), y: H - 8, "text-anchor": "middle" }, fmtShort(x.d)));
    });
    if (!cum) {
      const gap = slot > 8 ? 2 : 1, bw = Math.max(1, slot - gap * 2), r = Math.min(4, bw / 2);
      let peak = -1;
      vals.forEach((v, i) => { if (v > 0 && (peak < 0 || v > vals[peak])) peak = i; });
      days.forEach((x, i) => {
        if (!x.n) return;
        const bx = ml + slot * i + gap, by = y(x.n), bh = mt + ih - by;
        svg.append(s("path", { fill: "var(--bar)", d: "M" + bx + " " + (by + bh) + "V" + (by + r) + "a" + r + " " + r + " 0 0 1 " + r + " " + -r + "H" + (bx + bw - r) + "a" + r + " " + r + " 0 0 1 " + r + " " + r + "V" + (by + bh) + "Z" }));
      });
      if (peak >= 0) svg.append(s("text", { class: "peak", x: ml + slot * (peak + 0.5), y: y(vals[peak]) - 5, "text-anchor": "middle" }, String(vals[peak])));
    } else {
      const px = (i) => ml + slot * (i + 0.5);
      let d = "";
      days.forEach((x, i) => { d += (i ? "L" : "M") + px(i) + " " + y(x.cum); });
      svg.append(s("path", { d: d + "L" + px(n - 1) + " " + (mt + ih) + "L" + px(0) + " " + (mt + ih) + "Z", fill: "var(--accent)", opacity: ".14" }));
      svg.append(s("path", { d, fill: "none", stroke: "var(--accent)", "stroke-width": 2, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      const last = days[n - 1];
      if (last) {
        svg.append(s("circle", { cx: px(n - 1), cy: y(last.cum), r: 4, fill: "var(--accent)", stroke: "var(--surface)", "stroke-width": 2 }));
        svg.append(s("text", { class: "peak", x: px(n - 1), y: y(last.cum) - 9, "text-anchor": "end" }, String(last.cum)));
      }
    }
    const cap = s("rect", { x: ml, y: mt, width: iw, height: ih, fill: "transparent" });
    const move = (ev) => {
      const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.floor((px - ml) / slot)));
      hl.setAttribute("x", ml + slot * i); hl.setAttribute("visibility", "visible");
      const x = days[i];
      showTip(ev, fmtLong(x.d), ["Регистраций за день: " + x.n, "Всего к этому дню: " + num(x.cum)]);
    };
    cap.addEventListener("pointermove", move);
    cap.addEventListener("pointerleave", () => { hl.setAttribute("visibility", "hidden"); hideTip(); });
    svg.append(cap);
    box.replaceChildren(svg);
    const total = days.reduce((a, x) => a + x.n, 0);
    $("#daily-hint").textContent = state.f.period === "all" ? "За всё время (не больше 90 последних дней), всего " + num(total) : "Последние " + state.f.period + " дн., всего " + num(total);
  }

  /* ---------- breakdown charts ---------- */
  function renderHbars(sel, entries, opts) {
    const box = $(sel), total = opts.total;
    if (!entries.length) { box.replaceChildren(h("p", { class: "hint", text: "Нет данных по текущим фильтрам" })); return; }
    let list = entries;
    if (opts.limit && entries.length > opts.limit) {
      const top = entries.slice(0, opts.limit), rest = entries.slice(opts.limit);
      list = [...top, { label: "Другие (" + rest.length + ")", value: rest.reduce((a, x) => a + x.value, 0), confirmed: rest.reduce((a, x) => a + x.confirmed, 0) }];
    }
    const max = Math.max(...list.map((x) => x.value));
    box.replaceChildren(...list.map((e) => {
      const row = h("div", { class: "hrow" },
        h("div", { class: "name", text: e.label }),
        h("div", { class: "track" }, h("div", { class: "fill", style: "width:" + (e.value / max) * 100 + "%" })),
        h("div", { class: "num" }, num(e.value), h("span", { text: opts.conv ? pct(e.confirmed, e.value) + "% подтв." : pct(e.value, total) + "%" })));
      row.addEventListener("pointermove", (ev) => showTip(ev, e.label, [num(e.value) + " " + plural(e.value, "регистрация", "регистрации", "регистраций") + " (" + pct(e.value, total) + "%)", "Подтверждено: " + e.confirmed + " (" + pct(e.confirmed, e.value) + "%)"]));
      row.addEventListener("pointerleave", hideTip);
      return row;
    }));
  }
  function renderStatus(rows) {
    const box = $("#by-status"), n = rows.length;
    if (!n) { box.replaceChildren(h("p", { class: "hint", text: "Нет данных по текущим фильтрам" })); return; }
    const items = Object.entries(STATUS).map(([k, v]) => ({ k, ...v, n: rows.filter((r) => r.status === k).length }));
    const stack = h("div", { class: "stack", role: "img", "aria-label": "Распределение по статусам" }, items.filter((i) => i.n).map((i) => {
      const seg = h("div", { style: "flex:" + i.n + " 1 0;background:" + i.color });
      seg.addEventListener("pointermove", (ev) => showTip(ev, i.label, [num(i.n) + " (" + pct(i.n, n) + "%)"]));
      seg.addEventListener("pointerleave", hideTip);
      return seg;
    }));
    const legend = h("div", { class: "legend" }, items.map((i) => {
      const it = h("div", { class: "item" }, h("span", { class: "dot", style: "background:" + i.color }), h("span", { text: i.label }), h("span", { class: "n" }, num(i.n), h("span", { text: pct(i.n, n) + "%" })));
      return it;
    }));
    box.replaceChildren(stack, legend);
  }
  function renderAge(rows) {
    const box = $("#by-age"), ages = rows.map((r) => +r.age).filter((a) => a > 0);
    $("#age-hint").textContent = ages.length ? "Средний возраст " + (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1).replace(".", ",") + " · указан у " + pct(ages.length, rows.length) + "% участников" : "Возраст не указан";
    if (!ages.length) { box.replaceChildren(h("p", { class: "hint", text: "Нет данных по текущим фильтрам" })); return; }
    const counts = AGE_BUCKETS.map((b) => ages.filter(b.f).length), max = Math.max(1, ...counts);
    box.replaceChildren(...AGE_BUCKETS.map((b, i) => {
      const col = h("div", { class: "col" }, h("div", { class: "v", text: counts[i] }), h("div", { class: "bar-wrap", style: "height:120px" }, h("div", { class: "bar", style: "height:" + (counts[i] / max) * 100 + "%" })), h("div", { class: "l", text: b.l }));
      col.addEventListener("pointermove", (ev) => showTip(ev, b.l + " лет", [counts[i] + " (" + pct(counts[i], ages.length) + "%)"]));
      col.addEventListener("pointerleave", hideTip);
      return col;
    }));
  }
  function renderBreakdowns() {
    const rows = filtered(), n = rows.length;
    renderHbars("#by-source", countBy(rows, "source", "Не указан"), { total: n, conv: true });
    renderHbars("#by-track", countBy(rows, "track", "Не указано"), { total: n });
    renderHbars("#by-city", countBy(rows, "city", "Не указан"), { total: n, limit: 6 });
    renderStatus(rows); renderAge(rows);
  }

  /* ---------- insights ---------- */
  function renderInsights() {
    const rows = filtered(), n = rows.length, ul = $("#insights"), items = [];
    if (!n) { ul.replaceChildren(h("li", { text: "По текущим фильтрам регистраций нет." })); return; }
    const b = (t) => h("b", { text: t });
    const prev = prevCount(), w = windowBounds();
    if (prev != null && prev > 0) {
      const d = Math.round(((n - prev) / prev) * 100);
      items.push(h("li", {}, h("span", {}, "За " + w.n + " дн. пришло ", b(num(n)), " " + plural(n, "регистрация", "регистрации", "регистраций") + ": ", b((d >= 0 ? "на " : "на ") + Math.abs(d) + "% " + (d >= 0 ? "больше" : "меньше")), " чем за предыдущие " + w.n + ".")));
    }
    const src = countBy(rows, "source", "Не указан");
    if (src.length) items.push(h("li", {}, h("span", {}, "Главный источник: ", b(src[0].label), ", " + num(src[0].value) + " (" + pct(src[0].value, n) + "%).")));
    const good = src.filter((x) => x.value >= 5).sort((a, c) => c.confirmed / c.value - a.confirmed / a.value)[0];
    if (good && good.label !== "Не указан") items.push(h("li", {}, h("span", {}, "Лучше всего подтверждают участие из канала ", b(good.label), ": ", b(pct(good.confirmed, good.value) + "%"), ".")));
    const days = series(), peak = days.reduce((a, x) => (x.n > (a ? a.n : 0) ? x : a), null);
    if (peak && peak.n > 1) items.push(h("li", {}, h("span", {}, "Пик регистраций: ", b(fmtShort(peak.d)), ", " + peak.n + " " + plural(peak.n, "человек", "человека", "человек") + ".")));
    const city = countBy(rows, "city", "Не указан").filter((x) => x.label !== "Не указан")[0];
    if (city) items.push(h("li", {}, h("span", {}, "Больше всего участников из города ", b(city.label), ": ", b(pct(city.value, n) + "%"), ".")));
    const pend = state.rows.filter((r) => r.status === "pending").length;
    if (pend) items.push(h("li", {}, h("span", {}, b(num(pend)), " " + plural(pend, "участник ждёт", "участника ждут", "участников ждут") + " подтверждения.")));
    ul.replaceChildren(...items.slice(0, 6));
  }

  /* ---------- table ---------- */
  const COLS = [
    { k: "name", t: "Участник" }, { k: "city", t: "Город" }, { k: "track", t: "Направление" },
    { k: "source", t: "Источник" }, { k: "age", t: "Возраст", num: true }, { k: "createdAt", t: "Дата" }, { k: "status", t: "Статус" }
  ];
  function renderHead() {
    $("#thead").replaceChildren(...COLS.map((c) => {
      const active = state.sort.key === c.k;
      const th = h("th", { scope: "col", "aria-sort": active ? (state.sort.dir > 0 ? "ascending" : "descending") : false },
        h("button", { type: "button", onclick: () => { state.sort = { key: c.k, dir: active ? -state.sort.dir : c.k === "createdAt" ? -1 : 1 }; state.page = 0; renderHead(); renderTable(); } },
          c.t, active ? (state.sort.dir > 0 ? " ↑" : " ↓") : ""));
      return th;
    }), h("th", { scope: "col", text: "" }));
  }
  function sortRows(rows) {
    const { key, dir } = state.sort;
    return rows.slice().sort((a, b) => {
      let x = a[key], y = b[key];
      if (key === "createdAt") { x = rowDate(a).getTime() || 0; y = rowDate(b).getTime() || 0; }
      if (key === "age") { x = +x || 0; y = +y || 0; }
      if (typeof x === "number") return (x - y) * dir;
      return String(x || "").localeCompare(String(y || ""), "ru") * dir;
    });
  }
  const pendingDelete = new Set();
  function renderTable() {
    const rows = sortRows(filtered()), n = rows.length;
    const pages = Math.max(1, Math.ceil(n / PAGE));
    if (state.page >= pages) state.page = pages - 1;
    const slice = rows.slice(state.page * PAGE, state.page * PAGE + PAGE);
    $("#table-count").textContent = "Найдено: " + num(n);
    const tb = $("#tbody");
    if (!slice.length) tb.replaceChildren(h("tr", {}, h("td", { colspan: COLS.length + 1, class: "empty-row", text: "По текущим фильтрам участников нет." })));
    else tb.replaceChildren(...slice.map((r) => {
      const sel = h("select", { class: "status-sel", "aria-label": "Статус: " + r.name, disabled: !state.canWrite, onchange: (ev) => setStatus(r, ev.target.value) },
        Object.entries(STATUS).map(([k, v]) => h("option", { value: k, selected: r.status === k }, v.label)));
      const stat = h("span", { style: "display:inline-flex;align-items:center;gap:8px" }, h("span", { class: "dot", style: "background:" + (STATUS[r.status] || STATUS.pending).color }), sel);
      const del = h("button", { class: "btn small" + (pendingDelete.has(r.id) ? " danger" : ""), type: "button", disabled: !state.canWrite,
        onclick: () => {
          if (!pendingDelete.has(r.id)) { pendingDelete.add(r.id); renderTable(); setTimeout(() => { pendingDelete.delete(r.id); renderTable(); }, 3500); return; }
          pendingDelete.delete(r.id); removeRow(r);
        } }, pendingDelete.has(r.id) ? "Удалить?" : "Удалить");
      const d = rowDate(r);
      return h("tr", {},
        h("td", { class: "person" }, h("b", {}, r.name || "Без имени", r.demo ? h("span", { class: "demo-tag", text: "демо" }) : null), h("span", { text: r.email || "" })),
        h("td", { text: r.city || "—" }), h("td", { text: r.track || "—" }), h("td", { text: r.source || "—" }),
        h("td", { class: "num", text: r.age || "—" }),
        h("td", { class: "num", text: isNaN(d) ? "—" : d.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit", year: "2-digit" }) }),
        h("td", {}, stat), h("td", {}, del));
    }));
    const from = n ? state.page * PAGE + 1 : 0, to = Math.min(n, (state.page + 1) * PAGE);
    $("#pager").replaceChildren(
      h("span", { text: from + "–" + to + " из " + num(n) }),
      h("span", { style: "display:inline-flex;gap:8px" },
        h("button", { class: "btn small", type: "button", disabled: state.page === 0, onclick: () => { state.page--; renderTable(); }, text: "← Назад" }),
        h("button", { class: "btn small", type: "button", disabled: state.page >= pages - 1, onclick: () => { state.page++; renderTable(); }, text: "Вперёд →" })));
  }

  /* ---------- writes ---------- */
  async function setStatus(r, status) {
    try { await api("PATCH", "/api/participants/" + r.id, { status }); await reload(); }
    catch (e) { toast(errText(e)); renderTable(); }
  }
  async function removeRow(r) {
    try { await api("DELETE", "/api/participants/" + r.id); await reload(); toast("Участник удалён"); }
    catch (e) { toast(errText(e)); }
  }
  async function removeDemo() {
    $("#btn-demo-del") && ($("#btn-demo-del").disabled = true);
    try { const d = await api("DELETE", "/api/demo"); await reload(); toast("Демо-данные удалены: " + d.deleted); }
    catch (e) { toast(errText(e)); }
  }

  /* ---------- filters ---------- */
  let optKey = "";
  function syncFilterOptions() {
    const srcs = [...new Set(state.rows.map((r) => r.source).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const trs = [...new Set(state.rows.map((r) => r.track).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const cities = [...new Set(state.rows.map((r) => r.city).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const key = srcs.join("|") + "#" + trs.join("|") + "#" + cities.join("|");
    if (key === optKey) return; optKey = key;
    const fill = (sel, all, vals, cur) => { sel.replaceChildren(h("option", { value: "" }, all), ...vals.map((v) => h("option", { value: v, selected: v === cur }, v))); };
    fill($("#f-source"), "Все источники", srcs, state.f.source);
    fill($("#f-track"), "Все направления", trs, state.f.track);
    $("#dl-source").replaceChildren(...srcs.map((v) => h("option", { value: v })));
    $("#dl-track").replaceChildren(...trs.map((v) => h("option", { value: v })));
    $("#dl-city").replaceChildren(...cities.map((v) => h("option", { value: v })));
  }
  function renderBanner() {
    const demo = state.rows.filter((r) => r.demo).length, b = $("#banner");
    if (!demo) { b.hidden = true; return; }
    b.hidden = false;
    b.replaceChildren(h("span", { text: "В таблице " + demo + " демонстрационных записей. Это не настоящие участники." }),
      h("button", { class: "btn small", id: "btn-demo-del", type: "button", disabled: !state.canWrite, onclick: removeDemo, text: "Удалить демо-данные" }));
  }
  function renderAll() {
    const has = state.rows.length > 0;
    $("#dash").hidden = !has || !state.loaded;
    $("#empty").hidden = has || !state.loaded;
    const confirmed = state.rows.filter((r) => r.status === "confirmed").length;
    $("#sub").textContent = state.loaded ? (has ? num(state.rows.length) + " " + plural(state.rows.length, "участник", "участника", "участников") + " в базе, подтверждено " + num(confirmed) + ". Данные обновляются сами." : "Регистраций пока нет") : "Загружаем данные…";
    $("#btn-add").disabled = !state.canWrite; $("#btn-import").disabled = !state.canWrite;
    $("#btn-export").disabled = !state.rows.length;
    renderBanner();
    if (!has) return;
    syncFilterOptions();
    renderKpis(); renderInsights(); renderDaily(); renderBreakdowns(); renderTable();
  }
  function bindFilters() {
    $("#seg-period").addEventListener("click", (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      state.f.period = b.dataset.p; state.page = 0;
      for (const x of $("#seg-period").children) x.setAttribute("aria-pressed", String(x === b));
      renderAll();
    });
    $("#seg-mode").addEventListener("click", (ev) => {
      const b = ev.target.closest("button"); if (!b) return;
      state.mode = b.dataset.m;
      for (const x of $("#seg-mode").children) x.setAttribute("aria-pressed", String(x === b));
      renderDaily();
    });
    for (const [id, key] of [["#f-status", "status"], ["#f-source", "source"], ["#f-track", "track"]])
      $(id).addEventListener("change", (ev) => { state.f[key] = ev.target.value; state.page = 0; renderAll(); });
    let t; $("#f-q").addEventListener("input", (ev) => { clearTimeout(t); t = setTimeout(() => { state.f.q = ev.target.value; state.page = 0; renderAll(); }, 150); });
    $("#f-reset").addEventListener("click", () => {
      state.f = { period: "all", status: "", source: "", track: "", q: "" }; state.page = 0;
      $("#f-status").value = ""; $("#f-source").value = ""; $("#f-track").value = ""; $("#f-q").value = "";
      for (const x of $("#seg-period").children) x.setAttribute("aria-pressed", String(x.dataset.p === "all"));
      renderAll();
    });
  }

  /* ---------- drawer: add / import ---------- */
  function openDrawer(tab) {
    $("#drawer-back").hidden = false; setTab(tab);
    $("#a-date").value = dayKey(new Date()); $("#a-err").textContent = "";
    if (tab === "manual") setTimeout(() => $("#a-name").focus(), 0);
  }
  const closeDrawer = () => { $("#drawer-back").hidden = true; };
  function setTab(t) {
    for (const x of $("#seg-add").children) x.setAttribute("aria-pressed", String(x.dataset.t === t));
    $("#form-add").hidden = t !== "manual"; $("#csv-pane").hidden = t !== "csv";
    $("#drawer-title").textContent = t === "manual" ? "Новый участник" : "Импорт из CSV";
  }
  function dateFromInput(v) {
    if (!v) return new Date().toISOString();
    if (v === dayKey(new Date())) return new Date().toISOString();
    return new Date(v + "T12:00:00").toISOString();
  }
  const emailKey = (e) => String(e || "").trim().toLowerCase();
  async function submitAdd(ev) {
    ev.preventDefault();
    const err = $("#a-err"), email = emailKey($("#a-email").value), name = $("#a-name").value.trim();
    if (!name) { err.textContent = "Укажите имя."; return; }
    if (state.rows.some((r) => emailKey(r.email) === email)) { err.textContent = "Участник с таким email уже зарегистрирован."; return; }
    const age = parseInt($("#a-age").value, 10);
    const doc = { name, email, city: $("#a-city").value.trim(), age: age > 0 ? age : null, track: $("#a-track").value.trim(), source: $("#a-source").value.trim(), status: $("#a-status").value, createdAt: dateFromInput($("#a-date").value) };
    $("#a-submit").disabled = true;
    try { await api("POST", "/api/participants", doc); await reload(); toast("Участник добавлен: " + name); $("#form-add").reset(); closeDrawer(); }
    catch (e) { err.textContent = errText(e); }
    $("#a-submit").disabled = false;
  }

  function parseCSV(text) {
    text = text.replace(/^﻿/, "");
    const first = text.split(/\r?\n/)[0] || "";
    const delim = [";", "\t", ","].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
    const out = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ""; }
      else if (c === "\n" || c === "\r") { if (c === "\r" && text[i + 1] === "\n") i++; row.push(cur); cur = ""; if (row.some((x) => x.trim())) out.push(row); row = []; }
      else cur += c;
    }
    row.push(cur); if (row.some((x) => x.trim())) out.push(row);
    return out;
  }
  const ALIASES = {
    name: ["имя", "фио", "name", "участник", "full name", "fullname", "имя и фамилия"],
    email: ["email", "e-mail", "почта", "mail", "эл. почта"],
    city: ["город", "city"], age: ["возраст", "age"],
    track: ["направление", "трек", "track", "direction"], source: ["источник", "source", "канал", "utm_source"],
    status: ["статус", "status"], date: ["дата", "дата регистрации", "date", "createdat", "created_at", "registered", "registered_at"]
  };
  function normStatus(v) {
    const t = String(v || "").toLowerCase();
    if (/подтв|confirm|оплач|paid|approved/.test(t)) return "confirmed";
    if (/отмен|cancel|отказ|declin/.test(t)) return "cancelled";
    return "pending";
  }
  function parseDate(v) {
    const t = String(v || "").trim(); if (!t) return new Date().toISOString();
    const m = t.match(/^(\d{1,2})[.\/](\d{1,2})[.\/](\d{2,4})(?:[ T](\d{1,2}):(\d{2}))?/);
    let d;
    if (m) { const y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; d = new Date(y, +m[2] - 1, +m[1], m[4] ? +m[4] : 12, m[5] ? +m[5] : 0); }
    else d = new Date(t);
    return isNaN(d) ? new Date().toISOString() : d.toISOString();
  }
  function csvToDocs(text) {
    const table = parseCSV(text);
    if (table.length < 2) return { docs: [], skipped: 0, dup: 0, error: "В файле нет строк с данными." };
    const head = table[0].map((x) => x.trim().toLowerCase()), col = {};
    for (const [k, names] of Object.entries(ALIASES)) col[k] = head.findIndex((x) => names.includes(x));
    if (col.name < 0 && col.email < 0) return { docs: [], skipped: 0, dup: 0, error: "Не найдены столбцы «имя» или «email». Проверьте заголовки." };
    const seen = new Set(state.rows.map((r) => emailKey(r.email)).filter(Boolean));
    const docs = []; let skipped = 0, dup = 0;
    for (const r of table.slice(1)) {
      const g = (k) => (col[k] >= 0 ? (r[col[k]] || "").trim() : "");
      const email = emailKey(g("email")), name = g("name") || email;
      if (!name) { skipped++; continue; }
      if (email && seen.has(email)) { dup++; continue; }
      if (email) seen.add(email);
      const age = parseInt(g("age"), 10);
      docs.push({ name, email, city: g("city"), age: age > 0 && age < 100 ? age : null, track: g("track"), source: g("source"), status: normStatus(g("status")), createdAt: parseDate(g("date")) });
    }
    return { docs, skipped, dup };
  }
  async function onCsvFile(ev) {
    const f = ev.target.files[0]; state.csv = null; $("#csv-go").disabled = true;
    if (!f) { $("#csv-summary").textContent = ""; return; }
    const text = await f.text(), res = csvToDocs(text), sum = $("#csv-summary");
    if (res.error) { sum.textContent = res.error; return; }
    state.csv = res.docs.slice(0, 500);
    sum.textContent = "Будет добавлено: " + num(state.csv.length) + (res.docs.length > 500 ? " (первые 500)" : "") + ". Пропущено дублей по email: " + res.dup + ", пустых строк: " + res.skipped + ".";
    $("#csv-go").disabled = !state.csv.length;
  }
  async function runImport() {
    const docs = state.csv; if (!docs || !docs.length) return;
    $("#csv-go").disabled = true;
    try {
      const d = await api("POST", "/api/participants/import", { items: docs });
      await reload();
      toast("Импортировано: " + d.added + (d.skipped ? ", пропущено: " + d.skipped : ""));
      state.csv = null; $("#csv-file").value = ""; $("#csv-summary").textContent = ""; closeDrawer();
    } catch (e) { toast(errText(e)); $("#csv-go").disabled = false; }
  }

  /* ---------- export ---------- */
  function exportCsv() {
    const rows = sortRows(filtered()), esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const head = ["Имя", "Email", "Город", "Возраст", "Направление", "Источник", "Статус", "Дата регистрации"];
    const lines = [head.map(esc).join(",")].concat(rows.map((r) => [r.name, r.email, r.city, r.age, r.track, r.source, (STATUS[r.status] || STATUS.pending).label, isNaN(rowDate(r)) ? "" : rowDate(r).toISOString().slice(0, 10)].map(esc).join(",")));
    const blob = new Blob(["\uFEFF" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = h("a", { href: URL.createObjectURL(blob), download: "xpup-registrations-" + dayKey(new Date()) + ".csv" });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast("Экспортировано строк: " + rows.length);
  }

  async function loadDemo() {
    try { await api("POST", "/api/demo"); await reload(); } catch (e) { toast(errText(e)); }
  }

  /* ---------- empty state ---------- */
  function renderEmpty() {
    $("#empty").replaceChildren(
      h("h2", { text: "Регистраций пока нет" }),
      h("p", { text: "Добавьте первого участника вручную или загрузите CSV-выгрузку с сайта. Графики и выводы появятся сразу после первой записи." }),
      h("div", { class: "actions" },
        h("button", { class: "btn primary", type: "button", disabled: !state.canWrite, onclick: () => openDrawer("csv"), text: "Загрузить CSV" }),
        h("button", { class: "btn", type: "button", disabled: !state.canWrite, onclick: () => openDrawer("manual"), text: "Добавить вручную" }),
        h("button", { class: "btn", type: "button", onclick: loadDemo, text: "Показать на демо-данных" })));
  }

  /* ---------- wiring ---------- */
  $("#btn-add").addEventListener("click", () => openDrawer("manual"));
  $("#btn-import").addEventListener("click", () => openDrawer("csv"));
  $("#btn-export").addEventListener("click", exportCsv);
  $("#drawer-close").addEventListener("click", closeDrawer);
  $("#drawer-back").addEventListener("pointerdown", (ev) => { if (ev.target.id === "drawer-back") closeDrawer(); });
  document.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && !$("#drawer-back").hidden) closeDrawer(); });
  $("#seg-add").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setTab(b.dataset.t); });
  $("#form-add").addEventListener("submit", submitAdd);
  $("#csv-file").addEventListener("change", onCsvFile);
  $("#csv-go").addEventListener("click", runImport);
  document.addEventListener("keydown", (ev) => { if (ev.key === "Enter" && ev.target.id === "cap-input") saveCapacity(); });
  bindFilters(); renderHead(); renderEmpty();
  let rz; new ResizeObserver(() => { cancelAnimationFrame(rz); rz = requestAnimationFrame(() => { if (!$("#dash").hidden) renderDaily(); }); }).observe($("#chart-daily"));

  /* ---------- login ---------- */
  const wrap = document.querySelector(".wrap");
  let poll;
  function showLogin() {
    clearInterval(poll); state.loaded = false; state.sig = "";
    wrap.hidden = true; $("#login").hidden = false; $("#btn-logout").hidden = true;
    closeDrawer(); setTimeout(() => $("#l-pass").focus(), 0);
  }
  function startApp() {
    $("#login").hidden = true; wrap.hidden = false; $("#btn-logout").hidden = false;
    reload().catch((e) => { $("#sub").textContent = errText(e); });
    clearInterval(poll);
    poll = setInterval(() => {
      const a = document.activeElement;
      if (document.hidden || !$("#drawer-back").hidden || (a && a.classList && a.classList.contains("status-sel"))) return;
      reload().catch(() => {});
    }, 20000);
  }
  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector("button"); btn.disabled = true; $("#l-err").textContent = "";
    try { await api("POST", "/api/login", { password: $("#l-pass").value }); $("#l-pass").value = ""; startApp(); }
    catch (e) { $("#l-err").textContent = errText(e); }
    btn.disabled = false;
  });
  $("#btn-logout").addEventListener("click", async () => { try { await api("POST", "/api/logout"); } catch (e) { /* ничего */ } showLogin(); });

  /* ---------- start ---------- */
  try {
    const me = await api("GET", "/api/me");
    if (me.admin) startApp(); else showLogin();
  } catch (e) { wrap.hidden = false; $("#sub").textContent = "Нет связи с сервером."; }
})();
