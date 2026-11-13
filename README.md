# CodeTalky

随身的 AI agent 遥控器：在 Metalio E-INK4 墨水屏设备上查看电脑里 Claude Code、Codex 的工作状态，用语音和点按给它们下指令、批准请求、回答问题。

项目介绍与计划书：<https://claude.ai/artifact/CviDQkserZPJPT9fmrzBWL>

## 目录

| 目录 | 内容 |
| --- | --- |
| `ui/` | 设备界面，C + LVGL 9.5。仿真器和真机固件共用同一份代码 |
| `simulator/` | 网页仿真器外壳：把 `ui/` 编译成 WebAssembly，模拟墨水屏、按键、麦克风 |
| `bridge/` | 电脑端服务，TypeScript。连接设备和 agent：钩子、托管终端、语音识别 |
| `firmware/` | 真机固件工程：`ui/` 加官方驱动层（硬件到货后启用） |
| `Metalio-E-INK4/` | 官方固件仓库，只读参考，不纳入本仓库 |

## 运行仿真器

先生成字库（在 Windows 上跑；改了界面文字或换了字体后要重跑）：

```sh
uv run --with freetype-py -- python -I tools/fontpack/build_fonts.py tools/fontpack/fonts.json
```

字体文件放在 `third_party/fonts/`，来源见那里的说明。生成的字库在 `ui/fonts/gen/`，不进 git。

再编译。编译在 WSL 里做，需要 `~/emsdk` 里装好 Emscripten SDK：

```sh
bash simulator/build.sh
```

首次编译会下载 LVGL 9.5.0。如果 WSL 里连不上 GitHub，在命令前加 `CT_PROXY=http://<Windows 主机 IP>:<代理端口>`。

启动电脑端服务（Windows 上，要 Node 22.18 或更新版本）。`--fake` 是用假 agent 跑六个演示会话，同一个端口顺带提供仿真器页面：

```sh
cd bridge
npm install
npm run demo        # 即 node src/main.ts --fake；加 --speed 4 可以快进
```

然后打开 <http://127.0.0.1:8137>。设备连 `ws://127.0.0.1:8137/device`，协议见 `docs/PROTOCOL.md`。电脑端的检查和测试：`npm run check`、`npm test`。

不开浏览器也能出图，适合在脚本里检查界面。假 agent 和电脑端服务在同一个进程里跑，用假时钟，每次出的图都一样：

```sh
node simulator/tools/snapshot.mjs out.png --tap 240,248 --hold 360,756 --ms 5000
bash simulator/tools/render-ui.sh   # 全部界面，输出到 design/renders/ui-*.png
```

## 接 Claude Code

让 Claude Code 把事件发给电脑端服务（加到你的用户设置里，旧文件会留一份 `.codetalky.bak`）：

```sh
cd bridge
node src/main.ts hooks --merge ~/.claude/settings.json
node src/main.ts            # 起服务；加 --fake 可以同时看演示会话
```

之后在任何终端里开的 Claude Code 会话都会出现在设备上，批准请求和它的提问可以在设备上回答。终端里的确认框也照常弹出，在哪边答都行，另一边自动收起；设备没连上或期限内没回话时，就只在终端里答。不用了就 `node src/main.ts hooks --remove ~/.claude/settings.json`。细节见 `docs/STATUS.md` 的“第 7 项”。

想从设备给 Claude 发新指令，用 `codetalky claude` 代替 `claude` 启动（参数照旧）。在 `bridge` 目录运行一次 `npm link`，之后任何终端里都有 `codetalky` 命令；不想装就用 `node <仓库>/bridge/src/main.ts claude`。它在终端里看起来和直接运行 `claude` 一样，一启动设备上就有这个会话，设备发来的指令会像键盘输入一样打进去。它正在干活时，设备发来的指令先存着，等这一轮做完再打进去（干活中途它随时可能弹确认框，指令末尾的回车会替你答掉）。

Codex 也一样，只是它的钩子只能是命令，并且新钩子要先在 Codex 里信任一次：

```sh
node src/main.ts hooks --codex --merge ~/.codex/hooks.json
codex          # 进去后输入 /hooks，信任 CodeTalky 的钩子
codetalky codex  # 想从设备发指令时用它代替 codex 启动
```

和 Claude 有两点不同：

- Codex 在钩子等待期间不显示自己的确认框，所以不让钩子等。用 `codetalky codex` 启动时，确认框立刻出现在终端里，设备上的批准、拒绝就是替你在终端里按 `y`、Esc，两边都能答。直接运行 `codex`（或桌面版）时，只能在电脑上答，设备上显示“在电脑上等你确认”。
- 什么时候要批准由 Codex 的模型自己决定（审批策略只有 `on-request` 和 `never`）。在默认的工作区可写沙盒里，它只在要越出沙盒时才问，所以批准请求比 Claude 少。

`~/.codex/` 是 Codex 命令行和桌面版共用的，桌面版的设置里也有钩子信任，所以桌面版里的会话应该也会出现在设备上（还没实测）。

有几台电脑跑 agent，就在每台上都开电脑端服务，用 `--name` 起个名字（比如 `--name 台式机`），设备会同时连上所有电脑。

真机要从局域网连电脑，服务得监听局域网地址：`node src/main.ts --host 0.0.0.0 --name 台式机`。设备第一次连这台电脑时会提示配对：在这台电脑上运行 `codetalky pair`，设备屏幕上会出现 6 位配对码，按提示输入它，再在设备上点“配好了”，以后自动认得，连接全程加密。`codetalky devices` 看已配对的设备，`codetalky unpair <名字>` 撤销。

## 现状

第 1 阶段（设计与骨架）进行中。硬件未到货，开发都在仿真器上做。

- 已有：九个触摸界面（`ui/src/ct_ui.c`），数据从电脑端服务经 WebSocket 收来；电脑端服务（`bridge/`），接了 Claude Code 和 Codex 的钩子、托管终端、多台电脑，还有按剧本走的假 agent；字库生成工具；仿真器（只刷有变化的像素，先黑白、停下后叠加灰度，参数是占位值）；无浏览器截图工具。
- 还没有：语音、固件工程。

进度和结论见 `docs/STATUS.md`。
