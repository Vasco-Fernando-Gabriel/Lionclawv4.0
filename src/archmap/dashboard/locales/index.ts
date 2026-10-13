import ptBR from "./pt-BR";
import en from "./en";

export type LocaleKey = "pt-BR" | "en";
export type Locale = typeof en;

export const locales: Record<LocaleKey, Locale> = {
  "pt-BR": ptBR,
  en,
};

export function getLocale(key: LocaleKey): Locale {
  return locales[key] ?? locales.en;
}

export function resolveLocaleKey(lang: string | undefined): LocaleKey {
  if (!lang) return "en";
  const normalized = lang.toLowerCase().replace(/[_\s]/g, "-");
  if (/^pt(?:-|$)/.test(normalized) || ["portuguese", "português", "portugues"].includes(normalized)) return "pt-BR";
  return "en";
}

export { en, ptBR };
