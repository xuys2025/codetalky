/* Demo data: the same sessions as the design mockups. */
#include "ct_model.h"

#include <stddef.h>

#define COUNT(a) ((int)(sizeof(a) / sizeof((a)[0])))

static const char *const kTodos[] = {
    "复现残影问题", "读刷新相关代码", "改刷新分级", "写刷新计数器", "跑测试并回归",
};

static const ct_activity_t kActivity[] = {
    {"14:31", "Edit", "epd_driver.c", "+18 −7", false},
    {"14:30", "Bash", "idf.py build", "通过", false},
    {"14:29", "Read", "lv_adapter.cc", "88 行", false},
    {"14:27", "Edit", "epd_driver.c", "+36 −21", false},
    {"14:25", "Bash", "pytest tests/refresh", "失败 2", true},
    {"14:24", "Edit", "lv_adapter.cc", "+12 −9", false},
    {"14:22", "Write", "test_refresh.py", "+58", false},
    {"14:21", "Read", "epd_lut_partial.h", "64 行", false},
    {"14:20", "Read", "docs/epd-dither.md", "120 行", false},
    {"14:19", "Grep", "epd_refresh", "14 处", false},
    {"14:18", "Edit", "boards/config.h", "+8 −3", false},
    {"14:17", "Read", "epd_driver.c", "412 行", false},
    {"14:16", "Bash", "git status", "干净", false},
    {"14:15", "Grep", "PARTIAL", "9 处", false},
    {"14:14", "Read", "README.md", "96 行", false},
    {"14:13", "说", "先看刷新是怎么分级的", "", false},
};

static const ct_file_t kFiles[] = {
    {'M', "display/epd_driver.c", "+54 −28"},
    {'M', "display/lv_adapter.cc", "+12 −9"},
    {'M', "boards/config.h", "+8 −3"},
    {'A', "tests/test_refresh.py", "+58"},
};

static const ct_diff_line_t kHunkDriver[] = {
    {' ', "static int partial_n;"},
    {' ', "void epd_flush(rect_t r) {"},
    {'-', "  epd_refresh(PARTIAL);"},
    {'+', "  if (++partial_n >= 8) {"},
    {'+', "    epd_refresh(FULL);"},
    {'+', "    partial_n = 0;"},
    {'+', "  } else {"},
    {'+', "    epd_refresh(PARTIAL);"},
    {' ', "  }"},
    {' ', "  epd_wait_busy();"},
    {' ', "}"},
};

static const ct_diff_line_t kHunkHooks[] = {
    {' ', "// 等设备回话的最长时间"},
    {'-', "const TIMEOUT_S = 60;"},
    {'+', "const TIMEOUT_S = 600;"},
    {' ', "export async function onPermission(req) {"},
    {'+', "  if (!req.sessionId) {"},
    {'+', "    return deny('no session');"},
    {'+', "  }"},
    {' ', "  const card = toCard(req);"},
};

static const ct_option_t kOptions[] = {
    {"浏览器本地", "最简单，换设备就没了"},
    {"数据库里加一张表", "跨设备，要写迁移"},
    {"放进网址参数", "能分享链接，不记住上次"},
};

static const ct_para_t kReport[] = {
    {false, NULL, "给订单列表接口加了分页，默认每页 20 条，最多 100 条。"},
    {false, NULL, "这次改了这些："},
    {true, "接口", "：新增 page 和 size 两个参数，不传时结果和原来一样。"},
    {true, "查询", "：改成按主键翻页，十万条以上也不会变慢。"},
    {true, "测试", "：补了 4 个，连同原来的共 12 个，全部通过。"},
    {false, NULL, "两点说明："},
    {true, NULL, "接口文档还没改，需要的话说一声。"},
    {true, NULL, "旧客户端不用动，新参数都是可选的。"},
    {false, NULL, "下一步建议把前端列表页接上分页，要我继续吗？"},
};

static const char *const kQuickReplies[] = {
    "继续下一步", "跑一下测试", "提交这些改动", "先停一下，等我回电脑", "撤销刚才的修改",
};

