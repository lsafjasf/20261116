import './scenario-main.mjs';
import './scenario-resilience.mjs';
import './scenario-snapshot.mjs';
import { summary } from './lib.mjs';

const result = summary();
process.exitCode = result.failCount > 0 ? 1 : 0;
