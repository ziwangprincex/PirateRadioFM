# 播客、Spotify、Apple Music 音源说明

v0.2.0 在内置电台之外新增了三类音源。本文说明每一类怎么用、需要什么前提、
有哪些已知限制。

[English](./sources.md)

## 总览

| 音源 | 出声方式 | 前提条件 | 平台 |
|---|---|---|---|
| 电台（原有） | 本地 mpv/ffplay | 无 | 全平台 |
| **播客** | 本地 mpv/ffplay | 无（不用登录） | 全平台 |
| **Spotify** | 遥控 Spotify 客户端 | Premium + 开发者 app + 登录 | 全平台 |
| **Apple Music** | 遥控本机 Music.app | 曲目已在资料库里 | 仅 macOS |

`/pause` `/resume` `/next` `/prev` `/volume` `/stop` `/now-playing` 对四类音源
通用，会按当前音源自动分发。切换音源时旧的会自动静音——不会出现两路声音同时播。

## 播客

零配置。用 iTunes Search API（免费、无需鉴权）按名字搜播客，取 RSS feed 里
最新一集的音频地址，走和电台相同的本地播放管道。

```
/podcast 99% Invisible        # 按名字搜索，播最新一集
/podcast https://…/feed.xml   # 直接给 RSS 地址也行
/next                         # 上一集（更旧）
/prev                         # 下一集（更新）
```

- 集数顺序：最新一集是 1，`/next` 往旧走，`/prev` 往新走。
- **暂停后恢复会从头播这一集**：暂停实现是杀掉本地播放器，进度不保留。
  这是 v1 的取舍；要断点续播需要 mpv IPC，后续再说。
- 会话结束自动停止、`/stop` 全灭等保障与电台一致。播客音频的 CDN 域名
  会记录到 `~/.pirate-radio/dynamic-hosts.json`（上限 20 条），孤儿进程
  清扫会连这些域名一起匹配。

## Spotify

Web API 只能**遥控**一个正在运行的 Spotify 客户端（Spotify Connect 设备），
自己不出声，且播放控制需要 **Premium**。

### 一次性配置

1. 到 <https://developer.spotify.com/dashboard> 建一个 app，Redirect URI 填
   `http://127.0.0.1:8888/callback`。
2. 把 Client ID 放进环境变量：`export SPOTIFY_CLIENT_ID=...`。
3. `/spotify-login` → 打开返回的 URL 授权 → 从跳转地址里复制 `code` 参数 →
   `/spotify-complete-login <code>`。

Token 存在 `~/.pirate-radio/spotify.json`（权限 0600），之后自动刷新，
不用重复登录。

### 命令

```
/spotify-play <任意内容>      # URI、open.spotify.com 链接、自己的歌单名，
                              # 或随便一段文字（搜目录，优先级 曲目>专辑>歌单>播客）
/spotify-search <关键词>      # 搜目录，返回带 URI 的结果列表
/spotify-list                 # 列出自己的歌单
/spotify-devices              # 列出在线的 Connect 设备（> 标记当前活跃设备）
/spotify-device <名字或id>    # 把播放转移到另一台设备
```

- `/spotify-play` 现在什么都能播：`spotify:track:…`、`spotify:album:…`、
  `spotify:show:…`（播客）、`open.spotify.com` 链接、歌单名、自由文本。
- `/now-playing` 在 Spotify 模式下会实时查询 API，显示真实曲目、进度和设备。
- **没有活跃设备时的自愈**（仅 macOS）：播放遇到 404 会自动 `open -a Spotify`
  拉起客户端，等它注册成 Connect 设备（最多约 12 秒），转移播放后重试一次。
  其他平台会提示先打开客户端或用 `/spotify-devices`。

### 限制

- Premium 必需；免费账户会收到 403。
- Spotify 已对新注册 app 关闭 recommendations / audio-features 等端点，
  所以没有"猜你喜欢"类功能。

## Apple Music（仅 macOS）

通过 `osascript`（AppleScript）驱动本机 Music.app。不需要开发者账号、
不需要任何 token。

```
/music <歌单、歌曲或专辑名>
```

- 匹配顺序：歌单名 → 歌曲名（contains）→ 专辑名（contains）。
- **只能播资料库里已有的内容**。AppleScript 无法搜 Apple Music 目录——那是
  MusicKit（网页/App 专用）的能力，CLI 下不可用。想播的内容先在 Music.app
  里"添加到资料库"。
- 第一次使用时 macOS 会弹一次"允许控制 Music"的自动化授权，点允许即可。
- 会话结束时的自动停止只覆盖本地播放器；Music.app / Spotify 属于外部应用，
  会话结束不会替你暂停（和之前的 Spotify 行为一致），需要时用 `/stop`。

## 实现位置

| 文件 | 职责 |
|---|---|
| `src/sources/podcast.ts` | iTunes 搜索、RSS 解析（无第三方依赖）、按集播放 |
| `src/sources/applemusic.ts` | osascript 封装、资料库三级匹配 |
| `src/sources/spotify.ts` | 目录搜索、设备列表/转移、now-playing、404 自愈 |
| `src/dynhosts.ts` | 播客 CDN 域名登记，供孤儿进程清扫使用 |
| `src/tools.ts` | 按 `now.source` 分发 pause/resume/next/prev/volume/stop |
