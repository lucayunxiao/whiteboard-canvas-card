# Whiteboard Canvas Card (无限白板画布与打印卡片)

<p align="center">
  <a href="https://github.com/hacs/default"><img src="https://img.shields.io/badge/HACS-Custom-41bdf5.svg?style=for-the-badge&logo=homeassistant" alt="HACS Custom"></a>
  <a href="https://github.com/lucayunxiao/whiteboard-canvas-card/releases"><img src="https://img.shields.io/github/v/release/lucayunxiao/whiteboard-canvas-card?style=for-the-badge&color=2563eb" alt="GitHub Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg?style=for-the-badge" alt="License"></a>
  <img src="https://img.shields.io/badge/HA-2024.1%2B-blue.svg?style=for-the-badge&logo=homeassistant" alt="Home Assistant 2024.1+">
</p>

<p align="center">
  <b>一款专为 Home Assistant Lovelace 设计的现代化高响应无限白板画布手绘、多端实时协作与远程打印卡片</b><br/>
  支持中点二次贝塞尔曲线抗锯齿平滑笔触、多终端实时同步与按设备独立撤回/重做、双指捏合无级缩放与平移、内联零漂移悬浮文本框、300 DPI 物理纸张自适应包围盒裁切光栅化、一键保存/放弃/打印工作流，以及多模式网络打印机直连集成。
</p>

<p align="center">
  <a href="README.md"><b>English</b></a> | <a href="README_zh.md"><b>简体中文</b></a>
</p>

---

## 📸 架构拓扑与交互预览

<p align="center">
  <img src="assets/banner.svg" alt="Canvas Card 架构与工作流设计" width="100%"/>
</p>

---

## ✨ 核心特性

- 🎨 **真·无边界无限画布 (Boundless Canvas)**：彻底告别固定纸张尺寸对创意的裁剪限制。画布底部的工程网格或手帐点阵直接铺满 100% 视口边缘，随平移与缩放（`0.2x` 至 `5.0x`）无级流动延展，绝无白框边界感。
- 🔄 **多端实时画面同步与按设备独立撤回 (Multi-Terminal Sync &amp; Per-Device Undo/Redo)**：
  - **双通道无感同步引擎**：通过 Home Assistant WebSocket 事件总线 (`canvas_card_sync`) 与本端 `BroadcastChannel` 双层联动，电脑、平板、手机、智能中控屏随时随地毫秒级实时同屏；
  - **按设备归属撤回隔离机制**：每台设备上的撤回/反撤回按钮仅撤回**当前设备自身绘制**的笔画与文字（基于 `ownerId` 与矢量操作 `opId` 精准剔除重绘），绝不会误撤其他用户/其他设备新增的内容，且撤回结果毫秒级同步至所有终端；
  - **超低带宽高频矢量流**：仅同步精简矢量路径坐标差值增量，而非重度 Base64 位图，实现 60 FPS 极速流畅的多人并发绘制，零卡顿、无碰撞；
  - **新设备握手同步**：新打开页面或刚连入设备自动触发握手同步，无缝拉取当前最新画布全景与矢量操作栈。
- 📱 **移动端全场景手势与专用漫游工具**：
  - **`[ ✋ Hand ]` 专用漫游手势工具**：工具栏新增手形漫游工具，单指拖拽即平移无限画布，彻底消除误画线条或触发手机系统侧滑返回手势的烦恼；
  - **右下角触控缩放胶囊 (Zoom Pod)**：屏幕右下角集成极简悬浮控制器，提供 `[-]`、`[🎯 100%]`、`[+]` 实体触控按键，单手一触即达；
  - **双指触控防鬼点机制**：延时判定单击落笔与双指捏合，彻底杜绝两个手指刚接触屏幕瞬间产生的多余墨点。
- 🖱️ **桌面端鼠标专业操作**：
  - **光标原点无级滚轮缩放**：以当前鼠标光标为轴心平滑滚轮缩放；
  - **鼠标右键 / 中键漫游**：按住鼠标右键或滚轮中键直接拖动画布，自动屏蔽浏览器右键原生上下文菜单，左键专注绘图。
