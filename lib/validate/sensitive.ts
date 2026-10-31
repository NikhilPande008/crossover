// Sensitive-trait vocabulary. Audiences are never described by these traits, and taste
// tags with these names are never used as creative-angle evidence (Qloo's usage rules
// and our own: aggregate taste only).

export const SENSITIVE =
  /\b(ethnic\w*|race|racial|religio\w*|christian|muslim|jewish|hindu|sikh|buddhist|black people|white people|latino|latina|latinx|hispanic|asian people|disabilit\w*|disabled|mental illness|mental health|depress(ed|ion)|anxiety disorder|pregnan\w*|sexual orientation|sexuality|gay|lesbian|bisexual|queer|lgbt\w*|transgender|immigrant|undocumented|diagnos\w*)\b/i;

export function isSensitive(text: string): boolean {
  return SENSITIVE.test(text);
}
