export interface RecordedRoutineStep {
  op: string;
  params: Record<string, unknown>;
  optional?: boolean;
}

export interface HandoffSummary {
  id: string;
  tabId: number;
  origin: string;
  message: string;
  startedAt: number;
}

export interface DemonstrationSummary {
  id: string;
  tabId: number;
  origin: string;
  instruction: string;
  stepCount: number;
  startedAt: number;
  popupInitiated: boolean;
}

interface PendingHandoff extends HandoffSummary {
  session: string;
  timer: ReturnType<typeof setTimeout>;
  finish: (action: 'continue' | 'cancel' | 'timeout') => void;
}

interface PendingDemonstration extends DemonstrationSummary {
  session: string;
  steps: RecordedRoutineStep[];
  timer: ReturnType<typeof setTimeout>;
  finish: (action: 'finish' | 'cancel' | 'timeout', finalSteps?: RecordedRoutineStep[]) => void;
}

const handoffsByTab = new Map<number, PendingHandoff>();
const demosByTab = new Map<number, PendingDemonstration>();
let nextSeq = 1;

export function isTabWaitingHandoff(tabId: number): boolean {
  return handoffsByTab.has(tabId) || demosByTab.has(tabId);
}

export function listActiveHandoffs(): HandoffSummary[] {
  return [...handoffsByTab.values()].map(({ id, tabId, origin, message, startedAt }) => ({
    id,
    tabId,
    origin,
    message,
    startedAt,
  }));
}

export function listActiveDemonstrations(): DemonstrationSummary[] {
  return [...demosByTab.values()].map(({ id, tabId, origin, instruction, steps, startedAt, popupInitiated }) => ({
    id,
    tabId,
    origin,
    instruction,
    stepCount: steps.length,
    startedAt,
    popupInitiated,
  }));
}

export function startHandoffWait(
  tabId: number,
  session: string,
  origin: string,
  message: string,
  timeoutMs: number,
  onChange: () => void,
): { id: string; promise: Promise<{ completed: boolean; action: 'continue' | 'cancel' | 'timeout' }> } {
  const existing = handoffsByTab.get(tabId);
  if (existing) {
    existing.finish('cancel');
  }
  const id = `ho-${nextSeq++}-${Date.now().toString(36)}`;
  let finishFn!: (action: 'continue' | 'cancel' | 'timeout') => void;
  const promise = new Promise<{ completed: boolean; action: 'continue' | 'cancel' | 'timeout' }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      handoffsByTab.delete(tabId);
      onChange();
      resolve({ completed: false, action: 'timeout' });
    }, timeoutMs);

    finishFn = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handoffsByTab.delete(tabId);
      onChange();
      resolve({ completed: action === 'continue', action });
    };

    handoffsByTab.set(tabId, {
      id,
      tabId,
      session,
      origin,
      message,
      startedAt: Date.now(),
      timer,
      finish: finishFn,
    });
    onChange();
  });

  return { id, promise };
}

export function resolveHandoffWait(
  target: { tabId?: number; id?: string },
  action: 'continue' | 'cancel',
): number | null {
  if (typeof target.tabId === 'number') {
    const entry = handoffsByTab.get(target.tabId);
    if (!entry) return null;
    if (target.id && entry.id !== target.id) return null;
    entry.finish(action);
    return target.tabId;
  }
  if (target.id) {
    for (const [tid, entry] of handoffsByTab.entries()) {
      if (entry.id === target.id) {
        entry.finish(action);
        return tid;
      }
    }
  }
  return null;
}

export function startDemonstrationWait(
  tabId: number,
  session: string,
  origin: string,
  instruction: string,
  timeoutMs: number,
  popupInitiated: boolean,
  onChange: () => void,
): {
  id: string;
  promise: Promise<{ completed: boolean; action: 'finish' | 'cancel' | 'timeout'; steps: RecordedRoutineStep[] }>;
} {
  const existing = demosByTab.get(tabId);
  if (existing) {
    existing.finish('cancel');
  }
  const id = `demo-${nextSeq++}-${Date.now().toString(36)}`;
  const promise = new Promise<{
    completed: boolean;
    action: 'finish' | 'cancel' | 'timeout';
    steps: RecordedRoutineStep[];
  }>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      const lastSteps = demosByTab.get(tabId)?.steps ?? [];
      demosByTab.delete(tabId);
      onChange();
      resolve({ completed: false, action: 'timeout', steps: lastSteps });
    }, timeoutMs);

    const finish = (action: 'finish' | 'cancel' | 'timeout', finalSteps?: RecordedRoutineStep[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const steps = finalSteps ?? demosByTab.get(tabId)?.steps ?? [];
      demosByTab.delete(tabId);
      onChange();
      resolve({ completed: action === 'finish', action, steps });
    };

    demosByTab.set(tabId, {
      id,
      tabId,
      session,
      origin,
      instruction,
      stepCount: 0,
      steps: [],
      startedAt: Date.now(),
      popupInitiated,
      timer,
      finish,
    });
    onChange();
  });

  return { id, promise };
}

export function updateDemonstrationProgress(tabId: number, id: string | undefined, steps: RecordedRoutineStep[]): void {
  const entry = demosByTab.get(tabId);
  if (!entry) return;
  if (id && entry.id !== id) return;
  entry.steps = steps;
  entry.stepCount = steps.length;
}

export function resolveDemonstrationWait(
  target: { tabId?: number; id?: string },
  action: 'finish' | 'cancel',
  finalSteps?: RecordedRoutineStep[],
): { tabId: number; steps: RecordedRoutineStep[]; popupInitiated: boolean } | null {
  let entry: PendingDemonstration | undefined;
  if (typeof target.tabId === 'number') {
    const cand = demosByTab.get(target.tabId);
    if (cand && (!target.id || cand.id === target.id)) entry = cand;
  } else if (target.id) {
    for (const cand of demosByTab.values()) {
      if (cand.id === target.id) {
        entry = cand;
        break;
      }
    }
  }
  if (!entry) return null;
  const tabId = entry.tabId;
  const popupInitiated = entry.popupInitiated;
  const steps = finalSteps ?? entry.steps;
  entry.finish(action, steps);
  return { tabId, steps, popupInitiated };
}

export function cancelTabInteractions(tabId: number): void {
  handoffsByTab.get(tabId)?.finish('cancel');
  demosByTab.get(tabId)?.finish('cancel');
}
