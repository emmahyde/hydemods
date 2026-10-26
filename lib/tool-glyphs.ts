import { skillCallLabel } from './tool-rows';

// Verified against OMP's bundled Nerd Fonts catalog. Canonical labels remain plain text.
export const ToolGlyphs: Readonly<Record<string, string>> = Object.freeze({
  GILES: '󰌱', // nf-md-library
  WEB: '󰖟', // nf-md-web
  SEARCH: '', // nf-fa-search
  SKILL: '󱆀', // nf-md-school_outline
  FB: '󰆉', // nf-md-comment_text_outline
  READ: '󰷋', // nf-md-file_eye_outline
  WRITE: '󰻭', // nf-md-file_plus_outline
  EDIT: '󰏫', // nf-md-pencil
  FIND: '󰱽', // nf-md-file_search_outline
  AST: '󰅩', // nf-md-code_braces
  BASH: '󰆍', // nf-md-console
  TOOL: '󰖷', // nf-md-wrench
  PYTHON3: '', // nf-dev-python
  JS: '', // nf-dev-javascript
  IMAGE: '󰥶', // nf-md-image_outline
});

export function displayToolLabel(label: string, ascii = false): string {
  if (label.startsWith('/')) return skillCallLabel(label.slice(1));
  const canonical = label.toUpperCase();
  return ascii ? canonical : canonical.split(':').map(token => ToolGlyphs[token] ?? token).join(':');
}
