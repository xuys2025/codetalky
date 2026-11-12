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

编译在 WSL 里做，需要 `~/emsdk` 里装好 Emscripten SDK：

```sh
bash simulator/build.sh
```

首次编译会下载 LVGL 9.5.0。如果 WSL 里连不上 GitHub，在命令前加 `CT_PROXY=http://<Windows 主机 IP>:<代理端口>`。

启动页面（Windows 或 WSL 都行），然后打开 <http://127.0.0.1:8137>：

```sh
python -m http.server 8137 --bind 127.0.0.1 -d simulator/web
```

不开浏览器也能出图，适合在脚本里检查界面：

```sh
node simulator/tools/snapshot.mjs out.png --tap 240,350 --key 0
```

## 现状

第 1 阶段（设计与骨架）进行中。硬件未到货，开发都在仿真器上做。

- 已有：LVGL 编译成 WebAssembly 的流程、浏览器外壳、墨水屏刷新模型（参数是占位值）、无浏览器截图工具。
- `ui/` 里目前只是一个验证用的界面，正式界面等风格选定后再写。
- 还没有：假 agent、电脑端服务、正式字体、固件工程。
