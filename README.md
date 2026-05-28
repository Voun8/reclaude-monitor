# Reclaude Monitor

VS Code 状态栏扩展，实时展示 [reclaude.ai](https://reclaude.ai) 的拼车额度、服务可用性，并支持多账号管理。

## 状态栏

```
$(zap) $12.34/$50 · 3时24分 · 错误 0.2%
```

- 已用 / 总额度（美元）
- 距下次额度重置的倒计时
- 最近 60 秒服务错误率

悬浮可查看完整面板：当前账号、彩色进度条、剩余额度、错误率、平均延迟、RPM / TPM，以及刷新、切换账号、添加账号、改密、设置组织 ID 等快捷操作。

颜色分级：

| 颜色 | 阈值 |
| --- | --- |
| 蓝（默认） | 使用率 < 80% 且错误率 < 1% |
| 黄 | 使用率 ≥ 80% 或 错误率 ≥ 1% |
| 红 | 使用率 ≥ 95% 或 错误率 ≥ 5% |

## 安装

需要 VS Code `1.85.0` 及以上。

```powershell
pnpm install
pnpm run package
```

打包后的 `.vsix` 位于 `dist/`，在 VS Code 执行 **Extensions: Install from VSIX...** 选中即可。开发时按 `F5` 启动扩展开发宿主窗口。

## 快速开始

1. 命令面板执行 **Reclaude: 添加账号**，输入邮箱与密码。凭证使用 VS Code SecretStorage（系统密钥环）加密存储。
2. 扩展会自动登录并探测拼车组织 ID：账号下仅有 1 个套餐时直接选用；多个套餐时弹窗让你选择。
3. 状态栏立即开始刷新。

## 命令

命令面板搜索 `Reclaude:`：

| 命令 | 说明 |
| --- | --- |
| Reclaude: 立即刷新 | 手动触发一次刷新 |
| Reclaude: 添加账号 | 新增账号（邮箱 + 密码） |
| Reclaude: 切换账号 | 在已保存的多账号间切换 |
| Reclaude: 删除账号 | 删除某个保存的账号 |
| Reclaude: 修改账号密码 | 更新已保存账号的密码 |
| Reclaude: 设置组织 ID | 手动指定拼车组织（`org_id`） |
| Reclaude: 自动探测组织 ID | 重新探测当前账号下的拼车套餐 |
| Reclaude: 设置 Cookie（备用） | 手动粘贴 `rc_sid=...` Cookie |
| Reclaude: 清除所有账号 | 清空所有凭证和缓存 |

## 配置项

`settings.json` 或设置界面搜索 `reclaude`：

| 配置项 | 默认 | 说明 |
| --- | --- | --- |
| `reclaude.refreshOnSave` | `true` | 保存文件时自动刷新 |
| `reclaude.quotaRefreshIntervalSec` | `60` | 拼车额度轮询间隔（秒），最小 5 |
| `reclaude.metricsRefreshIntervalSec` | `30` | 服务可用性轮询间隔（秒），最小 5 |
| `reclaude.idleActivateSec` | `0` | 多少秒未保存文件才启用轮询，`0` = 始终启用 |
| `reclaude.orgId` | `""` | 拼车组织 ID，留空时自动探测 |

状态栏正常态文字颜色可在主题中覆盖：

```json
"workbench.colorCustomizations": {
  "reclaudeMonitor.statusForeground": "#D97757"
}
```

默认色取自 Claude 品牌橙。

## 多账号与自动跟随

- 所有凭证存于 VS Code SecretStorage，平台对应系统密钥环（Windows Credential Manager / macOS Keychain / libsecret），不会落盘明文。
- 每 10 秒读取 `~/.reclaude/device.json`，若发现 reclaude 客户端切换到了**已保存在扩展中**的另一个账号，状态栏自动同步。

## 鉴权失败处理

- HTTP `400/401/403/422`：判定为账号或密码错误，弹窗提示重新输入。
- Cookie 失效（数据接口返回 `401/403`）：自动重新登录一次。
- 持续失败：状态栏显示 `$(key) 账号或密码错误`，点击直接进入「修改账号密码」流程。

## 工作原理

扩展只调用 4 个公开接口：

| 接口 | 用途 |
| --- | --- |
| `POST /api/auth/login` | 账号密码换 `Set-Cookie` |
| `GET  /api/app/billing/carpool-allocations` | 列出账号下的拼车套餐（自动探测 `org_id`） |
| `GET  /api/app/billing/carpool-quota?org_id=...` | 查询拼车额度 |
| `GET  /api/app/ops/metrics` | 查询近 60 秒错误率、RPS、TPM、平均延迟 |

请求均携带 `User-Agent` 与 `referer: https://reclaude.ai/app`。Cookie 仅内存缓存，账号切换时立即失效。

## 隐私

- 邮箱、密码、Cookie 全部走 VS Code SecretStorage。
- 不向 `settings.json` 或日志写入任何凭证。
- 「清除所有账号」会一并清除遗留的旧版字段。

## 许可

MIT
