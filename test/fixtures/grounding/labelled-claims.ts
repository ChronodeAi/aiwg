/**
 * Hand-labelled synthetic challenge set for #3313, independent of retrieval
 * scores. Labels describe the semantic relation of evidence to claim.
 * Includes unsupported paraphrases to expose the literal checker's recall
 * limit. This is a regression measurement, not a held-out NLI benchmark.
 */
export const labelledClaims: Array<{
  claim: string;
  content: string;
  label: 'supports' | 'contradicts' | 'unknown';
}> = [
  { claim: 'TLS transport is encrypted.', content: 'TLS transport is encrypted.', label: 'supports' },
  { claim: 'The cache is not persistent.', content: 'The cache is not persistent.', label: 'supports' },
  { claim: 'The API is available.', content: '  The API   is available  ', label: 'supports' },
  { claim: 'The timeout is 30 seconds.', content: 'The timeout is 30 seconds.', label: 'supports' },
  { claim: 'Protocol version 1.2 is supported.', content: 'Protocol version 1.2 is supported.', label: 'supports' },
  { claim: 'Birds migrate in winter.', content: 'Birds migrate in winter.', label: 'supports' },
  { claim: 'The backup is mandatory.', content: 'The backup is required.', label: 'supports' },
  { claim: 'The cache is temporary.', content: 'The cache is not persistent.', label: 'supports' },
  { claim: 'TLS transport is encrypted.', content: 'TLS transport is not encrypted.', label: 'contradicts' },
  { claim: 'The cache is not persistent.', content: 'The cache is persistent.', label: 'contradicts' },
  { claim: 'Replicas are available.', content: 'Replicas are not available.', label: 'contradicts' },
  { claim: 'The release was stable.', content: 'The release was not stable.', label: 'contradicts' },
  { claim: 'The replicas were synchronized.', content: 'The replicas were not synchronized.', label: 'contradicts' },
  { claim: 'The endpoint is public.', content: 'The endpoint is not public.', label: 'contradicts' },
  { claim: 'The timeout is 30 seconds.', content: 'The timeout is 60 seconds.', label: 'contradicts' },
  { claim: 'The cache is persistent.', content: 'The cache is temporary.', label: 'contradicts' },
  { claim: 'TLS transport is encrypted.', content: 'TLS transport configuration is documented.', label: 'unknown' },
  { claim: 'TLS transport is encrypted.', content: 'Bananas grow in tropical regions.', label: 'unknown' },
  { claim: 'The endpoint is public.', content: 'The endpoint may be public.', label: 'unknown' },
  { claim: 'The endpoint is public.', content: 'If the flag is enabled, the endpoint is public.', label: 'unknown' },
  { claim: 'The endpoint is public.', content: 'Is the endpoint public?', label: 'unknown' },
  { claim: 'The endpoint is public.', content: '"The endpoint is public" is an unverified claim.', label: 'unknown' },
  { claim: 'The endpoint is public.', content: 'The endpoint is not only public but also cached.', label: 'supports' },
  { claim: 'The endpoint is public.', content: 'The endpoint is public. That statement is false.', label: 'unknown' },
];
