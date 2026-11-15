import { FIELD_DEFS } from './storage.js';

export function buildControls(root, onInput) {
  const refs = {};
  for (const groupName of ['colors', 'equipment', 'animation']) {
    const host = document.getElementById(`${groupName}Fields`);
    for (const def of FIELD_DEFS.filter((d) => d.group === groupName)) {
      const wrap = document.createElement('div');
      wrap.className = 'field';
      const id = `input-${def.key}`;
      const label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = def.label;
      wrap.append(label);

      let input;
      if (def.type === 'color') {
        input = document.createElement('input');
        input.type = 'color';
      } else if (def.type === 'select') {
        input = document.createElement('select');
        for (const opt of def.options) {
          const option = document.createElement('option');
          option.value = opt;
          option.textContent = opt;
          input.append(option);
        }
      } else {
        input = document.createElement('input');
        input.type = 'range';
        input.min = def.min;
        input.max = def.max;
        input.step = def.step;
        const hint = document.createElement('span');
        hint.className = 'value-hint';
        hint.id = `hint-${def.key}`;
        wrap.append(input, hint);
        input.hintEl = hint;
      }
      input.id = id;
      input.dataset.fieldKey = def.key;
      input.dataset.fieldGroup = groupName;
      input.addEventListener('input', () => onInput(def, input));
      if (def.type !== 'range') wrap.append(input);
      host.append(wrap);
      refs[def.key] = input;
    }
  }
  return refs;
}

export function syncControls(refs, config) {
  for (const def of FIELD_DEFS) {
    const input = refs[def.key];
    const value = config[def.group][def.key];
    if (input.value !== String(value)) input.value = value;
    if (def.type === 'range') input.hintEl.textContent = `${value} (${def.min}-${def.max})`;
  }
}

export function readFieldValue(def, input) {
  if (def.type === 'range') return Number(input.value);
  return input.value;
}

export function renderCharacter(svg, config) {
  const { colors, equipment, animation } = config;
  const dur = Math.max(0.2, 2.2 - animation.speed / 45).toFixed(2);
  const weaponShape = {
    none: '',
    sword: '<g class="part-weapon"><line x1="172" y1="120" x2="206" y2="70" stroke="#cfd6e4" stroke-width="6" stroke-linecap="round"/><line x1="166" y1="128" x2="180" y2="116" stroke="#8a6a3a" stroke-width="5"/></g>',
    staff: '<g class="part-weapon"><line x1="176" y1="70" x2="176" y2="210" stroke="#7a5230" stroke-width="5"/><circle cx="176" cy="64" r="10" fill="#7fd99b"/></g>',
    bow: '<g class="part-weapon"><path d="M196 80 Q160 150 196 220" fill="none" stroke="#9a6b3f" stroke-width="4"/><line x1="196" y1="80" x2="196" y2="220" stroke="#cfd6e4" stroke-width="1.5"/></g>',
  }[equipment.weapon];
  const helmetShape = {
    none: '',
    light: `<path class="part-helmet" d="M92 78 Q120 48 148 78 Z" fill="#9fb2d4" stroke="#5f7396"/>`,
    heavy: `<path class="part-helmet" d="M88 82 Q120 40 152 82 L152 96 L88 96 Z" fill="#6f83a8" stroke="#3c4a66"/><rect x="104" y="70" width="32" height="8" fill="#3c4a66"/>`,
  }[equipment.helmet];
  const shieldShape = {
    none: '',
    buckler: '<ellipse class="part-shield" cx="66" cy="150" rx="16" ry="20" fill="#b08a4a" stroke="#6b4f24"/>',
    tower: '<rect class="part-shield" x="46" y="120" width="26" height="70" rx="8" fill="#8a6a3a" stroke="#523f20"/>',
  }[equipment.shield];

  svg.innerHTML = `
    <title id="svgTitle">角色预览</title>
    <desc id="svgDesc">武器 ${equipment.weapon}，头盔 ${equipment.helmet}，盾牌 ${equipment.shield}</desc>
    <style>
      .bounce { animation: bob ${dur}s ease-in-out infinite alternate; }
      .swinger { transform-box: fill-box; transform-origin: 50% 10%; animation: swing ${dur}s ease-in-out infinite alternate; }
      @keyframes bob { from { transform: translateY(0); } to { transform: translateY(${animation.bounce}px); } }
      @keyframes swing { from { transform: rotate(${-animation.swing}deg); } to { transform: rotate(${animation.swing}deg); } }
      @media (prefers-reduced-motion: reduce) { .bounce, .swinger { animation: none; } }
    </style>
    <g class="bounce">
      <ellipse cx="120" cy="300" rx="56" ry="10" fill="rgba(0,0,0,0.35)"/>
      <path class="part-cape" d="M86 108 Q120 132 154 108 L164 210 Q120 232 76 210 Z" fill="${colors.capeColor}" opacity="0.92"/>
      <rect class="part-body" x="90" y="104" width="60" height="96" rx="16" fill="${colors.armorColor}"/>
      <circle class="part-head" cx="120" cy="76" r="28" fill="${colors.skinColor}"/>
      ${helmetShape}
      <g class="swinger">
        <rect x="146" y="112" width="14" height="66" rx="7" fill="${colors.skinColor}"/>
        ${weaponShape}
      </g>
      <rect x="80" y="112" width="14" height="62" rx="7" fill="${colors.skinColor}"/>
      ${shieldShape}
      <rect x="98" y="200" width="18" height="70" rx="8" fill="#3a4358"/>
      <rect x="124" y="200" width="18" height="70" rx="8" fill="#3a4358"/>
    </g>`;
}

export function buildDiff(host, current, incoming, labelMap) {
  host.textContent = '';
  let changeCount = 0;
  for (const def of FIELD_DEFS) {
    const oldVal = current[def.group][def.key];
    const newVal = incoming[def.group][def.key];
    if (oldVal === newVal) continue;
    changeCount += 1;
    const row = document.createElement('div');
    row.className = 'diff-row diff-changed';
    row.innerHTML = `<span class="diff-path">${labelMap[def.key]}</span>
      <span class="diff-old">旧：${oldVal}</span>
      <span class="diff-new">新：${newVal}</span>`;
    host.append(row);
  }
  if (changeCount === 0) {
    host.innerHTML = '<p class="diff-none">两份配置完全相同，没有差异。</p>';
  }
  return changeCount;
}
