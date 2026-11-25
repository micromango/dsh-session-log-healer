# DSH Session Log Healer

[![Tests](https://github.com/micromango/dsh-session-log-healer/actions/workflows/test.yml/badge.svg)](https://github.com/micromango/dsh-session-log-healer/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

DSH 会话日志自愈插件。在会话写入锁保护下检查 v4 JSONL zstd 日志，保留全部原始记录，并修复可恢复的压缩帧布局。

**版本：1.1.0** · [English technical details](docs/DETAIL.md) · [更新记录](CHANGELOG.md)

## 功能

- 逐个解压全部 zstd 帧，保留每一条原始记录。
- 使用 DSH 持久化后端的实际会话写入锁；正在写入的会话会跳过。
- 严格校验 UTF-8、JSONL、v4 会话头和 DSH 会话格式，并通过 DSH 的实际读取路径验证结果。
- 修复会话头与事件混在同一个压缩帧中的布局。完整 JSON 缺少末尾换行时，只有完整会话校验通过才会补一个换行。
- 先写入、同步并验证临时文件，创建独立备份，再检查原文件是否变化，最后在同一目录内替换文件。
- 卸载时取消正在执行的工作，等待扫描结束和写入锁释放。

完整有效的日志保持原样。无法解码的压缩帧、永久校验和损坏、不完整记录或会话校验失败，会报告需要手动处理并保留原文件。备份名为 `*.corrupt-<timestamp>-<uuid>.bak`。

## 运行要求

- Node.js **24 或更新版本**，具备 Node 内置 zstd 支持。
- DSH v4 JSONL zstd 持久化后端。已验证 `@deepseek-ai/dsh-session-persistence-jsonl@0.2.2-rc.3`，以及 Node.js `24.21.0`、`26.13.1`。
- 宿主须提供 `acquireLease()`、`readZstdPrefix()` 和完整的 v4 会话格式目录。这些后端方法属于内部兼容接口；缺少接口或验证器时，插件会在安排自动写入前拒绝启动。

插件没有需要单独安装的运行依赖，使用 Node 内置模块及 DSH 已安装的会话格式验证器。

## 安装

先打开一次 DSH 完成目标 profile 初始化，然后退出 DSH。将仓库克隆到一个固定目录，例如在 PowerShell 中执行：

```powershell
git clone https://github.com/micromango/dsh-session-log-healer.git C:\dsh-plugins\dsh-session-log-healer
dsh plugin --profile desktop add "link:C:/dsh-plugins/dsh-session-log-healer"
```

`desktop` 是 DSH 桌面版的 profile；使用其他 profile 时换成对应名称。`dsh plugin add` 会安装本地包，并将包声明的 `cordis.patch.yml` 注册为 profile 的 bundle 层。随后重新打开 DSH。

如果当前安装没有将 `dsh` 命令加入 PATH，可以在 DSH 插件管理界面将克隆目录作为本地插件安装。安装后的目标 profile 应包含下面两项：

```json
{
  "dependencies": {
    "@local/dsh-session-log-healer": "link:C:/dsh-plugins/dsh-session-log-healer"
  },
  "dsh": {
    "profile": {
      "bundles": ["@local/dsh-session-log-healer"]
    }
  }
}
```

这是需要合并到已有配置的片段，已有的依赖和 bundle 列表也应保留。Windows 桌面版的默认 profile 位于 `%USERPROFILE%\.dsh\profiles\desktop`；自定义 DSH 数据目录时使用实际的 profile 路径。

## 配置与使用

插件加载后自动扫描，无需手动调用。默认跟随当前持久化后端的会话根目录，在启动 3 秒后扫描；每次扫描完成 24 小时后再次扫描。默认跳过最近 10 分钟有修改的日志，并始终遵守实际写入锁。

包内的 `cordis.patch.yml` 提供默认配置。可配置项如下：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `root` | 当前持久化后端的根目录 | 仅允许该根目录或其子目录 |
| `startupDelayMs` | `3000` | 首次扫描延迟，非负安全整数 |
| `intervalMs` | `86400000` | 上次扫描结束到下次扫描的间隔，正安全整数 |
| `scanActive` | `true` | 额外跳过最近有修改的文件；设为 `false` 仍不会绕过写入锁 |

扫描会跳过超过 512 MiB 的压缩文件；解压明文限制为 512 MiB，帧数限制为一百万。遍历时不跟随目录或文件符号链接。备份会保留，插件不会自动清理旧备份。

更新本地源码后须重新加载插件或重新打开 DSH，正在运行的实例才会使用新代码。更多行为、错误处理和平台限制见 [技术说明](docs/DETAIL.md)。

## 开发与验证

在仓库目录中运行：

```powershell
npm test
```

回归测试使用临时生成的日志和后端、格式目录测试替身，覆盖多帧记录保留、写入失败、并发变更、写入锁竞争、取消、严格校验及定时器。测试清理前会检查目标目录位于临时目录内。

GitHub Actions 在 Windows 和 Linux 上分别使用 Node.js 24、26 执行这些回归测试。实际 DSH 的原生写入锁和会话格式兼容性需要在对应宿主上另外验证。

欢迎通过 [Issues](https://github.com/micromango/dsh-session-log-healer/issues) 提交问题，或通过 Pull Request 改进插件。问题报告中请附上 DSH、持久化后端和 Node.js 版本，以及能复现问题的合成日志。

## 许可证

[MIT](LICENSE)。本仓库提供社区插件源码。
