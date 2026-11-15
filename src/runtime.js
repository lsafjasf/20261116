export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = "noopener";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function svgBlob(svg) {
  return new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
}

let fontPayloadPromise = null;

async function fontPayload() {
  if (!fontPayloadPromise) {
    fontPayloadPromise = fetch("./assets/fonts/AtlasNotoSansSC-Regular.woff2")
      .then((response) => {
        if (!response.ok) throw new Error(`字体资源返回 ${response.status}`);
        return response.arrayBuffer();
      })
      .then((buffer) => {
        const bytes = new Uint8Array(buffer);
        let binary = "";
        const chunkSize = 0x8000;
        for (let index = 0; index < bytes.length; index += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
        }
        return btoa(binary);
      });
  }
  return fontPayloadPromise;
}

export async function standaloneSvg(svg) {
  try {
    const base64 = await fontPayload();
    const fontFace = `<style>@font-face{font-family:'AtlasNoto';` +
      `src:url(data:font/woff2;base64,${base64}) format('woff2');` +
      `font-style:normal;font-weight:100 900;}</style>`;
    return {
      svg: svg.replace("<style>", `${fontFace}<style>`),
      fontEmbedded: true
    };
  } catch (error) {
    return { svg, fontEmbedded: false, error };
  }
}

function imageFromUrl(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    const timer = setTimeout(() => reject(new Error("SVG 光栅化超时")), 5000);
    image.onload = () => {
      clearTimeout(timer);
      resolve(image);
    };
    image.onerror = () => {
      clearTimeout(timer);
      reject(new Error("SVG 光栅化失败"));
    };
    image.src = url;
  });
}

export async function rasterizeSvg(svg, width, height, scale = 2, target = "blob") {
  const url = URL.createObjectURL(svgBlob(svg));
  try {
    const image = await imageFromUrl(url);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas 2D 上下文不可用");
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    if (target === "dataUrl") return canvas.toDataURL("image/png");
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("PNG 编码失败"));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function makeThumbnail(svg, width, height, options = {}) {
  if (options.forceFailure) throw new Error("已启用缩略图故障演示");
  const targetWidth = 220;
  const targetHeight = Math.max(44, Math.round(targetWidth * (height / width)));
  return rasterizeSvg(svg, targetWidth, targetHeight, 1, "dataUrl");
}

export async function fetchScenarioManifest(options = {}) {
  if (options.forceFailure) throw new Error("已启用异步请求故障演示");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2600);
  try {
    const response = await fetch("/api/scenarios", {
      cache: "no-store",
      signal: controller.signal,
      headers: { accept: "application/json" }
    });
    if (!response.ok) throw new Error(`异步接口返回 ${response.status}`);
    const payload = await response.json();
    if (!Array.isArray(payload.scenarios)) throw new Error("异步参数结构无效");
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

export function formatTime(iso) {
  try {
    return new Intl.DateTimeFormat("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      month: "2-digit",
      day: "2-digit"
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

export async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}
