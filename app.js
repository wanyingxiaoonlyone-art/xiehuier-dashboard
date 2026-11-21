'use strict';
const RANGE_OPTIONS = [1, 7, 14, 30, 90];
const CHANNELS = { appstore: 'App Store（正式）', all: '全部渠道（含测试）', development: 'Development（测试）', testflight: 'TestFlight（测试）' };
const PLATFORMS = { all: '全部平台', ios: 'iOS', macos: 'macOS' };
const ERROR_MESSAGES = {
  config: '尚未配置 Supabase 公开 key，或公开配置不正确。请联系维护者补齐配置。',
  credentials: '登录失败，请检查邮箱和密码；仅允许管理员账号登录。',
  session: '登录已过期，请重新登录。',
  forbidden: '当前账号未获看板授权。请联系管理员显式加入白名单，或退出并更换账号。',
  network: '网络连接失败或请求超时，请检查网络后重试。',
  server: '服务暂时不可用，请稍后重试。',
  response: '查询返回格式不符合约定，暂不展示指标。请联系维护者。',
  filters: '筛选参数不正确，请重新选择。',
};
const api = window.DashboardSupabase;
const model = window.DashboardData;
const state = {
  ready: false, days: 30, filters: { version: 'all', channel: 'appstore', platform: 'all' },
  charts: { daily: null, distribution: null, game: null },
  requestId: 0, controller: null, timer: null, busy: false, authId: 0,
  versions: new Set(),
};
const $ = (selector) => document.querySelector(selector);
const els = {
  title: $('#hero-title'), sourceBadge: $('#source-badge'), updatedAt: $('#updated-at'),
  metricNote: $('#metric-note'), activeFilter: $('#active-filter'), rangeGroup: $('#range-group'),
  summaryGrid: $('#summary-grid'), versionSelect: $('#version-select'), channelSelect: $('#channel-select'),
  platformSelect: $('#platform-select'), refreshButton: $('#refresh-button'),
  gamesTable: $('#games-table'), releasesList: $('#releases-list'), template: $('#summary-card-template'),
  loginForm: $('#login-form'), email: $('#login-email'), password: $('#login-password'),
  loginButton: $('#login-button'), logoutButton: $('#logout-button'), status: $('#status-message'),
};

async function boot() {
  bindEvents();
  hydrateSelect(els.channelSelect, Object.entries(CHANNELS), state.filters.channel);
  hydrateSelect(els.platformSelect, Object.entries(PLATFORMS), state.filters.platform);
  renderVersionOptions();
  renderRanges();
  clearDisplay('请登录后查看数据');
  setAuthUI();
  try {
    const response = await fetch('./config.json', { cache: 'no-store', credentials: 'omit' });
    if (!response.ok) throw new Error('config');
    const config = await response.json();
    // Ignore former snapshot/JSON URLs and URL query parameters entirely.
    api.configure(config);
    state.ready = true;
    document.title = typeof config.title === 'string' ? config.title : '歇会儿数据看板';
    setAuthUI();
    if (api.hasSession()) { startPolling(); await refreshData(); }
    else showStatus('请使用已加入白名单的管理员邮箱和密码登录。', 'info');
  } catch {
    showStatus(ERROR_MESSAGES.config, 'error');
    clearDisplay('公开配置未就绪');
    setAuthUI();
  }
  window.addEventListener('resize', () => Object.values(state.charts).forEach((chart) => chart?.resize()));
  if (window.ResizeObserver) {
    const observer = new ResizeObserver(() => Object.values(state.charts).forEach((chart) => chart?.resize()));
    ['daily-chart', 'distribution-chart', 'game-chart'].forEach((id) => observer.observe($(`#${id}`)));
  }
  window.addEventListener('pagehide', () => {
    invalidateRequest(); clearInterval(state.timer); state.timer = null;
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted && api.hasSession()) { startPolling(); refreshData(); }
  });
}

function bindEvents() {
  els.refreshButton.addEventListener('click', () => refreshData());
  els.loginForm.addEventListener('submit', login);
  els.logoutButton.addEventListener('click', () => {
    state.authId += 1;
    invalidateRequest();
    api.logout();
    stopPolling();
    state.versions.clear(); renderVersionOptions();
    els.password.value = ''; els.email.value = '';
    clearDisplay('已退出，请登录后查看数据');
    showStatus('已退出登录，当前会话已清除。', 'info');
    setAuthUI();
  });
  [[els.versionSelect, 'version'], [els.channelSelect, 'channel'], [els.platformSelect, 'platform']].forEach(([select, key]) => {
    select.addEventListener('change', () => { state.filters[key] = select.value; refreshData(); });
  });
}

