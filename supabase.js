/* Only the public Supabase key belongs in the browser. No SDK or private backend. */
'use strict';
window.DashboardSupabase = (() => {
  const SUPABASE_URL = 'https://ndaruhfjwhkihczgdmie.supabase.co';
  const STORAGE_KEY = 'xiehuier.auth.tokens';
  class ApiError extends Error {
    constructor(kind, status = 0) { super(kind); this.kind = kind; this.status = status; }
  }
  let publicKey = '';
  let session = null;
  let epoch = 0;
  let refreshing = null;

  function configure(config) {
    if (config.supabaseUrl && config.supabaseUrl.replace(/\/$/, '') !== SUPABASE_URL) {
      throw new ApiError('config');
    }
    const key = config.supabasePublicKey || '';
    // Accept publishable keys or legacy JWTs whose role is explicitly anon.
    let valid = typeof key === 'string' && key.startsWith('sb_publishable_');
    if (typeof key === 'string' && key.split('.').length === 3) {
      try {
        const payload = key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        valid = JSON.parse(atob(payload)).role === 'anon';
      } catch { valid = false; }
    }
    if (!valid) throw new ApiError('config');
    publicKey = key;
    try {
      const saved = JSON.parse(sessionStorage.getItem(STORAGE_KEY));
      if (saved?.access_token && saved?.refresh_token && Number.isFinite(saved.expires_at)) {
        session = { access_token: saved.access_token, refresh_token: saved.refresh_token, expires_at: saved.expires_at };
      }
    } catch { session = null; }
  }

  function storeTokens(data, expectedEpoch) {
    if (expectedEpoch !== epoch) throw new ApiError('cancelled');
    if (!data?.access_token || !data?.refresh_token || !Number.isFinite(Number(data.expires_in))) {
      throw new ApiError('response');
    }
    session = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Number(data.expires_at) || Math.floor(Date.now() / 1000) + Number(data.expires_in),
    };
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session)); } catch { /* memory-only session */ }
  }

  function clear() {
    epoch += 1;
    session = null;
    refreshing = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage may be disabled */ }
  }

  async function request(path, body, token, signal) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    if (signal?.aborted) throw new ApiError('cancelled');
    signal?.addEventListener('abort', cancel, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 20000);
    try {
      const headers = { apikey: publicKey, 'Content-Type': 'application/json' };
      if (token) headers.Authorization = `Bearer ${token}`;
      const response = await fetch(`${SUPABASE_URL}${path}`, {
        method: 'POST', headers, body: JSON.stringify(body), signal: controller.signal,
        cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer',
      });
      if (!response.ok) {
        // Never render server error bodies, which may contain sensitive details.
        throw new ApiError(response.status === 401 ? 'session' : response.status === 403 ? 'forbidden' : 'server', response.status);
      }
      try { return await response.json(); } catch { throw new ApiError('response'); }
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (controller.signal.aborted) throw new ApiError(timedOut ? 'network' : 'cancelled');
      throw new ApiError('network');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
    }
  }

  async function login(email, password) {
    clear();
    const currentEpoch = epoch;
    try {
      const data = await request('/auth/v1/token?grant_type=password', { email, password });
      storeTokens(data, currentEpoch);
    } catch (error) {
      if (currentEpoch !== epoch) throw new ApiError('cancelled');
      if ([400, 401, 422].includes(error.status)) throw new ApiError('credentials');
      throw error;
    }
  }

  async function refresh() {
    if (!session) throw new ApiError('session');
    if (refreshing) return refreshing;
    const currentEpoch = epoch;
    const refreshToken = session.refresh_token;
    const pending = (async () => {
      try {
        const data = await request('/auth/v1/token?grant_type=refresh_token', { refresh_token: refreshToken });
        storeTokens(data, currentEpoch);
      } catch (error) {
        if (currentEpoch !== epoch) throw new ApiError('cancelled');
        if ([400, 401, 403, 422].includes(error.status)) { clear(); throw new ApiError('session'); }
        throw error;
      }
    })();
    refreshing = pending;
    try { await pending; } finally { if (refreshing === pending) refreshing = null; }
  }

  async function dashboard(filters, signal) {
    const currentEpoch = epoch;
    if (!session) throw new ApiError('session');
    if (session.expires_at <= Date.now() / 1000 + 60) await refresh();
    if (currentEpoch !== epoch || signal?.aborted) throw new ApiError('cancelled');
    const body = {
      days: filters.days, channel: filters.channel,
      platform_filter: filters.platform, version_filter: filters.version,
    };
    if (!Number.isInteger(body.days) || body.days < 1 || body.days > 90 ||
        !['all', 'appstore', 'development', 'testflight'].includes(body.channel) ||
        !['all', 'ios', 'macos'].includes(body.platform_filter) ||
        typeof body.version_filter !== 'string' || !body.version_filter.length || body.version_filter.length > 32) {
      throw new ApiError('filters');
    }
    try {
      return await request('/rest/v1/rpc/xiehuier_dashboard', body, session.access_token, signal);
    } catch (error) {
      if (error.status !== 401) throw error;
      if (currentEpoch !== epoch || signal?.aborted) throw new ApiError('cancelled');
      await refresh();
      if (currentEpoch !== epoch || signal?.aborted) throw new ApiError('cancelled');
      try { return await request('/rest/v1/rpc/xiehuier_dashboard', body, session.access_token, signal); }
      catch (retryError) {
        if (retryError.status === 401 && currentEpoch === epoch) { clear(); throw new ApiError('session'); }
        throw retryError;
      }
    }
  }

  function logout() {
    const token = session?.access_token;
    clear();
    if (token) {
      // Local clearing is immediate even when offline; never restore on revoke failure.
      fetch(`${SUPABASE_URL}/auth/v1/logout?scope=local`, {
        method: 'POST', headers: { apikey: publicKey, Authorization: `Bearer ${token}` },
        credentials: 'omit', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(10000),
      }).catch(() => {});
    }
  }
  return { configure, login, dashboard, logout, hasSession: () => Boolean(session), ApiError };
})();
