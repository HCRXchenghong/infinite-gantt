const PARTS = [
  { key: '硬件研发', name: '硬件研发', cls: 'hw', color: '#e53e3e' },
  { key: '软件开发', name: '软件开发', cls: 'sw', color: '#3182ce' },
  { key: '平台运营', name: '平台运营', cls: 'op', color: '#dd6b20' },
  { key: '其他部分', name: '其他部分', cls: 'other', color: '#805ad5' },
];
const DAY = 86400000;
const HEADER_H = 46;
const LANE_MIN = 64; // 每个负责人行的最小高度
const LABEL_W = 200; // 左侧标签列宽度，与 CSS 中 .labels 一致

// 粒度档位：从细到粗（日 → 周 → 月 → 季度），各自定义「每天多少像素」
// ＋ 放大 = 更细（索引变小），− 缩小 = 更粗（索引变大）
const LEVELS = [
  { mode: 'day', name: '日', pxPerDay: 72 },   // 日视图每天 72px，宽松清晰
  { mode: 'week', name: '周', pxPerDay: 12 },  // 一周约 84px
  { mode: 'month', name: '月', pxPerDay: 3.2 },// 一月约 97px
  { mode: 'quarter', name: '季度', pxPerDay: 1.1 },
];

const LEVEL_STORAGE_KEY = 'infinite-gantt-level';
function getSavedLevel() {
  try {
    const saved = Number(localStorage.getItem(LEVEL_STORAGE_KEY));
    return Number.isInteger(saved) && saved >= 0 && saved < LEVELS.length ? saved : 0;
  } catch (e) {
    return 0;
  }
}
function saveLevel() {
  try { localStorage.setItem(LEVEL_STORAGE_KEY, String(levelIdx)); } catch (e) { /* 忽略浏览器存储限制 */ }
}

let levelIdx = getSavedLevel(); // 首次默认「日」，之后沿用用户上次选择
let lastEvents = [];

// 渲染期的坐标系（供滚动定位换算用）
let rangeMin = null;   // 时间轴起点对应的本地零点
let curPxPerDay = 0;
let chartEl = null;

// 'YYYY-MM-DD' → 本地零点（避免 UTC 解析偏移）
function parseDay(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(y, m - 1, d);
}
function midnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

async function load() {
  const res = await fetch('/api/data');
  const data = await res.json();
  lastEvents = data.events || [];
  render({ anchor: 'today' });
}

