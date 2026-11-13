# 外部审核材料（2026-11-14）

给审核者（Codex）看的。审核只读：不改文件、不提交、不推送，也不要跑会消耗模型额度的东西（见最后一节）。

## 项目一句话

CodeTalky 是一个随身的墨水屏设备（Metalio E-INK4，ESP32-S3，480×800，触摸），在局域网里显示多台电脑上 Claude Code 和 Codex 的工作状态，可以在设备上批准请求、回答提问、发新指令。硬件还没到，现在用仿真器开发：设备端的 C 代码原样编译成 WebAssembly 在浏览器或 Node 里跑。

```
设备（ui/，C + LVGL；仿真器 simulator/ 跑同一份代码）
   │  WebSocket，每台电脑一条连接；局域网连接要配对、全程加密
   ▼
电脑端服务 bridge/（Node 22，TypeScript，直接跑 .ts）
   │  Claude Code：HTTP 钩子（SessionStart 例外，走命令钩子）
   │  Codex：命令钩子，经 bridge/hooks/hook.mjs 转发
   │  托管终端：codetalky claude/codex 在伪终端里启动 agent，电脑端服务能往里打字、按键
   ▼
Claude Code / Codex（用户自己的终端里）
```

背景文档：`docs/PROTOCOL.md`（设备和电脑之间的协议，配对一节最重要），`docs/STATUS.md`（进度和每次实测的记录），`README.md`。

## 审核范围

提交 `79788bf..HEAD`（11-13 晚到 11-14），代码改动约 2900 行（不含 `third_party/`、截图）：

- `4789edb` 配对：限制同时等待的请求数，同码多请求都不配；设备默认只认加密连接
- `4dad566` 计划确认上设备，提问支持多选和自己写答案
- `3b71482` 配对加强：配对码由双方算出、密钥不上网，之后整条连接加密
- `cf4ff59` 状态文档：去掉两处过时的说法
- `9f7724e` 直接运行的 Codex 不等设备：电脑上直接答，设备只显示在电脑上等确认
- `ab55a64` 记录：测完撤掉了 Codex 钩子
- `71b4a42` 真 Codex 实测：托管的 Codex 用按键答终端里的确认框，改动从会话记录读
- `0c0c9d6` 真 Claude Code 实测托管终端和批准：修掉实测发现的几处问题

`third_party/`（Monocypher 4.0.2、cJSON）和 LVGL 本身不审，但怎么用它们要审。下面按重要程度分四块，A 最重要。

## A. 配对和加密（重点）

文件：`bridge/src/secure.ts`、`bridge/src/pairing.ts`、`bridge/src/link.ts`、`bridge/src/protocol.ts`（`auth`、`pair` 部分）、`bridge/src/server.ts`（`/device` 的来源检查）；设备端 `ui/src/ct_secure.c`、`ui/src/ct_proto.c`（`sec_t`、`on_auth`、`on_pairing`、`on_confirmed`、`handle`、`ct_proto_receive`、`send_json`）、`ui/include/ct_hal.h`；仿真器 `simulator/wasm/sim_main.c`。协议细节见 `docs/PROTOCOL.md` 的“配对”。

做法摘要：
- 配对像蓝牙的数字比对。双方各出一把临时 X25519 密钥；电脑先发 `commit = H(rB)`，设备发出自己的公钥和 `rD` 后，电脑才揭晓 `rB`。6 位码 = `H(PD, PB, rD, rB)` 前 4 字节模 10^6，两边各自算；用户把设备上的码输入电脑（`codetalky pair <码>`）。配对密钥 `K = H(S, PD, PB, rD, rB)` 不上网。电脑不打印配对码。
- 之后每条连接：电脑发 16 字节挑战 `nB`，设备回 `nD` 和 `proof = H(K, deviceId, hostId, nB, nD)`；两个方向各派生一把密钥；之后每帧 ChaCha20-Poly1305（RFC 8439），nonce 是方向内的序号；打不开或顺序不对就断开。
- `H` 是 BLAKE2b-512，先喂长度前缀的标签，变长字符串也带 1 字节长度前缀，截取前 32 字节。
- 同时最多 3 个配对请求在等，多了拒绝且不揭晓 `rB`；一个码对上两个请求就都不配。
- 设备端默认 `CT_REQUIRE_SECURE=1`（不认明文 `hello`）；只有仿真器编译成 0，因为电脑端信任本机来的明文连接（`isLoopback` 且没有 `Origin`）。

