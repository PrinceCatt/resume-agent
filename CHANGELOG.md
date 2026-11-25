# 更新记录 / Changelog

## 未发布 / Unreleased

- README 加了截图（虚构的演示数据）。/ Screenshots in the README, made with made-up sample data.
- 岗位详情的简历预览在笔记本屏幕上不再被切掉右边：整页按栏宽缩放。/ The resume preview on the job page is scaled to its column instead of being cut off on laptop screens.

## 0.2.0 — 2026-11-25（第一个公开版本 / first public release）

**省钱 / Spending less on the model**

- 发给模型的岗位文字只留正文：LinkedIn 的登录菜单、「Similar jobs」，MyCareersFuture 的 cookie 提示和页脚先去掉（约 24,000 字 → 3,000 字）。
- 资料库放在提示词最前面、日期放到最后，DeepSeek 按缓存价计费的部分更多。
- 填表时页面只是填了值、结构没变，就只发变化的字段（约 70 tokens，原来每步重发整页约 3,000 tokens）；整页快照里表单外的普通按钮最多列 40 个。
- 岗位内容、资料库、提示词都没变时，「重新读取岗位」沿用上次结果，不调用模型。
- 要 JSON 的地方要求压成一行。
- 「等闲时再处理」：批量的改简历、填表等 DeepSeek 半价时段再开始，有空位才开始下一个。

**看得见花费 / Seeing what it costs**

- 设置页、每个岗位都显示约花了多少钱（按 DeepSeek 价目和每次调用所在时段估算）。
- 显示 DeepSeek 账户余额；余额用完就停下所有调用，岗位页出现「充好了，继续」，不再一个个报错。

**岗位筛选和求职信 / Filters and cover letters**

- 读岗位时存下原文写明的条件（全职 / 兼职 / 实习、经验、学历、在读或已毕业、公民 / PR 限制、要交的材料），列表可按这些筛选、看统计。
- 匹配度对照「想找什么」：要兼职实习的人遇到全职实习等明确冲突，分数最多 45，由程序卡住。
- 只给要求求职信的岗位写（或在设置里改成都写），表单要了会现写一封。

**其他 / Other**

- 程序重启时，读取或改简历到一半的岗位不再一直显示「进行中」。
- 公开前的整理：测试和模拟页里只用虚构的资料；MIT 许可证；GitHub Actions 跑类型检查、测试和构建；`pnpm serve` 在 macOS / Linux 上一条命令构建并启动。

## 0.1.0 — 2026-11

第一版：读岗位、按岗位改简历（只用资料库里的事实，有出处校验）、agent 在你自己的 Edge 里填申请表并停在提交前、找岗位、投递跟进、日程、面试准备、统计。
