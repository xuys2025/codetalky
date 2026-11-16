# 字体文件

这个目录里的字体文件不进 git（体积大），只在本机保留。丢了可以按下面的地址重新下载。

| 目录 | 字体 | 用途 | 许可 | 来源 |
| --- | --- | --- | --- | --- |
| `sarasa-ui-sc/` | 更纱黑体 Sarasa UI SC（Regular、SemiBold、Bold） | 界面正文，目前的首选 | OFL 1.1 | <https://github.com/be5invis/Sarasa-Gothic/releases/download/v1.0.43/SarasaUiSC-TTF-1.0.43.7z> |
| `jetbrains-mono/` | JetBrains Mono Medium、ExtraBold | 路径、数字、代码；ExtraBold 用于标题和关机页 | OFL 1.1 | <https://github.com/JetBrains/JetBrainsMono/raw/master/fonts/ttf/JetBrainsMono-Medium.ttf>（ExtraBold 同目录） |
| `noto-sans-sc/` | 思源黑体 Noto Sans SC（可变字重） | 对照 | OFL 1.1 | <https://github.com/google/fonts/raw/main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf> |
| `lxgw-wenkai-screen/` | 霞鹜文楷 屏幕阅读版 | 候选，还没测 | OFL 1.1 | <https://github.com/lxgw/LxgwWenKai-Screen/releases/download/v1.530/LXGWWenKaiScreen.ttf> |
| `isas/` | ISAS 宋体点阵 gb16st、gb16fs、gb24st（BDF） | 点阵候选，还没测；GB2312 编码，没有半角字符 | X11 式宽松许可 | <https://www.x.org/releases/individual/font/font-isas-misc-1.0.4.tar.xz> |
| `terminus/` | Terminus 点阵等宽 18、20、22、24 号（BDF） | 点阵候选，还没测 | OFL 1.1 | <https://sourceforge.net/projects/terminus-font/files/terminus-font-4.49/> |

MiSans 和霞鹜臻楷在官方仓库里：`Metalio-E-INK4/tools/ttf-fonts/`。

调研时排除的：

- HarmonyOS Sans SC：许可只允许嵌入未修改的字体，做成位图字库有疑问。
- 霞鹜新晰黑：IPA 许可，不是 OFL。
- Zpix：商用要付费，且不允许转换。
- HZK16、HZK24：版权来源不清。
- 方舟像素、缝合像素：只有 8、10、12 号，太小。
