# Playwright 会话复用采集说明

这个工具只做只读采集，不会提交开启、关闭、QPS、利润率等业务调整动作。

## 1. 初始化登录会话

在项目根目录运行：

```bash
npm run auth
```

脚本会打开浏览器。你在浏览器里手动登录后台，进入流量转发报表页面后，回到终端按回车。

登录态会保存到：

```text
.auth/dsp-report-state.json
```

这个文件被 `.gitignore` 忽略。项目不会保存明文密码。

## 2. 采集报表页面

登录会话保存好后运行：

```bash
npm run collect
```

脚本会复用 `.auth/dsp-report-state.json` 打开：

```text
https://adm.adbiding.cn/report/dspReport
```

然后使用 `config/dsps.json` 里的 9 个默认 DSP 作为采集配置，输出脱敏 JSON 到 `samples/`。

默认是无头浏览器。如果需要看见浏览器窗口，可以在 PowerShell 里运行：

```powershell
$env:HEADLESS='false'; npm run collect
```

## 3. 输出文件

每次采集会生成两类文件：

```text
samples/dsp-report-page-YYYYMMDD-HHmmss.json
samples/dsp-report-network-YYYYMMDD-HHmmss.json
```

页面文件包含表格、控件、可见文本、默认 DSP 列表等。

网络文件包含页面请求、请求参数和响应摘要。敏感字段会被脱敏，例如 cookie、authorization、token、password、session。

## 4. 直接查询 DSP 报表

如果只想直接读取流量转发报表接口，可以运行：

```bash
npm run report
```

默认会查询 `config/dsps.json` 里的 DSP，日期默认是今天，聚合维度默认是 `dat,dsp_id`。

为了快速验证 `200001 百度-S` 和 `200021 百度-WB`，可以运行：

```bash
npm run report:baidu
```

也可以手动指定 DSP 和日期：

```bash
npm run report -- --dsp 200001,200021 --date 2026-05-08
```

查询结果会输出到：

```text
samples/dsp-report-query-YYYY-MM-DD-YYYY-MM-DD-YYYYMMDD-HHmmss.json
```

输出文件包含 `summaryRows` 和完整 `rows`。这个命令只调用 `/api/queryDspReport` 查询接口，不会修改任何计划配置。

## 5. 生成规则建议

读取最近一次 `dsp-report-query-*.json` 并生成只读建议：

```bash
npm run analyze
```

快速查询并分析 `200001 百度-S` 和 `200021 百度-WB`：

```bash
npm run advise:baidu
```

建议结果会输出到：

```text
samples/dsp-report-analysis-YYYYMMDD-HHmmss.json
samples/dsp-report-analysis-YYYYMMDD-HHmmss.md
```

默认规则配置在：

```text
config/report-rules.json
```

这一步只生成建议，不会调用任何调整、保存或开关接口。

## 6. 会话过期

如果 `npm run collect` 提示会话过期，重新运行：

```bash
npm run auth
```

登录完成后再运行：

```bash
npm run collect
```

## 7. 默认 DSP

默认 DSP 配置在：

```text
config/dsps.json
```

当前包含：

- `200045` 京东B
- `200046` 京东C
- `200047` 京东D
- `200088` 京东Q
- `200089` 京东M
- `200094` 京东F
- `200095` 京东G
- `200001` 百度-S
- `200021` 百度-WB
 
## 8. 指定 DSP 广告位下钻

所有下钻命令仍然只读，只调用 `/api/queryDspReport`，不会修改 QPS、利润率、开关状态或计划配置。

如果还不知道 `dsp_slot_id`，先按广告位维度查询：

```bash
npm run report -- --dsp 200001,200021 --group-by dat,dsp_id,dsp_slot_id --date 2026-05-08
```

输出文件里的 `summaryRows` 会包含：

```text
dsp_slot_id
dsp_slot_name
```

拿到一个或多个要看的广告位后，再下钻到这些广告位下面的 ad 明细：

```bash
npm run drilldown -- --dsp 200001,200021 --dsp-slot 220013,222686 --date 2026-05-08
```

`--dsp-slot` 是必填项。没有传广告位时，脚本会直接报错，避免误查整个 DSP 的所有 ad。

下钻会生成：

```text
samples/dsp-report-drilldown-YYYY-MM-DD-YYYY-MM-DD-YYYYMMDD-HHmmss.json
samples/dsp-report-drilldown-YYYY-MM-DD-YYYY-MM-DD-YYYYMMDD-HHmmss.md
```

结果包含两部分：

