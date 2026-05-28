# Changelog

本文件记录 `reclaude-monitor` 的所有重要变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.0.1] - 2026-05-28

### 新增

- 状态栏实时展示 reclaude 拼车额度、距额度重置倒计时、近 60 秒服务错误率。
- 鼠标悬浮面板展示当前账号、彩色进度条、剩余额度、错误率、平均延迟、RPM / TPM
  以及刷新、切换账号、添加账号、改密、设置组织 ID 等快捷操作链接。
- 多账号管理：添加、切换、删除、修改密码。所有凭证通过 VS Code SecretStorage 加密存储。
- 自动探测拼车组织 ID（`carpool-allocations`）；多套餐时弹窗供用户选择。
- 自动跟随 reclaude 客户端：每 10 秒读取 `~/.reclaude/device.json`，发现客户端切换到
  已保存账号时同步切换。
- 闲置调度：可配置在多少秒未保存文件后才启用轮询，节省资源。
- 保存文件自动刷新（可关闭）。
- 鉴权失败兜底：Cookie 失效自动重登；账号或密码错误时弹窗提示重新输入并跳转到改密流程。
- 自定义状态栏正常态文字颜色：`reclaudeMonitor.statusForeground`（默认 Claude 品牌橙）。
- 9 条 `reclaude.*` 命令与 5 项 `reclaude.*` 配置。
