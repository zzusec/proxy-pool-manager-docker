# Proxy Pool Manager (Docker Version)

代理池管理系统 — Docker/Node.js 版本，从 Cloudflare Worker 迁移而来。

## 功能

- 📥 批量导入代理（支持多种格式）
- 🔗 订阅链接解析（Base64 编码、Clash YAML）
- 🏷️ 机房 IP / ISP 住宅 IP 判定统一以 ipdata.co 为准（asn.type + company.type，双 ISP 即住宅），未配置 Key 时才回退 testisp.info / ispinfo.io，本地 GeoLite 关键词推断只作最后兜底
- 🌍 国家/地区自动识别（GeoLite Country/City 本地库优先，远程服务兜底）
- 💓 内置存活检测（HTTP/SOCKS5 直连，其余协议经 sing-box 隧道；确认失效后直接删除，无法判断时保留并记录原因）
- 🔁 sticky / rotating 代理类型识别（按出口 IP 历史自动判定，也可手动标注）
- 🎯 按当前筛选结果后台批量检测（跨页快照，逻辑范围无上限）
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
| `IPDATA_API_KEY` | ipdata.co API Key，机房/ISP 判定来源（免费额度 1500 次/天）；支持逗号分隔多个轮换；也可在设置页增删，设置页的 Key 优先 | - |
| `IPINFO_TOKEN` | ipinfo.io API token | - |
| `ISPINFO_API_URL` | 通过代理出口调用的 ISPInfo 接口 | `https://ispinfo.io/api/ip` |
| `ISPINFO_TIMEOUT` | ISPInfo 单代理查询超时（毫秒） | 跟随 `testTimeout` |
| `API_KEY` | 外部 API 访问密钥 | - |
| `TESTER_URL` | 外部测试服务 URL（可选） | - |
| `CRON_SCHEDULE` | Cron 调度 | `*/10 * * * *` |

## 管理员认证与恢复

- `SESSION_SECRET` 只用于签发和验证 8 小时的登录会话。轮换它会让当前会话失效，但不会使新版管理员密码失效。
- 管理员在设置页修改的密码保存在 Docker 的持久化数据卷中，重建镜像或容器不会重置它；不要通过删除 `proxy-pool-data` 恢复登录，这会丢失代理、任务和设置。
- 旧版部署曾以 `SESSION_SECRET` 生成密码摘要。升级后首次以旧密码登录会自动迁移；若此前已轮换 session secret，可使用 `.env` 中已知的 `ADMIN_PASSWORD` 登录一次完成恢复与迁移。
- 如果旧密码和环境恢复密码都不可用，先备份数据卷，然后只在服务器/容器本地运行：

  ```bash
  read -rs ADMIN_PASSWORD; echo
  export ADMIN_PASSWORD
  docker compose exec -e ADMIN_PASSWORD proxy-pool \
    node scripts/reset-admin-password.mjs --confirm-reset-admin-password
  unset ADMIN_PASSWORD
  ```

  这只会更新管理员密码记录，不会删除其他数据，也不会在网络上提供重置入口。请避免把密码、`SESSION_SECRET`、Bearer token 或完整的 `docker compose config` 输出发送到日志或聊天记录。
- 生产环境应在 HTTPS 反向代理之后访问，设置 `COOKIE_SECURE=true`，并为 `ADMIN_PASSWORD` 与 `SESSION_SECRET` 使用独立的高强度随机值。

部署脚本会等待 `/healthz` 和认证配置确认。若在受保护的 shell 环境中设置 `LOGIN_SMOKE_USERNAME`、`LOGIN_SMOKE_PASSWORD`，它还会执行不输出 token 的登录烟测。

## IP 类型判定（机房 vs ISP 住宅）

判定链路只认 ipdata.co，规则按顺序生效：

1. `asn.type` 与 `company.type` **同为 `isp`** → 住宅（双 ISP，置信度最高）
2. 任一为 `hosting`，或 `threat.is_datacenter` 为真 → 机房
3. 任一为 `isp` → 住宅（单边命中，置信度中）
4. 任一为 `business` / `education` / `government` / `banking` / `military` / `cdn` → 机房
5. 都取不到 → 保持"待分类"，不猜

要点：

