import { createLucideIcon } from 'lucide-react';

/**
 * Icon des Dashboards: Kopfkachel mit Avatar über zwei Kacheln (Personal-Übersicht).
 * Gleiche Schnittstelle wie die Lucide-Icons (size, strokeWidth, className), damit es
 * in NavItem.icon und überall dort steht, wo die anderen Icons stehen.
 */
export const DashboardIcon = createLucideIcon('DashboardOverview', [
  ['rect', { x: '3', y: '3', width: '18', height: '7', rx: '2', key: 'head' }],
  ['circle', { cx: '7.5', cy: '6.5', r: '1.5', key: 'avatar' }],
  ['path', { d: 'M11.5 6.5H17', key: 'line' }],
  ['rect', { x: '3', y: '12', width: '8', height: '9', rx: '2', key: 'left' }],
  ['rect', { x: '13', y: '12', width: '8', height: '9', rx: '2', key: 'right' }],
]);
