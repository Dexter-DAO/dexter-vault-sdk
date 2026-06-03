import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    snapshotSerializers: ['./tests/uint8array-serializer.ts'],
  },
});
