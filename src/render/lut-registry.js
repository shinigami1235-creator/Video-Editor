// User LUTs loaded from .cube files, shared by every compositor (preview and export).
export const lutRegistry = new Map();

export function registerLut(key, lut) {
  lutRegistry.set(key, lut);
}
