# 个人陪伴分身

一个长期运行的 TypeScript 应用：深刻理解用户并以用户身份陪伴用户。运行时仅使用 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core`，应用层持有全部数据。

## 架构：runtime 与应用层分离

- **runtime**：`pi-ai` / `pi-agent-core` 负责模型调用与 agent 循环。应用不读取 `~/.pi` 或任何 Pi/omp 配置，也不写 `process.env`。
- **应用层**：数据以纯文件形式在 `dataDir` 中管理。不引入工具市场、MCP、bash 或浏览器工具。渠道仅 Telegram 与 Discord。

## 两个角色

- 分身（persona）：`chat` / `proactive`，运行在 Telegram/Discord，使用主模型 `models.primary`。负责像他一样聊天与陪伴；**只读**理解层。
- 理解者（observer）：`reflection` / `interview`，运行在后台与本机终端，使用 `models.reflection`。负责研究他、追问、维护理解层；读写删。
- 理解者维护 `persona.md` 简报，每一轮分身都会看到；其它理解层文件不预加载，分身需要时用工具读。

## 模型

- 支持模型：通过 `ModelSpec` 配置 `provider/id/baseUrl/apiKey/api` 等；`reflectionModel` 可单独配置。

## 数据布局（dataDir，默认 ./data）

```
dataDir/
  raw/messages-YYYY-MM-DD.jsonl   只追加原始记录（user / assistant / proactive / import）
  raw/media/                     图片、语音原件
  understanding/                 agent 自主管理的理解层，本身就是 git 仓库
  state/                         运行状态（不进 git）：reflection-cursor.json, contacts.json, next-wake.json, proactive-log.jsonl
```

- dataDir 根目录不是 git 仓库；git 仅存在于 `understanding/` 内，提交只含理解层文件。
- `config.json` 不得放在 dataDir 内；若存在，`loadConfig` 会报错。

## 配置

配置文件不在数据目录内。优先级：`--config` > `AVATAR_CONFIG` > `./avatar.config.json`（可不存在），再用环境变量覆盖。

```json
{
  "dataDir": "./data",
  "model": { "provider": "openai", "id": "gpt-4o", "apiKey": "sk-...", "input": ["text", "image"] },
  "reflectionModel": { "provider": "openai", "id": "gpt-4o-mini" },
  "idleMinutes": 15,
  "proactiveFallbackMinutes": 180,
  "proactiveMinMinutes": 10,
  "personaBriefMaxChars": 12000,
  "telegramToken": "123:abc",
  "allowedTelegramUserId": "42",
  "discordToken": "xxx",
  "allowedDiscordUserId": "7",
  "transcription": { "baseUrl": "https://api.openai.com/v1", "apiKey": "sk-...", "model": "whisper-1" },
  "backup": { "dir": "./backups", "intervalHours": 24, "passphraseEnv": "AVATAR_BACKUP_PASSPHRASE" }
}
```

环境变量：`AVATAR_DATA_DIR`, `AVATAR_MODEL`, `AVATAR_PROVIDER`, `AVATAR_BASE_URL`, `AVATAR_API_KEY`, `AVATAR_API`, `REFLECTION_*`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ALLOWED_USER_ID`, `DISCORD_BOT_TOKEN`, `DISCORD_ALLOWED_USER_ID`。

没有 `model.id` 会抛错（不默认任何模型）。

### 自定义 OpenAI 兼容端点

设置 `baseUrl` 即走自定义端点，`api` 默认 `openai-completions`。服务商要求的额外请求头写在 `headers` 里，代码中不硬编码任何服务商细节。例如 opencode Go 要求 `x-opencode-session`：

```json
"model": {
  "provider": "opencode-go", "id": "deepseek-v4.1-flash",
  "baseUrl": "https://opencode.ai/zen/go/v1", "api": "openai-completions", "apiKey": "...",
  "reasoning": true, "thinkingLevel": "low", "contextWindow": 1000000, "input": ["text", "image"],
  "headers": { "x-opencode-session": "avatar-companion-chat" }
}
```

反思模型同理，可以换成更强、更慢的模型或更高的 `thinkingLevel`。

`backup.dir` 不要放在数据目录里，否则每次备份都会把之前的备份一起打包进去。

## CLI 命令

- 运行守护进程：`node dist/index.js` 或 `run`
- `view` 查看理解层文件
- `history` 查看 git 历史
- `rollback <ref>` 回滚理解层
- `search <query>` 搜索原始记录
- `edit <path>` 编辑理解层文件
- `backup`：按配置立即备份到 `config.backup.dir`
- `restore <file> <targetDir>`：恢复备份（目标目录必须不存在或为空）
- `import <file> --label <说明> --date YYYY-MM-DD`：导入种子对话，触发一次反思
- `interview`：本机访谈。理解者先开口；`/exit` 或 Ctrl+D 结束并整理写入理解层，Ctrl+C 直接退出不整理。可与守护进程同时运行