威胁模型：攻击者在同一个 Wi-Fi/局域网里，能抓包、发包、做中间人（如 ARP 欺骗），能连电脑端口。不能操作用户的电脑，摸不到设备。要保护的是：批准权限、“发指令”（等于能让 agent 在用户电脑上做任何事）、会话内容（代码、命令、文件名）。电脑本机的其他进程在信任范围内（钩子接口只对本机开放）。

请重点看：
1. 承诺、揭晓的顺序，在重试、并发请求、设备“换个新码”（重新发 `hello`）、断线重连这些情况下是否还成立，中间人能不能凑出相同的码。
2. 派生和证明：能否重放、反射，两个方向的密钥是否真的分开，有没有任何路径会让同一把密钥配同一个 nonce 用两次（重连、配对后切换、`pair again`）。
3. 明文和密文的切换规则有没有降级或绕过：电脑端 `link.ts` 的 `receive()`，设备端 `ct_proto.c` 的 `handle()`（`plain_ok`、等第一条密文时只收明文 `auth`）和 `ct_proto_receive()`。
4. C 端的边界：`ct_open()` 的 base64 解码和长度检查、`ct_seal()` 的缓冲区大小、`ct_unhex()`、内存释放和清零。
5. 随机数：设备端用 `ct_hal_random()` 每次 32 位拼起来（仿真器是 `crypto.getRandomValues`，真机将用 `esp_random`）。`simulator/tools/snapshot.mjs` 为了截图可重复，把设备和电脑两边的随机数都换成了固定种子（`entropy` 选项），确认这条路不会漏到正式运行里。
6. 电脑端把配对密钥明文存在 `~/.codetalky/devices.json`（写入时 `mode 0o600`，Windows 上不生效，靠用户目录的权限）。
7. 未认证的连接能消耗多少资源（每次 `auth` 生成一把 X25519 密钥，配对请求已限 3 个）。

已知局限（不用再报，除非你觉得我们低估了）：电脑上的 `devices.json` 被拿走就能冒充设备；真机固件还没写，NVS 键名限 15 字符要映射；局域网里的人能看到“有设备在连哪台电脑”这类元数据。

## B. 钩子和批准（Claude Code、Codex）

文件：`bridge/src/claude/source.ts`（两种 agent 共用的会话逻辑，最大的一块）、`bridge/src/claude/hooks.ts`、`bridge/hooks/hook.mjs`、`bridge/src/claude/tools.ts`、`bridge/src/claude/transcript.ts`、`bridge/src/codex/rollout.ts`、`bridge/src/codex/tools.ts`、`bridge/src/hub.ts`、`bridge/src/server.ts`（`handlePost`：只收本机、没有 `Origin` 的请求；agent 挂断时用 `AbortSignal` 通知）。

实测确认过的行为（11-13，见 `docs/STATUS.md` 第 7、10 项），代码是按这些写的：
- Claude Code：钩子等设备时，终端里同时弹出自己的确认框，先答的一方生效；终端答了以后 Claude 会挂断钩子请求。
- Codex 0.169：钩子运行期间不画自己的确认框；第一条指令提交时才发 SessionStart；`apply_patch` 不发 PostToolUse，它的 PreToolUse 报成 Bash；按 Esc 拒绝会结束这一轮且不发 Stop，只在会话记录里写 `turn_aborted`。
- 所以：Codex 不让钩子等。`codetalky codex` 启动的，设备的回答变成在终端里按键（见 C）；直接运行的 `codex`，设备只显示“在电脑上等你确认”（用户 11-13 定的）。Codex 的改动和中断从它的会话记录（`~/.codex/sessions/…/rollout-*.jsonl` 里的 `item_completed`、`turn_aborted`）读，干活期间每 2 秒读一次。