- 「刷新 IP 类型」走 ipdata 批量接口（每次最多 100 个 IP），全库体检则按**实测出口 IP** 单个查询；确认失效的代理会直接删除并跳过 ipdata，不浪费额度。
- **风险信息**：同一次 ipdata 查询还会带回 `threat.scores.trust_score`（0–100，越低越差）和命中的威胁标记数量（`is_proxy` / `is_datacenter` / `is_tor` / `is_known_abuser` 等）。列表新增「风险」列，显示信任分与档位（0–33 高风险 / 34–66 中风险 / 67–100 低风险），悬停可看具体命中了哪些标记；对外 API 也会返回 `trustScore` / `threatCount` / `riskLevel`。本地 ASN 预筛判定的机房 IP 没有查过 ipdata，该列显示 `-`。
- **网段级持久化缓存**：ipdata 每条响应都带 `asn.route`（如 `207.97.155.0/24`），整段写入 SQLite（默认 30 天，设置页可调 1–365）。批量分类时先按 /24 各取一个代表去查，拿回真实网段后其余 IP 直接命中缓存；网段被拆成两个 /25 之类的情况会自动多跑一轮，覆盖范围永远以实际 route 为准而不是 /24 猜测。实测线上 11070 个 IP 落在 187 个 /24 内，全量刷新的调用量从 11070 降到约 187。
- **本地 ASN 预筛**：GeoLite2-ASN 认出 AWS/Hetzner/Cloudflare/OVH 等纯托管 ASN（名单见 `src/services/datacenter-asns.js`）时直接判机房，不花额度；只判机房不判住宅——「不是已知机房」说明不了是住宅还是商务，双 ISP 仍必须问 ipdata。可在设置页关闭。
- **额度看板**：设置页显示今日已用次数、按 Key 数估算的剩余额度、缓存/预筛各省了多少次、缓存条目数与命中数，并可清理过期缓存或清空全部。
- **多 Key 轮换**：设置页可添加任意多个免费 Key，请求按轮询分摊；某个 Key 返回配额用尽（403）就自动跳过它并换下一个，日额度按 Key 数量叠加。
- 单 Key 状态：`401` → 标记「无效」并移出轮换；`403 daily limit` → 冷却到次日 UTC 零点；`429` 限流 → 冷却 10 分钟。设置页每个 Key 单独显示状态、成功/失败次数和最近错误，可单独测试或删除。
- 结果缓存 6 小时；Key 只以掩码形式（前 4 位 + 后 4 位）回显，接口不会返回明文。
- ipdata 把移动运营商也归为 `isp`：只有 ispinfo 在出口侧识别出移动网络时才标记为「移动」。
- 列表里 IP 类型徽标悬停可以看到判定来源和原始 `asn.type` / `company.type` 证据。
- 未配置 Key 时系统不会中断，只是回退到旧链路（testisp.info → ispinfo.io → GeoLite 关键词），此时精度明显下降。
- 设置页「IP 分类」可以直接填 Key 并做一次测试查询，保存后立即生效，无需重启。

## 批量检测（耐久任务）

代理列表页有三个语义不同的检测入口，全部写入数据库中的耐久任务（`test_jobs` / `test_job_items`），关闭页面或重启容器都会继续跑完：

| 入口 | 范围 | 上限 |
|------|------|------|
| 检测当前筛选结果 | 服务器按当前筛选条件（类型/国家/分组/协议/状态/搜索）覆盖全部匹配代理 | 无上限 |
| 检测全部未检测 | 当前所有 `alive IS NULL` 的代理 | 无上限 |
| 勾选行 → 检测 | 当前勾选的全部代理 | 无上限 |

- 检测得到 `alive === false` 的确认失效结果时会直接删除代理；历史数据中已有的 `alive=false` 行仍可通过「失效」筛选查看和复测。
- 任务创建后按数据库高水位冻结范围，并在后台小批量准备任务成员；新入库代理不会混入已经创建的任务。
- 用户操作没有 1000 条逻辑限制，但任务准备和检测仍采用持久化分页、受控批次和受控并发，避免阻塞服务。

### 存活判定规则

检测目标默认走 HTTPS（`api.ipify.org` / `ipinfo.io` / `icanhazip.com`），与真实使用方式一致；判定顺序如下，尽量不留「不确定」：

| 结论 | `last_test_outcome` | 触发条件 |
|------|---------------------|----------|
| 存活 | `alive` | 任一目标返回 2xx 且解析出出口 IP |
| 存活 | `alive_no_exit_ip` | 代理成功转发、目标有 HTTP 响应但没吐出口 IP（限流、拦截页、非 JSON） |
| 失效 | `dead` | 3 个目标全部在连接层失败；或 sing-box 隧道起不来且节点端口 TCP 不可达 |
| 失效 | `tunnel_error` | 节点端口能连上，但 sing-box 建不起隧道（配置不被支持），在本系统里同样不可用 |
| 无法检测 | `unsupported_protocol` | 检测器不支持该协议（例如 tuic），不会给出存活结论 |

- `alive === false`（包括 `dead` 和 `tunnel_error`）是确认失效，会立即删除；`alive === null`（例如协议不支持、检测器未返回结果或基础设施异常）不会删除。
- 未被删除的检测结果会写入 `last_test_outcome` 和 `last_test_error`，界面上鼠标悬停状态徽标即可看到具体原因。
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
