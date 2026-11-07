// Calibrate against protected context BEFORE restoring it. Never compare the
// repaired objects themselves: their changed shape must not drive the fit.
export function matchSeamColors(output, reference, mask) {
  const samples = [], stride = Math.max(1, Math.ceil(output.width * output.height / 24000));
  for (let p = 0; p < output.width * output.height; p += stride) {
    const i = p * 4;
    if (mask.data[i + 3] < 250 || output.data[i + 3] < 250 || reference.data[i + 3] < 250) continue;
    if ([0, 1, 2].some((c) => output.data[i + c] < 4 || output.data[i + c] > 251 || reference.data[i + c] < 4 || reference.data[i + c] > 251)) continue;
    samples.push(i);
  }
  if (samples.length < 128) return { applied: false, reason: 'insufficient-context', samples: samples.length };
  const median = (values) => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const transforms = [];
  for (let c = 0; c < 3; c++) {
    let gain = 1, offset = median(samples.map((i) => reference.data[i + c] - output.data[i + c]));
    let inliers = samples;
    for (let round = 0; round < 3; round++) {
      const residuals = samples.map((i) => Math.abs(reference.data[i + c] - (output.data[i + c] * gain + offset)));
      const threshold = Math.max(4, Math.min(14, median(residuals) * 2.5));
      inliers = samples.filter((i, n) => residuals[n] <= threshold);
      if (inliers.length < 128 || inliers.length < samples.length * .45) return { applied: false, reason: 'inconsistent-context', samples: samples.length };
      let mx = 0, my = 0;
      for (const i of inliers) { mx += output.data[i + c]; my += reference.data[i + c]; }
      mx /= inliers.length; my /= inliers.length;
      let variance = 0, covariance = 0;
      for (const i of inliers) { const x = output.data[i + c] - mx; variance += x * x; covariance += x * (reference.data[i + c] - my); }
      gain = variance / inliers.length > 36 ? Math.max(.65, Math.min(1.5, covariance / variance)) : 1;
      offset = Math.max(-40, Math.min(40, my - gain * mx));
    }
    transforms.push({ gain, offset });
  }
  for (let i = 0; i < output.data.length; i += 4) {
    if (mask.data[i + 3] === 255 || !output.data[i + 3]) continue;
    for (let c = 0; c < 3; c++) output.data[i + c] = Math.max(0, Math.min(255, Math.round(output.data[i + c] * transforms[c].gain + transforms[c].offset)));
  }
  return { applied: true, samples: samples.length, transforms };
}
