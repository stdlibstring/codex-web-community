# 验证记录

日期：2026-10-30。

环境：Linux x64、Node.js 22.23.3、Codex CLI 0.165.0、VS Code Server 1.143.1、Codex 插件 26.51007.21434。使用独立的运行目录、项目目录、工作台数据、Codex 会话目录及监听端口。

| 检查 | 结果 |
| --- | --- |
| `npm ci` | 依赖安装完成，npm audit 未报告漏洞 |
| `npm run setup -- ...` | 从官方下载并安装组件，标准 VSIX 安装布局扩展 |
| 使用相同参数再次执行 setup | 保留配置和已有运行材料 |
| `npm run build` | TypeScript 检查与生产构建通过 |
| `npm test` | 15 项通过，使用真实官方组件 |
| `npm run doctor` | 证书、密钥权限、入口路径与 Codex 登录状态检查通过 |
| `npm run test:browser` | 手机与电脑宽度表单、登录、官方面板、首次引导及对话输入区域通过 |
| `npm run test:agent` | 真实模型请求完成，验证文件内容并读取官方会话历史 |
| `systemd-analyze --user verify` | 生成的服务配置通过语法检查 |
| `npm run pack:source` | 源码包清单中没有个人配置、账户凭据、证书或运行数据 |

集成测试覆盖错误配置、端口占用、TLS、HTTP 与 WebSocket 身份验证、跨站请求限制、退出时撤销连接、官方工作台资源转发及 Codex 协议初始化。

浏览器检查通过 DOM 与实际交互执行。真实模型使用 `gpt-6.1-sol`，验证文件位于独立测试项目。模型调用使用正常账户额度。

arm64 与 WSL2 尚未在对应设备上执行验证。systemd 配置已经检查，实际后台服务安装由部署者执行。GitHub Actions 的远程执行结果以仓库 Actions 页面为准。
