import { createNode, resetIdCounter } from './scene.js';
import { addKeyframe } from './keyframes.js';

// 三层对象树：
// root(舞台)
//  └─ cardGroup(卡片组, L1) —— clipped，超出 clipRect 的子内容被裁掉
//      ├─ backdrop(背景矩形, L2)
//      ├─ badge(标记圆, L2) —— 带位移/颜色关键帧
//      └─ grid(网格层, L2) —— 与 backdrop 重叠，靠后绘制覆盖前者，验证绘制顺序
//          └─ marker(标记方块, L3)
export function buildDemoScene() {
  resetIdCounter(0);
  const root = createNode({
    id: 'stage',
    name: '舞台',
    type: 'group',
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
  });

  const marker = createNode({
    id: 'marker',
    name: '标记方块',
    type: 'rect',
    geometry: { w: 18, h: 18 },
    transform: { x: 30, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fill: '#ff4d4f', opacity: 1 },
  });

  const grid = createNode({
    id: 'grid',
    name: '网格层',
    type: 'rect',
    geometry: { w: 70, h: 70 },
    transform: { x: 30, y: 20, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fill: '#22c55e', opacity: 0.85 },
  });
  grid.children.push(marker);

  const backdrop = createNode({
    id: 'backdrop',
    name: '卡片背景',
    type: 'rect',
    geometry: { w: 160, h: 120 },
    transform: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fill: '#4f8cff', opacity: 1 },
  });

  const badge = createNode({
    id: 'badge',
    name: '状态标记',
    type: 'ellipse',
    geometry: { w: 44, h: 44 },
    transform: { x: -40, y: -30, rotation: 0, scaleX: 1, scaleY: 1 },
    style: { fill: '#f59e0b', opacity: 1 },
  });
  addKeyframe(badge, 'x', 0, -40);
  addKeyframe(badge, 'x', 60, 50);
  addKeyframe(badge, 'fill', 0, '#f59e0b');
  addKeyframe(badge, 'fill', 60, '#10b981');

  const cardGroup = createNode({
    id: 'cardGroup',
    name: '卡片组',
    type: 'group',
    clipped: true,
    clipRect: { x: -90, y: -70, w: 180, h: 140 },
    transform: { x: 240, y: 180, rotation: 0, scaleX: 1, scaleY: 1 },
  });
  cardGroup.children.push(backdrop, badge, grid);

  root.children.push(cardGroup);
  return root;
}

// 测试参数三组：默认 / 边界 / 异常
export function testParams() {
  return {
    default: {
      label: '默认参数',
      canvas: { width: 480, height: 360, background: '#f4f6fa' },
      selectId: 'marker',
      parentMove: { id: 'cardGroup', dx: 50, dy: 25 },
      hideId: 'cardGroup',
      deleteId: 'badge',
      sampleTime: 30,
      resourceKey: 'tex/default',
    },
    boundary: {
      label: '边界参数',
      canvas: { width: 1, height: 1, background: '#f4f6fa' },
      selectId: 'grid',
      parentMove: { id: 'cardGroup', dx: 0, dy: 0 },
      hideId: 'grid',
      deleteId: 'marker',
      sampleTime: 0,
      extreme: { nodeId: 'backdrop', scaleX: 0, opacity: 0 },
      resourceKey: 'tex/boundary',
      reorderTarget: 0,
    },
    abnormal: {
      label: '异常参数',
      canvas: { width: 480, height: 360, background: '#f4f6fa' },
      selectId: 'not-exist-id',
      parentMove: { id: 'ghost', dx: 10, dy: 10 },
      hideId: 'ghost',
      deleteId: 'stage',
      sampleTime: -5,
      badColor: '#12345',
      badOpacity: 2,
      resourceKey: 'tex/missing',
      fault: 'network',
    },
  };
}
