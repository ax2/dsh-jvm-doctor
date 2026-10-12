# dsh-jvm-doctor

**离线、确定性的 JVM 生产报告诊断器** — 一个 DeepSeek Harness 插件，向模型注册 5 个工具：粘贴线程 dump / GC 日志 / 依赖树 / 异常栈 / Spring 配置文本，换回结构化诊断与诚实的解析覆盖率回执。

[![CI](https://github.com/ax2/dsh-jvm-doctor/actions/workflows/ci.yml/badge.svg)](https://github.com/ax2/dsh-jvm-doctor/actions/workflows/ci.yml)
MIT License · DSH 0.2.0-rc.2 验证通过 · Node ≥ 20.10（运行）/ ≥ 22.6（测试）

> **永不接触运行中的进程** · 无 `jcmd` / `jstack` / `jmap` / `jstat` / attach / JMX · 无网络 · 无文件读取 · 无时钟、无随机 · 每次调用都带字节回执

---

## 快速开始

[![npm](https://img.shields.io/npm/v/dsh-jvm-doctor)](https://www.npmjs.com/package/dsh-jvm-doctor)
![tools](https://img.shields.io/badge/tools-5-blue) ![tests](https://img.shields.io/badge/tests-47%20passing-brightgreen) ![network](https://img.shields.io/badge/network-none-informational) ![license](https://img.shields.io/badge/license-MIT-lightgrey)

```sh
dsh plugin --profile web add dsh-jvm-doctor
```

装完**重启应用**。想一次装齐四个插件（含 [deterministic-tools](https://github.com/ax2/dsh-deterministic-tools) / [py-doctor](https://github.com/ax2/dsh-py-doctor) / [win-native](https://github.com/ax2/dsh-win-native)）用 [`@ax2zicode/dsh-dev-toolbox`](https://github.com/ax2/dsh-dev-toolbox)；**别和单独安装混用**。

**家族总览**：[zicode.com/software](https://zicode.com/software/) 是四个插件、合装包与桌面软件的统一入口。

**15 秒看效果** —— 把异常栈贴进去，模型调用 `java_stack_trace`，拿回（实测输出）：

```
root_cause: java.lang.IllegalStateException: inner
primary:    java.lang.RuntimeException: boom
frames:     com.acme.Main.main(Main.java:7)      coverage: 100% (3/3, parser 1)
```

线程 dump 同理：`java_thread_dump` 给出 **Java 级死锁环**（`waiting_for` / `holding` 链），而不是让你在 500 个线程里自己找。

**为什么不让模型自己写 pwsh？** 死锁环、GC 停顿 p50/p90/p99、依赖冲突消解、`... N more` 折叠还原——写成脚本都是几十行，每次还得重新写对；工具是固定实现 + 47 个测试，并且**只出结构化事实、不做因果推断**。

相邻插件：[dsh-deterministic-tools](https://github.com/ax2/dsh-deterministic-tools) · [dsh-py-doctor](https://github.com/ax2/dsh-py-doctor) · [dsh-win-native](https://github.com/ax2/dsh-win-native) · [dsh-dev-toolbox](https://github.com/ax2/dsh-dev-toolbox)

---

## 为什么需要它

JVM 生产排查的证据几乎全部长这样：一段 `jstack` 输出、一坨 `-Xlog:gc` 日志、一棵 `dependency:tree`、一条 `Caused by:` 链、一份 `application.yml`。这些文本**运维手里已经有了**，但模型拿到之后只能：

1. **自己起进程去采** —— 生产环境通常不允许：容器里没有 `jcmd`、权限与审计不让 attach、事故期间更不该再给 JVM 加负担；
2. **或者肉眼心算** —— 95 行 jstack 里哪几个线程互相持有锁、`Found 1 deadlock` 之外还有没有第二个环、`omitted for conflict with` 到底谁赢了，全靠猜，而且不可复现。

`dsh-jvm-doctor` 只做一件事：**把已到手的文本变成结构化诊断**。它刻意不做采集 —— 没有 `jcmd`、没有 `jstack`、没有 attach、没有 JMX、没有网络、没有文件系统读取。每个工具都是纯函数：同样的输入永远给同样的输出。

顺带解决一个更隐蔽的问题：**「解析失败」和「没有异常」长得一模一样**。所有工具都返回 `unknown_lines` / `unknown_samples` / `coverage` / `confidence`，并且把预算导致的截断逐条报数，所以「没发现问题」和「没看懂输入」永远不会被混为一谈。

## 设计契约：每个结果都是回执

规范返回值固定为：

```json
{
  "result": { "…工具自己的载荷…": true },
  "meta": {
    "bytesIn": 5396,
    "bytesOut": 7716,
    "truncated": false,
    "notes": []
  }
}
```

模型看到的就是 `result`（对象给格式化 JSON），**只有**当发生截断或需要解释时才追加页脚：

```
[bounded] input=2307B output=5615B
[note] 7 frame(s) hidden behind `... N more` could not be resolved because the enclosing trace was truncated or absent
```

干净的调用不花额外 token；有问题的调用一定说清楚。

### 边界行为（五种，绝不混淆）

| 情况 | 行为 |
|---|---|
| 输入超 `maxInputBytes` | **抛错拒绝**：报出实际字节、上限，并明确「没有任何截断或部分处理」 |
| 渲染文本超 `maxOutputBytes` | **按 code point 边界截断** + `truncated: true` + note（`meta.bytesOut` 仍报真实载荷大小） |
| 结构化列表超预算（线程数 / GC cause 数 / 冲突数 / 每条冲突的边数 / 异常数 / 每异常的帧数 / 差异条数） | **截断并逐条报数**：`threads_omitted`、`causes_omitted`、`conflicts_omitted`、`edges_omitted`、`exceptions_omitted`、`frames_omitted`、`changes_omitted` |
| 不认识的语法 | **绝不静默丢弃**：计入 `unknown_lines`，`unknown_samples` 里给出原文，并按覆盖率下调 `confidence` |
| 无法给出结论 | 返回诚实标记（`confidence`、`findings`、`errors[]`），而不是编一个诊断 |

## 安装

npm（推荐）：

```sh
dsh plugin --profile web add dsh-jvm-doctor
```

预构建 tarball（与 npm 上是同一份产物，无需构建步骤，也避开 pnpm 的 `allowBuilds` 授权）：

```sh
dsh plugin --profile web add https://github.com/ax2/dsh-jvm-doctor/releases/latest/download/dsh-jvm-doctor.tgz
```

要固定版本就把 `latest/download/dsh-jvm-doctor.tgz` 换成 `download/v<version>/dsh-jvm-doctor-<version>.tgz`。

本地开发：不安装，直接挂载构建产物。

```sh
pnpm install && pnpm build
dsh --profile web --patch ./cordis.local-overlay.yml --dump-config   # 先验证层合成
dsh --profile web --patch ./cordis.local-overlay.yml                 # 再启动
```

## 配置

`apply(ctx, config)` 接受以下配置（全部可选，含默认值）：

| 字段 | 默认 | 作用 |
|---|---|---|
| `maxInputBytes` | `2097152` | 单份粘贴文本的硬上限（UTF-8 字节），超过即拒绝 |
| `maxOutputBytes` | `262144` | 渲染文本的软上限，超过即按 code point 截断并标记 |
| `maxThreads` | `200` | `java_thread_dump` 序列化的线程条目上限 |
| `maxStatusLines` | `40` | `java_thread_dump` 汇总的状态行上限 |
| `maxContention` | `20` | `java_thread_dump` 报告的锁竞争队列上限 |
| `maxGcEvents` | `500` | `java_gc_log` 保留的 GC cause 种类上限 |
| `maxPauseSamples` | `5000` | 计算百分位所用的停顿样本上限 |
| `maxConflicts` | `100` | `java_dependency_conflicts` 报告的冲突 artifact 上限 |
| `maxEdgesPerConflict` | `20` | 每条冲突保留的边上限 |
| `maxExceptions` | `25` | `java_stack_trace` 保留的异常链条目上限 |
| `maxFramesPerException` | `60` | 每个异常保留的帧上限 |
| `maxChanges` | `500` | `spring_config_diff` 报告的差异条数上限 |
| `maxKeys` | `5000` | 每份配置文档展平后的键上限 |
| `sampleLimit` | `5` | `unknown_samples` 保留的原文行数上限 |
| `toolPrefix` | `''` | 工具名前缀，例如 `jvm` → `jvm__java_thread_dump` |
| `only` | `[]` | 只注册指定工具（空 = 全部） |

非法值（`0`、负数、`NaN`、`Infinity`）静默回落到默认值，并向下取整 —— 一个坏配置无法把预算关掉。

## 工具清单（5 个）

| 工具 | 说明 |
|---|---|
| `java_thread_dump` | 解析 `jstack` / `jcmd <pid> Thread.print`：线程普查、归一化与原文状态直方图、daemon 数、每线程 top 帧与锁、**Java 级死锁环（含 waiting_for/holding 链）**、`Object.wait`/park 计数、锁竞争队列 |
| `java_gc_log` | 解析 JEP 158 统一日志与 JDK 9 之前的旧式 GC 行：事件/停顿计数、总/均/最大停顿、p50/p90/p99 百分位、Young/Full 拆分、堆前后区间、cause 直方图、promotion failure，并在有时间戳时估算分配速率 |
| `java_dependency_conflicts` | 解析 Maven `dependency:tree -Dverbose` 与 Gradle `dependencies` / `dependencyInsight`：同一 artifact 的多版本、`omitted for conflict with X`、`omitted for duplicate`、每条边所在深度、逐 artifact 结论摘要 |
| `java_stack_trace` | 解析异常链：类型与消息、`class.method(file:line)` 帧、`Caused by:` 链、`Suppressed:` 块、**`... N more` 折叠按外层 trace 还原**、最深的业务帧、最多 6 条可能原因提示 |
| `spring_config_diff` | 把两份 `application.yml` / `.properties` 展平成点号键后逐键对比（add / remove / change）；**敏感值在进入载荷之前就替换为 `***`** |

### `java_thread_dump` — 死锁环与竞争队列

输入（节选；真实示例是完整 `jstack -l`）：

```
Full thread dump OpenJDK 64-Bit Server VM (21.0.4+7-LTS-103 mixed mode, sharing):

"deadlock-A" #40 ... nid=0x2b00 waiting for monitor entry
   java.lang.Thread.State: BLOCKED (on object monitor)
	at com.acme.order.Inventory.reserve(Inventory.java:61)
	- waiting to lock <0x0000000712d00020> (a com.acme.order.Inventory)
	- locked <0x0000000712c00010> (a com.acme.order.OrderDao)
...
Found one Java-level deadlock:
"deadlock-A":
  waiting to lock monitor 0x... (object 0x0000000712d00020, a com.acme.order.Inventory),
  which is held by "deadlock-B"
"Thead-B": ... which is held by "deadlock-A"
Found 1 deadlock.
```

输出（节选，`…` 表示省略）：

```json
{
  "source": "jstack",
  "jvm_version": "OpenJDK 64-Bit Server VM",
  "captured_at": "2026-01-02 03:04:05",
  "thread_count": 9,
  "daemon_threads": 2,
  "state_histogram": { "RUNNABLE": 1, "WAITING": 1, "BLOCKED": 5, "TIMED_WAITING": 2 },
  "raw_state_histogram": {
    "RUNNABLE": 1, "WAITING (parking)": 1, "BLOCKED (on object monitor)": 5,
    "TIMED_WAITING (sleeping)": 1, "TIMED_WAITING (on object monitor)": 1
  },
  "deadlock_marker": true,
  "reported_deadlock_count": 1,
  "deadlock_cycles": [{
    "threads": ["deadlock-A", "deadlock-B"],
    "locks": ["0x0000000712d00020", "0x0000000712c00010"],
    "chain": [
      { "thread": "deadlock-A", "waiting_for": "0x0000000712d00020", "holding": "0x0000000712c00010" },
      { "thread": "deadlock-B", "waiting_for": "0x0000000712c00010", "holding": "0x0000000712d00020" }
    ]
  }],
  "lock_contention_candidates": [{
    "method": "com.acme.order.OrderDao.save",
    "thread_count": 4,
    "threads": ["worker-1", "worker-2", "worker-3", "deadlock-B"],
    "states": ["BLOCKED"]
  }],
  "total_lines": 95, "parsed_lines": 95, "unknown_lines": 0,
  "coverage": 1, "confidence": "high"
}
```

`state_histogram` 是归一化枚举（`BLOCKED`），`raw_state_histogram` 保留 JVM 原话（`BLOCKED (on object monitor)`）—— 归一化便于统计，原文便于核对，两者都不丢。

**明确拒绝**：文本超 `maxInputBytes` 抛错；只认得 dump 语法的行，任何其它行都进 `unknown_lines` 并降 `confidence`，不会当成「线程正常」。

### `java_gc_log` — 停顿统计与分配速率

```
[2026-01-02T03:04:05.678+0800][info][gc] Using G1
[2026-01-02T03:04:05.678+0800][info][gc] GC(0) Pause Young (Normal) (G1 Evacuation Pause) 128M->45M(512M) 12.345ms
[2026-01-02T03:04:07.100+0800][info][gc] GC(2) Pause Young (Concurrent Start) (Metadata GC Threshold) 480M->120M(512M) 30.500ms
[2026-01-02T03:04:08.100+0800][info][gc] GC(4) Pause Full (G1 Compaction Pause) 500M->90M(512M) 200.000ms
```

```json
{
  "gc_event_count": 6, "pause_count": 5, "non_gc_lines": 1,
  "total_pause_ms": 268.095, "mean_pause_ms": 53.619, "max_pause_ms": 200,
  "pause_percentiles": { "p50_ms": 20, "p90_ms": 132.2, "p99_ms": 193.22, "max_ms": 200 },
  "young_pause_count": 4, "full_pause_count": 1, "concurrent_cycle_count": 1,
  "heap_before_max_bytes": 524288000, "heap_after_min_bytes": 41943040, "heap_total_max_bytes": 536870912,
  "unique_causes": 4, "causes_omitted": 0,
  "cause_histogram": [
    { "reason": "Pause Young (Normal) (G1 Evacuation Pause)", "count": 3, "mean_pause_ms": 12.532, "max_pause_ms": 20 },
    { "reason": "Pause Full (G1 Compaction Pause)", "count": 1, "mean_pause_ms": 200, "max_pause_ms": 200 }
  ],
  "estimated_allocation_rate": { "bytes_per_second": 31182870, "bytes_per_hour": 112258331344, "window_seconds": 2.522, "events_with_timestamp": 6 },
  "findings": [
    "1 pause(s) triggered by Metadata GC Threshold: class-loader or metaspace pressure is forcing collections",
    "1 full-collection pause(s) present; check old-generation occupancy and humongous allocations",
    "heap occupancy reached 97.7% before a collection: collections are running close to exhaustion"
  ],
  "coverage": 1, "confidence": "high"
}
```

堆大小一律换算成字节（`128M` → `134217728`），百分位用最近秩法在**保留的样本**上计算；样本被 `maxPauseSamples` 截断时 `pause_percentiles_sampled: true` 并附 note。同时认得旧式 `[GC (Allocation Failure) [PSYoungGen: ...] 1234K->567K(2048K), 0.0123456 secs]` 与 `[Times: user=... real=... secs]`，并在 `pause_source` 里说明停顿秒数取自内联字段、尾随 `secs]` 还是 `[Times: real=]`。

### `java_dependency_conflicts` — 谁被裁掉了

```
[INFO] com.acme:order-service:jar:1.0.0
[INFO] +- org.springframework.boot:spring-boot-starter-web:jar:2.7.18:compile
[INFO] |  \- org.springframework:spring-web:jar:5.3.31:compile
[INFO] +- com.acme:widget-core:jar:1.2.3:compile
[INFO] |  \- com.google.guava:guava:jar:31.1-jre:compile
[INFO] +- com.acme:widget-extras:jar:2.0.0:compile
[INFO] |  \- com.google.guava:guava:jar:32.1.3-jre:compile (omitted for conflict with 31.1-jre)
```

```json
{
  "source": "maven", "edge_count": 9, "artifact_count": 8,
  "omitted_edge_count": 2, "duplicate_markers": 1,
  "conflicts": [{
    "artifact": "com.google.guava:guava",
    "kind": "version_conflict",
    "resolved_versions": ["31.1-jre"],
    "omitted_versions": ["32.1.3-jre"],
    "depths": [1], "min_depth": 1, "max_depth": 1,
    "edges_omitted": 0,
    "summary": "com.google.guava:guava is requested at 31.1-jre; the build resolved 31.1-jre; 1 edge(s) pruned at depth 1..1"
  }],
  "coverage": 1, "confidence": "high"
}
```

Maven 的 `+-`/`\-` 与 Gradle 的 `+---`/`\---` 各自成树，`->` 记入 `requested_version`：**请求版本与被解析版本分开存**，因为「构建实际用哪个」和「谁想要哪个」是两个问题。`treeDepthOf` 让 Maven 与 Gradle 的深度定义一致（顶层直接依赖 = 深度 0）。

### `java_stack_trace` — `... N more` 不是黑盒

```
org.springframework.web.util.NestedServletException: Request processing failed; …
	at com.acme.web.CatalogController.list(CatalogController.java:64)
Caused by: java.lang.NullPointerException: Cannot invoke "…Product.getSku()" because "product" is null
	at com.acme.catalog.CatalogService.toSku(CatalogService.java:112)
	... 15 more
```

```json
{
  "exception_count": 2,
  "root_cause": "java.lang.NullPointerException",
  "chain": [
    { "type": "org.springframework.web.util.NestedServletException", "relation": "primary", "frame_count": 3,
      "deepest_application_frame": "com.acme.web.CatalogController.list",
      "hints": ["NestedServletException surfaced through com.acme.web.CatalogController.list; …"] },
    { "type": "java.lang.NullPointerException", "relation": "caused_by", "frame_count": 16, "folded_frames": 15,
      "folded_resolved": 3, "deepest_application_frame": "com.acme.catalog.CatalogService.toSku",
      "hints": ["NullPointerException dereferences a null receiver or return value at com.acme.catalog.CatalogService.toSku; …"] }
  ],
  "total_frames": 7, "folded_frames_resolved": 3, "folded_frames_unresolved": 12,
  "exceptions_omitted": 0, "frames_omitted": 0,
  "confidence": "medium"
}
```

折叠帧只从**最近的外层异常**里还原（Java 的语义如此），还原不出来就计入 `folded_frames_unresolved` 并降 `confidence` —— 不编造不存在的帧。`application_frames`、`library_prefixes`、`test_failure` 用来区分业务边界与框架管道。

### `spring_config_diff` — 密钥不落地

```json
{
  "left_dialect": "yaml", "right_dialect": "yaml",
  "left_keys": 8, "right_keys": 8,
  "added": 1, "removed": 1, "changed": 4, "unchanged": 3,
  "masked_values": 2,
  "changes": [
    { "key": "spring.datasource.hikari.connection-timeout", "op": "add", "left": null, "right": "3000", "masked": false },
    { "key": "server.shutdown", "op": "remove", "left": "immediate", "right": null, "masked": false },
    { "key": "logging.level.root", "op": "change", "left": "INFO", "right": "WARN", "masked": false },
    { "key": "server.port", "op": "change", "left": "8080", "right": "9090", "masked": false },
    { "key": "spring.datasource.hikari.maximum-pool-size", "op": "change", "left": "10", "right": "32", "masked": false },
    { "key": "spring.datasource.url", "op": "change", "left": "jdbc:postgresql://db:5432/orders", "right": "jdbc:postgresql://db-primary:5432/orders", "masked": false }
  ],
  "errors": [],
  "findings": ["2 secret-looking value(s) were replaced with *** before comparison"]
}
```

键名命中 `password|secret|token|key|credential` 时，**左右两侧的值在进入载荷之前**就替换为 `***`（`masked: true` 仍然说明这里有一处变化），所以密码既不会被比较、也不会被回显。`.properties` 的转义（`\:` `\=` `\\` `\ `）与行内注释照常解析；解析不了的行进 `errors[]` 并带上行号，调用本身仍然是成功结果。

## 诚实性设计：coverage 与 confidence

所有解析器共用同一套记账（`src/core/lines.ts`）：

- `total_lines` 按 CR/LF 归一化后计数，单个结尾换行不额外造一行；
- **空行算结构、不算语法**：把空行计入 `unknown_lines` 会让覆盖率取决于报告排版多松散；
- `coverage = (total - unknown) / total`；
- `confidence`：`coverage ≥ 0.98` 且没有可疑信号 → `high`；`≥ 0.85` → `medium`；否则 `low`；
- 「可疑信号」指文档解析成功但**没有任何主体**（0 个线程 / 0 条依赖边），这种情况永远拿不到 `high`；
- **完全空的输入是 `low`**，不是「100% 覆盖率」的假象；
- `unknown_samples` 只保留前 `sampleLimit` 行原文，且**永远不丢计数**。

## 离线与安全边界

- **不采集**：没有 `jcmd` / `jstack` / `jmap` / `jstat` / `jinfo`、没有 attach API、没有 JMX、没有 socket、没有子进程；
- **不读盘**：报告文本只能从工具入参进来；
- **不联网**：没有任何出站请求，包括遥测；
- **不猜密码**：`spring_config_diff` 在比较之前就把敏感值掩码；
- **可复现**：无时钟、无随机、无环境变量读取、无 locale 依赖；同一份文本永远给同一份结果（含 `bytesIn`/`bytesOut`）。

## 开发

```sh
pnpm install
pnpm typecheck              # tsc --noEmit，0 错误
pnpm test                   # 47 个用例（5 个工具，用例数 ≥ 工具数）
pnpm build                  # 产出 lib/（ESM + .d.ts，导入已改写为 .js）
```

测试分三类：

1. **解析器金值测试**（`test/core.test.ts`，27 例）：内联真实的 `jstack` / 两种 GC 日志 / Maven 与 Gradle 依赖树 / 多层异常链 / YAML 与 properties fixture，断言**精确的结构化数字**（线程数、直方图、死锁环的 `waiting_for`/`holding`、百分位、堆字节数、冲突深度），而不是「非空」；
2. **组装路径测试**（`test/tools.test.ts`，20 例）：`definition.execute(args, exec)` → `definition.output.render()`，断言 `result` / `meta` / 页脚，以及每个工具的 schema 形状与「离线 + 拒绝」描述；`only` / `toolPrefix` 过滤、`resolveLimits` 非法值回落、`maxOutputBytes` 截断路径；
3. **诚实性测试**：故意塞入被截断/被人类改过的 fixture，断言覆盖率、`unknown_samples`、`confidence` **如实地变差**（例如 100 行里 4 行不认识 → `coverage 0.96`、`confidence medium`），并断言每个预算截断都报出精确的丢弃条数（`exceptions_omitted`、`causes_omitted`、`edges_omitted`…）。

## 兼容性与风险

- 官方插件 API 自称 **pre-stable，无冻结承诺**；本插件只依赖最稳定的两个面：`ctx.tools.register(defineTool(...))` 与 `apply(ctx, config)`。
- **验证到什么程度（不夸大）**：`tsc --noEmit` 0 错误；47 个用例在真实 `@deepseek-ai/dsh-tools` 上跑通组装路径；`lib/` 产物由 `research/plugin-smoke.mjs`（stub registry）加载并验证 5 个工具全部注册、schema 齐全、无重名、无 default export、`dsh.bundle` 指向存在且 id 正确的 patch；Node 22 / 24 的 CI 矩阵；npm 上的版本用 `dsh plugin --profile <scratch> add` 装进一个临时 profile 后，真实 `dsh` 启动把本包 5 个工具 schema 发给了模型（会话日志核对）。**真实对话也跑通了**：同一个临时 profile 接上本机 desktop profile 用的那条 LLM 路由后，模型在真实回合里调用了 `java_stack_trace`（3 行异常链），正确报出 `root_cause`、帧位置与 100% 解析覆盖率（会话 `session-b5681b93`）。**尚未做**：跨多个真实会话的调用统计（这属于 M3）。
- **语法是启发式的**：不同 JDK 版本的 dump/GC 文案、各构建工具的输出变体都可能落在已知语法之外 —— 这正是 `unknown_lines` 存在的理由；覆盖率下降就是「这份报告我没完全看懂」的信号，请以它为准。
- **不做因果推断**：工具给的是结构化事实与明确的 finding（例如「97.7% 堆占用触发回收」），不是「你的服务就是这样挂的」。
- GC 分配速率是**线性估算**（首尾时间戳窗口内的正堆增量），不含分代细节，仅作量级参考。

## Roadmap

1. JDK 版本感知：为 JDK 8 / 11 / 17 / 21 的 dump 与 GC 文案分别固定 golden 语料，把版本差异变成测试而不是猜测。
2. 更多报告：`jcmd GC.heap_info` 文本、JFR 摘要、线程 dump 的差集对比（两次 dump 之间谁新增/谁消失）。
3. 建议引擎：把 `findings` 从「事实陈述」升级为可核对的检查项（例如「持有锁超过 N 个采样」），并保持每个结论可回溯到具体行号。
4. `output.presentCall/presentResult` 卡片化，让 Web UI 直接渲染线程表与死锁环图，而不是纯文本 JSON。

## License

MIT © ax2

---

## English

**Offline, deterministic JVM production-report diagnostics for DeepSeek Harness** — 5 model-visible tools that turn pasted `jstack` / GC logs / dependency trees / exception chains / Spring configuration into structured diagnostics with an honest parse-coverage receipt.

- **Never touches a running process.** No `jcmd`, `jstack`, `jmap`, `jstat`, no attach API, no JMX, no sockets, no subprocesses, no filesystem reads. Every tool is a pure function of the text you paste: no clock, no randomness, no environment reads, so the same input always yields the same output.
- **Every call returns a receipt**: `{ result, meta: { bytesIn, bytesOut, truncated, notes } }`. Model-facing text is exactly `result`; a footer appears only when something was clipped or needs explaining.
- **Explicit failure, never silent degradation.** Over-budget input is refused with both sizes and an assurance that nothing was partially processed. Rendered text is clipped at code-point boundaries and flagged. Every budget that drops list entries reports the exact count (`threads_omitted`, `causes_omitted`, `conflicts_omitted`, `edges_omitted`, `exceptions_omitted`, `frames_omitted`, `changes_omitted`).
- **Unrecognized syntax is never dropped**: it is counted in `unknown_lines`, sampled verbatim in `unknown_samples`, and lowers `confidence`. An entirely empty paste is `low` confidence, not a fake 100% coverage.
- **Secrets stay out of the payload**: `spring_config_diff` replaces values whose key matches `password|secret|token|key|credential` with `***` before comparison.

Tools:

| Tool | What it answers |
|---|---|
| `java_thread_dump` | Thread census, normalized and raw state histograms, daemon count, per-thread top frames and locks, **Java-level deadlock cycles with the `waiting_for`/`holding` chain**, `Object.wait`/park counts, lock-contention cohorts |
| `java_gc_log` | JEP 158 unified and legacy GC grammar: event/pause counts, total/mean/max pause, p50/p90/p99 percentiles, Young vs Full split, heap before/after ranges in bytes, cause histogram, promotion failures, allocation-rate estimate |
| `java_dependency_conflicts` | Maven `dependency:tree -Dverbose` and Gradle `dependencies`/`dependencyInsight`: same artifact at several versions, `omitted for conflict with X`, `omitted for duplicate`, per-edge depth, per-artifact summary |
| `java_stack_trace` | Exception chain: type and message, `class.method(file:line)` frames, `Caused by:` chain, `Suppressed:` blocks, `... N more` folds resolved against the enclosing trace, deepest application frame, up to six likely-cause hints |
| `spring_config_diff` | Flatten two `application.yml` / `.properties` documents to dotted keys and classify every difference as add, remove or change — with sensitive values masked before they reach the payload |

- **Install**: `dsh plugin --profile web add dsh-jvm-doctor`, or mount the built entry locally with `dsh --profile web --patch ./cordis.local-overlay.yml`.
- **Develop**: `pnpm install && pnpm typecheck && pnpm test && pnpm build` — 47 tests (parser golden values + assembled tool path + honesty/degradation cases) against the real `@deepseek-ai/dsh-tools`.
- **Verified against DSH 0.2.0-rc.2** on Node 22 and 24; only `ctx.tools.register(defineTool(...))` and `apply(ctx, config)` are used, because the official plugin API is explicitly pre-stable.
- **Honest about grammar**: dump and GC wording varies across JDK versions and build tools. Coverage below `1` is the signal that part of the report was not understood — treat `unknown_lines` and `confidence` as part of the answer, not as noise.
