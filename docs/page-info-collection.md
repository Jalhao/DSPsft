# 页面信息采集第一步

目标：先把 `https://adm.adbiding.cn/report/dspReport` 这个页面的结构和接口线索采集出来，后续再判断适合用“直接接口调用”还是“浏览器自动化”。

## 我需要的信息

请先准备这几类信息。敏感值不用发给我，比如 cookie、token、密码、短信验证码。

1. 你负责的 DSP 名称或 ID
2. 日常筛选条件：日期范围、媒体、广告位、国家/地区、流量类型等
3. 报表里你最常看的字段：例如请求数、填充率、展示、点击、收入、成本、利润、利润率、QPS
4. 你会执行的动作：开启、关闭、增加/减少 QPS、调整利润率
5. 每个动作对应的页面位置：在哪个菜单、按钮、弹窗或表格行里操作
6. 风控边界：哪些 DSP 绝不能自动操作，单次最大 QPS 调整幅度，利润率最大/最小值

## 第一步：采集页面结构

1. 用浏览器打开 `https://adm.adbiding.cn/report/dspReport`
2. 登录，并切到你平时工作的“流量转发报表”状态
3. 按 `F12` 打开开发者工具
4. 切到 `Console`
5. 打开本项目里的 `tools/page-snapshot-snippet.js`
6. 复制全部内容，粘贴到 Console，回车
7. 浏览器会下载一个类似 `dsp-report-page-snapshot-2026-05-08T...json` 的文件
8. 把这个 JSON 文件放到本项目的 `samples/` 目录，或直接把关键内容发给我

这个快照会包含：

- 当前页面标题和 URL
- 表格表头与部分行样本
- 输入框、下拉框、按钮、链接
- 页面上的可见文本摘要
- 页面加载过的接口 URL 线索
- localStorage/sessionStorage 的 key 名称，但不会保存值

## 第二步：采集接口调用

页面结构只能告诉我们“看到了什么”。真正自动化时，更重要的是页面背后的接口。

1. 刷新页面
2. 打开 `Console`
3. 复制并运行 `tools/network-recorder-snippet.js`
4. 正常操作一遍：
   - 选择日期
   - 选择或搜索 DSP
   - 点击查询
   - 翻页或排序一次，如果你平时会这么做
   - 打开一次调整 QPS/利润率/开关计划的入口，但先不要提交危险操作
5. 在 Console 里执行：

```js
window.__dspReportRecorder.download()
```

6. 浏览器会下载一个类似 `dsp-report-network-2026-05-08T...json` 的文件
7. 同样放到 `samples/` 目录，或把内容发给我

## 第三步：如果需要 HAR

如果上面的网络脚本没有捕获到足够信息，再用 DevTools 导出 HAR：

1. 打开 DevTools 的 `Network`
2. 勾选 `Preserve log`
3. 刷新页面
4. 操作查询和调整入口
5. 右键请求列表，选择 `Save all as HAR with content`
6. 发给我前，请确认里面没有 cookie、authorization、token 等敏感值

## 请优先给我的最小材料

第一轮只需要这几个文件/信息：

1. `page-snapshot` JSON
2. `network` JSON 或 HAR
3. 你负责的 2-3 个 DSP 示例
4. 你平时最常做的 2-3 条调整规则，例如“利润率低于 5% 且消耗超过 100 元就降低 QPS”

拿到这些后，我就能开始判断接口形态，并做一个只读版的报表提取工具。
