# Codex Web Community

在手机或电脑浏览器中使用自己服务器上的 Codex。项目提供 HTTPS 密码入口、官方 VS Code 网页工作台和常驻 Codex 引擎，支持对话、权限审批、命令执行、文件编辑与会话历史。

每套部署供同一个系统用户使用。掌握网站密码的人可以使用该用户的 Codex 和项目文件。多人共同使用时，应当为每个人提供独立的系统用户或容器、项目目录及登录状态。

## 环境要求

- Linux x64 或 arm64；Windows 使用 WSL2。
- Node.js 22 或更新版本、npm、curl、tar、OpenSSL。
- 已安装 Codex CLI，且 `codex app-server --help` 包含 `--ws-auth` 和 `--ws-token-file`。
- 能够访问微软下载服务、VS Code Marketplace、VS Code CDN 及自己的模型服务。

通过 `npm install -g @openai/codex` 安装 Codex CLI。安装脚本使用当前 PATH 中的 `codex`，也可以通过 `--codex` 指定可执行文件的绝对路径。

运行所需官方组件由安装脚本获取：VS Code Server **1.143.1** 和 Codex 插件 **26.51007.21434**。官方组件保持原有程序内容，分别遵守其许可证。本项目的 MIT 许可证适用于仓库中的项目代码。

## 安装

将源码放入固定目录，进入该目录后执行：

```bash
mkdir -p .artifacts/runtime
export TMPDIR="$PWD/.artifacts/runtime"
npm ci
```

阅读下载组件附带的 VS Code Server 许可条款；下面的参数表示接受该条款。`--project` 指定自己需要操作的项目目录。

```bash
npm run setup -- --project "$HOME/projects/my-project" --accept-server-license-terms
npm run login
npm run build
npm run doctor
npm start
```

服务器上的浏览器访问 `https://localhost:8443/`。网站访问密码保存在 `.artifacts/access.json`；安装程序生成的密码与 Codex 账户登录分别使用各自的认证流程。

远程服务器可以使用设备登录：

```bash
npm run login -- --device-auth
```

`npm run login -- status` 显示该部署的 Codex 登录状态。登录和会话数据默认保存在 `.artifacts/codex-home/`。需要配置模型或代理时，编辑其中的 `config.toml`，格式遵循 Codex 官方配置文档。

## 手机和远程访问

安装时设置监听地址和浏览器访问的域名或 IP，例如：

```bash
npm run setup -- --project "$HOME/projects/my-project" --host 0.0.0.0 --hostname codex.example.com --accept-server-license-terms
```

域名需要指向运行本项目的服务器，访问设备也需要能够连接服务器的 HTTPS 端口。默认端口为 `8443`。首次访问需要在设备上信任安装时生成的自签名证书，或者提供浏览器已信任的域名证书：

```bash
npm run setup -- --project "$HOME/projects/my-project" --host 0.0.0.0 --hostname codex.example.com --tls-cert "$HOME/certs/fullchain.pem" --tls-key "$HOME/certs/privkey.pem" --accept-server-license-terms
```

登录页面提供证书下载。安装自签名证书前，应该通过可信渠道核对证书；浏览器信任证书后才能正常使用密码保存功能。证书需要覆盖实际访问使用的域名或 IP。

## 配置

安装结果写入 `config.json`，其中保存项目目录、可执行文件、运行目录、监听地址、端口和证书路径。该文件与 `.artifacts/` 已加入 Git 忽略规则。

| 参数 | 默认值 | 用途 |
| --- | --- | --- |
| `--project` | 必填 | Codex 操作的项目目录 |
| `--codex` | 当前 PATH 中的 Codex | Codex CLI 可执行文件 |
| `--codex-home` | `.artifacts/codex-home` | Codex 登录、配置和会话目录 |
| `--server` | 自动下载 | 已安装的官方 `code-server` 可执行文件 |
| `--host` | `127.0.0.1` | HTTPS 监听地址，可设置 `0.0.0.0` |
| `--hostname` | `localhost` | 浏览器访问地址及自签名证书的名称 |
| `--port` | `8443` | HTTPS 端口 |
| `--workbench-port` | `8444` | 内部工作台端口 |
| `--engine-port` | `8446` | 内部 Codex 引擎端口 |
| `--tls-cert` / `--tls-key` | 自动生成 | HTTPS 证书与私钥，需要成对提供 |

三个端口需要互不相同，端口占用会让启动过程立即终止。工作台与引擎仅监听 `127.0.0.1`，并校验各自的连接令牌。