- 🎯 **刷新自适应居中**：借助 `ResizeObserver` 智能监听，页面初次加载、网页刷新或移动设备横竖屏切换时，自动精准居中并按 100% 比例呈现画面。
- ✍️ **平滑贝塞尔笔触**：内置中点二次贝塞尔插值算法与触控防抖，消除平板（iPad / Android / Apple Pencil / 手写笔）在屏幕上书写时的折线与锯齿。
- 📝 **内联可拖拽悬浮文本框 (Inline Draggable Text Box)**：
  - 点击 `[ T ]` 工具轻触屏幕任意位置生成轻量悬浮输入框；
  - **直接视口级抓手**：按住顶部拖拽条可随意调整文字位置，点击 Done 后自动按坐标换算并入无限图层；
  - **4 档预设字号**：小（18px）、中（24px）、大（32px）、特大（44px），预览字号均 $\ge 18\text{px}$，彻底杜绝 iOS Safari 唤起输入法时强行放大网页视口的缺陷；
  - **输入法 IME 缓冲区保护**：提交前主动刷出输入法未上屏字符，确保中文/日文拼音候选词绝不丢失。
- 🖨️ **固定打印区域取景与 300 DPI 裁切 (Fixed-Frame Print Preview)**：
  - **绘画过程永不裁剪**：创作阶段永远处于无限画布模式，随意书写；
  - **固定纸张打印框**：点击 `Print + New` 唤起打印取景弹窗，所选纸张区域（**A4、A5、A3、Letter、80mm 热敏纸**，支持 **纵向 Portrait / 横向 Landscape**）始终按真实比例固定居中显示，绝不超出弹窗范围；
  - **拖动/缩放画布塞入打印区域**：通过拖拽移动、滚轮缩放、双指捏合或点击 **`Fit Content`** / **`[-]` `[+]`**，将无限画布内容自由缩放并塞进固定的纸张打印框内，所见即所得；
  - 严格以 **300 DPI 印刷级超清分辨率**（A4: $2480 \times 3508\text{ 像素}$）合成渲染，实体出纸清晰锐利。
- ⚡ **四大核心按键高效工作流**：
  - **`Save + New` (保存并新建)**：将当前作品导出归档至本地 IndexedDB 存储库，瞬间清空画布并开启新草稿；
  - **`Discard + New` (放弃并新建)**：清空画布并不保存当前草稿（多端联动同步清空，远端设备弹出非侵入式轻量提示）；
  - **`Print + New` (打印并新建)**：唤起取景框，框选确认后下发 300 DPI 任务给打印机，历史记录自动打标并重置画布；
  - **`History` (历史归档中心)**：侧边抽屉式画廊，支持缩略图浏览、载入二次编辑 (`Edit`)、一键重印 (`Print`)、导出图片 (`Export`) 与删除。支持自定义历史容量上限（5-100 个，默认 30 个），超限自动 FIFO 滚动淘汰清理。
- 🔒 **打印独立开关与全面脱敏**：
  - 提供可视化的 `Enable Printing` 独立开关，关闭时自动隐藏打印按钮与打印机状态药丸，呈现极致纯粹的无干扰数字手绘板；
  - 零硬编码局域网私有 IP，配置全面脱敏安全。
- 🌐 **多模式网络打印机通信栈**：
  - 模式 1：局域网直接 IPP 通信 (Port 631)
  - 模式 2：Home Assistant 官方服务/脚本桥接中继（彻底穿透 HTTPS 跨域同源限制）
  - 模式 3：专用伴生打印网关（如 `epson-web-printer` / CUPS）
  - 模式 4：全平台系统级原生打印回退（免任何网络配置，一键唤醒 AirPrint / Mopria）
- 🎛️ **扁平化 GUI 配置编辑器**：采用标准扁平 `<ha-form>` 下拉菜单，杜绝单选按钮无法反选、嵌套对象无法保存等问题。

---

## 🔬 打印原理与预计支持范围 (Printing Principles & Scope)

### 打印底层原理解析

