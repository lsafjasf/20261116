export function describe(suiteName) {
  const tests = [];
  return {
    suiteName,
    test(name, fn) {
      tests.push({ name, fn });
    },
    async run() {
      const results = [];
      for (const test of tests) {
        try {
          await test.fn();
          results.push({ suite: suiteName, name: test.name, ok: true });
        } catch (error) {
          results.push({ suite: suiteName, name: test.name, ok: false, error });
        }
      }
      return results;
    }
  };
}

export function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

export function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || "Values differ"}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

export function assertApprox(actual, expected, epsilon, message) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`${message || "Values not close"}: expected ${expected} ± ${epsilon}, got ${actual}`);
  }
}

export async function assertRejects(fn, expectedCodeFragment, message) {
  let threw = null;
  try {
    await fn();
  } catch (error) {
    threw = error;
  }
  if (!threw) throw new Error(message || "Expected promise to reject");
  if (expectedCodeFragment && !String(threw.message).includes(expectedCodeFragment)) {
    throw new Error(`${message || "Rejection message mismatch"}: got "${threw.message}"`);
  }
}

export function assertThrows(fn, expectedCodeFragment, message) {
  let threw = null;
  try {
    fn();
  } catch (error) {
    threw = error;
  }
  if (!threw) throw new Error(message || "Expected function to throw");
  if (expectedCodeFragment && !String(threw.message).includes(expectedCodeFragment)) {
    throw new Error(`${message || "Error message mismatch"}: got "${threw.message}"`);
  }
}
