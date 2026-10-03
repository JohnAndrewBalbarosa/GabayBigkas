import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float32ToPcm16 } from '../frontend/voice/capture/pcm.mjs';

test('PCM conversion clamps browser samples to signed 16-bit values', () => {
  const pcm = float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});

