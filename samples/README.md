# 模拟样本

全部为**虚构的模拟聊天**，用于开发与自动化测试，不含任何真实用户资料（见 docs/business/privacy-retention.md §4）。

| 文件 | 用途 |
|---|---|
| chat-text/header-style.txt | 日期分隔行 + "发言人 时间" 头部 + 多行消息 + `[图片]` 占位 |
| chat-text/inline-with-time.txt | `[日期 时间] 发言人：内容`，含同一分钟内同一人连发 |
| chat-text/inline-no-time.txt | 无时间；含真实的连续重复发言（"在""在"） |
| chat-text/uncertain-lines.txt | 无法归属说话人的行（须交给用户确认，不猜测） |
| chat-text/date-only.txt | 只有日期、没有时间（时间精度=日期） |
| chat-text/injection-and-placeholders.txt | 聊天中的指令注入文本、语音占位、撤回系统消息 |

声明"支持"的解析器必须在此目录有样本与测试；微信/抖音导出文件格式在拿到真实格式样本前不声明支持。
