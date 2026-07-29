# Proxy Pool Manager (Docker Version)

代理池管理系统 — Docker/Node.js 版本，从 Cloudflare Worker 迁移而来。

## 功能

- 📥 批量导入代理（支持多种格式）
- 🔗 订阅链接解析（Base64 编码、Clash YAML）
- 🏷️ 机房 IP / ISP 住宅 IP 判定统一以 ipdata.co 为准（asn.type + company.type，双 ISP 即住宅），未配置 Key 时才回退 testisp.info / ispinfo.io，本地 GeoLite 关键词推断只作最后兜底
- 🌍 国家/地区自动识别（GeoLite Country/City 本地库优先，远程服务兜底）
- 💓 内置存活检测（HTTP/SOCKS5 直连，其余协议经 sing-box 隧道；判定结论和失败原因都会落库）
- 🔁 sticky / rotating 代理类型识别（按出口 IP 历史自动判定，也可手动标注）
- 🎯 按当前筛选结果后台批量检测（跨页快照，单次最多 1000 个）
- 🗂️ 代理业务分组（例如 `paid-residential-us`，可用于导入、管理和 API 筛选）
- 🔌 对外 API（按国家/IP 类型/代理类型/分组/协议/存活状态/标签查询，含 sticky 会话接口）
- 🧩 设置页接口生成器：选好条件直接生成可复制的 API 地址
- ⏰ 可配置的自动分类和检测策略
- 🌙 暗色模式

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
| `IPDATA_API_KEY` | ipdata.co API Key，机房/ISP 判定来源（免费额度 1500 次/天）；也可在设置页填写，设置页优先 | - |
| `IPINFO_TOKEN` | ipinfo.io API token | - |
| `ISPINFO_API_URL` | 通过代理出口调用的 ISPInfo 接口 | `https://ispinfo.io/api/ip` |
| `ISPINFO_TIMEOUT` | ISPInfo 单代理查询超时（毫秒） | 跟随 `testTimeout` |
| `API_KEY` | 外部 API 访问密钥 | - |
| `TESTER_URL` | 外部测试服务 URL（可选） | - |
| `CRON_SCHEDULE` | Cron 调度 | `*/10 * * * *` |

## IP 类型判定（机房 vs ISP 住宅）

判定链路只认 ipdata.co，规则按顺序生效：

1. `asn.type` 与 `company.type` **同为 `isp`** → 住宅（双 ISP，置信度最高）
2. 任一为 `hosting`，或 `threat.is_datacenter` 为真 → 机房
3. 任一为 `isp` → 住宅（单边命中，置信度中）
4. 任一为 `business` / `education` / `government` / `banking` / `military` / `cdn` → 机房
5. 都取不到 → 保持"待分类"，不猜

要点：

- 「刷新 IP 类型」走 ipdata 批量接口（每次最多 100 个 IP），全库体检则按**实测出口 IP** 单个查询，失效且会被自动删除的代理直接跳过，不浪费额度。
- 结果缓存 6 小时；返回 403/429 时进入 10 分钟冷却，避免把当天额度打满。
- ipdata 把移动运营商也归为 `isp`：只有 ispinfo 在出口侧识别出移动网络时才标记为「移动」。
- 列表里 IP 类型徽标悬停可以看到判定来源和原始 `asn.type` / `company.type` 证据。
- 未配置 Key 时系统不会中断，只是回退到旧链路（testisp.info → ispinfo.io → GeoLite 关键词），此时精度明显下降。
- 设置页「IP 分类」可以直接填 Key 并做一次测试查询，保存后立即生效，无需重启。

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

### 存活判定规则

检测目标默认走 HTTPS（`api.ipify.org` / `ipinfo.io` / `icanhazip.com`），与真实使用方式一致；判定顺序如下，尽量不留「不确定」：

| 结论 | `last_test_outcome` | 触发条件 |
|------|---------------------|----------|
| 存活 | `alive` | 任一目标返回 2xx 且解析出出口 IP |
| 存活 | `alive_no_exit_ip` | 代理成功转发、目标有 HTTP 响应但没吐出口 IP（限流、拦截页、非 JSON） |
| 失效 | `dead` | 3 个目标全部在连接层失败；或 sing-box 隧道起不来且节点端口 TCP 不可达 |
| 失效 | `tunnel_error` | 节点端口能连上，但 sing-box 建不起隧道（配置不被支持），在本系统里同样不可用 |
| 无法检测 | `unsupported_protocol` | 检测器不支持该协议（例如 tuic），不会给出存活结论 |

- 除了协议本身不支持，检测一定会给出存活或失效的明确结论，不存在「结果不确定，保留原状态」这一档。
- 每次检测都会写 `last_test_outcome` 和 `last_test_error`，界面上鼠标悬停状态徽标即可看到具体原因。
- sing-box 的 stderr 会被捕获，配置被拒绝时能直接看到它的原始报错。

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

# sticky：同一 session 在有效期内固定同一个出口（最长 120 分钟）
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies/sticky?country=US&type=residential&session=order-8812&ttl=30"
```

`/api/v1/proxies`、`/api/v1/proxies/random`、`/api/v1/proxies/sticky` 和 `/api/v1/proxies/count` 支持可组合筛选：`type=residential|datacenter|mobile`、`country=US`（两位国家代码）、`rotation=sticky|rotating`、`group=paid-residential-us`、`protocol=http|https|socks5`、`alive=true|false|null`，以及可选 `tag`。留空的参数（如 `?country=`）视为不筛选。列表端点每页最多 1000 条；JSON 默认返回分组、标签和 `rotation` 但不返回认证信息，`format=text` 返回标准 `protocol://user:password@ip:port` 文本。所有对外 API 都必须带 `Authorization: Bearer <API_KEY>` 或 `?key=<API_KEY>`。

设置页的 **接口生成器** 可以按国家 / IP 类型 / 代理类型（sticky、rotating）等条件直接生成上述地址，复制即可使用。

### sticky 与 rotating

| 代理类型 | 含义 | 取用方式 |
|----------|------|----------|
| `sticky` | 出口 IP 在会话期内保持不变 | `/api/v1/proxies/sticky?session=<你的会话标识>&ttl=<分钟>` |
| `rotating` | 每次请求换一个出口 IP | `/api/v1/proxies/random?rotation=rotating` |

- `ttl` 单位为分钟，默认 10，**最长 120 分钟**，超出会自动截断；不传 `session` 时服务端生成一个并在响应里返回。
- 会话过期、绑定的代理被删除或被判失效时，同一个 `session` 会自动改绑一个新的可用代理。
- 代理的 sticky / rotating 属性有两个来源：连续检测积累的出口 IP 记录自动判定（连续 3 次以上出口相同记为 sticky，出现变化记为 rotating），或在代理列表中勾选后手动标注（手动标注不会被自动判定覆盖）。

## License

MIT
