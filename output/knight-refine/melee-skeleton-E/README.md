# Melee E 二维骨架标注

15帧，单帧256×256，透明PNG，图集3840×256，从左到右播放。绿色为人物关节链；红色实心端点连线为剑的握点到剑尖，另一条红线为盾牌长轴。虚线表示遮挡或不确定的位置。

这是根据原PNG人工估计的二维投影，不是恢复出的原始骨骼，也没有深度与真实骨长。尤其刀光遮住的肢体和剑，以及转身时左右肢体的对应，均需要人工校正。near/far标签只是图像中的跟踪链，不保证解剖学左右。不能直接当作精确换装绑定。

- overlay-and-skeleton.gif：左叠加原图，右独立骨架。
- skeleton-only.gif：独立骨架预览。
- overlay-contact-sheet.png：15帧叠加检查图。
- body-bones-15frames.png / weapon-bones-15frames.png：独立人物/武器骨架层。
- skeleton-15frames.png：绿色+红色透明骨架图集。
- frames/：逐帧四种分层PNG。
- joints.json / joints.csv：可编辑关节坐标，坐标原点为左上角。

预览按每帧100ms循环；原Unity动作是非循环片段，结束时间1.4166666秒。原素材未修改。
