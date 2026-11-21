# 歇会儿 Supabase 实时看板

## 启动与配置

以静态 HTTP 服务托管此目录，并打开 `index.html`（不要用 `file://` 直接打开）。生产登录请使用 HTTPS。没有 AppStudio / Eden、内部数据源或服务端 SDK。

现有 `config.json` 由维护者管理，本次未修改。使用字段：

- `supabaseUrl`: `https://ndaruhfjwhkihczgdmie.supabase.co`
- `supabasePublicKey`: Supabase publishable key，或 role=anon 的旧公开 JWT key。
- `title`: 可选页面标题。

`config.public.example.json` 是空公开 key 的参考文件，**不要覆盖已配置的 config.json**。禁止配置私密 key。旧的 `dashboardDataUrl` 和 `?data=` 参数不再生效，页面不会加载 JSON 快照、本地上传或示例数据。

## 身份与查询

保留可由 Aime UI 填写的邮箱/密码 form：`#login-email`、`#login-password`、`#login-button`。没有注册或 OTP 入口。

1. `POST /auth/v1/token?grant_type=password`，正文邮箱和密码由登录 form 提供。
2. `sessionStorage` 只持久化 access/refresh token 和到期时间；不存邮箱、密码或 Auth 用户对象。提交时立即清空密码输入框。
3. 过期前 60 秒或 RPC 返回 401 时，以 refresh token 调用 `/auth/v1/token?grant_type=refresh_token`。并发刷新合并，401 最多重试一次。
4. RPC 403 明确提示管理员白名单未授权，并保留退出入口；不展示指标或伪造 0。
5. 退出立即清空本地 token、页面指标和轮询，同时尽力撤销当前 Auth 会话；离线撤销失败不会恢复本地登录。

`POST /rest/v1/rpc/xiehuier_dashboard` 使用 `apikey: 公开key` 和 `Authorization: Bearer 用户access_token`。

正文：`days`（1..90）、`channel`（默认 appstore，可 all/development/testflight）、`platform_filter`（all/ios/macos）、`version_filter`（all/版本号）。日期、渠道、平台、版本每次变化都重新查询服务器，指标、明细和图表使用同一响应。版本下拉保留本会话已发现的版本和当前选项。

登录后每 60 秒刷新；刷新按钮显示加载态。筛选变化会取消旧请求，且使用请求序号阻止旧响应覆盖新选择。退出时也会使尚未完成的请求失效。

## 统计口径

- 只接受 canonical `meta/summary/daily/games/versions/releaseChannels/platforms/releases`。
- 今天 DAU 精确匹配 UTC 今天；不取最后一条历史记录。成功返回日历中的 0 才显示 0，缺失指标显示 `—`。
- `summary.storeProductUnits` 为 **App Store产品销量**。不使用 `estimatedDownloads`。
- `summary.storeDataThrough` 为历史销量截止日期。展示“截至 YYYY-MM-DD 的历史快照；非自动更新、非首次下载或首次激活”。截止日期缺失时如实标明；未导入销量则显示“未接入”。销量遵循后端全量汇总，不随事件日期/渠道/平台/版本筛选变化。没有硬编码销量或日期。
- 工作指标为完成次数，不计算“工作完成/启动率”。
- 小游戏完成次数 / 开始次数不是严格漏斗，跨期完成可能 >100%；开始数为 0 或指标缺失时不计算。
- 游戏名只采用 `game-names.js` 的固定映射，否则显示 raw key。当前工作区未找到原生 `ExerciseKind` 定义，映射暂为空，待提供已核验映射后补充。事件提供的 name 不作为展示名称。
- 动态文本使用 textContent 或 escapeHTML；ECharts tooltip 使用 richText 而非 HTML。分布饼图仅含平台，不合并重复的渠道人群，也不拿事件数替代 0 设备数。

## 文件职责

- `index.html` / `styles.css`: 保留既有浅色页面视觉，增加登录、退出和错误状态。
- `app.js`: 页面交互、筛选、请求竞态、轮询、图表。
- `supabase.js`: 公开配置校验、Auth、token 生命周期及 RPC fetch。
- `dashboard-data.js`: canonical 数据规范化、未知值、UTC 今天、指标语义与 HTML 转义。
- `game-names.js`: 待补齐的固定游戏名称映射。

旧 `sample-dashboard-data.json` 已删除；旧 `real-dashboard-data.json` 未删除但不再被页面读取。

## 验证

```sh
node --check analytics-dashboard/output/app.js
node --check analytics-dashboard/output/supabase.js
node --check analytics-dashboard/output/dashboard-data.js
node --check analytics-dashboard/output/game-names.js
node --check analytics-dashboard/output/tests/ui-regression.mjs
node --test analytics-dashboard/output/tests/integration.test.cjs
```

自动化单元/契约测试：14 项通过，包括 token-only 存储、并发 token 刷新、401 重试、白名单拒绝、退出竞态、全部筛选参数、UTC 日历、销量历史截止日期、>100% 比率和转义。

浏览器回归：使用 Aime 本地 Chrome 访问仅本机 HTTP 预览；隔离 iframe 内模拟 fetch，不使用真实账号。24 项通过：登录/退出、密码立即清空、60 秒轮询、全部筛选、刷新加载态、旧响应不覆盖新响应、未授权、网络失败、成功零日历、raw-key XSS、纯平台饼图以及桌面/320px 移动布局。回归脚本不由正式 index.html 加载。

本机预览确认真实 config.json 公开配置加载成功，密码登录 form 可填。后续重复浏览器回归遇到 Aime native host 超时，不能计作通过；上面 24 项为此前完整运行的通过记录，代码未因该超时变更。已关闭自建测试标签页和临时本机服务。当前依赖保留既有 CDN；Tailwind CDN 会给出既有生产使用警告，已完成运行中无本次 JS 异常。

真实管理员登录与真实 RPC 已由主流程报告成功，但本前端会话未获得真实管理员凭据，未自行重复实网登录验证；不将模拟测试冒充真实联调。待主流程提供凭据后，可用登录 form 验证手机 build5 上报的数据与销量截止日期。

本次没有修改 Supabase SQL、原生工程或 config.json，没有创建 GitHub 仓库，也没有外部或内部部署。公开发布仍需用户授权。
