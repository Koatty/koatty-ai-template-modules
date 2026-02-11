# koatty-ai-template-modules

Koatty 模块代码生成模板，用于 `koatty add`、`koatty create` 等命令生成 controller、service、model、dto 等文件。

## 目录结构

- `controller/` — Controller 模板
- `service/` — Service 模板
- `model/` — TypeORM Entity 模板
- `dto/` — DTO 模板
- `aspect/` — AOP 切面模板
- `guard/` — AuthAspect 认证切面
- `middleware/` — 中间件模板
- `plugin/` — 插件模板
- `exception/` — 异常处理器模板
- `proto/` — gRPC proto 模板

## 使用

由 [koatty_cli](https://github.com/Koatty/koatty-ai) 的 `add`、`create`、`generate` 等命令自动拉取。
