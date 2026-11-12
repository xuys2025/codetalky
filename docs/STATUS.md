# 进度与结论（2026-11-13 晚）

下次继续开发时先读这一页。

## 线上的两份东西

- 项目介绍与计划书：<https://claude.ai/artifact/CviDQkserZPJPT9fmrzBWL>
- 界面设计稿画布：<https://claude.ai/artifact/8V3tAD9ZErgLhb3kdHYjxV>

这两份在 Claude 账号里，是私有的。本地都有离线副本（2026-11-13 晚导出）：

- 计划书：`docs/计划书.md`，三张图在 `docs/计划书-图/`。
- 设计稿：`design/mockups/`，每张一个 HTML 和一张截图，不联网也能看。
- 按真机像素渲染的图：`design/renders/`。
- 画布源文件：`design/canvas/`。

线上改了以后本地不会自动更新。重新导出的办法：计划书用 `tools/export-plan.mjs`，设计稿用 `tools/export-mockups.mjs`。

## 已经定下来的

- 只在同一个 Wi-Fi 下用；语音识别用豆包云端接口，凭据到第 3 阶段再给。
- 只接 Claude Code 和 Codex。
- 界面用 LVGL 自己写，不用官方的 A2UI；官方的阅读、壁纸等应用不保留。
- agent 接入用钩子（看状态、批准、拒绝）加托管终端（发新指令），借鉴 Kiteline。
- 界面方向是“工作台”紧凑版：会话列表、三页会话详情（概览、活动、改动）、批准、语音确认、完成汇报。你已在计划书里把“界面风格”这一项勾选确认。
- 内容多了就分页，音量上下键翻页。

## 还没定的

- 显示方式：操作时纯黑白快刷，停下后叠加一遍灰度。你说“灰度刷新不错”，但还没明确拍板。
- 字体：我建议更纱黑体（Sarasa UI SC），等你确认。
- 正文字号 20 还是 22：20 号一页约 20 行，22 号更清楚但少两行。

## 今晚查清的事实

屏幕（来自仓库里的数据手册，DKE DEPG0397BBS77AF11HP）：

- 3.97 寸，480×800，235 DPI，显示区 51.84 × 86.40 毫米。
- 屏厂只保证黑白两级；出厂波形整屏全刷 3.2 秒（25℃）；工作温度 0 到 50℃。
- 对比度约 7:1，白底反射率 30%，真屏没有纯白纯黑。
- README 和代码注释写的是 GDEM0397T81，和数据手册不是同一家，到货后看排线标签确认。

官方驱动（`Metalio-E-INK4/main/display/LUT/` 和 `esp_lcd_panel_ssd1677.c`）：

- 局刷波形 17 帧（注释标 50 Hz，约 0.34 秒），并留有改成 100 Hz 的注释。
- 快速全刷 40 帧（约 0.8 秒）。
- 看书模式的抗锯齿是“黑白底图加灰度叠加”，叠加这一遍 12 帧，只有白、浅灰、深灰、黑四档。
- 以上耗时都是按波形表算的，没有实测。

文字渲染（`tools/fontbench/` 里的脚本可以重跑）：

- 浏览器画的示意稿有灰度平滑，比真机好看，不能拿来判断清晰度。
- 纯黑白要用 FreeType 的黑白栅格器。没有像素对齐信息的字体（MiSans、思源黑体）必须强制自动对齐，否则笔画忽粗忽细。
- 更纱黑体自带像素对齐信息，纯黑白下最整齐，OFL 许可可以随固件分发。
- 字重用常规体；中等字重在 20 号下笔画多的字会糊。

会话数据（`tools/transcript-shape.mjs` 可以重查）：

- Claude Code 的会话记录里有模型名、每一步的工具和文件路径、每次修改的逐行补丁、说明文字、git 分支和 token 用量。
- Codex 的记录格式还没核对。

## 代码现状

- `simulator/`：LVGL 9.5 编译成 WebAssembly 的流程、浏览器外壳、墨水屏刷新模型（参数是占位值）、无浏览器截图工具。已验证能跑。
- `ui/`：只有一个验证用的界面。
- `bridge/`、`firmware/`：空。
- WSL 里装了 Emscripten 7.0.0（`~/emsdk`）。WSL 直连 GitHub 不通，要走 Windows 上的代理，见 README。

## 明天从这里开始

1. 你确认显示方式、字体和字号。
2. 写字库生成工具：用黑白栅格化把更纱黑体做成 LVGL 字库（黑白一份，灰度一份）。
3. 在仿真器里加上“黑白底图加灰度叠加”的两步刷新。
4. 用 LVGL 写七个界面，先做会话列表和完成汇报。
5. 写假 agent，让界面跟着剧本变化。
6. 在 WSL 里装 ESP-IDF v5.5.4，确认官方固件能原样编译。

## 常用命令

```sh
# 编译仿真器（WSL 里）
bash simulator/build.sh
# 启动仿真器页面，然后打开 http://127.0.0.1:8137
python -m http.server 8137 --bind 127.0.0.1 -d simulator/web
# 按真机像素渲染一页（黑白和灰度叠加两种）
uv run --with pillow --with freetype-py -- python -I tools/fontbench/screen.py tools/fontbench/configs/screens4.json design/renders
```
