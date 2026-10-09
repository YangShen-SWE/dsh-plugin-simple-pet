import catalogue from './card-themes.json' with { type: 'json' };

// The WPF pet and settings preview read this same catalogue; character skins are independent.
export const CARD_THEMES = Object.freeze(catalogue.map(theme => Object.freeze({
  ...theme, deepseek: Object.freeze({ ...theme.deepseek }),
  codex: Object.freeze({ ...theme.codex }), peak: Object.freeze({ ...theme.peak }),
})));
export const CARD_THEME_IDS = Object.freeze(CARD_THEMES.map(theme => theme.id));
export function cardPalette(id, mode = 'deepseek', peak = false) {
  const theme = CARD_THEMES.find(theme => theme.id === id) ?? CARD_THEMES[0];
  const palette = mode === 'codex' ? theme.codex : theme.deepseek;
  return { ...palette, ...(mode !== 'codex' && peak ? theme.peak : {}) };
}
export function cardCssVariables(id, mode = 'deepseek', peak = false) {
  const palette = cardPalette(id, mode, peak);
  // WPF catalogue uses #AARRGGBB; browsers use #RRGGBBAA.
  const cssColor = color => color.length === 9 ? `#${color.slice(3)}${color.slice(1, 3)}` : color;
  return Object.fromEntries(Object.entries(palette).map(([key, value]) =>
    [`--pet-card-${key}`, key === 'radius' ? `${value}px` : cssColor(value)]));
}
