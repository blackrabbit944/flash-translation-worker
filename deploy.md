# Flash Translation Worker 部署指南

本指南将帮助你将项目部署到 Cloudflare Worker。

## 1. 部署数据库 (D1)

本项目使用了三个 D1 数据库，你需要分别对它们应用迁移。

请在终端中依次运行以下命令：

```bash
# 部署用户数据库
npx wrangler d1 migrations apply users_db --remote

# 部署单词数据库
npx wrangler d1 migrations apply words_db --remote

# 部署日志数据库
npx wrangler d1 migrations apply logs_db --remote
```

> **注意**：如果不加 `--remote` 参数，迁移将应用到本地开发数据库。

## 2. 部署代码

使用 pnpm 运行部署脚本：

```bash
pnpm run deploy
```

这将自动构建项目并将其上传到 Cloudflare。

## 3. 设置环境变量

环境变量分为**普通变量**和**机密变量 (Secrets)**。

### 机密变量 (Secrets)

敏感信息不应直接写入配置文件，请使用 `wrangler secret put` 命令设置：

```bash
# Gemini API 密钥
npx wrangler secret put GEMINI_API_KEY

# JWT 签名密钥
npx wrangler secret put JWT_SECRET

# RevenueCat Webhook 密钥
npx wrangler secret put REVENUECAT_WEBHOOK_SECRET

# Cloudflare Gateway Token (如果使用了 AI Gateway)
npx wrangler secret put CLOUDFLARE_GATEWAY_TOKEN
```

运行命令后，终端会提示你输入具体的值。

### 普通变量

非敏感变量可以直接在 `wrangler.jsonc` 文件的 `[vars]` 部分配置，或者通过 Cloudflare Dashboard 设置。

根据代码 (`worker-configuration.d.ts`)，你可能还需要设置：

- `ENVIRONMENT`: 环境名称 (例如 `production`)
- `R2_PUBLIC_DOMAIN`: R2 存储桶的公开访问域名

可以在 `wrangler.jsonc` 中添加：

```jsonc
"vars": {
  "ENVIRONMENT": "production",
  "R2_PUBLIC_DOMAIN": "https://你的-r2-域名.com"
}
```

或者使用 `wrangler deploy --var` 命令在部署时指定。