- `slotSummary`: 指定 `dsp_slot_id` 的广告位汇总，使用 `group_by=dat,dsp_id,dsp_slot_id`
- `adDetails`: 指定广告位下的 ad 明细，使用 `group_by=dat,dsp_id,dsp_slot_id,ad_id`

分析字段会计算：

- `profit_amount = charge - cost`
- `send_rate = req_send / req_avalible`
- `profit_rate`

明细会按加量机会排序：利润率高、利润金额高、发送量高的计划靠前，同时标记：

- `uplifter`: 拉高利润率，适合优先观察加量
- `dragger`: 拉低利润率，适合优先排查或降量
- `neutral`: 暂时中性

## 9. 利润率调整草稿和提交

这个工具用于调整广告配置里的 `traffic_strategy[].profit_ratio`，也就是报表利润率背后的可写利润配置。它不是直接改报表里的 `profit_rate` 指标。

完整流程分三步：先下钻、再生成草稿、最后 dry-run 或提交。

### 9.1 先下钻到指定 DSP 广告位

选择一个或多个 DSP，并指定一个或多个 `dsp_slot_id`：

```bash
npm run drilldown -- --dsp 200021 --dsp-slot 223187 --date 2026-05-08
```

多个 DSP 或广告位用英文逗号分隔：

```bash
npm run drilldown -- --dsp 200001,200021 --dsp-slot 220013,222686,223187 --date 2026-05-08
```

这一步只读，不会修改线上配置。

### 9.2 生成利润率调整草稿

调高 10 个百分点：

```bash
npm run draft:profit -- --dsp-slot 223187 --increase 10
```

调低 5 个百分点：

```bash
npm run draft:profit -- --dsp-slot 223187 --increase -5
```

这里的 `--increase 10` 表示“增加 10 个百分点”，例如 `20% -> 30%`。

`--increase -5` 表示“降低 5 个百分点”，例如 `30% -> 25%`。

这一步仍然不会提交修改，只会生成：

```text
samples/dsp-profit-adjustment-draft-YYYYMMDD-HHmmss.json
samples/dsp-profit-adjustment-draft-YYYYMMDD-HHmmss.md
```

### 9.3 Dry-run 检查实际会提交什么

提交前必须先 dry-run。调高 10 个百分点：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase 10
```

调低 5 个百分点：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase -5
```

dry-run 会读取 `/api/adInfo/:id`，生成真正会提交的配置 diff，但不会调用保存接口。

默认保护：

- 默认最低利润配置不低于 `0%`
- 默认最高利润配置不高于 `100%`
- 测试广告会标记为 `skipped-test-ad`

如果需要自定义上下限：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase -5 --min-profit 10 --max-profit 80
```

这表示目标会被限制在 `10%` 到 `80%` 之间。

### 9.4 确认后提交

确认 dry-run 输出无误后，才可以显式提交。调高 10 个百分点：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase 10 --apply --confirm 223187
```

调低 5 个百分点：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase -5 --apply --confirm 223187
```

提交保护规则：

- 默认永远 dry-run
- 必须同时传 `--apply` 和 `--confirm <dsp_slot_id>` 才会调用 `POST /api/adInfo/:id`
- 测试广告会标记为 `skipped-test-ad`，不会用普通广告接口修改
- 输出文件不保存 cookie、token、authorization 或密码

如果一次选择多个广告位，`--confirm` 必须和 `--dsp-slot` 完全一致：

```bash
npm run apply:profit -- --dsp-slot 220013,223187 --increase 10 --apply --confirm 220013,223187
```

### 9.5 常用示例

只调整百度-WB 的 `223187`，利润调高 10 个百分点：

```bash
npm run drilldown -- --dsp 200021 --dsp-slot 223187 --date 2026-05-08
npm run draft:profit -- --dsp-slot 223187 --increase 10
npm run apply:profit -- --dsp-slot 223187 --increase 10
npm run apply:profit -- --dsp-slot 223187 --increase 10 --apply --confirm 223187
```

同时调整多个广告位，利润调低 5 个百分点：

```bash
npm run drilldown -- --dsp 200001,200021 --dsp-slot 220013,223187 --date 2026-05-08
npm run draft:profit -- --dsp-slot 220013,223187 --increase -5
npm run apply:profit -- --dsp-slot 220013,223187 --increase -5
npm run apply:profit -- --dsp-slot 220013,223187 --increase -5 --apply --confirm 220013,223187
```

只生成检查结果，不提交线上：

```bash
npm run apply:profit -- --dsp-slot 223187 --increase 10
```

真正提交一定会带上：

```text
--apply --confirm <dsp_slot_id>
```
