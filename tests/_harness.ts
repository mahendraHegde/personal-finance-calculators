// Shared assertion helpers for the framework-free test scripts (same spirit as
// retirement.test.ts). Each test file is its own process; call done() at the end.

let failures = 0;

export function section(title: string): void {
  console.log(`\n${title}`);
}

export function ok(cond: boolean, label: string): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    failures++;
  }
}

/** Relative-tolerance numeric check. */
export function near(a: number, b: number, tol: number, label: string): void {
  const diff = Math.abs(a - b) / Math.max(1, Math.abs(b));
  if (diff <= tol) {
    console.log(`  ✓ ${label}: ${a.toFixed(4)} ≈ ${b.toFixed(4)}`);
  } else {
    console.error(
      `  ✗ ${label}: got ${a}, expected ${b} (diff ${(diff * 100).toFixed(4)}% > ${(tol * 100).toFixed(3)}%)`,
    );
    failures++;
  }
}

export function eq<T>(a: T, b: T, label: string): void {
  if (a === b) {
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}: got ${String(a)}, expected ${String(b)}`);
    failures++;
  }
}

export function done(): void {
  console.log(`\n${"=".repeat(56)}`);
  if (failures === 0) {
    console.log("ALL CHECKS PASSED");
    process.exit(0);
  } else {
    console.error(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
}
