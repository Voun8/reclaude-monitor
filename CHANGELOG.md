# Changelog

本文件记录 `reclaude-monitor` 的所有重要变更，格式遵循
[Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 新增

- 新增 `reclaude.apiBase` 配置项，允许用户自定义监控 API 根地址。

### 变更

- API 根地址留空时优先使用 `https://reclaude.ai`，默认地址网络或服务不可用时自动切换到 `https://www.recode.cat`；填写自定义地址后仅使用该地址。

## [0.0.2] - 2026-05-30

### 新增

- 左侧活动栏新增 Reclaude 图标，点击打开「监控面板」侧边栏视图（WebviewView）。
- 侧边栏面板可视化展示：拼车额度进度条、已用 / 剩余、重置倒计时、服务可用性
  （错误率、平均延迟、请求/分、令牌/分）。
- 侧边栏内联操作：刷新、切换账号、添加账号、修改密码、设置 / 自动探测组织 ID，
  全部在面板内完成，无需打开命令面板。
- 图标：`media/icon.svg`（活动栏单色）与 `media/icon.png`（扩展市场彩色），并在 `package.json` 声明 `icon`。

### 变更

- **组织 ID 按账号记忆**：`org_id` 不再是单一全局值，改为跟随当前账号存储与探测，
  切换账号自动套用对应组织；仅在无账号的备用 Cookie 模式下回退到全局配置 `reclaude.orgId`。
- 状态栏悬浮提示重排版并全面中文化：彩色用量百分比、细条进度条、纵向两列的服务可用性表格、
  方块迷你折线图。
- 侧边栏面板跟随 VS Code 浅色 / 深色主题（使用主题 CSS 变量着色）。
- 状态栏单击行为由「立即刷新」改为「聚焦侧边栏面板」。
- 打包流程统一为 `pnpm package`（vsce）；更新 `.vscodeignore` 以保留 `media/` 图标、
  排除源码与构建产物。
- 重写 README，补充侧边栏面板、主题自适应、内联操作与按账号组织 ID 等说明。

### 修复

- 修复多账号共用同一全局 `org_id` 导致切换账号后查询额度返回 `403 organization access denied`、
  表现为「登录失败 / 数据获取失败」的问题。

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
