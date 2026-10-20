// Request-local subscription preferences. No ambient account/global setting reads.
export function withSpeedPreference(provider, speedMode = 'standard') {
  if (!['standard', 'fast'].includes(speedMode)) throw new Error('SPEED_UNAVAILABLE');
  const optionsFor = (options = {}) => {
    const { serviceTier: _untrustedTier, onPayload, ...rest } = options;
    const apply = payload => {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('INVALID_REQUEST_PAYLOAD');
      const { service_tier: _untrusted, ...safe } = payload;
      return speedMode === 'fast' ? { ...safe, service_tier: 'priority' } : safe;
    };
    return { ...rest, ...(speedMode === 'fast' ? { serviceTier: 'priority' } : {}),
      async onPayload(payload, model) {
        const managed = apply(payload);
        return apply(await onPayload?.(managed, model) ?? managed);
      } };
  };
  return { ...provider,
    stream: (model, context, options) => provider.stream(model, context, optionsFor(options)),
    streamSimple: (model, context, options) => provider.streamSimple(model, context, optionsFor(options)),
  };
}
export function accountSpeedModes(row) {
  const tiers = [...(Array.isArray(row?.additional_speed_tiers) ? row.additional_speed_tiers : []),
    ...(Array.isArray(row?.service_tiers) ? row.service_tiers.map(tier => tier?.id) : [])];
  return tiers.some(tier => tier === 'fast' || tier === 'priority') ? ['standard', 'fast'] : ['standard'];
}
