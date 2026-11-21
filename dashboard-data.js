'use strict';
window.DashboardData = (() => {
  function metric(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  function normalize(raw) {
    if (!raw || typeof raw.meta !== 'object' || !raw.meta || !raw.summary ||
        !['daily', 'games', 'versions', 'releaseChannels', 'platforms', 'releases'].every((key) => Array.isArray(raw[key]))) {
      throw new Error('Invalid canonical RPC response');
    }
    return {
      meta: raw.meta,
      summary: {
        ...Object.fromEntries(['storeProductUnits', 'launches', 'activeDevices', 'workCompleted', 'breakCompleted']
          .map((key) => [key, metric(raw.summary[key])])),
        storeDataThrough: typeof raw.summary.storeDataThrough === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.summary.storeDataThrough)
          ? raw.summary.storeDataThrough : null,
      },
      daily: raw.daily.map((item) => ({
        date: String(item.date), dau: metric(item.dau), launches: metric(item.launches),
        workCompleted: metric(item.workCompleted), breakCompleted: metric(item.breakCompleted),
      })),
      games: raw.games.map((item) => {
        const key = String(item.key ?? 'unknown');
        const names = window.DashboardGameNames || {};
        return {
          key, name: Object.hasOwn(names, key) ? names[key] : key,
          started: metric(item.started), completed: metric(item.completed), users: metric(item.users),
        };
      }),
      versions: raw.versions, releaseChannels: raw.releaseChannels,
      platforms: raw.platforms.map((item) => ({ value: String(item.value), users: metric(item.users), uses: metric(item.uses) })),
      releases: raw.releases.map((item) => ({
        appVersion: String(item.app_version ?? 'unknown'), releaseChannel: String(item.release_channel ?? 'unknown'),
        platform: String(item.platform ?? 'unknown'), lastSeenAt: item.last_seen_at,
        users: metric(item.users), events: metric(item.events),
      })),
    };
  }
  function view(data, days, now = new Date()) {
    const today = now.toISOString().slice(0, 10);
    const todayRow = data.daily.find((item) => item.date === today);
    // The SQL calendar contains UTC today even for a successful zero-event query.
    // Missing calendar rows are unknown, never the last recorded day's DAU or an invented zero.
    const dau = todayRow?.dau ?? null;
    const games = data.games.map((item) => ({
      ...item,
      completionRate: item.started !== null && item.started > 0 && item.completed !== null
        ? Math.round(item.completed / item.started * 1000) / 10 : null,
    })).sort((a, b) => (b.started ?? -1) - (a.started ?? -1));
    return {
      ...data, games,
      summaryCards: [
        { label: 'App Store产品销量', value: format(data.summary.storeProductUnits, '未接入'),
          subtitle: `${data.summary.storeDataThrough ? `截至 ${data.summary.storeDataThrough}` : '截止日期未提供'}的历史快照；非自动更新、非首次下载或首次激活。全量累计，不随事件筛选变化。`, icon: 'storefront' },
        { label: '今日日活（DAU）', value: format(dau),
          subtitle: `${today}（UTC）的匿名安装设备数。`, icon: 'stacked_line_chart' },
        { label: '启动次数', value: format(data.summary.launches),
          subtitle: `最近 ${days} 天、当前筛选内的 app_opened 次数。`, icon: 'play_circle' },
        { label: '工作完成次数', value: format(data.summary.workCompleted),
          subtitle: `最近 ${days} 天、当前筛选内的 work_completed 次数。`, icon: 'sports_score' },
      ],
    };
  }
  function format(value, fallback = '—') {
    return metric(value) === null ? fallback : new Intl.NumberFormat('zh-CN').format(value);
  }
  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  return { normalize, view, format, escapeHTML };
})();
