# Reclaude Monitor

VS Code 插件：在状态栏和侧边栏实时显示 reclaude 拼车额度、个人用量与服务可用性。

## 功能

- **拼车额度**：状态栏显示已用 / 总额、重置倒计时；侧边栏可视化进度条。
- **服务可用性**：错误率、平均延迟、请求/分、令牌/分实时监控。
- **侧边栏面板**：左侧活动栏图标点开，跟随 VS Code 浅色/深色主题；刷新、切换、添加、改密、组织等操作全部内联在面板内完成。
- **多账号管理**：添加多个账号、一键切换、修改密码；组织 ID（org_id）按账号各自记忆与自动探测，切换账号自动套用。
- **自动跟随**：检测 `~/.reclaude/device.json`，自动同步 reclaude 当前账号。
- **定时刷新**：额度与指标独立刷新间隔，支持闲置暂停。
- **API 地址可配置**：留空默认使用 `https://reclaude.ai`，默认地址不可用时自动切换到 `https://www.recode.cat`。

## 使用

1. 点击左侧活动栏的 Reclaude 图标打开侧边栏面板。
2. 点「添加」，输入邮箱和密码（也可用命令 `Reclaude: 添加账号`）。
3. 插件自动登录并探测组织 ID（org_id）。
4. 状态栏显示额度与服务状态，鼠标悬停查看详情；侧边栏查看完整面板并进行操作。

## 配置项

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `reclaude.refreshOnSave` | `true` | 保存文件时自动刷新 |
| `reclaude.quotaRefreshIntervalSec` | `60` | 余额刷新间隔（秒） |
| `reclaude.metricsRefreshIntervalSec` | `30` | 错误率刷新间隔（秒） |
| `reclaude.idleActivateSec` | `0` | 闲置多久后才定时刷新；0=始终 |
| `reclaude.apiBase` | `""` | API 根地址；留空时默认 `https://reclaude.ai`，默认地址不可用时自动切到 `https://www.recode.cat`；填写后仅使用该地址 |
| `reclaude.orgId` | `""` | 拼车组织 ID（仅备用 Cookie 模式使用；账号密码模式按账号自动记忆） |

## 开发与打包

```bash
pnpm install
pnpm run compile      # 编译 TypeScript 到 out/
pnpm run package      # 清理 + 编译 + 用 vsce 打包到 dist/*.vsix
```

安装打包好的 vsix：

```bash
code --install-extension dist/reclaude-monitor-0.0.3.vsix --force
```

## License

MIT