请重点看：
1. 挂起请求的生命周期：`hold`、`release`、`advance`、`settled`、`releaseKeyed`、超时、设备断开、agent 挂断，几条路径同时发生时会不会出错（比如重复 `finish`、队列里留下死请求、设备上残留旧的批准页）。
2. 托管运行的占位会话和别名（`waitFor`、`session()` 里的接管、`SessionEnd` 后转回等待）：会不会把别人的会话接到这个终端上，或者让设备能往错误的终端打字。
3. 回答格式：多选用 `", "` 连接、自己写的文字直接当答案、计划批准时带 `updatedInput` 和 `setMode: default`（这几条官方文档没写全，还没实测，见下面“待实测”）。
4. 会话记录读取：第一次读跳过历史、文件被重写、半行、很大的文件。
5. 设备动作的校验（`hub.ts` 的 `act()`、`protocol.ts` 的 `parseFromDevice()`）：`req` 必须是正在等的那个，多选只对 `multi` 的问题，文字长度上限。

待实测（还没跑真 agent，攒到最后一起测）：批准计划后 Claude 进哪个模式；能不能用任意文字回答 AskUserQuestion；PermissionRequest 是否一定为 ExitPlanMode 触发。

## C. 托管终端（替用户打字、按键）

文件：`bridge/src/run.ts`（启动器：伪终端、用 `@xterm/headless` 留一份屏幕、`press`、按顺序打字）、`bridge/src/runs.ts`、`bridge/src/server.ts`（`/run`：只收本机、没有 `Origin` 的 WebSocket）。

风险在于键被打进了错误的地方。现在的防护有两条：
- 按键（`press`）之前，先看屏幕上确实有确认框（`expect`，Codex 的是 `Yes, proceed|Press enter to confirm`）。
- 打字之前，先等屏幕上没有任何确认框（`PROMPT_UP`）。不然一条指令末尾的回车（或指令里的字母 y）会替用户答掉确认框。

请重点看：竞态（看屏幕和真正写入之间画面变了）、正则的误判和漏判（比如 agent 输出的内容里正好有 “Yes, proceed”）、Esc 在不该按的时候被按下（Codex 干活时按 Esc 会中断这一轮）、运行令牌（`CODETALKY_RUN`）的处理。

## D. 设备界面的新功能

文件：`ui/src/ct_ui.c`（计划页 `show_plan`、多选 `on_pick`/`on_picked`、回复页的三种用途 `s_reply_mode`/`send_words`、BOOT 键）、`ui/src/ct_proto.c`（`parse_ask` 的 plan 和 multi、`ct_proto_send_back`、`ct_proto_answer_many`、`ct_proto_answer_text`）、`ui/include/ct_model.h`。

请重点看：用户正在看的请求被换掉时（`s_req`、`s_picked` 的重置）会不会把回答发给新请求；回复页从提问或计划进入、而请求已经没了时会怎样；arena 里字符串的生命周期。

## 怎么验证

```sh
cd bridge
npm install
npm run check      # tsc，应无输出
npm test           # 92 个测试
```

用真正编译的设备代码跑一遍配对。这台电脑上已经编译好了（`simulator/web/gen/`，不进 git，和当前代码一致；重新编译要在 WSL 里 `bash simulator/build.sh`）：

```sh
node simulator/tools/snapshot.mjs out.png --pair --approve --relink 0 --tap 240,248 --tap 356,756 --verbose
```

正常时退出码 0，`--verbose` 能看到配对之后设备发出的都是 `E…` 开头的密文。全部界面截图：`bash simulator/tools/render-ui.sh`（输出到 `design/renders/`，会改写文件，只读审核时不要跑）。

不要跑：`codetalky claude`、`codetalky codex` 和 `bridge/test` 以外的实测脚本，它们会启动真 agent、消耗额度。现在 `~/.claude/settings.json` 和 `~/.codex/hooks.json` 里都没有 CodeTalky 的钩子，审核期间运行的 Codex 不会连到电脑端服务。

## 希望你回答的

1. A 的协议在上面的威胁模型下有没有能被利用的漏洞，严重的先说。
2. 有没有你认为必须在接真机之前改的地方。
3. 托管终端按键、打字的防护够不够，有没有更稳的做法。
4. B 里有没有会让设备批准到别的请求、或者把回答发错会话的竞态。
5. 其他明显的 bug 或测试漏掉的情况。

每条发现请写：严重程度（高、中、低、建议）、文件和行号、问题、怎么触发、建议的改法。
