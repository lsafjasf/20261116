// 最小 CanvasRenderingContext2D 桩：记录关键绘制调用，供无浏览器环境核对渲染行为
export class MockCtx {
  constructor(width, height) {
    this.canvas = { width, height };
    this.calls = [];
    this.setLineDashCalls = [];
    this.font = ''; this.fillStyle = ''; this.strokeStyle = ''; this.lineWidth = 1;
    this.textAlign = 'left'; this.globalAlpha = 1;
  }
  log(name, args) { this.calls.push({ name, args }); }
  clearRect(...a) { this.log('clearRect', a); }
  fillRect(...a) { this.log('fillRect', a); }
  strokeRect(...a) { this.log('strokeRect', a); }
  beginPath() { this.log('beginPath', []); }
  moveTo(...a) { this.log('moveTo', a); }
  lineTo(...a) { this.log('lineTo', a); }
  arc(...a) { this.log('arc', a); }
  fill(...a) { this.log('fill', a); }
  stroke(...a) { this.log('stroke', a); }
  fillText(...a) { this.log('fillText', a); }
  closePath() { this.log('closePath', []); }
  setLineDash(d) { this.setLineDashCalls.push(d); this.log('setLineDash', [d]); }
  setTransform() {}
  findText(substr) {
    return this.calls.filter((c) => c.name === 'fillText' &&
      String(c.args[0]).includes(substr));
  }
  textValues() {
    return this.calls.filter((c) => c.name === 'fillText').map((c) => String(c.args[0]));
  }
  lineCount() {
    return this.calls.filter((c) => c.name === 'lineTo').length;
  }
}
