/* 固定剧本：同一伪随机种子 + 同一命令序列，保证每次运行完全可重复。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine'));
  else root.BridgeScenarios = factory(root.BridgeEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  function build(name) {
    if (name === 'normal') {
      var s1 = E.createSim({ seed: 20261116, gap: 18, speed: 6 });
      E.sendCommand(s1, { type: 'reinforce', at: 5, node: 1 });
      E.sendCommand(s1, { type: 'reinforce', at: 9, node: 9 });
      return s1;
    }
    if (name === 'fault') {
      var s2 = E.createSim({ seed: 20261116, gap: 20, speed: 5.5 });
      E.sendCommand(s2, { type: 'reinforce', at: 4, node: 1 });
      E.sendCommand(s2, { type: 'reinforce', at: 8, node: 9 });
      E.scheduleFault(s2, { kind: 'pump', target: 'P5', at: 22, duration: 18 });
      E.sendCommand(s2, { type: 'repair', at: 34, kind: 'pump', target: 'P5' });
      return s2;
    }
    if (name === 'overlimit') {
      var s3 = E.createSim({ seed: 20261116, gap: 18, speed: 6 });
      E.sendCommand(s3, { type: 'setGap', at: 1, value: 3 });
      E.sendCommand(s3, { type: 'setSpeed', at: 1.5, value: 99 });
      E.sendCommand(s3, { type: 'reinforce', at: 2, node: 99 });
      E.sendCommand(s3, { type: 'reinforce', at: 2.4, node: 1 });
      E.sendCommand(s3, { type: 'reinforce', at: 2.8, node: 9 });
      E.sendCommand(s3, { type: 'reinforce', at: 3.2, node: 4 });
      return s3;
    }
    if (name === 'wrongReinforce') {
      var s4 = E.createSim({ seed: 20261116, gap: 14, speed: 7 });
      E.sendCommand(s4, { type: 'reinforce', at: 4, node: 0 });
      E.sendCommand(s4, { type: 'reinforce', at: 8, node: 10 });
      return s4;
    }
    throw new Error('unknown scenario ' + name);
  }

  return { build: build, NAMES: ['normal', 'fault', 'overlimit', 'wrongReinforce'] };
});
