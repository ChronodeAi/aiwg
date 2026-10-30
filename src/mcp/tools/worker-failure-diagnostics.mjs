// Keep contract failures actionable without publishing parser messages or payload values.
export function workerFailureDiagnostics(error, definition, fallback) {
  const code = typeof error?.code === 'string' ? error.code : fallback;
  if (code !== 'OG_CONTRACT_INVALID') return [code];
  const pointer = typeof error.pointer === 'string' && error.pointer.startsWith(`/${definition}/`)
    && error.pointer.length <= 1024 && /^\/[A-Za-z0-9_~/-]+$/.test(error.pointer)
    ? error.pointer : `/${definition}`;
  return [code, { code, pointer, message: 'Worker contract validation failed at this field.' }];
}
