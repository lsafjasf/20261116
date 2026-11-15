(function () {
  "use strict";

  const sampleA = {
    id: "sample-a",
    code: "A",
    name: "园区核心网 · 双活汇聚",
    shortName: "样例 A · 双活汇聚",
    projectName: "核心园区 · 双活链路",
    description: "11 个有效节点、14 条有效链路，含空名称 / 空坐标、重复节点与重复链路、负延迟和超限容量。",
    versionSeed: "2026.11.16-A",
    routes: [
      {
        id: "route-primary",
        name: "生产主路径",
        kind: "primary",
        nodeIds: ["GW-EDGE-01", "RT-CORE-A", "RT-AGG-B", "RT-EDGE-A", "TERM-API-01"]
      },
      {
        id: "route-backup-a",
        name: "备用路径 A",
        kind: "backup",
        nodeIds: ["GW-EDGE-01", "RT-CORE-B", "RT-AGG-B", "RT-EDGE-A", "TERM-API-01"]
      },
      {
        id: "route-backup-b",
        name: "备用路径 B",
        kind: "backup",
        nodeIds: ["GW-EDGE-01", "RT-CORE-A", "RT-AGG-A", "RT-EDGE-A", "TERM-API-01"]
      }
    ],
    nodes: [
      { id: "GW-EDGE-01", type: "gateway", name: "园区边缘网关", x: 105, y: 380, zone: "边界区", status: "up", model: "GW-4200", ip: "10.16.0.1" },
      { id: "RT-CORE-A", type: "router", name: "核心路由 A", x: 330, y: 245, zone: "核心区", status: "up", model: "CR-9800", ip: "10.16.1.1" },
      { id: "RT-CORE-B", type: "router", name: "核心路由 B", x: 330, y: 515, zone: "核心区", status: "up", model: "CR-9800", ip: "10.16.1.2" },
      { id: "RT-AGG-A", type: "router", name: "汇聚路由 A", x: 580, y: 145, zone: "汇聚区", status: "up", model: "AR-7600", ip: "10.16.2.1" },
      { id: "RT-AGG-B", type: "router", name: "汇聚路由 B", x: 580, y: 380, zone: "汇聚区", status: "up", model: "AR-7600", ip: "10.16.2.2" },
      { id: "RT-AGG-C", type: "router", name: "汇聚路由 C", x: 580, y: 615, zone: "汇聚区", status: "degraded", model: "AR-7600", ip: "10.16.2.3" },
      { id: "RT-AGG-B", type: "router", name: "汇聚路由 B · 重复记录", x: 580, y: 380, zone: "汇聚区", status: "up", model: "AR-7600", ip: "10.16.2.2" },
      { id: "RT-EDGE-A", type: "router", name: "接入路由 A", x: 825, y: 245, zone: "接入区", status: "up", model: "ER-3200", ip: "10.16.3.1" },
      { id: "RT-EDGE-B", type: "router", name: "接入路由 B", x: 825, y: 515, zone: "接入区", status: "up", model: "ER-3200", ip: "10.16.3.2" },
      { id: "TERM-IOT-07", type: "terminal", name: "IoT 采集器 07", x: null, y: null, zone: "终端区", status: "up", model: "EDGE-IOT", ip: "10.16.8.17" },
      { id: "TERM-API-01", type: "terminal", name: "业务 API 集群", x: 1050, y: 380, zone: "终端区", status: "up", model: "API-NODE", ip: "10.16.9.11" },
      { id: "TERM-HMI-02", type: "terminal", name: null, x: 9999, y: -40, zone: "终端区", status: "up", model: "HMI-PANEL", ip: null }
    ],
    links: [
      { id: "L-GW-CORE-A", source: "GW-EDGE-01", target: "RT-CORE-A", capacityMbps: 10000, latencyMs: 0.6 },
      { id: "L-GW-CORE-B", source: "GW-EDGE-01", target: "RT-CORE-B", capacityMbps: null, latencyMs: 0.7 },
      { id: "L-CORE-A-AGG-A", source: "RT-CORE-A", target: "RT-AGG-A", capacityMbps: 25000, latencyMs: 0.4 },
      { id: "L-CORE-A-AGG-B", source: "RT-CORE-A", target: "RT-AGG-B", capacityMbps: 25000, latencyMs: 0.5 },
      { id: "L-CORE-B-AGG-B", source: "RT-CORE-B", target: "RT-AGG-B", capacityMbps: 25000, latencyMs: 0.6 },
      { id: "L-CORE-B-AGG-C", source: "RT-CORE-B", target: "RT-AGG-C", capacityMbps: 10000, latencyMs: 0.8 },
      { id: "L-AGG-A-EDGE-A", source: "RT-AGG-A", target: "RT-EDGE-A", capacityMbps: 10000, latencyMs: 1.1 },
      { id: "L-AGG-A-EDGE-A", source: "RT-AGG-A", target: "RT-EDGE-A", capacityMbps: 10000, latencyMs: 1.1 },
      { id: "L-AGG-B-EDGE-A", source: "RT-AGG-B", target: "RT-EDGE-A", capacityMbps: 10000, latencyMs: 0.7 },
      { id: "L-AGG-B-EDGE-B", source: "RT-AGG-B", target: "RT-EDGE-B", capacityMbps: 10000, latencyMs: 0.9 },
      { id: "L-AGG-C-EDGE-B", source: "RT-AGG-C", target: "RT-EDGE-B", capacityMbps: 10000, latencyMs: -1.4 },
      { id: "L-EDGE-A-IOT", source: "RT-EDGE-A", target: "TERM-IOT-07", capacityMbps: 1000, latencyMs: 2.8 },
      { id: "L-EDGE-A-API", source: "RT-EDGE-A", target: "TERM-API-01", capacityMbps: 1000, latencyMs: 1.9 },
      { id: "L-EDGE-B-API", source: "RT-EDGE-B", target: "TERM-API-01", capacityMbps: 1000, latencyMs: 2.4 },
      { id: "L-EDGE-B-HMI", source: "RT-EDGE-B", target: "TERM-HMI-02", capacityMbps: 9999999, latencyMs: 2.6 },
      { id: "L-ORPHAN-01", source: "RT-CORE-A", target: "MISSING-NODE-99", capacityMbps: 1000, latencyMs: 4.2 },
      { id: "L-SELF-LOOP", source: "RT-CORE-B", target: "RT-CORE-B", capacityMbps: 1000, latencyMs: 0.2 }
    ],
    expected: {
      nodes: 11,
      links: 14,
      duplicateNodes: 1,
      duplicateLinks: 1,
      invalidLinks: 2,
      nullFields: 5,
      anomalies: 4
    }
  };

  const sampleB = {
    id: "sample-b",
    code: "B",
    name: "分支园区 · 边界迁移",
    shortName: "样例 B · 边界迁移",
    projectName: "分支园区 · 边界迁移",
    description: "11 个有效节点、14 条有效链路，含空值插补、重复设备记录、越界坐标、零容量与超长延迟。",
    versionSeed: "2026.11.16-B",
    routes: [
      {
        id: "route-primary",
        name: "生产主路径",
        kind: "primary",
        nodeIds: ["GW-BR-02", "RT-CORE-X", "RT-AGG-N", "RT-EDGE-P", "TERM-EDGE-05"]
      },
      {
        id: "route-backup-a",
        name: "备用路径 A",
        kind: "backup",
        nodeIds: ["GW-BR-02", "RT-CORE-Y", "RT-AGG-S", "RT-EDGE-P", "TERM-EDGE-05"]
      },
      {
        id: "route-backup-b",
        name: "备用路径 B",
        kind: "backup",
        nodeIds: ["GW-BR-02", "RT-CORE-X", "RT-AGG-N", "RT-EDGE-Q", "TERM-EDGE-05"]
      }
    ],
    nodes: [
      { id: "GW-BR-02", type: "gateway", name: "分支边界网关", x: 105, y: 380, zone: "边界区", status: "up", model: "GW-3100", ip: "10.32.0.1" },
      { id: "RT-CORE-X", type: "router", name: "核心路由 X", x: 330, y: 245, zone: "核心区", status: "up", model: "CR-8800", ip: "10.32.1.1" },
      { id: "RT-CORE-Y", type: "router", name: "核心路由 Y", x: 330, y: 515, zone: "核心区", status: "up", model: "CR-8800", ip: "10.32.1.2" },
      { id: "RT-AGG-N", type: "router", name: "北向汇聚路由", x: 565, y: 145, zone: "汇聚区", status: "up", model: "AR-6200", ip: "10.32.2.1" },
      { id: "RT-AGG-S", type: "router", name: "南向汇聚路由", x: 565, y: 380, zone: "汇聚区", status: "up", model: "AR-6200", ip: "10.32.2.2" },
      { id: "RT-AGG-N", type: "router", name: "北向汇聚路由 · 重复记录", x: 565, y: 145, zone: "汇聚区", status: "up", model: "AR-6200", ip: "10.32.2.1" },
      { id: "RT-AGG-E", type: "router", name: "东向汇聚路由", x: 565, y: 615, zone: "汇聚区", status: "degraded", model: "AR-6200", ip: "10.32.2.3" },
      { id: "RT-EDGE-P", type: "router", name: "接入路由 P", x: 815, y: 245, zone: "接入区", status: "up", model: "ER-2800", ip: "10.32.3.1" },
      { id: "RT-EDGE-Q", type: "router", name: "接入路由 Q", x: 815, y: 515, zone: "接入区", status: "up", model: "ER-2800", ip: "10.32.3.2" },
      { id: "TERM-CAM-12", type: "terminal", name: null, x: -600, y: 160, zone: "终端区", status: "up", model: "CAM-IPC", ip: "10.32.8.12" },
      { id: "TERM-EDGE-05", type: "terminal", name: "边缘业务节点 05", x: 1050, y: 380, zone: "终端区", status: "up", model: "EDGE-NODE", ip: "10.32.9.5" },
      { id: "TERM-POS-01", type: "terminal", name: "POS 终端 01", x: null, y: null, zone: "终端区", status: "up", model: "POS-TERM", ip: null }
    ],
    links: [
      { id: "L-GW-CX", source: "GW-BR-02", target: "RT-CORE-X", capacityMbps: 10000, latencyMs: 0.5 },
      { id: "L-GW-CY", source: "GW-BR-02", target: "RT-CORE-Y", capacityMbps: 10000, latencyMs: 0.7 },
      { id: "L-CX-AN", source: "RT-CORE-X", target: "RT-AGG-N", capacityMbps: 25000, latencyMs: 0.6 },
      { id: "L-CX-AN", source: "RT-CORE-X", target: "RT-AGG-N", capacityMbps: 25000, latencyMs: 0.6 },
      { id: "L-CX-AS", source: "RT-CORE-X", target: "RT-AGG-S", capacityMbps: 25000, latencyMs: 0.8 },
      { id: "L-CY-AS", source: "RT-CORE-Y", target: "RT-AGG-S", capacityMbps: 25000, latencyMs: null },
      { id: "L-CY-AE", source: "RT-CORE-Y", target: "RT-AGG-E", capacityMbps: 10000, latencyMs: 1.3 },
      { id: "L-AN-EP", source: "RT-AGG-N", target: "RT-EDGE-P", capacityMbps: 10000, latencyMs: 0.7 },
      { id: "L-AN-EQ", source: "RT-AGG-N", target: "RT-EDGE-Q", capacityMbps: 10000, latencyMs: 1.5 },
      { id: "L-AS-EP", source: "RT-AGG-S", target: "RT-EDGE-P", capacityMbps: 10000, latencyMs: 0.9 },
      { id: "L-AS-EQ", source: "RT-AGG-S", target: "RT-EDGE-Q", capacityMbps: 10000, latencyMs: 0.5 },
      { id: "L-AE-EQ", source: "RT-AGG-E", target: "RT-EDGE-Q", capacityMbps: 0, latencyMs: 1.1 },
      { id: "L-EP-CAM", source: "RT-EDGE-P", target: "TERM-CAM-12", capacityMbps: 1000, latencyMs: 1200 },
      { id: "L-EP-EDGE", source: "RT-EDGE-P", target: "TERM-EDGE-05", capacityMbps: 1000, latencyMs: 2.2 },
      { id: "L-EQ-EDGE", source: "RT-EDGE-Q", target: "TERM-EDGE-05", capacityMbps: 1000, latencyMs: 2.8 },
      { id: "L-EQ-POS", source: "RT-EDGE-Q", target: "TERM-POS-01", capacityMbps: -50, latencyMs: 4.1 },
      { id: "L-ORPHAN-02", source: "RT-CORE-X", target: "UNKNOWN-DEVICE", capacityMbps: 1000, latencyMs: 2.1 }
    ],
    expected: {
      nodes: 11,
      links: 14,
      duplicateNodes: 1,
      duplicateLinks: 1,
      invalidLinks: 1,
      nullFields: 5,
      anomalies: 5
    }
  };

  window.TOPO_SAMPLES = [sampleA, sampleB];
})();
