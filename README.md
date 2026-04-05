# 阿里云盘 TV Token Worker

这是从主站 `app\alipan-tv-token\page.tsx` 与相关 API 路由中抽离出来的独立 Cloudflare Workers 项目。

## 功能

- 提供一个独立页面，用于发起阿里云盘 TV 端授权
- 提供生成授权链接、轮询登录状态、刷新 token 的 API
- 兼容 Cloudflare Workers，通过 Wrangler 打包 `crypto-es`

## 项目文件

- `workers.js`：页面和 API 都在这里
- `wrangler.toml`：Cloudflare Workers 配置
- `package.json`：Wrangler 与 `crypto-es` 依赖

## 本地开发

```powershell
cd e:\UGit\i-tools\standalone\alipan-tv-token-worker
npm install
npm run dev
```

注意：当前仓库根目录已经有一个用于 OpenNext 的 `wrangler.json`。这个独立项目的 npm 脚本已经显式加上 `--config wrangler.toml`，否则 `wrangler` 会错误读取上层配置。

## 部署

```powershell
cd e:\UGit\i-tools\standalone\alipan-tv-token-worker
npm install
npx wrangler login
npm run deploy
```

## 路由

- `GET /`：独立页面
- `POST /api/alipan-tv-token/generate-qr`：生成授权链接
- `GET /api/alipan-tv-token/check-status/:sid`：查询扫码状态
- `POST /api/oauth/alipan/token`：通过 `refresh_token` 刷新 access token
- `GET /api/oauth/alipan/token?refresh_ui=xxx`：兼容原页面展示的刷新接口
