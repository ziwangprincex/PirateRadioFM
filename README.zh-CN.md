<p align="center"><img src="assets/banner.png" alt="PirateRadioFM — 在 CLI 里听电台" width="100%"></p>

# PirateRadioFM

在 CLI 编程 agent 里放网络电台。会话结束时音乐自动停止。

[English](./README.md)

## 安装（Claude Code）

需要 Node.js 20+ 和 `mpv`（或 `ffplay`）：

- Windows：`winget install mpv`
- macOS：`brew install mpv`
- Linux：`sudo apt install mpv`

```bash
claude plugin marketplace add ziwangprincex/PirateRadioFM
claude plugin install radiohead@radiohead
```

重启 Claude Code，在新会话里输 `/` 就能看到命令。

卸载：

```bash
claude plugin uninstall radiohead
claude plugin marketplace remove radiohead
```

## 安装（Codex / OpenCode / Hermes / pi）

```bash
git clone https://github.com/ziwangprincex/PirateRadioFM
cd PirateRadioFM
node install.mjs
```

不带参数时配置本机装了的所有 agent。也可以指定一个：`node install.mjs codex`
（或 `opencode`、`hermes`、`pi`）。`node install.mjs --uninstall` 删除写入的
全部内容。装完重启对应 agent。

写入的位置：

- Codex：MCP server 写进 `~/.codex/config.toml`，prompts 写进 `~/.codex/prompts/`
- OpenCode：MCP server 写进 `~/.config/opencode/opencode.json`，命令写进 `~/.config/opencode/commands/`
- Hermes：MCP server 写进 `~/.hermes/config.yaml`
- pi：prompt 模板写进 `~/.pi/agent/prompts/`，skill 写进 `~/.pi/agent/skills/radiohead/`

pi 不支持 MCP，命令直接调用 `dist/cli.js`，所以会话结束时音乐不会自动停，
需要用 `/stop`。

## 命令

### 风格电台

| 命令 | 播放 |
|---|---|
| `/jazz` | 爵士 |
| `/classical` | 古典 |
| `/indie` | 独立音乐 |
| `/rock` | 摇滚 |
| `/country` | 乡村 |
| `/pop` | 流行 |
| `/ambient` | 氛围 |
| `/lofi` | lo-fi |
| `/soul` | 灵魂乐 |
| `/eighties` | 80 年代 |
| `/world` | 世界音乐 |
| `/house` | 浩室 |
| `/techno` | techno / IDM |

### DJ / 公共电台

| 命令 | 电台 |
|---|---|
| `/kexp` | KEXP 90.3，西雅图 |
| `/kcrw` | KCRW Eclectic24，洛杉矶 |
| `/wfmu` | WFMU 自由派，新泽西 |
| `/nts` | NTS，伦敦 |
| `/wwoz` | WWOZ，新奥尔良，爵士和蓝调 |
| `/paradise` | Radio Paradise |
| `/npr` | NPR 音乐台 — The Current、WXPN、KUTX、WFUV（`/next` 轮换） |
| `/hoer` | HÖR 柏林 — 直播时段放 DJ 直播，其余时间放最新场次（[配置指南](./docs/sources.md#hör-berlin)） |

### 播放控制

| 命令 | 作用 |
|---|---|
| `/play` | 播放爵士电台；如果之前暂停了，就恢复播放 |
| `/pause` | 暂停 |
| `/resume` | 恢复播放 |
| `/stop` | 停止。和暂停不同，停止后不能恢复 |
| `/next` | 下一个台 / 频道 / 曲目 |
| `/prev` | 上一个台 / 频道 / 曲目 |
| `/volume <0-100>` | 设置音量 |
| `/now-playing` | 显示正在播放什么 |
| `/doctor` | 诊断播放问题（播放器、yt-dlp、Spotify、电台连通性） |

`/nts`、`/paradise`、`/npr` 有多个频道，用 `/next` 切换。

### 播客与流媒体

| 命令 | 作用 |
|---|---|
| `/podcast <名字或RSS地址>` | 播放播客最新一集（iTunes 搜索，无需登录）；`/next`/`/prev` 切集 |
| `/music <名字>` | 播放 Apple Music 资料库里的歌单/歌曲/专辑（仅 macOS） |
| `/spotify-play <任意内容>` | 在你的 Spotify 客户端上播放曲目/专辑/歌单/播客（需 Premium + 配置） |
| `/spotify-search <关键词>` | 搜索 Spotify 目录 |
| `/spotify-devices` / `/spotify-device <名字>` | 列出 Spotify 设备 / 转移播放 |

Spotify 需要一次性配置（开发者 app + 登录）；三类音源的细节和限制见
[docs/sources.zh-CN.md](./docs/sources.zh-CN.md)。

直接说话也行："放点爵士"、"换个台"、"停"。
