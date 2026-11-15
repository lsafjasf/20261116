// 仅用于 Node 测试环境复用字段定义，浏览器侧使用 storage.js。
module.exports.FIELD_DEFS = [
  { key: 'skinColor', label: '肤色', type: 'color', group: 'colors' },
  { key: 'armorColor', label: '装甲色', type: 'color', group: 'colors' },
  { key: 'capeColor', label: '披风色', type: 'color', group: 'colors' },
  { key: 'weapon', label: '武器', type: 'select', group: 'equipment',
    options: ['none', 'sword', 'staff', 'bow'] },
  { key: 'helmet', label: '头盔', type: 'select', group: 'equipment',
    options: ['none', 'light', 'heavy'] },
  { key: 'shield', label: '盾牌', type: 'select', group: 'equipment',
    options: ['none', 'buckler', 'tower'] },
  { key: 'speed', label: '动画速度', type: 'range', group: 'animation', min: 0, max: 100, step: 1 },
  { key: 'bounce', label: '弹跳幅度', type: 'range', group: 'animation', min: 0, max: 40, step: 1 },
  { key: 'swing', label: '挥摆角度', type: 'range', group: 'animation', min: 0, max: 90, step: 1 },
];
