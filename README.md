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

## 现状

第 1 阶段（设计与骨架）进行中。硬件未到货，开发都在仿真器上做。

- 已有：九个触摸界面（`ui/src/ct_ui.c`），数据从电脑端服务经 WebSocket 收来；电脑端服务（`bridge/`）和按剧本走的假 agent；字库生成工具；仿真器（先黑白、停下后叠加灰度的两遍刷新，参数是占位值）；无浏览器截图工具。
- 还没有：接真的 Claude Code 和 Codex（钩子、托管终端）、语音、固件工程。

进度和结论见 `docs/STATUS.md`。
