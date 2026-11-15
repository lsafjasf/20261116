import { layoutText } from "./layout.js";

export class LayoutEngine {
  constructor(measure) {
    this.measure = measure;
  }

  layout(text, style) {
    return layoutText(text, style, this.measure);
  }
}