重复执行安装时使用相同参数，密码、令牌、证书、配置与会话会保留。安装参数与已有配置不同时，安装程序会终止并提示检查 `config.json`。修改配置后重新启动服务。搬移安装目录时，需要更新配置中的绝对路径和 `.artifacts/workbench/data/Machine/settings.json` 中的 `chatgpt.cliExecutable`。

需要代理时，在运行安装、登录、启动命令的终端中设置 `HTTP_PROXY`、`HTTPS_PROXY` 和 `NO_PROXY=localhost,127.0.0.1`。后台服务可通过仓库根目录的 `.env` 文件设置环境变量。代理由部署者按自己的网络环境配置。

## 后台运行

`npm start` 管理 Codex、工作台和 HTTPS 三个进程。退出时关闭本次启动的进程；任意进程异常退出时，整套服务会终止并返回失败。浏览器刷新期间，引擎继续执行任务。重新启动服务会终止当时执行中的任务，已经保存的会话可以通过官方历史列表继续。

生成并安装独立的 systemd 用户服务：

```bash
npm run service
install -Dm600 .artifacts/codex-web-community.service "$HOME/.config/systemd/user/codex-web-community.service"
systemctl --user daemon-reload
systemctl --user enable --now codex-web-community
```

```bash
systemctl --user status codex-web-community
journalctl --user -u codex-web-community -f
systemctl --user stop codex-web-community
```

更换证书后，执行 `systemctl --user reload codex-web-community` 加载证书。服务配置使用独立名称。日志、下载内容及安装结果均位于 `.artifacts/`。

## Android APP

`android/` 提供版本 `1.1.2` 的 Codex 远程 APP 源码，包含明暗主题、原生菜单、系统文件选择、软键盘布局和 WebView 全屏支持。服务器地址、公开证书和签名通过构建参数配置。应用 ID 为 `dev.stdlibstring.codexremote.community`，支持 Android 8.0 及以上版本。

准备 JDK 21 与 Android SDK 36 后，在仓库根目录构建自己的安装包：

```bash
npm run android:build -- assembleDebug lintDebug -PcodexServerUrl=https://codex.example.com:8443/ -PcodexServerCa="$PWD/.artifacts/tls.crt"
```

安装包位于 `android/app/build/outputs/apk/debug/app-debug.apk`。使用系统已信任证书时省略 `codexServerCa`。正式签名、构建环境与参数说明见 [Android APP](android/README.md)。

## 验证

```bash
npm run check
npm test
```

`npm test` 在配置指定的空闲端口启动真实官方工作台、Codex 引擎与 HTTPS 入口，测试结束后关闭本次启动的服务。测试覆盖端口配置校验、证书、密码登录、HTTP 和 WebSocket 鉴权、退出后连接撤销、官方资源转发以及真实引擎协议初始化。测试服务日志位于 `.artifacts/tests-server.log`。

浏览器验证使用实际的官方插件界面，通过 DOM 检查登录、工作台加载、Codex 面板和手机宽度下的登录表单。需要先安装 Chromium：

```bash
PLAYWRIGHT_BROWSERS_PATH="$PWD/.artifacts/browsers" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/.artifacts/browsers" npm run test:browser
```

也可以通过 `CHROME_BINARY` 指定已有 Chrome 或 Chromium。测试创建独立浏览器上下文。首次使用工作台时，按官方界面完成目录信任与 Codex 登录引导。

完成 Codex 登录后，可以在专门的测试项目中执行真实模型验证：

```bash
npm run test:agent
```

该检查使用当前配置中的模型，在 `--project` 指定的目录中创建带随机名称的验证文件，逐字检查内容并读取会话历史。检查会消耗正常的模型额度。可以通过 `CODEX_TEST_MODEL` 指定测试模型。

## 发布源码

```bash
npm run pack:source
```

源码包生成在 `.artifacts/output/codex-web-community-1.0.0.tar.gz`。打包脚本按明确列出的源码目录收集文件；运行数据、个人配置、账户凭据、证书、官方二进制组件、依赖和构建产物均位于打包范围之外。接收者解压后按照安装流程运行。

仓库的 GitHub Actions 工作流在 Linux 上安装固定版本组件，执行网站构建和真实集成测试，并单独执行 Android 调试构建与 lint。

## 使用范围

首次安装在 Linux x64 验证；arm64 使用对应的官方下载地址，需要部署者在自己的设备上检查兼容性。该项目需要能够运行后台进程的主机。GitHub Pages 只提供静态网页托管。

本项目独立维护，与 OpenAI、Microsoft 的官方产品归属分别说明。Codex 和 VS Code 的名称、标识与官方组件权利归各自所有者。
