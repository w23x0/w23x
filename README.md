# 个人陪伴分身

一个长期运行的 TypeScript 应用：深刻理解用户并以用户身份陪伴用户。运行时仅使用 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core`，应用层持有全部数据。

## 架构：runtime 与应用层分离

- **runtime**：`pi-ai` / `pi-agent-core` 负责模型调用与 agent 循环。应用不读取 `~/.pi` 或任何 Pi/omp 配置，也不写 `process.env`。
- **应用层**：数据以纯文件形式在 `dataDir` 中管理。不引入工具市场、MCP、bash 或浏览器工具。渠道仅 Telegram 与 Discord。
- 支持模型：通过 `ModelSpec` 配置 `provider/id/baseUrl/apiKey/api` 等；_refllectionModel_ 可单独配置。

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

import 是唯一需要构造模型的 CLI 命令，仍不启动渠道适配器。

守护进程运行时执行 `import`，两个进程可能各跑一次反思；理解层写入受版本校验保护，不会互相覆盖，只是重复工作。

## 主动探询与反思

- **反思**：空闲 `idleMinutes` 后触发；只在有新原始记录时运行。反思 prompt 只说明新记录数量、时间范围与导入记录事实，不塞原文；agent 自行决定是否更新理解层。
- **主动唤醒**：agent 通过 `schedule_next_wake` 自行安排下次唤醒；未安排时按 `proactiveFallbackMinutes` 兜底；`proactiveMinMinutes` 为安全下限。是否联系用户、说什么，完全由 agent 判断。
- 冷启动条件：原始记录中还没有任何 `user` 或 `proactive` 消息（还没直接聊过）时触发。
- 导入的种子对话 role 为 `import`，不进入在线会话上下文，由 agent 按需检索。

用户在对话中表达的交流偏好，由 agent 在反思中自行识别并写入理解层，代码不硬编码任何具体偏好。

## 安全

- 只允许配置的本人用户 id（Telegram/Discord fail-closed）。
- 理解层路径守卫：拒绝 `..` 越界、绝对路径、`.git` 路径段、空路径或 base 本身、符号链接逃逸。
- 加密备份：`AVBK1` + salt(16) + iv(12) + authTag(16) + AES-256-GCM 密文；key = scrypt(passphrase, salt, 32)。口令错误或被篡改时恢复抛错，且不写出任何文件。单个段落超过 4000 字符时保持为一条记录，不破坏原文。