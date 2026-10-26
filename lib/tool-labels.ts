import { skillCallLabel } from './tool-rows';

export function displayToolLabel(label: string): string {
  if (label.startsWith('/')) return skillCallLabel(label.slice(1));
  const canonical = label.toUpperCase();
  if (!canonical.startsWith('GILES:')) return canonical;
  return canonical.replace(/^GILES:KNOWLEDGE_/, 'GILES:KNWLG_')
    .replace(/^GILES:WORK_/, 'GILES:WK_')
    .replace(/^GILES:WK_CHECK$/, 'GILES:WK_CHK')
    .replace(/^GILES:WK_FINISH$/, 'GILES:WK_FIN')
    .replaceAll('_', ':');
}
