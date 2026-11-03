// backend/lib/sanctionedCountries.js — countries where we don't sell Pro.
//
// Matches the countries Paddle won't take buyers from, for sanctions and
// anti-money-laundering reasons. Ukraine's occupied regions are not listed
// separately: the buyer's country header only says UA, so those regions can't
// be told apart here. Update this list if the provider's list changes.

export const BLOCKED_COUNTRIES = new Set([
    'AF', // Afghanistan
    'AQ', // Antarctica
    'BY', // Belarus
    'MM', // Myanmar (Burma)
    'CF', // Central African Republic
    'CU', // Cuba
    'CD', // Democratic Republic of Congo
    'HT', // Haiti
    'IR', // Iran
    'IQ', // Iraq
    'LY', // Libya
    'ML', // Mali
    'NI', // Nicaragua
    'KP', // North Korea
    'SS', // South Sudan
    'SD', // Sudan
    'SY', // Syria
    'VE', // Venezuela
    'YE', // Yemen
    'ZW', // Zimbabwe
]);

export function isBlockedCountry(country) {
    return Boolean(country) && BLOCKED_COUNTRIES.has(String(country).toUpperCase());
}