1. **虚拟高精坐标映射与 300 DPI 物理光栅化 (Bounding Box Rasterization)**：
   - 用户在无限画布上绘制的线条基于高精矢量坐标记录。
   - 打印调度时，算法自动扫描非透明像素的极值坐标 $[X_{\min}, Y_{\min}, X_{\max}, Y_{\max}]$，裁除外围无边界空白，并补充 10mm 打印安全边界。
   - 内存离屏 Canvas（Offscreen Canvas）根据所选纸张物理规格按标准 300 DPI 分配像素：
     $$\text{A4 离屏像素} = \frac{210\text{ mm}}{25.4\text{ mm/英寸}} \times 300\text{ DPI} \approx 2480\text{ 像素 (宽)} \times 3508\text{ 像素 (高)}$$
   - 绘制图案保持长宽比（Aspect Ratio Preserved）居中映射，无论是大幅速写还是细小签名，实体出纸均细腻平滑。

2. **通信协议栈与浏览器安全限制应对 (CORS & Mixed Content)**：
   - **IPP (RFC 8011)**：基于 HTTP 631 端口传输的 `application/ipp` 二进制协议，封装标准 `Print-Job` 指令及纸张规格参数。
   - **HTTPS 跨域 Mixed Content 突破**：当用户通过 SSL 证书或 Nabu Casa 远程访问 Home Assistant 时，现代浏览器会强制拦截页面向局域网纯 HTTP 打印机 IP 发起的直连请求。Canvas Card 构建了四级回退链路：
     1. *直连 IPP*：在本地 HTTP 访问或开放 CORS 的内网环境下直接与打印机 631 端口握手；
     2. *HA 服务桥接*：将光栅化数据通过 Home Assistant 后端中继发往打印机，规避客户端浏览器限制；
     3. *专用网关*：投递至此前部署的 `epson-web-printer` 或本地 CUPS 容器；
     4. *系统级原生打印*：一键调起浏览器底层打印对话框，无缝对接手机/平板已配对的 AirPrint 或 Mopria 打印机。

### 预计支持打印机范围矩阵

| 品牌 / 分类 | 代表支持机型 | 通信协议 | 推荐接入模式 |
| :--- | :--- | :--- | :--- |
| **Epson (爱普生)** | EcoTank 墨仓全系列 (ET-5150, ET-2800, ET-8550, L3150 等), WorkForce | IPP (Port 631), ESC/P-R, RAW 9100, AirPrint | 直连 IPP / HA 桥接 / 网关 |
| **HP (惠普)** | LaserJet 激光系列, OfficeJet Pro, DeskJet, ENVY 全系列 | IPP / IPPS, ePrint, AirPrint, PCL3GUI | 直连 IPP / HA 官方 IPP 集成 |
| **Canon (佳能)** | PIXMA 喷墨系列 (TS/G 系列), MAXIFY, imageRUNNER | IPP, UFR II, AirPrint | 直连 IPP / AirPrint |
| **Brother (兄弟)** | HL 黑白/彩色激光机, MFC 多功能一体机, DCP 系列 | IPP, B-Net, RAW 9100 | 直连 IPP / RAW 9100 |
| **热敏小票 / 标签机** | 芯烨 (Xprinter), 佳博 (Gprinter), MUNBYN, 爱普生 TM 系列 | ESC/POS (Port 9100), TSPL, IPP | 局域网 RAW 9100 / HA 桥接 |
| **系统全兼容打印** | 任何已连接至手机、平板或电脑的本地/无线打印机 | iOS AirPrint, Android Mopria, Windows 打印机, CUPS | 系统级原生打印对话框 |

---

## 📦 安装指南

### 方式 1：通过 HACS 安装（推荐）

1. 在 Home Assistant 中打开 **HACS**；
2. 点击右上角三个点 $\to$ **自定义代码库 (Custom repositories)**；
3. 输入仓库地址：`https://github.com/lucayunxiao/whiteboard-canvas-card`，类别选择 **Plugin**；
4. 在应用商店中搜索 `Whiteboard Canvas Card` 并点击 **下载 (Download)**；
5. 刷新浏览器页面即可。

