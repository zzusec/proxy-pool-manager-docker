# Proxy Pool Manager (Docker Version)

代理池管理系统 — Docker/Node.js 版本，从 Cloudflare Worker 迁移而来。

## 功能

- 📥 批量导入代理（支持多种格式）
- 🔗 订阅链接解析（Base64 编码、Clash YAML）
- 📰 Linux.do 公共 RSS 采集（自动提取帖子里的代理并进入导入队列）
- 🏷️ 自动 IP 分类（住宅/数据中心/移动，支持本地 GeoLite ASN 数据库 + testisp.info）
- 🌍 国家/地区自动识别（GeoLite Country/City 本地库优先，远程服务兜底）
- 💓 内置存活检测（HTTP/SOCKS5；3 个独立出口 IP 目标都明确失败才标记失效）
- 🎯 按当前筛选结果后台批量检测（跨页快照，单次最多 1000 个）
- 🗂️ 代理业务分组（例如 `paid-residential-us`，可用于导入、管理和 API 筛选）
- 🔌 对外 API（按类型/国家/分组/协议/存活状态/标签查询）
- ⏰ 可配置的自动分类和检测策略
- 🎨 暗色模式和可配置主体颜色

## 支持的代理协议

| 协议 | URI 格式 | Clash YAML |
|------|----------|------------|
| HTTP/SOCKS5 | ✅ | ✅ |
| Hysteria2 | ✅ | ✅ |
| VLESS | ✅ | ✅ |
| VMess | ✅ | ✅ |
| Trojan | ✅ | ✅ |
| Shadowsocks | ✅ | ✅ |

## 与 CF Worker 版本的区别

| 特性 | CF Worker | Docker 版本 |
|------|-----------|-------------|
| 存储 | KV | SQLite |
| 代理检测 | 需外部 tester | 内置支持 |
| 执行时间限制 | 有 | 无 |
| KV subrequest 限制 | 有 | 无 |

## 快速部署

```bash
# 1. 克隆仓库
git clone https://github.com/zzusec/proxy-pool-manager-docker.git
cd proxy-pool-manager-docker

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 设置密码和密钥

# 3. 启动
docker compose up --build -d
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `PORT` | 服务端口 | `3000` |
| `ADMIN_USERNAME` | 管理员用户名 | `admin` |
| `ADMIN_PASSWORD` | 管理员密码 | `change-me` |
| `SESSION_SECRET` | Session 密钥（≥32字符） | - |
| `IPINFO_TOKEN` | ipinfo.io API token | - |
| `API_KEY` | 外部 API 访问密钥 | - |
| `TESTER_URL` | 外部测试服务 URL（可选） | - |
| `CRON_SCHEDULE` | Cron 调度 | `*/10 * * * *` |

## 批量检测（耐久任务）

代理列表页有三个语义不同的检测入口，全部写入数据库中的耐久任务（`test_jobs` / `test_job_items`），关闭页面或重启容器都会继续跑完：

| 入口 | 范围 | 上限 |
|------|------|------|
| 检测当前筛选结果 | 服务器按当前筛选条件（类型/国家/分组/协议/状态/搜索）跨所有分页取 ID | 1000 |
| 检测全部未检测 | 从未检测过的代理 | 1000 |
| 勾选行 → 检测 | 当前勾选的代理 | 1000 |

- 切到「失效」标签（`alive=false`）时，第一个按钮会变成「复测失效代理」，用于一次性重测失效池。
- 任务创建时会把 ID 冻结成快照，之后不再按筛选条件重新查询；翻页、状态变化或新导入的数据都不会改变已创建任务的成员。
- 超过 1000 条时接口返回 `truncated: true`，并按稳定排序（`created_at DESC, id DESC`）只检测前 1000 个，剩余部分再点一次即可继续。
- 检测规则不变：3 个独立目标都是明确的代理级失败才会写入 `alive=false`；网络或目标本身异常记为不确定，保留原有状态等待复测。

## Linux.do 公共 RSS 采集

在「导入」页的 **Linux.do 公共 RSS 来源** 卡片中添加 RSS 地址，系统会定期读取公开 RSS，从帖子正文里提取代理并交给已有的耐久导入队列。

**只读取公开 RSS，不需要也不支持论坛登录、Cookie、账号密码或浏览器自动化**，因此不会存储任何 Linux.do 凭据。

支持的地址（其余一律拒绝）：

```text
https://linux.do/latest.rss        # 最新主题
https://linux.do/posts.rss         # 最新回复
https://linux.do/top.rss           # 热门主题
https://linux.do/t/topic/<ID>.rss  # 指定话题
https://linux.do/c/<分类>/<ID>.rss  # 分类
https://linux.do/tag/<标签>.rss     # 标签
```

添加来源时**可以直接粘贴浏览器地址栏里的论坛链接**，系统会转成上表中对应的 `.rss`：

| 粘贴 | 实际订阅 |
|------|----------|
| `https://linux.do/t/免费代理分享/123456` | `https://linux.do/t/topic/123456.rss` |
| `https://linux.do/t/免费代理分享/123456/7`（楼层链接） | 同上（楼层号不会被当成话题 ID） |
| `https://linux.do/t/slug/123456?u=someone`、`...#post_7` | 同上（分享参数和锚点被丢弃） |
| `https://linux.do/c/develop/4/l/latest` | `https://linux.do/c/develop/4.rss` |
| `https://linux.do/tag/代理` | `https://linux.do/tag/%E4%BB%A3%E7%90%86.rss` |

