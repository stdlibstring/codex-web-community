export type AppearancePreference = 'system' | 'dark' | 'light';
export type Appearance = { preference: AppearancePreference; theme: 'dark' | 'light' };
export function getAppearance(): Appearance;
export function toggleAppearance(): void;
export function subscribeAppearance(listener: (appearance: Appearance) => void): () => void;