// anchor: 'today' = 今天贴最左；'keep' = 保持当前左边缘日期
function render(opt) {
  const anchor = (opt && opt.anchor) || 'keep';
  const events = lastEvents;
  const labelsEl = document.querySelector('#labels');
  chartEl = document.querySelector('.chart');

  if (!events.length) {
    labelsEl.innerHTML = '';
    document.querySelector('#timeline').innerHTML = '';
    document.querySelector('#rows').innerHTML = '<div style="padding:30px;text-align:center;color:#a0aec0">暂无事件数据</div>';
    document.querySelector('#legend').innerHTML = '';
    document.querySelector('#todayLine').hidden = true;
    return;
  }

  // 切换档位/窗口变化前，先记下当前左边缘对应的日期
  const keepDate = anchor === 'keep' ? leftEdgeDate() : null;

  // 时间范围：事件首尾月各留一个月余量
  const all = events.flatMap((e) => [parseDay(e.start).getTime(), parseDay(e.end).getTime()]);
  const first = new Date(Math.min(...all));
  const last = new Date(Math.max(...all));
  rangeMin = new Date(first.getFullYear(), first.getMonth() - 1, 1);
  const maxNext = new Date(last.getFullYear(), last.getMonth() + 2, 1);
  const days = Math.round((maxNext - rangeMin) / DAY); // 整数天数

  const level = LEVELS[levelIdx];
  // 图表宽：至少填满视口剩余宽度，保证任何档位下内容都铺满
  const fillW = Math.max(0, chartEl.clientWidth - LABEL_W - 2);
  const chartW = Math.max(fillW, Math.round(days * level.pxPerDay));
  curPxPerDay = chartW / days; // 以实际宽度回算，保证缩放后仍对齐

  // 显式设定内层与网格区宽度：sticky 标签列因此在整个滚动宽度内全程钉住
  document.querySelector('.chart-inner').style.width = (LABEL_W + chartW) + 'px';
  document.querySelector('.grid-wrap').style.width = chartW + 'px';

  const pos = (d) => Math.round(((midnight(d) - rangeMin) / DAY) * curPxPerDay);

  const barL = (startStr) => pos(parseDay(startStr));
  const barW = (e) => {
    const endNext = new Date(parseDay(e.end).getTime() + DAY); // 含结束当天
    return Math.max(6, pos(endNext) - pos(parseDay(e.start)));
  };

  const cells = buildTimelineCells(rangeMin, maxNext, chartW, level.mode, curPxPerDay);

  document.querySelector('#legend').innerHTML = PARTS.map(
    (p) => `<span><i class="dot" style="background:${p.color}"></i>${p.name}</span>`
  ).join('');

  document.querySelector('#zoomLabel').textContent = level.name;
  document.querySelector('#zoomIn').disabled = levelIdx === 0;
  document.querySelector('#zoomOut').disabled = levelIdx === LEVELS.length - 1;

  const availH = Math.max(0, chartEl.clientHeight - HEADER_H);

  // 按负责人分道：每个部分内，负责人相同的事件共用一行，不同负责人各占一行
  const partLanes = PARTS.map((p) => {
    const items = events
      .filter((e) => e.part === p.key)
      .sort((a, b) => parseDay(a.start) - parseDay(b.start));
    return buildLanes(items);
  });
  const totalLanes = partLanes.reduce((a, l) => a + l.length, 0) || 1;
  const rowH = Math.max(LANE_MIN, Math.floor(availH / totalLanes));

  labelsEl.innerHTML = PARTS.map((p, i) => {
    const lanes = partLanes[i];
    const n = events.filter((e) => e.part === p.key).length;
    const laneNames = lanes
      .map((l) => `<div class="lane-name" style="height:${rowH}px" title="${l.name}">${l.name}</div>`)
      .join('');
    return `<div class="label" style="height:${lanes.length * rowH}px">
      <div class="part-name"><span>${p.name}</span><span class="label-count">${n} 个节点</span></div>
      <div class="lane-names">${laneNames}</div>
    </div>`;
  }).join('');

  document.querySelector('#timeline').innerHTML = cells
    .map((m) => `<div class="mcell" style="width:${m.w}px">${m.label}</div>`)
    .join('');

  const rowsHtml = PARTS.map((p, i) => {
    const lanes = partLanes[i];
    return lanes
      .map((lane, li) => {
        const bars = lane.events
          .map((e) => {
            const owners = e.owners || [];
            const ownersHtml = owners.length
              ? `<div class="bar-owners">${owners.map((o) => `<span class="owner-chip">${o}</span>`).join('')}</div>`
              : '';
            return `<div class="bar ${p.cls}" data-id="${e.id}" style="left:${barL(e.start)}px;width:${barW(e)}px" title="${e.title}">${e.title}${ownersHtml}</div>`;
          })
          .join('');
        const stripes = cells.map((m) => `<i style="width:${m.w}px"></i>`).join('');
        const isLast = li === lanes.length - 1;
        return `<div class="row${isLast ? ' part-end' : ''}" style="height:${rowH}px"><div class="stripes">${stripes}</div>${bars}</div>`;
      })
      .join('');
  }).join('');
  document.querySelector('#rows').innerHTML = rowsHtml;

  // 今日红线：画在今天这格正中间
  const now = new Date();
  const line = document.querySelector('#todayLine');
  if (now >= rangeMin && now < maxNext) {
    line.style.left = (pos(now) + curPxPerDay / 2) + 'px';
    line.hidden = false;
  } else {
    line.hidden = true;
  }

  document.querySelectorAll('.bar').forEach((el) => {
    el.addEventListener('click', () => {
      const ev = events.find((e) => e.id === Number(el.dataset.id));
      if (ev) openModal(ev);
    });
  });

  // 滚动定位：今天贴最左 / 保持左边缘日期（并对齐到粒度单位起点）
  if (anchor === 'today') {
    scrollToToday(now, rangeMin, maxNext);
  } else if (keepDate) {
    chartEl.scrollLeft = pos(snapToUnitStart(keepDate, level.mode));
  }
}

// 把日期吸附到所属粒度单位的起点：周一 / 月1日 / 季首日 / 当天零点
function snapToUnitStart(d, mode) {
  const m = midnight(d);
  if (mode === 'day') return m;
  if (mode === 'week') {
    // 回退到最近的周一（getDay: 0=周日 … 6=周六）
    return new Date(m.getFullYear(), m.getMonth(), m.getDate() - ((m.getDay() + 6) % 7));
  }
  if (mode === 'month') return new Date(m.getFullYear(), m.getMonth(), 1);
  // quarter：季初月（1/4/7/10 月）的 1 日
  return new Date(m.getFullYear(), Math.floor(m.getMonth() / 3) * 3, 1);
}

function scrollToToday(now, min, maxNext) {
  const today = midnight(now);
  // 今天在范围内 → 贴左；否则退到时间轴起点
  const target = (today >= min && today < maxNext) ? today : min;
  chartEl.scrollLeft = Math.round(((target - min) / DAY) * curPxPerDay);
}