#define DETAIL                                                                   \
    .todos = kTodos, .todo_count = COUNT(kTodos), .todo_done = 3,               \
    .activity = kActivity, .activity_count = COUNT(kActivity),                   \
    .files = kFiles, .file_count = COUNT(kFiles),                                \
    .hunk_title = "epd_driver.c · 第 214 行", .hunk_stat = "这一处 +5 −1",       \
    .hunk = kHunkDriver, .hunk_count = COUNT(kHunkDriver), .hunk_total = 4,      \
    .thinking = "局刷后残影没清干净。先加一个计数器，累计 8 次强制全刷，再跑一遍刷新测试。", \
    .summary = "读 21 · 改 4 · 新 1 · 命令 6",                                   \
    .report = kReport, .report_count = COUNT(kReport)

static const ct_session_t kSessions[] = {
    {
        .name = "codetalky", .agent = "claude", .model = "opus-5.5", .branch = "feat/hooks",
        .state = CT_STATE_WAIT_APPROVE,
        .verb = "Edit", .target = "src/bridge/hooks.ts", .stat = "+86 −21",
        .counts = "读 12 · 改 3", .when = "等了 2 分", .meta_right = "09:12 后回电脑确认",
        DETAIL,
        .hunk_title = "第 41 行", .hunk_stat = "+4 −1",
        .hunk = kHunkHooks, .hunk_count = COUNT(kHunkHooks),
        .reason = "60 秒太短，在设备上来不及点。改成 600 秒，并拒绝没带会话号的请求。",
        .expiry = "09:12 后回电脑确认",
    },
    {
        .name = "blog-engine", .agent = "codex", .model = "gpt-5", .branch = "main",
        .state = CT_STATE_WAIT_ANSWER,
        .verb = "问", .target = "筛选条件存在哪里", .stat = NULL,
        .counts = "读 7 · 改 0", .when = "等了 5 分", .meta_right = "任务 2/4 · 等了 5 分",
        DETAIL,
        .question = "用户保存的筛选条件，存在哪里？",
        .question_note = "列表页要记住每个用户上次的筛选，三种做法成本不一样。",
        .options = kOptions, .option_count = COUNT(kOptions),
    },
    {
        .name = "firmware", .agent = "claude", .model = "sonnet-5.5", .branch = "fix/refresh",
        .state = CT_STATE_RUNNING,
        .verb = "Edit", .target = "display/epd_driver.c", .stat = "+132 −40",
        .counts = "读 21 · 改 4", .when = "8 分 · 任务 3/5", .meta_right = "8 分 · 上下文 46%",
        DETAIL,
    },
    {
        .name = "landing", .agent = "claude", .model = "haiku-5.5", .branch = "main",
        .state = CT_STATE_RUNNING,
        .verb = "Bash", .target = "pnpm build", .stat = "+18 −6",
        .counts = "读 4 · 改 2", .when = "2 分 · 任务 1/3", .meta_right = "2 分 · 上下文 12%",
        DETAIL,
    },
    {
        .name = "api-server", .agent = "codex", .model = "gpt-5", .branch = "feat/paging",
        .state = CT_STATE_DONE,
        .verb = "Bash", .target = "npm test · 12 个全过", .stat = "+64 −12",
        .counts = "读 9 · 改 5", .when = "用时 12 分", .meta_right = "用时 12 分 · 读 9 · 改 5",
        DETAIL,
    },
    {
        .name = "docs-site", .agent = "claude", .model = "sonnet-5.5", .branch = "main",
        .state = CT_STATE_ERROR,
        .verb = "API", .target = "接口限流，已停在第 4 步", .stat = "+9 −2",
        .counts = "读 15 · 改 1", .when = "停了 20 分", .meta_right = "停了 20 分",
        DETAIL,
    },
};

int ct_model_session_count(void) {
    return COUNT(kSessions);
}

const ct_session_t *ct_model_session(int index) {
    if (index < 0 || index >= COUNT(kSessions)) {
        return NULL;
    }
    return &kSessions[index];
}

int ct_model_quick_reply_count(void) {
    return COUNT(kQuickReplies);
}

const char *ct_model_quick_reply(int index) {
    if (index < 0 || index >= COUNT(kQuickReplies)) {
        return NULL;
    }
    return kQuickReplies[index];
}
