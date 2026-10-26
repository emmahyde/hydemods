import { skillCallLabel } from './tool-rows';

const GilesActions: Readonly<Record<string, string>> = {
  WORK_CHECK: 'WK:CHK',
  WORK_FINISH: 'WK:FIN',
  WORK_RECORD_EVIDENCE: 'WK:EVID',
  WORK_ADD_REFERENCE: 'WK:REF',
  WORK_LIST_DEPENDENCIES: 'WK:DEPS',
  WORK_ADD_DEPENDENCY: 'WK:DEP:ADD',
  WORK_REMOVE_DEPENDENCY: 'WK:DEP:RM',
  WORK_RECONCILE_CRITERIA: 'WK:RECON',
  KNOWLEDGE_PROPOSE_DECISION: 'KNWLG:PROPOSE:DEC',
  KNOWLEDGE_RECONCILE: 'KNWLG:RECON',
  FB: 'FB:SEND',
  FB_CHECK: 'FB:CHK',
  FEEDBACK_SUBMIT: 'FB:SEND',
  FEEDBACK_CHECK: 'FB:CHK',
  FEEDBACK_RECONCILE: 'FB:RECON',
  CAPTURE_SOURCE: 'CAPTURE:SRC',
  CAPTURE_TRAJECTORY: 'CAPTURE:TRACE',
  CONTEXT_PREPARE: 'CTX:PREP',
  ENSURE_PAGE: 'PAGE:ENSURE',
};

export function displayToolLabel(label: string): string {
  if (label.startsWith('/')) return skillCallLabel(label.slice(1));
  const canonical = label.toUpperCase();
  if (!canonical.startsWith('GILES:')) return canonical;
  const action = canonical.slice('GILES:'.length);
  return `GILES:${GilesActions[action] ?? action
    .replace(/^KNOWLEDGE_/, 'KNWLG_')
    .replace(/^WORK_/, 'WK_')
    .replace(/^FEEDBACK_/, 'FB_')
    .replaceAll('_', ':')}`;
}
