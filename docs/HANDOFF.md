# PirateRadioFM — 交接文档 / Handoff

> 给未来接手改代码的人（或 AI model）看的。目标：**5 分钟内理解这个项目的核心难点、不变量、以及"改 X 要动哪些文件"。**
> 最后更新：2026-07（HÖR cookie 认证修复、文档补全）。

---

## 1. 这个项目是什么

在 CLI 编码代理（Claude Code / Codex / OpenCode / Hermes / pi）里放网络电台、播客、Spotify、Apple Music。

- 语言：TypeScript，编译成 4 个自包含 bundle 放在 `dist/`（**入库**，插件直接跑，无需 `npm install`）。
- 依赖：只有 `@modelcontextprotocol/sdk`。dev 依赖只有 esbuild + typescript。**保持这种克制**。
- 两个运行入口：
  - **MCP server**（`dist/index.js`）— 供 Claude Code / Codex / Hermes 用，stdio 协议。
  - **CLI**（`dist/cli.js <tool> [args]`）— 供 slash command / pi 用，argv → tool handler 直接映射，无协议握手。

---

## 2. 最重要的一件事：进程生命周期（改任何东西前先懂这个）

整个项目最难、最不能碰坏的是**"音乐不能在会话结束后还在放"**。它靠一套层层兜底实现，每一层失败都有下一层接住：

1. **anchor**（`state.ts`）— MCP server 启动时把自己的 `{pid, token}` 写到 `~/.pirate-radio/anchor.json`。它是会话进程的子进程，会话关了它就死。`token` 是进程启动时间指纹，**防 PID 复用**（系统回收 PID 后 token 不匹配 → 判定会话已死）。
2. **watchdog**（`watchdog.ts`）— play 时 spawn 的 detached 进程，轮询 anchor 是否还活。会话死 → 杀播放器。即使 SessionEnd hook 不触发也兜底。
3. **registry**（`registry.ts`）— 跨进程锁保护的 player/watchdog PID 表（`~/.pirate-radio/players.json`）。**PID 不放在 state.json 里**，因为两个 CLI 并发写 state.json 会 lost-update 把 PID 冲掉、孤儿化播放器（这正是"音乐停不掉"的历史根因）。
4. **orphan sweep**（`player.ts` 的 `sweepOrphans`）— 最后防线。扫描命令行里带我们 stream host 的 mpv/ffplay 进程直接杀，哪怕它逃出了 registry。host 来源 = `stations.json` 的 hosts + `dynhosts.ts`（播客 CDN 等动态 host）。
5. **启动清扫**（`index.ts`）— 启动时若发现上个会话的 anchor 已死，先 `stop()` 清掉残留再接管。若发现另一个 anchor **还活着**，拒绝启动第二个 server（避免两个会话互杀音乐）。

**改动警告：**
- 加新音源且它用**本地播放器**（mpv/ffplay）→ 它的 stream host 必须能被 orphan sweep 找到。静态台加进 `stations.json`；动态 host（每次不同，如 googlevideo、播客 CDN）调 `rememberHost()`（见 `hoer.ts`、`podcast.ts`）。**漏了这一步 = 那个音源的"停止"保证失效。**
- 加新音源且它是**远程 app**（Spotify/Apple Music）→ 不用管 orphan sweep（它们不经过本地播放器），但要在 `tools.ts` 的 pause/stop/resume/next/prev 分支里处理。

---

## 3. 文件地图（改 X 动哪里）

