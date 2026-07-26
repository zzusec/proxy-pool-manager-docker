# Proxy Pool Manager (Docker Version)

代理池管理系统 — Docker/Node.js 版本，从 Cloudflare Worker 迁移而来。

## 功能

- 📥 批量导入代理（支持多种格式）
- 🏷️ 自动 IP 分类（住宅/数据中心/移动，基于 ipinfo.io）
- 🌍 国家/地区自动识别
- 💓 内置存活检测（HTTP/SOCKS5，无需外部服务）
- 🔌 对外 API（按类型/国家/协议/存活状态查询）
- ⏰ Cron 定时自动分类和检测
- 🌙 暗色模式

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

# 批量获取代理文本（最多 500 条）
curl -H "Authorization: Bearer $API_KEY" \
  "http://localhost:3000/api/v1/proxies?alive=true&limit=100&format=text"
```

`/api/v1/proxies` 和 `/api/v1/proxies/random` 支持 `type`、`country`、`protocol`、`alive` 过滤；JSON 是默认格式，`format=text` 返回标准 `protocol://user:password@ip:port` 文本。所有对外 API 都必须带 `Authorization: Bearer <API_KEY>`。

## License

MIT
