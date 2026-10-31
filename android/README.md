# Codex 远程 Android APP

版本 `1.1.3`，支持 Android 8.0 及以上版本，需要较新的 Android System WebView。APP 使用 WebView 连接自己部署的 Codex Web Community，显示官方 Codex 插件；登录状态保存在 APP 私有数据目录。

原生界面采用黑白配色、白色双环图标、56dp 顶部栏和圆角底部菜单。顶部栏提供刷新与更多操作，菜单可以进入账户管理或打开系统浏览器。手机开启深色模式时，原生界面与系统栏使用深色背景和浅色图标；手机使用浅色模式时，原生界面跟随工作台主题。APP 保存网页的主题选择，并在启动和手机主题变化时重新计算原生外观。系统栏使用 AndroidX EdgeToEdge 配置透明背景，显示下方的原生界面颜色。

WebView 进入全屏时隐藏原生顶部栏和系统栏，网页退出与系统返回操作可以恢复普通窗口。键盘打开时优先收起键盘。普通模式与全屏模式均按键盘、系统栏和屏幕开孔调整布局；横屏允许输入法提供系统编辑区域。文件附件使用 Android 系统选择器。

## 构建环境

安装 JDK 21、Android SDK Platform 36 和 Build Tools 35.0.0，并接受 Android SDK 许可。设置 `JAVA_HOME` 和 `ANDROID_HOME`，或通过 Android Studio 配置 SDK。仓库提供 Gradle 8.13 Wrapper，包含官方分发文件的 SHA-256 校验值。

以下命令在仓库根目录执行，支持 Linux 和 WSL2。构建脚本将缓存和临时文件放在被忽略的 `.artifacts/` 中；也可以在 Android Studio 中打开 `android/` 工程，并设置相同的 Gradle 项目属性。

## 配置服务器

`codexServerUrl` 必须指定手机能够访问的 HTTPS 入口，例如 `https://codex.example.com:8443/`。服务器地址只包含协议、主机和端口，应用要求部署在网站根目录。地址在构建时写入安装包；更换地址后重新构建。

使用系统已信任证书的服务器：

```bash
npm run android:build -- assembleDebug lintDebug -PcodexServerUrl=https://codex.example.com:8443/
```

使用自己部署时生成的证书：

```bash
npm run android:build -- assembleDebug lintDebug -PcodexServerUrl=https://codex.example.com:8443/ -PcodexServerCa="$PWD/.artifacts/tls.crt"
```

`codexServerCa` 接受 X.509 公开证书，证书中的名称需要覆盖配置的主机。构建程序为该主机生成独立的网络安全配置，公开证书写入安装包。其他主机使用系统证书。TLS 验证失败会停止连接，手机无需安装系统 CA。

调试安装包位于 `android/app/build/outputs/apk/debug/app-debug.apk`，应用 ID 为 `dev.stdlibstring.codexremote.community`。调试签名材料在构建者本地生成。

## 正式签名

生成自己的签名文件；命令会交互询问密码：

```bash
mkdir -p .artifacts/android-signing
keytool -genkeypair -alias codex-remote -keyalg RSA -keysize 3072 -validity 10000 -storetype PKCS12 -keystore .artifacts/android-signing/release.p12
```

使用编辑器创建 `.artifacts/android-signing/keystore.properties`，将 `storeFile` 填写为签名文件的绝对路径，并填写自己的密码：

```properties
storeFile=/absolute/path/to/release.p12
storePassword=自己的签名密码
keyAlias=codex-remote
keyPassword=自己的签名密码
```

```bash
chmod 600 .artifacts/android-signing/release.p12 .artifacts/android-signing/keystore.properties
npm run android:build -- assembleRelease -PcodexServerUrl=https://codex.example.com:8443/ -PcodexServerCa="$PWD/.artifacts/tls.crt" -PcodexSigningProperties="$PWD/.artifacts/android-signing/keystore.properties"
```

正式安装包位于 `android/app/build/outputs/apk/release/app-release.apk`。缺少签名配置时，正式构建会终止。请自行备份签名文件；后续更新需要保持相同的应用 ID 和签名。

## 发布与验证

GitHub Actions 使用示例服务器地址执行调试构建与 Android lint。示例地址用于构建检查；部署者根据自己的服务器生成安装包。

`npm run pack:source` 包含 Android 源码和 Gradle Wrapper。构建目录、本地 SDK 配置、证书、签名文件和运行材料由 Git 忽略规则与打包清单排除。密码和 Codex 登录凭据通过服务器与 APP 的登录流程保存。

APP 调试能力由 `BuildConfig.DEBUG` 控制，正式构建关闭调试标志。需要测试网络、登录和官方插件时，应当连接真实部署并使用 Android 设备或模拟器验证。验证范围记录在仓库根目录的 [VERIFICATION.md](../VERIFICATION.md)。

窗口测试位于 `app/src/androidTest/`，检查实际 Activity 背景、状态栏与导航栏透明颜色，以及图标明暗。使用自己的服务器和签名配置执行 `assembleRelease assembleReleaseAndroidTest`，将两个 APK 安装到设备。先通过工作台的 `Preferences: Color Theme` 选择 `Light Modern`，等待原生界面完成主题同步，再开启手机深色模式并执行：

```bash
adb shell am instrument -w -e expectedNativeTheme dark -e expectedSystemTheme dark -e expectedPageTheme light dev.stdlibstring.codexremote.community.test/androidx.test.runner.AndroidJUnitRunner
```

手机切换回浅色模式后，将两个参数均设置为 `light` 再次执行。测试使用设备的实际主题和窗口属性，参数描述预期结果。