```
src/
  index.ts        MCP server 入口。anchor 生命周期、启动清扫、stdin-close 清理。
  cli.ts          CLI 入口。argv → tool。doctor 有独立只读分支（不走 withState 锁）。
  tools.ts        所有 MCP tool 定义 + handler。← 加命令主要动这里
  doctor.ts       环境诊断（/doctor）。只读，永不 throw，有 fail 时 CLI 退出码=1。
  state.ts        NowPlaying 状态 + anchor。withState() 是 tool handler 的标准包裹。
  registry.ts     跨进程锁保护的 player/watchdog PID 表。
  lock.ts         跨进程锁原语（mkdir 原子性 + holder-pid + mtime 偷锁）。
  player.ts       本地播放器（mpv/ffplay）spawn + stop + orphan sweep。
  proc.ts         跨平台进程原语：pidAlive / startToken(防复用) / killPid / 找孤儿。
  watchdog.ts     detached 会话看门狗。
  stations.ts     读 data/stations.json；genres()、hosts()（orphan sweep 的匹配集）。
  dynhosts.ts     动态 host（播客/HÖR CDN），也进 orphan sweep 匹配集，有上限。
  argparse.ts     CLI argv → tool args（按 schema 决定是否把 "50" 转成数字）。
  selfcheck.ts    node:test 测试套件（跑 `node --test dist/selfcheck.js`）。
  lifecyclecheck.ts 跨进程生命周期集成测试（隔离 HOME，测试 bundle 写入 `.test-dist/`，不随插件发布）。
  sources/
    radio.ts       内置台切换。
    spotify.ts     OAuth PKCE + 远程控制已运行的 Spotify 客户端。最长、最脆。
    podcast.ts     iTunes 搜索 + RSS 解析 + tracking-URL 去壳。
    applemusic.ts  macOS 专属，走 AppleScript 控制 Music.app。
    hoer.ts        HÖR Berlin，抓网页 videoId → yt-dlp 解析（需 YouTube cookies 认证）→ 本地播放器。
data/stations.json  台数据（单一真相源：genre 列表、host 列表都从这派生）。
commands/*.md       slash command 定义。install.mjs 从这动态发现，5 个 agent 共用。
install.mjs         非-Claude agent 的安装器。从 commands/*.md + stations.json 派生。
build.mjs           esbuild 打包 4 个入口到 dist/。
.claude-plugin/     Claude Code 插件清单（MCP server 注册）。
docs/sources.md     各音源行为说明（中英双语）。
```

---

## 4. 关键不变量（别破坏）

- **dist/ 必须与 src/ 同步且行尾符为 LF。** 改了 src/ 一定跑 `npm run build` 并把 dist/ 一起提交。CI 有一步验证 dist/ 是否与 src/ 编译结果一致（在 ubuntu 上跑）。`.gitattributes` 保证 Windows checkout 后 dist/ 不显示假脏——**别删它**。
- **单一真相源**：genre metadata、兼容 aliases、stream 和 host 列表都从 `data/stations.json` 派生（`radio_play` 的 description、`install.mjs` 的 SKILL.md genre 行、`hosts()`）。加台只改 stations.json，别在别处手抄一份（历史上 install.mjs 手抄漏了 `npr`，已改成派生）。
- **命令自动分发**：加 slash command = 在 `commands/` 加一个 `.md`（照抄现有格式）+ 在 `tools.ts` 加对应 tool。`install.mjs` 会自动把它装到所有 agent，**不用改 install.mjs**。
- **tool handler 通过 withState() 包裹**（见 index.ts / cli.ts）：入口 fresh-load state、出口原子保存，全程持锁。**例外**：`doctor` 只读，在 cli.ts 里走独立分支跳过锁。
- **用户意图优先于远程调用成败**：pause/stop/volume 即使底层 API 失败也要更新 `now.state`（否则 `now-playing` 会撒谎）。见 tools.ts 里的 `try { ... } catch { /* keep going */ }` 模式。
- **spotify.ts 的 API 响应类型是手写窄类型**（不是 Zod）：字段全 optional，因为 Spotify 会省略。运行时靠 `?.` / `?? []` / 显式 `if (!token) throw` 兜底，类型只是编译期检查。加新字段就往对应 interface 加。

---

## 5. 常见改动配方

