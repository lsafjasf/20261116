export function createDemoProject(frames) {
  if (!Array.isArray(frames) || frames.length === 0) throw new Error("Frames are required");
  const keyframeIndexes = [0, Math.floor(frames.length / 3), Math.floor((frames.length * 2) / 3), frames.length - 1];
  const palette = ["#ffb54a", "#6ee7ff", "#ff6b9a", "#9d8cff"];
  return {
    version: 1,
    id: "sprite-lab-628",
    revision: 1,
    frameOrder: frames.map((frame) => frame.id),
    layers: [
      { id: "backdrop", name: "背景层", order: 0, visible: true, color: "#18243a", opacity: 1 },
      { id: "character", name: "角色层", order: 1, visible: true, color: palette[0], opacity: 1 },
      { id: "effects", name: "特效层", order: 2, visible: true, color: palette[1], opacity: 0.86 },
    ],
    keyframes: keyframeIndexes.map((index, order) => ({
      id: `key-${order}`,
      index,
      name: ["待机", "踏步", "冲刺", "收势"][order],
      frameId: frames[index].id,
      colors: {
        backdrop: ["#18243a", "#1b2b45", "#20304d", "#162033"][order],
        character: frames[index].colors[0],
        effects: palette[(order + 1) % palette.length],
      },
      easing: "ease-in-out",
    })),
    selectedFrameId: frames[0].id,
    selectedLayerId: "character",
    palette,
    background: "#0b111d",
  };
}

export function cloneProject(project) {
  return JSON.parse(JSON.stringify(project));
}

export function projectFingerprint(project, packer) {
  const slices = [];
  for (const id of project.frameOrder) {
    const placement = packer.placements.get(id);
    if (!placement) continue;
    slices.push({
      id,
      x: placement.x,
      y: placement.y,
      w: placement.w,
      h: placement.h,
      rotated: placement.rotated,
      colors: placement.colors,
      sourceSize: [placement.sourceWidth, placement.sourceHeight],
      spriteSourceSize: [
        placement.trimRect.x,
        placement.trimRect.y,
        placement.trimRect.w,
        placement.trimRect.h,
      ],
    });
  }
  return stableStringify({
    layerOrder: project.layers.map((layer) => ({
      id: layer.id,
      order: layer.order,
      color: layer.color,
      visible: layer.visible,
      opacity: layer.opacity,
    })),
    keyframes: project.keyframes,
    selectedFrameId: project.selectedFrameId,
    selectedLayerId: project.selectedLayerId,
    frameOrder: project.frameOrder,
    slices,
  });
}

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}
