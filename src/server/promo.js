// Promo codes, extracted from server.js during the decomposition. Static map
// of code -> { discount, description }, consumed by POST /api/promo/validate.
// All current codes are 100% (unlimited-use comps/partnerships).
export const PROMO_CODES = new Map([
  ['FORGEFRIEND',   { discount: 100, description: 'Friend of Forge' }],
  ['EARLYBIRD',     { discount: 100, description: 'Early Access' }],
  ['SANDBOX100',    { discount: 100, description: 'Sandbox Group Internal' }],
  ['NANGO',         { discount: 100, description: 'Nango Partnership' }],
]);