// 按负责人给事件分道（lane）：
// 以事件的负责人组合为道名（多人用「、」连接），同一负责人组合的事件在同一行；
// 无负责人的归入「未分配」。行内事件按开始时间排序。
function buildLanes(items) {
  const laneMap = new Map();
  items.forEach((e) => {
    const name = (e.owners && e.owners.length) ? e.owners.join('、') : '未分配';
    if (!laneMap.has(name)) laneMap.set(name, []);
    laneMap.get(name).push(e);
  });
  return [...laneMap.entries()].map(([name, evs]) => ({ name, events: evs }));
}

// 当前左边缘对应的日期（用于切换档位时保持视野不跳）
function leftEdgeDate() {
  if (!chartEl || !curPxPerDay || !rangeMin) return null;
  return new Date(rangeMin.getTime() + (chartEl.scrollLeft / curPxPerDay) * DAY);
}

// 时间轴分格：宽度按「相邻边界像素差」望远镜式累计，总和恒等于 chartW，
// 与条形共用同一套 pos() 计算，保证完全对齐
function buildTimelineCells(min, maxNext, chartW, mode, pxPerDay) {
  const cells = [];
  const pos = (d) => Math.round(((midnight(d) - min) / DAY) * pxPerDay);
  const nextDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

  if (mode === 'day') {
    const cur = new Date(min);
    while (cur < maxNext) {
      const next = nextDay(cur);
      cells.push({ label: `${cur.getMonth() + 1}/${cur.getDate()}`, w: Math.max(1, pos(next) - pos(cur)) });
      cur.setTime(next.getTime());
    }
  } else if (mode === 'week') {
    const cur = new Date(min);
    cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7)); // 回退到最近的周一
    while (cur < maxNext) {
      const next = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 7);
      const s = cur < min ? min : cur;
      const e = next > maxNext ? maxNext : next;
      if (e > s) cells.push({ label: `${s.getMonth() + 1}/${s.getDate()}`, w: Math.max(1, pos(e) - pos(s)) });
      cur.setTime(next.getTime());
    }
  } else if (mode === 'month') {
    const cur = new Date(min);
    while (cur < maxNext) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      const e = next > maxNext ? maxNext : next;
      const w = Math.max(1, pos(e) - pos(cur));
      const label = (cur.getMonth() === 0 || w >= 76)
        ? `${cur.getFullYear()}年${cur.getMonth() + 1}月`
        : `${cur.getMonth() + 1}月`;
      cells.push({ label, w });
      cur.setTime(next.getTime());
    }
  } else {
    // 季度：1/4/7/10 月为季初
    const cur = new Date(min.getFullYear(), Math.floor(min.getMonth() / 3) * 3, 1);
    while (cur < maxNext) {
      const next = new Date(cur.getFullYear(), cur.getMonth() + 3, 1);
      const s = cur < min ? min : cur;
      const e = next > maxNext ? maxNext : next;
      if (e > s) {
        const w = Math.max(1, pos(e) - pos(s));
        const q = Math.floor(s.getMonth() / 3) + 1;
        cells.push({ label: `${s.getFullYear()} Q${q}`, w });
      }
      cur.setTime(next.getTime());
    }
  }
  return cells;
}

function openModal(ev) {
  const p = PARTS.find((x) => x.key === ev.part) || { cls: 'sw', name: ev.part };
  const dur = Math.round((parseDay(ev.end) - parseDay(ev.start)) / DAY) + 1;
  document.querySelector('#modalBody').innerHTML = `
    <h2>${ev.title}</h2>
    <span class="tag ${p.cls}">${p.name}</span>
    <div class="kv"><b>开始时间</b><span>${ev.start}</span></div>
    <div class="kv"><b>结束时间</b><span>${ev.end}</span></div>
    <div class="kv"><b>持续天数</b><span>${dur} 天</span></div>
    <div class="kv"><b>负责人</b><span>${(ev.owners || []).length ? ev.owners.join('、') : '未指定'}</span></div>
    ${ev.desc ? `<div class="kv"><b>详细说明</b><p>${ev.desc.replace(/</g, '&lt;')}</p></div>` : ''}
  `;
  document.querySelector('#modal').hidden = false;
}

document.querySelector('#modal').addEventListener('click', (e) => {
  if (e.target.id === 'modal' || e.target.id === 'modalClose') {
    document.querySelector('#modal').hidden = true;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelector('#modal').hidden = true;
});

// 粒度切换：纯本地重绘，保持左边缘日期不跳
document.querySelector('#zoomIn').addEventListener('click', () => {
  if (levelIdx > 0) {
    levelIdx--;
    saveLevel();
    render({ anchor: 'keep' });
  }
});
document.querySelector('#zoomOut').addEventListener('click', () => {
  if (levelIdx < LEVELS.length - 1) {
    levelIdx++;
    saveLevel();
    render({ anchor: 'keep' });
  }
});

let resizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => render({ anchor: 'keep' }), 150);
});

load();