[![Open your Home Assistant instance and open a repository inside the Home Assistant Community Store.](https://my.home-assistant.io/badges/hacs_repository.svg)](https://my.home-assistant.io/redirect/hacs_repository/?owner=lucayunxiao&repository=whiteboard-canvas-card&category=plugin)

### 方式 2：手动安装

1. 下载 [`dist/whiteboard-canvas-card.js`](https://raw.githubusercontent.com/lucayunxiao/whiteboard-canvas-card/main/dist/whiteboard-canvas-card.js)；
2. 将 `whiteboard-canvas-card.js` 复制到 Home Assistant 配置目录下的 `<config>/www/` 中；
3. 进入 **设置 > 仪表盘 > 右上角三个点 > 资源**；
4. 点击 **添加资源**，URL 填写 `/local/whiteboard-canvas-card.js?v=1.1.0`，资源类型选择 `JavaScript Module`；
5. 刷新浏览器缓存。

---

## ⚙️ 配置说明

### 图形化配置编辑器
在仪表盘中添加卡片并选择 **编辑卡片**，即可通过可视化表单调整配置：

- **Card Title**：卡片顶栏显示的自定义标题；
- **Max History Items**：历史画廊保存的最大记录数（滑块范围 5 到 100，默认 30），超限自动按先进先出（FIFO）淘汰旧记录；
- **Enable Printing Feature**：独立打印功能开关。开启后顶栏显示打印按钮与打印机状态药丸；关闭时完全隐藏，呈现极致纯粹的无干扰数字手绘白板；
- **Printer IP Address / Hostname**：打印机的局域网固定 IP 或主机名（可选，例如 `192.168.1.100` 或 `printer.local`，默认留空脱敏）；
- **Printer Port**：打印机端口（默认 IPP 为 `631`）；
- **Printing Protocol / Dispatch Mode**：打印调度模式（直连 IPP、HA 服务桥接、专用网关或系统原生打印）；
- **Canvas Background**：画布底纹样式（高对比工程网格、纯白底纸或手帐点阵）；
- **Card Viewport Height**：卡片在页面上的视口高度（350px 至 1200px 可调）；
- **Confirm before Discarding**：放弃画稿前确认弹窗开关。

### YAML 配置示例

#### 纯白板手绘模式（默认关闭打印功能）：
```yaml
type: custom:whiteboard-canvas-card
title: "手绘涂鸦白板"
enable_printing: false
canvas_bg: "grid"
confirm_discard: true
max_history_items: 30
height: 560
```

#### 启用网络硬件打印机与交互式取景框：
```yaml
type: custom:whiteboard-canvas-card
title: "创意画板与网络打印"
enable_printing: true
printer_ip: "192.168.1.100"
printer_port: 631
print_mode: "ipp"
canvas_bg: "grid"
confirm_discard: true
max_history_items: 50
height: 600
```

---

## 🤝 官方 HACS 默认商店收录指南 (Include in Default)

按照 [HACS 官方收录要求 (Publish - Include Before You Start)](https://www.hacs.xyz/docs/publish/include/#before-you-start) 执行：

1. **本地质量核验**：
   - 确认包含完整的 `hacs.json`、`whiteboard-canvas-card.js` 与 `.github/workflows/validate.yaml`，且 HACS Action 检查为 0 错误 0 警告；
   - 创建标准语义化 Git Tag（如 `v1.1.0`）并在 GitHub 发布附带编译包资产的 Release。
2. **Fork 官方仓库**：
   在 GitHub 上访问并 Fork [https://github.com/hacs/default](https://github.com/hacs/default) 至个人账号。
3. **在 `plugin` 文件中追加记录**：
   在 Fork 仓库的根目录下编辑 `plugin` 纯文本文件。
   > [!IMPORTANT]
   > 官方要求条目必须按**严格字母升序 (Alphabetical Order)** 排列。`whiteboard-canvas-card` 首字母为 `w`，排在 `lucayunxiao/tts-broadcast-card` (`t`) **之后**：
   ```text
   ...
   lucayunxiao/tts-broadcast-card
   lucayunxiao/whiteboard-canvas-card
   ...
   ```
4. **提交 Pull Request**：
   创建功能分支（如 `git checkout -b add-whiteboard-canvas-card`），向 `hacs/default:master` 发起 PR，按要求勾选确认模板项，等待 CI 验证通过并由社区维护者合并。

---

## 📄 开源协议

本项目采用 [MIT 许可证](LICENSE) 开源发布。
