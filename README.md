# Proxy Pool Manager (Docker Version)

代理池管理系统 — Docker/Node.js 版本，从 Cloudflare Worker 迁移而来。

## 功能

- 📥 批量导入代理（支持多种格式）
- 🏷️ 自动 IP 分类（住宅/数据中心/移动，支持本地 GeoLite ASN 数据库）
- 🌍 国家/地区自动识别（GeoLite Country/City 本地库优先，远程服务兜底）
- 💓 内置存活检测（HTTP/SOCKS5；3 个独立出口 IP 目标都明确失败才标记失效）
- 🗂️ 代理业务分组（例如 `paid-residential-us`，可用于导入、管理和 API 筛选）
- 🔌 对外 API（按类型/国家/分组/协议/存活状态/标签查询）
- ⏰ 可配置的自动分类和检测策略
- 🎨 暗色模式和可配置主体颜色

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
