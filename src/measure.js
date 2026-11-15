export function fontString(style) {
  return `${style.fontWeight} ${style.fontSize}px ${style.fontFamily}`;
}

export function createCanvasMeasurer() {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  return (text, style) => {
    context.font = fontString(style);
    return context.measureText(text).width;
  };
}

function unitWidth(char, style) {
  if (char === " ") return 0.29;
  const code = char.codePointAt(0);
  const cjk = code >= 0x2e80;
  if (cjk) return 1;
  if (/[A-Z]/.test(char)) return 0.64;
  if (/[a-z]/.test(char)) return 0.52;
  if (/[0-9]/.test(char)) return 0.56;
  if (/[.,;:!?'"()[\]{}]/.test(char)) return 0.33;
  return 0.6;
}

export function createApproxMeasurer() {
  return (text, style) => {
    const family = String(style.fontFamily).toLowerCase();
    const familyFactor = family.includes("mono") ? 0.62 : family.includes("serif") ? 0.54 : 0.55;
    const weightFactor = 1 + (Number(style.fontWeight) - 400) * 0.00018;
    let em = 0;
    for (const char of Array.from(text)) em += unitWidth(char, style);
    return em * style.fontSize * familyFactor * weightFactor;
  };
}
