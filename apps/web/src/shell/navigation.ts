import type { ProjectStore } from '@mirage/project/store';
import { g3Requested } from '../render/g3-mode';

// Application shell navigation (TASK-137, S01). The tab list follows
// PROJECT_SCOPE.md and the roadmap. The selected tab and the open project are
// local settings in the project store, so both survive a reload.

export const TABS = [
  { id: 'project', label: 'Project' },
  { id: 'aircraft', label: 'Aircraft' },
  { id: 'components', label: 'Components' },
  { id: 'sensors', label: 'Sensors' },
  { id: 'faults', label: 'Faults and interference' },
  { id: 'weather', label: 'Weather and location' },
  { id: 'tasks', label: 'Flight tasks' },
  { id: 'parameters', label: 'Parameters' },
  { id: 'logging', label: 'Logging' },
  { id: 'run', label: 'Run' },
  { id: 'experiments', label: 'Experiments' },
  { id: 'analysis', label: 'Analysis' },
] as const;
export type TabId = typeof TABS[number]['id'];

export interface NavigationState {
  readonly tab: TabId;
  /** The open project, or null. */
  readonly projectId: string | null;
}
/** Project-store setting that holds the navigation (stored form: schemaVersion 1). */
export const NAVIGATION_SETTING = 'shell.navigation';
/** With nothing stored the shell opens the Run tab, where the synthetic demo was before the shell. */
export const DEFAULT_NAVIGATION: NavigationState = { tab: 'run', projectId: null };

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isTabId(value: unknown): value is TabId {
  return TABS.some(tab => tab.id === value);
}
export function tabId(tab: TabId): string {
  return `tab-${tab}`;
}
export function panelId(tab: TabId): string {
  return `panel-${tab}`;
}

/** Validates the stored navigation; anything else is null. */
export function parseNavigation(value: unknown): NavigationState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== 'projectId' || keys[1] !== 'schemaVersion' || keys[2] !== 'tab') return null;
  const schemaVersion: unknown = Reflect.get(value, 'schemaVersion'), tab: unknown = Reflect.get(value, 'tab');
  const projectId: unknown = Reflect.get(value, 'projectId');
  if (schemaVersion !== 1 || !isTabId(tab)) return null;
  if (projectId !== null && (typeof projectId !== 'string' || !UUID_V4.test(projectId))) return null;
  return { tab, projectId };
}

/** The tab a key selects in the tab list: arrows move and wrap, Home and End jump. Other keys give null. */
export function tabForKey(current: TabId, key: string): TabId | null {
  const index = TABS.findIndex(tab => tab.id === current), count = TABS.length;
  let next: number;
  switch (key) {
    case 'ArrowRight': next = (index + 1) % count; break;
    case 'ArrowLeft': next = (index - 1 + count) % count; break;
    case 'Home': next = 0; break;
    case 'End': next = count - 1; break;
    default: return null;
  }
  return TABS[next]?.id ?? null;
}

/** `?g3=1` measures the full-screen flight view inside the Run tab, so that tab stays selected. */
export function forcedTab(search: string): TabId | null {
  return g3Requested(search) ? 'run' : null;
}

/**
 * The stored navigation, or the default when nothing valid is stored. A
 * project that is no longer stored is dropped, keeping the tab.
 */
export async function loadNavigation(store: ProjectStore): Promise<NavigationState> {
  let value: unknown;
  try {
    value = await store.readSetting(NAVIGATION_SETTING);
  } catch {
    // A damaged setting costs only the navigation; the next save replaces it.
    return DEFAULT_NAVIGATION;
  }
  const stored = parseNavigation(value);
  if (!stored) return DEFAULT_NAVIGATION;
  if (stored.projectId === null) return stored;
  const head = await store.head(stored.projectId);
  return head?.record.kind === 'project' ? stored : { tab: stored.tab, projectId: null };
}

export async function saveNavigation(store: ProjectStore, state: NavigationState): Promise<void> {
  await store.writeSetting(NAVIGATION_SETTING, { schemaVersion: 1, tab: state.tab, projectId: state.projectId });
}
