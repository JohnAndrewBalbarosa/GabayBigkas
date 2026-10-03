export function float32ToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index++) {
    const bounded = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = bounded < 0 ? Math.round(bounded * 32768) : Math.round(bounded * 32767);
  }
  return pcm;
}

