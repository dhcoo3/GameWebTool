# 本机 UI 分割

在项目根目录执行：

```sh
npm run ui:segmentation:setup
npm run ui:segmentation:pilot -- '/完整路径/source.png'
npm run test:ui-segmentation
```

依赖固定在 `requirements.lock.txt`；模型固定为 Meta 官方 SAM 2.1 Tiny 的 safetensors 权重和处理配置。环境、单份模型和下载元数据仅放在 `.local/ui-segmentation`，不提交 Git。无需 CUDA、训练环境或视频模型。实际安装约 1.1 GiB。

Node 通过 JSON Lines 调用单个 Python 工作进程，串行处理任务，空闲 120 秒后结束进程释放模型。MPS 不可用时显示 CPU；运行时发生 MPS 兼容错误时切换 CPU，并返回原因。PNG 蒙版返回原图位置和尺寸；不会静默把空蒙版换成矩形。

样张主测试使用人工校准框，分别运行全图、带上下文局部图，每个对象保留三个候选。它验证轮廓模型能力，不代表自动检测准确率。`render_pilot.py` 生成原尺寸素材、棋盘格对比、独立重组与隐藏按钮预览。徽章局部修正试验记录在验收输出中；`correct_pilot.py` 可重现已记录的子区域蒙版替换。

工作台流程：导入/生成 → AI 识别组件和层级 → 调整定位框或 AI 校正局部框 → 分割全部/选中层 → 切换候选、画笔验边 → 逐层确认 → 确认方案 → ZIP。框用于分割提示；改框会使旧蒙版失效，不拉伸素材。

背景补齐：选择底层 → 预览粉色范围 → 确认范围 → Gemini 请求 → 查看模型完整结果和局部合成 → 确认版本。只有确认版本才导出，重建区域有独立蒙版。原图与全部候选保留在项目中。

原像素指解码为 sRGB 后的可见像素。硬边蒙版和直接 PNG RGBA 编码避免透明边缘的额外 RGB 四舍五入；原始半透明前景、真实遮挡关系与隐藏内容无法从单张平面图唯一恢复。整图重组一致只验证像素归属与坐标，不能替代语义验边。

Unity ZIP 解压到工程根目录，执行 `Tools > 生产工厂 > 导入 UI 资源`。v2 创建逻辑分组和独立 Canvas 排序，v1 仍按旧平铺方式导入。实际验收环境及结果见 `output/ui-segmentation-pilot/ACCEPTANCE.md`。
