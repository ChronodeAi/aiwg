// Warm up before measuring to exclude first-use/JIT costs. A monotonic clock
// avoids Date.now() quantization; an odd sample count rejects isolated scheduler
// pauses without hiding a sustained slowdown. Await each operation so async work
// (including initialization and file validation) stays inside the measurement.
export async function medianMs(operation: () => unknown, runs = 21): Promise<number> {
  for (let i = 0; i < 3; i++) {
    await operation();
  }

  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)];
}