这层改写只作用于「添加来源」，抓取时和每次重定向仍走严格校验，所以它不会放宽抓取器允许请求的范围；非 linux.do 域名、HTTP、带端口或凭据的地址改写后照样被拒。

行为与限制：

- 每个来源可单独设置导入分组、默认协议（无协议前缀的 `ip:port` 按此协议入库）、跳过重复、自动分类、轮询间隔（15–1440 分钟）和启用状态；最多配置 20 个来源，同时最多 2 个来源并发抓取。
- 来源地址创建后不可修改（ETag 与已读帖子状态与地址绑定），换地址请删除后重新添加。
- 抓取使用 `If-None-Match` / `If-Modified-Since` 条件请求，`304` 记为「没有新内容」；连续失败会指数退避。`403`/`503` 记为 Cloudflare 拦截，`429` 记为限流，都会按退避自动重试。
- 请求走 HTTP/2（undici dispatcher，`allowH2`）。linux.do 前面的 Cloudflare 会给 HTTP/1.1 客户端返回「Just a moment...」人机验证页并以 403 结束，而 Node 内置 `fetch` 只支持 HTTP/1.1，所以这里不能用它。
- 帖子按 GUID 去重，内容哈希未变不会重复入队；未发现代理的帖子记为「未发现代理」；导入失败的帖子下次仍会重试。
- 只提取合法的 HTTP/HTTPS/SOCKS5 `ip:port`（含可选认证），按协议/IP/端口/认证去重，最终仍由既有解析器和唯一索引兜底。
- **只接受公网地址**：正文里的回环/内网地址（`127.0.0.0/8`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`100.64/10` 等）会被丢弃。论坛正文经常出现「配置 proxy 为 `127.0.0.1:8999`」这类说明，导入它们不但没用，还会让检测器去连本机和内网端口。手工粘贴导入不受此限制（内网代理是运维自己的选择）。
- 代理行会记录来源（`source=rss:linux.do`）和来源帖子链接，导入历史里显示为 `Linux.do RSS`。
- 安全边界：仅允许 `https://linux.do` 默认端口、无凭据/无参数的白名单路径；首次请求和每次重定向都重新校验域名并拒绝解析到内网/保留地址；最多 3 次重定向、15 秒超时、5MB 响应上限；不发送 Cookie；含 `DOCTYPE`/`ENTITY` 的 XML 直接拒绝；脚本/样式内容在提取前被移除。
- RSS 管理接口位于需要登录的内部 `/api/rss/*`，对外 `/api/v1` **不暴露** 来源配置、帖子内容或任何凭据。

### 选哪个源（2026-07 实测）

帖子正文是 CDATA 包裹的完整 HTML，`<pre>` / `<code>` 都在，所以代码块里的代理列表能正常提取；`/t/topic/<ID>.rss` 返回**全部楼层**，不只是首帖。真正的限制是各个源的时间窗口：

| 源 | 30/50 条覆盖的时间跨度 | 小时轮询覆盖率 | 适用性 |
|----|------------------------|----------------|--------|
| `/t/topic/<ID>.rss` | 整个话题（全部楼层） | 100% | ✅ 首选，盯住已知的代理分享帖 |
| `tag/<标签>.rss` | 2 年以上 | 100% | ✅ 适合追踪某类帖子 |
| `top.rss` | 数月 | 100% | ⚠️ 热帖，很少有代理列表 |
| `latest.rss` | **约 34 分钟** | ~50% | ❌ 论坛太活跃，追不上 |
| `posts.rss` | **约 4 分钟** | ~7% | ❌ 同上，更严重 |

因此**用具体帖子或标签作为来源**，不要指望全站源大海捞针。匿名状态下 `search.json` 和 `/categories` 都返回 403（Cloudflare 人机验证），所以无法自动搜索「发代理的帖子」——发现帖子这一步得人工完成，之后交给帖子源持续跟进即可。

## 外部 API

```bash
# 查询代理列表
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies?type=residential&country=US&alive=true"

# 随机获取代理
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies/random?type=residential"

# 统计数量
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies/count"

# 获取可直接使用的代理文本（一行一个，包含认证信息）
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies/random?alive=true&format=text"

# 获取付费美国住宅代理（最多 1000 条）
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies?group=paid-residential-us&type=residential&country=US&alive=true&limit=1000&format=text"
```

`/api/v1/proxies`、`/api/v1/proxies/random` 和 `/api/v1/proxies/count` 支持可组合筛选：`type=residential|datacenter|mobile`、`country=US`（两位国家代码）、`group=paid-residential-us`、`protocol=http|https|socks5`、`alive=true|false|null`，以及可选 `tag`。列表端点每页最多 1000 条；JSON 默认返回分组与标签但不返回认证信息，`format=text` 返回标准 `protocol://user:password@ip:port` 文本。所有对外 API 都必须带 `Authorization: Bearer <API_KEY>`。

## License

MIT
