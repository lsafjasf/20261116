/* sample.js — 含三层的示例地图（海岸线 / 道路 / 行政边界） */
(function (root) {
  "use strict";
  root.SampleMap = function () {
    return {
      version: 1,
      name: "示例地图·三层",
      layers: [
        {
          id: "coast", name: "海岸线", kind: "coastline", visible: true,
          style: { width: 5, lineJoin: "round", color: "#1b6ca8", dash: null },
          label: { text: "鹭江海岸线", show: true, fontSize: 14, color: "#1b6ca8" },
          features: [
            { id: "coast-1", closed: false, points: [
              { x: 40, y: 150 }, { x: 140, y: 120 }, { x: 250, y: 160 },
              { x: 360, y: 130 }, { x: 470, y: 170 }, { x: 590, y: 140 },
              { x: 700, y: 180 }, { x: 830, y: 150 }, { x: 920, y: 190 },
            ] },
          ],
        },
        {
          id: "road", name: "道路", kind: "road", visible: true,
          style: { width: 4, lineJoin: "round", color: "#d35400", dash: null },
          label: { text: "滨海主干道", show: true, fontSize: 13, color: "#b34700" },
          features: [
            { id: "road-1", closed: false, points: [
              { x: 60, y: 320 }, { x: 200, y: 300 }, { x: 340, y: 330 },
              { x: 480, y: 300 }, { x: 640, y: 340 }, { x: 820, y: 310 },
            ] },
            { id: "road-2", closed: false, points: [
              { x: 300, y: 200 }, { x: 320, y: 330 }, { x: 300, y: 470 },
            ] },
          ],
        },
        {
          id: "admin", name: "行政边界", kind: "boundary", visible: true,
          style: { width: 2.5, lineJoin: "miter", color: "#7d3c98", dash: "8 5" },
          label: { text: "云湖区界", show: true, fontSize: 13, color: "#7d3c98" },
          features: [
            { id: "admin-1", closed: true, points: [
              { x: 150, y: 230 }, { x: 480, y: 210 }, { x: 760, y: 240 },
              { x: 860, y: 420 }, { x: 560, y: 520 }, { x: 240, y: 500 },
              { x: 100, y: 380 },
            ] },
          ],
        },
      ],
    };
  };
})(typeof self !== "undefined" ? self : globalThis);
