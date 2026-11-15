export function assert(condition, message, detail = undefined) {
  if (!condition) {
    const error = new Error(`断言失败: ${message}`);
    error.detail = detail;
    throw error;
  }
}

export function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  assert(ok, message, { actual, expected });
}

export function assertClose(actual, expected, tolerance, message) {
  assert(Math.abs(actual - expected) <= tolerance, message, { actual, expected, tolerance });
}
