export const test = (val: unknown): val is Uint8Array => val instanceof Uint8Array;
export const serialize = (val: Uint8Array): string => {
  const hex = Array.from(val, (b) => b.toString(16).padStart(2, '0')).join('');
  return `Uint8Array(${val.length}) "${hex}"`;
};
export default { test, serialize };