async function login(event) {
  event.preventDefault();
  if (!state.ready || els.loginButton.disabled) return;
  const authId = ++state.authId;
  invalidateRequest();
  const email = els.email.value.trim();
  const password = els.password.value;
  els.password.value = '';
  els.loginButton.disabled = true;
  els.loginButton.textContent = '登录中…';
  showStatus('正在验证登录…', 'info');
  try {
    await api.login(email, password);
    if (authId !== state.authId) return;
    setAuthUI(); startPolling(); await refreshData();
  } catch (error) {
    if (authId === state.authId && error.kind !== 'cancelled') {
      showStatus(ERROR_MESSAGES[error.kind] || ERROR_MESSAGES.server, 'error');
      clearDisplay('登录未完成');
    }
  } finally {
    if (authId === state.authId) { els.loginButton.textContent = '登录'; setAuthUI(); }
  }
}

function setAuthUI() {
  const loggedIn = api.hasSession();
  els.loginForm.hidden = loggedIn;
  els.logoutButton.hidden = !loggedIn;
  els.loginButton.disabled = !state.ready;
  els.refreshButton.disabled = !state.ready || !loggedIn || state.busy;
  els.versionSelect.disabled = !loggedIn;
  els.channelSelect.disabled = !loggedIn;
  els.platformSelect.disabled = !loggedIn;
  els.rangeGroup.querySelectorAll('button').forEach((button) => { button.disabled = !loggedIn; });
}

function startPolling() {
  stopPolling();
  state.timer = setInterval(() => { if (!state.busy && api.hasSession()) refreshData(); }, 60000);
}
function stopPolling() { clearInterval(state.timer); state.timer = null; }
function invalidateRequest() {
  state.requestId += 1;
  state.controller?.abort(); state.controller = null;
  state.busy = false;
  els.refreshButton.setAttribute('aria-busy', 'false');
  els.refreshButton.querySelector('.refresh-label').textContent = '刷新数据';
}

async function refreshData() {
  if (!state.ready || !api.hasSession()) return;
  invalidateRequest();
  const id = state.requestId;
  const controller = new AbortController(); state.controller = controller;
  const filters = { days: state.days, ...state.filters };
  state.busy = true;
  els.refreshButton.setAttribute('aria-busy', 'true');
  els.refreshButton.querySelector('.refresh-label').textContent = '查询中…';
  setAuthUI();
  clearDisplay('正在查询…');
  showStatus('正在查询当前筛选的数据…', 'info');
  try {
    const raw = await api.dashboard(filters, controller.signal);
    if (id !== state.requestId) return;
    let data;
    try { data = model.normalize(raw); } catch { throw new api.ApiError('response'); }
    data.versions.forEach((item) => { if (typeof item.value === 'string' && item.value.length <= 32 && item.value) state.versions.add(item.value); });
    renderVersionOptions();
    renderDashboard(model.view(data, filters.days));
    showStatus(data.daily.every((day) => day.dau === 0) ? '查询成功：当前筛选暂无活跃事件。每 60 秒刷新。' : '查询成功，每 60 秒自动刷新。', 'info');
  } catch (error) {
    if (id !== state.requestId || error.kind === 'cancelled') return;
    if (error.kind === 'session') { api.logout(); stopPolling(); }
    clearDisplay(error.kind === 'forbidden' ? '未获授权' : '数据不可用');
    showStatus(ERROR_MESSAGES[error.kind] || ERROR_MESSAGES.server, 'error');
  } finally {
    if (id === state.requestId) {
      state.busy = false; state.controller = null;
      els.refreshButton.setAttribute('aria-busy', 'false');
      els.refreshButton.querySelector('.refresh-label').textContent = '刷新数据';
      setAuthUI();
    }
  }
}