**加一个内置电台 genre：**
1. 在 `data/stations.json` 的 `genres` 下增加带 `label`、`description`、`stations` 的 genre；兼容旧命令时在 `aliases` 中映射。
2. 在 `commands/` 加 `genrename.md`（照抄 `jazz.md`，改 `genre=genrename`）。
3. `npm run check`（会验证 catalog schema、精确 genre 集合、aliases、host 唯一性、命令映射和生命周期集成测试）。需要联网检查全部 stream 时另跑 `npm run check:stations`。
4. 如果这个 genre 要出现在 selfcheck 的 expected 列表里，去 `selfcheck.ts` 加上。
5. `npm run build`，提交 src + dist + commands + data。

**加一个新命令（非播放）：**
1. `tools.ts` 加 tool（name、description、schema、handler）。
2. `commands/xxx.md`。
3. selfcheck.ts 的 tool 列表加 name（那个测试会强制命令↔tool 一致）。
4. README ×2 的表格手动加一行（README 是人读的，没自动化）。
5. build + 提交。

**加一个新音源（如 YouTube、SoundCloud）：**
- 这是最大的改动。目前 `tools.ts` 对 4 个音源用 `if (now.source === ...)` 分支（next/prev/pause/resume/volume/now_playing）。**加第 5 个音源时，考虑把音源抽象成统一接口**（`PlaybackSource { play/pause/resume/next/prev/stop/nowPlaying }`），否则分支会散。这是目前架构里唯一"到点就该重构"的地方。
- 本地播放器音源记得处理 orphan sweep 的 host（见第 2 节警告）。

---

## 6. 验证 / 命令

```bash
npm run typecheck          # tsc --noEmit
npm run build              # esbuild → dist/（4 个 bundle）
npm run check              # typecheck + build + selfcheck + lifecyclecheck
node dist/cli.js doctor    # 环境诊断（player/yt-dlp/spotify/anchor/stream 连通性）
node dist/cli.js radio_list
node install.mjs --uninstall   # 注意：会真的改本机 agent 配置，别随便跑
```

CI（`.github/workflows/ci.yml`）：ubuntu + windows + macos 三平台跑 `npm run check`，再验证 dist/ 同步。`.github/workflows/station-health.yml` 每周一 08:00 UTC 运行 `npm run check:stations`，与普通 PR CI 分离。

---

## 7. 已知的小债 / 未来方向（不紧急）

- **install.mjs 用字符串编辑 TOML/YAML**（JSON 走 parser）。个人工具够用，但面向陌生用户发布前建议：parser 化 + `--dry-run` + 写前备份 + `# BEGIN/END PirateRadioFM` 标记块。
- **`radio_doctor` MCP tool 会走 withState 锁**（doctor 只读，不必），但只是几十 ms 开销，没害处。CLI 的 `doctor` 分支已跳过锁。
- **withState 持锁跨越 Spotify API 往返**（可能几百 ms），30s 才偷锁。并发 tool call 罕见，可接受，但知道这点。
- **anchor token 在中文 Windows 上是本地化字符串**（PowerShell CreationDate），只比较相等所以功能正常，看起来是乱码但无碍。
- **外部源天然脆**：stream URL 会变、Spotify 需 Premium+active device、HÖR 依赖网页结构 + yt-dlp + YouTube cookies（会过期，需定期重新导出）、播客 RSS 格式各异。`/doctor` 是排障第一站。

---

## 8. 状态目录

运行时状态都在 `~/.pirate-radio/`：
- `state.json` — NowPlaying（genre、音量、Spotify token 等），原子写 + 锁。
- `state.lock` / `players.lock` — 两个独立锁域（互不阻塞）。
- `anchor.json` — 会话 anchor（pid + start-token）。
- `players.json` — player/watchdog PID registry。
- `spotify.json` — OAuth token（`0o600` 权限）。
- `dynamic-hosts.json` — 动态 host 列表（orphan sweep 用），有上限。
- `cookies.txt` — YouTube cookies（HÖR 用，Netscape 格式，用户手动导出）。