import 与 interview 是仅有的需要构造模型的 CLI 命令，都不启动渠道适配器。

守护进程运行时执行 `import` 或 `interview`，理解层写入受版本校验保护，不会互相覆盖。

## 主动消息与反思

- **反思**：空闲 `idleMinutes` 后触发；只在有新原始记录时运行。反思 prompt 只说明新记录数量、时间范围与导入记录事实，不塞原文；agent 自行决定是否更新理解层。
- **主动唤醒**：agent 通过 `schedule_next_wake` 自行安排下次唤醒；未安排时按 `proactiveFallbackMinutes` 兜底；`proactiveMinMinutes` 为安全下限。是否联系用户、说什么，完全由 agent 判断。
- 冷启动：外部渠道不冷启动。第一次 `interview` 就是冷启动，理解者在已有理解（含导入的种子）上发起认识对话。
- 导入的种子对话 role 为 `import`，不进入在线会话上下文，由 agent 按需检索。

用户在对话中表达的交流偏好，由理解者自行识别并写入理解层，代码不硬编码任何具体偏好。

## 本机活动感知（sense）

让理解者知道他平时在电脑上做什么，包括不在电脑前的时候。采集交给 ActivityWatch，本应用只读它的本地 REST API。

### 采集组件（本机，systemd 用户服务）

- [awatcher](https://github.com/2e3s/awatcher)：内置 ActivityWatch 服务（`localhost:5600`）+ 窗口与离开检测。GNOME Wayland 需要扩展 [Focused Window D-Bus](https://extensions.gnome.org/extension/5592/focused-window-d-bus/)。
- [aw-watcher-media-player](https://github.com/2e3s/aw-watcher-media-player)：通过 MPRIS 记录正在播放的音乐与视频。
- 可选 [aw-watcher-web](https://github.com/ActivityWatch/aw-watcher-web)：浏览器扩展，记录网址与标签页标题。
- 另外直接读取：`gitRoots` 下本地仓库的提交、`claudeProjectsDir` 下 Claude Code 会话中他发出的消息。

### 配置

配置里有 `sense` 对象（哪怕是 `{}`）即启用：

```json
"sense": {
  "activityWatchUrl": "http://127.0.0.1:5600",
  "blockMinutes": 30,
  "lagMinutes": 5,
  "maxCatchupBlocks": 48,
  "gitRoots": ["~/projects"],
  "claudeProjectsDir": "~/.claude/projects",
  "githubUser": "your-name",
  "githubTokenEnv": "GITHUB_TOKEN",
  "exclude": { "apps": ["keepass"], "titlePatterns": ["bank|银行"], "domains": ["mail.google.com"] }
}
```

### 流程

- 守护进程每 5 分钟检查一次，按本地时间对齐的块（默认 30 分钟）处理：汇总信号 → 反思模型写一张时间线卡片（无工具）→ 追加到 `raw/activity-YYYY-MM-DD.jsonl`。没有任何信号（关机）或暂停的块不调用模型。
- 过了午夜生成前一天的日报 `raw/digests/day-YYYY-MM-DD.md`，并触发一次反思。
- 反思时理解者会看到新的卡片、日报与报告，用 `list_activity` / `read_activity` / `read_activity_file` / `search_activity` 查看，自行提炼进理解层。
- 状态：`state/sense-cursor.json`、`state/sense-pauses.json`、`state/sense-reflection.json`。

### 隐私

- `exclude` 命中的应用、标题、域名在汇总前就被抹掉，不会进入文件或模型请求。
- `sense pause <分钟>` 暂停记录，`sense resume` 恢复。
- 分身（Telegram/Discord）没有活动工具，看不到任何活动材料；只能通过理解者写进理解层的结论间接知道。

### CLI

- `sense tick`：立即处理待处理的块
- `sense today`：查看今天的时间线
- `sense status`：ActivityWatch 是否可达、bucket、游标、暂停状态
- `sense pause <分钟>` / `sense resume`
- `sense github`：抓取 GitHub 全貌报告（仓库、README、近一年提交）写入 `raw/sense/`，随后运行一次反思

## 安全

- 只允许配置的本人用户 id（Telegram/Discord fail-closed）。
- 理解层路径守卫：拒绝 `..` 越界、绝对路径、`.git` 路径段、空路径或 base 本身、符号链接逃逸。
- 加密备份：`AVBK1` + salt(16) + iv(12) + authTag(16) + AES-256-GCM 密文；key = scrypt(passphrase, salt, 32)。口令错误或被篡改时恢复抛错，且不写出任何文件。单个段落超过 4000 字符时保持为一条记录，不破坏原文。