function showStatus(message, tone) {
  els.status.textContent = message;
  els.status.className = `status-message ${tone}`;
  els.status.setAttribute('role', tone === 'error' ? 'alert' : 'status');
}
function hydrateSelect(select, entries, selected) {
  select.replaceChildren();
  entries.forEach(([value, label]) => {
    const option = document.createElement('option'); option.value = value; option.textContent = label;
    select.appendChild(option);
  });
  select.value = selected;
}
function renderVersionOptions() {
  const selected = state.filters.version;
  if (selected !== 'all') state.versions.add(selected);
  hydrateSelect(els.versionSelect, [['all', '全部版本'], ...[...state.versions].sort().map((value) => [value, value])], selected);
}
function renderRanges() {
  els.rangeGroup.replaceChildren();
  RANGE_OPTIONS.forEach((days) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `range-chip${state.days === days ? ' active' : ''}`;
    button.textContent = `最近 ${days} 天`; button.setAttribute('aria-pressed', String(state.days === days));
    button.addEventListener('click', () => { state.days = days; renderRanges(); refreshData(); });
    els.rangeGroup.appendChild(button);
  });
  setAuthUI();
}
function filterLabel() {
  return `最近 ${state.days} 天 / ${state.filters.version === 'all' ? '全部版本' : state.filters.version} / ${CHANNELS[state.filters.channel]} / ${PLATFORMS[state.filters.platform]}`;
}
function clearDisplay(message) {
  els.sourceBadge.textContent = message;
  els.updatedAt.textContent = '—';
  els.activeFilter.textContent = filterLabel();
  renderSummary(['App Store产品销量', '今日日活（DAU）', '启动次数', '工作完成次数'].map((label) => ({ label, value: '—', subtitle: message, icon: 'monitoring' })));
  Object.entries(state.charts).forEach(([key, chart]) => { chart?.dispose(); state.charts[key] = null; });
  ['daily-chart', 'distribution-chart', 'game-chart'].forEach((id) => {
    const element = document.createElement('div'); element.className = 'empty-state h-full'; element.textContent = message;
    $(`#${id}`).replaceChildren(element);
  });
  els.gamesTable.innerHTML = `<tr><td colspan="4" class="px-4 py-8 text-center text-sm text-slate-500">${model.escapeHTML(message)}</td></tr>`;
  els.releasesList.textContent = message;
}
function renderDashboard(data) {
  els.title.textContent = '歇会儿 App 数据看板';
  els.sourceBadge.textContent = 'Supabase 实时查询';
  els.updatedAt.textContent = formatDateTime(data.meta.updatedAt);
  els.metricNote.textContent = 'UTC 日历；DAU 为匿名安装设备数，测试与正式渠道独立筛选。商店产品销量单独统计。';
  els.activeFilter.textContent = filterLabel();
  renderSummary(data.summaryCards); renderGames(data.games); renderReleases(data.releases);
  if (!window.echarts) {
    ['daily-chart', 'distribution-chart', 'game-chart'].forEach((id) => { $(`#${id}`).textContent = '图表库未加载，指标与明细仍可查看。'; });
    return;
  }
  renderDailyChart(data); renderDistributionChart(data); renderGameChart(data.games);
}
function renderSummary(cards) {
  els.summaryGrid.replaceChildren();
  cards.forEach((card) => {
    const fragment = els.template.content.cloneNode(true);
    fragment.querySelector('.summary-label').textContent = card.label;
    fragment.querySelector('.summary-value').textContent = card.value;
    fragment.querySelector('.summary-subtitle').textContent = card.subtitle;
    const icon = document.createElement('span'); icon.className = 'material-symbols-outlined'; icon.textContent = card.icon;
    fragment.querySelector('.summary-icon').appendChild(icon);
    els.summaryGrid.appendChild(fragment);
  });
}
function renderGames(games) {
  els.gamesTable.replaceChildren();
  if (!games.length) {
    els.gamesTable.innerHTML = '<tr><td colspan="4" class="px-4 py-8 text-center text-sm text-slate-500">当前筛选没有小游戏事件</td></tr>';
    return;
  }
  games.forEach((game) => {
    const row = document.createElement('tr');
    row.innerHTML = `<td class="px-4 py-4 font-semibold text-slate-900">${model.escapeHTML(game.name)}</td>
      <td class="px-4 py-4">${model.format(game.started)}</td><td class="px-4 py-4">${model.format(game.completed)}</td>
      <td class="px-4 py-4"><span class="table-badge normal">${game.completionRate === null ? '—' : `${game.completionRate.toFixed(1)}%`}</span></td>`;
    els.gamesTable.appendChild(row);
  });
}
function renderReleases(releases) {
  els.releasesList.replaceChildren();
  if (!releases.length) { els.releasesList.textContent = '当前筛选条件下没有版本动态'; return; }
  releases.slice(0, 8).forEach((item) => {
    const card = document.createElement('div'); card.className = 'release-item';
    card.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3"><div>
      <div class="text-base font-bold text-slate-900">${model.escapeHTML(item.appVersion)}</div>
      <div class="mt-1 text-sm text-slate-500">${model.escapeHTML(CHANNELS[item.releaseChannel] || item.releaseChannel)} / ${model.escapeHTML(item.platform)}</div>
      </div><span class="metric-pill">${model.format(item.users)} 设备</span></div>
      <div class="mt-4 grid grid-cols-2 gap-3 text-sm text-slate-600">
      <div class="rounded-2xl bg-white px-3 py-3"><div class="text-slate-400">最近上报（UTC）</div><div class="mt-1 font-semibold text-slate-900">${model.escapeHTML(formatDateTime(item.lastSeenAt))}</div></div>
      <div class="rounded-2xl bg-white px-3 py-3"><div class="text-slate-400">事件总数</div><div class="mt-1 font-semibold text-slate-900">${model.format(item.events)}</div></div></div>`;
    els.releasesList.appendChild(card);
  });
}
function chart(name, id) {
  const element = $(`#${id}`); element.replaceChildren();
  if (!state.charts[name]) state.charts[name] = window.echarts.init(element);
  return state.charts[name];
}
function chartEmpty(name, id, message) {
  state.charts[name]?.dispose(); state.charts[name] = null;
  const empty = document.createElement('div'); empty.className = 'empty-state h-full'; empty.textContent = message;
  $(`#${id}`).replaceChildren(empty);
}
function renderDailyChart(data) {
  if (!data.daily.length) { chartEmpty('daily', 'daily-chart', '查询成功，但未返回日历数据'); return; }
  chart('daily', 'daily-chart').setOption({
    animationDuration: 500, color: ['#2563eb', '#60a5fa', '#f59e0b'],
    tooltip: { trigger: 'axis', renderMode: 'richText' },
    grid: { top: 36, left: 12, right: 12, bottom: 12, containLabel: true },
    legend: { top: 0, textStyle: { color: '#64748b' } },
    xAxis: { type: 'category', data: data.daily.map((item) => item.date), axisLine: { lineStyle: { color: '#cbd5e1' } }, axisLabel: { color: '#64748b' } },
    yAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } }, axisLabel: { color: '#64748b' } },
    series: [
      { name: 'DAU', type: 'line', smooth: true, data: data.daily.map((item) => item.dau), areaStyle: { color: 'rgba(37,99,235,0.12)' }, lineStyle: { width: 3 }, symbolSize: 8 },
      { name: '启动次数', type: 'bar', barMaxWidth: 18, data: data.daily.map((item) => item.launches) },
      { name: '工作完成次数', type: 'line', smooth: true, data: data.daily.map((item) => item.workCompleted), lineStyle: { width: 2 }, symbolSize: 6 },
    ],
  }, true);
}
function renderDistributionChart(data) {
  // Never combine overlapping channel and platform populations; zero stays zero, no uses fallback.
  const platforms = data.platforms.filter((item) => item.users !== null && item.users > 0)
    .map((item) => ({ name: PLATFORMS[item.value] || item.value, value: item.users }));
  if (!platforms.length) { chartEmpty('distribution', 'distribution-chart', '当前筛选没有可展示的平台设备分布'); return; }
  chart('distribution', 'distribution-chart').setOption({
    animationDuration: 500, tooltip: { trigger: 'item', renderMode: 'richText' },
    legend: { bottom: 0, textStyle: { color: '#64748b' } },
    series: [{ type: 'pie', radius: ['42%', '72%'], center: ['50%', '42%'], padAngle: 3,
      itemStyle: { borderRadius: 12, borderColor: '#fff', borderWidth: 3 },
      label: { color: '#334155', formatter: '{b}\n{d}%' }, data: platforms }],
  }, true);
}
function renderGameChart(games) {
  if (!games.length) { chartEmpty('game', 'game-chart', '当前筛选没有小游戏事件'); return; }
  chart('game', 'game-chart').setOption({
    animationDuration: 500, color: ['#2563eb', '#38bdf8'],
    tooltip: { trigger: 'axis', renderMode: 'richText', axisPointer: { type: 'shadow' } },
    legend: { top: 0, textStyle: { color: '#64748b' } },
    grid: { top: 36, left: 12, right: 12, bottom: 12, containLabel: true },
    xAxis: { type: 'value', splitLine: { lineStyle: { color: 'rgba(148,163,184,0.18)' } }, axisLabel: { color: '#64748b' } },
    yAxis: { type: 'category', data: games.map((item) => item.name), axisLabel: { color: '#475569', width: 100, overflow: 'truncate' }, axisLine: { show: false }, axisTick: { show: false } },
    series: [
      { name: '开始次数', type: 'bar', barMaxWidth: 18, data: games.map((item) => item.started), itemStyle: { borderRadius: [0, 8, 8, 0] } },
      { name: '完成次数', type: 'bar', barMaxWidth: 18, data: games.map((item) => item.completed), itemStyle: { borderRadius: [0, 8, 8, 0] } },
    ],
  }, true);
}
function formatDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '—';
  return new Intl.DateTimeFormat('zh-CN', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).format(date);
}
boot();
